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

const PUBLIC_FIELDS = ["active", "description", "id", "name", "negotiable", "price", "sku", "stock", "withdrawal"];

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

describe("prices in words", () => {
  const owner: Caller = {
    actor: { kind: "owner", id: "u1", channel: "owner_ui" },
    tier: "verified_principal",
    sandbox: false,
    now: () => T0,
  };

  it("writes each price in its own currency, yen with no minor unit, at both doors", async () => {
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
    // A record shop's feed, priced in yen.
    const feed = await inbox.caps.feeds.add(owner, { url: "https://records.example.com/feed.csv" });
    await inbox.caps.feeds.importBody(
      feed.id,
      ["id,title,price", "R1,Vinyl record,4980 JPY", "R2,Record sleeve,¥350", "R3,Cleaning cloth,8.50 EUR"].join("\n"),
      T0,
    );
    const pub = await connect(inbox.app, "/mcp");
    const listed = await pub.callTool({ name: "list_products", arguments: {} });
    const text = (listed.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("Vinyl record JP¥4,980 (id ");
    expect(text).toContain("Record sleeve JP¥350 (id ");
    expect(text).toContain("Cleaning cloth €8.50 (id ");

    const key = await createApiKey(db, { kind: "owner", name: "t" });
    const own = await connect(inbox.app, "/mcp/owner", { authorization: `Bearer ${key.key}` });
    const ownText = ((await own.callTool({ name: "list_products", arguments: {} })).content as { text: string }[])[0]
      ?.text;
    expect(ownText).toContain(": Vinyl record JP¥4,980");
    expect(ownText).toContain(": Cleaning cloth €8.50");
  });
});
