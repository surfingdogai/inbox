import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { consume, createApiKey, isCreateRoute, LIMITS, mcpCreates } from "@surfingdog/adapters";
import { schema, ulid } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { freshDb } from "./harness";

/**
 * Rate limits on the doors anyone can open (packages/adapters/src/limits.ts). Without them one
 * script could post ten thousand bookings and mail the owner ten thousand times. The owner's own
 * verified calls are never limited, and a forged Authorization header does not make a stranger the
 * owner. Addresses arrive as CF-Connecting-IP, the way Cloudflare delivers them.
 */
const T0 = Date.parse("2026-09-22T10:00:00Z");

async function setup() {
  const db = await freshDb();
  const svc = ulid();
  await db.orm.insert(schema.services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    capacity: 1,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  const clock = { t: T0 };
  const owner = await createApiKey(db, { kind: "owner", name: "test" });
  const app = createApp({ db, now: () => clock.t, ownerEmails: ["owner@example.com"] });
  return { db, app, svc, clock, ownerKey: owner.key };
}

const booking = (svc: string, ip: string, headers: Record<string, string> = {}) =>
  new Request("https://inbox.test/v1/bookings", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
    body: JSON.stringify({
      payload: {
        reservationFor: { serviceId: svc, name: "Full service" },
        startTime: "2026-09-23T08:00:00Z",
        endTime: "2026-09-23T09:30:00Z",
      },
      contact: { name: "Rita", email: "rita@example.com" },
    }),
  });

describe("rate limits", () => {
  it("let a burst of new items through, then refuse with Retry-After, per address", async () => {
    const { app, svc } = await setup();
    for (let i = 0; i < LIMITS.create.capacity; i++) {
      const res = await app.request(booking(svc, "203.0.113.7"));
      expect(res.status, `booking ${i + 1}`).toBe(201);
    }
    const refused = await app.request(booking(svc, "203.0.113.7"));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("content-type")).toContain("application/problem+json");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await refused.json()) as { code: string }).code).toBe("too_many_requests");
    // Another address is untouched.
    expect((await app.request(booking(svc, "198.51.100.9"))).status).toBe(201);
    // Reads are never limited.
    const read = await app.request(
      new Request("https://inbox.test/v1/business", { headers: { "cf-connecting-ip": "203.0.113.7" } }),
    );
    expect(read.status).toBe(200);
  });

  it("recover after a pause, and stay shut for a client that keeps knocking", async () => {
    const { app, svc, clock } = await setup();
    for (let i = 0; i < LIMITS.create.capacity; i++) await app.request(booking(svc, "203.0.113.8"));
    expect((await app.request(booking(svc, "203.0.113.8"))).status).toBe(429);
    // Knocking every minute: never earns a token back.
    for (let i = 0; i < 5; i++) {
      clock.t += 60_000;
      expect((await app.request(booking(svc, "203.0.113.8"))).status, `knock ${i + 1}`).toBe(429);
    }
    // Two tokens' worth of quiet (one per three minutes) and it is let in again.
    clock.t += 2 * 180_000 + 1_000;
    expect((await app.request(booking(svc, "203.0.113.8"))).status).toBe(201);
  });

  it("never limit the verified owner, and a forged key does not make anyone the owner", async () => {
    const { db, app, svc, ownerKey } = await setup();
    await db.client.query({
      sql: "INSERT INTO rate_limits (bucket, tokens, updated_at) VALUES (?, -1, ?), (?, -1, ?)",
      params: ["create:ip:203.0.113.9", T0, "public:ip:203.0.113.9", T0],
      method: "run",
    });
    const asOwner = await app.request(booking(svc, "203.0.113.9", { authorization: `Bearer ${ownerKey}` }));
    expect(asOwner.status).not.toBe(429);
    const forged = await app.request(
      booking(svc, "203.0.113.9", { authorization: "Bearer sdi_own_forged0000000000000000" }),
    );
    expect(forged.status).toBe(429);
  });

  it("keep sign-in links from filling the owner's mailbox", async () => {
    const { app } = await setup();
    const ask = () =>
      app.request(
        new Request("https://inbox.test/auth/magic-link", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
          body: JSON.stringify({ email: "owner@example.com" }),
        }),
      );
    for (let i = 0; i < LIMITS.auth.capacity; i++) expect((await ask()).status, `link ${i + 1}`).not.toBe(429);
    expect((await ask()).status).toBe(429);
  });

  it("do not apply to the inbound mail webhook, which has its own secret", async () => {
    const { db, app } = await setup();
    await db.client.query({
      sql: "INSERT INTO rate_limits (bucket, tokens, updated_at) VALUES (?, -1, ?)",
      params: ["public:ip:203.0.113.11", T0],
      method: "run",
    });
    const res = await app.request(
      new Request("https://inbox.test/v1/email/inbound", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.11", "x-inbox-email-secret": "wrong" },
        body: "raw",
      }),
    );
    // Refused for the secret, not for the rate.
    expect(res.status).toBe(401);
  });

  it("limit MCP tool calls that create, and not the ones that read", async () => {
    const { db, app, svc } = await setup();
    const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set("cf-connecting-ip", "203.0.113.12");
      return app.request(String(input), { ...init, headers });
    };
    const client = new Client({ name: "test-agent", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("https://inbox.test/mcp"), { fetch: fetchLike }));
    await db.client.query({
      sql: "INSERT INTO rate_limits (bucket, tokens, updated_at) VALUES (?, -1, ?)",
      params: ["create:ip:203.0.113.12", T0],
      method: "run",
    });
    const read = await client.callTool({ name: "list_services", arguments: {} });
    expect(read.isError ?? false).toBe(false);
    await expect(
      client.callTool({
        name: "create_booking",
        arguments: {
          payload: {
            reservationFor: { serviceId: svc, name: "Full service" },
            startTime: "2026-09-23T08:00:00Z",
            endTime: "2026-09-23T09:30:00Z",
          },
          contact: { email: "rita@example.com" },
          idempotency_key: "mcp-limit-1",
        },
      }),
    ).rejects.toThrow(/429|Too many/i);
  });
});

describe("the bucket arithmetic", () => {
  it("is one statement that refuses at zero and floors at minus one", async () => {
    const db = await freshDb();
    const cap = LIMITS.auth.capacity;
    for (let i = 0; i < cap; i++) expect((await consume(db, "auth", "a", T0)).allowed).toBe(true);
    const no = await consume(db, "auth", "a", T0);
    expect(no.allowed).toBe(false);
    expect(no.retryAfterSec).toBeGreaterThan(0);
    const { rows } = await db.client.query({
      sql: "SELECT tokens FROM rate_limits WHERE bucket = 'auth:a'",
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBe(-1);
  });

  it("classifies what creates", async () => {
    expect(isCreateRoute("POST", "/v1/bookings")).toBe(true);
    expect(isCreateRoute("POST", "/v1/messages")).toBe(true);
    expect(isCreateRoute("GET", "/v1/bookings")).toBe(false);
    expect(isCreateRoute("POST", "/v1/items/x/cancel")).toBe(false);
    const call = (name: string) =>
      new Request("https://x/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
      });
    expect(await mcpCreates(call("create_booking"))).toBe(true);
    expect(await mcpCreates(call("list_services"))).toBe(false);
    expect(await mcpCreates(new Request("https://x/mcp", { method: "POST", body: "not json" }))).toBe(false);
  });
});
