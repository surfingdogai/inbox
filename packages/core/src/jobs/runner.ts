import type { Db } from "../db";

/**
 * The transactional outbox's consumer. Rows land in `jobs` inside the batch that caused them;
 * `runDue` claims due rows with one leased UPDATE (safe across processes and isolates), runs the
 * handler, and marks done / requeues with backoff / marks dead. Every runtime calls it: the Node
 * loop every second, the Worker after each mutating request and on cron, hosted from alarms.
 */
export interface JobRow {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export type JobHandler = (job: JobRow, ctx: { db: Db; now: number }) => Promise<void | { note?: string }>;

export interface RunReport {
  readonly claimed: number;
  readonly done: number;
  readonly failed: number;
  readonly dead: number;
}

export const LEASE_MS = 60_000;

export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 30_000, 6 * 3_600_000);
}

export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private running: Promise<RunReport> | null = null;

  register(kind: string, handler: JobHandler): this {
    this.handlers.set(kind, handler);
    return this;
  }

  /** Runs due jobs once. Concurrent calls in one process share the same run. */
  runDue(db: Db, opts: { limit?: number; workerId?: string; now?: number } = {}): Promise<RunReport> {
    if (this.running) return this.running;
    this.running = this.run(db, opts).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(db: Db, opts: { limit?: number; workerId?: string; now?: number }): Promise<RunReport> {
    const now = opts.now ?? Date.now();
    const limit = opts.limit ?? 20;
    const workerId = opts.workerId ?? "local";
    const { rows } = await db.client.query({
      sql: `UPDATE jobs SET status = 'running', lease_until = ?, leased_by = ?, attempts = attempts + 1
            WHERE id IN (SELECT id FROM jobs WHERE status IN ('queued', 'running') AND run_at <= ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY run_at LIMIT ?)
            RETURNING id, kind, payload, attempts, max_attempts`,
      params: [now + LEASE_MS, workerId, now, now, limit],
      method: "all",
    });
    const report = { claimed: rows.length, done: 0, failed: 0, dead: 0 };
    for (const r of rows) {
      const job: JobRow = {
        id: String(r[0]),
        kind: String(r[1]),
        payload: parse(r[2]),
        attempts: Number(r[3]),
        maxAttempts: Number(r[4]),
      };
      const handler = this.handlers.get(job.kind);
      try {
        if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
        const result = await handler(job, { db, now });
        await db.client.query({
          sql: "UPDATE jobs SET status = 'done', done_at = ?, lease_until = NULL, last_error = ? WHERE id = ?",
          params: [now, result?.note ?? null, job.id],
          method: "run",
        });
        report.done++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (job.attempts >= job.maxAttempts) {
          await db.client.query({
            sql: "UPDATE jobs SET status = 'dead', lease_until = NULL, last_error = ? WHERE id = ?",
            params: [message, job.id],
            method: "run",
          });
          report.dead++;
        } else {
          await db.client.query({
            sql: "UPDATE jobs SET status = 'queued', lease_until = NULL, run_at = ?, last_error = ? WHERE id = ?",
            params: [now + backoffMs(job.attempts), message, job.id],
            method: "run",
          });
          report.failed++;
        }
      }
    }
    return report;
  }
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
