import type { Money } from "./types";

/**
 * How the valid transitions of an item become buttons, and what each event asks for. Mirrors the
 * per-event inputs in core's machine tables; the confirmation uses the same words as the button.
 */
export type ButtonTone = "primary" | "secondary" | "danger";

const DANGER_EVENTS = new Set(["decline", "reject", "mark_spam", "no_show"]);

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

export type InputKind = "none" | "note" | "propose" | "quote" | "payment" | "payment_request";

export function inputKindFor(event: string): InputKind {
  switch (event) {
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

/** "45" or "45,90" in major units → minor units with the currency. */
export function parseMoney(major: string, currency: string): Money | undefined {
  const text = major.replace(",", ".").trim();
  if (!text) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return { value: Math.round(n * 100), currency };
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
