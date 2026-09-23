import type { Item, Money } from "./types";

/**
 * How the valid transitions of an item become buttons, and what each event asks for. Mirrors the
 * per-event inputs in core's machine tables; the confirmation uses the same words as the button.
 */
export type ButtonTone = "primary" | "secondary" | "danger";

const DANGER_EVENTS = new Set([
  "decline",
  "reject",
  "mark_spam",
  "no_show",
  "payment_failed",
  "charge_back",
  "record_charge_back",
  "record_cancel",
  "record_cancel_late",
]);

export function isDanger(event: string): boolean {
  return DANGER_EVENTS.has(event) || event.startsWith("cancel");
}

/** The API ranks the happy path first; whatever the ranking, destructive actions come last. */
export function orderActions<T extends { readonly event: string }>(transitions: readonly T[]): T[] {
  return [...transitions.filter((t) => !isDanger(t.event)), ...transitions.filter((t) => isDanger(t.event))];
}

/** Buttons in the order the API gives them: the first non-destructive one is primary. */
export function tonesFor(transitions: readonly { readonly event: string }[]): ButtonTone[] {
  let primaryGiven = false;
  return transitions.map((t) => {
    if (isDanger(t.event)) return "danger";
    if (!primaryGiven) {
      primaryGiven = true;
      return "primary";
    }
    return "secondary";
  });
}

export type InputKind =
  | "none"
  | "note"
  | "propose"
  | "quote"
  | "payment"
  | "payment_request"
  /** The customer asked to cancel: what they said, and when. */
  | "customer_cancel"
  /** The customer said yes to the time we proposed: how, for the record. */
  | "agreed";

/** What an event asks the owner for. `state` is the item's, where it changes the question. */
export function inputKindFor(event: string, state?: string): InputKind {
  switch (event) {
    case "record_cancel":
    case "record_cancel_late":
      return "customer_cancel";
    case "confirm":
      return state === "proposed" ? "agreed" : "none";
    case "propose":
      return "propose";
    case "quote":
      return "quote";
    case "record_payment":
    case "refund":
      return "payment";
    case "request_payment":
      return "payment_request";
    case "request_info":
    case "decline":
    case "cancel":
    case "cancel_by_business":
    case "reject":
    case "payment_failed":
      return "note";
    default:
      return "none";
  }
}

/** A datetime-local value (browser local time) → ISO 8601 with offset, as the API wants. */
export function localToIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO 8601 → the value a datetime-local input shows, in browser local time. */
export function isoToLocal(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * An amount as a person types it, in major units, to minor units: `45`, `45,5`, `45,50`, `45.50`,
 * `1 234,50`, `1.234,50` and `1,234.50` all read as they are meant (when both `.` and `,` appear,
 * the last is the decimal mark; one followed by exactly three digits groups thousands). Anything
 * else — a sign, a letter, three decimals, a stray separator — is undefined, never a guess: a price
 * typed with a comma was once saved as free. The one parser every price field uses.
 */
export function parseMajor(typed: string): number | undefined {
  const text = typed.trim().replace(/[\s\u00a0\u202f]/g, (m, i: number, all: string) =>
    // A space only between digit groups: "1 234,50".
    /\d/.test(all[i - 1] ?? "") && /^\d{3}(\D|$)/.test(all.slice(i + 1)) ? "" : m,
  );
  if (!/^\d[\d.,]*$/.test(text)) return undefined;
  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");
  let whole = text;
  let cents = "";
  if (lastDot !== -1 && lastComma !== -1) {
    const mark = Math.max(lastDot, lastComma);
    whole = text.slice(0, mark);
    cents = text.slice(mark + 1);
    if (!/^\d{1,2}$/.test(cents)) return undefined;
    const group = mark === lastDot ? "," : ".";
    if (whole.includes(mark === lastDot ? "." : ",")) return undefined;
    if (!grouped(whole, group)) return undefined;
    whole = whole.replaceAll(group, "");
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? "." : ",";
    const parts = text.split(sep);
    const tail = parts[parts.length - 1] ?? "";
    if (parts.length === 2 && /^\d{1,2}$/.test(tail)) {
      whole = parts[0] ?? "";
      cents = tail;
    } else if (grouped(text, sep)) {
      whole = parts.join("");
    } else {
      return undefined;
    }
  }
  if (!/^\d+$/.test(whole)) return undefined;
  const value = Number(whole) * 100 + Number(cents.padEnd(2, "0") || "0");
  return Number.isSafeInteger(value) ? value : undefined;
}

/** "1.234.567" with `.` grouping: a first group of one to three digits, then groups of three. */
function grouped(text: string, sep: string): boolean {
  const parts = text.split(sep);
  if (parts.length < 2) return /^\d+$/.test(text);
  return /^[1-9]\d{0,2}$/.test(parts[0] ?? "") && parts.slice(1).every((p) => /^\d{3}$/.test(p));
}

/** A typed amount (`parseMajor`) with its currency. */
export function parseMoney(major: string, currency: string): Money | undefined {
  const value = parseMajor(major);
  return value === undefined ? undefined : { value, currency };
}

export function moneyMajor(m: Money | undefined): string {
  return m ? (m.value / 100).toFixed(2) : "";
}

export interface QuoteLine {
  readonly name: string;
  readonly quantity: number;
  readonly price: Money;
}

export function sumLines(lines: readonly QuoteLine[], currency: string): Money {
  return { value: lines.reduce((total, l) => total + l.quantity * l.price.value, 0), currency };
}

/**
 * What an action does that its label cannot say, for the confirmation: that Confirm on a proposed
 * booking books the time we proposed, and that recording a customer's cancellation makes it theirs.
 */
export function actionNote(
  event: string,
  item: Item,
  formatWhen: (iso: string) => string,
  notice: { readonly minNoticeMin: number; readonly now: number } = { minNoticeMin: 0, now: Date.now() },
): string | null {
  if (event === "confirm" && item.type === "booking") {
    const proposed = item.state === "proposed" ? item.payload.proposed : undefined;
    const start = Date.parse(proposed?.startTime ?? item.payload.startTime);
    // Inside the notice customers can no longer book it; a person at the business still may.
    const soon =
      start > notice.now && start - notice.now < notice.minNoticeMin * 60_000
        ? ` It starts within your minimum notice of ${notice.minNoticeMin} minutes: customers can no longer book it online, but you can.`
        : "";
    if (proposed) {
      return `This books ${formatWhen(proposed.startTime)}, the time you proposed. Use it when the customer said yes by phone, email or in person.${soon}`;
    }
    if (soon) return soon.trim();
  }
  if (event === "record_cancel" || event === "record_cancel_late") {
    return "It counts as the customer's cancellation, not yours, and we tell them it is cancelled as they asked.";
  }
  return null;
}

/**
 * While the item waits on the customer (a time or a quote we proposed, a question we asked), one
 * line saying so, and until when they can answer; null when it waits on the business or on nobody.
 */
export function waitingLine(item: Item, formatWhen: (iso: string) => string, minNoticeMin = 0): string | null {
  if (item.type === "booking" && item.state === "proposed" && item.payload.proposed) {
    // The customer answers by the start less the minimum notice, as their email says.
    const until = new Date(Date.parse(item.payload.proposed.startTime) - minNoticeMin * 60_000).toISOString();
    return `Waiting for the customer's answer until ${formatWhen(until)}.`;
  }
  if (item.type === "quote_request" && item.state === "quoted" && item.payload.quote) {
    return `Waiting for the customer's answer until ${formatWhen(item.payload.quote.validThrough)}.`;
  }
  if (item.state === "needs_info") return "Waiting for the customer's details.";
  return null;
}

/**
 * What the networks make of an outcome the owner is about to record (ADR-017 §3), in one sentence
 * for the confirmation, or null when there is nothing to say. Nothing here decides anything: the
 * network works out notice from the dates; this only tells the owner beforehand.
 */
export function networkNote(event: string, item: Item, now: number = Date.now()): string | null {
  if (item.type === "booking" && item.state === "confirmed") {
    if (event === "cancel_by_business") {
      const notice = Date.parse(item.payload.startTime) - now;
      return notice >= 24 * 3_600_000
        ? "With a day's notice or more, networks count this cancellation at half against you."
        : "Under 24 hours before the start, networks count this cancellation fully against you.";
    }
    if (event === "no_show") {
      return "Networks record a no-show against the customer. You can correct it once, until the booking would have completed on its own.";
    }
  }
  if (item.type === "booking" && (item.state === "no_show" || item.state === "completed")) {
    if (event === "complete" || event === "no_show")
      return "A correction can be made once; the later record is the one that counts.";
  }
  if (item.type === "order") {
    if (event === "cancel" && ["accepted", "awaiting_payment", "payment_failed"].includes(item.state)) {
      return "You accepted this order: networks count cancelling it now as an order not fulfilled.";
    }
    if (event === "payment_failed")
      return "Networks count a failed payment at half against the customer; they can still pay.";
    if (event === "charge_back" || event === "record_charge_back") {
      return "Networks count a charge-back against the customer. Record one only when the bank reversed the payment.";
    }
  }
  return null;
}
