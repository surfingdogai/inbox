import { localiser, type Weekly, withinOpening } from "../capabilities/availability";
import { dateLocaliser, isClosed, readClosures } from "../capabilities/closures";
import type { Db } from "../db";
import type { ItemType } from "../domain/types";
import { machines } from "../machine/tables";
import { deliverAt, type NotifyPrefs, pushKindOf, readPrefs } from "../phones/prefs";
import { ownerOnlySql } from "../write/flags";

/**
 * How fast the business answers (ADR-028 Amendment 5): for each day, in the business's own time
 * zone, the requests that came and how soon each was first answered. Counts only: a day and numbers
 * leave here, never a word, a name or an address.
 *
 * - **A request** is what a customer or their assistant sent through one of the inbox's own doors
 *   (`REQUEST_CHANNELS`), arriving as it waits on the business (its type's first state). Never a test
 *   item (our own probes are tests), anything the spam filter held, put aside or is still screening,
 *   anything put in Spam, a notice or an account's mail, nor anything the business made itself, nor
 *   what came before `since` (the door opening).
 * - **Its first answer** is the first thing the business sent the customer about it: a reply, or a
 *   transition that answers (`ANSWER_EVENTS`: a price, Accept, Propose, Decline, a question back). A
 *   note is no answer, nor is Spam, nor closing it without a word. A rule answers only by such a
 *   transition: its reply alone ("We may know you already…", which leaves the request for a person)
 *   is no answer.
 * - **In hours**: it came while the business was open (its weekly hours and closed days; with no hours
 *   saved, all the time) and not while every phone that would have told the owner held it for its
 *   quiet hours. The hours and the phones are read as they are now.
 *
 * The headline measure is the share of the requests in hours first answered within 15 minutes, with
 * 5 and 60 beside it (`ANSWER_MINUTES`).
 */
export interface AnswerDay {
  /** The business's own date the requests came on, `YYYY-MM-DD`. */
  readonly day: string;
  /** Requests that came that day. */
  readonly requests: number;
  /** Of them, answered by now. */
  readonly answered: number;
  /** Of those answered, who answered first: a person at the business, a rule, or anything else (the owner's AI, another system's key). */
  readonly by_person: number;
  readonly by_rule: number;
  readonly by_other: number;
  /** Of the requests, those that came in hours. */
  readonly in_hours: number;
  /** Of those in hours, first answered within 5, 15 and 60 minutes. */
  readonly within_5: number;
  readonly within_15: number;
  readonly within_60: number;
  /** Of those in hours and answered, the median time to the first answer, in seconds; null when none was. */
  readonly median_s: number | null;
}

/** The doors an agent comes through. */
export const AGENT_CHANNELS = ["rest", "mcp_public", "a2a", "ucp", "acp", "arp"] as const;

/** The doors a request comes through from outside: the agents' and the people's. */
export const REQUEST_CHANNELS = [...AGENT_CHANNELS, "email", "form", "action_link"] as const;

/** What the business does that answers a request: a price or an offer, a yes, a no, a question back, a reply. */
export const ANSWER_EVENTS = [
  "answer",
  "request_info",
  "quote",
  "propose",
  "propose_change",
  "confirm",
  "accept",
  "approve",
  "decline",
  "reject",
  "cancel",
  "cancel_by_business",
] as const;

/** The minutes the counts are kept for; 15 is the headline. */
export const ANSWER_MINUTES = [5, 15, 60] as const;

const BUSINESS = ["owner", "staff", "owner_ai", "integration", "rule"] as const;
/** Who answers by a reply alone: anyone at the business but a rule, whose replies leave the request open. */
const REPLIERS = BUSINESS.filter((k) => k !== "rule");
const CUSTOMERS = ["customer_agent", "customer_human"] as const;
/** The spam filter's verdicts that reach the owner as any request does (ADR-041). */
const DELIVERED = ["delivered", "warned"] as const;

/** Our own constants, written into the SQL: never anything a caller sent. */
function words(list: readonly string[]): string {
  return list
    .map((w) => {
      if (!/^[a-z0-9_]+$/.test(w)) throw new Error(`not a word: ${w}`);
      return `'${w}'`;
    })
    .join(", ");
}

/** Each type's first state, the one a new request waits on the business in. */
function initialStates(): string {
  const when = (Object.keys(machines) as ItemType[]).map(
    (t) => `WHEN ${words([t])} THEN ${words([machines[t].initial])}`,
  );
  return `CASE i.type ${when.join(" ")} END`;
}

/**
 * The first answer found, as `<at> <actor kind> <written_by> <channel>` (packed: a subquery gives one
 * value). The door it came through tells the owner's AI from the owner: anything through the owner's
 * MCP door is the owner's AI, whatever key it holds (`causedByPerson`).
 */
const FIRST_EVENT = `(SELECT e.created_at || ' ' || e.actor_kind || ' ' || COALESCE(json_extract(e.meta, '$.written_by'), '')
      || ' ' || COALESCE(json_extract(e.meta, '$.channel'), '')
    FROM item_events e
   WHERE e.item_id = i.id AND e.seq > 1 AND e.actor_kind IN (${words(BUSINESS)}) AND e.event IN (${words(ANSWER_EVENTS)})
   ORDER BY e.seq LIMIT 1)`;
const FIRST_REPLY = `(SELECT t.created_at || ' ' || t.actor_kind || ' ' || COALESCE(t.written_by, '') || ' ' || COALESCE(t.channel, '')
    FROM thread_entries t
   WHERE t.item_id = i.id AND t.direction = 'out' AND t.actor_kind IN (${words(REPLIERS)})
   ORDER BY t.created_at LIMIT 1)`;

const REQUESTS = `SELECT i.type, i.created_at, ${FIRST_EVENT}, ${FIRST_REPLY}
  FROM items i JOIN item_events c ON c.item_id = i.id AND c.seq = 1
 WHERE i.created_at >= ? AND i.created_at < ?
   AND COALESCE(i.sandbox, 0) = 0
   AND i.state <> 'spam'
   AND (i.screen IS NULL OR i.screen IN (${words(DELIVERED)}))
   AND NOT ${ownerOnlySql("i.flags")}
   AND i.channel IN (${words(REQUEST_CHANNELS)})
   AND c.actor_kind IN (${words(CUSTOMERS)})
   AND c.to_state = ${initialStates()}`;

type Who = "person" | "rule" | "other";

interface Answer {
  readonly at: number;
  readonly who: Who;
}

function answerOf(packed: unknown): Answer | null {
  if (typeof packed !== "string" || !packed) return null;
  const [at, kind = "", writtenBy = "", channel = ""] = packed.split(" ");
  const t = Number(at);
  if (!Number.isFinite(t)) return null;
  // A rule is a rule, whatever it wrote; then the owner's AI, by what it said or the door it came
  // through (the owner's MCP door, even with an owner's key); then who said they wrote it; then who sent it.
  const who: Who =
    kind === "rule"
      ? "rule"
      : writtenBy === "automation" || channel === "mcp_owner"
        ? "other"
        : writtenBy === "person" || kind === "owner" || kind === "staff"
          ? "person"
          : "other";
  return { at: t, who };
}

/** The earlier of two answers. */
function first(a: Answer | null, b: Answer | null): Answer | null {
  if (!a) return b;
  if (!b) return a;
  return b.at < a.at ? b : a;
}

/** The business's zone, as its notifications and hours use it; UTC when it holds none a clock knows. */
async function zoneOf(db: Db): Promise<string> {
  const { rows } = await db.client.query({ sql: "SELECT timezone FROM business LIMIT 1", method: "all" });
  const tz = typeof rows[0]?.[0] === "string" ? String(rows[0][0]) : "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** Whether the business is open at an instant: its weekly hours (none saved: always) and its closed days. */
async function openingOf(db: Db, tz: string): Promise<(t: number) => boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT weekly FROM availability_rules WHERE kind = 'open' AND service_id IS NULL LIMIT 1",
    method: "all",
  });
  const raw = rows[0]?.[0];
  let weekly: Weekly = {};
  try {
    weekly = (typeof raw === "string" ? JSON.parse(raw) : (raw ?? {})) as Weekly;
  } catch {
    weekly = {};
  }
  const hours = Object.values(weekly).some((w) => Array.isArray(w) && w.length > 0);
  const closures = await readClosures(db);
  const local = localiser(tz);
  const date = dateLocaliser(tz);
  return (t) => {
    if (closures.length > 0 && isClosed(closures, date(t))) return false;
    if (!hours) return true;
    try {
      return withinOpening(local, weekly, t, t + 60_000);
    } catch {
      return true;
    }
  };
}

/** The phones that hear new requests now: their kinds and quiet hours. */
async function listeningPhones(db: Db): Promise<NotifyPrefs[]> {
  const { rows } = await db.client.query({
    sql: "SELECT notify FROM phone_devices WHERE revoked_at IS NULL AND confirmed_at IS NOT NULL AND push_state = 'on'",
    method: "all",
  });
  return rows.map((r) => readPrefs(typeof r[0] === "string" ? r[0] : null));
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const ms = sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return Math.round(ms / 1000);
}

export interface AnswerDaysOptions {
  /** `YYYY-MM`: the days of this month, in the business's own time zone. */
  readonly month: string;
  /** When the door opened (Unix ms): a request from before it is left out. */
  readonly since?: number | undefined;
}

/** A month's days, each with its counts; only days on which a request came. Null for a month that is not `YYYY-MM`. */
export async function answerDays(db: Db, opts: AnswerDaysOptions): Promise<AnswerDay[] | null> {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(opts.month);
  if (!m) return null;
  const year = Number(m[1]);
  const index = Number(m[2]) - 1;
  const tz = await zoneOf(db);
  // A local day starts at most 14 hours from its UTC midnight: the month's requests are inside this.
  const margin = 15 * 3_600_000;
  const from = Math.max(Date.UTC(year, index, 1) - margin, opts.since ?? 0);
  const to = Date.UTC(year, index + 1, 1) + margin;
  if (from >= to) return [];
  const { rows } = await db.client.query({ sql: REQUESTS, params: [from, to], method: "all" });
  const open = await openingOf(db, tz);
  const phones = await listeningPhones(db);
  /** Every phone that would have told the owner of it held it for quiet hours. */
  const quiet = (type: ItemType, t: number): boolean => {
    const kind = pushKindOf({ type }, true);
    const told = phones.filter((p) => p.kinds[kind]);
    return told.length > 0 && told.every((p) => deliverAt(p, t, tz) > t);
  };
  const date = dateLocaliser(tz);
  const days = new Map<
    string,
    {
      requests: number;
      answered: number;
      by: Record<Who, number>;
      inHours: number;
      within: number[];
      times: number[];
    }
  >();
  for (const r of rows) {
    const type = String(r[0]) as ItemType;
    const at = Number(r[1]);
    const day = date(at);
    if (!day.startsWith(`${opts.month}-`)) continue;
    let d = days.get(day);
    if (!d) {
      d = {
        requests: 0,
        answered: 0,
        by: { person: 0, rule: 0, other: 0 },
        inHours: 0,
        within: ANSWER_MINUTES.map(() => 0),
        times: [],
      };
      days.set(day, d);
    }
    d.requests++;
    const answer = first(answerOf(r[2]), answerOf(r[3]));
    if (answer) {
      d.answered++;
      d.by[answer.who]++;
    }
    if (!open(at) || quiet(type, at)) continue;
    d.inHours++;
    if (!answer) continue;
    const took = Math.max(0, answer.at - at);
    d.times.push(took);
    ANSWER_MINUTES.forEach((minutes, i) => {
      if (took <= minutes * 60_000) d.within[i] = (d.within[i] ?? 0) + 1;
    });
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, d]) => ({
      day,
      requests: d.requests,
      answered: d.answered,
      by_person: d.by.person,
      by_rule: d.by.rule,
      by_other: d.by.other,
      in_hours: d.inHours,
      within_5: d.within[0] ?? 0,
      within_15: d.within[1] ?? 0,
      within_60: d.within[2] ?? 0,
      median_s: median(d.times),
    }));
}
