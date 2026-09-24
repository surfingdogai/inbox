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

export type JobHandler = (
  job: JobRow,
  ctx: { db: Db; now: number },
) => Promise<{ note?: string | undefined } | undefined>;

export interface RunReport {
  readonly claimed: number;
  readonly done: number;
  readonly failed: number;
  readonly dead: number;
  /** Claimed by a lane that ran out of time, and handed back for the next run. */
  readonly released: number;
}

export const LEASE_MS = 60_000;

/**
 * How long a lane may keep starting jobs in one run. A lane is someone else's server, and a run
 * ends only when its slowest lane does; past this, the lane's remaining jobs are handed back
 * untouched for the next run, so a slow network costs the rest of the outbox seconds, not minutes.
 */
export const LANE_BUDGET_MS = 10_000;

export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 30_000, 6 * 3_600_000);
}

/**
 * A lane: jobs that name the same lane run one after another, and each lane runs beside the others
 * and beside every job without one. A job that calls someone else's server (a network, ADR-017
 * §8.1) takes a lane per server, so a slow or unreachable one only ever delays its own jobs.
 */
export type LaneOf = (payload: unknown) => string | undefined;

export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly lanes = new Map<string, LaneOf>();
  private running: { readonly report: Promise<RunReport>; readonly since: number } | null = null;
  private readonly laneBudgetMs: number;
  /** The wall clock that ages a shared run; jobs themselves run at the `now` each call passes. */
  private readonly clock: () => number;

  constructor(opts: { laneBudgetMs?: number; clock?: () => number } = {}) {
    this.laneBudgetMs = opts.laneBudgetMs ?? LANE_BUDGET_MS;
    this.clock = opts.clock ?? Date.now;
  }

  register(kind: string, handler: JobHandler, opts: { lane?: LaneOf } = {}): this {
    this.handlers.set(kind, handler);
    if (opts.lane) this.lanes.set(kind, opts.lane);
    else this.lanes.delete(kind);
    return this;
  }

  /**
   * Runs due jobs once. Concurrent calls in one process share the same run, with two exceptions.
   *
   * A caller that awaits the run to finish its own work passes `join: false` and gets a run of its
   * own. On Workers every request, cron tick and queue batch is an invocation of its own, and the I/O
   * of a run belongs to the invocation that started it: when that one ends (a request's waitUntil
   * runs out after 30 s), its run stops for good, and a cron tick that had joined it would wait on
   * it for ever. Two runs at once are safe: each claims its rows with its own leased UPDATE.
   *
   * And a run older than a lease is not joined: whatever it claimed is free to claim again by now,
   * and a run that stopped without settling must not stop every run after it.
   */
  runDue(db: Db, opts: { limit?: number; workerId?: string; now?: number; join?: boolean } = {}): Promise<RunReport> {
    const join = opts.join !== false;
    const current = this.running;
    if (join && current && this.clock() - current.since < LEASE_MS) return current.report;
    const report = this.run(db, opts).finally(() => {
      if (this.running?.report === report) this.running = null;
    });
    if (join) this.running = { report, since: this.clock() };
    return report;
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
    const report = { claimed: rows.length, done: 0, failed: 0, dead: 0, released: 0 };
    // Jobs without a lane keep the order they were claimed in, in one sequence; each lane is a
    // sequence of its own, and the sequences run side by side.
    const sequences = new Map<string, JobRow[]>([["", []]]);
    for (const r of rows) {
      const job: JobRow = {
        id: String(r[0]),
        kind: String(r[1]),
        payload: parse(r[2]),
        attempts: Number(r[3]),
        maxAttempts: Number(r[4]),
      };
      const lane = this.lanes.get(job.kind)?.(job.payload) ?? "";
      const sequence = sequences.get(lane) ?? [];
      sequence.push(job);
      sequences.set(lane, sequence);
    }
    const started = Date.now();
    await Promise.all(
      [...sequences.entries()].map(async ([lane, sequence]) => {
        for (const [i, job] of sequence.entries()) {
          if (lane !== "" && Date.now() - started > this.laneBudgetMs) {
            await this.release(db, sequence.slice(i), now);
            report.released += sequence.length - i;
            return;
          }
          await this.runOne(db, job, now, report);
        }
      }),
    );
    return report;
  }

  /**
   * Claimed and never started: back to the queue, the claim's attempt undone, and behind every job
   * that was already due when this run began. Keeping their old `run_at` would put them first in
   * the next claim again, so a lane with a backlog would take every slot, run by run, and starve
   * the other lanes and the rest of the outbox until it drained.
   */
  private async release(db: Db, jobs: readonly JobRow[], now: number): Promise<void> {
    // In slices: D1 binds at most 100 values in a statement, and a cron run claims up to 100 jobs.
    for (let i = 0; i < jobs.length; i += 90) {
      const slice = jobs.slice(i, i + 90);
      await db.client.query({
        sql: `UPDATE jobs SET status = 'queued', lease_until = NULL, leased_by = NULL, attempts = attempts - 1,
                    run_at = MAX(run_at, ?)
               WHERE id IN (${slice.map(() => "?").join(", ")}) AND status = 'running'`,
        params: [now, ...slice.map((j) => j.id)],
        method: "run",
      });
    }
  }

  private async runOne(
    db: Db,
    job: JobRow,
    now: number,
    report: { done: number; failed: number; dead: number },
  ): Promise<void> {
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
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
