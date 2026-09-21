import { type Caller, JobRunner } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { ensureNetworkPing, NETWORK_PING_KIND, networkPingHandler, pingDedupeKey } from "../src/network";
import { publicOrigin } from "../src/origin";
import { freshDb } from "./db";

const system: Caller = {
  actor: { kind: "system", id: "test", channel: "system" },
  tier: "verified_principal",
  sandbox: false,
};
const customer: Caller = {
  actor: { kind: "customer_human", id: "web:1", channel: "form" },
  tier: "anonymous",
  sandbox: false,
};

function fakeNetwork(known: Set<string>) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const ping = /\/v1\/instances\/([^/]+)\/ping$/.exec(url);
    if (ping) {
      return known.has(decodeURIComponent(ping[1] ?? ""))
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ title: "unknown instance" }), { status: 404 });
    }
    if (url.endsWith("/v1/instances")) {
      known.add((body as { domain: string }).domain);
      return new Response(JSON.stringify({ status: "pending" }), { status: 202 });
    }
    return new Response("nope", { status: 500 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("network membership", () => {
  it("stays quiet until the owner joins, then registers, pings counts and schedules the next hour", async () => {
    const { db, caps } = await freshDb();
    const now = Date.UTC(2026, 8, 21, 15, 30);
    const net = fakeNetwork(new Set());
    const runner = new JobRunner()
      .register(
        NETWORK_PING_KIND,
        networkPingHandler({ baseUrl: "https://demo.example.com", version: "0.0.0", fetchImpl: net.fetchImpl }),
      )
      .register("notify", async () => undefined)
      .register("rules", async () => undefined);
    await ensureNetworkPing(db, now);
    await ensureNetworkPing(db, now);
    const pingStatus = async () =>
      (
        await db.client.query({
          sql: "SELECT status, last_error FROM jobs WHERE kind = ? ORDER BY created_at",
          params: [NETWORK_PING_KIND],
        })
      ).rows.map((r) => `${r[0]}:${r[1] ?? ""}`);
    await runner.runDue(db, { now });
    expect(await pingStatus()).toEqual(["done:not joined; enable network.join in Settings", "queued:"]);
    expect(net.calls).toEqual([]);
    const queued = async () =>
      (
        await db.client.query({
          sql: "SELECT dedupe_key FROM jobs WHERE kind = ? AND status = 'queued' ORDER BY run_at",
          params: [NETWORK_PING_KIND],
        })
      ).rows.map((r) => String(r[0]));
    expect(await queued()).toEqual([pingDedupeKey(now + 3_600_000)]);

    await caps.updateSettings(system, { doc: { network: { join: true } } });
    await caps.sendMessage(customer, { body: "hello", contact: { email: "a@example.com" } });
    const later = now + 3_600_000 + 130_000;
    await runner.runDue(db, { now: later });
    expect((await pingStatus())[1]).toBe("done:registered demo.example.com at network.surfingdog.ai and pinged");
    expect(net.calls.map((c) => c.url)).toEqual([
      "https://network.surfingdog.ai/v1/instances/demo.example.com/ping",
      "https://network.surfingdog.ai/v1/instances",
      "https://network.surfingdog.ai/v1/instances/demo.example.com/ping",
    ]);
    expect(net.calls[2]?.body).toEqual({
      version: "0.0.0",
      runtime: expect.any(String),
      counts: { bookings: 0, orders: 0, quotes: 0, messages: 1 },
    });
    expect(await queued()).toEqual([pingDedupeKey(later + 3_600_000)]);
  });

  it("refuses non-public origins and reports why", async () => {
    const { db, caps } = await freshDb();
    await caps.updateSettings(system, { doc: { network: { join: true, url: "https://localhost" } } });
    const net = fakeNetwork(new Set());
    const runner = new JobRunner().register(
      NETWORK_PING_KIND,
      networkPingHandler({ baseUrl: "http://localhost:8787", version: "0.0.0", fetchImpl: net.fetchImpl }),
    );
    const now = Date.now();
    await ensureNetworkPing(db, now);
    await runner.runDue(db, { now });
    const { rows } = await db.client.query({
      sql: "SELECT last_error FROM jobs WHERE kind = ? AND status = 'done'",
      params: [NETWORK_PING_KIND],
    });
    expect(String(rows[0]?.[0])).toContain("not a public https origin");
    expect(net.calls).toEqual([]);
  });

  it("derives the public origin from the base URL, then the proxy header, then the request", () => {
    const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
    expect(publicOrigin(req("http://127.0.0.1:9003/x"), "https://inbox.surfingdog.ai/")).toBe(
      "https://inbox.surfingdog.ai",
    );
    expect(publicOrigin(req("http://inbox.surfingdog.ai/x", { "x-forwarded-proto": "https" }))).toBe(
      "https://inbox.surfingdog.ai",
    );
    expect(publicOrigin(req("http://localhost:8787/x"))).toBe("http://localhost:8787");
  });
});
