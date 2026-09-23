import type { Item, Money } from "../domain/types";
import { canonicalJson } from "../util/canonical";

/**
 * What the business has put to the customer and is waiting for them to answer: another time for a
 * booking (`proposed`), or a quote (`quoted`). It is the projection of what the item already holds —
 * `payload.proposed` or `payload.quote` — so there is exactly one open at a time, and it changes
 * whenever the business changes what it proposes.
 *
 * `termsSha` is what a customer's yes is bound to (the confirm step): the terms they were shown,
 * fingerprinted, sent back with the acceptance. Different terms, a different fingerprint, and the
 * acceptance is refused with the current ones. For our ASCII keys, strings and safe integers the
 * canonical JSON is byte for byte RFC 8785's, so the fingerprint stays valid wherever it is checked.
 */
export interface OfferTerms {
  readonly startTime?: string | undefined;
  readonly endTime?: string | undefined;
  readonly partySize?: number | undefined;
  readonly totalPrice?: Money | undefined;
  readonly lines?: readonly { readonly name: string; readonly quantity: number; readonly price: Money }[] | undefined;
  readonly notes?: string | undefined;
  readonly validThrough?: string | undefined;
  readonly creates?: "booking" | "order" | undefined;
}

export interface OpenOffer {
  readonly kind: "time" | "quote";
  readonly terms: OfferTerms;
  /** base64url(SHA-256(canonical JSON of {kind, ...terms})): 43 characters. */
  readonly termsSha: string;
  /** Until when the customer can answer: a proposed time's start less the minimum notice; a quote's validity. */
  readonly deadline: string | null;
  /** Accepting binds the customer to pay: the terms carry a price above zero. */
  readonly obligationToPay: boolean;
}

export async function openOffer(item: Item, opts: { minNoticeMin?: number } = {}): Promise<OpenOffer | null> {
  if (item.type === "booking" && item.state === "proposed" && item.payload.proposed) {
    const p = item.payload.proposed;
    const totalPrice = p.totalPrice ?? item.payload.totalPrice;
    const terms: OfferTerms = {
      startTime: p.startTime,
      endTime: p.endTime,
      ...(item.payload.partySize !== undefined ? { partySize: item.payload.partySize } : {}),
      ...(totalPrice ? { totalPrice } : {}),
    };
    const start = Date.parse(p.startTime);
    const deadline = Number.isFinite(start) ? new Date(start - (opts.minNoticeMin ?? 0) * 60_000).toISOString() : null;
    return {
      kind: "time",
      terms,
      termsSha: await termsSha("time", terms),
      deadline,
      obligationToPay: (totalPrice?.value ?? 0) > 0,
    };
  }
  if (item.type === "quote_request" && item.state === "quoted" && item.payload.quote) {
    const q = item.payload.quote;
    const terms: OfferTerms = {
      totalPrice: q.totalPrice,
      lines: q.lines,
      ...(q.notes ? { notes: q.notes } : {}),
      validThrough: q.validThrough,
      creates: q.creates,
      ...(q.startTime ? { startTime: q.startTime } : {}),
      ...(q.endTime ? { endTime: q.endTime } : {}),
    };
    return {
      kind: "quote",
      terms,
      termsSha: await termsSha("quote", terms),
      deadline: q.validThrough,
      obligationToPay: q.totalPrice.value > 0,
    };
  }
  return null;
}

export async function termsSha(kind: OpenOffer["kind"], terms: OfferTerms): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ kind, ...terms }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return base64Url(digest);
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
