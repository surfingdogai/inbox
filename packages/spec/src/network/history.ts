import { type DoorHistoryEntry, doorTypeSchema } from "./directory";

/**
 * A door's history (`docs/protocol/network.md` §4.8, ADR-020): what the public sees of one door type at one host,
 * from the line a day a network keeps of its own reads. The network's code is held to `vectors/door-history.json`
 * as this is.
 *
 * A day is checked when the network's daily read of a door it reads every day (a member's or a claimed listing's)
 * concluded. A read an agent's report or the business asked for is a read of the door and never a check. A check is
 * missed when it failed, or was blocked while the door is down by the network's reads; a day is answered only when
 * none of its checks was missed, so a day with a failure and an answer fifteen minutes later is a day missed. The
 * share shows from 14 checked days, floored to the whole percent: never 100% with a day missed.
 */

/** The fewest checked days the share shows from. */
export const DOOR_HISTORY_MIN_DAYS = 14;
/** The days `recent` covers, ending on `as_of`. */
export const DOOR_HISTORY_RECENT_DAYS = 90;
/** A door last checked more than this many days before `as_of` says "from … to …" instead of "since …". */
export const DOOR_HISTORY_CURRENT_DAYS = 7;

/**
 * One door type at one host as a network stores it. `type` is a door type as `vocab/doors.json` names it; `days_seen`
 * the days a read found it answering; `days` are `[day, answered, missed]`, that day's daily checks.
 */
export interface DoorHistoryInput {
  readonly type: string;
  readonly host: string;
  readonly first_seen: string | null;
  readonly last_seen: string | null;
  readonly days_seen: number;
  readonly current: boolean;
  readonly days: readonly (readonly [string, number, number])[];
}

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Whether a door of this type has a history the public sees: a type of `vocab/doors.json`, or a platform's
 * (`doorTypeSchema`); never an experimental one, nor anything else.
 */
function shown(type: string): boolean {
  return doorTypeSchema.safeParse(type).success;
}

/** A `YYYY-MM-DD` day as a count of days since 1970-01-01. */
function dayNumber(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

function dayString(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** "3 Oct 2026". */
function dayWords(n: number): string {
  const d = new Date(n * DAY_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** What the public sees of `entry` on `asOf` (a UTC day): null for a type never shown, or a door never seen answering. */
export function doorHistoryOf(entry: DoorHistoryInput, asOf: string): DoorHistoryEntry | null {
  if (!shown(entry.type) || !entry.first_seen || !entry.last_seen) return null;
  const today = dayNumber(asOf);
  const out: DoorHistoryEntry = {
    type: entry.type,
    host: entry.host,
    first_seen: entry.first_seen,
    last_seen: entry.last_seen,
    // never fewer than the days its first and last name
    days_seen: Math.max(entry.days_seen, entry.first_seen === entry.last_seen ? 1 : 2),
    current: entry.current,
  };
  const byDay = new Map<number, { answered: number; missed: number }>();
  for (const [day, answered, missed] of entry.days) {
    const n = dayNumber(day);
    if (n > today || answered < 0 || missed < 0 || answered + missed === 0) continue;
    const cur = byDay.get(n) ?? { answered: 0, missed: 0 };
    byDay.set(n, { answered: cur.answered + answered, missed: cur.missed + missed });
  }
  if (byDay.size < DOOR_HISTORY_MIN_DAYS) return out;
  const keys = [...byDay.keys()];
  const first = Math.min(...keys);
  const last = Math.max(...keys);
  const answered = [...byDay.values()].filter((d) => d.missed === 0).length;
  let recent = "";
  for (let i = DOOR_HISTORY_RECENT_DAYS - 1; i >= 0; i--) {
    const d = byDay.get(today - i);
    recent += d === undefined ? "." : d.missed === 0 ? "a" : "x";
  }
  const days = byDay.size;
  out.checks = { first_checked: dayString(first), last_checked: dayString(last), days, answered, recent };
  const when =
    today - last > DOOR_HISTORY_CURRENT_DAYS
      ? `from ${dayWords(first)} to ${dayWords(last)}`
      : `since ${dayWords(first)}`;
  out.summary = `Answered every check on ${Math.floor((answered * 100) / days)}% of days checked ${when} (${answered} of ${days}).`;
  return out;
}
