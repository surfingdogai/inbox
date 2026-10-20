import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { randomToken } from "../ids";
import { type Interval, mergeIntervals } from "./sdk";

/**
 * Where calendars meet the database (0022, ADR-022): busy times, the bookings written out, and the
 * claims that keep two jobs from writing the same booking twice. D1 has no interactive transactions,
 * so every write here is one batch, a unique key, or a compare-and-set on a row.
 */

/**
 * How far ahead busy times are read: about three months, past the furthest most businesses take a
 * booking. Past what was read nothing is known, so nothing is offered there (`busyDetails`).
 */
export const BUSY_HORIZON_MS = 92 * 86_400_000;
/** A connector's busy times past this are not kept; the times after the last one kept stay closed. */
export const MAX_BUSY_ROWS = 2_000;

/** Busy times switched on for a connection: the owner's switch, absent meaning on. */
const BUSY_ON = "COALESCE(json_extract(config_public, '$.busyOn'), 1) = 1";

/**
 * Writes one generation of a connector's busy times and makes it current, unless a newer one is
 * current already, or the connection was paused or its busy times switched off while it read. Rows
 * go first, under their own generation, so nothing reads a half-written one. The last batch moves
 * `busy_gen` forward only (never back), deletes only the generations older than the current one (so
 * a newer sync still writing keeps its rows), and deletes this one's own rows if it did not become
 * current. Two syncs that run at once leave the newer one's times, whichever finishes last.
 *
 * `readUntil` is how far ahead the platform answered for (the window's end unless it said less);
 * with more rows than are kept, it is where the first one left out starts.
 */
export async function writeBusy(
  db: Db,
  connectorId: string,
  intervals: readonly Interval[],
  at: number,
  readUntil: number = at + BUSY_HORIZON_MS,
): Promise<{
  readonly gen: number;
  readonly rows: number;
  readonly current: boolean;
  readonly truncated: boolean;
  readonly until: number;
}> {
  const merged = mergeIntervals(intervals);
  const truncated = merged.length > MAX_BUSY_ROWS;
  const rows = merged.slice(0, MAX_BUSY_ROWS);
  const firstLeftOut = merged[MAX_BUSY_ROWS];
  const until = truncated && firstLeftOut ? Math.min(readUntil, firstLeftOut.start) : readUntil;
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
      sql: `UPDATE connectors SET busy_gen = ?, busy_at = ?, busy_until = ?
             WHERE id = ? AND (busy_gen IS NULL OR busy_gen < ?) AND status <> 'disabled' AND ${BUSY_ON}`,
      params: [gen, at, until, connectorId, gen],
      method: "run",
    },
    {
      sql: "DELETE FROM connector_busy WHERE connector_id = ? AND gen < COALESCE((SELECT busy_gen FROM connectors WHERE id = ?), 0)",
      params: [connectorId, connectorId],
      method: "run",
    },
    {
      sql: "DELETE FROM connector_busy WHERE connector_id = ? AND gen = ? AND gen IS NOT (SELECT busy_gen FROM connectors WHERE id = ?)",
      params: [connectorId, gen, connectorId],
      method: "run",
    },
  ]);
  const { rows: now } = await db.client.query({
    sql: "SELECT busy_gen FROM connectors WHERE id = ?",
    params: [connectorId],
    method: "all",
  });
  return { gen, rows: rows.length, current: Number(now[0]?.[0]) === gen, truncated, until };
}

/** Takes a connector's busy times away: switched off, paused, or disconnected. */
export function clearBusyStatements(connectorId: string): Statement[] {
  return [
    { sql: "DELETE FROM connector_busy WHERE connector_id = ?", params: [connectorId], method: "run" },
    {
      sql: "UPDATE connectors SET busy_gen = NULL, busy_at = NULL, busy_until = NULL WHERE id = ?",
      params: [connectorId],
      method: "run",
    },
  ];
}

/** A time a connected calendar takes off what is offered, and which connection says so. */
export interface BusyDetail extends Interval {
  readonly connectorId: string;
  /** The connection's name as the owner knows it ("iCloud", "Cal.com"). */
  readonly name: string;
  /** Past how far ahead the calendar was read: not known to be busy, but not known to be free. */
  readonly beyond: boolean;
}

/**
 * What connected calendars take off [from, to) for a resource: every connector's current generation,
 * and everything past how far ahead it was read, from connectors that are not paused and whose busy
 * times are on and apply to the service (all services unless the owner chose some). A resource that
 * is not a service is covered by connectors that apply to all. A calendar tied to one member of staff
 * (ADR-035) takes only their times off: it applies to their resource and to nothing else.
 */
export async function busyDetails(db: Db, from: number, to: number, resourceKey: string): Promise<BusyDetail[]> {
  const { rows } = await db.client.query({
    sql: `SELECT b.start_ms, b.end_ms, c.id, c.name, c.config_public, 0, c.resource_id FROM connector_busy b
            JOIN connectors c ON c.id = b.connector_id AND b.gen = c.busy_gen
           WHERE c.status <> 'disabled' AND ${BUSY_ON.replace("config_public", "c.config_public")}
             AND b.end_ms > ? AND b.start_ms < ?
          UNION ALL
          SELECT MAX(c.busy_until, ?), ?, c.id, c.name, c.config_public, 1, c.resource_id FROM connectors c
           WHERE c.kind <> 'feed' AND c.status <> 'disabled' AND c.busy_gen IS NOT NULL
             AND c.busy_until IS NOT NULL AND c.busy_until < ? AND ${BUSY_ON.replace("config_public", "c.config_public")}`,
    params: [from, to, from, to, to],
    method: "all",
  });
  if (rows.length === 0) return [];
  const serviceId = resourceKey.startsWith("service:") ? resourceKey.slice("service:".length) : null;
  const out: BusyDetail[] = [];
  const applies = new Map<string, boolean>();
  for (const [start, end, id, name, configPublic, beyond, resourceId] of rows) {
    const key = String(id);
    let ok = applies.get(key);
    if (ok === undefined) {
      const services = servicesOf(configPublic);
      ok =
        resourceId !== null && resourceId !== undefined
          ? resourceKey === `resource:${String(resourceId)}`
          : services === null || (serviceId !== null && services.includes(serviceId));
      applies.set(key, ok);
    }
    if (!ok) continue;
    out.push({
      start: Number(start),
      end: Number(end),
      connectorId: key,
      name: String(name ?? ""),
      beyond: Number(beyond) === 1,
    });
  }
  return out;
}

/** The times connected calendars take off [from, to) for a resource (`busyDetails`, as intervals). */
export async function busyOverlapping(db: Db, from: number, to: number, resourceKey: string): Promise<Interval[]> {
  return (await busyDetails(db, from, to, resourceKey)).map((b) => ({ start: b.start, end: b.end }));
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
  readonly claimedBy: string | null;
  readonly attempts: number;
  readonly retryAt: number | null;
  readonly lastError: string | null;
}

const LINK_COLUMNS =
  "connector_id, item_id, external_id, etag, calendar, synced_hash, synced_start, synced_end, state, claim_until, claimed_by, attempts, retry_at, last_error";

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
    claimedBy: s(r[10]),
    attempts: Number(r[11] ?? 0),
    retryAt: n(r[12]),
    lastError: s(r[13]),
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

/**
 * The bookings on the platforms now: one connector's, or every connector's. Busy times leave out all
 * of them, whichever connection wrote them: Cal.com writes its bookings into a calendar that may be
 * connected here too, and two calendars may show each other's events.
 */
export async function liveLinks(db: Db, connectorId?: string): Promise<LinkRow[]> {
  const { rows } = await db.client.query({
    sql: `SELECT ${LINK_COLUMNS} FROM connector_links WHERE state <> 'removed' AND external_id IS NOT NULL${connectorId === undefined ? "" : " AND connector_id = ?"}`,
    params: connectorId === undefined ? [] : [connectorId],
    method: "all",
  });
  return rows.map(linkOf);
}

/**
 * Links whose last write failed and whose retry is due, and links a run claimed and never let go (it
 * stopped half way): both are written by the next run.
 */
export async function dueRetries(db: Db, connectorId: string, now: number, limit: number): Promise<string[]> {
  const { rows } = await db.client.query({
    sql: `SELECT item_id FROM connector_links
           WHERE connector_id = ? AND state <> 'removed'
             AND ((last_error IS NOT NULL AND (retry_at IS NULL OR retry_at <= ?))
                  OR (claim_until IS NOT NULL AND claim_until < ?))
           ORDER BY retry_at LIMIT ?`,
    params: [connectorId, now, now, limit],
    method: "all",
  });
  return rows.map((r) => String(r[0]));
}

/**
 * How long one job holds a booking while it calls the platform: past the slowest run of calls one
 * booking takes (Google: a token, a removal, an update, a creation and an update again, 15 s each;
 * CalDAV: a removal and three writes, 20 s each).
 */
export const LINK_CLAIM_MS = 120_000;

/** A booking taken by one job: its link as it was, whether it was just made, and the claim's token. */
export interface LinkClaim {
  readonly link: LinkRow;
  readonly fresh: boolean;
  readonly token: string;
}

/**
 * Takes the booking for this job: inserts its link if there is none (`fresh`), or takes a link nobody
 * holds. Null when another job holds it now, which then writes it; this one leaves it alone.
 */
export async function claimLink(db: Db, connectorId: string, itemId: string, now: number): Promise<LinkClaim | null> {
  const until = now + LINK_CLAIM_MS;
  const token = randomToken(12);
  const inserted = await db.client.query({
    sql: `INSERT OR IGNORE INTO connector_links (connector_id, item_id, state, claim_until, claimed_by, attempts, created_at, updated_at)
          VALUES (?, ?, 'pending', ?, ?, 0, ?, ?)`,
    params: [connectorId, itemId, until, token, now, now],
    method: "run",
  });
  if (inserted.changes !== 1) {
    const taken = await db.client.query({
      sql: `UPDATE connector_links SET claim_until = ?, claimed_by = ?, updated_at = ?
             WHERE connector_id = ? AND item_id = ? AND (claim_until IS NULL OR claim_until < ?)`,
      params: [until, token, now, connectorId, itemId, now],
      method: "run",
    });
    if (taken.changes !== 1) return null;
  }
  const link = await readLink(db, connectorId, itemId);
  return link && link.claimedBy === token ? { link, fresh: inserted.changes === 1, token } : null;
}

/**
 * What a write did, recorded as the claim is let go: only by the job that still holds it. False when
 * the claim ran out and another job took the booking; that job's record stands.
 */
export async function settleLink(
  db: Db,
  claim: { readonly link: { readonly connectorId: string; readonly itemId: string }; readonly token: string },
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
): Promise<boolean> {
  const where = "WHERE connector_id = ? AND item_id = ? AND claimed_by = ?";
  const keys = [claim.link.connectorId, claim.link.itemId, claim.token];
  if (outcome.kind === "synced") {
    const r = await db.client.query({
      sql: `UPDATE connector_links SET external_id = ?, etag = ?, calendar = ?, synced_hash = ?, synced_start = ?, synced_end = ?,
                   state = 'synced', claim_until = NULL, claimed_by = NULL, attempts = 0, retry_at = NULL, last_error = NULL,
                   last_error_at = NULL, updated_at = ? ${where}`,
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
    return r.changes === 1;
  }
  if (outcome.kind === "removed") {
    const r = await db.client.query({
      sql: `UPDATE connector_links SET state = 'removed', claim_until = NULL, claimed_by = NULL, retry_at = NULL, last_error = NULL,
                   last_error_at = NULL, updated_at = ? ${where}`,
      params: [now, ...keys],
      method: "run",
    });
    return r.changes === 1;
  }
  const r = await db.client.query({
    sql: `UPDATE connector_links SET claim_until = NULL, claimed_by = NULL, attempts = attempts + 1, retry_at = ?, last_error = ?,
                 last_error_at = ?, updated_at = ? ${where}`,
    params: [outcome.retryAt, outcome.error.slice(0, 500), now, now, ...keys],
    method: "run",
  });
  return r.changes === 1;
}

/** When a failed write is tried again: a minute, then longer, never more than six hours apart. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts), 6 * 3_600_000);
}

/* --- this inbox ------------------------------------------------------------ */

/**
 * This inbox's own id, made once at random: the calendar entries it writes carry it (an event's UID,
 * a mark in its properties), so it knows its own wherever its address moves, and two inboxes writing
 * into one calendar never take each other's entries for their own.
 */
export async function instanceId(db: Db, now: number): Promise<string> {
  const read = async () => {
    const { rows } = await db.client.query({
      sql: "SELECT value FROM instance_meta WHERE key = 'instance_id'",
      method: "all",
    });
    const v = rows[0]?.[0];
    return typeof v === "string" && v ? v : null;
  };
  const found = await read();
  if (found) return found;
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db.client.query({
    sql: "INSERT OR IGNORE INTO instance_meta (key, value, created_at) VALUES ('instance_id', ?, ?)",
    params: [id, now],
    method: "run",
  });
  return (await read()) ?? id;
}
