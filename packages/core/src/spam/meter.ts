import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { filterDays } from "./filters";
import { dayOf, type Filter } from "./types";

/**
 * What the spam filter did, counted by UTC day (ADR-029 §15): AI checks made, reused, refused by a cap,
 * failed, their tokens; what was put aside, held, labelled, let in and brought back. Counts only, never
 * content or addresses, and never purged with items: a hosted inbox is charged per filter-day once
 * billing is on, and its AI checks are what it costs to run.
 */

export type MeterKey =
  | "judged"
  | "reused"
  | "capped"
  | "failed"
  | "tokens_in"
  | "tokens_out"
  | "aside"
  | "held"
  | "warned"
  | "released"
  | "brought_back"
  | "marked"
  | "trap_over_cap";

export function countStatement(key: MeterKey, now: number, n = 1): Statement {
  return {
    sql: `INSERT INTO spam_days (day, key, n) VALUES (?, ?, ?)
          ON CONFLICT (day, key) DO UPDATE SET n = spam_days.n + excluded.n`,
    params: [dayOf(now), key, n],
    method: "run",
  };
}

/** One counter over a range of days, both ends included. */
export async function counted(db: Db, key: MeterKey, fromDay: string, toDay: string): Promise<number> {
  const { rows } = await db.client.query({
    sql: "SELECT COALESCE(SUM(n), 0) FROM spam_days WHERE key = ? AND day >= ? AND day <= ?",
    params: [key, fromDay, toDay],
    method: "all",
  });
  return Number(rows[0]?.[0] ?? 0);
}

/** AI checks made today and this month (UTC), what the caps are kept by. */
export async function checksSoFar(db: Db, now: number): Promise<{ readonly day: number; readonly month: number }> {
  const day = dayOf(now);
  const month = `${day.slice(0, 7)}-01`;
  return { day: await counted(db, "judged", day, day), month: await counted(db, "judged", month, day) };
}

/** The spam filter's part of a month's usage (`Usage.spam` on a hosted inbox). */
export interface SpamUsage {
  readonly filter_days: Readonly<Record<Filter, number>>;
  readonly judged: number;
  readonly reused: number;
  readonly capped: number;
  readonly failed: number;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly aside: number;
  readonly held: number;
  readonly warned: number;
  /** Let in by a person, or confirmed by the sender. */
  readonly released: number;
  /** Not spam on something put aside: the filter's own count of its mistakes. */
  readonly brought_back: number;
}

export async function spamUsage(
  db: Db,
  range: { readonly from: number; readonly to: number },
  now: number,
): Promise<SpamUsage> {
  const from = dayOf(range.from);
  const to = dayOf(range.to - 1);
  const { rows } = await db.client.query({
    sql: "SELECT key, COALESCE(SUM(n), 0) FROM spam_days WHERE day >= ? AND day <= ? GROUP BY key",
    params: [from, to],
    method: "all",
  });
  const n = new Map(rows.map((r) => [String(r[0]), Number(r[1] ?? 0)]));
  const get = (k: MeterKey) => n.get(k) ?? 0;
  return {
    filter_days: await filterDays(db, range, now),
    judged: get("judged"),
    reused: get("reused"),
    capped: get("capped"),
    failed: get("failed"),
    tokens_in: get("tokens_in"),
    tokens_out: get("tokens_out"),
    aside: get("aside"),
    held: get("held"),
    warned: get("warned"),
    released: get("released"),
    brought_back: get("brought_back"),
  };
}

/**
 * What a month would cost once billing is on (ADR-029 §15.3, the founder's decision: per inbox ×
 * filters switched on): each filter's days, at most thirty, at a day's price — the month's price
 * divided by thirty, rounded up to a cent — and never more than the month's price.
 */
export function monthCharge(days: Readonly<Record<Filter, number>>, perFilterMonthMinor: number): number {
  const dayPrice = Math.ceil(perFilterMonthMinor / 30);
  let total = 0;
  for (const d of Object.values(days)) total += Math.min(Math.min(d, 30) * dayPrice, perFilterMonthMinor);
  return total;
}
