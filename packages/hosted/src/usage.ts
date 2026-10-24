import { existsSync, statSync } from "node:fs";
import { type Db, PROMISE_STATES, type SpamUsage, spamUsage } from "@surfingdog/core";

/**
 * What an inbox did in a month, as counts: what it is counted by and what the control plane
 * watches. Test items are never counted.
 *
 * - `items`: requests made in the month: what customers and their AIs sent through the inbox's
 *   own doors (its API, MCP, the agent protocols, email, its form, the links in its emails). Never
 *   what the owner marked as spam, nor what the business made itself (in the app, through its
 *   own MCP, its connectors or the inbox's own jobs). A month is recounted every time it is
 *   asked, so a request marked as spam leaves the count with the next reading;
 * - `agent_items`: those that came through a door for agents (the API, MCP and the agent protocols);
 * - `confirmed_items`: bookings and orders that first reached a promise in the month (a booking
 *   confirmed, an order accepted);
 * - `mail_sent`: emails the ledger let go in the month;
 * - `db_bytes`: the inbox's file now, its write-ahead log included;
 * - `spam`: the spam filter's month (ADR-029 §15.3): each filter's days on (what a hosted inbox is
 *   charged by once billing is on: per inbox × filters switched on), its AI checks and their tokens
 *   (what it costs to run), and what it put aside, held, labelled, let in and brought back. A request
 *   held or put aside is not in `items` until a person or its sender lets it in.
 */
export interface Usage {
  readonly confirmed_items: number;
  readonly items: number;
  readonly agent_items: number;
  readonly mail_sent: number;
  readonly db_bytes: number;
  readonly spam: SpamUsage;
}

export const AGENT_CHANNELS = ["rest", "mcp_public", "a2a", "ucp", "acp", "arp"] as const;

/** The doors a request comes through from outside: the agents' doors and the people's. */
export const REQUEST_CHANNELS = [...AGENT_CHANNELS, "email", "form", "action_link"] as const;

/** A request as `items` counts it: real, sent through a customer's door, and not spam, held or being screened. */
const REQUEST = `COALESCE(sandbox, 0) = 0 AND state <> 'spam' AND COALESCE(screen, '') NOT IN ('pending', 'held', 'aside')
  AND channel IN (${REQUEST_CHANNELS.map(() => "?").join(", ")})`;

/** `YYYY-MM` as the first millisecond of the month and of the next, in UTC; null for anything else. */
export function monthRange(month: string): { from: number; to: number } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const index = Number(m[2]) - 1;
  return { from: Date.UTC(year, index, 1), to: Date.UTC(year, index + 1, 1) };
}

/**
 * What an inbox's database holds now: its pages in use, without the free ones a delete left (SQLite
 * keeps those in the file to reuse). The cap on writes is held to this, not to the file: files swept or
 * erased free their room at once, though the file on disk does not shrink.
 */
export async function liveBytes(db: Db): Promise<number> {
  const { rows } = await db.client.query({
    sql: "SELECT (c.page_count - f.freelist_count) * s.page_size FROM pragma_page_count() c, pragma_freelist_count() f, pragma_page_size() s",
    params: [],
    method: "all",
  });
  return Number(rows[0]?.[0] ?? 0);
}

export function fileBytes(path: string): number {
  let total = 0;
  for (const file of [path, `${path}-wal`]) {
    if (existsSync(file)) total += statSync(file).size;
  }
  return total;
}

const PROMISED = `((i.type = 'booking' AND e.to_state IN (${PROMISE_STATES.booking.map(() => "?").join(", ")}))
               OR (i.type = 'order' AND e.to_state IN (${PROMISE_STATES.order.map(() => "?").join(", ")})))`;
const PROMISED_PARAMS = [...PROMISE_STATES.booking, ...PROMISE_STATES.order];

export async function usageOf(
  db: Db,
  range: { from: number; to: number },
  now: number = Date.now(),
): Promise<Omit<Usage, "mail_sent" | "db_bytes">> {
  const one = async (sql: string, params: unknown[]): Promise<number> => {
    const { rows } = await db.client.query({ sql, params: params as never, method: "all" });
    return Number(rows[0]?.[0] ?? 0);
  };
  const items = await one(`SELECT count(*) FROM items WHERE ${REQUEST} AND created_at >= ? AND created_at < ?`, [
    ...REQUEST_CHANNELS,
    range.from,
    range.to,
  ]);
  const agentItems = await one(
    `SELECT count(*) FROM items WHERE ${REQUEST} AND created_at >= ? AND created_at < ?
       AND channel IN (${AGENT_CHANNELS.map(() => "?").join(", ")})`,
    [...REQUEST_CHANNELS, range.from, range.to, ...AGENT_CHANNELS],
  );
  const confirmed = await one(
    `SELECT count(*) FROM (
       SELECT e.item_id, MIN(e.created_at) AS first FROM item_events e JOIN items i ON i.id = e.item_id
        WHERE COALESCE(i.sandbox, 0) = 0 AND ${PROMISED}
        GROUP BY e.item_id
     ) WHERE first >= ? AND first < ?`,
    [...PROMISED_PARAMS, range.from, range.to],
  );
  return { confirmed_items: confirmed, items, agent_items: agentItems, spam: await spamUsage(db, range, now) };
}

/** Whether the inbox holds any real item that reached a promise, or any real item an agent made. */
export async function hasFirst(db: Db, what: "confirmed" | "agent"): Promise<boolean> {
  const sql =
    what === "confirmed"
      ? `SELECT 1 FROM item_events e JOIN items i ON i.id = e.item_id WHERE COALESCE(i.sandbox, 0) = 0 AND ${PROMISED} LIMIT 1`
      : `SELECT 1 FROM items WHERE COALESCE(sandbox, 0) = 0 AND channel IN (${AGENT_CHANNELS.map(() => "?").join(", ")}) LIMIT 1`;
  const params = what === "confirmed" ? PROMISED_PARAMS : [...AGENT_CHANNELS];
  const { rows } = await db.client.query({ sql, params: params as never, method: "all" });
  return rows.length > 0;
}
