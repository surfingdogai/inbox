import { parseCredential } from "./credentials.js";
import { b64u } from "./encoding.js";
import type { AgentKeyInput } from "./keys.js";
import { NetworkCallError, networkUrl, retryAfterMs } from "./network.js";
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
 * Reports go only to a network that issued the person's key or pass (name it by that key or pass, or
 * pass the key or pass as `credential`), or to the default network, DEFAULT_REPORT_NETWORK; any other
 * network throws unless you set `allowNetwork: true`, for a network you chose yourself. Never send them
 * to an address a business's manifest, a receipt or an answer suggests: that would tell a stranger
 * which doors you used, and when.
 *
 * A batch the network cannot take now (no answer in `timeoutMs`, 408, 429, a 5xx) waits and is sent
 * again: after the network's `Retry-After` when it gives one, else after 30 s, doubling to 15 min. Each
 * report keeps its intent, so a batch sent twice counts once. A report older than the 7 days a network
 * takes is dropped before it is sent. While a batch waits so, new reports only queue: nothing is sent
 * before the wait is over unless you call `flush()`. Signed reports (`key`, `platform`) also earn the
 * signer points toward a larger reading allowance at the network (`reporterCredit`, protocol §4.15).
 */

/** The network reports go to without a key, a pass or `allowNetwork`: the one this library is published with. */
export const DEFAULT_REPORT_NETWORK = "network.surfingdog.ai";

export type DoorResult = "ok" | "refused" | "invalid" | "fail" | "info";

/** The classes of `vocab/door-report-classes.json` (spec 0.4), by the result each goes with. */
export const FAIL_CLASSES = [
  "dns.name_not_resolved",
  "dns.failed",
  "tcp.timed_out",
  "tcp.refused",
  "tcp.reset",
  "tls.cert.invalid",
  "tls.failed",
  "http.error",
  "http.response.invalid",
  "abandoned",
  "timeout",
  "operation.timeout",
  "protocol.internal",
  "protocol.advertised_missing",
  "protocol.version",
  "protocol.invalid_answer",
  "operation.tool_error",
  "operation.failed",
  "operation.internal",
  "payment_failed",
] as const;
export const REFUSED_CLASSES = [
  "slot_taken",
  "out_of_stock",
  "item_unavailable",
  "outside_limits",
  "wrong_state",
  "customer_side",
] as const;
export const INVALID_CLASSES = [
  "client.invalid_params",
  "client.parse_error",
  "client.invalid_request",
  "client.mcp_headers",
  "client.mcp_refused",
  "client.http",
  "client.rate_limited",
] as const;
export const INFO_CLASSES = ["escalation", "auth", "person"] as const;
export type FailClass = (typeof FAIL_CLASSES)[number];
export type RefusedClass = (typeof REFUSED_CLASSES)[number];
export type InvalidClass = (typeof INVALID_CLASSES)[number];
export type InfoClass = (typeof INFO_CLASSES)[number];
export type DoorClass = FailClass | RefusedClass | InvalidClass | InfoClass;

/** How one use of a door went: a result, and the class every result but `ok` carries. */
export type DoorOutcome =
  | { readonly result: "ok"; readonly class?: undefined }
  | { readonly result: "refused"; readonly class: RefusedClass }
  | { readonly result: "invalid"; readonly class: InvalidClass }
  | { readonly result: "fail"; readonly class: FailClass }
  | { readonly result: "info"; readonly class: InfoClass };

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
  /**
   * The network: its host, its https origin, or a key or pass it issued. Only one that issued the
   * person's key or pass, or the default network, unless `allowNetwork`.
   */
  readonly network: string;
  /** A key or pass of the person's: the network that issued it may take your reports. */
  readonly credential?: string | undefined;
  /**
   * true: you chose this network yourself. Never set it for a network a business's manifest, a
   * receipt or an answer named.
   */
  readonly allowNetwork?: boolean | undefined;
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
  /** How long one call to the network may take, in milliseconds; 10000 by default. */
  readonly timeoutMs?: number | undefined;
  /** Milliseconds since the epoch; the clock by default. */
  readonly now?: (() => number) | undefined;
}

/** At most this many reports wait; past it the oldest are dropped. */
export const MAX_PENDING_DOOR_REPORTS = 1000;
const MAX_BATCH = 100;
const RESULTS: readonly DoorResult[] = ["ok", "refused", "invalid", "fail", "info"];
/** A network takes a report up to 7 days old; one older than this is dropped before it is sent. */
const MAX_AGE_S = 7 * 86_400 - 60;
/** A batch that could not be sent waits this long, doubling with each failure, at most RETRY_MAX_MS. */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;

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
  /** Background sends that failed in a row, and the wait the network last asked for. */
  #failures = 0;
  #retryAfter: number | null = null;
  /** No background send before this (milliseconds since the epoch): the wait after a failed one. */
  #notBefore = 0;

  constructor(opts: DoorReporterOptions) {
    this.#opts = opts;
    this.#url = `${reportNetwork(opts)}/v1/door-reports`;
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
    const report = doorReportBody(input, this.#now());
    this.#queue.push(report);
    if (this.#queue.length > MAX_PENDING_DOOR_REPORTS)
      this.#queue.splice(0, this.#queue.length - MAX_PENDING_DOOR_REPORTS);
    if (this.#opts.autoFlush !== false) {
      // A full batch goes at once, unless the network asked us to wait: then it waits with the rest.
      if (this.#queue.length >= this.#batch && this.#now() >= this.#notBefore) this.#background();
      else this.#schedule();
    }
    return report.intent as string;
  }

  /**
   * Sends everything waiting, a batch per call, and answers the last call's answer (null when nothing
   * waited). A batch the network could not take now (no answer in time, 408, 429, 5xx) goes back in the
   * queue; one it refused whole (400, 413) is dropped and the error thrown. Reports older than a network
   * takes are dropped first.
   */
  flush(): Promise<DoorReportsAnswer | null> {
    this.#clear();
    let last: DoorReportsAnswer | null = null;
    const run = this.#sending.then(async () => {
      const oldest = Math.floor(this.#now() / 1000) - MAX_AGE_S;
      this.#queue = this.#queue.filter((r) => (r.at as number) >= oldest);
      while (this.#queue.length > 0) {
        const batch = this.#queue.splice(0, this.#batch);
        try {
          last = await this.#send(batch);
          this.#failures = 0;
          this.#retryAfter = null;
          this.#notBefore = 0;
        } catch (error) {
          if (retryable(error)) {
            this.#queue.unshift(...batch);
            this.#retryAfter = error instanceof NetworkCallError ? error.retryAfterMs : null;
          }
          throw error;
        }
      }
    });
    this.#sending = run.catch(() => undefined);
    return run.then(() => last);
  }

  /** How long the next background send waits after `failures` failures in a row. */
  #backoff(failures: number): number {
    const doubling = Math.min(RETRY_MAX_MS, Math.max(this.#wait, RETRY_BASE_MS) * 2 ** Math.max(0, failures - 1));
    // Up to a fifth less, so that many agents that failed together do not retry together.
    const jittered = doubling - Math.floor(Math.random() * doubling * 0.2);
    // The network's own Retry-After wins, however long (up to a day).
    return Math.max(Math.min(RETRY_MAX_MS, jittered), Math.min(this.#retryAfter ?? 0, 86_400_000));
  }

  #background(): void {
    this.flush().catch((error: unknown) => {
      this.#opts.onError?.(error);
      if (this.#queue.length > 0 && this.#opts.autoFlush !== false) {
        this.#failures++;
        const wait = this.#backoff(this.#failures);
        this.#notBefore = this.#now() + wait;
        this.#schedule(wait);
      }
    });
  }

  /** Sends in ms (or when the network's wait is over, whichever is later), unless a send is set already. */
  #schedule(ms: number = this.#wait): void {
    if (this.#timer !== null) return;
    ms = Math.max(ms, this.#notBefore - this.#now());
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#background();
    }, ms);
    // On Node, a waiting report does not keep the process alive: call flushDoorReports() before exit.
    (this.#timer as { unref?: () => void }).unref?.();
  }

  #now(): number {
    return this.#opts.now?.() ?? Date.now();
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
      signal: AbortSignal.timeout(Math.max(1, this.#opts.timeoutMs ?? 10_000)),
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
      throw new NetworkCallError(
        res.status,
        typeof p.code === "string" ? p.code : null,
        detail,
        retryAfterMs(res.headers.get("retry-after")),
      );
    }
    const a = (parsed ?? {}) as Partial<DoorReportsAnswer>;
    return {
      accepted: Array.isArray(a.accepted) ? a.accepted : [],
      ignored: Array.isArray(a.ignored) ? a.ignored : [],
      next: typeof a.next === "string" ? a.next : "",
    };
  }
}

/**
 * The origin reports for opts go to: a network that issued the person's key or pass (named by it, or
 * given as `credential`), the default network, or one the caller chose (`allowNetwork`). A TypeError
 * for any other.
 */
export function reportNetwork(opts: Pick<DoorReporterOptions, "network" | "credential" | "allowNetwork">): string {
  const origin = networkUrl(opts.network);
  const host = origin.slice("https://".length);
  const issuedBy = (s: string | undefined) => (s ? parseCredential(s)?.host : undefined);
  if (
    opts.allowNetwork === true ||
    host === DEFAULT_REPORT_NETWORK ||
    issuedBy(opts.network) === host ||
    issuedBy(opts.credential) === host
  ) {
    return origin;
  }
  throw new TypeError(
    `door reports go only to a network that issued the person's key or pass, or to ${DEFAULT_REPORT_NETWORK}: pass credential, or allowNetwork: true for a network you chose yourself (never one a business named)`,
  );
}

/** Whether a failed send may succeed later: no answer at all (or none in time), or 408, 429, 5xx. */
function retryable(error: unknown): boolean {
  if (!(error instanceof NetworkCallError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

const shared = new Map<string, DoorReporter>();

/**
 * Queues one report for `network` and sends it with others on its own, in batches; answers its intent.
 * One queue per network, signing key and platform, shared by every call with the same three, so one
 * user's key never signs another's reports. Pass `key` to sign, `fetch` to send through your own; the
 * first call for a queue sets them.
 */
export function reportDoor(
  input: DoorReportInput &
    Pick<
      DoorReporterOptions,
      | "network"
      | "credential"
      | "allowNetwork"
      | "fetch"
      | "key"
      | "platform"
      | "onError"
      | "flushAfterMs"
      | "timeoutMs"
    >,
): string {
  const origin = reportNetwork(input);
  const queue = `${origin}|${input.key?.privateJwk.x ?? ""}|${input.platform ?? ""}`;
  let reporter = shared.get(queue);
  if (!reporter) {
    reporter = new DoorReporter({
      network: origin,
      allowNetwork: true, // checked above
      fetch: input.fetch,
      key: input.key,
      platform: input.platform,
      onError: input.onError,
      flushAfterMs: input.flushAfterMs,
      timeoutMs: input.timeoutMs,
    });
    shared.set(queue, reporter);
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

/** What a network allows a reader, requests a minute and the burst, and what it is counted per. */
export interface ReadAllowance {
  readonly per_minute: number;
  readonly burst: number;
  readonly per: "address" | "key" | "platform";
  /** A contributor's: the most of its kind's reads from one address. */
  readonly per_address?: number | undefined;
}

/**
 * `GET /v1/door-reports/me` (schema `door-reporter`): your own reporting credit at a network, and what you
 * read with there.
 */
export interface DoorReporterAnswer {
  readonly reporter:
    | { readonly type: "key"; readonly keyid: string }
    | { readonly type: "platform"; readonly origin: string; readonly platform: string };
  /** Over the last `threshold.window_days` days: your points (1 per business, once a day) and the days that earned any. */
  readonly credit: { readonly points: number; readonly days: number };
  readonly contributor: boolean;
  /** The rule: `min_points` points on `min_days` days in the last `window_days`, at most `per_day_at_most` a day. */
  readonly threshold: {
    readonly window_days: number;
    readonly min_days: number;
    readonly min_points: number;
    readonly per_day_at_most: number;
  };
  /** What your signed reads count against now. */
  readonly reads: ReadAllowance;
  /** What a contributor of your kind reads with. */
  readonly contributor_reads: ReadAllowance;
  readonly rule: string;
  readonly as_of: string;
}

/**
 * Your own reporting credit at a network (`GET /v1/door-reports/me`, protocol §4.15), signed with your
 * key (sdi-agent/1) or as your platform (Web Bot Auth, with `platform`): how many points your signed
 * reports earned in the last 30 days, whether that makes you a contributor, and what your signed reads
 * count against. The network checks the signature before it looks anything up, so nobody can ask about
 * anyone else. The default network unless you name one.
 */
export async function reporterCredit(opts: {
  readonly key: AgentKeyInput;
  readonly network?: string | undefined;
  readonly platform?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly now?: number | undefined;
}): Promise<DoorReporterAnswer> {
  const url = `${networkUrl(opts.network ?? DEFAULT_REPORT_NETWORK)}/v1/door-reports/me`;
  const signed = await signRequest({
    method: "GET",
    url,
    key: opts.key,
    headers: { accept: "application/json" },
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  const res = await (opts.fetch ?? fetch)(url, {
    method: "GET",
    headers: signed.headers,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (res.status !== 200) {
    const p = (parsed ?? {}) as { code?: unknown; detail?: unknown };
    throw new NetworkCallError(
      res.status,
      typeof p.code === "string" ? p.code : null,
      typeof p.detail === "string" ? p.detail : `HTTP ${res.status}`,
      retryAfterMs(res.headers.get("retry-after")),
    );
  }
  const r = parsed as Partial<DoorReporterAnswer> | null;
  if (!r || typeof r.contributor !== "boolean" || !r.credit || !r.reads || !r.threshold) {
    throw new NetworkCallError(502, null, "the network's answer is not a reporter's credit");
  }
  return r as DoorReporterAnswer;
}
