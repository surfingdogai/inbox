import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { type Interval, mergeIntervals } from "./sdk";

/**
 * Where calendars meet the database (0022, ADR-020): busy times, the bookings written out, and the
 * claims that keep two jobs from writing the same booking twice. D1 has no interactive transactions,
 * so every write here is one batch, a unique key, or a compare-and-set on a row.
 */

/** How far ahead busy times are read: past the furthest anyone books a hairdresser, short enough to read in one go. */
export const BUSY_HORIZON_MS = 62 * 86_400_000;
/** A connector's busy times past this are not kept; the calendar has more than a business has times. */
export const MAX_BUSY_ROWS = 2_000;

/**
 * Writes one generation of a connector's busy times and makes it current, unless a newer one is
 * current already. Rows go first, under their own generation, so nothing reads a half-written one;
 * the last batch moves `busy_gen` forward only (never back) and deletes every other generation. Two
 * syncs that run at once leave the newer one's times, whichever finishes last.
 */
export async function writeBusy(
  db: Db,
  connectorId: string,
  intervals: readonly Interval[],
  at: number,
): Promise<{ readonly gen: number; readonly rows: number; readonly current: boolean; readonly truncated: boolean }> {
  const merged = mergeIntervals(intervals);
  const truncated = merged.length > MAX_BUSY_ROWS;
  const rows = merged.slice(0, MAX_BUSY_ROWS);
  // Milliseconds with ten random bits under them: two syncs in the same millisecond still differ.
  const gen = at * 1024 + Math.floor(Math.random() * 1024);
  const inserts: Statement[] = [];
  for (let i = 0; i < rows.length; i += 20) {
    const chunk = rows.slice(i, i + 20);
    inserts.push({
      sql: `INSERT OR IGNORE INTO connector_busy (connector_id, gen, start_ms, end_ms) VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")}`,
      params: chunk.flatMap((r) => [connectorId, gen, r.start, r.end]),
      method: "run",
    });
  }
  for (let i = 0; i < inserts.length; i += 40) await db.batch(inserts.slice(i, i + 40));
  await db.batch([
    {
      sql: "UPDATE connectors SET busy_gen = ?, busy_at = ? WHERE id = ? AND (busy_gen IS NULL OR busy_gen < ?)",
      params: [gen, at, connectorId, gen],
      method: "run",
    },
    {
      sql: "DELETE FROM connector_busy WHERE connector_id = ? AND gen <> COALESCE((SELECT busy_gen FROM connectors WHERE id = ?), -1)",
      params: [connectorId, connectorId],
      method: "run",
    },
  ]);
  const { rows: now } = await db.client.query({
    sql: "SELECT busy_gen FROM connectors WHERE id = ?",
    params: [connectorId],
    method: "all",
  });
  return { gen, rows: rows.length, current: Number(now[0]?.[0]) === gen, truncated };
}

/** Takes a connector's busy times away: switched off, or disconnected. */
export function clearBusyStatements(connectorId: string): Statement[] {
  return [
    { sql: "DELETE FROM connector_busy WHERE connector_id = ?", params: [connectorId], method: "run" },
    { sql: "UPDATE connectors SET busy_gen = NULL, busy_at = NULL WHERE id = ?", params: [connectorId], method: "run" },
  ];
}

/**
 * The busy times that touch [from, to) for a resource: every connector's current generation, from
 * connectors that are not switched off, whose busy times apply to the service (all services unless
 * the owner chose some). A resource that is not a service is covered by connectors that apply to all.
 */
export async function busyOverlapping(db: Db, from: number, to: number, resourceKey: string): Promise<Interval[]> {
  const { rows } = await db.client.query({
    sql: `SELECT b.start_ms, b.end_ms, c.config_public FROM connector_busy b
            JOIN connectors c ON c.id = b.connector_id AND b.gen = c.busy_gen
           WHERE c.status <> 'disabled' AND b.end_ms > ? AND b.start_ms < ?`,
    params: [from, to],
    method: "all",
  });
  if (rows.length === 0) return [];
  const serviceId = resourceKey.startsWith("service:") ? resourceKey.slice("service:".length) : null;
  const out: Interval[] = [];
  const applies = new Map<string, boolean>();
  for (const [start, end, configPublic] of rows) {
    const key = String(configPublic ?? "");
    let ok = applies.get(key);
    if (ok === undefined) {
      const services = servicesOf(configPublic);
      ok = services === null || (serviceId !== null && services.includes(serviceId));
      applies.set(key, ok);
    }
    if (ok) out.push({ start: Number(start), end: Number(end) });
  }
  return out;
}

function servicesOf(configPublic: unknown): string[] | null {
  let doc: unknown = configPublic;
  if (typeof doc === "string") {
    try {
      doc = JSON.parse(doc);
    } catch {
      return null;
    }
  }
  const services = (doc as { services?: unknown } | null)?.services;
  return Array.isArray(services) ? services.map(String) : null;
}

/* --- links: the bookings written out ------------------------------------- */

export interface LinkRow {
  readonly connectorId: string;
  readonly itemId: string;
  readonly externalId: string | null;
  readonly etag: string | null;
  readonly calendar: string | null;
  readonly syncedHash: string | null;
  readonly syncedStart: number | null;
  readonly syncedEnd: number | null;
  readonly state: string;
  readonly claimUntil: number | null;
  readonly attempts: number;
  readonly retryAt: number | null;
  readonly lastError: string | null;
}

const LINK_COLUMNS =
  "connector_id, item_id, external_id, etag, calendar, synced_hash, synced_start, synced_end, state, claim_until, attempts, retry_at, last_error";

function linkOf(r: readonly unknown[]): LinkRow {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    connectorId: String(r[0]),
    itemId: String(r[1]),
    externalId: s(r[2]),
    etag: s(r[3]),
    calendar: s(r[4]),
    syncedHash: s(r[5]),
    syncedStart: n(r[6]),
    syncedEnd: n(r[7]),
    state: String(r[8]),
    claimUntil: n(r[9]),
    attempts: Number(r[10] ?? 0),
    retryAt: n(r[11]),
    lastError: s(r[12]),
  };
}

export async function readLink(db: Db, connectorId: string, itemId: string): Promise<LinkRow | null> {
  const { rows } = await db.client.query({
    sql: `SELECT ${LINK_COLUMNS} FROM connector_links WHERE connector_id = ? AND item_id = ?`,
    params: [connectorId, itemId],
    method: "all",
  });
  return rows[0] ? linkOf(rows[0]) : null;
}

/** Every booking this connector has on the platform now: what busy times must leave out. */
export async function liveLinks(db: Db, connectorId: string): Promise<LinkRow[]> {
  const { rows } = await db.client.query({
    sql: `SELECT ${LINK_COLUMNS} FROM connector_links WHERE connector_id = ? AND state <> 'removed' AND external_id IS NOT NULL`,
    params: [connectorId],
    method: "all",
  });
  return rows.map(linkOf);
}

/** Links whose last write failed and whose retry is due. */
export async function dueRetries(db: Db, connectorId: string, now: number, limit: number): Promise<string[]> {
  const { rows } = await db.client.query({
    sql: `SELECT item_id FROM connector_links
           WHERE connector_id = ? AND state <> 'removed' AND last_error IS NOT NULL AND (retry_at IS NULL OR retry_at <= ?)
           ORDER BY retry_at LIMIT ?`,
    params: [connectorId, now, limit],
    method: "all",
  });
  return rows.map((r) => String(r[0]));
}

/** How long one job holds a booking while it calls the platform: past the slowest call, under a lease. */
export const LINK_CLAIM_MS = 45_000;

/**
 * Takes the booking for this job: inserts its link if there is none (`fresh`), or takes a link nobody
 * holds. Null when another job holds it now, which then writes it; this one leaves it alone.
 */
export async function claimLink(
  db: Db,
  connectorId: string,
  itemId: string,
  now: number,
): Promise<{ readonly link: LinkRow; readonly fresh: boolean } | null> {
  const until = now + LINK_CLAIM_MS;
  const inserted = await db.client.query({
    sql: `INSERT OR IGNORE INTO connector_links (connector_id, item_id, state, claim_until, attempts, created_at, updated_at)
          VALUES (?, ?, 'pending', ?, 0, ?, ?)`,
    params: [connectorId, itemId, until, now, now],
    method: "run",
  });
  if (inserted.changes !== 1) {
    const taken = await db.client.query({
      sql: `UPDATE connector_links SET claim_until = ?, updated_at = ?
             WHERE connector_id = ? AND item_id = ? AND (claim_until IS NULL OR claim_until < ?)`,
      params: [until, now, connectorId, itemId, now],
      method: "run",
    });
    if (taken.changes !== 1) return null;
  }
  const link = await readLink(db, connectorId, itemId);
  return link ? { link, fresh: inserted.changes === 1 } : null;
}

/** What a write did, recorded as the claim is let go. */
export async function settleLink(
  db: Db,
  link: { readonly connectorId: string; readonly itemId: string },
  outcome:
    | {
        readonly kind: "synced";
        readonly externalId: string | null;
        readonly etag: string | null;
        readonly calendar: string | null;
        readonly hash: string;
        readonly start: number;
        readonly end: number;
      }
    | { readonly kind: "removed" }
    | { readonly kind: "failed"; readonly error: string; readonly retryAt: number },
  now: number,
): Promise<void> {
  const where = "WHERE connector_id = ? AND item_id = ?";
  const keys = [link.connectorId, link.itemId];
  if (outcome.kind === "synced") {
    await db.client.query({
      sql: `UPDATE connector_links SET external_id = ?, etag = ?, calendar = ?, synced_hash = ?, synced_start = ?, synced_end = ?,
                   state = 'synced', claim_until = NULL, attempts = 0, retry_at = NULL, last_error = NULL, last_error_at = NULL,
                   updated_at = ? ${where}`,
      params: [
        outcome.externalId,
        outcome.etag,
        outcome.calendar,
        outcome.hash,
        outcome.start,
        outcome.end,
        now,
        ...keys,
      ],
      method: "run",
    });
    return;
  }
  if (outcome.kind === "removed") {
    await db.client.query({
      sql: `UPDATE connector_links SET state = 'removed', claim_until = NULL, retry_at = NULL, last_error = NULL,
                   last_error_at = NULL, updated_at = ? ${where}`,
      params: [now, ...keys],
      method: "run",
    });
    return;
  }
  await db.client.query({
    sql: `UPDATE connector_links SET claim_until = NULL, attempts = attempts + 1, retry_at = ?, last_error = ?, last_error_at = ?,
                 updated_at = ? ${where}`,
    params: [outcome.retryAt, outcome.error.slice(0, 500), now, now, ...keys],
    method: "run",
  });
}

/** When a failed write is tried again: a minute, then longer, never more than six hours apart. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts), 6 * 3_600_000);
}
