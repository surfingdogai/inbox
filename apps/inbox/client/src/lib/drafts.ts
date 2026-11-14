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

/**
 * Why a draft was not sent: the limits it is outside, or, for one a person must look at first whatever
 * it says (a stay's quote from the rates, ADR-037 §4.1), only that it waits.
 */
export function notSentWords(breaches: readonly string[]): string {
  return breaches.length ? `Not sent: it is ${breachWords(breaches)}.` : "Not sent yet.";
}

/** A stay's line, as its quote holds it (stays/price.ts): its words, its amount, and who collects it. */
interface StayLine {
  readonly label: string;
  readonly amount: number;
  readonly collected?: string;
}

/** An offer's line: what, how many, its price each, and a menu item's choices. */
interface ItemLine {
  readonly name?: string;
  readonly quantity?: number;
  readonly price?: { readonly value: number; readonly currency: string };
  readonly options?: readonly { readonly name?: string; readonly choiceId?: string; readonly portion?: string }[];
}

/** A stay's payment schedule, as its quote holds it: now, by a date, or at the property. */
interface ScheduleEntry {
  readonly type: string;
  readonly amount: { readonly value: number; readonly currency: string };
  readonly dueAt?: string;
}

const isStayLine = (l: unknown): l is StayLine =>
  typeof l === "object" &&
  l !== null &&
  typeof (l as StayLine).label === "string" &&
  typeof (l as StayLine).amount === "number";

function scheduleOf(t: DraftView["terms"]): ScheduleEntry[] {
  const raw = (t as { schedule?: unknown }).schedule;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is ScheduleEntry =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as ScheduleEntry).type === "string" &&
      typeof (e as ScheduleEntry).amount?.value === "number" &&
      typeof (e as ScheduleEntry).amount?.currency === "string",
  );
}

/**
 * One line as the customer reads it, with its amount: "2 × Bread — €4.00", "1 × Cake (Chocolate) —
 * €10.00" (as the customer's own summary words it, `orderLinesText`), "Double room, 3 nights —
 * €360.00", "City tax — €4.00, paid at the property".
 */
function lineWords(l: unknown, currency: string | undefined): string {
  if (isStayLine(l)) {
    const amount = currency ? ` — ${formatMoney({ value: l.amount, currency })}` : "";
    const there = l.collected === "at_property" && !/propert/i.test(l.label) ? ", paid at the property" : "";
    return `${l.label.trim()}${amount}${there}`;
  }
  const o = (l ?? {}) as ItemLine;
  const quantity = o.quantity ?? 1;
  const chosen = (o.options ?? [])
    .map((c) => `${c.portion === "left" || c.portion === "right" ? "½ " : ""}${c.name ?? c.choiceId ?? ""}`.trim())
    .filter(Boolean)
    .join(", ");
  const amount = o.price ? ` — ${formatMoney({ value: o.price.value * quantity, currency: o.price.currency })}` : "";
  return `${quantity} × ${(o.name ?? "").trim()}${chosen ? ` (${chosen})` : ""}${amount}`;
}

/**
 * What the customer would be offered, in one line: the time, each line with its amount, the total. A
 * draft the owner can send in one tap says every price the customer would read.
 */
export function termsLine(t: DraftView["terms"], tz: string | undefined): string {
  const parts: string[] = [];
  if (t.startTime) parts.push(formatWhen(t.startTime, t.endTime, tz));
  const lines = (t.lines ?? []) as readonly unknown[];
  const currency = t.totalPrice?.currency ?? scheduleOf(t)[0]?.amount.currency;
  if (lines.length) parts.push(lines.map((l) => lineWords(l, currency)).join("; "));
  if (t.totalPrice) parts.push(`${formatMoney(t.totalPrice)}${lines.length ? " in all" : ""}`);
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
  // A stay's schedule: what is paid when, as the guest's page and email say it.
  const schedule = scheduleOf(t);
  if (schedule.length)
    out.push(
      `Paid ${schedule
        .map((e) => {
          const when =
            e.type === "immediate"
              ? "now"
              : e.type === "at_property"
                ? "at the property"
                : e.dueAt
                  ? `by ${formatDateTime(e.dueAt, tz)}`
                  : "later";
          return `${formatMoney(e.amount)} ${when}`;
        })
        .join(", ")}`,
    );
  if (t.validThrough) out.push(`They can accept it until ${formatDateTime(t.validThrough, tz)}`);
  return out;
}
