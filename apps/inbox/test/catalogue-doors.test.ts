import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import { type Caller, schema, ulid } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { type App, createApp, createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * The catalogue at the doors, as customers, their agents and the owner's AI read it: a product's
 * public fields only, never where it came from (a feed's address can hold its key), and each price
 * written in its own currency. Node and workerd.
 */
const T0 = Date.parse("2026-10-20T09:00:00Z");
const FEED = "feed:https://shop.example/products.xml?token=feed-secret-0123";

async function connect(app: App, path: string, headers: Record<string, string> = {}) {
  const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const merged = new Headers(init?.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    return app.request(String(input), { ...init, headers: merged });
  };
  const transport = new StreamableHTTPClientTransport(new URL(`https://inbox.test${path}`), { fetch: fetchLike });
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(transport);
  return client;
}

async function setup() {
  const db = await freshDb();
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Harbour Bikes",
    timezone: "America/Toronto",
    currency: "EUR",
    createdAt: T0,
    updatedAt: T0,
  });
  await db.orm.insert(schema.products).values({
    id: ulid(),
    sku: "LUBE-100",
    name: "Chain lube",
    price: { value: 850, currency: "EUR" },
    source: FEED,
    externalId: "ext-1001",
    createdAt: T0,
    updatedAt: T0,
  });
  return { db, app: createApp({ db }) };
}

const PUBLIC_FIELDS = [
  "active",
  "availability",
  "brand",
  "condition",
  "description",
  "gtin",
  "id",
  "image_url",
  "mpn",
  "name",
  "negotiable",
  "no_gtin",
  "price",
  "sku",
  "stock",
  "updated_at",
  "url",
  "withdrawal",
];

describe("products at the public doors", () => {
  it("REST answers each product with its public fields only", async () => {
    const { app } = await setup();
    const res = await app.request("https://inbox.test/v1/products");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/feed-secret|ext-1001|feed:|created_at|createdAt|location/i);
    const page = JSON.parse(text) as { items: Record<string, unknown>[] };
    expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual(PUBLIC_FIELDS);
  });

  it("MCP list_products answers with the same public fields", async () => {
    const { app } = await setup();
    const client = await connect(app, "/mcp");
    const r = await client.callTool({ name: "list_products", arguments: {} });
    expect(r.isError).toBeFalsy();
    const page = r.structuredContent as { items: Record<string, unknown>[] };
    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual(PUBLIC_FIELDS);
    expect(JSON.stringify(r)).not.toMatch(/feed-secret|ext-1001|feed:/);
  });
});

describe("list_products by id and by barcode (ADR-029)", () => {
  it("answers the products a network showed, by their ids or their barcode, and refuses one that is no barcode", async () => {
    const { db, app } = await setup();
    const id = ulid();
    await db.orm.insert(schema.products).values({
      id,
      name: "Moka pot",
      price: { value: 1890, currency: "EUR" },
      gtin: "04006381333931",
      createdAt: T0,
      updatedAt: T0,
    });
    const client = await connect(app, "/mcp");
    const byIds = await client.callTool({ name: "list_products", arguments: { ids: [id] } });
    expect((byIds.structuredContent as { items: { id: string }[] }).items.map((p) => p.id)).toEqual([id]);
    const byGtin = await client.callTool({ name: "list_products", arguments: { gtin: "4006381333931" } });
    expect((byGtin.structuredContent as { items: { gtin: string }[] }).items).toEqual([
      expect.objectContaining({ id, gtin: "04006381333931", availability: "on_sale" }),
    ]);
    const bad = await client.callTool({ name: "list_products", arguments: { gtin: "4006381333932" } });
    expect(bad.isError).toBe(true);
  });
});

describe("prices in words", () => {
  const owner: Caller = {
    actor: { kind: "owner", id: "u1", channel: "owner_ui" },
    tier: "verified_principal",
    sandbox: false,
    now: () => T0,
  };

  it("writes each price in its own currency at both doors, and lists no yen it cannot count", async () => {
    const db = await freshDb();
    await db.orm.insert(schema.business).values({
      id: "self",
      name: "Kissa Records",
      timezone: "Asia/Tokyo",
      currency: "EUR",
      createdAt: T0,
      updatedAt: T0,
    });
    const inbox = createInbox({ db, background: () => {} });
    const feed = await inbox.caps.feeds.add(owner, { url: "https://records.example.com/feed.csv" });
    // The body is handed in below: the import connecting queued would fetch the feed in the
    // background of the calls that follow, after the test has ended.
    await db.client.query({ sql: "DELETE FROM jobs", method: "run" });
    // A record shop's feed, in three currencies: one of them is not counted in hundredths here.
    await inbox.caps.feeds.importBody(
      feed.id,
      [
        "id,title,price",
        "R1,Vinyl record,4980 JPY",
        "R2,Record sleeve,12.00 USD",
        "R3,Cleaning cloth,8.50 EUR",
        "R4,Record mat,9.5 GBP",
        "R5,Record brush,2500.50 HUF",
      ].join("\n"),
      T0,
    );
    const pub = await connect(inbox.app, "/mcp");
    const listed = await pub.callTool({ name: "list_products", arguments: {} });
    const text = (listed.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("Record sleeve US$12.00 (id ");
    expect(text).toContain("Cleaning cloth €8.50 (id ");
    expect(text).toContain("Record mat £9.50 (id ");
    // Every amount here is in hundredths, forints too: never HUF 2,501.
    expect(text).toMatch(/Record brush HUF\s2,500\.50 \(id /);
    // Never ¥49.80, nor €4,980.00: a price in yen is no price here, so the record is not on sale.
    expect(text).not.toContain("Vinyl record");

    const key = await createApiKey(db, { kind: "owner", name: "t" });
    const own = await connect(inbox.app, "/mcp/owner", { authorization: `Bearer ${key.key}` });
    const ownText = ((await own.callTool({ name: "list_products", arguments: {} })).content as { text: string }[])[0]
      ?.text;
    expect(ownText).toContain(": Cleaning cloth €8.50");
    expect(ownText).toContain(": Record sleeve US$12.00");
    expect(ownText).toMatch(/: Record brush HUF\s2,500\.50/);
    expect(ownText).toMatch(/: Vinyl record €0\.00 \(archived\)/);
  });
});
