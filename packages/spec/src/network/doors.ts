import { z } from "zod";
import { capabilityIdSchema } from "./capabilities";
import { timestampSchema } from "./common";

/**
 * Door reports (`docs/protocol/network.md` §4.15) and the network's own reads of a door (§4.8): what
 * an agent tells a network about one use of a business's door, done or not; how the network reads
 * such a body; what each report may lead to; and how the network's own reads move a door between
 * live, failing and gone. A report measures a machine (did the door answer, was the operation done,
 * refused or failed, did it need a person), never a person and never a promise (ADR-019).
 * `vectors/door-reports.json` pins every rule here down.
 */

/* --- results and classes ------------------------------------------------------------------------------------------ */

/**
 * How one use of a door went: `ok` it did what was asked; `refused` an honest no (the slot was taken),
 * which is the door working; `invalid` the agent's own fault (bad input, an unknown id, no access, a
 * rate limit); `fail` the door's fault, or no answer at all; `info` it needs a person.
 */
export const DOOR_REPORT_RESULTS = ["ok", "refused", "invalid", "fail", "info"] as const;
export const doorReportResultSchema = z.enum(DOOR_REPORT_RESULTS);
export type DoorReportResult = z.infer<typeof doorReportResultSchema>;

/** Where along a use the class sits, which decides what a report of it can do (§4.15). */
export const DOOR_REPORT_PHASES = ["reach", "protocol", "operation", "needs_human", "client"] as const;
export const doorReportPhaseSchema = z.enum(DOOR_REPORT_PHASES);
export type DoorReportPhase = z.infer<typeof doorReportPhaseSchema>;

export interface DoorReportClass {
  readonly id: string;
  readonly phase: DoorReportPhase;
  /** The one result a report of this class carries. */
  readonly result: Exclude<DoorReportResult, "ok">;
  readonly says: string;
  /** The JSON-RPC, MCP or A2A error codes, or the HTTP statuses, that mean this class. */
  readonly jsonrpc?: readonly number[];
  readonly mcp?: readonly number[];
  readonly a2a?: readonly number[];
  readonly http?: string;
}

/**
 * Every class an agent may report, reused and never invented: the reach names are W3C Network Error
 * Logging's (`dns.name_not_resolved` …), the protocol ones map JSON-RPC, MCP and A2A codes, and the
 * operation ones are the typed refusals and failures doors already answer.
 */
export const DOOR_REPORT_CLASSES: readonly DoorReportClass[] = [
  { id: "dns.name_not_resolved", phase: "reach", result: "fail", says: "The door's host name did not resolve." },
  { id: "dns.failed", phase: "reach", result: "fail", says: "The name lookup failed for another reason." },
  { id: "tcp.timed_out", phase: "reach", result: "fail", says: "The connection timed out." },
  { id: "tcp.refused", phase: "reach", result: "fail", says: "The connection was refused." },
  { id: "tcp.reset", phase: "reach", result: "fail", says: "The connection was reset." },
  { id: "tls.cert.invalid", phase: "reach", result: "fail", says: "The certificate was not valid for the host." },
  { id: "tls.failed", phase: "reach", result: "fail", says: "The secure connection failed for another reason." },
  {
    id: "http.error",
    phase: "reach",
    result: "fail",
    says: "The door answered with a server error (5xx).",
    http: "5xx",
  },
  { id: "http.response.invalid", phase: "reach", result: "fail", says: "The answer was not valid HTTP." },
  { id: "abandoned", phase: "reach", result: "fail", says: "The answer stopped before it was complete." },
  { id: "timeout", phase: "reach", result: "fail", says: "No answer in time.", http: "408" },
  { id: "operation.timeout", phase: "reach", result: "fail", says: "The operation started and never finished." },
  {
    id: "protocol.internal",
    phase: "protocol",
    result: "fail",
    says: "The door answered an internal error.",
    jsonrpc: [-32603],
  },
  {
    id: "protocol.advertised_missing",
    phase: "protocol",
    result: "fail",
    says: "A method or tool the door advertises was not found.",
    jsonrpc: [-32601],
    a2a: [-32004],
  },
  {
    id: "protocol.version",
    phase: "protocol",
    result: "fail",
    says: "The door refused the protocol version it advertises.",
    mcp: [-32022],
    a2a: [-32009],
  },
  {
    id: "protocol.invalid_answer",
    phase: "protocol",
    result: "fail",
    says: "The answer did not follow the door's own protocol.",
  },
  { id: "operation.tool_error", phase: "operation", result: "fail", says: "The tool answered with an error." },
  { id: "operation.failed", phase: "operation", result: "fail", says: "The operation failed at the door." },
  { id: "operation.internal", phase: "operation", result: "fail", says: "The operation hit the door's own error." },
  { id: "payment_failed", phase: "operation", result: "fail", says: "The door's payment step failed." },
  { id: "slot_taken", phase: "operation", result: "refused", says: "The time asked for was taken." },
  { id: "out_of_stock", phase: "operation", result: "refused", says: "What was asked for is out of stock." },
  { id: "item_unavailable", phase: "operation", result: "refused", says: "What was asked for is not offered now." },
  { id: "outside_limits", phase: "operation", result: "refused", says: "Outside what the business takes." },
  { id: "wrong_state", phase: "operation", result: "refused", says: "Not possible in the item's current state." },
  {
    id: "customer_side",
    phase: "operation",
    result: "refused",
    says: "Refused for a reason on the customer's side (a declined payment, an address, eligibility).",
  },
  { id: "escalation", phase: "needs_human", result: "info", says: "The door handed the request to a person." },
  { id: "auth", phase: "needs_human", result: "info", says: "The door needs the person to sign in." },
  { id: "person", phase: "needs_human", result: "info", says: "The door needs the person to act (3-D Secure)." },
  {
    id: "client.invalid_params",
    phase: "client",
    result: "invalid",
    says: "The agent sent arguments the tool cannot take.",
    jsonrpc: [-32602],
  },
  {
    id: "client.parse_error",
    phase: "client",
    result: "invalid",
    says: "The agent sent JSON that does not parse.",
    jsonrpc: [-32700],
  },
  {
    id: "client.invalid_request",
    phase: "client",
    result: "invalid",
    says: "The agent sent a request that is not valid JSON-RPC.",
    jsonrpc: [-32600],
  },
  {
    id: "client.mcp_headers",
    phase: "client",
    result: "invalid",
    says: "An MCP header the request needs was missing or disagreed with the body.",
    mcp: [-32020],
  },
  {
    id: "client.mcp_refused",
    phase: "client",
    result: "invalid",
    says: "The MCP server refused what the request declared.",
    mcp: [-32021],
  },
  {
    id: "client.http",
    phase: "client",
    result: "invalid",
    says: "The door answered 4xx, other than 408 and 429.",
    http: "4xx",
  },
  { id: "client.rate_limited", phase: "client", result: "invalid", says: "The door asked to slow down.", http: "429" },
];

/** Classes only a network works out from its own reads; an agent never reports them. */
export const NETWORK_ONLY_DOOR_CLASSES = ["protocol.unsigned_answer", "protocol.signed_mismatch"] as const;

const CLASS_BY_ID = new Map(DOOR_REPORT_CLASSES.map((c) => [c.id, c]));

/** A class by its id, or undefined for one an agent may not report. */
export function doorReportClass(id: string): DoorReportClass | undefined {
  return CLASS_BY_ID.get(id);
}

/** `vocab/door-report-classes.json`: the results, the phases and what each can do, and every class. */
export const doorReportClassesVocabSchema = z.object({
  version: z.int().min(1),
  name: z.string(),
  results: z.array(z.object({ id: doorReportResultSchema, says: z.string() })),
  phases: z.array(z.object({ id: doorReportPhaseSchema, results: z.array(doorReportResultSchema), does: z.string() })),
  classes: z.array(
    z.object({
      id: z.string(),
      phase: doorReportPhaseSchema,
      result: doorReportResultSchema,
      says: z.string(),
      jsonrpc: z.array(z.int()).optional(),
      mcp: z.array(z.int()).optional(),
      a2a: z.array(z.int()).optional(),
      http: z.string().optional(),
    }),
  ),
  network_only: z.array(z.object({ id: z.string(), from: z.string() })),
});
export type DoorReportClassesVocab = z.infer<typeof doorReportClassesVocabSchema>;

/* --- the call ----------------------------------------------------------------------------------------------------- */

/** At most this many reports in one call, and this many bytes of body, and of one token. */
export const DOOR_REPORTS_MAX = 100;
export const DOOR_REPORTS_MAX_BYTES = 131_072;
export const DOOR_TOKEN_MAX = 1024;
/** How old a report may be, and how far ahead of the network's clock. */
export const DOOR_REPORT_MAX_AGE_S = 7 * 86_400;
export const DOOR_REPORT_MAX_AHEAD_S = 60;

/**
 * A door as the network shows it: its type (`vocab/doors.json`) and its URL, exactly as written there.
 * For a member's inbox, type `inbox` with whichever of its addresses the agent used (`inbox.url`,
 * `inbox.mcp`, `inbox.rest` on a card).
 */
export const reportedDoorSchema = z.strictObject({
  type: z
    .string()
    .regex(/^[a-z0-9:_-]{1,48}$/)
    .describe(
      "The door's type as the network shows it: inbox for a member's inbox; mcp, a2a, openapi, api, … or platform:<name>.",
    ),
  url: z
    .string()
    .min(1)
    .max(2048)
    .describe(
      "The door's URL exactly as the network shows it; for an inbox, the address used: inbox.url, inbox.mcp or inbox.rest.",
    ),
});

/**
 * One use of one door, done or not. Nothing about the person or the request is ever in it: no pass,
 * key, email, name, phone, address, message, body, IP address, item id, reason or trace. A member this
 * schema does not name makes the whole call `400`.
 */
export const doorReportSchema = z.strictObject({
  domain: z
    .string()
    .regex(/^[a-z0-9.-]{1,253}$/)
    .describe("The business's domain, as the network lists it."),
  door: reportedDoorSchema,
  op: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,31}$/)
    .describe("What was attempted, from the capability vocabulary (vocab/capabilities.json): book, order, message, …"),
  tool: z
    .string()
    .regex(/^[a-z0-9_.-]{1,64}$/)
    .optional()
    .describe("The tool or operation called at the door, in lowercase."),
  at: z.int().min(0).describe("When, in Unix seconds; the network keeps it to the minute."),
  ms: z.int().min(0).max(600_000).optional().describe("How long the door took to answer, in milliseconds."),
  intent: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,32}$/)
    .describe("8 to 32 base64url characters, one per attempt with all its retries: an attempt counts once."),
  result: doorReportResultSchema,
  class: z
    .string()
    .regex(/^[a-z0-9_.]{1,64}$/)
    .optional()
    .describe("Why, from vocab/door-report-classes.json: required unless the result is ok, and absent when it is."),
  token: z
    .string()
    .max(DOOR_TOKEN_MAX)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    .optional()
    .describe("The door's signed outcome token from its answer, when it gave one, as it came."),
});
export type DoorReport = z.infer<typeof doorReportSchema>;

/** `POST /v1/door-reports`, and the `report_door` tool's arguments: strict JSON (§4.15). */
export const doorReportsRequestSchema = z.strictObject({
  v: z.literal(1),
  reports: z.array(doorReportSchema).min(1).max(DOOR_REPORTS_MAX),
});
export type DoorReportsRequest = z.infer<typeof doorReportsRequestSchema>;

/**
 * Why a report was not taken, the first that applies: the door is not one the network lists for that
 * domain (or its URL carries a query or a fragment); the op is not in the capability vocabulary; the
 * class is unknown, the network's own, not of that result, missing or present on ok; the time is
 * more than 7 days old or more than a minute ahead; a later report in the same call is the same
 * attempt (`superseded`); or the source sent more than its share today (`over_limit`).
 */
export const DOOR_REPORT_IGNORED = [
  "unknown_door",
  "unknown_op",
  "bad_class",
  "bad_time",
  "superseded",
  "over_limit",
] as const;
export const doorReportIgnoredSchema = z.enum(DOOR_REPORT_IGNORED);
export type DoorReportIgnored = z.infer<typeof doorReportIgnoredSchema>;

/**
 * What proved a report: a door token that verified, else a signature that verified (sdi-agent/1 with
 * a self-held key, or Web Bot Auth), else nothing. A network that does not check tokens yet answers
 * `signature` or `none` for a report that carries one.
 */
export const doorReportProofSchema = z.enum(["none", "signature", "token"]);
export type DoorReportProof = z.infer<typeof doorReportProofSchema>;

/** What a report was kept as: a per-door daily count only, or a row of its own; both private. */
export const doorReportKeptSchema = z.enum(["counter", "row"]);
export type DoorReportKept = z.infer<typeof doorReportKeptSchema>;

/** `202`: every report is either accepted or ignored, by its index in `reports`. */
export const doorReportsResponseSchema = z.object({
  accepted: z.array(z.object({ i: z.int().min(0), proof: doorReportProofSchema, counts: doorReportKeptSchema })),
  ignored: z.array(z.object({ i: z.int().min(0), why: doorReportIgnoredSchema })),
  next: z.string().describe("One plain sentence: what the network does with these reports."),
});
export type DoorReportsResponse = z.infer<typeof doorReportsResponseSchema>;

/** `report_door` (MCP): the same body as `POST /v1/door-reports`, and the same answer as structuredContent. */
export const reportDoorInputSchema = doorReportsRequestSchema;
export const reportDoorOutputSchema = doorReportsResponseSchema;

/* --- the business's side ------------------------------------------------------------------------------------------ */

/** `POST /v1/door-incidents/{id}`, signed sdi-instance/1 by the business: the business says it fixed it. */
export const doorIncidentAnswerSchema = z.object({ state: z.literal("fixed") });
export const doorIncidentAnsweredSchema = z.object({
  id: z.string(),
  state: z.literal("fixed"),
  check_queued: z.boolean().describe("Whether the network queued a read of the door to confirm it."),
});

const dayString = z.iso.date();
const hourTimestamp = timestampSchema.describe("To the hour.");

/**
 * The `doors` block of a signed ping's `200` (§4.1, §4.15): what agents reported about the business's
 * own doors and what the network's own reads saw. Only the business sees it. Counts are to the day
 * and incidents to the hour; no key, person or address is ever in it, and a platform is named only
 * when 5 or more distinct sources from it reported in the period.
 */
export const pingDoorsSchema = z.object({
  as_of: dayString.describe("The last day the counts include, in UTC."),
  doors: z
    .array(
      z.object({
        type: z.string(),
        url: z.string(),
        status: z.enum(["live", "failing", "gone"]).describe("From the network's own reads only."),
        checked: z
          .object({ result: z.enum(["good", "failed", "blocked"]), at: hourTimestamp })
          .nullable()
          .describe("The network's own last read of this door; blocked: its read was refused (403, 429, a challenge)."),
        not_reproduced: z
          .int()
          .min(0)
          .optional()
          .describe(
            "In the 7 days to as_of, how many reads the network made because agents reported this door down that found it answering.",
          ),
        reports: z
          .array(
            z.object({
              op: z.string(),
              tool: z.string().optional(),
              proof: z
                .enum(["token", "none"])
                .describe("token: signed by your door; none: agents the network cannot tell apart."),
              result: doorReportResultSchema,
              class: z.string().optional(),
              d7: z.int().min(0).describe("In the 7 days to as_of."),
              d30: z.int().min(0).describe("In the 30 days to as_of."),
            }),
          )
          .max(500),
        platforms: z
          .array(z.string())
          .max(50)
          .describe("Agent platforms' origins with 5 or more distinct sources reporting here in 30 days."),
      }),
    )
    .max(50),
  incidents: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        url: z.string(),
        class: z.string(),
        opened_at: hourTimestamp,
        reproduced: z.boolean().describe("Whether the network's own read saw it too."),
        public_from: dayString
          .nullable()
          .describe(
            "When it shows publicly: the day it opened when the door's state is public at once (the network's own reads), else the day it will show if it still holds then; null while the network shows nothing of it.",
          ),
      }),
    )
    .max(50)
    .describe("Open incidents, from the network's own reads or from door-signed failures of independent sources."),
  trouble: z
    .array(z.object({ type: z.string(), url: z.string(), since: hourTimestamp }))
    .max(50)
    .describe("Doors agents report trouble at that the network's own reads do not see."),
  fixes: z
    .array(z.object({ class: z.string(), text: z.string() }))
    .max(50)
    .describe("One plain line per class there is trouble with: what to fix."),
});
export type PingDoors = z.infer<typeof pingDoorsSchema>;

/* --- reading a call ----------------------------------------------------------------------------------------------- */

/** A door the network lists for a domain. */
export interface ListedDoor {
  readonly type: string;
  readonly url: string;
}

export interface DoorReportsContext {
  /** When the call arrived, in Unix seconds. */
  readonly now: number;
  /**
   * The doors the network shows for a domain, each as shown: the listing's doors, and a member's inbox
   * under type `inbox` at its address and at each endpoint a card gives (mcp, rest). None for a domain
   * it does not list.
   */
  readonly doors: (domain: string) => readonly ListedDoor[];
}

/** A report taken, `at` kept to the minute. */
export type KeptDoorReport = DoorReport & { readonly i: number };

export type DoorReportsRead =
  | { readonly status: 400 | 413; readonly code: "malformed" | "too_large"; readonly detail: string }
  | {
      readonly status: 202;
      readonly kept: KeptDoorReport[];
      readonly ignored: { readonly i: number; readonly why: DoorReportIgnored }[];
    };

/**
 * How a network reads a `POST /v1/door-reports` body, before anything about the caller (its
 * signature, its share for the day) is weighed: `413 too_large` over 128 KB, over 100 reports or with
 * a token over 1 KB; `400 malformed` for anything that is not strict JSON of this shape (a member this
 * schema does not name, in any letter case, or one named twice); else each report taken or ignored on
 * its own (`DOOR_REPORT_IGNORED`, the first that applies).
 */
export function readDoorReports(text: string, ctx: DoorReportsContext): DoorReportsRead {
  if (new TextEncoder().encode(text).length > DOOR_REPORTS_MAX_BYTES) {
    return { status: 413, code: "too_large", detail: `a call is at most ${DOOR_REPORTS_MAX_BYTES} bytes` };
  }
  const parsed = parseStrictJson(text);
  if (!parsed.ok) return { status: 400, code: "malformed", detail: parsed.why };
  const raw = parsed.value as { reports?: unknown };
  if (Array.isArray(raw?.reports)) {
    if (raw.reports.length > DOOR_REPORTS_MAX) {
      return { status: 413, code: "too_large", detail: `a call carries at most ${DOOR_REPORTS_MAX} reports` };
    }
    for (const r of raw.reports as { token?: unknown }[]) {
      if (typeof r?.token === "string" && r.token.length > DOOR_TOKEN_MAX) {
        return { status: 413, code: "too_large", detail: `a token is at most ${DOOR_TOKEN_MAX} characters` };
      }
    }
  }
  const body = doorReportsRequestSchema.safeParse(parsed.value);
  if (!body.success) {
    const issue = body.error.issues[0];
    return { status: 400, code: "malformed", detail: `${issue?.path.join(".") || "body"}: ${issue?.message ?? ""}` };
  }
  const reports = body.data.reports;
  const lastOfIntent = new Map<string, number>();
  reports.forEach((r, i) => {
    lastOfIntent.set(r.intent, i);
  });
  const kept: KeptDoorReport[] = [];
  const ignored: { i: number; why: DoorReportIgnored }[] = [];
  reports.forEach((r, i) => {
    const why = ignoredWhy(r, ctx) ?? (lastOfIntent.get(r.intent) === i ? null : "superseded");
    if (why) ignored.push({ i, why });
    else kept.push({ ...r, at: r.at - (r.at % 60), i });
  });
  return { status: 202, kept, ignored };
}

function ignoredWhy(r: DoorReport, ctx: DoorReportsContext): DoorReportIgnored | null {
  if (!isListedDoor(r, ctx)) return "unknown_door";
  if (!capabilityIdSchema.safeParse(r.op).success) return "unknown_op";
  if (r.result === "ok" ? r.class !== undefined : doorReportClass(r.class ?? "")?.result !== r.result) {
    return "bad_class";
  }
  if (r.at < ctx.now - DOOR_REPORT_MAX_AGE_S || r.at > ctx.now + DOOR_REPORT_MAX_AHEAD_S) return "bad_time";
  return null;
}

/** A door the network lists for that domain, of that type at exactly that URL, which carries no query or fragment. */
function isListedDoor(r: DoorReport, ctx: DoorReportsContext): boolean {
  if (/[?#]/.test(r.door.url) || !r.door.url.startsWith("https://")) return false;
  return ctx.doors(r.domain).some((d) => d.type === r.door.type && d.url === r.door.url);
}

/* --- what a report may lead to ------------------------------------------------------------------------------------ */

export interface DoorReportSource {
  /** How the call was signed, when its signature verified. */
  readonly signature: "none" | "key" | "platform";
  /** Whether the report's door token verified. */
  readonly token: boolean;
  /** A platform independent of the business, or a self-held key with standing (§4.15); never an unsigned call. */
  readonly independent: boolean;
}

export interface DoorReportEffect {
  readonly proof: DoorReportProof;
  readonly counts: DoorReportKept;
  /** It may make the network read the door itself, within that door's daily budget. */
  readonly confirm_read: boolean;
  /** Its confirm read goes ahead of the queue. */
  readonly priority: boolean;
  /** It counts toward the door's public failures line, once that line's thresholds are met. */
  readonly public_line: boolean;
}

/**
 * What one report taken can do (§4.15): kept as a row when a token verified or a platform signed it,
 * else as a count; a reach failure may make the network read the door, sooner from an independent
 * source; and only a door-signed failure from an independent source counts toward anything public.
 * Every report reaches the business, privately; none changes anything public on its own.
 */
export function doorReportEffect(
  source: DoorReportSource,
  report: { readonly result: DoorReportResult; readonly class?: string | undefined },
): DoorReportEffect {
  const phase = report.class === undefined ? undefined : doorReportClass(report.class)?.phase;
  const confirm = report.result === "fail" && phase === "reach";
  // Only a signature names a source, so a call nobody signed is never independent.
  const independent = source.independent && source.signature !== "none";
  return {
    proof: source.token ? "token" : source.signature === "none" ? "none" : "signature",
    counts: source.token || source.signature === "platform" ? "row" : "counter",
    confirm_read: confirm,
    priority: confirm && independent,
    public_line:
      source.token && independent && report.result === "fail" && (phase === "protocol" || phase === "operation"),
  };
}

/** Each (source, intent) counts once, and its last result wins: what a run of reports comes to. */
export function countedIntents<T extends { readonly source: string; readonly intent: string }>(
  reports: readonly T[],
): T[] {
  const last = new Map<string, T>();
  for (const r of reports) {
    const key = `${r.source}\u0000${r.intent}`;
    last.delete(key);
    last.set(key, r);
  }
  return [...last.values()];
}

/* --- the network's own reads (§4.8) ------------------------------------------------------------------------------- */

/** What one read of a door met. */
export interface DoorReadObservation {
  /** No HTTP answer at all. */
  readonly error?: "dns" | "tcp_refused" | "tcp_reset" | "tcp_timeout" | "tls" | undefined;
  readonly status?: number | undefined;
  /** How long the answer took, in milliseconds. */
  readonly ms?: number | undefined;
  /** The answer is a bot challenge page. */
  readonly challenge?: boolean | undefined;
  /** The door's robots.txt disallows the read. */
  readonly robots_disallow?: boolean | undefined;
  /** The answer parses as the door's protocol (a server card, a tools list, a manifest, a typed refusal). */
  readonly parses?: boolean | undefined;
  /** What the read of a known-good door through the same route met, in the same minute. */
  readonly control?: "good" | "failed" | "blocked" | undefined;
}

export type DoorReadResult = "good" | "failed" | "blocked" | "discarded";

/** The longest a door may take to answer a read before it counts as no answer. */
export const DOOR_READ_TIMEOUT_MS = 10_000;

/**
 * What a read concludes (§4.8): discarded when the control read did not come back good; blocked when
 * the door's robots.txt disallows it, or it answered 403, 429 or a challenge page (private, and it
 * never lowers a door); failed on no answer (name, connection or TLS failure, or nothing within 10 s),
 * a 5xx, or an answer that does not parse as the door's protocol; good otherwise.
 */
export function classifyDoorRead(o: DoorReadObservation): DoorReadResult {
  if (o.control !== undefined && o.control !== "good") return "discarded";
  if (o.robots_disallow) return "blocked";
  if (o.error !== undefined) return "failed";
  if (o.ms !== undefined && o.ms > DOOR_READ_TIMEOUT_MS) return "failed";
  if (o.status === 403 || o.status === 429 || o.challenge) return "blocked";
  if (o.status !== undefined && o.status >= 500) return "failed";
  if (o.parses === false) return "failed";
  return "good";
}

/**
 * One read, as the door state machine takes it: by the network's scheduled `probe`, its `crawl`, or
 * a `check` anyone asked for (which only ever adds: its failure never lowers a door).
 */
export interface DoorRead {
  readonly at: number;
  readonly by: "probe" | "crawl" | "check";
  readonly result: "good" | "failed" | "blocked";
}

export type DoorStatus = "live" | "failing" | "gone";

const MIN = 60;
const DAY = 86_400;

/**
 * The one door state machine (§4.8), over a door type's reads in time order, at `now` (Unix seconds):
 * `failing` after 3 failed reads in 7 days, the first and the last at least 30 minutes apart, with no
 * good read between them; `live` again after one good read; `gone` after 30 days failing. A blocked
 * read changes nothing, and neither does a failed `check`.
 */
export function doorStatusAfter(
  reads: readonly DoorRead[],
  now: number,
): { status: DoorStatus; failing_since: number | null } {
  let failing: number | null = null;
  let failed: number[] = [];
  for (const r of [...reads].sort((a, b) => a.at - b.at)) {
    if (r.result === "blocked") continue;
    if (r.result === "good") {
      failing = null;
      failed = [];
      continue;
    }
    if (r.by === "check") continue;
    failed.push(r.at);
    if (failing !== null) continue;
    const window = failed.filter((t) => t >= r.at - 7 * DAY);
    if (window.length >= 3 && r.at - (window[0] as number) >= 30 * MIN) failing = r.at;
  }
  if (failing === null) return { status: "live", failing_since: null };
  return { status: now - failing >= 30 * DAY ? "gone" : "failing", failing_since: failing };
}

/* --- strict JSON -------------------------------------------------------------------------------------------------- */

/**
 * JSON as RFC 8259 writes it, refusing what `JSON.parse` lets through: a member named twice in one
 * object. Nesting is limited to 32 levels.
 */
export function parseStrictJson(text: string): { ok: true; value: unknown } | { ok: false; why: string } {
  let pos = 0;
  const fail = (why: string): never => {
    throw new StrictJsonError(`${why} at ${pos}`);
  };
  const ws = () => {
    while (pos < text.length && " \t\n\r".includes(text[pos] as string)) pos++;
  };
  const str = (): string => {
    const start = pos;
    pos++;
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c === 0x22) {
        pos++;
        return JSON.parse(text.slice(start, pos)) as string;
      }
      if (c < 0x20) fail("a control character in a string");
      if (c === 0x5c) {
        const e = text[pos + 1];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(pos + 2, pos + 6))) fail("a bad \\u escape");
          pos += 6;
          continue;
        }
        if (e === undefined || !'"\\/bfnrt'.includes(e)) fail("a bad escape");
        pos += 2;
        continue;
      }
      pos++;
    }
    return fail("an unterminated string");
  };
  const value = (depth: number): unknown => {
    if (depth > 32) fail("nesting deeper than 32");
    ws();
    const c = text[pos];
    if (c === "{") {
      pos++;
      const out: [string, unknown][] = [];
      const seen = new Set<string>();
      ws();
      if (text[pos] === "}") {
        pos++;
        return {};
      }
      for (;;) {
        ws();
        if (text[pos] !== '"') fail("a member name expected");
        const name = str();
        if (seen.has(name)) fail(`the member ${JSON.stringify(name)} named twice`);
        seen.add(name);
        ws();
        if (text[pos] !== ":") fail("':' expected");
        pos++;
        out.push([name, value(depth + 1)]);
        ws();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "}") {
          pos++;
          return Object.fromEntries(out);
        }
        fail("',' or '}' expected");
      }
    }
    if (c === "[") {
      pos++;
      const out: unknown[] = [];
      ws();
      if (text[pos] === "]") {
        pos++;
        return out;
      }
      for (;;) {
        out.push(value(depth + 1));
        ws();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "]") {
          pos++;
          return out;
        }
        fail("',' or ']' expected");
      }
    }
    if (c === '"') return str();
    const lit = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(pos, pos + 400));
    if (!lit) return fail("a value expected");
    pos += lit[0].length;
    return JSON.parse(lit[0]) as unknown;
  };
  try {
    const v = value(0);
    ws();
    if (pos !== text.length) fail("text after the value");
    return { ok: true, value: v };
  } catch (e) {
    if (e instanceof StrictJsonError) return { ok: false, why: e.message };
    throw e;
  }
}

class StrictJsonError extends Error {}
