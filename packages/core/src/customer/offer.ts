import type { Item, ItemOf, Money, OfferPointer, PayloadOf } from "../domain/types";
import { canonicalJson } from "../util/canonical";

/**
 * What the business has put to the customer and is waiting for them to answer: another time for a
 * booking (`proposed`), a quote (`quoted`), or changes to an order (`proposed`). It is the
 * projection of what the item already holds — `payload.proposed` or `payload.quote` — so there is
 * exactly one open at a time, and it changes whenever the business changes what it proposes. The
 * offer itself is a row in `item_offers` (`negotiation/offers.ts`), written with these very terms, so
 * the projection and the row always fingerprint alike.
 *
 * `termsSha` is what a customer's yes is bound to (the confirm step): the terms they were shown,
 * fingerprinted, sent back with the acceptance. Different terms, a different fingerprint, and the
 * acceptance is refused with the current ones. For our ASCII keys, strings and safe integers the
 * canonical JSON is byte for byte RFC 8785's, so the fingerprint stays valid wherever it is checked.
 */
export type OfferForm =
  /** A booking's time: a time we proposed, or the one the customer asked for. */
  | "time"
  /** A quote we sent. */
  | "quote"
  /** An order's lines, total and delivery: the customer's order, or the changes we suggested. */
  | "order"
  /** What a customer's quote request asks for: the thing, how many, for when. */
  | "request"
  /**
   * A change to a promise, either side's: the confirmed booking (its time, party and price) or the
   * accepted order (its lines, total and delivery) as it would be. A form of its own, so a yes to a
   * change is never a yes to a time or an order that happened to hold the same terms.
   */
  | "change";

export interface OfferLine {
  readonly productId?: string | undefined;
  readonly sku?: string | undefined;
  readonly name: string;
  readonly quantity: number;
  readonly price: Money;
}

export interface OfferTerms {
  readonly startTime?: string | undefined;
  readonly endTime?: string | undefined;
  readonly partySize?: number | undefined;
  readonly totalPrice?: Money | undefined;
  readonly lines?: readonly OfferLine[] | undefined;
  readonly notes?: string | undefined;
  readonly validThrough?: string | undefined;
  readonly creates?: "booking" | "order" | undefined;
  readonly delivery?: { readonly method: "pickup" | "delivery" | "digital"; readonly when?: string | undefined };
  readonly quantity?: number | undefined;
  readonly itemOffered?:
    | {
        readonly name: string;
        readonly serviceId?: string | undefined;
        readonly productId?: string | undefined;
        readonly sku?: string | undefined;
      }
    | undefined;
}

export interface OpenOffer {
  /**
   * What the business proposed: a time, a quote, changes to an order, or a change to a confirmed
   * booking or an accepted order (`change`).
   */
  readonly kind: "time" | "quote" | "order" | "change";
  readonly terms: OfferTerms;
  /** base64url(SHA-256(canonical JSON of {kind, ...terms})): 43 characters. */
  readonly termsSha: string;
  /** Until when the customer can answer: the offer's validity (a time's, never past its start less the minimum notice). */
  readonly deadline: string | null;
  /**
   * Accepting binds the customer to pay: the terms carry a price above zero. For a change, only when
   * it asks more of them than what they agreed (a higher total).
   */
  readonly obligationToPay: boolean;
  /** The offer's id, once the inbox holds it as a row; null for one made before offers had a table, until it does. */
  readonly id: string | null;
  /** A time we hold for the customer until they answer. */
  readonly held: boolean;
  /** We may still withdraw it before they answer. */
  readonly withdrawable: boolean;
  /** Its price was chosen for this customer (a reward, a discount automation gave): the notice goes with it. */
  readonly personalised?: boolean | undefined;
}

/** Whether the business's open proposal on the item is at a price chosen for this customer. */
function personalisedProposal(item: Item): boolean {
  const payload = item.payload as {
    proposed?: { totalPrice?: unknown; personalised?: unknown };
    personalised?: unknown;
  };
  const p = payload.proposed;
  if (!p) return false;
  if (item.type === "booking") {
    return p.personalised !== undefined || (p.totalPrice === undefined && payload.personalised !== undefined);
  }
  return item.type === "order" && p.personalised !== undefined;
}

/** The pointer to the business's open offer, when the item's pointer is one. */
function openBusinessPointer(item: Item): OfferPointer | undefined {
  const p = (item.payload as { offer?: OfferPointer }).offer;
  return p && p.by === "business" && p.status === "open" ? p : undefined;
}

/**
 * Until when a time we proposed can be accepted: the validity it went out with, and never later than
 * its start less the minimum notice, since the customer could not take it after that. A time proposed
 * before offers had a table has only the second.
 */
export function timeDeadline(item: ItemOf<"booking">, minNoticeMin: number): string | null {
  const p = item.payload.proposed;
  if (!p) return null;
  const start = Date.parse(p.startTime);
  if (!Number.isFinite(start)) return null;
  const bound = start - minNoticeMin * 60_000;
  const valid = openBusinessPointer(item)?.validThrough;
  const until = valid ? Math.min(Date.parse(valid), bound) : bound;
  return new Date(until).toISOString();
}

export async function openOffer(item: Item, opts: { minNoticeMin?: number } = {}): Promise<OpenOffer | null> {
  const pointer = openBusinessPointer(item);
  const meta = {
    id: pointer?.id ?? null,
    held: pointer?.held === true,
    withdrawable: pointer?.binding === false,
    ...(personalisedProposal(item) ? { personalised: true } : {}),
  };
  if (item.type === "booking" && item.state === "proposed" && item.payload.proposed) {
    const terms = businessTimeTerms(item.payload);
    return {
      kind: "time",
      terms,
      termsSha: await termsSha("time", terms),
      deadline: timeDeadline(item, opts.minNoticeMin ?? 0),
      obligationToPay: (terms.totalPrice?.value ?? 0) > 0,
      ...meta,
    };
  }
  if (item.type === "quote_request" && item.state === "quoted" && item.payload.quote) {
    const terms = quoteOfferTerms(item.payload.quote);
    return {
      kind: "quote",
      terms,
      termsSha: await termsSha("quote", terms),
      deadline: item.payload.quote.validThrough,
      obligationToPay: item.payload.quote.totalPrice.value > 0,
      ...meta,
    };
  }
  if (item.type === "order" && item.state === "proposed" && item.payload.proposed) {
    const terms = orderOfferTerms(item.payload.proposed);
    return {
      kind: "order",
      terms,
      termsSha: await termsSha("order", terms),
      deadline: pointer?.validThrough ?? null,
      obligationToPay: item.payload.proposed.totalPrice.value > 0,
      ...meta,
    };
  }
  // A change we asked for to what was agreed: the promise as it would be.
  const change = businessChange(item);
  if (change) {
    const terms = changeTerms(item);
    if (!terms) return null;
    const before = (item.payload as { totalPrice?: Money }).totalPrice;
    const after = terms.totalPrice;
    return {
      kind: "change",
      terms,
      termsSha: await termsSha("change", terms),
      deadline: pointer?.validThrough ?? null,
      // More than agreed, or in another currency than agreed (never less by a number in another unit).
      obligationToPay:
        after !== undefined &&
        after.value > 0 &&
        (before === undefined ||
          after.currency.toUpperCase() !== before.currency.toUpperCase() ||
          after.value > before.value),
      ...meta,
    };
  }
  return null;
}

/** The states in which a booking or an order holds a promise the two sides may change. */
export const CHANGEABLE: Readonly<Record<"booking" | "order", readonly string[]>> = {
  booking: ["confirmed"],
  order: ["accepted", "awaiting_payment", "payment_failed", "paid", "fulfilling"],
};

/** Whether the item holds a promise the two sides may change: a confirmed booking, an accepted order. */
export function isChangeable(item: Pick<Item, "type" | "state">): boolean {
  return (item.type === "booking" || item.type === "order") && CHANGEABLE[item.type].includes(item.state);
}

/** The change asked for and not answered yet, and who asked; none on anything else. */
export function openChange(item: Item): { readonly by: "business" | "customer" } | null {
  if (!isChangeable(item)) return null;
  const c = (item.payload as { change?: { by: "business" | "customer" } }).change;
  return c ? { by: c.by } : null;
}

function businessChange(item: Item): boolean {
  return openChange(item)?.by === "business";
}

/**
 * The terms of the change the item holds (`payload.change`), whoever asked for it: the booking or the
 * order as it would be, in the same shape as what was agreed. Null when none is open.
 */
export function changeTerms(item: Item): OfferTerms | null {
  if (item.type === "booking") {
    const c = item.payload.change;
    if (!c) return null;
    return {
      startTime: c.startTime,
      endTime: c.endTime,
      ...(item.payload.partySize !== undefined ? { partySize: item.payload.partySize } : {}),
      ...(c.totalPrice ? { totalPrice: c.totalPrice } : {}),
    };
  }
  if (item.type === "order") {
    const c = item.payload.change;
    if (!c) return null;
    return {
      lines: c.orderedItem.map(offerLine),
      totalPrice: c.totalPrice,
      ...(c.delivery ? { delivery: c.delivery } : {}),
    };
  }
  return null;
}

/**
 * The terms the promise stands on now, as a change would name them: what a link to ask for a change
 * is bound to, so any change to the promise retires the links sent before it.
 */
export function promiseTerms(item: Item): OfferTerms | null {
  if (item.type === "booking") return bookingRequestTerms(item.payload);
  if (item.type === "order") return orderRequestTerms(item.payload);
  return null;
}

// ---- the terms of each form, from what the item holds ------------------------------------------

/** A time we proposed: the time, the party, and the price (ours with it, else the request's). */
export function businessTimeTerms(payload: PayloadOf<"booking">): OfferTerms {
  const p = payload.proposed;
  if (!p) return {};
  const totalPrice = p.totalPrice ?? payload.totalPrice;
  return {
    startTime: p.startTime,
    endTime: p.endTime,
    ...(payload.partySize !== undefined ? { partySize: payload.partySize } : {}),
    ...(totalPrice ? { totalPrice } : {}),
  };
}

/**
 * The time the customer asks for, as the booking holds it, and for what: two services at the same price
 * and length are different things to confirm (ADR-018 §5).
 */
export function bookingRequestTerms(payload: PayloadOf<"booking">): OfferTerms {
  return {
    itemOffered: { name: payload.reservationFor.name, serviceId: payload.reservationFor.serviceId },
    startTime: payload.startTime,
    endTime: payload.endTime,
    ...(payload.partySize !== undefined ? { partySize: payload.partySize } : {}),
    ...(payload.totalPrice ? { totalPrice: payload.totalPrice } : {}),
  };
}

type Quote = NonNullable<PayloadOf<"quote_request">["quote"]>;

/** A quote, as the links sent before offers had a table fingerprinted it. */
export function quoteOfferTerms(q: Quote): OfferTerms {
  return {
    totalPrice: q.totalPrice,
    lines: q.lines,
    ...(q.notes ? { notes: q.notes } : {}),
    validThrough: q.validThrough,
    creates: q.creates,
    ...(q.startTime ? { startTime: q.startTime } : {}),
    ...(q.endTime ? { endTime: q.endTime } : {}),
  };
}

type OrderLine = PayloadOf<"order">["orderedItem"][number];

function offerLine(l: OrderLine): OfferLine {
  return {
    ...(l.productId !== undefined ? { productId: l.productId } : {}),
    ...(l.sku !== undefined ? { sku: l.sku } : {}),
    name: l.name,
    quantity: l.quantity,
    price: l.price,
  };
}

/** The changes we suggested to an order: its lines, their total and when it would be delivered. */
export function orderOfferTerms(p: NonNullable<PayloadOf<"order">["proposed"]>): OfferTerms {
  return {
    lines: p.orderedItem.map(offerLine),
    totalPrice: p.totalPrice,
    ...(p.delivery ? { delivery: p.delivery } : {}),
  };
}

/** The order as the customer asks for it: never the price their request stated, only the business's. */
export function orderRequestTerms(payload: PayloadOf<"order">): OfferTerms {
  return {
    lines: payload.orderedItem.map(offerLine),
    totalPrice: payload.totalPrice,
    ...(payload.delivery ? { delivery: payload.delivery } : {}),
  };
}

/** What a quote request asks for: the thing, how many, for when. Not its words, and not a budget. */
export function quoteRequestTerms(payload: PayloadOf<"quote_request">): OfferTerms {
  const o = payload.itemOffered;
  return {
    itemOffered: {
      name: o.name,
      ...(o.serviceId !== undefined ? { serviceId: o.serviceId } : {}),
      ...(o.productId !== undefined ? { productId: o.productId } : {}),
      ...(o.sku !== undefined ? { sku: o.sku } : {}),
    },
    ...(payload.quantity !== undefined ? { quantity: payload.quantity } : {}),
    ...(payload.requestedFor ? { startTime: payload.requestedFor } : {}),
  };
}

export async function termsSha(kind: OfferForm, terms: OfferTerms): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ kind, ...terms }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return base64Url(digest);
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * The paths of `next` that differ from `prev`, JSONPath-like (`$.startTime`, `$.lines[1].quantity`):
 * what an answer or a revision changed, so a changed price never rides along unseen. The thing asked
 * for (`itemOffered`) is compared only when both name it: an answer about the time is about the same
 * thing.
 */
export function changedPaths(prev: OfferTerms | null | undefined, next: OfferTerms): string[] {
  if (!prev) return [];
  const same = prev.itemOffered === undefined || next.itemOffered === undefined;
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`);
      return;
    }
    if (isRecord(a) && isRecord(b) && !isMoney(a) && !isMoney(b)) {
      for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) walk(a[k], b[k], `${path}.${k}`);
      return;
    }
    out.push(path);
  };
  walk(prev, next, "$");
  return same ? out.filter((p) => p !== "$.itemOffered" && !p.startsWith("$.itemOffered.")) : out;
}

/** Whether any of these paths is money: a price, a total, or a whole line (with its price) come or gone. */
export function moneyChanged(paths: readonly string[]): boolean {
  return paths.some((p) => /\.(?:totalPrice|price)$/.test(p) || /^\$\.lines(?:\[\d+\])?$/.test(p));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isMoney(v: Record<string, unknown>): boolean {
  return typeof v.value === "number" && typeof v.currency === "string" && Object.keys(v).length === 2;
}
