import type { Db } from "../db";
import { randomToken, ulid } from "../ids";
import type { JobHandler } from "../jobs/runner";
import { ensureJob } from "../jobs/schedule";
import { hashJson } from "../util/canonical";
import { ConnectorError } from "./sdk";

/**
 * Write first (ADR-032): when a business's own system (a property system, a salon's booking system, a
 * till) is the authority for what can be sold, the inbox promises nothing until that system has taken
 * the write. One caller at a time writes for an item (a compare-and-set claim on `connector_links`),
 * every attempt is journalled (`connector_writes`), a retry sends the same idempotency key, and a
 * write whose answer never came is looked for by the inbox's own marker before anything is decided:
 * a timeout never counts as a refusal while the write may have landed. What is still unknown then is
 * settled by a job within minutes, through the resolver its owner (stays, bookings) registered.
 *
 * For a system that takes a write even when it oversells, the write is read back at once, from the
 * system's own definite word; if ours made it oversold, the inbox takes its own write back and says
 * so. A read-back that could not be made is no answer: the write is settled as unknown, and nothing is
 * promised until the resolver has read it back, or has taken it back once it never could.
 */

export type WriteOp = "reserve" | "modify" | "cancel" | "release";
export type WriteOutcome = "pending" | "written" | "refused" | "unknown" | "rolled_back";

/** The system's answer to a write: its id for what was written. */
export interface WrittenRef {
  readonly externalId: string;
  /** What else it said that the caller keeps (a status, a link to open it in the system). */
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
}

export interface WriteFirstCall {
  readonly connectorId: string;
  readonly itemId: string;
  readonly op: WriteOp;
  /**
   * Who settles a write left unknown (`registerWriteResolver`): `stays`, `bookings`. Stored, so the
   * resolver job knows whom to ask.
   */
  readonly owner: string;
  /**
   * Stable for one logical write: sent as the system's idempotency key and marker, the same on every
   * retry, so a write that landed is never made twice.
   */
  readonly key: string;
  /** What is written, for the journal's fingerprint: hashed, never kept (it may name the guest). */
  readonly request: unknown;
  /** How long the system has to answer before it is looked for instead: 20 s by default. */
  readonly timeoutMs?: number | undefined;
  write(key: string): Promise<WrittenRef>;
  /** The write as the system holds it, found by `key`; null when it is not there. */
  find(key: string): Promise<WrittenRef | null>;
  /** For a system that takes oversold writes: read back now, `conflict` when ours oversold it, `unknown` when it could not tell. */
  readBack?(ref: WrittenRef): Promise<"ok" | "conflict" | "unknown">;
  /** Takes our own write back, after a conflict. */
  rollback?(ref: WrittenRef): Promise<void>;
  readonly now: number;
}

export type WriteFirstResult =
  | { readonly status: "written"; readonly ref: WrittenRef; readonly journalId: string; readonly replayed: boolean }
  | { readonly status: "refused"; readonly reason: string; readonly journalId: string }
  /** Ours oversold it, and was taken back: nothing is promised. */
  | { readonly status: "conflict"; readonly journalId: string }
  /** No answer, and not found yet: the resolver settles it; nothing is promised meanwhile. */
  | { readonly status: "pending"; readonly journalId: string }
  /** Another caller is writing for this item now. */
  | { readonly status: "busy" };

export const CONNECTOR_WRITE_RESOLVE_KIND = "connector_write_resolve";
/** The longest one caller holds an item's claim: past the slowest answer and one look for it. */
const CLAIM_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;
/** How long an unknown write is looked for before it counts as not written. */
export const RESOLVE_WITHIN_MS = 5 * 60_000;
const RESOLVE_EVERY_MS = 30_000;

class Timeout extends Error {}

function timed<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout("no answer in time")), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Whether an error means the write may have landed: no answer, or one we could not read. */
function mayHaveLanded(error: unknown): boolean {
  if (error instanceof Timeout) return true;
  return error instanceof ConnectorError && (error.code === "unreachable" || error.code === "bad_response");
}

/** A journal row, as the resolver reads it. */
export interface WriteRow {
  readonly id: string;
  readonly connectorId: string;
  readonly itemId: string;
  readonly op: WriteOp;
  readonly owner: string;
  readonly attempt: number;
  readonly idemKey: string;
  readonly outcome: WriteOutcome;
  readonly externalId: string | null;
  readonly createdAt: number;
}

const ROW = "id, connector_id, item_id, op, owner, attempt, idem_key, outcome, external_id, created_at";
function rowOf(r: readonly unknown[]): WriteRow {
  return {
    id: String(r[0]),
    connectorId: String(r[1]),
    itemId: String(r[2]),
    op: String(r[3]) as WriteOp,
    owner: String(r[4]),
    attempt: Number(r[5]),
    idemKey: String(r[6]),
    outcome: String(r[7]) as WriteOutcome,
    externalId: r[8] === null || r[8] === undefined ? null : String(r[8]),
    createdAt: Number(r[9]),
  };
}

async function settle(
  db: Db,
  id: string,
  outcome: WriteOutcome,
  now: number,
  extra: { externalId?: string | null; detail?: string | null; resolveAfter?: number | null } = {},
): Promise<void> {
  await db.client.query({
    sql: `UPDATE connector_writes SET outcome = ?, external_id = COALESCE(?, external_id), detail = COALESCE(?, detail),
                 resolve_after = ?, updated_at = ? WHERE id = ?`,
    params: [outcome, extra.externalId ?? null, extra.detail ?? null, extra.resolveAfter ?? null, now, id],
    method: "run",
  });
}

async function claim(db: Db, connectorId: string, itemId: string, now: number): Promise<string | null> {
  const token = randomToken(12);
  await db.client.query({
    sql: `INSERT OR IGNORE INTO connector_links (connector_id, item_id, state, created_at, updated_at)
          VALUES (?, ?, 'pending', ?, ?)`,
    params: [connectorId, itemId, now, now],
    method: "run",
  });
  const r = await db.client.query({
    sql: `UPDATE connector_links SET claim_until = ?, claimed_by = ?, updated_at = ?
           WHERE connector_id = ? AND item_id = ? AND (claim_until IS NULL OR claim_until < ?)`,
    params: [now + CLAIM_MS, token, now, connectorId, itemId, now],
    method: "run",
  });
  return r.changes === 1 ? token : null;
}

async function release(
  db: Db,
  connectorId: string,
  itemId: string,
  token: string,
  now: number,
  written?: WrittenRef,
): Promise<void> {
  await db.client.query({
    sql: `UPDATE connector_links SET claim_until = NULL, claimed_by = NULL, updated_at = ?,
                 external_id = COALESCE(?, external_id), state = CASE WHEN ? IS NULL THEN state ELSE 'synced' END
           WHERE connector_id = ? AND item_id = ? AND claimed_by = ?`,
    params: [now, written?.externalId ?? null, written?.externalId ?? null, connectorId, itemId, token],
    method: "run",
  });
}

/**
 * Writes to the business's system first, journalled, under the item's claim. Answers what the system
 * did, or that it is not known yet (the resolver job then settles it), or that another caller is
 * writing for the item now.
 */
export async function writeFirst(db: Db, call: WriteFirstCall): Promise<WriteFirstResult> {
  const { connectorId, itemId, op, now } = call;
  // A write that landed before, under the same key, is the answer again: never written twice.
  const { rows: before } = await db.client.query({
    sql: `SELECT ${ROW} FROM connector_writes WHERE connector_id = ? AND item_id = ? AND op = ? AND idem_key = ?
           ORDER BY attempt DESC LIMIT 1`,
    params: [connectorId, itemId, op, call.key],
    method: "all",
  });
  const last = before[0] ? rowOf(before[0]) : null;
  if (last?.outcome === "written" && last.externalId) {
    return { status: "written", ref: { externalId: last.externalId }, journalId: last.id, replayed: true };
  }
  if (last?.outcome === "unknown" || last?.outcome === "pending") return { status: "pending", journalId: last.id };
  const token = await claim(db, connectorId, itemId, now);
  if (!token) return { status: "busy" };
  const journalId = ulid(now);
  const requestSha = await hashJson({ op, key: call.key, request: call.request });
  await db.client.query({
    sql: `INSERT INTO connector_writes (id, connector_id, item_id, op, owner, attempt, idem_key, request_sha, outcome, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(attempt), 0) + 1 FROM connector_writes WHERE connector_id = ? AND item_id = ?),
                  ?, ?, 'pending', ?, ?)`,
    params: [journalId, connectorId, itemId, op, call.owner, connectorId, itemId, call.key, requestSha, now, now],
    method: "run",
  });
  try {
    let ref: WrittenRef;
    try {
      ref = await timed(call.write(call.key), call.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof ConnectorError && (error.code === "refused" || error.code === "config")) {
        await settle(db, journalId, "refused", now, { detail: error.message.slice(0, 500) });
        return { status: "refused", reason: error.message, journalId };
      }
      if (!mayHaveLanded(error)) {
        await settle(db, journalId, "refused", now, {
          detail: String((error as Error)?.message ?? error).slice(0, 500),
        });
        throw error;
      }
      // It may have landed: looked for by our own key before anything is decided.
      let found: WrittenRef | null = null;
      try {
        found = await timed(call.find(call.key), call.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      } catch {
        found = null;
      }
      if (!found) {
        await settle(db, journalId, "unknown", now, {
          resolveAfter: now + RESOLVE_EVERY_MS,
          detail: "no answer, not found yet",
        });
        await ensureJob(db, CONNECTOR_WRITE_RESOLVE_KIND, `cwrite:${journalId}`, {
          now,
          runAt: now + RESOLVE_EVERY_MS,
          payload: { journalId },
        });
        return { status: "pending", journalId };
      }
      ref = found;
    }
    if (call.readBack) {
      const seen = await call.readBack(ref);
      if (seen === "unknown") {
        // Written, but not known to be sound: the resolver reads it back again before anything is promised.
        await settle(db, journalId, "unknown", now, {
          externalId: ref.externalId,
          resolveAfter: now + RESOLVE_EVERY_MS,
          detail: "written, not read back yet",
        });
        await ensureJob(db, CONNECTOR_WRITE_RESOLVE_KIND, `cwrite:${journalId}`, {
          now,
          runAt: now + RESOLVE_EVERY_MS,
          payload: { journalId },
        });
        return { status: "pending", journalId };
      }
      if (seen === "conflict") {
        try {
          await call.rollback?.(ref);
        } catch {
          // Ours oversold and could not be taken back yet: the resolver reads it back and tries again,
          // and nothing is promised meanwhile. Never left pending with nobody to settle it.
          await settle(db, journalId, "unknown", now, {
            externalId: ref.externalId,
            resolveAfter: now + RESOLVE_EVERY_MS,
            detail: "oversold: taking ours back failed, tried again",
          });
          await ensureJob(db, CONNECTOR_WRITE_RESOLVE_KIND, `cwrite:${journalId}`, {
            now,
            runAt: now + RESOLVE_EVERY_MS,
            payload: { journalId },
          });
          return { status: "pending", journalId };
        }
        await settle(db, journalId, "rolled_back", now, {
          externalId: ref.externalId,
          detail: "oversold: our write taken back",
        });
        return { status: "conflict", journalId };
      }
    }
    await settle(db, journalId, "written", now, { externalId: ref.externalId });
    await release(db, connectorId, itemId, token, now, ref);
    return { status: "written", ref, journalId, replayed: false };
  } finally {
    await release(db, connectorId, itemId, token, now);
  }
}

/**
 * Settles writes left unknown: the owner's resolver looks for each again by its key. Found, it is
 * written; still not found once `RESOLVE_WITHIN_MS` has passed, it counts as not written (the owner
 * then tells the customer nothing was promised). Every outcome goes back to the owner's resolver.
 */
export interface WriteResolver {
  /** Looks for the write again, by its key. */
  find(db: Db, row: WriteRow, now: number): Promise<WrittenRef | null>;
  /** For a system that takes oversold writes: the write found, read back as the write's own read-back would. */
  readBack?(db: Db, row: WriteRow, ref: WrittenRef, now: number): Promise<"ok" | "conflict" | "unknown">;
  /** Takes the write back: it oversold, or could never be read back. */
  rollback?(db: Db, row: WriteRow, ref: WrittenRef, now: number): Promise<void>;
  /** The write is settled: written (with what the system said) or not. */
  settled(db: Db, row: WriteRow, outcome: "written" | "refused", ref: WrittenRef | null, now: number): Promise<void>;
}

const resolvers = new Map<string, WriteResolver>();

/** Registers who settles the unknown writes of an owner (`stays`). */
export function registerWriteResolver(owner: string, resolver: WriteResolver): void {
  resolvers.set(owner, resolver);
}

/** The writes still unknown whose time to look again has come. */
export async function dueWrites(db: Db, now: number, limit = 20): Promise<WriteRow[]> {
  const { rows } = await db.client.query({
    sql: `SELECT ${ROW} FROM connector_writes WHERE outcome = 'unknown' AND resolve_after <= ? ORDER BY resolve_after LIMIT ?`,
    params: [now, limit],
    method: "all",
  });
  return rows.map(rowOf);
}

/** Looks once more for one unknown write, and settles it when it can. Answers what it did. */
export async function resolveWrite(db: Db, journalId: string, now: number): Promise<string> {
  const { rows } = await db.client.query({
    sql: `SELECT ${ROW} FROM connector_writes WHERE id = ?`,
    params: [journalId],
    method: "all",
  });
  const row = rows[0] ? rowOf(rows[0]) : null;
  if (!row) return "no such write";
  if (row.outcome !== "unknown") return `settled already: ${row.outcome}`;
  const resolver = resolvers.get(row.owner);
  if (!resolver) return `nobody settles ${row.owner} writes here`;
  // A write that answered but could not be read back is found already: it is read back again.
  let found: WrittenRef | null = row.externalId ? { externalId: row.externalId } : null;
  if (!found) {
    try {
      found = await resolver.find(db, row, now);
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
    }
  }
  if (found && resolver.readBack) {
    let seen: "ok" | "conflict" | "unknown";
    try {
      seen = await resolver.readBack(db, row, found, now);
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      seen = "unknown";
    }
    const late = now - row.createdAt >= RESOLVE_WITHIN_MS;
    if (seen === "unknown" && !late) {
      await settle(db, row.id, "unknown", now, { externalId: found.externalId, resolveAfter: now + RESOLVE_EVERY_MS });
      await ensureJob(db, CONNECTOR_WRITE_RESOLVE_KIND, `cwrite:${row.id}:${Math.floor(now / RESOLVE_EVERY_MS)}`, {
        now,
        runAt: now + RESOLVE_EVERY_MS,
        payload: { journalId: row.id },
      });
      return "written, not read back yet";
    }
    if (seen !== "ok") {
      // Oversold, or never known not to be: taken back, and nothing promised.
      try {
        await resolver.rollback?.(db, row, found, now);
      } catch (error) {
        if (!(error instanceof ConnectorError)) throw error;
      }
      const done = await db.client.query({
        sql: "UPDATE connector_writes SET outcome = 'rolled_back', external_id = ?, detail = ?, resolve_after = NULL, updated_at = ? WHERE id = ? AND outcome = 'unknown'",
        params: [
          found.externalId,
          seen === "conflict" ? "oversold: our write taken back" : "never read back: taken back",
          now,
          row.id,
        ],
        method: "run",
      });
      if (done.changes === 1) await resolver.settled(db, row, "refused", null, now);
      return seen === "conflict" ? "oversold: taken back" : "never read back: taken back";
    }
  }
  if (found) {
    const done = await db.client.query({
      sql: "UPDATE connector_writes SET outcome = 'written', external_id = ?, resolve_after = NULL, updated_at = ? WHERE id = ? AND outcome = 'unknown'",
      params: [found.externalId, now, row.id],
      method: "run",
    });
    if (done.changes === 1) await resolver.settled(db, row, "written", found, now);
    return "found: written";
  }
  if (now - row.createdAt < RESOLVE_WITHIN_MS) {
    await settle(db, row.id, "unknown", now, { resolveAfter: now + RESOLVE_EVERY_MS });
    await ensureJob(db, CONNECTOR_WRITE_RESOLVE_KIND, `cwrite:${row.id}:${Math.floor(now / RESOLVE_EVERY_MS)}`, {
      now,
      runAt: now + RESOLVE_EVERY_MS,
      payload: { journalId: row.id },
    });
    return "not found yet";
  }
  const done = await db.client.query({
    sql: "UPDATE connector_writes SET outcome = 'refused', detail = 'never found: not written', resolve_after = NULL, updated_at = ? WHERE id = ? AND outcome = 'unknown'",
    params: [now, row.id],
    method: "run",
  });
  if (done.changes === 1) await resolver.settled(db, row, "refused", null, now);
  return "never found: not written";
}

/** The job that settles one unknown write; a sweep finds any whose job was lost. */
export function writeResolveHandler(): JobHandler {
  return async (job, { db, now }) => {
    const id = (job.payload as { journalId?: unknown } | null)?.journalId;
    if (typeof id === "string") return { note: await resolveWrite(db, id, now) };
    const notes: string[] = [];
    for (const row of await dueWrites(db, now)) notes.push(`${row.id}: ${await resolveWrite(db, row.id, now)}`);
    return { note: notes.join("; ") || "nothing unknown" };
  };
}
