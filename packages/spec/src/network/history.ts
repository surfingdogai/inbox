import type { DoorHistoryEntry } from "./directory";

/**
 * A door's history (`docs/protocol/network.md` §4.8, ADR-020): what the public sees of one door type at one host,
 * from the line a day a network keeps of its own reads. The network's code is held to `vectors/door-history.json`
 * as this is.
 *
 * A day is checked when a read of the daily set (a member's or a claimed listing's door, read every day) concluded,
 * answered or failed; a blocked read is the business's to hear about and is no check. A day is answered only when
 * none of its checks failed, so a day with a failure and an answer fifteen minutes later is a day missed. The share
 * shows from 14 checked days, floored to the whole percent: never 100% with a day missed.
 */

/** The fewest checked days the share shows from. */
export const DOOR_HISTORY_MIN_DAYS = 14;
/** The days `recent` covers, ending on `as_of`. */
export const DOOR_HISTORY_RECENT_DAYS = 90;
/** A door last checked more than this many days before `as_of` says "from … to …" instead of "since …". */
export const DOOR_HISTORY_CURRENT_DAYS = 7;

/** The stored door types whose history is shown, by their public names (§4.8): never llms.txt, WebMCP or a page. */
export const DOOR_HISTORY_PUBLIC_TYPES: Readonly<Record<string, string>> = {
  agent_inbox: "inbox",
  mcp: "mcp",
  shopify_mcp: "platform:shopify",
  a2a: "a2a",
  openapi: "openapi",
  api: "api",
  ucp: "ucp",
  acp: "acp",
  nlweb: "nlweb",
  webhook: "webhook",
  other: "other",
};

/** One door type at one host as a network stores it: `days` are `[day, answered, failed]` of the daily set's reads. */
export interface DoorHistoryInput {
  readonly type: string;
  readonly host: string;
  readonly first_seen: string | null;
  readonly last_seen: string | null;
  readonly current: boolean;
  readonly days: readonly (readonly [string, number, number])[];
}

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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
  const type = DOOR_HISTORY_PUBLIC_TYPES[entry.type];
  if (!type || !entry.first_seen || !entry.last_seen) return null;
  const today = dayNumber(asOf);
  const out: DoorHistoryEntry = {
    type,
    host: entry.host,
    first_seen: entry.first_seen,
    last_seen: entry.last_seen,
    current: entry.current,
  };
  const byDay = new Map<number, { good: number; failed: number }>();
  for (const [day, good, failed] of entry.days) {
    const n = dayNumber(day);
    if (n > today || good < 0 || failed < 0 || good + failed === 0) continue;
    const cur = byDay.get(n) ?? { good: 0, failed: 0 };
    byDay.set(n, { good: cur.good + good, failed: cur.failed + failed });
  }
  if (byDay.size < DOOR_HISTORY_MIN_DAYS) return out;
  const keys = [...byDay.keys()];
  const first = Math.min(...keys);
  const last = Math.max(...keys);
  const answered = [...byDay.values()].filter((d) => d.failed === 0).length;
  let recent = "";
  for (let i = DOOR_HISTORY_RECENT_DAYS - 1; i >= 0; i--) {
    const d = byDay.get(today - i);
    recent += d === undefined ? "." : d.failed === 0 ? "a" : "x";
  }
  const days = byDay.size;
  out.checks = { since: dayString(first), last: dayString(last), days, answered, recent };
  const when =
    today - last > DOOR_HISTORY_CURRENT_DAYS
      ? `from ${dayWords(first)} to ${dayWords(last)}`
      : `since ${dayWords(first)}`;
  out.summary = `Answered ${Math.floor((answered * 100) / days)}% of daily checks ${when} (${answered} of ${days} days).`;
  return out;
}
