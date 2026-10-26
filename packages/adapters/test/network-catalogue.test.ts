import {
  type Caller,
  Capabilities,
  createSecretBox,
  JobRunner,
  NETWORK_CATALOGUE_KIND,
  NETWORK_LISTING_KIND,
  NETWORK_PING_KIND,
  NETWORK_PING_ONE_KIND,
  NETWORK_PUBLISH_KIND,
  type PublicJwk,
  readNetworkStatus,
  schema,
  ulid,
  verifyInstanceRequest,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  type NetworkDeps,
  networkCatalogueHandler,
  networkListingHandler,
  networkPingHandler,
  networkPingOneHandler,
  pingNetworksNow,
} from "../src/network";
import { freshDb } from "./db";

/**
 * The business's products on networks, as the inbox tells each network (ADR-029, protocol §4.18):
 * the owner's switch at once, with the signed `POST /v1/instances/{domain}/catalogue`, and the hourly
 * signed ping's `catalogue`, which says when the catalogue changed so the network reads the feed
 * again. Nothing is sent while the switch is off, to a network that has not verified the inbox, or by
 * an inbox that cannot sign; and what a network answers is read leniently. Node and workerd.
 */
const A = "https://network.example.com";
const B = "https://other.example.org";
const KEY = "network-catalogue-instance-key-0123456789";
const BASE = "https://demo.example.com";
const T0 = Date.UTC(2026, 9, 26, 10, 0, 30);
const HOUR = 3_600_000;

const owner = (t: number): Caller => ({
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
});

interface Call {
  readonly network: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
  readonly signed: boolean;
  readonly verified: boolean;
}

async function setup(
  opts: {
    secret?: boolean;
    switchStatus?: () => number;
    pingAnswer?: () => Record<string, unknown>;
    /** Networks that have not verified the inbox: they answer its pings 404. */
    unverified?: readonly string[];
  } = {},
) {
  const { db } = await freshDb();
  const caps = new Capabilities(db, opts.secret === false ? null : createSecretBox([KEY]), BASE, 0);
  const keys = async () => (await caps.receipts.jwks()).keys as PublicJwk[];
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.pathname === "/v1/ranking") return Response.json({ version: 9, next: null });
    const signed = headers["Signature-Input"] !== undefined;
    let verified = false;
    if (signed) {
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
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ network: url.origin, path: url.pathname, body, signed, verified });
    if (url.pathname.endsWith("/ping")) {
      if (opts.unverified?.includes(url.origin)) return new Response(null, { status: 404 });
      if (!verified) return new Response(null, { status: 204 });
      return Response.json({
        ok: true,
        rules: { version: 9, effective_at: "2026-10-20T00:00:00Z" },
        next_rules: null,
        reports: [],
        contests: [],
        ...(opts.pingAnswer ? opts.pingAnswer() : {}),
      });
    }
    if (url.pathname.endsWith("/catalogue")) {
      const status = opts.switchStatus ? opts.switchStatus() : 200;
      return status === 200
        ? Response.json({ listed: body?.listed === true, offers_live: body?.listed === true ? 2 : 0 })
        : Response.json({ code: status === 401 ? "unknown_instance" : "x" }, { status });
    }
    if (url.pathname.endsWith("/listing")) return Response.json({ domain: "demo.example.com", listed: true });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const deps: NetworkDeps = {
    baseUrl: BASE,
    version: "0.0.0",
    fetchImpl,
    instanceKey: async () => (caps.secrets ? caps.receipts.keys.active() : null),
    catalogue: (settings) => caps.catalogue.pingMember(settings),
  };
  const runner = new JobRunner()
    .register(NETWORK_PING_KIND, networkPingHandler(deps))
    .register(NETWORK_PING_ONE_KIND, networkPingOneHandler(deps))
    .register(NETWORK_LISTING_KIND, networkListingHandler(deps))
    .register(NETWORK_CATALOGUE_KIND, networkCatalogueHandler(deps));
  for (const kind of ["notify", "rules", NETWORK_PUBLISH_KIND, "network_receipt", "lifecycle_sweep"]) {
    runner.register(kind, async () => undefined);
  }
  const run = async (t: number) => {
    for (let i = 0; i < 10; i++) if ((await runner.runDue(db, { now: t })).claimed === 0) break;
  };
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
  const write = (t: number, doc: Record<string, unknown>) => caps.updateSettings(owner(t), { doc });
  const switches = () => calls.filter((c) => c.path.endsWith("/catalogue"));
  const pings = () => calls.filter((c) => c.path.endsWith("/ping"));
  await db.orm.insert(schema.products).values({
    id: ulid(T0),
    name: "Moka pot",
    price: { value: 1890, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  return { db, caps, calls, run, tick, register, write, switches, pings };
}

describe("the switch, at once", () => {
  it("tells a verified network once when it comes on, and once when it goes off, signed", async () => {
    const s = await setup();
    await s.write(T0, { networks: { [A]: { enabled: true } } });
    await s.register(A);
    await s.tick(T0);
    expect(s.switches()).toEqual([
      {
        network: A,
        path: "/v1/instances/demo.example.com/catalogue",
        body: { listed: true },
        signed: true,
        verified: true,
      },
    ]);
    expect(await readNetworkStatus(s.db, A)).toMatchObject({ catalogueListed: 1, catalogueError: null });
    // The next hour finds it told, and sends no switch again.
    await s.tick(T0 + HOUR);
    expect(s.switches()).toHaveLength(1);

    await s.write(T0 + 2 * HOUR, { catalogue: { listed: false } });
    await s.run(T0 + 2 * HOUR);
    expect(s.switches().map((c) => c.body)).toEqual([{ listed: true }, { listed: false }]);
    expect(await readNetworkStatus(s.db, A)).toMatchObject({ catalogueListed: 0 });
  });

  it("is retried when a network fails, and waits for the next hour when it asks to", async () => {
    let status = 503;
    const s = await setup({ switchStatus: () => status });
    await s.write(T0, { networks: { [A]: { enabled: true } } });
    await s.register(A);
    await s.tick(T0);
    expect(s.switches().length).toBeGreaterThanOrEqual(1);
    expect(await readNetworkStatus(s.db, A)).toMatchObject({ catalogueListed: null });
    status = 429;
    const before = s.switches().length;
    await s.tick(T0 + HOUR);
    expect(s.switches().length).toBeGreaterThan(before);
    expect(await readNetworkStatus(s.db, A)).toMatchObject({ catalogueListed: null });
    status = 200;
    await s.tick(T0 + 2 * HOUR);
    expect(await readNetworkStatus(s.db, A)).toMatchObject({ catalogueListed: 1 });
  });

  it("tells a network that has not verified the inbox yet again at the next hour, with nothing wrong to show", async () => {
    let status = 401;
    const s = await setup({ switchStatus: () => status });
    await s.write(T0, { networks: { [A]: { enabled: true } } });
    await s.register(A);
    await s.tick(T0);
    expect(s.switches()).toHaveLength(1);
    expect(await readNetworkStatus(s.db, A)).toMatchObject({
      catalogueListed: null,
      catalogueError: null,
      lastError: null,
    });
    status = 200;
    await s.tick(T0 + HOUR);
    expect(s.switches()).toHaveLength(2);
    expect(await readNetworkStatus(s.db, A)).toMatchObject({ catalogueListed: 1, catalogueError: null });
  });

  it("asks a network that lists no products (404) no more for a day", async () => {
    const s = await setup({ switchStatus: () => 404 });
    await s.write(T0, { networks: { [A]: { enabled: true } } });
    await s.register(A);
    await s.tick(T0);
    expect(s.switches()).toHaveLength(1);
    expect(await readNetworkStatus(s.db, A)).toMatchObject({ catalogueError: expect.stringContaining("no products") });
    await s.tick(T0 + HOUR);
    expect(s.switches()).toHaveLength(1);
    await s.tick(T0 + 25 * HOUR);
    expect(s.switches()).toHaveLength(2);
  });

  it("sends nothing while off, to a network that has not verified the inbox, or from an inbox that cannot sign", async () => {
    const off = await setup();
    await off.write(T0, { networks: { [A]: { enabled: true } }, catalogue: { listed: false } });
    await off.register(A);
    await off.tick(T0);
    expect(off.switches()).toEqual([]);

    const unverified = await setup({ unverified: [B] });
    await unverified.write(T0, { networks: { [B]: { enabled: true } } });
    await unverified.tick(T0);
    expect(unverified.switches()).toEqual([]);

    const unsigned = await setup({ secret: false });
    await unsigned.write(T0, { networks: { [A]: { enabled: true } } });
    await unsigned.register(A);
    await unsigned.tick(T0);
    expect(unsigned.switches()).toEqual([]);
    expect(unsigned.pings().every((p) => p.body && !("catalogue" in p.body))).toBe(true);
  });
});

describe("the hourly signed ping", () => {
  it("carries the catalogue's count and rev while the products are listed there, and changes rev with them", async () => {
    const s = await setup();
    await s.write(T0, { networks: { [A]: { enabled: true } } });
    await s.register(A);
    await s.tick(T0);
    const first = s.pings().at(-1)?.body?.catalogue as { listed: boolean; count: number; rev: string };
    expect(first).toMatchObject({ listed: true, count: 1, rev: expect.stringMatching(/^[0-9a-f]{16}$/) });
    const [moka] = await s.caps.setup.listProducts(owner(T0));
    await s.caps.setup.updateProduct(owner(T0 + 1000), { product_id: moka?.id as string, name: "Moka pot, 6 cups" });
    await s.tick(T0 + HOUR);
    const second = s.pings().at(-1)?.body?.catalogue as { rev: string };
    expect(second.rev).not.toBe(first.rev);
    // The ping still carries the manifest's hash and its other members as before.
    expect(s.pings().at(-1)?.body).toMatchObject({ version: "0.0.0" });
  });

  it("says not listed once to a network last told they were, when the switch did not reach it, then nothing", async () => {
    let status = 200;
    const s = await setup({ switchStatus: () => status });
    await s.write(T0, { networks: { [A]: { enabled: true } } });
    await s.register(A);
    await s.tick(T0);
    expect(await readNetworkStatus(s.db, A)).toMatchObject({ catalogueListed: 1 });
    // The switch off does not reach it: the next signed ping says it instead.
    status = 404;
    await s.write(T0 + HOUR, { networks: { [A]: { share: { catalogue: false } } } });
    // The hour's own tick may run beside the one asked for here, so this hour may hold two pings.
    const before = s.pings().length;
    await s.tick(T0 + HOUR);
    const hour = s.pings().slice(before);
    expect(hour[0]?.body?.catalogue).toEqual({ listed: false });
    expect(hour.slice(1).every((p) => !p.body || !("catalogue" in p.body))).toBe(true);
    expect(await readNetworkStatus(s.db, A)).toMatchObject({ catalogueListed: 0 });
    await s.tick(T0 + 2 * HOUR);
    expect(s.pings().at(-1)?.body).not.toHaveProperty("catalogue");
  });

  it("keeps what the network's answer says of the products, read leniently", async () => {
    let answer: Record<string, unknown> = {
      catalogue: {
        listed: true,
        offers_live: 209,
        held: [
          {
            why: "Its name looks like a template's sample.",
            count: 3,
            sample: [{ id: "p1", name: "Product name" }, { id: 7 }],
          },
          { why: "", count: 1, sample: [] },
        ],
        checked_at: "2026-10-26T10:42:00Z",
        extra: "ignored",
      },
    };
    const s = await setup({ pingAnswer: () => answer });
    await s.write(T0, { networks: { [A]: { enabled: true } } });
    await s.register(A);
    await s.tick(T0);
    expect(await readNetworkStatus(s.db, A)).toMatchObject({
      catalogue: {
        listed: true,
        offers_live: 209,
        held: [
          { why: "Its name looks like a template's sample.", count: 3, sample: [{ id: "p1", name: "Product name" }] },
        ],
        checked_at: "2026-10-26T10:42:00Z",
      },
    });
    // An answer whose block does not read keeps the last one, and the rest of the answer counts.
    answer = { catalogue: { listed: "yes" } };
    await s.tick(T0 + HOUR);
    expect((await readNetworkStatus(s.db, A))?.catalogue?.offers_live).toBe(209);
    expect((await readNetworkStatus(s.db, A))?.pingSignature).toBe("verified");
  });
});
