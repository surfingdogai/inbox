import { pingNetworksNow } from "@surfingdog/adapters";
import { createDb, type Db, MIGRATIONS, readSettings } from "@surfingdog/core";
import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { makeClient } from "./harness";

/**
 * The upgrade to the catalogue (migration 0026, ADR-029), as a live inbox meets it: its products keep
 * every value and gain the new columns' defaults, nothing is backfilled, and "Your products on
 * networks" is on (the founder, 26 October 2026: on by default). What it sends a network that verified
 * it is the ping's `catalogue` and one signed switch, and nothing else new; an inbox that cannot sign
 * sends nothing new at all. Runs on Node and in workerd.
 */
const INBOX = "https://inbox.lojamoka.com";
const NET = "https://network.surfingdog.ai";
const T0 = Date.now() - 86_400_000;

async function before0026(secret: boolean) {
  const client = await makeClient();
  const before = MIGRATIONS.filter((m) => m.name < "0026_catalogue");
  expect(await runMigrations(client, before)).toBe(before.length);
  await client.batch([
    {
      sql: `INSERT INTO products (id, sku, name, price, stock, source, external_id, active, created_at, updated_at)
            VALUES ('p1', '4006381333931', 'Moka pot', '{"value":1890,"currency":"EUR"}', 3, 'feed:https://loja.example/f.csv', 'x1', 1, ?, ?)`,
      params: [T0, T0],
      method: "run",
    },
    {
      sql: "INSERT INTO settings (id, schema_version, doc, version, updated_at) VALUES ('singleton', 1, ?, 3, ?)",
      params: [JSON.stringify({ networks: { [NET]: { enabled: true } } }), T0],
      method: "run",
    },
    {
      sql: "INSERT INTO network_status (network, registration, registered_at, failures, updated_at) VALUES (?, 'registered', ?, 0, ?)",
      params: [NET, T0, T0],
      method: "run",
    },
  ]);
  expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
  expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
  const db = createDb(client);
  return { db, ...inboxOn(db, secret) };
}

/** The inbox over `db`, with a network that knows it, and every call it makes. */
function inboxOn(db: Db, secret: boolean) {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.pathname.endsWith("/ping")) return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/catalogue")) return Response.json({ listed: true, offers_live: 1 });
    if (url.pathname === "/v1/ranking") return Response.json({ version: 9, next: null });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const inbox = createInbox({
    db,
    baseUrl: INBOX,
    fetchImpl,
    background: () => {},
    ...(secret ? { secretKey: "upgrade-catalogue-secret-0123456789abcdef" } : {}),
  });
  const drain = async () => {
    await pingNetworksNow(db, Date.now());
    for (let i = 0; i < 20; i++) if ((await inbox.runner.runDue(db, { workerId: "test" })).claimed === 0) return;
  };
  return { inbox, calls, drain };
}

const unsignedInbox = (db: Db) => inboxOn(db, false);

describe("upgrading to the catalogue", () => {
  // One test for the upgrade itself: on workerd a file starts with an empty database, and this needs it.
  it("keeps every product as it was, switches the catalogue on, and tells a verified network only the ping's catalogue and one signed switch", async () => {
    const s = await before0026(true);
    const { rows } = await s.db.client.query({
      sql: "SELECT sku, name, stock, active, gtin, gtin_given, no_gtin, brand, condition, url, listed, catalogue_seq FROM products",
      method: "all",
    });
    // The sku is a valid barcode, and stays only a sku: the owner is offered it once, nothing copies it.
    expect(rows).toEqual([["4006381333931", "Moka pot", 3, 1, null, null, 0, null, "new", null, 1, 0]]);
    expect((await readSettings(s.db)).catalogue).toEqual({ listed: true, taxIncluded: null, skuBarcodes: "ask" });

    await s.drain();
    const pings = s.calls.filter((c) => c.path.endsWith("/ping"));
    expect(pings.length).toBeGreaterThan(0);
    expect(pings[0]?.body?.catalogue).toMatchObject({ listed: true, count: 1 });
    expect(s.calls.filter((c) => c.path.endsWith("/catalogue")).map((c) => c.body)).toEqual([{ listed: true }]);
    for (const p of new Set(s.calls.map((c) => c.path))) {
      expect([
        "/v1/instances/inbox.lojamoka.com/ping",
        "/v1/instances/inbox.lojamoka.com/catalogue",
        "/v1/ranking",
      ]).toContain(p);
    }

    // The same inbox without INBOX_SECRET_KEY, its network never told: it sends nothing new at all.
    await s.db.client.query({ sql: "DELETE FROM jobs", method: "run" });
    await s.db.client.query({ sql: "UPDATE network_status SET catalogue_listed = NULL", method: "run" });
    const unsigned = unsignedInbox(s.db);
    await unsigned.drain();
    expect(unsigned.calls.filter((c) => c.path.endsWith("/catalogue"))).toEqual([]);
    for (const p of unsigned.calls.filter((c) => c.path.endsWith("/ping")))
      expect(p.body).not.toHaveProperty("catalogue");
  });
});
