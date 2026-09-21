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
