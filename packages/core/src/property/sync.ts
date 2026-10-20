import type { ConnectorCapabilities } from "../connectors/capability";
import {
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttp,
  isPropertySystem,
  type RunContext,
} from "../connectors/sdk";
import type { Db } from "../db";
import type { JobHandler } from "../jobs/runner";
import { ensureJob } from "../jobs/schedule";
import { listProperties, type PropertySetup, readSetup } from "../stays/store";
import { addDays, dateIn } from "../util/zoned";
import { ariStatements } from "./ari";

/**
 * The stays cache kept fresh (ADR-033 §4.5): the next 60 nights every 15 minutes and the next 365
 * every 6 hours, for each property whose own system is connected. A system that counts credits (Beds24
 * shares 100 per 5 minutes) is never polled below a reserve of 30, so a hold or a booking always has
 * credits left; a call it refuses for its limits waits until the system says.
 */

export const STAY_ARI_SYNC_KIND = "stay_ari_sync";
export const ARI_SHORT_MS = 15 * 60_000;
export const ARI_LONG_MS = 6 * 3_600_000;
/** Credits a poll leaves for holds and bookings. */
export const CREDIT_RESERVE = 30;

export interface Budget {
  readonly remaining: number;
  readonly resetsAt: number;
}

async function budgetOf(db: Db, connectorId: string): Promise<Budget | null> {
  const { rows } = await db.client.query({
    sql: "SELECT json_extract(config_public, '$.credits') FROM connectors WHERE id = ?",
    params: [connectorId],
    method: "all",
  });
  const raw = rows[0]?.[0];
  if (typeof raw !== "string") return null;
  try {
    const b = JSON.parse(raw) as Budget;
    return typeof b.remaining === "number" && typeof b.resetsAt === "number" ? b : null;
  } catch {
    return null;
  }
}

async function saveBudget(db: Db, connectorId: string, b: Budget): Promise<void> {
  await db.client.query({
    sql: "UPDATE connectors SET config_public = json_set(config_public, '$.credits', json(?)) WHERE id = ?",
    params: [JSON.stringify(b), connectorId],
    method: "run",
  });
}

/** Whether a poll may spend credits now: a reserve stays for holds and bookings. */
export async function mayPoll(db: Db, connectorId: string, now: number): Promise<boolean> {
  const b = await budgetOf(db, connectorId);
  return !b || b.resetsAt <= now || b.remaining >= CREDIT_RESERVE;
}

/**
 * The run's own way out, counting what each answer says is left: the system's own headers, read by
 * its `credits`. Only the latest answer counts.
 */
export function counted(
  ctx: RunContext,
  def: ConnectorDefinition,
  seen: { budget: Budget | null },
  now: number,
): RunContext {
  const credits = def.stays?.credits;
  if (!credits) return ctx;
  const http: ConnectorHttp = {
    async request(req) {
      const res = await ctx.http.request(req);
      const c = credits(res);
      if (c) seen.budget = { remaining: c.remaining, resetsAt: now + c.resetsInMs };
      return res;
    },
  };
  return { ...ctx, http };
}

/** Reads the property's system for the next `days` nights into the cache. Answers the rows written. */
export async function syncAri(
  db: Db,
  connectors: ConnectorCapabilities,
  setup: PropertySetup,
  now: number,
  opts: { readonly days: number; readonly live?: boolean },
): Promise<number> {
  const connectorId = setup.property.connectorId;
  const ext = setup.property.externalId;
  if (!connectorId || !ext) return 0;
  if (!opts.live && !(await mayPoll(db, connectorId, now))) return 0;
  const conn = await connectors.contextFor(connectorId, now);
  if (!conn || !isPropertySystem(conn.definition)) return 0;
  const seen: { budget: Budget | null } = { budget: null };
  const ctx = counted(conn.ctx, conn.definition, seen, now);
  const from = dateIn(now, setup.property.timezone);
  const to = addDays(from, opts.days);
  try {
    const read = await conn.definition.stays.ari(ctx, ext, { from, to });
    const rows = Array.isArray(read) ? read : read.rows;
    const statements = ariStatements(connectorId, rows, opts.live ? "live" : "poll", now);
    for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
    return rows.length;
  } catch (error) {
    if (!(error instanceof ConnectorError)) throw error;
    // Asked to wait: nothing more until the system says, and what is cached grows stale meanwhile.
    if (error.code === "rate_limited") {
      seen.budget = { remaining: 0, resetsAt: now + (error.retryAfterMs ?? 5 * 60_000) };
    }
    return 0;
  } finally {
    if (seen.budget) await saveBudget(db, connectorId, seen.budget);
  }
}

/** Keeps a property's polls queued: the short one and the long one. */
export async function ensureAriSync(db: Db, propertyId: string, now: number): Promise<void> {
  await ensureJob(
    db,
    STAY_ARI_SYNC_KIND,
    `${STAY_ARI_SYNC_KIND}:${propertyId}:short:${Math.floor(now / ARI_SHORT_MS)}`,
    {
      now,
      payload: { propertyId, long: false },
    },
  );
}

/** The poll job: reads, then queues the next of its kind while the property is still connected. */
export function ariSyncHandler(connectors: ConnectorCapabilities): JobHandler {
  return async (job, { db, now }) => {
    const p = job.payload as { propertyId?: string; long?: boolean } | null;
    const ids = p?.propertyId
      ? [p.propertyId]
      : (await listProperties(db, { active: true })).filter((x) => x.connectorId).map((x) => x.id);
    const notes: string[] = [];
    for (const id of ids) {
      const setup = await readSetup(db, id);
      if (!setup?.property.connectorId || !setup.property.active) continue;
      const long = p?.long === true;
      const rows = await syncAri(db, connectors, setup, now, { days: long ? 365 : 60 });
      notes.push(`${id}: ${rows} nights`);
      const every = long ? ARI_LONG_MS : ARI_SHORT_MS;
      const next = (Math.floor(now / every) + 1) * every;
      await ensureJob(
        db,
        STAY_ARI_SYNC_KIND,
        `${STAY_ARI_SYNC_KIND}:${id}:${long ? "long" : "short"}:${Math.floor(next / every)}`,
        {
          now,
          runAt: next,
          payload: { propertyId: id, long },
        },
      );
      if (!long) {
        await ensureJob(db, STAY_ARI_SYNC_KIND, `${STAY_ARI_SYNC_KIND}:${id}:long:${Math.floor(now / ARI_LONG_MS)}`, {
          now,
          payload: { propertyId: id, long: true },
        });
      }
    }
    return { note: notes.join("; ") || "no connected property" };
  };
}
