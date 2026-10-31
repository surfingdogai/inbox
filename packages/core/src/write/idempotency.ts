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

/** A random UUID: version 4, RFC 9562's variant. Any case, anywhere in the key (`req_<uuid>` is fine). */
const UUID_V4 = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
/** Thirty-two hexadecimal digits or more, in one run: `openssl rand -hex 16`. */
const HEX_RUN = /[0-9a-f]{32,}/gi;
/**
 * Example UUIDs from the manuals, the encyclopaedias and the API tools' defaults: random once, copied
 * by everyone since, and what a model with no random-number tool often writes from memory.
 */
const PRINTED = new Set(
  [
    "550e8400-e29b-41d4-a716-446655440000",
    "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
    "d290f1ee-6c54-4b01-90e6-d701748f0851",
    "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "de305d54-75b4-431b-adb2-eb6b9e546014",
    "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "110ec58a-a0f2-4ac4-8393-c866d813b8d1",
    "c9bf9e57-1685-4c89-bafb-ff5af830be8a",
  ].map((u) => u.replaceAll("-", "")),
);

/**
 * Whether an idempotency key is a secret only its sender could send again (ADR-043 §1): it carries
 * a random UUID (version 4), or a run of at least 32 hexadecimal digits, and that is 128 bits of key
 * material. A key like `booking-1`, a counter, a date, a word or a time-based UUID can be sent by
 * anyone who guesses it; a random one only by whoever made it. Nothing here proves it was drawn at
 * random, so what is plainly not random is refused too: one digit over and over, eight digits counting
 * up or down, or every other digit counting (`a1b2c3d4`), a short part repeated, a UUID every manual
 * prints. A key made from the request itself (a hash of its body) looks random and is not: anyone who
 * knows the request makes the same one, which is why the docs ask for a fresh random key, never one
 * derived from what is sent.
 */
export function strongIdempotencyKey(key: string): boolean {
  if (key.length > 200) return false;
  const material = [
    ...[...key.matchAll(UUID_V4)].map((m) => m[0].replaceAll("-", "")),
    ...[...key.matchAll(HEX_RUN)].map((m) => m[0]),
  ];
  return material.some((hex) => randomLooking(hex.toLowerCase()));
}

function randomLooking(hex: string): boolean {
  if (hex.length < 32 || PRINTED.has(hex)) return false;
  if (new Set(hex).size < 8) return false;
  let same = 1;
  let up = 1;
  let down = 1;
  for (let i = 1; i < hex.length; i++) {
    const step = Number.parseInt(hex[i] as string, 16) - Number.parseInt(hex[i - 1] as string, 16);
    same = step === 0 ? same + 1 : 1;
    up = step === 1 ? up + 1 : 1;
    down = step === -1 ? down + 1 : 1;
    if (same >= 8 || up >= 8 || down >= 8) return false;
  }
  // Every other digit counting up or down through six digits (`a1b2c3d4e5f6`).
  for (let start = 0; start < 2; start++) {
    let run = 0;
    let last = 0;
    for (let i = start + 2; i < hex.length; i += 2) {
      const step = Number.parseInt(hex[i] as string, 16) - Number.parseInt(hex[i - 2] as string, 16);
      run = step !== 0 && Math.abs(step) === 1 ? (step === last ? run + 1 : 1) : 0;
      last = step;
      if (run >= 5) return false;
    }
  }
  // A short part repeated: some period of at most half the length repeats all the way through.
  for (let period = 1; period <= hex.length / 2; period++) {
    let repeats = true;
    for (let i = period; i < hex.length && repeats; i++) repeats = hex[i] === hex[i - period];
    if (repeats) return false;
  }
  return true;
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
  if (p.via === "session" || p.via === "device") return `user:${p.userId ?? p.id}`;
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
