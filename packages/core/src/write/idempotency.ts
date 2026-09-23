import type { Db } from "../db";
import type { SecretBox } from "../secrets/box";
import { hashJson } from "../util/canonical";
import { type Caller, nowOf } from "./caller";
import { findIdempotent } from "./common";
import { WriteError } from "./errors";

/**
 * Idempotency for the owner's writes that are not item writes: setup, settings, webhooks, feeds and
 * keys. Item writes (create, transition, reply) already store their answer in the very batch that
 * makes the change; these writes are several statements, or a call out, so they cannot. Instead the
 * key is reserved first, the write runs, and the answer is stored on the reservation:
 *
 *   reserve (INSERT, the unique key decides who runs) → run → store the answer
 *
 * A second request with the same key and the same body gets the stored answer back and nothing
 * runs twice; with a different body it is refused (`idempotency_mismatch`); while the first is
 * still running it is told to wait. A write that fails releases its key, so a corrected retry with
 * the same key is not held to a failure. A reservation abandoned by a crash is taken over after
 * `STALE_RESERVATION_MS`, so a key is never stuck for good.
 *
 * Idempotency keys are for retries. They are pruned after `IDEMPOTENCY_TTL_MS`.
 */
export const IDEMPOTENCY_TTL_MS = 30 * 86_400_000;
export const STALE_RESERVATION_MS = 5 * 60_000;

/** A reservation's status until the answer is stored. Real answers are HTTP-style statuses. */
const RESERVED = 0;

export interface OnceOptions {
  /**
   * The answer carries a secret shown once (a signing secret, a key). It is stored sealed by the
   * secret box, never in the clear; without a box it is stored with the secret left out, and a
   * replay says so. The secret is replayed only to the principal that made the request: idempotency
   * keys are shared across the whole business, and another key or AI app that sends the same key
   * and body gets the answer with the secret left out, never someone else's key or signing secret.
   */
  readonly secret?: { readonly box: SecretBox | null; readonly fields: readonly string[] } | undefined;
}

export interface OnceResult<T> {
  readonly result: T;
  readonly replayed: boolean;
}

export async function once<T>(
  db: Db,
  caller: Caller,
  op: string,
  input: unknown,
  run: () => Promise<T>,
  opts: OnceOptions = {},
): Promise<OnceResult<T>> {
  const idem = caller.idempotency;
  if (!idem) return { result: await run(), replayed: false };
  const requestHash = await hashJson({ op, input });
  const now = nowOf(caller);

  for (let attempt = 0; attempt < 2; attempt++) {
    const hit = await findIdempotent(db, idem);
    if (hit) {
      if (hit.requestHash !== requestHash) {
        throw new WriteError(
          "idempotency_mismatch",
          "this idempotency key was already used with a different request; use a new key for a new request",
        );
      }
      if (hit.status !== RESERVED) {
        return { result: await restore<T>(hit.response, idem, opts, requester(caller)), replayed: true };
      }
      const [row] = (
        await db.client.query({
          sql: "SELECT created_at FROM idempotency_keys WHERE scope = ? AND key = ?",
          params: [idem.scope, idem.key],
          method: "all",
        })
      ).rows;
      if (row && now - Number(row[0]) < STALE_RESERVATION_MS) {
        throw new WriteError(
          "version_conflict",
          "a request with this idempotency key is still running; retry in a moment with the same key",
          { details: { idempotency: "in_progress" } },
        );
      }
      // Abandoned: take it over, but only if nobody else did in the meantime.
      await db.client.query({
        sql: "DELETE FROM idempotency_keys WHERE scope = ? AND key = ? AND status = ?",
        params: [idem.scope, idem.key, RESERVED],
        method: "run",
      });
      continue;
    }
    const reserved = await db.client.query({
      sql: "INSERT OR IGNORE INTO idempotency_keys (scope, key, request_hash, status, response, item_id, created_at) VALUES (?, ?, ?, ?, 'null', NULL, ?)",
      params: [idem.scope, idem.key, requestHash, RESERVED, now],
      method: "run",
    });
    if (reserved.changes !== 1) continue; // Someone else got there first: read what they stored.

    let result: T;
    try {
      result = await run();
    } catch (error) {
      await db.client.query({
        sql: "DELETE FROM idempotency_keys WHERE scope = ? AND key = ? AND status = ?",
        params: [idem.scope, idem.key, RESERVED],
        method: "run",
      });
      throw error;
    }
    await db.client.query({
      sql: "UPDATE idempotency_keys SET status = 200, response = ? WHERE scope = ? AND key = ?",
      params: [JSON.stringify(await store(result, idem, opts, requester(caller))), idem.scope, idem.key],
      method: "run",
    });
    return { result, replayed: false };
  }
  throw new WriteError(
    "version_conflict",
    "a request with this idempotency key is still running; retry in a moment with the same key",
    { details: { idempotency: "in_progress" } },
  );
}

/** Keys older than the TTL go; the hourly tick calls this. */
export async function pruneIdempotencyKeys(db: Db, now: number, maxAgeMs = IDEMPOTENCY_TTL_MS): Promise<number> {
  const r = await db.client.query({
    sql: "DELETE FROM idempotency_keys WHERE created_at < ?",
    params: [now - maxAgeMs],
    method: "run",
  });
  return r.changes;
}

type Idem = NonNullable<Caller["idempotency"]>;

/**
 * Who asked, for the one thing a replay must not share across the business: a secret. The owner in
 * person is the same person in any session; an AI app is its client for that person; a key is itself.
 */
function requester(caller: Caller): string {
  const p = caller.principal;
  if (!p) return `internal:${caller.actor.kind}:${caller.actor.id}`;
  if (p.via === "session") return `user:${p.userId ?? p.id}`;
  if (p.via === "oauth") return `oauth:${p.id}:${p.userId ?? ""}`;
  return `key:${p.id}`;
}

const REPLAY_NOTE =
  "This answer is a replay, and the secret it carried was shown only the first time. If it was lost, replace it: rotate the secret, or revoke the key and create another.";
const OTHER_NOTE =
  "This answer is a replay of a request another key or app made with the same idempotency key, so the secret it carried is not shown here. Use a new idempotency key for a new request.";

async function store(result: unknown, idem: Idem, opts: OnceOptions, by: string): Promise<unknown> {
  const secret = opts.secret;
  if (!secret || !isRecord(result)) return result;
  if (secret.box) {
    return {
      sealed: await secret.box.seal("idempotent-response", `${idem.scope}:${idem.key}`, JSON.stringify(result)),
      by,
    };
  }
  const kept: Record<string, unknown> = { ...result };
  for (const field of secret.fields) delete kept[field];
  return { withheld: secret.fields, value: kept };
}

async function restore<T>(stored: unknown, idem: Idem, opts: OnceOptions, by: string): Promise<T> {
  if (!opts.secret || !isRecord(stored)) return stored as T;
  if (typeof stored.sealed === "string" && opts.secret.box) {
    const opened = JSON.parse(
      await opts.secret.box.open("idempotent-response", `${idem.scope}:${idem.key}`, stored.sealed),
    ) as unknown;
    // The secret goes back only to whoever asked for it; anyone else gets the answer without it.
    if (stored.by === by || !isRecord(opened)) return opened as T;
    return withhold(opened, opts.secret.fields, OTHER_NOTE) as T;
  }
  if (Array.isArray(stored.withheld) && isRecord(stored.value)) {
    return withhold(stored.value, stored.withheld as string[], REPLAY_NOTE) as T;
  }
  return stored as T;
}

function withhold(value: Record<string, unknown>, fields: readonly string[], note: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  for (const field of fields) out[field] = null;
  out.secret_note = note;
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
