/**
 * Dates and wall-clock times in a business's own zone, as plain data: a local date is `YYYY-MM-DD`,
 * a wall time `HH:MM` or `HH:MM:SS`, and an instant milliseconds since the epoch. Dates never pass
 * through minutes or milliseconds, so a change of clocks, a 30-minute daylight saving (Lord Howe) or
 * a zone that skipped a whole day across the date line (Apia, Kiritimati) cannot shift one.
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const DAY_MS = 86_400_000;

/** A zone the runtime knows, or UTC. */
export function knownZone(zone: string): string {
  if (!zone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();
function fmt(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formats.set(zone, f);
  }
  return f;
}

/** The wall clock of an instant in a zone. */
export function wallOf(
  ms: number,
  zone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = fmt(knownZone(zone)).formatToParts(new Date(ms));
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

/** How far the zone's wall clock is ahead of UTC at an instant, in milliseconds. */
export function offsetAt(ms: number, zone: string): number {
  const p = wallOf(ms, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** The local date of an instant in a zone: `YYYY-MM-DD`. */
export function dateIn(ms: number, zone: string): string {
  const p = wallOf(ms, zone);
  return `${String(p.year).padStart(4, "0")}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * The instant a wall-clock time on a local date is in a zone. A time the clocks skip (a spring-forward
 * gap) moves forward by the gap, as Temporal's "compatible" choice does (00:30 in a one-hour gap at
 * midnight is 01:30); a time that comes twice (the autumn fold) is the first of the two.
 */
export function instantOf(date: string, time: string, zone: string): number {
  const d = DATE.exec(date);
  const t = TIME.exec(time);
  if (!d || !t) throw new RangeError(`not a local date and time: ${date} ${time}`);
  const z = knownZone(zone);
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), Number(t[3] ?? 0));
  // Two candidates around the wall time: with the offset just before it and just after it.
  const before = wall - offsetAt(wall - DAY_MS / 2, z);
  const after = wall - offsetAt(wall + DAY_MS / 2, z);
  const fits = (ms: number) => offsetAt(ms, z) + ms === wall;
  const candidates = [before, after].filter(fits).sort((a, b) => a - b);
  if (candidates[0] !== undefined) return candidates[0];
  // In a gap: the wall time read with the offset from before the jump, which lands after it.
  return Math.max(before, after);
}

/** An instant as an ISO 8601 timestamp with the zone's offset then: `2026-12-09T23:59:59+09:00`. */
export function isoIn(ms: number, zone: string): string {
  const z = knownZone(zone);
  const p = wallOf(ms, z);
  const offsetMin = Math.round(offsetAt(ms, z) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const off = offsetMin === 0 ? "Z" : `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${String(p.year).padStart(4, "0")}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${off}`;
}

/** A local date plus whole days (negative goes back): calendar arithmetic, no zone involved. */
export function addDays(date: string, days: number): string {
  const d = DATE.exec(date);
  if (!d) throw new RangeError(`not a local date: ${date}`);
  const t = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])) + days * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/** Calendar days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: string, b: string): number {
  const x = DATE.exec(a);
  const y = DATE.exec(b);
  if (!x || !y) throw new RangeError(`not local dates: ${a}, ${b}`);
  const ta = Date.UTC(Number(x[1]), Number(x[2]) - 1, Number(x[3]));
  const tb = Date.UTC(Number(y[1]), Number(y[2]) - 1, Number(y[3]));
  return Math.round((tb - ta) / DAY_MS);
}

/** Whether a string is a real calendar date `YYYY-MM-DD` (not 2026-02-30). */
export function isLocalDate(date: string): boolean {
  const d = DATE.exec(date);
  if (!d) return false;
  const t = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])));
  return t.toISOString().slice(0, 10) === date;
}

/** The weekday of a local date, Monday 1 … Sunday 7 (ISO 8601). */
export function isoWeekday(date: string): number {
  const d = DATE.exec(date);
  if (!d) throw new RangeError(`not a local date: ${date}`);
  const w = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]))).getUTCDay();
  return w === 0 ? 7 : w;
}

const pad = (n: number) => String(n).padStart(2, "0");
