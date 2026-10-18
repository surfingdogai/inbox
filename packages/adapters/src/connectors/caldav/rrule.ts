import type { WallTime } from "./zones";

/**
 * Repeating events (RFC 5545 §3.3.10), for a calendar server that hands back the master event rather
 * than its occurrences (most expand them when asked, and are asked). The rules people make in a
 * calendar app are covered: every day, every week on these days, every month on a date or on the
 * second Tuesday, every year, with an interval, a count or an end date. Occurrences are made on wall
 * time in the event's zone, so a weekly ten o'clock stays at ten across a change of clocks. A rule
 * this does not read (BYSETPOS, BYWEEKNO, BYYEARDAY, anything more often than daily) yields `null`.
 */

export interface RRule {
  readonly freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  readonly interval: number;
  readonly count: number | null;
  /** Inclusive, as an instant. */
  readonly until: number | null;
  readonly byDay: readonly { readonly n: number | null; readonly wd: number }[];
  readonly byMonthDay: readonly number[];
  readonly byMonth: readonly number[];
  readonly wkst: number;
}

const WD: Readonly<Record<string, number>> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Reads a rule; null for one this does not handle. `untilOf` turns an UNTIL value into an instant. */
export function parseRRule(text: string, untilOf: (value: string) => number | null): RRule | null {
  const parts = new Map<string, string>();
  for (const part of text.split(";")) {
    const [k, v] = part.split("=");
    if (k && v !== undefined) parts.set(k.trim().toUpperCase(), v.trim().toUpperCase());
  }
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  for (const unsupported of ["BYSETPOS", "BYWEEKNO", "BYYEARDAY", "BYHOUR", "BYMINUTE", "BYSECOND"]) {
    if (parts.has(unsupported)) return null;
  }
  const interval = Math.max(1, Number(parts.get("INTERVAL") ?? "1") || 1);
  const countRaw = parts.get("COUNT");
  const count = countRaw ? Math.max(0, Number(countRaw) || 0) : null;
  const untilRaw = parts.get("UNTIL");
  const until = untilRaw ? untilOf(untilRaw) : null;
  if (untilRaw && until === null) return null;
  const byDay: { n: number | null; wd: number }[] = [];
  for (const d of (parts.get("BYDAY") ?? "").split(",").filter(Boolean)) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d);
    if (!m) return null;
    byDay.push({ n: m[1] ? Number(m[1]) : null, wd: WD[m[2] ?? "MO"] ?? 1 });
  }
  const byMonthDay = (parts.get("BYMONTHDAY") ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n !== 0 && Math.abs(n) <= 31);
  const byMonth = (parts.get("BYMONTH") ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
  return { freq, interval, count, until, byDay, byMonthDay, byMonth, wkst: WD[parts.get("WKST") ?? "MO"] ?? 1 };
}

const MAX_STEPS = 20_000;

/**
 * The starts of every occurrence from `dtstart` (included, as RFC 5545 counts it) up to `before`,
 * after `after` only. `toMs` places a wall time in the event's zone.
 */
export function expandRRule(
  rule: RRule,
  dtstart: WallTime,
  toMs: (w: WallTime) => number,
  window: { readonly after: number; readonly before: number },
): number[] {
  const out: number[] = [];
  const startMs = toMs(dtstart);
  let produced = 0;
  const emit = (y: number, m: number, d: number): boolean => {
    const ms = toMs({ ...dtstart, year: y, month: m, day: d });
    if (ms < startMs) return true;
    if (rule.until !== null && ms > rule.until) return false;
    if (ms >= window.before) return false;
    produced++;
    if (rule.count !== null && produced > rule.count) return false;
    if (ms + 1 > window.after) out.push(ms);
    return true;
  };

  const base = Date.UTC(dtstart.year, dtstart.month - 1, dtstart.day);
  const dayOf = (ms: number) => {
    const d = new Date(ms);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay() };
  };

  if (rule.freq === "DAILY") {
    for (let i = 0, step = 0; step < MAX_STEPS; i += rule.interval, step++) {
      const day = dayOf(base + i * 86_400_000);
      if (rule.byMonth.length && !rule.byMonth.includes(day.m)) continue;
      if (rule.byDay.length && !rule.byDay.some((b) => b.wd === day.wd)) continue;
      if (!emit(day.y, day.m, day.d)) break;
    }
    return out;
  }

  if (rule.freq === "WEEKLY") {
    const days = rule.byDay.length ? [...new Set(rule.byDay.map((b) => b.wd))] : [dayOf(base).wd];
    // The week dtstart falls in, starting on WKST.
    const startWd = dayOf(base).wd;
    const weekStart = base - ((startWd - rule.wkst + 7) % 7) * 86_400_000;
    const order = (wd: number) => (wd - rule.wkst + 7) % 7;
    const sorted = days.sort((a, b) => order(a) - order(b));
    for (let w = 0, step = 0; step < MAX_STEPS; w += rule.interval, step++) {
      let more = true;
      for (const wd of sorted) {
        const day = dayOf(weekStart + (w * 7 + order(wd)) * 86_400_000);
        if (rule.byMonth.length && !rule.byMonth.includes(day.m)) continue;
        if (!emit(day.y, day.m, day.d)) {
          more = false;
          break;
        }
      }
      if (!more) break;
    }
    return out;
  }

  const monthDays = (y: number, m: number): number[] => {
    const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const picked = new Set<number>();
    if (rule.byMonthDay.length) {
      for (const n of rule.byMonthDay) {
        const d = n > 0 ? n : length + n + 1;
        if (d >= 1 && d <= length) picked.add(d);
      }
    }
    if (rule.byDay.length) {
      const byDay = new Set<number>();
      for (const b of rule.byDay) {
        const matches: number[] = [];
        for (let d = 1; d <= length; d++) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === b.wd) matches.push(d);
        if (b.n === null) for (const d of matches) byDay.add(d);
        else {
          const d = b.n > 0 ? matches[b.n - 1] : matches[matches.length + b.n];
          if (d !== undefined) byDay.add(d);
        }
      }
      // Both given: a day must satisfy both (RFC 5545 narrows by BYMONTHDAY first).
      if (rule.byMonthDay.length) return [...picked].filter((d) => byDay.has(d)).sort((a, b) => a - b);
      return [...byDay].sort((a, b) => a - b);
    }
    if (picked.size === 0 && dtstart.day <= length) picked.add(dtstart.day);
    return [...picked].sort((a, b) => a - b);
  };

  if (rule.freq === "MONTHLY") {
    for (let i = 0, step = 0; step < MAX_STEPS; i += rule.interval, step++) {
      const total = dtstart.month - 1 + i;
      const y = dtstart.year + Math.floor(total / 12);
      const m = (total % 12) + 1;
      if (rule.byMonth.length && !rule.byMonth.includes(m)) continue;
      let more = true;
      for (const d of monthDays(y, m)) {
        if (!emit(y, m, d)) {
          more = false;
          break;
        }
      }
      if (!more) break;
    }
    return out;
  }

  // YEARLY
  const months = rule.byMonth.length ? [...rule.byMonth].sort((a, b) => a - b) : [dtstart.month];
  for (let i = 0, step = 0; step < MAX_STEPS / 12; i += rule.interval, step++) {
    const y = dtstart.year + i;
    let more = true;
    for (const m of months) {
      const days =
        rule.byDay.length || rule.byMonthDay.length
          ? monthDays(y, m)
          : dtstart.day <= new Date(Date.UTC(y, m, 0)).getUTCDate()
            ? [dtstart.day]
            : [];
      for (const d of days) {
        if (!emit(y, m, d)) {
          more = false;
          break;
        }
      }
      if (!more) break;
    }
    if (!more) break;
  }
  return out;
}
