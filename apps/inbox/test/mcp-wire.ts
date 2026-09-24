import { expect } from "vitest";

/**
 * MCP requests as they arrive on the wire, for the door tests (mcp-door.test.ts on both runtimes,
 * worker-mcp.workers.test.ts through the Worker entry). Each case says what must come back; every
 * one must come back promptly, since a request that is never answered is the failure they guard.
 */

/** How long any answer may take in these tests. A door that never answers fails here, not at the suite's timeout. */
export const ANSWER_MS = 5_000;

/** Fails with `what` when `p` has not settled within `ms`. */
export function within<T>(p: T | Promise<T>, what: string, ms = ANSWER_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms: ${what}`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export const MODERN = "2026-07-28";
export const LEGACY = "2025-06-18";

/** The per-request envelope a 2026-07-28 client puts in every request's params. */
const envelope = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientCapabilities": {},
};

export function modern(id: number, method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: envelope } };
}

export function legacy(id: number, method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

/** The headers a 2026-07-28 client sends with a request. `name` is the Mcp-Name header, when it sends one. */
export function modernHeaders(method: string, name?: string): Record<string, string> {
  return {
    "mcp-method": method,
    "mcp-protocol-version": MODERN,
    ...(name === undefined ? {} : { "mcp-name": name }),
  };
}

/** The JSON-RPC messages in an answer, whether it came as JSON or as a stream of events; none for an empty one. */
export function messages(text: string, contentType: string | null): Record<string, unknown>[] {
  if (text.length === 0) return [];
  if (contentType?.startsWith("text/event-stream")) {
    return text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((data) => data.length > 0)
      .map((data) => JSON.parse(data) as Record<string, unknown>);
  }
  const parsed = JSON.parse(text) as unknown;
  return (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[];
}

export interface WireCase {
  readonly name: string;
  /** POST when absent. A GET or DELETE is sent with no body. */
  readonly method?: "GET" | "DELETE";
  /** The Accept header: both media types when absent, none at all when null. */
  readonly accept?: string | null;
  readonly headers: Record<string, string>;
  /** The body exactly as sent. */
  readonly body: string;
  readonly check: (status: number, answers: Record<string, unknown>[]) => void;
}

const result = (m: Record<string, unknown> | undefined) => m?.result as Record<string, unknown> | undefined;
const errorCode = (m: Record<string, unknown> | undefined) => (m?.error as { code?: number } | undefined)?.code;
/** A list in an answer's result, empty when the answer has none. */
const listIn = <T = unknown>(m: Record<string, unknown> | undefined, key: string): T[] =>
  (result(m)?.[key] ?? []) as T[];

/**
 * What a client can send to `/mcp`, and what it must get. The first is the request that went
 * unanswered on the public demo on 24 Sep 2026: tools/list at 2026-07-28 with no Mcp-Name header,
 * which is what Claude and ChatGPT send.
 */
export const WIRE_CASES: readonly WireCase[] = [
  {
    name: "tools/list at 2026-07-28 with no Mcp-Name header",
    headers: modernHeaders("tools/list"),
    body: JSON.stringify(modern(1, "tools/list")),
    check: (status, [m]) => {
      expect(status).toBe(200);
      const tools = listIn<{ name: string }>(m, "tools").map((t) => t.name);
      expect(tools).toContain("list_services");
      expect(tools).toContain("create_booking");
    },
  },
  {
    name: "tools/list at 2026-07-28 with an empty Mcp-Name header",
    headers: modernHeaders("tools/list", ""),
    body: JSON.stringify(modern(1, "tools/list")),
    check: (status, [m]) => {
      expect(status).toBe(200);
      expect(listIn(m, "tools").length).toBeGreaterThan(0);
    },
  },
  {
    name: "initialize at 2025-06-18, with no MCP headers",
    headers: {},
    body: JSON.stringify(
      legacy(1, "initialize", { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "t", version: "0" } }),
    ),
    check: (status, [m]) => {
      expect(status).toBe(200);
      expect(result(m)?.protocolVersion).toBe(LEGACY);
    },
  },
  {
    name: "tools/call at 2026-07-28 with its Mcp-Name header",
    headers: modernHeaders("tools/call", "get_business_profile"),
    body: JSON.stringify(modern(2, "tools/call", { name: "get_business_profile", arguments: {} })),
    check: (status, [m]) => {
      expect(status).toBe(200);
      expect(result(m)?.isError ?? false).toBe(false);
      expect(listIn(m, "content").length).toBeGreaterThan(0);
    },
  },
  {
    // The 2026-07-28 revision requires Mcp-Name on tools/call; the answer is the header error, at once.
    name: "tools/call at 2026-07-28 without its Mcp-Name header",
    headers: modernHeaders("tools/call"),
    body: JSON.stringify(modern(2, "tools/call", { name: "get_business_profile", arguments: {} })),
    check: (status, [m]) => {
      expect(status).toBe(400);
      expect(errorCode(m)).toBe(-32020);
    },
  },
  {
    name: "tools/call at 2025-06-18, with no MCP headers",
    headers: {},
    body: JSON.stringify(legacy(3, "tools/call", { name: "get_business_profile", arguments: {} })),
    check: (status, [m]) => {
      expect(status).toBe(200);
      expect(listIn(m, "content").length).toBeGreaterThan(0);
    },
  },
  {
    name: "a batch at 2025-06-18",
    headers: {},
    body: JSON.stringify([legacy(4, "tools/list"), legacy(5, "ping")]),
    check: (status, answers) => {
      expect(status).toBe(200);
      expect(answers.map((a) => a.id).sort()).toEqual([4, 5]);
      expect(answers.every((a) => a.error === undefined)).toBe(true);
    },
  },
  {
    name: "a batch that calls a tool, at 2025-06-18",
    headers: {},
    body: JSON.stringify([
      legacy(6, "tools/call", { name: "list_services", arguments: {} }),
      legacy(7, "tools/call", { name: "get_business_profile", arguments: {} }),
    ]),
    check: (status, answers) => {
      expect(status).toBe(200);
      expect(answers.map((a) => a.id).sort()).toEqual([6, 7]);
    },
  },
  {
    // Batches do not exist at 2026-07-28: refused, not left waiting.
    name: "a batch holding a 2026-07-28 request",
    headers: {},
    body: JSON.stringify([modern(8, "tools/list"), legacy(9, "ping")]),
    check: (status, [m]) => {
      expect(status).toBe(400);
      expect(errorCode(m)).toBe(-32600);
    },
  },
  // The rest of what a connector sends in a session, at both revisions, and the Accept headers
  // clients vary on. Each has one right answer, and it must come at once.
  {
    name: "server/discover at 2026-07-28, a negotiating client's first request",
    headers: modernHeaders("server/discover"),
    body: JSON.stringify(modern(10, "server/discover")),
    check: (status, [m]) => {
      expect(status).toBe(200);
      expect(result(m)?.supportedVersions).toContain(MODERN);
    },
  },
  {
    name: "tools/list at 2026-07-28 accepting JSON only",
    accept: "application/json",
    headers: modernHeaders("tools/list"),
    body: JSON.stringify(modern(11, "tools/list")),
    check: (status, [m]) => {
      expect(status).toBe(200);
      expect(listIn(m, "tools").length).toBeGreaterThan(0);
    },
  },
  {
    name: "tools/list at 2026-07-28 with no Accept header",
    accept: null,
    headers: modernHeaders("tools/list"),
    body: JSON.stringify(modern(12, "tools/list")),
    check: (status, [m]) => {
      expect(status).toBe(200);
      expect(listIn(m, "tools").length).toBeGreaterThan(0);
    },
  },
  {
    name: "tools/list at 2026-07-28 with Mcp-Method and no MCP-Protocol-Version header",
    headers: { "mcp-method": "tools/list" },
    body: JSON.stringify(modern(13, "tools/list")),
    check: (status, [m]) => {
      expect(status).toBe(200);
      expect(listIn(m, "tools").length).toBeGreaterThan(0);
    },
  },
  {
    name: "tools/list at 2026-07-28 with no Mcp-Method header",
    headers: { "mcp-protocol-version": MODERN },
    body: JSON.stringify(modern(14, "tools/list")),
    check: (status, [m]) => {
      expect(status).toBe(400);
      expect(errorCode(m)).toBe(-32020);
    },
  },
  {
    name: "tools/call at 2026-07-28 whose Mcp-Name names another tool",
    headers: modernHeaders("tools/call", "list_services"),
    body: JSON.stringify(modern(15, "tools/call", { name: "get_business_profile", arguments: {} })),
    check: (status, [m]) => {
      expect(status).toBe(400);
      expect(errorCode(m)).toBe(-32020);
    },
  },
  {
    name: "a notification at 2026-07-28",
    headers: modernHeaders("notifications/cancelled"),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 15, reason: "user", _meta: envelope },
    }),
    check: (status, answers) => {
      expect(status).toBe(202);
      expect(answers).toEqual([]);
    },
  },
  {
    name: "initialize at 2025-11-25, as the SDK's own client sends it",
    headers: {},
    body: JSON.stringify(
      legacy(0, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      }),
    ),
    check: (status, [m]) => {
      expect(status).toBe(200);
      expect(result(m)?.protocolVersion).toBe("2025-11-25");
    },
  },
  {
    name: "notifications/initialized at 2025-06-18",
    headers: { "mcp-protocol-version": LEGACY },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    check: (status, answers) => {
      expect(status).toBe(202);
      expect(answers).toEqual([]);
    },
  },
  {
    name: "tools/list at 2025-06-18 with the protocol header",
    headers: { "mcp-protocol-version": LEGACY },
    body: JSON.stringify(legacy(16, "tools/list", {})),
    check: (status, [m]) => {
      expect(status).toBe(200);
      expect(listIn(m, "tools").length).toBeGreaterThan(0);
    },
  },
  {
    // The 2025 transport needs a client that takes both; it says so rather than guess.
    name: "initialize at 2025-06-18 accepting JSON only",
    accept: "application/json",
    headers: {},
    body: JSON.stringify(
      legacy(0, "initialize", { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "t", version: "0" } }),
    ),
    check: (status, [m]) => {
      expect(status).toBe(406);
      expect(errorCode(m)).toBe(-32000);
    },
  },
  {
    // A 2025 client opens a stream for server messages after initialize; a stateless door has none.
    name: "GET, a 2025 client asking for its event stream",
    method: "GET",
    accept: "text/event-stream",
    headers: { "mcp-protocol-version": LEGACY },
    body: "",
    check: (status, [m]) => {
      expect(status).toBe(405);
      expect(errorCode(m)).toBe(-32000);
    },
  },
  {
    name: "DELETE, a 2025 client ending its session",
    method: "DELETE",
    headers: { "mcp-protocol-version": LEGACY },
    body: "",
    check: (status, [m]) => {
      expect(status).toBe(405);
      expect(errorCode(m)).toBe(-32000);
    },
  },
  {
    name: "a body that does not parse",
    headers: modernHeaders("tools/list"),
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list",',
    check: (status, [m]) => {
      expect(status).toBe(400);
      expect(errorCode(m)).toBe(-32700);
    },
  },
  {
    name: "an empty body",
    headers: {},
    body: "",
    check: (status, [m]) => {
      expect(status).toBe(400);
      expect(errorCode(m)).toBe(-32700);
    },
  },
];

/** Sends a case through `send` and checks its answer, failing fast if none comes. */
export async function expectAnswered(
  send: (init: RequestInit) => Response | Promise<Response>,
  c: WireCase,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const post = c.method === undefined;
  const accept = c.accept === undefined ? "application/json, text/event-stream" : c.accept;
  const res = await within(
    send({
      method: c.method ?? "POST",
      headers: {
        ...(post ? { "content-type": "application/json" } : {}),
        ...(accept === null ? {} : { accept }),
        ...c.headers,
        ...extraHeaders,
      },
      ...(post ? { body: c.body } : {}),
    }),
    c.name,
  );
  const text = await within(res.text(), `${c.name}: the body`);
  c.check(res.status, messages(text, res.headers.get("content-type")));
}
