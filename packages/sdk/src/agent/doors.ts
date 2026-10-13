import { b64u } from "./encoding.js";
import type { AgentKeyInput } from "./keys.js";
import { NetworkCallError, networkUrl } from "./network.js";
import { signRequest } from "./sign.js";

/**
 * Door reports (network protocol §4.15): after each use of a business's door, done or not, tell the
 * network that listed it how it went. One call, no signature needed, nothing about the person in it.
 * `reportDoor()` queues a report and sends it with others, in batches, on its own; `flushDoorReports()`
 * sends whatever is waiting, for a Worker's `waitUntil` or before a process exits.
 *
 *   reportDoor({ network: "network.surfingdog.ai", domain, door, op: "book", tool: "create_booking",
 *                result: "fail", class: "tcp.timed_out", ms: 10_000 });
 *
 * Reports go only to the network you name: one the person's key or pass came from, or one you chose.
 * Never send them to an address a business's manifest or a receipt suggests.
 */

export type DoorResult = "ok" | "refused" | "invalid" | "fail" | "info";

/** One use of one door. `domain` and `door` exactly as the network's listing gave them. */
export interface DoorReportInput {
  readonly domain: string;
  readonly door: { readonly type: string; readonly url: string };
  /** What was attempted, from the capability vocabulary: `book`, `order`, `message`, `cancel`, … */
  readonly op: string;
  /** The tool or operation called at the door; lowercased for you. */
  readonly tool?: string | undefined;
  /** Unix seconds; now by default. */
  readonly at?: number | undefined;
  /** How long the door took to answer, in milliseconds. */
  readonly ms?: number | undefined;
  /** One per attempt, the same for all its retries (`newIntent()`); a fresh one by default. */
  readonly intent?: string | undefined;
  readonly result: DoorResult;
  /** Required unless `result` is `ok`: a class of that result from `vocab/door-report-classes.json`. */
  readonly class?: string | undefined;
  /** The door's signed outcome token from its answer, as it came. */
  readonly token?: string | undefined;
}

/** What the network answered one call: each report accepted or ignored, by its index in the call. */
export interface DoorReportsAnswer {
  readonly accepted: readonly { readonly i: number; readonly proof: string; readonly counts: string }[];
  readonly ignored: readonly { readonly i: number; readonly why: string }[];
  readonly next: string;
}

export interface DoorReporterOptions {
  /** The network: its host, its https origin, or a key or pass it issued. */
  readonly network: string;
  readonly fetch?: typeof fetch | undefined;
  /** Sign each call sdi-agent/1 with your own key. Unsigned without it, which is fine. */
  readonly key?: AgentKeyInput | undefined;
  /** With `key`, the Web Bot Auth platform whose directory lists it. */
  readonly platform?: string | undefined;
  /** Send on its own: when a batch is full, and a few seconds after the first report waits. On by default. */
  readonly autoFlush?: boolean | undefined;
  /** Reports per call, 1 to 100; 100 by default. */
  readonly batchSize?: number | undefined;
  /** How long a report waits for others before it is sent, in milliseconds; 5000 by default. */
  readonly flushAfterMs?: number | undefined;
  /** Called with what went wrong sending a batch in the background; nothing by default. */
  readonly onError?: ((error: unknown) => void) | undefined;
  /** Milliseconds since the epoch; the clock by default. */
  readonly now?: (() => number) | undefined;
}

/** At most this many reports wait; past it the oldest are dropped. */
export const MAX_PENDING_DOOR_REPORTS = 1000;
const MAX_BATCH = 100;
const RESULTS: readonly DoorResult[] = ["ok", "refused", "invalid", "fail", "info"];

/** 16 random base64url characters: one per attempt, kept for all its retries so it counts once. */
export function newIntent(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(12)));
}

/** A queue of door reports for one network, sent in batches. */
export class DoorReporter {
  readonly #opts: DoorReporterOptions;
  readonly #url: string;
  readonly #batch: number;
  readonly #wait: number;
  #queue: Record<string, unknown>[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #sending: Promise<void> = Promise.resolve();

  constructor(opts: DoorReporterOptions) {
    this.#opts = opts;
    this.#url = `${networkUrl(opts.network)}/v1/door-reports`;
    this.#batch = Math.min(MAX_BATCH, Math.max(1, Math.floor(opts.batchSize ?? MAX_BATCH)));
    this.#wait = Math.max(0, opts.flushAfterMs ?? 5000);
  }

  /** Reports waiting to be sent. */
  get pending(): number {
    return this.#queue.length;
  }

  /**
   * Queues one report and returns its intent. Throws a TypeError for a report the network would refuse
   * whole, so a mistake shows where it is made rather than in a batch later.
   */
  report(input: DoorReportInput): string {
    const report = doorReportBody(input, this.#opts.now?.() ?? Date.now());
    this.#queue.push(report);
    if (this.#queue.length > MAX_PENDING_DOOR_REPORTS)
      this.#queue.splice(0, this.#queue.length - MAX_PENDING_DOOR_REPORTS);
    if (this.#opts.autoFlush !== false) {
      if (this.#queue.length >= this.#batch) this.#background();
      else this.#schedule();
    }
    return report.intent as string;
  }

  /**
   * Sends everything waiting, a batch per call, and answers the last call's answer (null when nothing
   * waited). A batch the network could not take now (no answer, 429, 5xx) goes back in the queue; one it
   * refused whole (400, 413) is dropped and the error thrown.
   */
  flush(): Promise<DoorReportsAnswer | null> {
    this.#clear();
    let last: DoorReportsAnswer | null = null;
    const run = this.#sending.then(async () => {
      while (this.#queue.length > 0) {
        const batch = this.#queue.splice(0, this.#batch);
        try {
          last = await this.#send(batch);
        } catch (error) {
          if (!(error instanceof NetworkCallError) || error.status === 429 || error.status >= 500) {
            this.#queue.unshift(...batch);
          }
          throw error;
        }
      }
    });
    this.#sending = run.catch(() => undefined);
    return run.then(() => last);
  }

  #background(): void {
    this.flush().catch((error: unknown) => {
      this.#opts.onError?.(error);
      if (this.#queue.length > 0 && this.#opts.autoFlush !== false) this.#schedule(Math.max(this.#wait, 30_000));
    });
  }

  #schedule(ms: number = this.#wait): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#background();
    }, ms);
    // On Node, a waiting report does not keep the process alive: call flushDoorReports() before exit.
    (this.#timer as { unref?: () => void }).unref?.();
  }

  #clear(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #send(reports: Record<string, unknown>[]): Promise<DoorReportsAnswer> {
    const body = JSON.stringify({ v: 1, reports });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const signed = this.#opts.key
      ? (
          await signRequest({
            method: "POST",
            url: this.#url,
            body,
            key: this.#opts.key,
            headers,
            ...(this.#opts.platform ? { platform: this.#opts.platform } : {}),
          })
        ).headers
      : headers;
    const res = await (this.#opts.fetch ?? fetch)(this.#url, {
      method: "POST",
      body,
      headers: { accept: "application/json", ...signed },
      redirect: "manual",
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (res.status < 200 || res.status >= 300) {
      const p = (parsed ?? {}) as { code?: unknown; detail?: unknown; title?: unknown };
      const detail =
        typeof p.detail === "string" ? p.detail : typeof p.title === "string" ? p.title : `HTTP ${res.status}`;
      throw new NetworkCallError(res.status, typeof p.code === "string" ? p.code : null, detail);
    }
    const a = (parsed ?? {}) as Partial<DoorReportsAnswer>;
    return {
      accepted: Array.isArray(a.accepted) ? a.accepted : [],
      ignored: Array.isArray(a.ignored) ? a.ignored : [],
      next: typeof a.next === "string" ? a.next : "",
    };
  }
}

const shared = new Map<string, DoorReporter>();

/**
 * Queues one report for `network` and sends it with others on its own, in batches; answers its intent.
 * One queue per network, shared by every call. Pass `key` to sign, `fetch` to send through your own;
 * the first call for a network sets them.
 */
export function reportDoor(
  input: DoorReportInput &
    Pick<DoorReporterOptions, "network" | "fetch" | "key" | "platform" | "onError" | "flushAfterMs">,
): string {
  const origin = networkUrl(input.network);
  let reporter = shared.get(origin);
  if (!reporter) {
    reporter = new DoorReporter({
      network: origin,
      fetch: input.fetch,
      key: input.key,
      platform: input.platform,
      onError: input.onError,
      flushAfterMs: input.flushAfterMs,
    });
    shared.set(origin, reporter);
  }
  return reporter.report(input);
}

/** Sends every report `reportDoor()` queued, to every network: for a Worker's `waitUntil`, or before exit. */
export async function flushDoorReports(): Promise<void> {
  const results = await Promise.allSettled([...shared.values()].map((r) => r.flush()));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

/** The report as the network takes it, checked as the network checks it; a TypeError says what is wrong. */
export function doorReportBody(input: DoorReportInput, nowMs: number = Date.now()): Record<string, unknown> {
  const bad = (why: string): never => {
    throw new TypeError(`door report: ${why}`);
  };
  if (typeof input.domain !== "string" || !/^[a-z0-9.-]{1,253}$/.test(input.domain)) {
    bad("domain is the business's domain, lowercase, as the listing gave it");
  }
  const door = input.door ?? bad("door is {type, url}, as the listing gave it");
  if (typeof door.type !== "string" || !/^[a-z0-9:_-]{1,48}$/.test(door.type)) bad("door.type is the listing's");
  if (
    typeof door.url !== "string" ||
    !door.url.startsWith("https://") ||
    door.url.length > 2048 ||
    /[?#]/.test(door.url)
  ) {
    bad("door.url is the listing's https URL, with no query or fragment");
  }
  if (typeof input.op !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(input.op))
    bad("op is from the capability vocabulary, like book");
  const tool = input.tool === undefined ? undefined : String(input.tool).toLowerCase();
  if (tool !== undefined && !/^[a-z0-9_.-]{1,64}$/.test(tool)) bad("tool is at most 64 of a-z, 0-9, _, . and -");
  const at = input.at ?? Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(at) || at < 0) bad("at is Unix seconds");
  if (input.ms !== undefined && (!Number.isSafeInteger(input.ms) || input.ms < 0 || input.ms > 600_000)) {
    bad("ms is 0 to 600000");
  }
  const intent = input.intent ?? newIntent();
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(intent)) bad("intent is 8 to 32 base64url characters");
  if (!RESULTS.includes(input.result)) bad(`result is one of ${RESULTS.join(", ")}`);
  if (input.result === "ok" ? input.class !== undefined : !/^[a-z0-9_.]{1,64}$/.test(input.class ?? "")) {
    bad("class is required, from vocab/door-report-classes.json, unless result is ok, which takes none");
  }
  if (input.token !== undefined && (input.token.length > 1024 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(input.token))) {
    bad("token is the door's compact JWS, at most 1024 characters, as it came");
  }
  return {
    domain: input.domain,
    door: { type: door.type, url: door.url },
    op: input.op,
    ...(tool === undefined ? {} : { tool }),
    at,
    ...(input.ms === undefined ? {} : { ms: input.ms }),
    intent,
    result: input.result,
    ...(input.class === undefined ? {} : { class: input.class }),
    ...(input.token === undefined ? {} : { token: input.token }),
  };
}
