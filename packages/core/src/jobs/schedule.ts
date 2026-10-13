import type { Db } from "../db";
import { jobStatement } from "../write/common";

/**
 * Enqueues a job once per dedupe key (INSERT OR IGNORE), for recurring work that schedules its
 * own next run: pass a key that names the period, e.g. `network_ping:2026-09-21T15`.
 */
export async function ensureJob(
  db: Db,
  kind: string,
  dedupeKey: string,
  opts: { runAt?: number | undefined; payload?: unknown; now?: number | undefined } = {},
): Promise<void> {
  const now = opts.now ?? Date.now();
  await db.client.query(jobStatement(kind, opts.payload ?? {}, now, { dedupeKey, runAt: opts.runAt ?? now }));
}

/** Deletes finished jobs older than `olderThanMs`; the outbox is not an archive. */
export async function pruneJobs(db: Db, olderThanMs: number, now = Date.now()): Promise<number> {
  const r = await db.client.query({
    sql: "DELETE FROM jobs WHERE status = 'done' AND done_at < ?",
    params: [now - olderThanMs],
    method: "run",
  });
  return r.changes;
}

/**
 * When `runDue` would next find work: the earliest a queued job falls due, or a running one's lease
 * runs out (a run that stopped without settling frees its job then), whichever is later for each
 * job. Null when nothing waits. A host that keeps many inboxes closed asks this as it closes one,
 * and opens it again only then, instead of running every inbox's jobs every second.
 */
export async function nextDueAt(db: Db): Promise<number | null> {
  const { rows } = await db.client.query({
    sql: `SELECT MIN(MAX(run_at, COALESCE(lease_until + 1, 0))) FROM jobs WHERE status IN ('queued', 'running')`,
    params: [],
    method: "all",
  });
  const value = rows[0]?.[0];
  return value === null || value === undefined ? null : Number(value);
}
