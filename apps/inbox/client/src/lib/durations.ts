/**
 * Lengths of time as the owner picks them: a few usual ones, one press each, and any other in the
 * unit people use (minutes, hours, days), said back in words ("24 hours", "1 week"). The settings
 * keep each in its own unit (`cancellationWindowMin` in minutes, `autoExpireHours` in hours,
 * `payDays` in days); nothing here changes what is stored, only how it is chosen.
 */

export type DurationUnit = "min" | "h" | "days";

const PER: Readonly<Record<DurationUnit, number>> = { min: 1, h: 60, days: 1440 };

/** A value in `unit` as minutes. */
export function inMinutes(value: number, unit: DurationUnit): number {
  return value * PER[unit];
}

/** Minutes as a value in `unit`, rounded to a whole one. */
export function fromMinutes(minutes: number, unit: DurationUnit): number {
  return Math.round(minutes / PER[unit]);
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** 0 → "None"; 30 → "30 minutes"; 90 → "1 hour 30 minutes"; 1440 → "1 day"; 10080 → "1 week". */
export function durationWords(minutes: number, none = "None"): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return none;
  if (minutes % 10080 === 0) return plural(minutes / 10080, "week");
  if (minutes % 1440 === 0) return plural(minutes / 1440, "day");
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  return [days ? plural(days, "day") : "", hours ? plural(hours, "hour") : "", mins ? plural(mins, "minute") : ""]
    .filter(Boolean)
    .join(" ");
}

/** The unit an amount of minutes reads best in, for the field that takes another one. */
export function bestUnit(minutes: number, allowed: readonly DurationUnit[]): DurationUnit {
  for (const unit of ["days", "h", "min"] as const) {
    if (allowed.includes(unit) && minutes > 0 && minutes % PER[unit] === 0) return unit;
  }
  return allowed[allowed.length - 1] ?? "min";
}

export interface DurationPreset {
  /** In the field's own unit; null is "none set" (an empty, optional field). */
  readonly value: number | null;
  readonly label: string;
}

const m = (value: number, label: string): DurationPreset => ({ value, label });

/** The usual choices, field by field, each in the unit its setting keeps. */
export const DURATION_PRESETS = {
  /** `booking.cancellationWindowMin`, minutes. */
  cancellation: [m(0, "None"), m(120, "2 h"), m(720, "12 h"), m(1440, "24 h"), m(2880, "48 h")],
  /** `booking.minNoticeMin`, minutes. */
  notice: [m(0, "None"), m(30, "30 min"), m(60, "1 h"), m(120, "2 h"), m(1440, "1 day")],
  /** Holds and lapses in hours: `booking.autoExpireHours`, `negotiation.offerValidHours`, `counterValidHours`. */
  holdHours: [m(24, "1 day"), m(48, "2 days"), m(72, "3 days"), m(168, "1 week")],
  /** `booking.autoCompleteHours`, hours (one week at most). */
  completeHours: [m(12, "12 h"), m(24, "1 day"), m(48, "2 days"), m(72, "3 days")],
  /** `negotiation.ai.maxTimeShiftMin`, as the form holds it: hours. */
  shiftHours: [m(0, "None"), m(2, "2 h"), m(24, "1 day"), m(48, "2 days"), m(168, "1 week")],
  /** `negotiation.changes.customerCutoffMin`, minutes; none is the cancellation window. */
  cutoff: [{ value: null, label: "Same as cancelling" }, m(120, "2 h"), m(1440, "24 h"), m(2880, "48 h")],
  /** `customers.otp.ttlMinutes`, minutes (an hour at most). */
  codeMinutes: [m(5, "5 min"), m(10, "10 min"), m(15, "15 min"), m(30, "30 min"), m(60, "1 h")],
  /** Days: `orders.payDays`, `orders.dueDays`. */
  orderDays: [m(3, "3 days"), m(7, "1 week"), m(14, "2 weeks"), m(30, "30 days")],
  /** `negotiation.ai.maxDelayDays`, days. */
  delayDays: [m(0, "None"), m(1, "1 day"), m(3, "3 days"), m(7, "1 week")],
  /** `returns.days`, days (14 at least, by law). */
  returnDays: [m(14, "14 days"), m(30, "30 days"), m(60, "60 days")],
  /** `returns.respondHours`, hours. */
  respondHours: [m(24, "1 day"), m(48, "2 days"), m(72, "3 days"), m(168, "1 week")],
} as const satisfies Record<string, readonly DurationPreset[]>;

/** Whether a typed value is one of the presets, compared as numbers ("1440" is 1440). */
export function isPreset(value: string, presets: readonly DurationPreset[]): boolean {
  const t = value.trim();
  return presets.some((p) => (p.value === null ? t === "" : t !== "" && Number(t) === p.value));
}
