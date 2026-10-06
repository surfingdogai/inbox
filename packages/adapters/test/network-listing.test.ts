import {
  type Caller,
  Capabilities,
  createSecretBox,
  JobRunner,
  NETWORK_LISTING_KIND,
  NETWORK_PING_KIND,
  NETWORK_PING_ONE_KIND,
  NETWORK_PUBLISH_KIND,
  type PublicJwk,
  readNetworkStatus,
  verifyInstanceRequest,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  type NetworkDeps,
  networkListingHandler,
  networkPingHandler,
  networkPingOneHandler,
  pingNetworksNow,
} from "../src/network";
import { freshDb } from "./db";

/**
 * Leaving the directory really leaves it (ADR-017 A2.3). Switching the listing off — for every
 * network in Settings, or for one network, or switching a network off entirely — tells each network
 * that verified this inbox with a signed `POST /v1/instances/{domain}/listing`, once; a network
 * that asked to wait (429), or a job that was lost, is caught up by the hourly tick; an inbox that
 * cannot sign calls nothing and leaves it to its manifest. Node and workerd.
 */
const A = "https://network.example.com";
const B = "https://other.example.org";
const KEY = "network-listing-instance-key-0123456789";
const BASE = "https://demo.example.com";
const T0 = Date.UTC(2026, 9, 6, 10, 0, 30);

const owner = (t: number): Caller => ({
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
});

interface ListingCall {
  readonly network: string;
  readonly path: string;
  readonly body: unknown;
  readonly verified: boolean;
}

async function setup(opts: { secret?: boolean; registered?: readonly string[]; answer?: () => number } = {}) {
  const { db } = await freshDb();
  const caps = new Capabilities(db, opts.secret === false ? null : createSecretBox([KEY]), BASE, 0);
  const keys = async () => (await caps.receipts.jwks()).keys as PublicJwk[];
  const calls: ListingCall[] = [];
  let known = new Set<string>(opts.registered ?? [A]);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.pathname === "/v1/ranking") return Response.json({ version: 3, next: null });
    if (url.pathname === "/v1/instances") {
      known = new Set([...known, url.origin]);
      return Response.json({ ok: true }, { status: 201 });
    }
    if (url.pathname.endsWith("/ping")) {
      return known.has(url.origin) ? new Response(null, { status: 204 }) : new Response(null, { status: 404 });
    }
    let verified = false;
    try {
      const v = await verifyInstanceRequest({
        method: init?.method ?? "GET",
        url: url.href,
        headers,
        body: String(init?.body ?? ""),
        authorities: [url.host],
        now: Date.now(),
        keysFor: async (domain) => (domain === "demo.example.com" ? keys() : null),
      });
      verified = v.domain === "demo.example.com";
    } catch {
      verified = false;
    }
    calls.push({ network: url.origin, path: url.pathname, body: JSON.parse(String(init?.body ?? "null")), verified });
    const status = opts.answer ? opts.answer() : 200;
    return Response.json(status === 200 ? { domain: "demo.example.com", listed: true } : { code: "x" }, { status });
  }) as typeof fetch;
  const deps: NetworkDeps = {
    baseUrl: BASE,
    version: "0.0.0",
    fetchImpl,
    instanceKey: async () => (caps.secrets ? caps.receipts.keys.active() : null),
  };
  const runner = new JobRunner()
    .register(NETWORK_PING_KIND, networkPingHandler(deps))
    .register(NETWORK_PING_ONE_KIND, networkPingOneHandler(deps))
    .register(NETWORK_LISTING_KIND, networkListingHandler(deps));
  for (const kind of ["notify", "rules", NETWORK_PUBLISH_KIND, "network_receipt", "lifecycle_sweep"]) {
    runner.register(kind, async () => undefined);
  }
  const run = async (t: number) => {
    for (let i = 0; i < 10; i++) if ((await runner.runDue(db, { now: t })).claimed === 0) break;
  };
  /** The hourly tick, as the cron queues it. */
  const tick = async (t: number) => {
    await pingNetworksNow(db, t);
    await run(t);
  };
  const register = async (network: string) =>
    db.client.query({
      sql: `INSERT INTO network_status (network, registration, registered_at, failures, updated_at) VALUES (?, 'registered', ?, 0, ?)
            ON CONFLICT (network) DO UPDATE SET registration = 'registered'`,
      params: [network, T0, T0],
      method: "run",
    });
  const notes = async () =>
    (
      await db.client.query({
        sql: "SELECT last_error FROM jobs WHERE kind = ? ORDER BY created_at, id",
        params: [NETWORK_LISTING_KIND],
        method: "all",
      })
    ).rows.map((r) => r[0]);
  const write = (t: number, doc: Record<string, unknown>) => caps.updateSettings(owner(t), { doc });
  return { db, caps, calls, run, tick, register, notes, write };
}

describe("telling a network the business left its directory", () => {
  it("sends one signed listing call when the owner leaves the directories, and one when they come back", async () => {
    const s = await setup();
    await s.write(T0, { networks: { [A]: { enabled: true } } });
    await s.register(A);
    await s.run(T0);
    // Listed and never told otherwise: there is nothing to say.
    expect(s.calls).toEqual([]);

    await s.write(T0 + 1_000, { directory: { listed: false } });
    await s.run(T0 + 1_000);
    expect(s.calls).toEqual([
      { network: A, path: "/v1/instances/demo.example.com/listing", body: { listed: false }, verified: true },
    ]);
    expect(await readNetworkStatus(s.db, A)).toMatchObject({ listed: 0, listedAt: T0 + 1_000 });

    // The hourly tick finds it told, and calls nothing more.
    await s.tick(T0 + 3_600_000);
    expect(s.calls).toHaveLength(1);

    await s.write(T0 + 2 * 3_600_000, { directory: { listed: true } });
    await s.run(T0 + 2 * 3_600_000);
    expect(s.calls.map((c) => c.body)).toEqual([{ listed: false }, { listed: true }]);
    expect(await readNetworkStatus(s.db, A)).toMatchObject({ listed: 1 });
  });

  it("tells only the network whose listing was switched off", async () => {
    const s = await setup({ registered: [A, B] });
    await s.write(T0, { networks: { [A]: { enabled: true }, [B]: { enabled: true } } });
    await s.register(A);
    await s.register(B);
    await s.write(T0 + 1_000, { networks: { [B]: { share: { listing: false } } } });
    await s.run(T0 + 1_000);
    expect(s.calls.map((c) => [c.network, c.body])).toEqual([[B, { listed: false }]]);
  });

  it("tells a network switched off entirely, through the hourly tick when nothing else is on", async () => {
    const s = await setup();
    await s.write(T0, { networks: { [A]: { enabled: true } } });
    await s.register(A);
    await s.write(T0 + 1_000, { networks: { [A]: { enabled: false } } });
    // The job the write queued is lost; the tick, with no network on at all, still catches it up.
    await s.db.client.query({ sql: "DELETE FROM jobs", params: [], method: "run" });
    await s.tick(T0 + 3_600_000);
    expect(s.calls.map((c) => [c.network, c.body, c.verified])).toEqual([[A, { listed: false }, true]]);
    expect(await readNetworkStatus(s.db, A)).toMatchObject({ listed: 0 });
  });

  it("waits for the next hourly tick when the network answers 429, and records only a 200", async () => {
    const answers = [429, 200];
    const s = await setup({ answer: () => answers.shift() ?? 200 });
    await s.write(T0, { networks: { [A]: { enabled: true } } });
    await s.register(A);
    await s.run(T0);
    await s.write(T0 + 1_000, { directory: { listed: false } });
    await s.run(T0 + 1_000);
    expect(s.calls).toHaveLength(1);
    expect((await readNetworkStatus(s.db, A))?.listed).toBeNull();
    expect((await s.notes()).at(-1)).toBe("network.example.com asked to wait (HTTP 429); the hourly tick asks again");

    await s.tick(T0 + 3_600_000);
    expect(s.calls.map((c) => c.body)).toEqual([{ listed: false }, { listed: false }]);
    expect(await readNetworkStatus(s.db, A)).toMatchObject({ listed: 0, listedAt: T0 + 3_600_000 });
  });

  it("calls nothing from an inbox that cannot sign: the manifest says it", async () => {
    const s = await setup({ secret: false });
    await s.write(T0, { networks: { [A]: { enabled: true } } });
    await s.register(A);
    await s.write(T0 + 1_000, { directory: { listed: false } });
    await s.run(T0 + 1_000);
    expect(s.calls).toEqual([]);
    expect((await s.notes()).at(-1)).toBe("network.example.com: cannot sign; the manifest carries directory.listed");
    expect((await readNetworkStatus(s.db, A))?.listed).toBeNull();
  });

  it("calls nothing at a network that has not verified this inbox", async () => {
    const s = await setup();
    await s.write(T0, { networks: { [A]: { enabled: true } } });
    await s.write(T0 + 1_000, { directory: { listed: false } });
    // Only the listing jobs: the ping would register the inbox there, and then tell the network.
    await s.db.client.query({ sql: "DELETE FROM jobs WHERE kind <> ?", params: [NETWORK_LISTING_KIND], method: "run" });
    await s.run(T0 + 1_000);
    expect(s.calls).toEqual([]);
    expect((await s.notes()).at(-1)).toBe("network.example.com: not registered; the manifest says it");
  });

  it("tells a network at once when this inbox registers there without its listing", async () => {
    const s = await setup({ registered: [] });
    await s.write(T0, { networks: { [A]: { enabled: true, share: { listing: false, counts: true } } } });
    await s.tick(T0);
    expect(await readNetworkStatus(s.db, A)).toMatchObject({ registration: "registered", listed: 0 });
    expect(s.calls.map((c) => c.body)).toEqual([{ listed: false }]);
  });
});
