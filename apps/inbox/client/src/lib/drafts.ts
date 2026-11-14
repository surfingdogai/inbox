import { formatMoney, formatWhen } from "./format";
import type { ItemDetail } from "./types";

/**
 * A draft's words (ADR-018 §4): what automation would have offered outside the owner's limits, and
 * which limits. Pure, so the owner app and the phone app say a draft the same way.
 */
export type DraftView = NonNullable<ItemDetail["draft"]>;

/** Each limit a draft is outside, in the owner's words: the owner may read what automation may not. */
export const BREACH_WORDS: Readonly<Record<string, string>> = {
  below_floor: "under your lowest price, or more off than you allow",
  above_list: "above the customer's price",
  counter_priced: "answers the customer's own price with another",
  custom_line: "puts a price on what your catalogue does not price",
  time_moved: "further from the time they asked for than you allow",
  delivery_later: "delivers later than they asked",
  worse_than_before: "dearer than what you last offered them",
  rounds_exhausted: "past the last round of back and forth",
  change_not_allowed: "asks them for a change to what was agreed",
  over_approval_value: "above the value you accept yourself",
  amount_named: "names an amount of money you have not offered",
};

export function breachWords(breaches: readonly string[]): string {
  return breaches.map((b) => BREACH_WORDS[b] ?? b.replaceAll("_", " ")).join("; ");
}

/** What the customer would be offered, in one line: the time, the lines, the total. */
export function termsLine(t: DraftView["terms"], tz: string | undefined): string {
  const parts: string[] = [];
  if (t.startTime) parts.push(formatWhen(t.startTime, t.endTime, tz));
  if (t.lines?.length) parts.push(t.lines.map((l) => `${l.quantity ?? 1} × ${l.name ?? ""}`.trim()).join(", "));
  if (t.totalPrice) parts.push(formatMoney(t.totalPrice));
  return parts.join(" · ");
}
