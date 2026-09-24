import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  consume,
  createApiKey,
  isCreateRoute,
  isNegotiateRoute,
  LIMITS,
  mcpCreates,
  mcpNegotiates,
} from "@surfingdog/adapters";
import { schema, ulid } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { freshDb, futureDay } from "./harness";

/**
 * Rate limits on the doors anyone can open (packages/adapters/src/limits.ts). Without them one
 * script could post ten thousand bookings and mail the owner ten thousand times. The owner's own
 * verified calls are never limited, and a forged Authorization header does not make a stranger the
 * owner. Addresses arrive as CF-Connecting-IP, the way Cloudflare delivers them.
 */
const T0 = Date.parse("2026-09-22T10:00:00Z");
/** Bookings go through the doors on the real clock: a day to come (nobody books a time that has started). */
const DAY = futureDay();

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
        startTime: `${DAY}T08:00:00Z`,
        endTime: `${DAY}T09:30:00Z`,
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
            startTime: `${DAY}T08:00:00Z`,
            endTime: `${DAY}T09:30:00Z`,
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
    const call = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
    expect(mcpCreates(call("create_booking"))).toBe(true);
    expect(mcpCreates(call("list_services"))).toBe(false);
    // A batch creates when any call in it does; a body that is not JSON-RPC calls no tool.
    expect(mcpCreates([call("list_services"), call("send_message")])).toBe(true);
    expect(mcpCreates(undefined)).toBe(false);
    expect(mcpCreates(null)).toBe(false);
    expect(mcpCreates([null, 1, "x", { method: "tools/call", params: null }])).toBe(false);
  });

  it("classifies asking for another time, and limits it and the link page's POSTs on their own", async () => {
    expect(isNegotiateRoute("POST", "/v1/items/01K5X/counter")).toBe(true);
    expect(isNegotiateRoute("POST", "/v1/items/01K5X/accept")).toBe(false);
    expect(isNegotiateRoute("GET", "/v1/items/01K5X/counter")).toBe(false);
    const call = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
    expect(mcpNegotiates(call("suggest_time"))).toBe(true);
    expect(mcpNegotiates(call("accept_offer"))).toBe(false);
    expect(LIMITS.negotiate).toEqual({ capacity: 10, perMs: 10 / 3_600_000 });
    expect(LIMITS.link).toEqual({ capacity: 30, perMs: 30 / 3_600_000 });

    const { app } = await setup();
    const counter = () =>
      app.request("https://inbox.test/v1/items/01K5NOTANITEMAAAAAAAAAAAAA/counter", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.20" },
        body: JSON.stringify({ start_time: "2026-09-24T10:00:00Z" }),
      });
    for (let i = 0; i < LIMITS.negotiate.capacity; i++) expect((await counter()).status, `try ${i + 1}`).not.toBe(429);
    expect((await counter()).status).toBe(429);
    const page = () =>
      app.request("https://inbox.test/c/not-a-token", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.21", "content-type": "application/x-www-form-urlencoded" },
        body: "terms=x&v=1",
      });
    for (let i = 0; i < LIMITS.link.capacity; i++) expect((await page()).status, `post ${i + 1}`).toBe(404);
    const refused = await page();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await refused.text()).toContain("Too many attempts.");
  });
});
