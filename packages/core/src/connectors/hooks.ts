import { sha256Hex } from "@surfingdog/platform";
import type { Db } from "../db";
import { randomToken, ulid } from "../ids";
import type { JobHandler } from "../jobs/runner";
import { staleStatement } from "../property/ari";
import { ensureAriSync } from "../property/sync";
import { jobStatement } from "../write/common";
import type { PayConnection, PaymentLinks } from "./payments";
import {
  type ConnectorDefinition,
  ConnectorError,
  type FeedBooking,
  type HookEvent,
  type HookFact,
  type InboundRequest,
  type Interval,
  type RunContext,
} from "./sdk";

/**
 * What platforms send a connection at its own address (ADR-026 §4), and the links a connection serves
 * (§5). The rules that shape it:
 *
 * - **One connection per address.** `POST /v1/hooks/<kind>/<token>` names one connection by the hash of
 *   its token, so a request never fans out over every connection of a kind to find whose signature
 *   checks out, and the database never holds what opens the address.
 * - **The signature first, over the exact bytes**, in constant time (`hook-sign.ts`): a request that
 *   does not check out is answered 400 and writes nothing.
 * - **Ids, never bodies.** What is kept of an event is its id, its topic and the ids it names: a
 *   platform's body carries a customer's details, and a body is never believed anyway.
 * - **Answered at once, read back after.** The platform hears 200 within its timeout (Shopify gives
 *   five seconds); a job then reads what the event names with the business's own key and applies it.
 *   A delivery sent twice is applied once.
 * - **Polling is the source of truth.** A webhook is a nudge: a connection that hears none still finds
 *   everything on its next sync.
 */

/** The job that reads back what a platform's webhook named, and applies it. */
export const CONNECTOR_HOOK_KIND = "connector_hook";

/** A webhook body larger than this is refused unread: platforms send ids and a few fields. */
export const MAX_HOOK_BYTES = 1024 * 1024;

/** A connection's address segment: 32 random bytes, base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** An id an event may name: what platforms use (numbers, `gid://shopify/Order/1`, `ord_…`), and nothing else. */
const REF = /^[A-Za-z0-9_:./@#=+-]{1,200}$/;

/** A new address segment for a connection: 32 random bytes. */
export function newInboundToken(): string {
  return randomToken(32);
}

/** Whether a path segment can be a connection's address at all, before anything is looked up. */
export function isInboundToken(token: string): boolean {
  return TOKEN.test(token);
}

/** What the database keeps of an address segment: its SHA-256, never the segment. */
export function inboundHash(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}

/** What the hooks side asks of the connections it works for. */
export interface HookHost {
  readonly db: Db;
  readonly payments: PaymentLinks;
  definition(kind: string): ConnectorDefinition | undefined;
  /** The connection an address names, by its token's hash and kind. */
  connectionByToken(kind: string, tokenHash: string): Promise<{ readonly id: string; readonly kind: string } | null>;
  /** One connection, opened; null when it is gone or its secrets do not open here. */
  context(connectorId: string, now: number): Promise<RunContext | null>;
  payConnection(connectorId: string, now: number): Promise<PayConnection | null>;
  /** A connection failed in a way the owner must fix: said on its tile, and told once. */
  failed(connectorId: string, error: ConnectorError, now: number): Promise<void>;
  /** Read the connection again now (busy times, the catalogue): a sync, once per key. */
  syncNow(connectorId: string, now: number, key: string): Promise<void>;
}

export interface HookAnswer {
  readonly status: 200 | 400 | 404 | 413 | 503;
  readonly body: Record<string, unknown>;
}

export class ConnectorHooks {
  constructor(private readonly host: HookHost) {}

  /**
   * A request a platform sent to a connection's own address. Answers at once: 200 once it is kept (or
   * was kept before, `duplicate`, or is a ping), 400 when the signature does not check out, 404 for an
   * address that names no connection, 503 when the connection cannot be opened here.
   */
  async receive(kind: string, token: string, request: InboundRequest, now: number): Promise<HookAnswer> {
    if (!isInboundToken(token)) return NOT_FOUND;
    if (request.body.length > MAX_HOOK_BYTES) {
      return { status: 413, body: { error: "too_large", detail: "This address takes requests up to 1 MB." } };
    }
    const conn = await this.host.connectionByToken(kind, await inboundHash(token));
    const def = conn ? this.host.definition(conn.kind) : undefined;
    if (!conn || !def?.hooks) return NOT_FOUND;
    const ctx = await this.host.context(conn.id, now);
    if (!ctx)
      return { status: 503, body: { error: "unavailable", detail: "This connection cannot be read here now." } };
    let event: HookEvent | null;
    try {
      event = await def.hooks.verify(ctx, request);
    } catch (error) {
      if (error instanceof ConnectorError) {
        return { status: 400, body: { error: "bad_signature", detail: "The signature does not check out." } };
      }
      throw error;
    }
    if (!event) return { status: 200, body: { ok: true, ping: true } };
    const eventId = event.eventId.slice(0, 200);
    if (!eventId) return { status: 400, body: { error: "invalid_input", detail: "The request names no delivery." } };
    const kept = keptOf(event);
    const results = await this.host.db.batch([
      {
        sql: `INSERT OR IGNORE INTO connector_events (id, connector_id, external_id, topic, received_at, status, raw)
              VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        params: [ulid(now), conn.id, eventId, kept.topic, now, JSON.stringify(kept)],
        method: "run",
      },
      // Once per delivery, ever: a job already run for it is not run again.
      jobStatement(CONNECTOR_HOOK_KIND, { connectorId: conn.id, eventId }, now, {
        dedupeKey: `chook:${conn.id}:${eventId}`,
      }),
    ]);
    const duplicate = (results[0]?.changes ?? 0) === 0;
    return { status: 200, body: { ok: true, duplicate } };
  }

  /**
   * The job: what one kept event names, read back from the platform with the business's own key, and
   * applied. A platform that does not answer is asked again (the job is retried); a key it no longer
   * takes is said on the connection, once. Answers what it did, for the job's note.
   */
  async read(connectorId: string, eventId: string, now: number): Promise<string> {
    const { rows } = await this.host.db.client.query({
      sql: "SELECT raw, status FROM connector_events WHERE connector_id = ? AND external_id = ?",
      params: [connectorId, eventId],
      method: "all",
    });
    const row = rows[0];
    if (!row) return "gone: the connection was disconnected";
    if (String(row[1]) === "handled" || String(row[1]) === "ignored") return `already ${String(row[1])}`;
    const event = eventOf(eventId, row[0]);
    const ctx = await this.host.context(connectorId, now);
    const conn = ctx ? await this.connectionKind(connectorId) : null;
    const def = conn ? this.host.definition(conn) : undefined;
    if (!ctx || !def?.hooks) return this.settle(connectorId, eventId, "ignored", null, now, "not readable here");
    let facts: readonly HookFact[];
    try {
      facts = await def.hooks.read(ctx, event);
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      if (error.code === "auth" || error.code === "config") {
        await this.host.failed(connectorId, error, now);
        return this.settle(connectorId, eventId, "failed", null, now, error.message);
      }
      if (error.code === "not_found") return this.settle(connectorId, eventId, "ignored", null, now, error.message);
      // Not answering, or asked to wait: the job is tried again later.
      await this.settle(connectorId, eventId, "pending", null, now, error.message);
      throw error;
    }
    let handled = 0;
    let itemId: string | null = null;
    const pay = facts.some((f) => f.kind === "payment" || f.kind === "order")
      ? await this.host.payConnection(connectorId, now)
      : null;
    for (const f of facts) {
      switch (f.kind) {
        case "payment": {
          if (!pay) break;
          const applied = await this.host.payments.apply(pay, f.fact, now);
          if (applied.itemId) itemId = applied.itemId;
          if (applied.done) handled++;
          break;
        }
        case "order": {
          if (!pay) break;
          const applied = await this.host.payments.applyOrder(pay, f.fact, now);
          if (applied.itemId) itemId = applied.itemId;
          if (applied.done) handled++;
          break;
        }
        case "catalogue":
        case "busy":
          await this.host.syncNow(connectorId, now, `hook:${eventId}`);
          handled++;
          break;
        case "stay_nights": {
          // Never believed: the nights are marked to read again, and the property's poll reads them now.
          const rooms = f.roomIds?.length ? f.roomIds : [undefined];
          await this.host.db.batch(rooms.map((r) => staleStatement(connectorId, f.from, f.to, r)));
          const { rows } = await this.host.db.client.query({
            sql: "SELECT id FROM properties WHERE connector_id = ? AND active = 1",
            params: [connectorId],
            method: "all",
          });
          for (const r of rows) await ensureAriSync(this.host.db, String(r[0]), now);
          handled++;
          break;
        }
        case "revoked":
          await this.host.failed(
            connectorId,
            new ConnectorError("auth", `${def.title} says this inbox's access was withdrawn. Connect it again.`),
            now,
          );
          handled++;
          break;
      }
    }
    return this.settle(connectorId, eventId, handled > 0 ? "handled" : "ignored", itemId, now, null);
  }

  private async connectionKind(connectorId: string): Promise<string | null> {
    const { rows } = await this.host.db.client.query({
      sql: "SELECT kind FROM connectors WHERE id = ?",
      params: [connectorId],
      method: "all",
    });
    return rows[0] ? String(rows[0][0]) : null;
  }

  private async settle(
    connectorId: string,
    eventId: string,
    status: "handled" | "ignored" | "failed" | "pending",
    itemId: string | null,
    now: number,
    error: string | null,
  ): Promise<string> {
    await this.host.db.client.query({
      sql: `UPDATE connector_events SET status = ?, item_id = COALESCE(?, item_id), handled_at = ?, error = ?
             WHERE connector_id = ? AND external_id = ?`,
      params: [status, itemId, status === "pending" ? null : now, error?.slice(0, 500) ?? null, connectorId, eventId],
      method: "run",
    });
    return `${status}${error ? `: ${error}` : ""}`;
  }
}

/** The job that reads a kept webhook back, once per delivery, in its connection's lane. */
export function connectorHookHandler(hooks: ConnectorHooks): JobHandler {
  return async (job, { now }) => {
    const p = job.payload as { connectorId?: unknown; eventId?: unknown } | null;
    if (typeof p?.connectorId !== "string" || typeof p.eventId !== "string") return { note: "no event named" };
    return { note: `event ${p.eventId}: ${await hooks.read(p.connectorId, p.eventId, now)}` };
  };
}

/** What is kept of an event: its topic and the ids it names, never what the body said of them. */
function keptOf(event: HookEvent): { readonly topic: string; readonly refs: readonly string[] } {
  return {
    topic: event.topic.slice(0, 100),
    refs: [...new Set(event.refs.filter((r) => typeof r === "string" && REF.test(r)))].slice(0, 50),
  };
}

function eventOf(eventId: string, raw: unknown): HookEvent {
  let parsed: { topic?: unknown; refs?: unknown } = {};
  try {
    parsed = typeof raw === "string" ? (JSON.parse(raw) as typeof parsed) : {};
  } catch {
    parsed = {};
  }
  const refs = Array.isArray(parsed.refs) ? parsed.refs.filter((r): r is string => typeof r === "string") : [];
  return { eventId, topic: typeof parsed.topic === "string" ? parsed.topic : "", refs };
}

const NOT_FOUND: HookAnswer = { status: 404, body: { error: "not_found" } };

/* --- links a connection serves (ADR-026 §5) -------------------------------------------------- */

/**
 * Confirmed bookings overlapping a window, as a link may show them: times and the service's name,
 * never who booked or how to reach them, and never a test booking. `sequence` is the item's version,
 * which goes up whenever the booking changes.
 */
export async function feedBookings(db: Db, window: Interval): Promise<FeedBooking[]> {
  const { rows } = await db.client.query({
    sql: `SELECT i.id, json_extract(i.payload, '$.startTime'), json_extract(i.payload, '$.endTime'),
                 COALESCE(s.name, json_extract(i.payload, '$.reservationFor.name')), i.version, i.updated_at
            FROM items i LEFT JOIN services s ON s.id = json_extract(i.payload, '$.reservationFor.serviceId')
           WHERE i.type = 'booking' AND i.state = 'confirmed' AND COALESCE(i.sandbox, 0) = 0
             AND i.end_at > ? AND unixepoch(i.start_at) < ?
           ORDER BY i.end_at, i.id LIMIT 5000`,
    params: [Math.floor(window.start / 1000), Math.ceil(window.end / 1000)],
    method: "all",
  });
  const out: FeedBooking[] = [];
  for (const r of rows) {
    const start = Date.parse(String(r[1] ?? ""));
    const end = Date.parse(String(r[2] ?? ""));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (end <= window.start || start >= window.end) continue;
    out.push({
      itemId: String(r[0]),
      start,
      end,
      serviceName:
        String(r[3] ?? "")
          .trim()
          .slice(0, 120) || "Booked",
      sequence: Number(r[4] ?? 1),
      updatedAt: Number(r[5] ?? 0),
    });
  }
  return out;
}
