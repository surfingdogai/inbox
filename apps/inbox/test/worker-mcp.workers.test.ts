import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/worker";
import { expectAnswered, modern, modernHeaders, WIRE_CASES, within } from "./mcp-wire";

/**
 * The MCP door through the real Worker entry, in workerd: as the public demo shop runs it
 * (INBOX_DEMO=1) and as any other instance does. On 24 Sep 2026 the demo shop left some of these
 * requests without an answer; each case here fails in seconds if one ever goes unanswered again.
 */

// The Worker keeps one app per D1 binding. The demo gets a binding of its own over the same
// database, so it never shares an app with the instance SELF reaches in this file.
const demoDb = {
  prepare: (sql: string) => env.DB.prepare(sql),
  batch: (statements: Parameters<typeof env.DB.batch>[0]) => env.DB.batch(statements),
};
const demoEnv = {
  ...env,
  DB: demoDb as unknown as typeof env.DB,
  INBOX_DEMO: "1",
  INBOX_OWNER_EMAIL: "owner@example.com",
  INBOX_SECRET_KEY: "worker-demo-secret-key-0123456789abcdef",
};

/** A request to the demo Worker, answered and its after-response work finished. */
async function demoFetch(url: string, init: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, init) as Parameters<typeof worker.fetch>[0], demoEnv, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return new Response(text, res);
}

describe("the Worker's MCP door, as the demo shop", () => {
  for (const c of WIRE_CASES) {
    it(`answers ${c.name}`, async () => {
      await expectAnswered((init) => demoFetch("https://demo.test/mcp", init), c, {
        "cf-connecting-ip": "203.0.113.90",
      });
    });
  }

  it("answers the request the demo left unanswered when its body comes as a stream of unknown length", async () => {
    // Without Content-Length the demo's body limit reads the body and hands on a new request.
    const bytes = new TextEncoder().encode(JSON.stringify(modern(1, "tools/list")));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 32) controller.enqueue(bytes.slice(i, i + 32));
        controller.close();
      },
    });
    const res = await within(
      demoFetch("https://demo.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...modernHeaders("tools/list"),
        },
        body,
        duplex: "half",
      } as RequestInit),
      "a streamed tools/list",
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
  });

  it("answers many clients at once", async () => {
    const send = (i: number) =>
      demoFetch("https://demo.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "cf-connecting-ip": `203.0.113.${100 + i}`,
          ...modernHeaders("tools/list"),
        },
        body: JSON.stringify(modern(i, "tools/list")),
      });
    const answers = await within(Promise.all(Array.from({ length: 12 }, (_, i) => send(i))), "twelve at once");
    expect(answers.map((r) => r.status)).toEqual(Array(12).fill(200));
  });
});

describe("the Worker's MCP door", () => {
  for (const c of WIRE_CASES) {
    it(`answers ${c.name}`, async () => {
      await expectAnswered((init) => SELF.fetch("https://example.com/mcp", init), c, {
        "cf-connecting-ip": "203.0.113.91",
      });
    });
  }
});
