import { afterEach, describe, expect, it, vi } from "vitest";
import { DOOR_REPORT_CLASSES, doorReportSchema, doorReportsMeSchema } from "../../spec/src/index";
import {
  classifyDoorAnswer,
  classifyDoorError,
  type DoorOutcome,
  DoorReporter,
  FAIL_CLASSES,
  generateAgentKey,
  INFO_CLASSES,
  INVALID_CLASSES,
  NetworkCallError,
  REFUSED_CLASSES,
  reporterCredit,
  signingFetch,
  trackDoor,
} from "../src/index";

/**
 * trackDoor and what it reads (network protocol §4.15): every outcome it reports is one the protocol's
 * vocabulary has, the call's own result comes back untouched, nothing that is not the door's is
 * reported; signingFetch signs the requests it sends to the network, and no others; reporterCredit reads
 * the signer's own credit; and the reporter's retries. Node and workerd.
 */

const NOW = Date.parse("2026-10-15T12:00:00Z");
const DOOR = { type: "mcp", url: "https://bakery.example/mcp" };
const TOKEN = "eyJhbGciOiJFZERTQSJ9.eyJ2IjoxfQ.c2lnbmF0dXJl";

/** A network that takes every call (202) and keeps the reports it was sent. */
function network(answer?: (n: number) => Response) {
  const reports: Record<string, unknown>[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (answer) return answer(calls.length);
    const body = JSON.parse(String(init.body)) as { reports: Record<string, unknown>[] };
    reports.push(...body.reports);
    return Response.json(
      { accepted: body.reports.map((_, i) => ({ i, proof: "none", counts: "counter" })), ignored: [], next: "" },
      { status: 202 },
    );
  }) as unknown as typeof fetch;
  return { reports, calls, fetch };
}

function queue(fetch: typeof globalThis.fetch) {
  return new DoorReporter({ network: "network.example", allowNetwork: true, fetch, autoFlush: false, now: () => NOW });
}

const use = {
  network: "network.example",
  allowNetwork: true,
  domain: "bakery.example",
  door: DOOR,
  op: "book",
  tool: "create_booking",
};

describe("the classes", () => {
  it("are the protocol's, each with its result", () => {
    const byResult = (r: string) =>
      DOOR_REPORT_CLASSES.filter((c) => c.result === r)
        .map((c) => c.id)
        .sort();
    expect([...FAIL_CLASSES].sort()).toEqual(byResult("fail"));
    expect([...REFUSED_CLASSES].sort()).toEqual(byResult("refused"));
    expect([...INVALID_CLASSES].sort()).toEqual(byResult("invalid"));
    expect([...INFO_CLASSES].sort()).toEqual(byResult("info"));
  });
});

/** Every outcome read is a report the protocol takes. */
function valid(o: DoorOutcome | undefined): DoorOutcome {
  if (!o) throw new Error("no outcome");
  const r = { domain: "bakery.example", door: DOOR, op: "book", at: 1, intent: "abcdefgh", ...o };
  expect(doorReportSchema.safeParse(r).success, JSON.stringify(o)).toBe(true);
  return o;
}

describe("classifyDoorAnswer", () => {
  it("reads a Response by its status, and an error's problem code from a copy", async () => {
    const cases: [Response, DoorOutcome][] = [
      [new Response("{}", { status: 200 }), { result: "ok" }],
      [new Response(null, { status: 201 }), { result: "ok" }],
      [new Response(null, { status: 408 }), { result: "fail", class: "timeout" }],
      [new Response(null, { status: 429 }), { result: "invalid", class: "client.rate_limited" }],
      [new Response(null, { status: 404 }), { result: "invalid", class: "client.http" }],
      [new Response(null, { status: 503 }), { result: "fail", class: "http.error" }],
      [
        Response.json(
          { type: "about:blank", status: 409, code: "slot_taken" },
          { status: 409, headers: { "content-type": "application/problem+json" } },
        ),
        { result: "refused", class: "slot_taken" },
      ],
      [
        Response.json(
          { type: "about:blank", status: 422, code: "outside_limits" },
          { status: 422, headers: { "content-type": "application/problem+json" } },
        ),
        { result: "refused", class: "outside_limits" },
      ],
      [Response.json({ code: "something_else" }, { status: 409 }), { result: "invalid", class: "client.http" }],
    ];
    for (const [res, want] of cases) expect(valid(await classifyDoorAnswer(res)), String(res.status)).toEqual(want);
    const res = Response.json({ code: "slot_taken" }, { status: 409 });
    await classifyDoorAnswer(res);
    expect(await res.json()).toEqual({ code: "slot_taken" }); // the caller can still read it
    expect(await classifyDoorAnswer(new Response(null, { status: 302 }))).toBeUndefined();
  });

  it("reads JSON-RPC answers, MCP tool results and problem documents", async () => {
    const cases: [unknown, DoorOutcome][] = [
      [{ jsonrpc: "2.0", id: 1, result: { content: [] } }, { result: "ok" }],
      [
        { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "x" } },
        { result: "invalid", class: "client.invalid_params" },
      ],
      [
        { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "x" } },
        { result: "fail", class: "protocol.advertised_missing" },
      ],
      [
        { jsonrpc: "2.0", id: 1, error: { code: -32022, message: "x" } },
        { result: "fail", class: "protocol.version" },
      ],
      // A server's own code, even one an SDK uses for itself, is the door's error.
      [
        { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "x" } },
        { result: "fail", class: "operation.failed" },
      ],
      [
        { jsonrpc: "2.0", id: 1, result: { isError: true, content: [] } },
        { result: "fail", class: "operation.tool_error" },
      ],
      [
        { content: [], isError: true, structuredContent: { error: { code: "slot_taken", status: 409 } } },
        { result: "refused", class: "slot_taken" },
      ],
      [
        { content: [], isError: true, structuredContent: { error: { code: "invalid_input", status: 422 } } },
        { result: "invalid", class: "client.invalid_params" },
      ],
      [
        { content: [], isError: true, structuredContent: { error: { code: "made_up", status: 500 } } },
        { result: "fail", class: "operation.failed" },
      ],
      [{ content: [{ type: "text", text: "Booked" }] }, { result: "ok" }],
      [
        { type: "about:blank", status: 409, code: "confirm_terms" },
        { result: "info", class: "person" },
      ],
      ["a string", { result: "ok" }],
      [undefined, { result: "ok" }],
    ];
    for (const [answer, want] of cases)
      expect(valid(await classifyDoorAnswer(answer)), JSON.stringify(answer)).toEqual(want);
  });
});

describe("classifyDoorError", () => {
  it("reads what is the door's, and nothing else", () => {
    const fetchFailed = (code: string) =>
      Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
    const cases: [unknown, DoorOutcome | undefined][] = [
      [new DOMException("timed out", "TimeoutError"), { result: "fail", class: "timeout" }],
      [fetchFailed("ENOTFOUND"), { result: "fail", class: "dns.name_not_resolved" }],
      [fetchFailed("ECONNREFUSED"), { result: "fail", class: "tcp.refused" }],
      [fetchFailed("ECONNRESET"), { result: "fail", class: "tcp.reset" }],
      [fetchFailed("UND_ERR_CONNECT_TIMEOUT"), { result: "fail", class: "tcp.timed_out" }],
      [fetchFailed("CERT_HAS_EXPIRED"), { result: "fail", class: "tls.cert.invalid" }],
      [fetchFailed("ERR_SSL_WRONG_VERSION_NUMBER"), { result: "fail", class: "tls.failed" }],
      [new TypeError("Network connection lost."), { result: "fail", class: "tcp.reset" }],
      // The MCP SDK's McpError and StreamableHTTPError carry the code.
      [
        Object.assign(new Error("MCP error -32602"), { code: -32602 }),
        { result: "invalid", class: "client.invalid_params" },
      ],
      [Object.assign(new Error("Request timed out"), { code: -32001 }), { result: "fail", class: "timeout" }],
      [Object.assign(new Error("Connection closed"), { code: -32000 }), { result: "fail", class: "abandoned" }],
      [Object.assign(new Error("Error POSTing"), { code: 503 }), { result: "fail", class: "http.error" }],
      [Object.assign(new Error("Error POSTing"), { code: 401 }), { result: "invalid", class: "client.http" }],
      // Not the door's: a cancellation, a fault in the agent's own code.
      [new DOMException("aborted", "AbortError"), undefined],
      [new TypeError("x.map is not a function"), undefined],
      [new Error("boom"), undefined],
      ["thrown string", undefined],
    ];
    for (const [error, want] of cases) {
      const got = classifyDoorError(error);
      expect(got, String(error)).toEqual(want);
      if (got) valid(got);
    }
  });
});

describe("an A2A task's state", () => {
  const task = (state: string) => ({ jsonrpc: "2.0", id: 1, result: { kind: "task", id: "t1", status: { state } } });
  it("is how the use went, whatever the JSON-RPC envelope says", async () => {
    const cases: [unknown, DoorOutcome | undefined][] = [
      [task("failed"), { result: "fail", class: "operation.failed" }],
      [task("rejected"), { result: "refused", class: "wrong_state" }],
      [task("auth-required"), { result: "info", class: "auth" }],
      [task("input-required"), { result: "info", class: "person" }],
      [task("canceled"), undefined],
      [task("completed"), { result: "ok" }],
      [task("working"), { result: "ok" }],
      [task("submitted"), { result: "ok" }],
      [task("constructor"), { result: "ok" }],
      [
        { kind: "status-update", taskId: "t1", status: { state: "failed" }, final: true },
        { result: "fail", class: "operation.failed" },
      ],
      [
        { jsonrpc: "2.0", id: 1, result: { kind: "message", messageId: "m1", role: "agent", parts: [] } },
        { result: "ok" },
      ],
    ];
    for (const [answer, want] of cases) {
      const got = await classifyDoorAnswer(answer);
      expect(got, JSON.stringify(answer)).toEqual(want);
      if (got) valid(got);
    }
  });

  it("is reported by trackDoor, and a cancelled task is not", async () => {
    const net = network();
    const reporter = queue(net.fetch);
    const a2a = { ...use, door: { type: "a2a", url: "https://bakery.example/a2a" }, reporter };
    await trackDoor(a2a, async () => task("failed"));
    await trackDoor(a2a, async () => task("canceled"));
    await trackDoor(a2a, async () => task("rejected"));
    await reporter.flush();
    expect(net.reports.map((r) => [r.result, r.class])).toEqual([
      ["fail", "operation.failed"],
      ["refused", "wrong_state"],
    ]);
  });
});

describe("trackDoor", () => {
  it("answers the call's own result, and reports it with its time", async () => {
    const net = network();
    const reporter = queue(net.fetch);
    let clock = NOW;
    const answer = { content: [{ type: "text", text: "Booked for 10:00" }] };
    const got = await trackDoor({ ...use, reporter, now: () => clock }, async () => {
      clock += 1840;
      return answer;
    });
    expect(got).toBe(answer);
    await reporter.flush();
    expect(net.reports).toEqual([
      expect.objectContaining({
        domain: "bakery.example",
        door: DOOR,
        op: "book",
        tool: "create_booking",
        result: "ok",
        ms: 1840,
        at: NOW / 1000,
      }),
    ]);
    expect(net.reports[0]).not.toHaveProperty("class");
    // Nothing of the answer or the call travels.
    expect(JSON.stringify(net.reports)).not.toContain("Booked");
  });

  it("throws what the call threw, and reports it when it is the door's", async () => {
    const net = network();
    const reporter = queue(net.fetch);
    const down = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    await expect(trackDoor({ ...use, reporter }, () => Promise.reject(down))).rejects.toBe(down);
    const mine = new TypeError("cannot read properties of undefined");
    await expect(trackDoor({ ...use, reporter }, () => Promise.reject(mine))).rejects.toBe(mine);
    await reporter.flush();
    expect(net.reports.map((r) => [r.result, r.class])).toEqual([["fail", "tcp.refused"]]);
  });

  it("keeps one intent for an attempt's retries, and takes a door's token only where you say it is", async () => {
    const net = network();
    const reporter = queue(net.fetch);
    const tokens: string[] = [];
    const intent = "attempt-00000001";
    const header = (answer: unknown) =>
      answer instanceof Response ? (answer.headers.get("x-door-token") ?? undefined) : undefined;
    await trackDoor({ ...use, reporter, intent }, async () => Response.json({}, { status: 503 }));
    await trackDoor(
      { ...use, reporter, intent, tokenOf: header, onToken: (t) => tokens.push(t) },
      async () => new Response("{}", { status: 200, headers: { "X-Door-Token": TOKEN } }),
    );
    // Without tokenOf, nothing is read as a token, wherever an answer carries one.
    await trackDoor({ ...use, reporter }, async () => ({ content: [], _meta: { "ai.surfingdog/door": TOKEN } }));
    // A token that is no compact JWS is left out, never the report.
    await trackDoor({ ...use, reporter, tokenOf: () => "not a token" }, async () => ({}));
    await trackDoor({ ...use, reporter, tokenOf: () => `${TOKEN}${"A".repeat(1024)}` }, async () => ({}));
    await reporter.flush();
    expect(net.reports.map((r) => [r.intent === intent, r.result, r.token])).toEqual([
      [true, "fail", undefined],
      [true, "ok", TOKEN],
      [false, "ok", undefined],
      [false, "ok", undefined],
      [false, "ok", undefined],
    ]);
    expect(tokens).toEqual([TOKEN]);
  });

  it("takes your own reading first, and reports nothing when you say so", async () => {
    const net = network();
    const reporter = queue(net.fetch);
    await trackDoor({ ...use, reporter, outcome: () => ({ result: "info", class: "escalation" }) }, async () => ({}));
    await trackDoor({ ...use, reporter, outcome: () => null }, async () => ({}));
    await trackDoor({ ...use, reporter, outcome: () => undefined }, async () => ({}));
    await reporter.flush();
    expect(net.reports.map((r) => r.result)).toEqual(["info", "ok"]);
  });

  it("never fails the call over its report", async () => {
    const errors: unknown[] = [];
    const answer = await trackDoor({ ...use, domain: "Not A Domain", onError: (e) => errors.push(e) }, async () => 42);
    expect(answer).toBe(42);
    expect(errors[0]).toBeInstanceOf(TypeError);
  });
});

describe("signingFetch", () => {
  it("signs every request to the network, the body's digest included, and sends the body as it was", async () => {
    const key = await generateAgentKey();
    const seen: Request[] = [];
    const f = signingFetch({
      key,
      origins: ["https://network.example"],
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Request(input, init));
        return new Response("{}");
      }) as typeof fetch,
    });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await f("https://network.example/mcp", { method: "POST", body, headers: { "content-type": "application/json" } });
    await f(new Request("https://network.example/v1/businesses?q=bakery"));
    const [post, get] = seen;
    expect(await post?.text()).toBe(body);
    expect(post?.headers.get("content-type")).toBe("application/json");
    expect(post?.headers.get("signature-input")).toMatch(
      /^sig1=\("@method" "@authority" "@path" "content-digest" "sdi-agent-key";key="sig1"\);created=\d+;expires=\d+;keyid="[\w-]{43}";alg="ed25519";tag="sdi-agent";nonce="/,
    );
    expect(post?.headers.get("content-digest")).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/);
    expect(get?.headers.get("signature-input")).toMatch(
      /^sig1=\("@method" "@authority" "@path" "@query" "sdi-agent-key";key="sig1"\)/,
    );
    expect(get?.headers.get("content-digest")).toBeNull();
  });

  it("signs as a platform, and leaves other origins unsigned when told", async () => {
    const key = await generateAgentKey();
    const seen: Request[] = [];
    const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response("{}");
    }) as typeof fetch;
    const f = signingFetch({
      key,
      platform: "https://agents.example",
      origins: ["https://network.example"],
      fetch: send,
    });
    await f("https://network.example/v1/businesses");
    await f("https://elsewhere.example/v1/businesses");
    expect(seen[0]?.headers.get("signature-agent")).toBe('sig1="https://agents.example"');
    expect(seen[0]?.headers.get("signature-input")).toContain('tag="web-bot-auth"');
    expect(seen[1]?.headers.get("signature")).toBeNull();
  });

  it("signs only the default network's requests unless told otherwise: never a business's", async () => {
    const key = await generateAgentKey();
    const seen: Request[] = [];
    const f = signingFetch({
      key,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Request(input, init));
        return new Response("{}");
      }) as typeof fetch,
    });
    await f("https://network.surfingdog.ai/v1/businesses?q=bakery");
    await f("https://surfingdog.ai/mcp", { method: "POST", body: "{}" });
    await f("https://bakery.example/mcp", { method: "POST", body: "{}" });
    expect(seen[0]?.headers.get("signature-input")).toContain('tag="sdi-agent"');
    expect(seen[1]?.headers.get("signature-input")).toContain('tag="sdi-agent"');
    expect(seen[2]?.headers.get("signature-input")).toBeNull();
    expect(seen[2]?.headers.get("sdi-agent-key")).toBeNull();
  });
});

describe("reporterCredit", () => {
  it("asks the network, signed, for the signer's own credit", async () => {
    const key = await generateAgentKey();
    const standing = {
      reporter: { type: "key", keyid: key.thumbprint },
      credit: { points: 12, days: 4 },
      contributor: false,
      threshold: { window_days: 30, min_days: 7, min_points: 30, per_day_at_most: 10 },
      reads: { per_minute: 600, burst: 200, per: "address" },
      contributor_reads: { per_minute: 1800, burst: 600, per: "key", per_address: 1800 },
      guide: "https://network.example/report.md",
      as_of: "2026-10-15T12:00:00Z",
    };
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json(standing);
    }) as unknown as typeof globalThis.fetch;
    expect(doorReportsMeSchema.safeParse(standing).success).toBe(true);
    expect(await reporterCredit({ key, network: "network.example", fetch })).toEqual(standing);
    expect(calls[0]?.url).toBe("https://network.example/v1/door-reports/me");
    const sent = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(sent["Signature-Input"]).toContain(`keyid="${key.thumbprint}"`);
    const refused = (async () =>
      Response.json(
        { code: "signature_required", detail: "sign" },
        { status: 401 },
      )) as unknown as typeof globalThis.fetch;
    await expect(reporterCredit({ key, network: "network.example", fetch: refused })).rejects.toMatchObject({
      status: 401,
      code: "signature_required",
    });
  });
});

describe("DoorReporter's retries", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits as long as the network asks before it tries again", async () => {
    vi.useFakeTimers();
    const net = network((n) =>
      n === 1
        ? new Response(null, { status: 429, headers: { "Retry-After": "120" } })
        : Response.json({ accepted: [], ignored: [], next: "" }, { status: 202 }),
    );
    const errors: unknown[] = [];
    const r = new DoorReporter({
      network: "network.example",
      allowNetwork: true,
      fetch: net.fetch,
      flushAfterMs: 10,
      onError: (e) => errors.push(e),
    });
    r.report({ domain: "bakery.example", door: DOOR, op: "book", result: "ok" });
    await vi.advanceTimersByTimeAsync(20);
    expect(net.calls).toHaveLength(1);
    expect(errors[0]).toMatchObject({ status: 429, retryAfterMs: 120_000 });
    await vi.advanceTimersByTimeAsync(110_000);
    expect(net.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(net.calls).toHaveLength(2);
    expect(r.pending).toBe(0);
  });

  it("keeps a full queue waiting while the network asks it to: new reports do not send it sooner", async () => {
    vi.useFakeTimers();
    const net = network((n) =>
      n === 1
        ? new Response(null, { status: 429, headers: { "Retry-After": "120" } })
        : Response.json({ accepted: [], ignored: [], next: "" }, { status: 202 }),
    );
    const r = new DoorReporter({
      network: "network.example",
      allowNetwork: true,
      fetch: net.fetch,
      flushAfterMs: 10,
      onError: () => undefined,
    });
    const one = { domain: "bakery.example", door: DOOR, op: "book", result: "ok" } as const;
    for (let i = 0; i < 100; i++) r.report(one);
    await vi.advanceTimersByTimeAsync(1);
    expect(net.calls).toHaveLength(1);
    for (let i = 0; i < 150; i++) {
      r.report(one);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(net.calls).toHaveLength(1);
    expect(r.pending).toBe(250);
    await vi.advanceTimersByTimeAsync(106_000);
    expect(net.calls.length).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.pending).toBe(0);
  });

  it("drops what is older than a network takes, and gives up on a call that does not answer in time", async () => {
    const net = network();
    const r = new DoorReporter({
      network: "network.example",
      allowNetwork: true,
      fetch: net.fetch,
      autoFlush: false,
      now: () => NOW,
    });
    r.report({ domain: "bakery.example", door: DOOR, op: "book", result: "ok", at: NOW / 1000 - 8 * 86_400 });
    expect(await r.flush()).toBeNull();
    expect(net.calls).toHaveLength(0);

    const hang = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as unknown as typeof fetch;
    const slow = new DoorReporter({
      network: "network.example",
      allowNetwork: true,
      fetch: hang,
      autoFlush: false,
      timeoutMs: 20,
    });
    slow.report({ domain: "bakery.example", door: DOOR, op: "book", result: "ok" });
    await expect(slow.flush()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(slow.pending).toBe(1);
    expect(new NetworkCallError(503, null, "x").retryAfterMs).toBeNull();
  });
});
