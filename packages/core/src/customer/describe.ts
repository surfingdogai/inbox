import type { Item, ItemType } from "../domain/types";
import { cap, copyFor, phraseOf, vars } from "./copy";
import { moneyIn, oneLine, shortRef, whenText } from "./format";
import type { CustomerLang } from "./lang";
import type { OpenOffer } from "./offer";

/**
 * What the business says to its customer about their item, in its own voice and language, in the
 * sentences an assistant relays word for word: the status, what we proposed, who we are waiting on
 * and what the customer can do next.
 */
export interface Audience {
  readonly lang: CustomerLang;
  /** The business's time zone: every time is written in it, with the zone named. */
  readonly timezone: string;
  /** How long before a proposed time the customer can still take it. */
  readonly minNoticeMin: number;
  /** The customer closed it themselves (their own cancel or decline), which changes the words. */
  readonly closedByCustomer?: boolean | undefined;
  /** What we asked, for an item waiting on the customer's details. */
  readonly question?: string | undefined;
}

export const DEFAULT_AUDIENCE: Audience = { lang: "en", timezone: "UTC", minNoticeMin: 0 };

/** `"Full service"`, or empty: the item's subject in the customer's language (`subjectIn`). */
export function whatOf(item: SubjectOf, lang: CustomerLang = "en"): string {
  const subject = subjectIn(item, lang);
  return subject ? `"${subject}"` : "";
}

type SubjectOf = Pick<Item, "subject"> & { readonly type?: ItemType; readonly payload?: unknown };

/** How the inbox names an order of several lines when nobody named it: the first, and how many more. */
const MORE: Readonly<Record<CustomerLang, (first: string, more: number) => string>> = {
  en: (first, more) => `${first} and ${more} more`,
  pt: (first, more) => `${first} e mais ${more} ${more === 1 ? "artigo" : "artigos"}`,
};

/** The subjects the inbox gives a request nobody named, in English: said by the noun instead. */
const PLAIN: Readonly<Partial<Record<ItemType, string>>> = {
  booking: "Booking",
  order: "Order",
  quote_request: "Quote request",
  refund: "Refund request",
};

/**
 * The item's subject as the customer reads it, on one line. A subject the inbox made up when nobody
 * named the request (`defaultSubject`, in English) is said in the customer's language: an order's
 * "Bread and 2 more" becomes "Bread e mais 2 artigos", and a bare "Order" gives way to the noun.
 */
export function subjectIn(item: SubjectOf, lang: CustomerLang = "en"): string {
  const subject = oneLine(item.subject);
  if (!item.type) return subject;
  if (subject === PLAIN[item.type]) return lang === "en" ? subject : "";
  if (item.type === "order" && lang !== "en") {
    const lines = (item.payload as { orderedItem?: { name?: unknown }[] } | undefined)?.orderedItem ?? [];
    const first = typeof lines[0]?.name === "string" ? lines[0].name : null;
    if (first && lines.length > 1 && subject === oneLine(MORE.en(first, lines.length - 1))) {
      return oneLine(MORE[lang](first, lines.length - 1));
    }
  }
  return subject;
}

export function yourNoun(type: ItemType, lang: CustomerLang): string {
  return copyFor(lang).yourNoun[type];
}

/** The sentence an assistant relays for the item as it stands. Never an id: a six-character reference. */
export function statusSentence(item: Item, a: Audience = DEFAULT_AUDIENCE): string {
  const c = copyFor(a.lang);
  if (item.type === "booking" && item.state === "proposed" && item.payload.proposed) {
    return proposedSentence(item, a);
  }
  if (item.type === "quote_request" && item.state === "quoted" && item.payload.quote) {
    return quotedSentence(item, a);
  }
  const gender = c.gender[item.type];
  const total =
    (item.type === "order" || item.type === "booking") && item.payload.totalPrice
      ? moneyIn(item.payload.totalPrice, a.lang)
      : "";
  const v = vars({
    what: whatOf(item, a.lang),
    ref: shortRef(item.id),
    total,
    question: a.question ?? "",
    yourNoun: c.yourNoun[item.type],
  });
  let phrase: string;
  if (item.type === "quote_request" && item.state === "accepted") phrase = phraseOf(c.states.accepted_quote, gender, v);
  else if (a.closedByCustomer && item.type === "order" && item.state === "cancelled")
    phrase = phraseOf(c.byCustomer.cancelled, gender, v);
  else if (a.closedByCustomer && item.type === "quote_request" && item.state === "declined")
    phrase = phraseOf(c.byCustomer.declined, gender, v);
  else phrase = phraseOf(c.states[item.state], gender, v) || item.state.replaceAll("_", " ");
  // A request that named another price hears ours, in our words (ADR-018 §3.2).
  const stated =
    (item.type === "booking" || item.type === "order") && item.payload.customerStatedPrice && item.payload.totalPrice;
  return c.sentence({
    ...v,
    phrase,
    booking: item.type === "booking",
    when: item.type === "booking" ? whenText(item.payload.startTime, a.timezone, a.lang) : "",
    priceLine: stated ? c.statedPrice(v) : "",
  });
}

function proposedSentence(item: Extract<Item, { type: "booking" }>, a: Audience): string {
  const c = copyFor(a.lang);
  const p = item.payload.proposed;
  if (!p) return "";
  const price = p.totalPrice ?? item.payload.totalPrice;
  const v = vars({
    what: whatOf(item, a.lang),
    ref: shortRef(item.id),
    total: price ? moneyIn(price, a.lang) : "",
  });
  return c.proposed({
    ...v,
    newWhen: whenText(p.startTime, a.timezone, a.lang),
    deadline: whenText(new Date(Date.parse(p.startTime) - a.minNoticeMin * 60_000).toISOString(), a.timezone, a.lang),
    priceLine: price ? c.price(v) : "",
  });
}

function quotedSentence(item: Extract<Item, { type: "quote_request" }>, a: Audience): string {
  const c = copyFor(a.lang);
  const q = item.payload.quote;
  if (!q) return "";
  return c.quoted(
    vars({
      what: whatOf(item, a.lang),
      ref: shortRef(item.id),
      total: moneyIn(q.totalPrice, a.lang),
      validThrough: whenText(q.validThrough, a.timezone, a.lang),
      when: q.creates === "booking" && q.startTime ? whenText(q.startTime, a.timezone, a.lang) : "",
    }),
  );
}

/**
 * The open offer in words, for the customer to say yes to: the sentence, and when accepting binds
 * them to pay, that it does (the confirm step's summary).
 */
export function offerSummary(item: Item, offer: OpenOffer, a: Audience = DEFAULT_AUDIENCE): string {
  const c = copyFor(a.lang);
  const sentence = statusSentence(item, a);
  if (!offer.obligationToPay || !offer.terms.totalPrice) return sentence;
  return `${sentence} ${c.obligation(vars({ total: moneyIn(offer.terms.totalPrice, a.lang) }))}`;
}

/** The states in which the business waits for the customer. */
const THEIR_MOVE = new Set(["proposed", "quoted", "needs_info", "awaiting_payment", "payment_failed"]);

/** Who the item is waiting on: `you` (the customer), `us` (the business), or nobody once it is closed. */
export function waitingOn(item: Item): "you" | "us" | null {
  if (item.closedAt !== null || item.state === "spam") return null;
  return THEIR_MOVE.has(item.state) ? "you" : "us";
}

export type NextAction =
  | "accept_offer"
  | "decline_offer"
  | "suggest_time"
  | "provide_details"
  | "cancel_item"
  | "send_message";

/** What the customer can do next, in the order they would most likely do it, with the business's labels. */
export function nextActions(
  item: Item,
  customerEvents: readonly string[],
  lang: CustomerLang,
): { action: NextAction; label: string }[] {
  const l = copyFor(lang).labels;
  const out: { action: NextAction; label: string }[] = [];
  if (item.type === "booking" && item.state === "proposed") {
    out.push({ action: "accept_offer", label: l.accept });
    out.push({ action: "decline_offer", label: l.decline });
    out.push({ action: "suggest_time", label: l.otherTime });
    return out;
  }
  if (item.type === "quote_request" && item.state === "quoted") {
    out.push({ action: "accept_offer", label: l.accept });
    out.push({ action: "decline_offer", label: l.decline });
    return out;
  }
  if (item.state === "needs_info") out.push({ action: "provide_details", label: l.details });
  if (customerEvents.includes("cancel")) out.push({ action: "cancel_item", label: l.cancel });
  if (item.state !== "spam") out.push({ action: "send_message", label: l.write });
  return out;
}

/** The button a customer sees for an event, in their language. */
export function customerLabel(event: string, type: ItemType, state: string, lang: CustomerLang): string {
  const l = copyFor(lang).labels;
  switch (event) {
    case "accept":
      return l.accept;
    case "decline":
      return l.decline;
    case "counter":
      return l.otherTime;
    case "provide_info":
      return l.details;
    case "cancel":
    case "cancel_late":
      // Before anything is agreed, the customer's cancel of a time we proposed is their no.
      return type === "booking" && state === "proposed" ? l.decline : l.cancel;
    case "reopen":
      return l.write;
    default:
      return cap(event.replaceAll("_", " "));
  }
}
