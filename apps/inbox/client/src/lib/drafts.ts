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

type Amount = { readonly value: number; readonly currency: string };

/** A stay's cancellation policy, dated for its nights (spec `datedPolicySchema`): each step, then after, and no-show. */
interface DatedPolicy {
  readonly steps: readonly { readonly until: string; readonly fee: Amount }[];
  readonly after: Amount;
  readonly noShow: Amount;
  readonly zone?: string;
}

const isAmount = (m: unknown): m is Amount =>
  typeof m === "object" &&
  m !== null &&
  typeof (m as Amount).value === "number" &&
  typeof (m as Amount).currency === "string";

/** A stay's rate plan, as its quote holds it: its name, and whether it is refundable. */
function ratePlanOf(t: DraftView["terms"]): { name: string; refundable: boolean } | null {
  const p = (t as { ratePlan?: unknown }).ratePlan as { name?: unknown; refundable?: unknown } | undefined;
  return p && typeof p.name === "string" && p.name.trim() && typeof p.refundable === "boolean"
    ? { name: p.name.trim(), refundable: p.refundable }
    : null;
}

function policyOf(t: DraftView["terms"]): DatedPolicy | null {
  const p = (t as { policy?: unknown }).policy as Partial<DatedPolicy> | undefined;
  if (!p || !Array.isArray(p.steps) || !isAmount(p.after) || !isAmount(p.noShow)) return null;
  if (!p.steps.every((s) => typeof s?.until === "string" && isAmount(s.fee))) return null;
  return p as DatedPolicy;
}

/**
 * A stay's cancellation, as its guest is sent it (`policySentence`, in the owner's words and clock):
 * "Free cancellation until Thu, Dec 10, 23:59; after that KES 6,500.00; no-show KES 6,500.00". A fee of
 * the whole total is "the full stay", none is "nothing".
 */
function policyWords(p: DatedPolicy, total: Amount | undefined, tz: string | undefined): string {
  const zone = p.zone || tz;
  const fee = (m: Amount) =>
    m.value === 0
      ? "nothing"
      : total && m.value === total.value && m.currency === total.currency
        ? "the full stay"
        : formatMoney(m);
  const parts = p.steps.map((s) =>
    s.fee.value === 0
      ? `free cancellation until ${formatDateTime(s.until, zone)}`
      : `until ${formatDateTime(s.until, zone)}, cancelling costs ${fee(s.fee)}`,
  );
  parts.push(p.steps.length ? `after that ${fee(p.after)}` : `cancelling costs ${fee(p.after)}`);
  parts.push(`no-show ${fee(p.noShow)}`);
  const words = parts.join("; ");
  return words.charAt(0).toUpperCase() + words.slice(1);
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
 * owner's words: the people, delivery, fees, stages, tax, the tip and deposit; a stay's rate plan, what
 * it includes, what is paid when, its cancellation and whether a card holds it; and until when it holds.
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
  // A stay's rate plan and what it includes, as its quote is sent.
  const plan = ratePlanOf(t);
  if (plan) out.push(`${plan.name}, ${plan.refundable ? "refundable" : "not refundable"}`);
  const raw = (t as { includes?: unknown }).includes;
  const included = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  if (included.length) out.push(`Includes: ${included.map((x) => x.trim()).join(", ")}`);
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
  // A stay's cancellation, and whether a card holds it, as the guest is sent them.
  const policy = policyOf(t);
  if (policy) out.push(policyWords(policy, t.totalPrice, tz));
  const guarantee = (t as { guarantee?: unknown }).guarantee;
  if (guarantee === "card") out.push("A card holds the booking; nothing is charged now");
  else if (guarantee === "none") out.push("No card needed to hold it");
  if (t.validThrough) out.push(`They can accept it until ${formatDateTime(t.validThrough, tz)}`);
  return out;
}
