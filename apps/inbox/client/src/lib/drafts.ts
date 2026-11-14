import { formatDateTime, formatMoney, formatWhen } from "./format";
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

/**
 * Everything else the customer would read in a draft, beyond its one line (`termsLine`), each in the
 * owner's words: the people, delivery, fees, stages, tax, the tip and deposit, and until when it holds.
 * The note is apart (`DraftView["terms"]["notes"]`): it is the draft's own words to the customer.
 */
export function draftDetails(t: DraftView["terms"], tz: string | undefined): string[] {
  const out: string[] = [];
  if (t.partySize) out.push(`For ${t.partySize} ${t.partySize === 1 ? "person" : "people"}`);
  if (t.delivery)
    out.push(
      `${t.delivery.method === "pickup" ? "Collected" : t.delivery.method === "digital" ? "Sent digitally" : "Delivered"}${
        t.delivery.when ? `, ${formatDateTime(t.delivery.when, tz)}` : ""
      }`,
    );
  if (t.fulfil)
    out.push(
      `${t.fulfil.method === "pickup" ? "Collected" : "Delivered"}${t.fulfil.slot ? `, ${t.fulfil.slot}` : ""}${
        t.fulfil.fee ? `, fee ${formatMoney(t.fulfil.fee)}` : ""
      }`,
    );
  if (t.quoteKind === "estimate") out.push("An estimate: the final price may move with the work");
  else if (t.quoteKind === "fixed") out.push("A fixed price");
  if (t.stages?.length)
    out.push(
      `Paid in stages: ${t.stages
        .map((st) => {
          const when =
            st.type === "immediate"
              ? "now"
              : st.type === "at_property"
                ? "on site"
                : `by ${formatDateTime(st.due_at ?? "", tz)}`;
          return `${st.label?.trim() ? `${st.label.trim()} ` : ""}${formatMoney(st.amount)} ${when}`;
        })
        .join("; ")}`,
    );
  if (t.callOutFee)
    out.push(
      `Call-out fee ${formatMoney(t.callOutFee.amount)}${t.callOutFee.creditedIfAccepted ? ", taken off the total" : ", apart from the total"}`,
    );
  if (t.visitFee)
    out.push(
      `Visit fee ${formatMoney(t.visitFee.amount)}${t.visitFee.creditedIfAccepted ? ", taken off the total" : ", apart from the total"}`,
    );
  if (t.tax?.included) out.push("Prices include tax");
  else if (t.tax?.lines?.length)
    out.push(`Before tax, plus ${t.tax.lines.map((l) => `${l.name} ${formatMoney(l.amount)}`).join(" + ")}`);
  if (t.tip) out.push(`Tip ${formatMoney(t.tip)}`);
  if (t.deposit) out.push(`Deposit ${formatMoney(t.deposit)}`);
  if (t.validThrough) out.push(`They can accept it until ${formatDateTime(t.validThrough, tz)}`);
  return out;
}
