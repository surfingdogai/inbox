import type { Statement } from "@surfingdog/platform";
import { toDbError } from "@surfingdog/platform";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { ulid } from "../ids";
import { idempotencyKeys, items, slotClaims } from "../schema/tables";
import type { Caller } from "./caller";
import { WriteError } from "./errors";

export interface IdempotentHit {
  readonly requestHash: string;
  readonly status: number;
  readonly response: unknown;
}

export async function findIdempotent(
  db: Db,
  idem: NonNullable<Caller["idempotency"]>,
): Promise<IdempotentHit | undefined> {
  const [row] = await db.orm
    .select({
      requestHash: idempotencyKeys.requestHash,
      status: idempotencyKeys.status,
      response: idempotencyKeys.response,
    })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.scope, idem.scope), eq(idempotencyKeys.key, idem.key)));
  return row;
}

export function idempotencyStatement(
  idem: NonNullable<Caller["idempotency"]>,
  requestHash: string,
  status: number,
  response: unknown,
  itemId: string,
  now: number,
): Statement {
  return {
    sql: "INSERT INTO idempotency_keys (scope, key, request_hash, status, response, item_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    params: [idem.scope, idem.key, requestHash, status, JSON.stringify(response), itemId, now],
    method: "run",
  };
}

/** Jobs are the transactional outbox: inserted in the same batch as the change they follow. */
export function jobStatement(
  kind: string,
  payload: unknown,
  now: number,
  opts: { dedupeKey?: string; runAt?: number } = {},
): Statement {
  return {
    sql: "INSERT OR IGNORE INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at) VALUES (?, ?, ?, ?, 'queued', 0, 8, ?, ?)",
    params: [ulid(), kind, JSON.stringify(payload), opts.runAt ?? now, opts.dedupeKey ?? null, now],
    method: "run",
  };
}

export function eventStatement(e: {
  id: string;
  itemId: string;
  seq: number;
  event: string;
  fromState: string | null;
  toState: string;
  actorKind: string;
  actorId: string;
  reason?: string | null;
  diff?: unknown;
  meta?: unknown;
  causationId?: string | null;
  depth?: number;
  now: number;
}): Statement {
  return {
    sql: "INSERT INTO item_events (id, item_id, seq, event, from_state, to_state, actor_kind, actor_id, reason, diff, meta, causation_id, depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    params: [
      e.id,
      e.itemId,
      e.seq,
      e.event,
      e.fromState,
      e.toState,
      e.actorKind,
      e.actorId,
      e.reason ?? null,
      e.diff === undefined ? null : JSON.stringify(e.diff),
      e.meta === undefined ? null : JSON.stringify(e.meta),
      e.causationId ?? null,
      e.depth ?? 0,
      e.now,
    ],
    method: "run",
  };
}

export function threadEntryStatement(t: {
  itemId: string;
  direction: "in" | "out" | "note";
  channel: string;
  actorKind: string;
  actorId: string | null;
  partyId: string | null;
  subject?: string | null;
  body: string;
  messageId?: string | null;
  now: number;
}): Statement {
  return {
    sql: "INSERT INTO thread_entries (id, item_id, direction, channel, actor_kind, actor_id, party_id, subject, body_text, body_format, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'text', ?, ?)",
    params: [
      ulid(),
      t.itemId,
      t.direction,
      t.channel,
      t.actorKind,
      t.actorId,
      t.partyId,
      t.subject ?? null,
      t.body,
      t.messageId ?? null,
      t.now,
    ],
    method: "run",
  };
}

/**
 * A batch failed. The error text is only a hint; the truth is re-read from the database and turned
 * into the one refusal a caller can act on (ADR-007).
 */
export async function diagnoseFailure(
  db: Db,
  error: unknown,
  ctx: {
    idem?: Caller["idempotency"] | undefined;
    requestHash?: string | undefined;
    itemId?: string | undefined;
    expectedVersion?: number | undefined;
    claims?: { resourceKey: string; claims: readonly [number, number][] } | undefined;
  },
): Promise<IdempotentHit> {
  const e = toDbError(error);
  if (e.code !== "unique") throw new WriteError("internal", e.message);
  if (ctx.idem) {
    const hit = await findIdempotent(db, ctx.idem);
    if (hit) {
      if (hit.requestHash === ctx.requestHash) return hit;
      throw new WriteError("idempotency_mismatch", "this idempotency key was already used with a different request");
    }
  }
  if (ctx.itemId && ctx.expectedVersion !== undefined) {
    const [row] = await db.orm.select({ version: items.version }).from(items).where(eq(items.id, ctx.itemId));
    if (row && row.version !== ctx.expectedVersion) {
      throw new WriteError("version_conflict", "the item changed while you were writing; read it again and retry", {
        details: { currentVersion: row.version },
      });
    }
  }
  if (ctx.claims) {
    for (const [bucket, ordinal] of ctx.claims.claims) {
      const [row] = await db.orm
        .select({ itemId: slotClaims.itemId })
        .from(slotClaims)
        .where(
          and(
            eq(slotClaims.resourceKey, ctx.claims.resourceKey),
            eq(slotClaims.bucketStart, bucket),
            eq(slotClaims.ordinal, ordinal),
          ),
        );
      if (row && row.itemId !== ctx.itemId)
        throw new WriteError("slot_taken", "that time was taken a moment ago", { details: { bucket } });
    }
  }
  throw new WriteError("internal", e.message);
}
