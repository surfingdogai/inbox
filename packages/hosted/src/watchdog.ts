import { Worker } from "node:worker_threads";

/**
 * A shard's watchdog. The shard's event loop writes a heartbeat into shared memory four times a
 * second; a thread of its own reads it. When the heartbeat is older than the threshold (5 s), the
 * loop is stuck: the thread records which inbox was running (the one the shard last named, before
 * each call into it and each query on its file) and ends the process, which its service manager
 * starts again. An inbox blamed three times in an hour is put into maintenance when the shard starts
 * (shard.ts), so one inbox that stalls cannot keep stalling the others.
 *
 * This file uses only syntax a type-stripping loader erases, and imports nothing of ours: the thread
 * is plain JavaScript, and a test runs it in a child process as it is.
 */

export interface Watchdog {
  /** Names the inbox whose code runs from now on (null: none of them). */
  setCurrent(tenantId: string | null): void;
  stop(): Promise<void>;
}

export const BLOCKED_MS = 5_000;
const MAX_ID = 64;

const THREAD = `
const { workerData } = require("node:worker_threads");
const { thresholdMs, ledgerPath, beat, current } = workerData;
const heartbeat = new BigInt64Array(beat);
const length = new Int32Array(current, 0, 1);
const bytes = new Uint8Array(current, 4);
const check = () => {
  const last = Number(Atomics.load(heartbeat, 0));
  const now = Date.now();
  if (last === 0 || now - last <= thresholdMs) return;
  const n = Atomics.load(length, 0);
  const tenant = n > 0 ? new TextDecoder().decode(bytes.slice(0, n)) : null;
  try {
    process.stderr.write("shard: the event loop was blocked for " + (now - last) + " ms" + (tenant ? " while " + tenant + " was running" : "") + "; restarting\\n");
  } catch {}
  if (tenant && ledgerPath) {
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(ledgerPath, { timeout: 2000 });
      db.prepare("INSERT INTO blames (tenant_id, at) VALUES (?, ?)").run(tenant, now);
      db.close();
    } catch {}
  }
  process.kill(process.pid, "SIGKILL");
};
setInterval(check, Math.max(50, Math.floor(thresholdMs / 4)));
`;

export function startWatchdog(o: { thresholdMs?: number; ledgerPath?: string | null }): Watchdog {
  const thresholdMs = o.thresholdMs ?? BLOCKED_MS;
  const beat = new SharedArrayBuffer(8);
  const current = new SharedArrayBuffer(4 + MAX_ID);
  const heartbeat = new BigInt64Array(beat);
  const length = new Int32Array(current, 0, 1);
  const bytes = new Uint8Array(current, 4);
  const tick = () => {
    Atomics.store(heartbeat, 0, BigInt(Date.now()));
  };
  tick();
  const timer = setInterval(tick, Math.max(25, Math.floor(thresholdMs / 20)));
  timer.unref();
  const worker = new Worker(THREAD, {
    eval: true,
    workerData: { thresholdMs, ledgerPath: o.ledgerPath ?? null, beat, current },
  });
  worker.unref();
  const encoder = new TextEncoder();
  return {
    setCurrent(tenantId) {
      if (!tenantId) {
        Atomics.store(length, 0, 0);
        return;
      }
      const encoded = encoder.encode(tenantId).slice(0, MAX_ID);
      Atomics.store(length, 0, 0);
      bytes.set(encoded);
      Atomics.store(length, 0, encoded.length);
    },
    async stop() {
      clearInterval(timer);
      await worker.terminate();
    },
  };
}
