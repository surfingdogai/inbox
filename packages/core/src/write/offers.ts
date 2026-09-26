import type { Statement } from "@surfingdog/platform";
import { audienceFor } from "../customer/audience";
import type { Audience } from "../customer/describe";
import { statusSentence } from "../customer/describe";
import {
  bookingRequestTerms,
  businessTimeTerms,
  CHANGEABLE,
  changedPaths,
  changeTerms,
  type OfferForm,
  type OfferTerms,
  orderOfferTerms,
  orderRequestTerms,
  promiseTerms,
  quoteOfferTerms,
  quoteRequestTerms,
  termsSha,
} from "../customer/offer";
import type { Db } from "../db";
import type { Item, ItemType, Money, OfferPointer, PayloadOf } from "../domain/types";
import { ulid } from "../ids";
import type { Transition } from "../machine/machine";
import {
  agreedOf,
  closeOfferStatement,
  insertOfferStatement,
  legacyOfferId,
  nextRev,
  nextRound,
  type OfferRow,
  type OfferSide,
  type OfferStatus,
  openOf,
  pointerOf,
} from "../negotiation/offers";
import type { Settings } from "../settings/schema";
import { type Caller, holdsMoney, isCustomer, isOwnerAssistant, isPerson } from "./caller";
import { WriteError } from "./errors";

/**
 * The offers side of a transition (ADR-018 §1, §2): what the machine's `offer` action does to the
 * item's offers, as statements for the transition's own batch, and the pointer its payload carries.
 * The terms of every offer are the projection of what the item holds after the transition
 * (`customer/offer.ts`), so an offer's fingerprint is always the one its email's links carry.
 */

/** The item types that negotiate. */
export const NEGOTIATES: ReadonlySet<ItemType> = new Set(["booking", "order", "quote_request"]);

/** The states in which the business has the next move on a request, or waits on the customer's details. */
const REQUEST_STATES: ReadonlySet<string> = new Set(["requested", "received", "needs_info"]);

const HOUR = 3_600_000;

/**
 * Automation, held to the owner's limits (ADR-018 §4, Q2): the owner's AI, rules, and a key handed to
 * another system without `money:write` (C9). A key that holds it is the owner's till or shop, and is
 * judged like the owner.
 */
export function isAutomation(caller: Caller): boolean {
  return (
    isOwnerAssistant(caller) ||
    caller.actor.kind === "rule" ||
    (caller.principal?.keyKind === "integration" && !holdsMoney(caller))
  );
}

/** The side a caller speaks for: the customer, the business, or nobody (the system's sweep). */
export function sideOf(caller: Caller): OfferSide | null {
  if (isCustomer(caller)) return "customer";
  return caller.actor.kind === "system" ? null : "business";
}

const formOf = (type: ItemType, by: OfferSide, change = false): OfferForm =>
  change
    ? "change"
    : type === "booking"
      ? "time"
      : type === "order"
        ? "order"
        : by === "business"
          ? "quote"
          : "request";

/** The terms each side stands on, as the item holds them; for a change, the promise as it would be. */
function termsOf(type: ItemType, by: OfferSide, payload: Record<string, unknown>, change = false): OfferTerms {
  if (change) return changeTerms({ type, payload } as Item) ?? {};
  switch (type) {
    case "booking":
      return by === "business"
        ? businessTimeTerms(payload as PayloadOf<"booking">)
        : bookingRequestTerms(payload as PayloadOf<"booking">);
    case "order": {
      const p = payload as PayloadOf<"order">;
      return by === "business" && p.proposed ? orderOfferTerms(p.proposed) : orderRequestTerms(p);
    }
    case "quote_request": {
      const p = payload as PayloadOf<"quote_request">;
      return by === "business" && p.quote ? quoteOfferTerms(p.quote) : quoteRequestTerms(p);
    }
    default:
      return {};
  }
}

/**
 * When a request waiting on the business, or on the customer's details, lapses: a booking
 * `booking.autoExpireHours` on and at its start at the latest (nobody could book it after); an
 * order or a quote request `negotiation.counterValidHours` on.
 */
export function requestExpiry(type: ItemType, payload: Record<string, unknown>, settings: Settings, now: number) {
  if (type === "booking") {
    const until = now + settings.booking.autoExpireHours * HOUR;
    const start = Date.parse(String(payload.startTime));
    return Number.isFinite(start) ? Math.min(until, Math.max(start, now)) : until;
  }
  return now + settings.negotiation.counterValidHours * HOUR;
}

/** Whether the item, in `state`, waits for the business to answer a request, or for the customer's details. */
export const inRequestState = (state: string): boolean => REQUEST_STATES.has(state);

/**
 * Until when an offer the business makes now can be accepted (ADR-018 §1). A time until its start
 * less the minimum notice, when nobody could take it any more; a quote or changes to an order until
 * the date they give, else `negotiation.offerValidHours`. What automation offers runs at most
 * `offerValidHours`, whatever it says.
 */
function businessValidity(
  type: ItemType,
  payload: Record<string, unknown>,
  data: Record<string, unknown>,
  settings: Settings,
  now: number,
  automated: boolean,
): number {
  const hours = now + settings.negotiation.offerValidHours * HOUR;
  const cap = (at: number) => (automated ? Math.min(at, hours) : at);
  if (type === "quote_request")
    return cap(Date.parse(String((payload.quote as { validThrough: string }).validThrough)));
  if (type === "order") return cap(typeof data.validThrough === "string" ? Date.parse(data.validThrough) : hours);
  const start = Date.parse(String((payload.proposed as { startTime: string }).startTime));
  return cap(start - settings.booking.minNoticeMin * 60_000);
}

/**
 * Until when a change can be accepted (ADR-018 §3.1, §3.2). One we ask for: until the date it gives,
 * else `negotiation.offerValidHours` for an order, and for a booking until the earlier of its old
 * and its new start less the minimum notice, since after that the customer could take neither;
 * what automation asks runs at most `offerValidHours`. One the customer asks for: until
 * `negotiation.counterValidHours` on, and for a booking never past either start.
 */
function changeValidity(
  by: OfferSide,
  type: ItemType,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  data: Record<string, unknown>,
  settings: Settings,
  now: number,
  automated: boolean,
): number {
  const hours = now + settings.negotiation.offerValidHours * HOUR;
  const starts =
    type === "booking"
      ? [Date.parse(String(before.startTime)), Date.parse(String((after.change as { startTime: string }).startTime))]
      : [];
  if (by === "customer") return Math.min(now + settings.negotiation.counterValidHours * HOUR, ...starts);
  const notice = settings.booking.minNoticeMin * 60_000;
  const given = typeof data.validThrough === "string" ? Date.parse(data.validThrough) : Number.NaN;
  const bound = Math.min(...starts.map((s) => s - notice));
  const until = Number.isFinite(given) ? given : type === "booking" ? bound : hours;
  return Math.min(until, bound, automated ? hours : Number.POSITIVE_INFINITY);
}

interface Actorish {
  readonly kind: string;
  readonly id: string;
  readonly eventId: string | null;
  readonly at: number;
}

/**
 * The offer an item made before offers had a table gets for what it holds, the first time anything
 * touches it (or the sweep reaches it): the customer's request while it is with the business, or
 * what we proposed while it waits for the customer. One row, rev 1, with an id every writer agrees
 * on, so a race writes it once. A time keeps the deadline its email gave (its start less the
 * notice); a quote, its own. Nothing is sent again.
 */
export async function legacyRows(
  db: Db,
  item: Item,
  requestExpiresAt: number | null,
  settings: Settings,
): Promise<OfferRow[]> {
  if (!NEGOTIATES.has(item.type)) return [];
  const p = item.payload as Record<string, unknown>;
  let by: OfferSide;
  let validThrough: number | null;
  if (inRequestState(item.state)) {
    by = "customer";
    validThrough = requestExpiresAt;
  } else if (item.type === "booking" && item.state === "proposed" && p.proposed) {
    by = "business";
    const start = Date.parse((p.proposed as { startTime: string }).startTime);
    validThrough = start - settings.booking.minNoticeMin * 60_000;
  } else if (item.type === "quote_request" && item.state === "quoted" && p.quote) {
    by = "business";
    validThrough = Date.parse((p.quote as { validThrough: string }).validThrough);
  } else {
    return [];
  }
  const actor = await madeBy(db, item.id, by);
  const form = formOf(item.type, by);
  const terms = termsOf(item.type, by, p);
  return [
    {
      id: legacyOfferId(item.id),
      itemId: item.id,
      rev: 1,
      parentId: null,
      kind: "offer",
      form,
      by,
      actorKind: actor.kind,
      actorId: actor.id,
      round: 1,
      status: "open",
      validThrough: validThrough !== null && Number.isFinite(validThrough) ? validThrough : null,
      terms,
      termsSha: await termsSha(form, terms),
      changes: null,
      shown: null,
      authored: by === "customer" || actor.kind === "owner" || actor.kind === "staff" ? "person" : "automated",
      binding: by === "business",
      reasonCode: null,
      note: null,
      eventId: actor.eventId,
      closedEventId: null,
      createdAt: actor.at,
      updatedAt: actor.at,
    },
  ];
}

/** Who made what a legacy item holds: its create for the customer's side, the latest propose or quote for ours. */
async function madeBy(db: Db, itemId: string, by: OfferSide): Promise<Actorish> {
  const { rows } = await db.client.query({
    sql:
      by === "customer"
        ? "SELECT id, actor_kind, actor_id, created_at FROM item_events WHERE item_id = ? AND seq = 1"
        : "SELECT id, actor_kind, actor_id, created_at FROM item_events WHERE item_id = ? AND event IN ('propose', 'quote') ORDER BY seq DESC LIMIT 1",
    params: [itemId],
    method: "all",
  });
  const r = rows[0];
  return r
    ? { eventId: String(r[0]), kind: String(r[1]), id: String(r[2]), at: Number(r[3]) }
    : { eventId: null, kind: by === "customer" ? "customer_human" : "owner", id: "unknown", at: Date.now() };
}

/**
 * The customer's request as the first offer (ADR-018 §1, §3): written with the item, open for the
 * business to take (`confirm`, `accept`), answer (`propose`, `quote`) or let lapse at the request's
 * clock. A request a person at the business wrote down for the customer binds them; one the customer
 * sent binds them once they confirmed it.
 */
export async function requestRow(o: {
  readonly itemId: string;
  readonly type: ItemType;
  readonly payload: Record<string, unknown>;
  readonly caller: Caller;
  readonly validThrough: number | null;
  readonly eventId: string;
  readonly now: number;
  /** The customer confirmed its summary first (the confirm step): it binds them. */
  readonly confirmed?: boolean | undefined;
}): Promise<OfferRow> {
  const form = formOf(o.type, "customer");
  const terms = termsOf(o.type, "customer", o.payload);
  return {
    id: ulid(),
    itemId: o.itemId,
    rev: 1,
    parentId: null,
    kind: "offer",
    form,
    by: "customer",
    actorKind: o.caller.actor.kind,
    actorId: o.caller.actor.id,
    round: 1,
    status: "open",
    validThrough: o.validThrough,
    terms,
    termsSha: await termsSha(form, terms),
    changes: null,
    shown: null,
    authored: isCustomer(o.caller) || isPerson(o.caller) ? "person" : "automated",
    binding: o.confirmed === true || (!isCustomer(o.caller) && isPerson(o.caller)),
    reasonCode: null,
    note: null,
    eventId: o.eventId,
    closedEventId: null,
    createdAt: o.now,
    updatedAt: o.now,
  };
}

export interface OfferPlan {
  readonly statements: Statement[];
  /** The payload's pointer after the transition: an offer, none (`null`), or as it was (`undefined`). */
  readonly pointer: OfferPointer | null | undefined;
  /** The offer this transition opened, if it opened one. */
  readonly made?: OfferRow | undefined;
  /** The offer this transition accepted, if it accepted one. */
  readonly taken?: OfferRow | undefined;
  /**
   * A change that was open when the promise ended another way (cancelled, completed, fulfilled):
   * closed with it, so the payload lets it go and its hold goes too.
   */
  readonly endedChange?: OfferRow | undefined;
}

export interface OfferContext {
  readonly db: Db;
  readonly item: Item;
  /** The item's offers before the transition, a legacy item's included. */
  readonly rows: readonly OfferRow[];
  readonly t: Transition;
  readonly caller: Caller;
  /** The payload the transition leaves. */
  readonly payload: Record<string, unknown>;
  readonly data: Record<string, unknown>;
  readonly settings: Settings;
  readonly now: number;
  readonly eventId: string;
  /** When the transition hands the request over or asks the customer something: its new lapse time. */
  readonly requestExpiresAt: number | null;
  /** A time we propose whose place is held for the customer. */
  readonly held?: boolean | undefined;
  /** The customer's audience, when the caller is the customer (else read from their party). */
  readonly audience?: Audience | undefined;
}

/**
 * What a transition does to the offers. Closes come before the insert in the batch, since the
 * partial unique index allows one open offer per item at any moment.
 */
export async function planOffers(ctx: OfferContext): Promise<OfferPlan> {
  const { t, rows, caller, now, eventId } = ctx;
  if (!NEGOTIATES.has(ctx.item.type)) return { statements: [], pointer: undefined };
  const side = sideOf(caller);
  const open = openOf(rows);
  const statements: Statement[] = [];
  const close = (row: OfferRow, status: OfferStatus, reason?: string | null) =>
    statements.push(closeOfferStatement(row.id, status, eventId, now, reason));
  /** The side a transition speaks for: recording the customer's own cancellation is theirs, whoever types it. */
  const acting: OfferSide | null = t.event.startsWith("record_cancel") ? "customer" : side;
  /** How an offer ends when nobody takes it: withdrawn by its own side, declined by the other, lapsed by the system. */
  const endOf = (row: OfferRow): OfferStatus =>
    acting === null || t.event === "expire" || t.event === "expire_change"
      ? "expired"
      : row.by === acting
        ? "retracted"
        : "declined";

  if (!t.offer) {
    // A promise that ends another way — cancelled, completed, fulfilled — ends the change it had open.
    const type = ctx.item.type as "booking" | "order";
    if (open?.kind === "change" && (type === "booking" || type === "order") && !CHANGEABLE[type].includes(t.to)) {
      close(open, endOf(open));
      const agreed = agreedOf(rows);
      return { statements, pointer: agreed ? pointerOf(agreed) : null, endedChange: open };
    }
    return { statements, pointer: undefined };
  }

  switch (t.offer) {
    case "make": {
      if (!side) return { statements, pointer: undefined };
      const change = t.change === true;
      // A promise from before offers had a table has no agreed offer: what it holds is what was agreed,
      // written first, so a change has it to answer and to be measured against.
      const standing = change && !agreedOf(rows) ? await standingRow(ctx) : undefined;
      if (standing) statements.push(insertOfferStatement(standing));
      const known = standing ? [...rows, standing] : rows;
      const made = await newRow(standing ? { ...ctx, rows: known } : ctx, side, {
        status: "open",
        parent: open ?? (change ? agreedOf(known) : undefined) ?? rows.at(-1),
        // A customer who asks again for a change of their own before we answered is another round,
        // so asking over and over reaches a person rather than the owner's inbox each time.
        round: change && side === "customer" && open?.by === "customer" ? open.round + 1 : nextRound(known, side),
        validThrough: change
          ? changeValidity(
              side,
              ctx.item.type,
              ctx.item.payload as Record<string, unknown>,
              ctx.payload,
              ctx.data,
              ctx.settings,
              now,
              isAutomation(caller),
            )
          : side === "business"
            ? businessValidity(ctx.item.type, ctx.payload, ctx.data, ctx.settings, now, isAutomation(caller))
            : ctx.requestExpiresAt,
      });
      // Past the last round a customer's next suggestion goes to a person (their door says so).
      // Automation past it, or offering worse than we last did, never gets here: its offer is a draft
      // for a person (`write/limits.ts`). A person at the business is never held.
      if (side === "customer" && made.round > ctx.settings.negotiation.maxRounds) {
        throw new WriteError(
          "guard_failed",
          "we have gone back and forth on this a few times: a person on our team will answer",
          { details: { guard: "round_left" } },
        );
      }
      if (open) close(open, open.by === side ? "superseded" : "countered");
      statements.push(insertOfferStatement(made));
      return { statements, pointer: pointerOf(made, { held: ctx.held === true }), made };
    }
    case "take": {
      if (open) {
        close(open, "accepted");
        const taken = { ...open, status: "accepted" as const, closedEventId: eventId, updatedAt: now };
        return { statements, pointer: pointerOf(taken), taken };
      }
      // Nothing open: the terms the item stands on are what was agreed. A business taking a request
      // takes the customer's; nothing else reaches here.
      const by: OfferSide = inRequestState(ctx.item.state) ? "customer" : "business";
      const taken = await newRow(ctx, by, {
        status: "accepted",
        parent: rows.at(-1),
        round: nextRound(rows, by),
        validThrough: null,
        standing: true,
      });
      statements.push(insertOfferStatement(taken));
      return { statements, pointer: pointerOf(taken), taken };
    }
    case "withdraw": {
      // A question asked of the customer's open request leaves it open.
      if (!open || !side || open.by !== side) return { statements, pointer: undefined };
      close(open, "retracted");
      // The other side's request stands again, as the item holds it, back with us.
      const other: OfferSide = side === "business" ? "customer" : "business";
      const theirs = [...rows].reverse().find((r) => r.by === other);
      const again = await newRow(ctx, other, {
        status: "open",
        parent: open,
        round: theirs?.round ?? 1,
        validThrough: ctx.requestExpiresAt,
        standing: true,
        as: theirs,
      });
      statements.push(insertOfferStatement(again));
      return { statements, pointer: pointerOf(again), made: again };
    }
    case "end": {
      if (open) {
        // An expiry is an expiry, whoever lets it happen (the sweep, or a rule once it lapsed).
        const status = endOf(open);
        const reason = side === "customer" && typeof ctx.data.reasonCode === "string" ? ctx.data.reasonCode : null;
        close(open, status, status === "declined" ? reason : null);
      }
      return { statements, pointer: null };
    }
    case "keep": {
      // The change is not made: declined, withdrawn or lapsed. The promise stands as agreed.
      if (!open) return { statements, pointer: undefined };
      const status = endOf(open);
      const reason = side === "customer" && typeof ctx.data.reasonCode === "string" ? ctx.data.reasonCode : null;
      close(open, status, status === "declined" ? reason : null);
      const agreed = agreedOf(rows);
      return { statements, pointer: agreed ? pointerOf(agreed) : null };
    }
  }
}

/**
 * What a promise made before offers had a table stands on, as its agreed offer: the terms it holds,
 * accepted, so a change has something to answer and to be measured against.
 */
async function standingRow(ctx: OfferContext): Promise<OfferRow> {
  const { item, now } = ctx;
  const form = formOf(item.type, "business");
  const terms = promiseTerms(item) ?? {};
  return {
    id: ulid(),
    itemId: item.id,
    rev: nextRev(ctx.rows),
    parentId: ctx.rows.at(-1)?.id ?? null,
    kind: "offer",
    form,
    by: "business",
    actorKind: "owner",
    actorId: "unknown",
    round: 1,
    status: "accepted",
    validThrough: null,
    terms,
    termsSha: await termsSha(form, terms),
    changes: null,
    shown: null,
    authored: "person",
    binding: true,
    reasonCode: null,
    note: null,
    eventId: null,
    closedEventId: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** What the business last offered in the negotiation under way: since the last agreed offer. */
export function lastBusinessOffer(rows: readonly OfferRow[]): OfferRow | undefined {
  let since = 0;
  for (const r of rows) if (r.status === "accepted") since = r.rev;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r && r.rev > since && r.by === "business" && r.status !== "draft") return r;
  }
  return undefined;
}

/**
 * Whether `next` asks more of the customer than `prev` did: a time at a higher price, or a line of
 * an order at a higher unit price than the same product had. Quantities and times are not money.
 */
export function dearer(prev: OfferTerms, next: OfferTerms): boolean {
  const more = (a: Money | undefined, b: Money | undefined) =>
    a !== undefined && b !== undefined && a.currency.toUpperCase() === b.currency.toUpperCase() && b.value > a.value;
  if (!prev.lines && !next.lines) return more(prev.totalPrice, next.totalPrice);
  type Line = NonNullable<OfferTerms["lines"]>[number];
  const same = (a: Line, b: Line) =>
    (a.productId !== undefined && a.productId === b.productId) ||
    (a.sku !== undefined && a.sku === b.sku) ||
    a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
  return (next.lines ?? []).some((l) => (prev.lines ?? []).some((p) => same(p, l) && more(p.price, l.price)));
}

/** A new offer row for `by`, from the item as the transition leaves it. */
async function newRow(
  ctx: OfferContext,
  by: OfferSide,
  o: {
    readonly status: OfferStatus;
    readonly parent: OfferRow | undefined;
    readonly round: number;
    readonly validThrough: number | null;
    /** The side's standing terms, reinstated or taken as they are, rather than something the caller just said. */
    readonly standing?: boolean;
    /** Whose standing terms they are, when reinstated: the row they last made. */
    readonly as?: OfferRow | undefined;
  },
): Promise<OfferRow> {
  const { item, caller, data, now, eventId } = ctx;
  const change = ctx.t.change === true;
  const form = formOf(item.type, by, change);
  const terms = termsOf(item.type, by, ctx.payload, change);
  const sha = await termsSha(form, terms);
  const fromCaller = !o.standing && sideOf(caller) === by;
  const actorKind = fromCaller
    ? caller.actor.kind
    : (o.as?.actorKind ?? (by === "customer" ? "customer_human" : "owner"));
  const actorId = fromCaller ? caller.actor.id : (o.as?.actorId ?? "unknown");
  const authored: OfferRow["authored"] =
    by === "customer"
      ? "person"
      : fromCaller
        ? isPerson(caller)
          ? "person"
          : "automated"
        : (o.as?.authored ?? "person");
  const note = fromCaller && typeof data.note === "string" && data.note.trim() ? data.note.trim() : null;
  const reason = fromCaller && typeof data.reasonCode === "string" ? data.reasonCode : null;
  const binding =
    by === "business"
      ? ctx.settings.negotiation.binding
      : // A customer's offer binds them once they confirmed it (the confirm step); a request a person at
        // the business wrote down for them does.
        (o.as?.binding ?? (fromCaller ? false : isPerson(caller)));
  const row: OfferRow = {
    id: ulid(),
    itemId: item.id,
    rev: nextRev(ctx.rows),
    parentId: o.parent?.id ?? null,
    kind: change ? "change" : "offer",
    form,
    by,
    actorKind,
    actorId,
    round: o.round,
    status: o.status,
    validThrough: o.validThrough !== null && Number.isFinite(o.validThrough) ? o.validThrough : null,
    terms,
    termsSha: sha,
    // A change is measured against what it answers or would change, which has the same shape.
    changes: o.parent && (o.parent.form === form || change) ? changedPaths(o.parent.terms, terms) : null,
    shown: null,
    authored,
    binding,
    reasonCode: reason,
    note,
    eventId,
    closedEventId: o.status === "accepted" ? eventId : null,
    createdAt: now,
    updatedAt: now,
  };
  if (by !== "business" || o.status !== "open") return row;
  // What the customer is shown with it, in their language: the business's proof of what it offered.
  const audience = ctx.audience ?? (await audienceFor(ctx.db, { partyId: item.partyId, settings: ctx.settings }));
  const pointer = pointerOf(row, { held: ctx.held === true });
  const shownItem = { ...item, state: ctx.t.to, payload: { ...ctx.payload, offer: pointer } } as Item;
  return {
    ...row,
    shown: {
      lang: audience.lang,
      human: statusSentence(shownItem, audience),
      disclosures: [
        ...(item.type === "booking" ? [ctx.held ? "held" : "unheld"] : []),
        ...(row.binding ? [] : ["withdrawable"]),
        // A price chosen for this customer by automated decision: the notice went with it (ADR-018 §5).
        ...(personalisedOffer(item.type, ctx.payload, change) ? ["personalised_price"] : []),
      ],
    },
  };
}

/** Whether the business offer the payload holds is at a price chosen for this customer (a reward, a discount). */
function personalisedOffer(type: ItemType, payload: Record<string, unknown>, change: boolean): boolean {
  if (change) return false;
  const proposed = payload.proposed as { totalPrice?: unknown; personalised?: unknown } | undefined;
  if (type === "booking" && proposed) {
    return (
      proposed.personalised !== undefined || (proposed.totalPrice === undefined && payload.personalised !== undefined)
    );
  }
  if (type === "order" && proposed) return proposed.personalised !== undefined;
  return false;
}
