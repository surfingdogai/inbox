import type { Settings } from "../settings/schema";

/**
 * The owner's limits, in code (ADR-018 §4): what the owner's AI, rules and another system's key
 * without `money:write` may agree to on their own. Pure: the write path gathers what it judges (the
 * catalogue's prices for this customer, the owner's floors, the customer's asked terms, the round)
 * and asks here which limits an offer or an acceptance is outside. Outside them an offer becomes a
 * draft for a person, never sent and never refused; an acceptance is refused. A breach is a code,
 * never a number: automation learns that it is outside a limit, never where the limit is.
 */
export type Breach =
  /** A catalogue line at a price under the owner's floor for this customer. */
  | "below_floor"
  /** A catalogue line at a price above this customer's price: a surcharge, or a reward held back. */
  | "above_list"
  /** Answering a customer's own price with another price: automation takes a price or leaves it to a person. */
  | "counter_priced"
  /** A price on what the catalogue does not price: a quote, a line of its own, a longer booking. */
  | "custom_line"
  /** A time further from the one the customer asked for than the owner allows. */
  | "time_moved"
  /** A delivery later than the one the customer asked for by more than the owner allows. */
  | "delivery_later"
  /** Worse for the customer than what we last offered them in this negotiation. */
  | "worse_than_before"
  /** Past the rounds a negotiation takes before a person answers. */
  | "rounds_exhausted"
  /** A change to what was agreed, which the owner has not let automation ask for. */
  | "change_not_allowed"
  /** A refund agreed with nothing to send back, above what the owner lets automation agree. */
  | "refund_over_max"
  /** An order above the value the owner accepts only in person. */
  | "over_approval_value"
  /**
   * Words to the customer naming an amount of money our terms and the catalogue do not hold, or
   * something off a price: a binding proposal in an online message (DL 7/2004 art. 32(1)), so a person's.
   */
  | "amount_named";

export const BREACHES: readonly Breach[] = [
  "below_floor",
  "above_list",
  "counter_priced",
  "custom_line",
  "time_moved",
  "delivery_later",
  "worse_than_before",
  "rounds_exhausted",
  "change_not_allowed",
  "refund_over_max",
  "over_approval_value",
  "amount_named",
];

/**
 * One priced line as automation offers or takes it, beside what the catalogue says of it. A booking's
 * total is one line of quantity 1; a product's price is per unit.
 */
export interface LimitLine {
  /** The price in the terms, per unit. */
  readonly price: number;
  readonly quantity: number;
  /** The catalogue's list price per unit, or null when the catalogue does not price it. */
  readonly list: number | null;
  /** The customer's price P: the list price, or the owner's reward for them. Null with no list price. */
  readonly customer: number | null;
  /** The owner's floor per unit, when there is one. */
  readonly floor: number | null;
  /** The customer's own price for this line, when what automation answers is a price they suggested. */
  readonly countered?: number | null | undefined;
}

/** The limits' part of the settings. */
export type LimitSettings = Pick<Settings["negotiation"], "maxRounds" | "ai">;

/**
 * The lowest price automation may put on a line for this customer: the owner's floor, or the
 * customer's price less the discount the owner allows (`maxDiscountPct`, 0 out of the box), whichever
 * is higher — rounded up, so no rounding ever takes it under — and never above the customer's price
 * itself, which the owner set: a list price since lowered under its floor is still one automation may
 * offer. Null for a line the catalogue does not price.
 */
export function effectiveFloor(line: LimitLine, maxDiscountPct: number): number | null {
  if (line.customer === null) return null;
  const basis = Math.round(Math.max(0, Math.min(100, maxDiscountPct)) * 100);
  const cut = line.customer * (10_000 - basis);
  const discounted = Number.isSafeInteger(cut) ? Math.ceil(cut / 10_000) : line.customer;
  return Math.min(line.customer, Math.max(line.floor ?? 0, discounted));
}

/** What automation offers: its lines, and how it stands against what the customer asked and we last said. */
export interface OfferCheck {
  readonly lines: readonly LimitLine[];
  /** Something no catalogue line prices is priced: a quote, a longer booking. */
  readonly custom?: boolean | undefined;
  /**
   * The price offered is one the customer's own request set, kept by leaving ours out (ADR-018 §3.2,
   * Q5): never automation's to offer back as ours, whatever the owner lets it price.
   */
  readonly customerPriced?: boolean | undefined;
  /** Minutes between the time offered and the time the customer asked for, when both are known. */
  readonly timeShiftMin?: number | null | undefined;
  /** The time offered is not one we would offer: outside the opening hours, on a closure, off the grid. */
  readonly timeNotOffered?: boolean | undefined;
  /** Days the delivery offered is later than the one asked for, when both are known. */
  readonly delayDays?: number | null | undefined;
  /** The offer asks more of the customer than what we last offered them in this negotiation. */
  readonly worseThanBefore?: boolean | undefined;
  /** The round the offer would be in. */
  readonly round: number;
  /** A change to what was agreed. */
  readonly change?: boolean | undefined;
}

/** The limits an offer by automation is outside; empty when it may go to the customer. */
export function checkOffer(o: OfferCheck, s: LimitSettings): Breach[] {
  const out = new Set<Breach>();
  if (o.change && !s.ai.mayProposeChanges) out.add("change_not_allowed");
  if (o.round > s.maxRounds) out.add("rounds_exhausted");
  if (o.worseThanBefore) out.add("worse_than_before");
  if ((o.custom && !s.ai.mayPriceCustom) || o.customerPriced) out.add("custom_line");
  for (const line of o.lines) {
    if (line.list === null) {
      if (!s.ai.mayPriceCustom) out.add("custom_line");
      continue;
    }
    if (line.countered !== undefined && line.countered !== null && line.price !== line.countered) {
      out.add("counter_priced");
    }
    if (line.customer !== null && line.price > line.customer) out.add("above_list");
    const floor = effectiveFloor(line, s.ai.maxDiscountPct);
    if (floor !== null && line.price < floor) out.add("below_floor");
  }
  if (o.timeShiftMin !== undefined && o.timeShiftMin !== null && o.timeShiftMin > s.ai.maxTimeShiftMin) {
    out.add("time_moved");
  }
  // Always within availability and opening hours (ADR-018 §4): a time outside them is a person's to offer.
  if (o.timeNotOffered) out.add("time_moved");
  if (o.delayDays !== undefined && o.delayDays !== null && o.delayDays > s.ai.maxDelayDays) out.add("delivery_later");
  return BREACHES.filter((b) => out.has(b));
}

/** What automation would accept: the lines at the customer's prices, and the total. */
export interface AcceptCheck {
  readonly lines: readonly LimitLine[];
  readonly total?: number | null | undefined;
  /** `orders.maxValueWithoutApprovalMinor`: above it (when > 0) a person accepts. */
  readonly approvalMax?: number | undefined;
}

/**
 * The limits an acceptance by automation is outside; empty when it may accept. A line the catalogue
 * does not price is not judged here: a price the business did not set is never automation's to take
 * (`business_priced`), whatever the limits say. A price above the list price is a person's to take
 * even when the customer named it: an assistant that mistook the units, or cents for euros, would
 * otherwise bind its person to ten times our price.
 */
export function checkAccept(a: AcceptCheck, s: LimitSettings): Breach[] {
  const out = new Set<Breach>();
  for (const line of a.lines) {
    if (line.list !== null && line.price > line.list) out.add("above_list");
    const floor = effectiveFloor(line, s.ai.maxDiscountPct);
    if (floor !== null && line.price < floor) out.add("below_floor");
  }
  if (a.approvalMax && a.approvalMax > 0 && a.total !== undefined && a.total !== null && a.total > a.approvalMax) {
    out.add("over_approval_value");
  }
  return BREACHES.filter((b) => out.has(b));
}

/** Whether automation may agree a refund of `amount` with nothing to send back: within `maxRefundMinor`. */
export function refundWithinLimit(amount: number, s: LimitSettings): boolean {
  return s.ai.maxRefundMinor > 0 && amount <= s.ai.maxRefundMinor;
}
