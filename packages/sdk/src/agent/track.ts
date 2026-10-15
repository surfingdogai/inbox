import {
  type DoorOutcome,
  type DoorReporter,
  type DoorReporterOptions,
  type DoorReportInput,
  newIntent,
  reportDoor,
} from "./doors.js";

/**
 * `trackDoor` wraps one use of a business's door and reports how it went, so an agent reports every
 * use without writing the report itself:
 *
 *   const result = await trackDoor(
 *     { network: "network.surfingdog.ai", domain: "bakery.example",
 *       door: { type: "mcp", url: "https://bakery.example/mcp" }, op: "book", tool: "create_booking" },
 *     () => client.callTool({ name: "create_booking", arguments }),
 *   );
 *
 * It times the call, reads the outcome from what came back or what was thrown (`classifyDoorAnswer`,
 * `classifyDoorError`), takes the door's signed outcome token when the answer carries one
 * (`doorTokenOf`, experimental: no door signs yet), and queues the report (`reportDoor`). The call's result comes back untouched, and
 * what it threw is thrown again. Reporting never fails the call: a report that cannot be made is passed
 * to `onError`. What is reported is the door's machine outcome only: never the arguments, the answer,
 * or anything about the person.
 */

export interface TrackDoorOptions
  extends Pick<
    DoorReporterOptions,
    "network" | "credential" | "allowNetwork" | "fetch" | "key" | "platform" | "onError" | "flushAfterMs" | "timeoutMs"
  > {
  /**
   * Your own reading of an answer, or of what was thrown: an outcome to report, null to report nothing,
   * or undefined to leave it to `classifyDoorAnswer` and `classifyDoorError`.
   */
  readonly outcome?: ((answer: unknown, thrown: boolean) => DoorOutcome | null | undefined) | undefined;
  /** Where your door puts its outcome token; `doorTokenOf` (experimental: no door signs yet) by default. */
  readonly tokenOf?: ((answer: unknown) => string | undefined) | undefined;
  /**
   * Experimental (no door signs yet): called with a door's outcome token when an answer carries one.
   * Keep it: it is your proof of what the business answered, and the report carries it too.
   */
  readonly onToken?:
    | ((token: string, use: { domain: string; door: DoorReportInput["door"]; op: string; intent: string }) => void)
    | undefined;
  /** Report through this queue instead of `reportDoor`'s shared one. */
  readonly reporter?: DoorReporter | undefined;
  /** Milliseconds since the epoch; the clock by default. */
  readonly now?: (() => number) | undefined;
}

export type TrackDoorInput = Omit<DoorReportInput, "result" | "class" | "ms" | "at" | "token"> & TrackDoorOptions;

/**
 * Runs `call`, one use of a door, and reports how it went. Pass the same `intent` to every retry of one
 * attempt, so it counts once and its last outcome wins. An outcome that is not the door's (your own
 * code threw, or you cancelled) is not reported.
 */
export async function trackDoor<T>(input: TrackDoorInput, call: () => Promise<T>): Promise<T> {
  const now = input.now ?? Date.now;
  const intent = input.intent ?? newIntent();
  const started = now();
  let answer: unknown;
  let thrown = false;
  try {
    answer = await call();
  } catch (error) {
    answer = error;
    thrown = true;
  }
  const ms = Math.max(0, Math.min(600_000, Math.round(now() - started)));
  try {
    // Your own reading first: null says it is not the door's to report, undefined leaves it to ours.
    const own = input.outcome?.(answer, thrown);
    const outcome = own !== undefined ? own : thrown ? classifyDoorError(answer) : await classifyDoorAnswer(answer);
    if (outcome) {
      const token = thrown ? undefined : (input.tokenOf ?? doorTokenOf)(answer);
      if (token) input.onToken?.(token, { domain: input.domain, door: input.door, op: input.op, intent });
      const report: DoorReportInput = {
        domain: input.domain,
        door: input.door,
        op: input.op,
        tool: input.tool,
        at: Math.floor(started / 1000),
        ms,
        intent,
        result: outcome.result,
        class: outcome.class,
        token,
      };
      if (input.reporter) input.reporter.report(report);
      else reportDoor({ ...input, ...report });
    }
  } catch (error) {
    input.onError?.(error);
  }
  if (thrown) throw answer;
  return answer as T;
}

/* --- reading an outcome ------------------------------------------------------------------------------------------- */

/** JSON-RPC, MCP and A2A error codes, as vocab/door-report-classes.json maps them. */
const RPC_CODES: Record<number, DoorOutcome> = {
  [-32602]: { result: "invalid", class: "client.invalid_params" },
  [-32700]: { result: "invalid", class: "client.parse_error" },
  [-32600]: { result: "invalid", class: "client.invalid_request" },
  [-32601]: { result: "fail", class: "protocol.advertised_missing" },
  [-32603]: { result: "fail", class: "protocol.internal" },
  [-32020]: { result: "invalid", class: "client.mcp_headers" },
  [-32021]: { result: "invalid", class: "client.mcp_refused" },
  [-32022]: { result: "fail", class: "protocol.version" },
  [-32004]: { result: "fail", class: "protocol.advertised_missing" },
  [-32009]: { result: "fail", class: "protocol.version" },
  // MCP's URL elicitation: the person has to act at an address the door gives.
  [-32042]: { result: "info", class: "person" },
};

/**
 * What the MCP TypeScript SDK throws on its own side, never a door's answer: ConnectionClosed and
 * RequestTimeout. In a door's JSON-RPC answer these codes are the door's own errors.
 */
const SDK_CODES: Record<number, DoorOutcome> = {
  [-32000]: { result: "fail", class: "abandoned" },
  [-32001]: { result: "fail", class: "timeout" },
};

/**
 * The problem codes of a Surfing Dog Inbox door (and any door that uses the same words): the honest
 * refusals, the caller's own faults, a person needed, the door's own error. Another door's codes fall
 * back on the HTTP status.
 */
const PROBLEM_CODES: Record<string, DoorOutcome> = {
  slot_taken: { result: "refused", class: "slot_taken" },
  out_of_stock: { result: "refused", class: "out_of_stock" },
  item_unavailable: { result: "refused", class: "item_unavailable" },
  outside_limits: { result: "refused", class: "outside_limits" },
  wrong_state: { result: "refused", class: "wrong_state" },
  guard_failed: { result: "refused", class: "wrong_state" },
  no_offer: { result: "refused", class: "wrong_state" },
  offer_expired: { result: "refused", class: "wrong_state" },
  offer_changed: { result: "refused", class: "wrong_state" },
  payment_declined: { result: "refused", class: "customer_side" },
  eligibility_invalid: { result: "refused", class: "customer_side" },
  address_undeliverable: { result: "refused", class: "customer_side" },
  invalid_input: { result: "invalid", class: "client.invalid_params" },
  unknown_event: { result: "invalid", class: "client.invalid_params" },
  idempotency_mismatch: { result: "invalid", class: "client.invalid_params" },
  version_conflict: { result: "invalid", class: "client.http" },
  not_found: { result: "invalid", class: "client.http" },
  not_allowed: { result: "invalid", class: "client.http" },
  too_many_attempts: { result: "invalid", class: "client.rate_limited" },
  rate_limited: { result: "invalid", class: "client.rate_limited" },
  confirm_terms: { result: "info", class: "person" },
  confirm_withdrawal: { result: "info", class: "person" },
  internal: { result: "fail", class: "operation.internal" },
};

/** An HTTP status as a door's outcome; undefined for one that says nothing (1xx, 3xx). */
function outcomeOfStatus(status: number): DoorOutcome | undefined {
  if (status >= 200 && status < 300) return { result: "ok" };
  if (status === 408) return { result: "fail", class: "timeout" };
  if (status === 429) return { result: "invalid", class: "client.rate_limited" };
  if (status >= 400 && status < 500) return { result: "invalid", class: "client.http" };
  if (status >= 500 && status < 600) return { result: "fail", class: "http.error" };
  return undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** A problem document's (or an MCP tool error's) outcome: its code when known, else its status. */
function outcomeOfProblem(p: Record<string, unknown>): DoorOutcome | undefined {
  const known = typeof p.code === "string" ? PROBLEM_CODES[p.code] : undefined;
  if (known) return known;
  if (typeof p.status === "number" && p.status >= 400) {
    return p.status >= 500 ? { result: "fail", class: "operation.failed" } : outcomeOfStatus(p.status);
  }
  return undefined;
}

/**
 * The outcome of a door's answer: a `Response` (its status; for an error with a JSON problem, its
 * code, read from a copy), a JSON-RPC answer (its error's code), an MCP tool result (`isError`, and an
 * Inbox door's problem in `structuredContent.error`), or a problem document. Anything else that came
 * back is `ok`: the door answered.
 */
export async function classifyDoorAnswer(answer: unknown): Promise<DoorOutcome | undefined> {
  if (answer instanceof Response) {
    // An error's problem document may say more than its status: read a copy, the answer stays unread.
    if (answer.status >= 400 && /json/i.test(answer.headers.get("content-type") ?? "")) {
      try {
        const text = await answer.clone().text();
        const body = text.length <= 65_536 ? (JSON.parse(text) as unknown) : undefined;
        const code = isObject(body) ? body.code : undefined;
        if (typeof code === "string" && PROBLEM_CODES[code]) return PROBLEM_CODES[code];
      } catch {
        // Not JSON after all: the status says it.
      }
    }
    return outcomeOfStatus(answer.status);
  }
  if (!isObject(answer)) return { result: "ok" };
  // A JSON-RPC answer: its error by its code (one the protocols do not name is the door's own), or its result.
  if (answer.jsonrpc === "2.0") {
    if (isObject(answer.error)) {
      const code = answer.error.code;
      return (typeof code === "number" ? RPC_CODES[code] : undefined) ?? { result: "fail", class: "operation.failed" };
    }
    return classifyDoorAnswer(answer.result);
  }
  // An MCP tool result.
  if (answer.isError === true) {
    const sc = answer.structuredContent;
    const problem = isObject(sc) && isObject(sc.error) ? outcomeOfProblem(sc.error) : undefined;
    return problem ?? { result: "fail", class: "operation.tool_error" };
  }
  // A problem document (RFC 9457).
  if (typeof answer.type === "string" && typeof answer.status === "number" && answer.status >= 400) {
    return outcomeOfProblem(answer);
  }
  return { result: "ok" };
}

/** Network failures by the codes runtimes give them (Node and undici, Bun, Deno), as NEL names them. */
const NET_CODES: Record<string, DoorOutcome> = {
  ENOTFOUND: { result: "fail", class: "dns.name_not_resolved" },
  EAI_NONAME: { result: "fail", class: "dns.name_not_resolved" },
  EAI_AGAIN: { result: "fail", class: "dns.failed" },
  EAI_FAIL: { result: "fail", class: "dns.failed" },
  ECONNREFUSED: { result: "fail", class: "tcp.refused" },
  ConnectionRefused: { result: "fail", class: "tcp.refused" },
  ECONNRESET: { result: "fail", class: "tcp.reset" },
  ConnectionReset: { result: "fail", class: "tcp.reset" },
  EPIPE: { result: "fail", class: "tcp.reset" },
  UND_ERR_SOCKET: { result: "fail", class: "tcp.reset" },
  ETIMEDOUT: { result: "fail", class: "tcp.timed_out" },
  UND_ERR_CONNECT_TIMEOUT: { result: "fail", class: "tcp.timed_out" },
  UND_ERR_HEADERS_TIMEOUT: { result: "fail", class: "timeout" },
  UND_ERR_BODY_TIMEOUT: { result: "fail", class: "timeout" },
  CERT_HAS_EXPIRED: { result: "fail", class: "tls.cert.invalid" },
  ERR_TLS_CERT_ALTNAME_INVALID: { result: "fail", class: "tls.cert.invalid" },
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: { result: "fail", class: "tls.cert.invalid" },
  DEPTH_ZERO_SELF_SIGNED_CERT: { result: "fail", class: "tls.cert.invalid" },
  SELF_SIGNED_CERT_IN_CHAIN: { result: "fail", class: "tls.cert.invalid" },
  EPROTO: { result: "fail", class: "tls.failed" },
};

/**
 * The outcome of what a use of a door threw, when it is the door's: a timeout (`TimeoutError`), a
 * network failure a runtime names (no such host, refused, reset, a bad certificate…), a JSON-RPC, MCP
 * or A2A error code (the MCP SDK's `McpError`), or an HTTP status on an error (`StreamableHTTPError`).
 * Undefined for anything else, a cancellation (`AbortError`) or a fault in your own code included: it
 * is not reported.
 */
export function classifyDoorError(error: unknown): DoorOutcome | undefined {
  if (!isObject(error)) return undefined;
  if (error.name === "TimeoutError") return { result: "fail", class: "timeout" };
  if (error.name === "AbortError") return undefined;
  if (typeof error.code === "number") {
    if (error.code < 0)
      return RPC_CODES[error.code] ?? SDK_CODES[error.code] ?? { result: "fail", class: "operation.failed" };
    if (error.code >= 400 && error.code < 600) return outcomeOfStatus(error.code);
  }
  for (const e of [error, error.cause]) {
    if (isObject(e) && typeof e.code === "string" && NET_CODES[e.code]) return NET_CODES[e.code];
    if (isObject(e) && typeof e.code === "string" && /^ERR_SSL_|^ERR_TLS_/.test(e.code)) {
      return { result: "fail", class: "tls.failed" };
    }
  }
  // Workers say a lost connection in words only.
  if (error instanceof TypeError && /network connection lost|connection (was )?reset/i.test(error.message)) {
    return { result: "fail", class: "tcp.reset" };
  }
  return undefined;
}

/* --- the door's token -------------------------------------------------------------------------------------------- */

const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Experimental: no door signs its answers yet, and the protocol does not publish where a door's token
 * goes. This reads the two places the SDK expects one (the `Sdi-Door` header of a `Response`, or an MCP
 * result's `_meta["ai.surfingdog/door"]`) and may change when the token is specified. A compact JWS of
 * at most 1 KB, as it came, or nothing.
 */
export function doorTokenOf(answer: unknown): string | undefined {
  let t: unknown;
  if (answer instanceof Response) t = answer.headers.get("sdi-door");
  else if (isObject(answer)) {
    const meta = isObject(answer.result) && isObject(answer.result._meta) ? answer.result._meta : answer._meta;
    t = isObject(meta) ? meta["ai.surfingdog/door"] : undefined;
  }
  return typeof t === "string" && t.length <= 1024 && TOKEN_RE.test(t) ? t : undefined;
}
