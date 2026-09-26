import type { WithdrawalFlag } from "../domain/types";
import { addDays, type Law, workingDay } from "./holidays";

export { type Law, lawOf } from "./holidays";

/**
 * The consumer's right to withdraw from a contract made at a distance (ADR-018 §7; Directive
 * 2011/83/EU arts. 9–16, PT DL 24/2014 arts. 10–17, UK SI 2013/3134 regs. 29–36), as pure functions:
 * when the period ends, and whether the right runs for a booking or an order as it stands.
 *
 * The period is 14 days (or the business's longer `returns.days`): for goods from the day the last of
 * them reached the customer — and the customer may withdraw before that too (recital 40) — and for a
 * service from the day the contract was made. It is counted as Regulation 1182/71 counts: the day it
 * starts from is not counted, and a period that would end on a Saturday, a Sunday or a public holiday
 * ends at the end of the next working day, in the business's time zone. Told nothing of the right, the
 * customer has 12 months more (art. 10).
 */
const DAY = 86_400_000;

/** The flags that let nothing be withdrawn from, whatever the period. */
const EXCEPTIONS: ReadonlySet<string> = new Set([
  "personalised",
  "perishable",
  "sealed_hygiene",
  "sealed_media",
  "mixed",
  "dated_leisure",
  "urgent_repair",
  "digital_started",
  "price_fluctuates",
]);

/** The first exception among a contract's lines, or null when every one is `standard`. */
export function exceptionOf(flags: readonly (string | null | undefined)[]): WithdrawalFlag | null {
  for (const f of flags) if (f && EXCEPTIONS.has(f)) return f as WithdrawalFlag;
  return null;
}

export interface PeriodInput {
  /** Goods count from delivery; a service from the day the contract was made. */
  readonly kind: "goods" | "service";
  /** When the contract was made: a booking confirmed, an order accepted. */
  readonly concludedAt: number;
  /** Goods: when the last of them reached the customer. */
  readonly deliveredAt?: number | null | undefined;
  /** Goods: when they were sent (fulfilled), for when no delivery was recorded. */
  readonly fulfilledAt?: number | null | undefined;
  /** The period in days: 14, or the business's longer `returns.days`. */
  readonly days: number;
  /** With no delivery recorded, the days goods are taken to have been on their way (`returns.assumedTransitDays`). */
  readonly assumedTransitDays: number;
  /** The customer was told of the right as the law asks; told nothing, the period runs 12 months longer. */
  readonly informed?: boolean | undefined;
  readonly law: Law;
  readonly timezone: string;
}

/**
 * When the period ends, as the last millisecond of its last day in the business's zone; null while it
 * has not begun (goods not delivered yet), when the customer may withdraw already.
 */
export function withdrawalUntil(i: PeriodInput): number | null {
  const start =
    i.kind === "service"
      ? i.concludedAt
      : (i.deliveredAt ??
        (i.fulfilledAt !== null && i.fulfilledAt !== undefined ? i.fulfilledAt + i.assumedTransitDays * DAY : null));
  if (start === null || !Number.isFinite(start)) return null;
  const statutory = periodEnd(start, 14, i.law, i.timezone);
  const policy = i.days > 14 ? periodEnd(start, i.days, i.law, i.timezone) : statutory;
  const untold = i.informed === false ? monthsLater(statutory, 12, i.law, i.timezone) : statutory;
  return Math.max(policy, untold);
}

/**
 * The end of a period of `days` days from an instant, as Regulation 1182/71 counts it: the day of the
 * instant is not counted, and an end on a weekend or a public holiday moves to the end of the next
 * working day. The last millisecond of that day, in `timezone`.
 */
export function periodEnd(from: number, days: number, law: Law, timezone: string): number {
  let last = addDays(localDay(from, timezone), days);
  while (!workingDay(last, law)) last = addDays(last, 1);
  return startOfDay(addDays(last, 1), timezone) - 1;
}

/** The period's end moved on by whole months, to the end of a working day. */
function monthsLater(end: number, months: number, law: Law, timezone: string): number {
  const [y, m, d] = localDay(end, timezone).split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastOfMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  let day = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastOfMonth)))
    .toISOString()
    .slice(0, 10);
  while (!workingDay(day, law)) day = addDays(day, 1);
  return startOfDay(addDays(day, 1), timezone) - 1;
}

export type NoRight =
  /** The business sells only to businesses (`commerce.customers`). */
  | "business_customer"
  /** What was bought is excepted from the right: made to order, perishable, for a set date … */
  | "excepted"
  /** A booking nothing was paid for is a reservation, not a contract to withdraw from. */
  | "not_paid"
  /** The service has begun: what is left is the business's to settle with the customer. */
  | "started"
  /** Nothing agreed yet (a request: the customer cancels it), or the contract has ended. */
  | "not_agreed"
  /** The period has run out. */
  | "lapsed";

export interface WithdrawalRight {
  readonly available: boolean;
  /** When the period ends; null while it has not begun (goods on their way), or when there is no right. */
  readonly until: number | null;
  readonly why?: NoRight | undefined;
  /** The exception, when that is why. */
  readonly exception?: WithdrawalFlag | undefined;
}

/** The states in which a contract stands that the customer may withdraw from: an order before or after delivery, a confirmed booking. */
const ORDER_AGREED: ReadonlySet<string> = new Set([
  "accepted",
  "awaiting_payment",
  "payment_failed",
  "paid",
  "fulfilling",
  "fulfilled",
  "completed",
]);
/** An order's states after the goods went out: the period runs from delivery. */
export const ORDER_SENT: ReadonlySet<string> = new Set(["fulfilled", "completed"]);

export interface RightInput {
  readonly type: "booking" | "order";
  readonly state: string;
  /** Not a business: `commerce.customers` is not `businesses`. */
  readonly consumer: boolean;
  /** Each line's or the service's `withdrawal` flag. */
  readonly flags: readonly (string | null | undefined)[];
  /** A booking was paid at a distance (a payment or deposit recorded). */
  readonly paid: boolean;
  /** A booking's start. */
  readonly startTime?: number | undefined;
  readonly period: PeriodInput;
  readonly now: number;
}

/**
 * Whether the customer may withdraw now, and until when (ADR-018 §7). A booking only once paid at a
 * distance and before it starts; an order from its acceptance, before delivery and for the period
 * after. Excepted, sold to a business, or past the period: no right, and why.
 */
export function withdrawalRight(r: RightInput): WithdrawalRight {
  const agreed = r.type === "booking" ? r.state === "confirmed" : ORDER_AGREED.has(r.state);
  if (!agreed) return { available: false, until: null, why: "not_agreed" };
  if (!r.consumer) return { available: false, until: null, why: "business_customer" };
  const exception = exceptionOf(r.flags);
  if (exception) return { available: false, until: null, why: "excepted", exception };
  if (r.type === "booking") {
    if (!r.paid) return { available: false, until: null, why: "not_paid" };
    if (r.startTime !== undefined && r.startTime <= r.now) return { available: false, until: null, why: "started" };
  }
  // An order not yet sent can be withdrawn from whatever the date: its period has not begun.
  const until = r.type === "order" && !ORDER_SENT.has(r.state) ? null : withdrawalUntil(r.period);
  if (until !== null && r.now > until) return { available: false, until, why: "lapsed" };
  return { available: true, until };
}

/** The calendar day (YYYY-MM-DD) an instant falls on in a zone. */
export function localDay(ms: number, timezone: string): string {
  const parts = zoneParts(ms, timezone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** The first millisecond of a calendar day (YYYY-MM-DD) in a zone, daylight saving included. */
export function startOfDay(date: string, timezone: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  let t = guess - offsetAt(guess, timezone);
  // Once more at the instant found: the offset may differ there (a change of clocks overnight).
  t = guess - offsetAt(t, timezone);
  return t;
}

/** How far the zone's wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(ms: number, timezone: string): number {
  const p = zoneParts(ms, timezone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

function zoneParts(ms: number, timezone: string) {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  }
  const parts = fmt.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
