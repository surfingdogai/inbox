import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { schema, ulid } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { type App, createApp } from "../src/app";
import { freshDb } from "./harness";

/**
 * The catalogue at the public doors, as customers and their agents read it: a product's public
 * fields only, never where it came from (a feed's address can hold its key). Node and workerd.
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
