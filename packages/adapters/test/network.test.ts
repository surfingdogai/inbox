import { type Caller, DEFAULT_NETWORK, ensureJob, hourOf, JobRunner, networkLane, pingOneKey } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  ensureNetworkPing,
  NETWORK_PING_KIND,
  NETWORK_PING_ONE_KIND,
  NETWORK_PUBLISH_KIND,
  type NetworkDeps,
  networkPingHandler,
  networkPingOneHandler,
  pingDedupeKey,
  pingNetworksNow,
} from "../src/network";
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

const A = "https://network.example.com";
const B = "https://second.example.net";
const HOUR = 3_600_000;

type Reply = Response | "hang" | Promise<Response>;

/**
 * Fake networks by origin. Each keeps the domains it knows; a ping from an unknown one gets 404, a
 * registration adds it. `reply` overrides the answer for one network to fake an outage.
 */
function fakeNetworks(opts: { known?: string[]; reply?: Record<string, (url: string) => Reply | undefined> } = {}) {
  const known = new Set(opts.known ?? []);
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const custom = opts.reply?.[new URL(url).origin]?.(url);
    if (custom === "hang") {
      return await new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    }
    if (custom) return await custom;
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
  return { calls, fetchImpl, known };
}

function runnerFor(deps: NetworkDeps): JobRunner {
  const runner = new JobRunner()
    .register(NETWORK_PING_KIND, networkPingHandler(deps))
    .register(NETWORK_PING_ONE_KIND, networkPingOneHandler(deps), { lane: networkLane });
  for (const kind of ["notify", "rules", NETWORK_PUBLISH_KIND, "network_receipt"]) {
    runner.register(kind, async () => undefined);
  }
  return runner;
}

type Db = Awaited<ReturnType<typeof freshDb>>["db"];

/** Runs until nothing more is due at `now`: a tick queues jobs that only the next run picks up. */
async function drain(runner: JobRunner, db: Db, now: number) {
  for (let i = 0; i < 10; i++) {
    if ((await runner.runDue(db, { now })).claimed === 0) return;
  }
}

const jobs = async (db: Db, kind: string) =>
  (
    await db.client.query({
      sql: "SELECT dedupe_key, status, last_error FROM jobs WHERE kind = ? ORDER BY created_at, dedupe_key",
      params: [kind],
      method: "all",
    })
  ).rows.map((r) => ({ key: String(r[0]), status: String(r[1]), note: r[2] === null ? null : String(r[2]) }));

describe("the hourly tick", () => {
  it("stays quiet while no network is on, and schedules the next hour", async () => {
    const { db } = await freshDb();
    const now = Date.UTC(2026, 8, 21, 15, 30);
    const net = fakeNetworks();
    await ensureNetworkPing(db, now);
    await ensureNetworkPing(db, now);
    await runnerFor({ version: "0.0.0", fetchImpl: net.fetchImpl, baseUrl: "https://demo.example.com" }).runDue(db, {
      now,
    });
    expect(await jobs(db, NETWORK_PING_KIND)).toEqual([
      {
        key: pingDedupeKey(now),
        status: "done",
        note: "no network is switched on; add or switch one on in Settings → Networks",
      },
      { key: pingDedupeKey(now + HOUR), status: "queued", note: null },
    ]);
    expect(await jobs(db, NETWORK_PING_ONE_KIND)).toEqual([]);
    expect(net.calls).toEqual([]);
  });

  it("queues one ping and one publisher per network that is on, once an hour", async () => {
    const { db, caps } = await freshDb();
    await caps.updateSettings(system, {
      doc: { networks: { [A]: { enabled: true }, [B]: { enabled: true, share: { receipts: false } } } },
    });
    await db.client.query({ sql: "DELETE FROM jobs", params: [], method: "run" });
    const now = Date.UTC(2026, 8, 21, 16, 0, 30);
    await ensureNetworkPing(db, now);
    const runner = new JobRunner().register(NETWORK_PING_KIND, networkPingHandler());
    await runner.runDue(db, { now });
    const hour = Math.floor(now / HOUR);
    expect((await jobs(db, NETWORK_PING_ONE_KIND)).map((j) => j.key).sort()).toEqual(
      [`network_ping:${A}:${hour}`, `network_ping:${B}:${hour}`].sort(),
    );
    // B does not take receipts, so it gets no publisher.
    expect((await jobs(db, NETWORK_PUBLISH_KIND)).map((j) => j.key)).toEqual([`network_publish:${A}:${hour}`]);
    expect((await jobs(db, NETWORK_PING_KIND))[0]?.note).toBe("reporting to network.example.com, second.example.net");
  });
});

describe("pinging a network", () => {
  it("registers, pings counts and records the status, the moment the owner switches it on", async () => {
    const { db, caps } = await freshDb();
    const now = Date.UTC(2026, 8, 21, 15, 30);
    await caps.sendMessage({ ...customer, now: () => now }, { body: "hello", contact: { email: "a@example.com" } });
    await caps.updateSettings({ ...system, now: () => now }, { doc: { networks: { [A]: { enabled: true } } } });
    const net = fakeNetworks();
    await runnerFor({ baseUrl: "https://demo.example.com", version: "0.0.0", fetchImpl: net.fetchImpl }).runDue(db, {
      now,
    });
    expect(net.calls.map((c) => c.url)).toEqual([
      `${A}/v1/instances/demo.example.com/ping`,
      `${A}/v1/instances`,
      `${A}/v1/instances/demo.example.com/ping`,
    ]);
    expect(net.calls[2]?.body).toEqual({
      version: "0.0.0",
      runtime: expect.any(String),
      counts: { bookings: 0, orders: 0, quotes: 0, messages: 1 },
    });
    expect((await jobs(db, NETWORK_PING_ONE_KIND))[0]?.note).toBe(
      "registered demo.example.com at network.example.com and pinged",
    );
    const [view] = (await caps.getNetworks(system)).networks.filter((n) => n.origin === A);
    expect(view).toMatchObject({
      enabled: true,
      registration: "registered",
      registered_at: new Date(now).toISOString(),
      last_ping_at: new Date(now).toISOString(),
      last_error: null,
      failing_since: null,
    });
  });

  it("keeps each network to itself: one down, the other reporting, side by side", async () => {
    const { db, caps } = await freshDb();
    const now = Date.UTC(2026, 8, 21, 15, 30);
    await caps.updateSettings(
      { ...system, now: () => now },
      { doc: { networks: { [A]: { enabled: true }, [B]: { enabled: true } } } },
    );
    // Each network answers only once the other has been called: run one after the other, the
    // first would time out. Side by side, both answer.
    let calledA!: () => void;
    let calledB!: () => void;
    const aCalled = new Promise<void>((r) => {
      calledA = r;
    });
    const bCalled = new Promise<void>((r) => {
      calledB = r;
    });
    const net = fakeNetworks({
      known: ["demo.example.com"],
      reply: {
        [A]: () => {
          calledA();
          return bCalled.then(() => new Response(null, { status: 204 }));
        },
        [B]: () => {
          calledB();
          return aCalled.then(() => new Response(null, { status: 204 }));
        },
      },
    });
    const deps = { baseUrl: "https://demo.example.com", version: "0.0.0", fetchImpl: net.fetchImpl, timeoutMs: 1_000 };
    await runnerFor(deps).runDue(db, { now });
    const views = (await caps.getNetworks(system)).networks;
    expect(views.find((n) => n.origin === A)?.last_ping_at).toBe(new Date(now).toISOString());
    expect(views.find((n) => n.origin === B)?.last_ping_at).toBe(new Date(now).toISOString());

    // Now B stops answering. A keeps reporting; B's failure is recorded and retried on its own.
    const later = now + HOUR;
    const down = fakeNetworks({ known: ["demo.example.com"], reply: { [B]: () => "hang" } });
    await ensureNetworkPing(db, later);
    const runner = runnerFor({ ...deps, fetchImpl: down.fetchImpl, timeoutMs: 50 });
    await runner.runDue(db, { now: later });
    await runner.runDue(db, { now: later });
    const after = (await caps.getNetworks(system)).networks;
    expect(after.find((n) => n.origin === A)).toMatchObject({
      last_ping_at: new Date(later).toISOString(),
      failing_since: null,
    });
    expect(after.find((n) => n.origin === B)).toMatchObject({
      last_ping_at: new Date(now).toISOString(),
      failing_since: new Date(later).toISOString(),
      last_error: "ping: no answer within 50 ms",
    });
    const hour = Math.floor(later / HOUR);
    const bJob = (await jobs(db, NETWORK_PING_ONE_KIND)).find((j) => j.key === `network_ping:${B}:${hour}`);
    expect(bJob).toMatchObject({ status: "queued", note: "second.example.net ping: no answer within 50 ms" });
  });

  it("takes any 2xx as a ping, and a 409 on registration as registered", async () => {
    const { db, caps } = await freshDb();
    const now = Date.UTC(2026, 8, 21, 15, 30);
    await caps.updateSettings({ ...system, now: () => now }, { doc: { networks: { [A]: { enabled: true } } } });
    let registered = false;
    const net = fakeNetworks({
      reply: {
        [A]: (url) => {
          if (url.endsWith("/v1/instances")) {
            registered = true;
            return new Response(JSON.stringify({ code: "already_registered" }), { status: 409 });
          }
          return registered
            ? new Response(JSON.stringify({ ok: true, standing: null }), { status: 200 })
            : new Response(null, { status: 404 });
        },
      },
    });
    await runnerFor({ baseUrl: "https://demo.example.com", version: "0.0.0", fetchImpl: net.fetchImpl }).runDue(db, {
      now,
    });
    expect((await jobs(db, NETWORK_PING_ONE_KIND))[0]).toMatchObject({ status: "done" });
    expect((await caps.getNetworks(system)).networks.find((n) => n.origin === A)?.registration).toBe("registered");
  });

  it("registers at most once a day while the network has not verified the domain", async () => {
    const { db, caps } = await freshDb();
    const now = Date.UTC(2026, 8, 21, 15, 30);
    await caps.updateSettings({ ...system, now: () => now }, { doc: { networks: { [A]: { enabled: true } } } });
    // A network that takes the registration but never verifies: every ping is a 404.
    const net = fakeNetworks({
      reply: {
        [A]: (url) =>
          url.endsWith("/v1/instances") ? new Response(null, { status: 202 }) : new Response(null, { status: 404 }),
      },
    });
    const deps = { baseUrl: "https://demo.example.com", version: "0.0.0", fetchImpl: net.fetchImpl };
    await runnerFor(deps).runDue(db, { now });
    expect((await caps.getNetworks(system)).networks.find((n) => n.origin === A)?.registration).toBe("pending");
    const pingAt = async (t: number) => {
      await ensureJob(db, NETWORK_PING_ONE_KIND, pingOneKey(A, hourOf(t)), { now: t, payload: { network: A } });
      await runnerFor(deps).runDue(db, { now: t });
    };
    for (let h = 1; h <= 3; h++) await pingAt(now + h * HOUR);
    expect(net.calls.filter((c) => c.url.endsWith("/v1/instances"))).toHaveLength(1);
    expect(net.calls.filter((c) => c.url.endsWith("/ping"))).toHaveLength(5);
    expect((await jobs(db, NETWORK_PING_ONE_KIND)).at(-1)?.note).toMatch(/^network\.example\.com has not verified/);
    await pingAt(now + 25 * HOUR);
    expect(net.calls.filter((c) => c.url.endsWith("/v1/instances"))).toHaveLength(2);
  });

  it("keeps what a hostile network says to one short, plain line, and quotes it to the owner's AI", async () => {
    const { db, caps } = await freshDb();
    const now = Date.UTC(2026, 8, 21, 15, 30);
    await caps.updateSettings({ ...system, now: () => now }, { doc: { networks: { [A]: { enabled: true } } } });
    const detail = `line one\nline two ‮gnp.exe‬​\u0085 ${"x".repeat(400)}`;
    const net = fakeNetworks({
      reply: {
        [A]: (url) =>
          url.endsWith("/v1/instances")
            ? new Response(JSON.stringify({ code: "nope‮", detail }), { status: 403 })
            : new Response(null, { status: 404 }),
      },
    });
    await runnerFor({ baseUrl: "https://demo.example.com", version: "0.0.0", fetchImpl: net.fetchImpl }).runDue(db, {
      now,
    });
    const error = (await caps.getNetworks(system)).networks.find((n) => n.origin === A)?.last_error ?? "";
    expect(error.startsWith("register: HTTP 403 nope : line one line two gnp.exe")).toBe(true);
    expect(error).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(Array.from(error).length).toBeLessThanOrEqual(200);
  });

  it("sends no counts to a network that should not get them", async () => {
    const { db, caps } = await freshDb();
    const now = Date.UTC(2026, 8, 21, 15, 30);
    await caps.updateSettings(
      { ...system, now: () => now },
      { doc: { networks: { [A]: { enabled: true, share: { counts: false } } } } },
    );
    const net = fakeNetworks({ known: ["demo.example.com"] });
    await runnerFor({ baseUrl: "https://demo.example.com", version: "0.0.0", fetchImpl: net.fetchImpl }).runDue(db, {
      now,
    });
    expect(net.calls[0]?.body).toEqual({ version: "0.0.0", runtime: expect.any(String) });
  });

  it("refuses an instance address a network could never verify, and tells the owner", async () => {
    const { db, caps } = await freshDb();
    const now = Date.UTC(2026, 8, 21, 15, 30);
    await caps.updateSettings({ ...system, now: () => now }, { doc: { networks: { [A]: { enabled: true } } } });
    const net = fakeNetworks();
    for (const [i, [baseUrl, problem]] of [
      ["http://localhost:8787", "is not a public https origin"],
      ["https://demo.example.com:8443", "has a port"],
    ].entries()) {
      await pingNetworksNow(db, now + i);
      await drain(runnerFor({ baseUrl, version: "0.0.0", fetchImpl: net.fetchImpl }), db, now + i);
      const view = (await caps.getNetworks(system)).networks.find((n) => n.origin === A);
      expect(view?.last_error).toContain(problem);
      // Not the network's fault, so not "not reachable".
      expect(view?.failing_since).toBeNull();
    }
    expect(net.calls).toEqual([]);
  });

  it("uses the Inbox address from Settings when no base URL is injected", async () => {
    const { db, caps } = await freshDb();
    const now = Date.UTC(2026, 8, 21, 15, 30);
    await caps.updateSettings(
      { ...system, now: () => now },
      {
        doc: {
          networks: { [DEFAULT_NETWORK]: { enabled: true } },
          notifications: { appUrl: "https://shop.example.com" },
        },
      },
    );
    const net = fakeNetworks({ known: ["shop.example.com"] });
    await runnerFor({ version: "0.0.0", fetchImpl: net.fetchImpl }).runDue(db, { now });
    expect((await jobs(db, NETWORK_PING_ONE_KIND))[0]?.note).toBe("pinged network.surfingdog.ai as shop.example.com");
    expect(net.calls.map((c) => c.url)).toEqual(["https://network.surfingdog.ai/v1/instances/shop.example.com/ping"]);
  });

  it("keeps the live instance reporting after the upgrade, with nothing for the owner to do", async () => {
    const { db } = await freshDb();
    // What the live instance has stored: the legacy pair, joined, with the default URL.
    await db.client.query({
      sql: "INSERT INTO settings (id, schema_version, doc, version, updated_at) VALUES ('singleton', 1, ?, 3, 0)",
      params: [JSON.stringify({ network: { url: "https://network.surfingdog.ai", join: true } })],
      method: "run",
    });
    const now = Date.UTC(2026, 8, 23, 9, 0, 30);
    await ensureNetworkPing(db, now);
    const net = fakeNetworks({ known: ["inbox.surfingdog.ai"] });
    await drain(
      runnerFor({ baseUrl: "https://inbox.surfingdog.ai", version: "0.0.0", fetchImpl: net.fetchImpl }),
      db,
      now,
    );
    expect(net.calls.map((c) => c.url)).toEqual([
      "https://network.surfingdog.ai/v1/instances/inbox.surfingdog.ai/ping",
    ]);
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
