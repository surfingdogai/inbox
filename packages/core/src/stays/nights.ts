import { addDays, daysBetween, instantOf, isLocalDate, isoIn, isoWeekday } from "../util/zoned";
import { WriteError } from "../write/errors";
import type { PropertyRow } from "./store";

/**
 * A stay's nights (ADR-037): local dates, the night that starts on each, from check-in up to the day
 * before check-out. Never minutes: a change of clocks or a zone across the date line cannot move one.
 */

/** The nights of a stay, as local dates: `["2026-12-12", "2026-12-13", "2026-12-14"]` for 12–15 Dec. */
export function nightsOf(checkIn: string, checkOut: string): string[] {
  const n = daysBetween(checkIn, checkOut);
  return Array.from({ length: Math.max(0, n) }, (_, i) => addDays(checkIn, i));
}

/** Monday 1 … Sunday 64, the bit a rate's `weekdays` mask carries for a night. */
export function weekdayBit(night: string): number {
  return 1 << (isoWeekday(night) - 1);
}

/** Whether a date-ranged row (inclusive nights; '' for none) covers a night on its weekday. */
export function covers(
  row: { readonly fromDate: string; readonly toDate: string; readonly weekdays: number },
  night: string,
): boolean {
  if ((row.weekdays & weekdayBit(night)) === 0) return false;
  if (row.fromDate === "") return true;
  return row.fromDate <= night && night <= (row.toDate || row.fromDate);
}

/**
 * When a stay starts and ends, as the inbox writes them on the item: check-in date at the property's
 * check-in time and check-out date at its check-out time, in its zone, with the offset of the day.
 */
export function stayTimes(
  p: Pick<PropertyRow, "checkInFrom" | "checkOutUntil" | "timezone">,
  checkIn: string,
  checkOut: string,
): { startTime: string; endTime: string; startAt: number; endAt: number } {
  const startAt = instantOf(checkIn, p.checkInFrom, p.timezone);
  const endAt = instantOf(checkOut, p.checkOutUntil, p.timezone);
  return { startTime: isoIn(startAt, p.timezone), endTime: isoIn(endAt, p.timezone), startAt, endAt };
}

/** Checks a stay's dates: real dates, departure after arrival, within the property's longest stay. */
export function checkDates(
  p: Pick<PropertyRow, "maxNights">,
  checkIn: string,
  checkOut: string,
  path = "payload",
): void {
  const bad = (field: string, message: string) =>
    new WriteError("invalid_input", message, { fields: [{ path: `${path}.${field}`, problem: "invalid", message }] });
  if (!isLocalDate(checkIn)) throw bad("checkIn", "a date as YYYY-MM-DD");
  if (!isLocalDate(checkOut)) throw bad("checkOut", "a date as YYYY-MM-DD");
  const n = daysBetween(checkIn, checkOut);
  if (n < 1) throw bad("checkOut", "the departure must be after the arrival");
  if (n > p.maxNights) throw bad("checkOut", `stays here are at most ${p.maxNights} nights`);
}
