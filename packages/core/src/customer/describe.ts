import type { Item, ItemType, Money, Personalised } from "../domain/types";
import { cap, copyFor, phraseOf, vars } from "./copy";
import { moneyIn, oneLine, shortRef, whenText } from "./format";
import type { CustomerLang } from "./lang";
import { isChangeable, type OpenOffer, openChange, timeDeadline } from "./offer";

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
  if (item.type === "refund") return refundSentence(item, a);
  if (item.type === "booking" && item.state === "proposed" && item.payload.proposed) {
    return proposedSentence(item, a);
  }
  if (item.type === "quote_request" && item.state === "quoted" && item.payload.quote) {
    return quotedSentence(item, a);
  }
  if (item.type === "order" && item.state === "proposed" && item.payload.proposed) {
    return proposedOrderSentence(item, a);
  }
  // A change we asked for to what was agreed, waiting for their answer.
  if (item.type === "booking" && item.payload.change?.by === "business" && isChangeable(item)) {
    return changeSentence(item, a);
  }
  if (item.type === "order" && item.payload.change?.by === "business" && isChangeable(item)) {
    return changeOrderSentence(item, a);
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
  // A request that named another price hears ours, in our words (ADR-018 §3.2); a price we chose for
  // them carries the notice instead, wherever it is before them (ADR-018 §5).
  const stated =
    (item.type === "booking" || item.type === "order") && item.payload.customerStatedPrice && item.payload.totalPrice;
  const notice =
    (item.type === "booking" || item.type === "order") && (stated || PRICED_STATES.has(item.state))
      ? personalisedLine(item.payload, a)
      : "";
  // A change they asked for, while we have not answered it: what was agreed stands meanwhile.
  const asked =
    openChange(item)?.by !== "customer"
      ? ""
      : item.type === "booking" && item.payload.change
        ? c.changeRequested.time(vars({ newWhen: whenText(item.payload.change.startTime, a.timezone, a.lang) }))
        : c.changeRequested.order;
  return c.sentence({
    ...v,
    phrase,
    booking: item.type === "booking",
    when: item.type === "booking" ? whenText(item.payload.startTime, a.timezone, a.lang) : "",
    priceLine: [notice || (stated ? c.statedPrice(v) : ""), asked].filter(Boolean).join(" "),
  });
}

/** Where a status sentence is about the price as it stands: the request with us, and the payment asked. */
const PRICED_STATES: ReadonlySet<string> = new Set(["requested", "received", "needs_info", "awaiting_payment"]);

/**
 * The personalised-price notice (ADR-018 §5; CRD art. 6(1)(ea)) for a price the inbox chose for this
 * customer — the owner's reward for their record, a discount automation gave, their own price
 * automation took — and the owner's line for them after it. Empty for a price that is not theirs alone.
 */
export function personalisedLine(
  holder: { readonly totalPrice?: Money | undefined; readonly personalised?: Personalised | undefined } | object,
  a: Audience,
): string {
  const h = holder as { totalPrice?: Money; personalised?: Personalised };
  const p = h.personalised;
  const total = h.totalPrice;
  if (!p || !total || total.currency.toUpperCase() !== p.listPrice.currency.toUpperCase()) return "";
  if (total.value >= p.listPrice.value) return "";
  const c = copyFor(a.lang);
  const line = c.personalised(vars({ total: moneyIn(total, a.lang), listPrice: moneyIn(p.listPrice, a.lang) }));
  return p.says?.trim() ? `${line} ${oneLine(p.says)}` : line;
}

/**
 * Where a return or a refund stands, in the words it is: goods to send back by a date, a refund due
 * by one, the goods back, disputed, refunded, refused or dropped (ADR-018 §3.4).
 */
function refundSentence(item: Extract<Item, { type: "refund" }>, a: Audience): string {
  const r = copyFor(a.lang).returns.status;
  const p = item.payload;
  const at = (iso: string | undefined) => (iso ? whenText(iso, a.timezone, a.lang) : "");
  const v = vars({ what: whatOf(item, a.lang), ref: shortRef(item.id), amount: moneyIn(p.amount, a.lang) });
  switch (item.state) {
    case "approved":
      return p.goodsBack
        ? r.approvedBack({ ...v, deadline: at(p.returnBy) })
        : r.approvedRefund({ ...v, deadline: at(p.refundDue) });
    case "goods_received":
      return p.disputed ? r.disputed(v) : r.goodsReceived({ ...v, deadline: at(p.refundDue) });
    case "refunded":
      return r.refunded({ ...v, amount: moneyIn(p.paidAmount ?? p.amount, a.lang) });
    case "rejected":
      return r.rejected(v);
    case "cancelled":
      return r.cancelled(v);
    default:
      return r.requested(v);
  }
}

/** Until when the customer can answer what we put to them, as the payload's pointer says. */
function answerBy(item: Item, a: Audience): string {
  const p = (item.payload as { offer?: { by: string; status: string; validThrough?: string } }).offer;
  const until = p?.by === "business" && p.status === "open" ? p.validThrough : undefined;
  return until ? whenText(until, a.timezone, a.lang) : "";
}

/** A change we ask for to a confirmed booking: from when, to when, the price, and until when to answer. */
function changeSentence(item: Extract<Item, { type: "booking" }>, a: Audience): string {
  const c = copyFor(a.lang);
  const change = item.payload.change;
  if (!change) return "";
  const price = change.totalPrice;
  const v = vars({ what: whatOf(item, a.lang), ref: shortRef(item.id), total: price ? moneyIn(price, a.lang) : "" });
  return c.changeAsked({
    ...v,
    when: whenText(item.payload.startTime, a.timezone, a.lang),
    newWhen: whenText(change.startTime, a.timezone, a.lang),
    deadline: answerBy(item, a),
    priceLine: price ? c.price(v) : "",
  });
}

/** A change we ask for to an accepted order: its lines as they would be, the total, and until when to answer. */
function changeOrderSentence(item: Extract<Item, { type: "order" }>, a: Audience): string {
  const c = copyFor(a.lang);
  const change = item.payload.change;
  if (!change) return "";
  return c.changeAskedOrder(
    vars({
      what: whatOf(item, a.lang),
      ref: shortRef(item.id),
      total: moneyIn(change.totalPrice, a.lang),
      summary: orderLinesText(change.orderedItem, a.lang),
      deadline: answerBy(item, a),
    }),
  );
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
  const deadline = timeDeadline(item, a.minNoticeMin) ?? p.startTime;
  // A price we chose for them carries the notice, each time it is offered (ADR-018 §5).
  const notice = personalisedLine(p.totalPrice ? p : item.payload, a);
  return c.proposed({
    ...v,
    newWhen: whenText(p.startTime, a.timezone, a.lang),
    deadline: whenText(deadline, a.timezone, a.lang),
    priceLine: price ? (notice ? `${c.price(v)} ${notice}` : c.price(v)) : "",
  });
}

/** The changes we suggest to an order: each line, the total, and until when to answer. */
function proposedOrderSentence(item: Extract<Item, { type: "order" }>, a: Audience): string {
  const c = copyFor(a.lang);
  const p = item.payload.proposed;
  if (!p) return "";
  const until = item.payload.offer?.by === "business" ? item.payload.offer.validThrough : undefined;
  const sentence = c.proposedOrder(
    vars({
      what: whatOf(item, a.lang),
      ref: shortRef(item.id),
      total: moneyIn(p.totalPrice, a.lang),
      summary: orderLinesText(p.orderedItem, a.lang),
      deadline: until ? whenText(until, a.timezone, a.lang) : "",
    }),
  );
  // A price we chose for them carries the notice, each time it is offered (ADR-018 §5).
  const notice = personalisedLine(p, a);
  return notice ? `${sentence} ${notice}` : sentence;
}

/** An order's lines in one run of text: "2 × Bread — €4.00; 1 × Cake — €10.00". */
export function orderLinesText(
  lines: readonly {
    readonly name: string;
    readonly quantity: number;
    readonly price: { value: number; currency: string };
  }[],
  lang: CustomerLang,
): string {
  return lines
    .map(
      (l) =>
        `${l.quantity} × ${oneLine(l.name)} — ${moneyIn({ value: l.price.value * l.quantity, currency: l.price.currency }, lang)}`,
    )
    .join("; ");
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
  const sentence = `${statusSentence(item, a)}${offer.withdrawable ? ` ${c.withdrawable}` : ""}`;
  if (!offer.obligationToPay || !offer.terms.totalPrice) return sentence;
  return `${sentence} ${c.obligation(vars({ total: moneyIn(offer.terms.totalPrice, a.lang) }))}`;
}

/** The states in which the business waits for the customer. */
const THEIR_MOVE = new Set(["proposed", "quoted", "needs_info", "awaiting_payment", "payment_failed"]);

/** Who the item is waiting on: `you` (the customer), `us` (the business), or nobody once it is closed. */
export function waitingOn(item: Item): "you" | "us" | null {
  if (item.closedAt !== null || item.state === "spam") return null;
  // A change we asked for to what was agreed waits for their answer.
  if (openChange(item)?.by === "business") return "you";
  return THEIR_MOVE.has(item.state) ? "you" : "us";
}

export type NextAction =
  | "accept_offer"
  | "decline_offer"
  | "suggest_time"
  | "make_offer"
  | "provide_details"
  | "withdraw_from_contract"
  | "request_return"
  | "cancel_item"
  | "send_message";

/** What the customer can do next, in the order they would most likely do it, with the business's labels. */
export function nextActions(
  item: Item,
  customerEvents: readonly string[],
  lang: CustomerLang,
  /**
   * What the customer may do with the contract itself: withdraw from it (the label in the words of
   * the law it is under), or send its goods back once they have them.
   */
  contract: { readonly withdraw?: string | undefined; readonly sendBack?: boolean | undefined } = {},
): { action: NextAction; label: string }[] {
  const l = copyFor(lang).labels;
  const out: { action: NextAction; label: string }[] = [];
  if (item.type === "booking" && item.state === "proposed") {
    out.push({ action: "accept_offer", label: l.accept });
    out.push({ action: "decline_offer", label: l.decline });
    out.push({ action: "suggest_time", label: l.otherTime });
    return out;
  }
  if (
    (item.type === "quote_request" && item.state === "quoted") ||
    (item.type === "order" && item.state === "proposed")
  ) {
    out.push({ action: "accept_offer", label: l.accept });
    out.push({ action: "decline_offer", label: l.decline });
    out.push({ action: "make_offer", label: l.suggestChange });
    return out;
  }
  // A promise: its change to answer, their own to take back, or one to ask for.
  if (isChangeable(item)) {
    const change = openChange(item);
    if (change?.by === "business") {
      out.push({ action: "accept_offer", label: l.acceptChange });
      out.push({ action: "decline_offer", label: l.keepAsIs });
    } else if (change?.by === "customer") {
      out.push({ action: "decline_offer", label: l.withdrawChange });
    }
    if (change?.by !== "customer") {
      out.push(
        item.type === "booking"
          ? { action: "suggest_time", label: l.changeTime }
          : { action: "make_offer", label: l.suggestChange },
      );
    }
  }
  if (item.state === "needs_info") out.push({ action: "provide_details", label: l.details });
  if (contract.sendBack) out.push({ action: "request_return", label: copyFor(lang).returns.labels.sendBack });
  if (contract.withdraw) out.push({ action: "withdraw_from_contract", label: contract.withdraw });
  // While the right runs, a cancel is a withdrawal: the one link says so, in the law's words. A refund
  // with nothing to send back is money owed to them: nothing to cancel.
  const owedOnly = item.type === "refund" && item.payload.goodsBack !== true;
  if (customerEvents.includes("cancel") && !owedOnly && !(contract.withdraw && item.type !== "refund")) {
    out.push({
      action: "cancel_item",
      label: item.type === "refund" ? copyFor(lang).returns.labels.cancel : l.cancel,
    });
  }
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
      return type === "booking" ? l.otherTime : l.suggestChange;
    case "propose_change":
      return type === "booking" ? l.changeTime : l.suggestChange;
    case "accept_change":
      return l.acceptChange;
    case "decline_change":
      return l.keepAsIs;
    case "retract_change":
      return l.withdrawChange;
    case "provide_info":
      return l.details;
    case "cancel":
    case "cancel_late":
      // Before anything is agreed, the customer's cancel of a time or changes we proposed is their no.
      return state === "proposed" ? l.decline : l.cancel;
    case "reopen":
      return l.write;
    default:
      return cap(event.replaceAll("_", " "));
  }
}
