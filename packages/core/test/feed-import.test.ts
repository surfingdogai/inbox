import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * Feed import end to end, minus the network (ADR-015 §7.3): the body is handed in, because what
 * goes wrong with a feed is the content, and the fetching is tested separately.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");

const owner: Caller = {
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const customer: Caller = {
  actor: { kind: "customer_agent", id: "agent:claude", channel: "mcp_public" },
  tier: "signed_agent",
  sandbox: false,
  now: () => T0,
};

async function setup(): Promise<{ db: Db; caps: Capabilities }> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  return { db, caps: new Capabilities(db) };
}

const FEED_V1 = [
  "id,title,description,price,quantity",
  "A1,Chain lube,100ml,8.50,10",
  "A2,Inner tube,700x25c,4.99,4",
  "A3,Bar tape,Cork,14.00,2",
].join("\n");

describe("connecting a feed", () => {
  it("stores the URL, needs no credentials, and queues the first import at once", async () => {
    const { db, caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "shop.example.com/feed.csv" });

    expect(feed.url).toBe("https://shop.example.com/feed.csv");
    expect(feed.name).toBe("shop.example.com");
    expect(feed.status).toBe("configured");
    expect(feed.product_count).toBe(0);

    // No credentials anywhere: that is the whole point of a feed.
    const { rows } = await db.client.query({ sql: "SELECT config_enc FROM connectors", method: "all" });
    expect(rows[0]?.[0]).toBeNull();

    const jobs = await db.client.query({ sql: "SELECT kind FROM jobs", method: "all" });
    expect(jobs.rows.map((r) => (r as unknown[])[0])).toContain("feed_import");
  });

  it("refuses an address on this machine or this network", async () => {
    const { caps } = await setup();
    for (const url of ["http://localhost:8080/feed.csv", "https://192.168.1.10/feed", "https://nas.local/feed.xml"]) {
      await expect(caps.feeds.add(owner, { url }), url).rejects.toThrow();
    }
  });

  it("upgrades http, because a price list read over a rewritable connection is not a price list", async () => {
    const { caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "http://shop.example.com/feed.csv" });
    expect(feed.url.startsWith("https://")).toBe(true);
  });

  it("will not connect the same feed twice", async () => {
    const { caps } = await setup();
    await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    await expect(caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" })).rejects.toThrow(/already/);
  });

  it("is the owner's, not a customer agent's", async () => {
    const { caps } = await setup();
    await expect(caps.feeds.add(customer, { url: "https://shop.example.com/feed.csv" })).rejects.toThrow();
    await expect(caps.feeds.list(customer)).rejects.toThrow();
  });
});

describe("importing", () => {
  it("creates the catalogue, then updates only what changed", async () => {
    const { caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });

    const first = await caps.feeds.importBody(feed.id, FEED_V1, T0);
    expect(first.format).toBe("csv");
    expect(first.created).toBe(3);
    expect(first.updated).toBe(0);
    expect(first.deactivated).toBe(0);

    const products = await caps.setup.listProducts(owner);
    expect(products).toHaveLength(3);
    expect(products.find((p) => p.name === "Chain lube")?.price).toEqual({ value: 850, currency: "EUR" });

    // The same feed again changes nothing at all.
    const again = await caps.feeds.importBody(feed.id, FEED_V1, T0 + 1000);
    expect(again.created).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.unchanged).toBe(3);

    // One price moves.
    const dearer = FEED_V1.replace("8.50", "9.25");
    const third = await caps.feeds.importBody(feed.id, dearer, T0 + 2000);
    expect(third.updated).toBe(1);
    expect(third.unchanged).toBe(2);
    const after = await caps.setup.listProducts(owner);
    expect(after.find((p) => p.name === "Chain lube")?.price).toEqual({ value: 925, currency: "EUR" });
  });

  it("keeps the last price when a row leaves it out, and never puts a row with no price ever on sale", async () => {
    const { caps } = await setup();
    // A hardware shop in Pune: its prices are in rupees, and its feed names no currency.
    await caps.updateSettings(owner, { doc: { business: { currency: "INR" } } });
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    await caps.feeds.importBody(feed.id, ["id,title,price", "B1,Hammer,250.00", "B2,Spirit level,"].join("\n"), T0);
    const first = await caps.setup.listProducts(owner);
    expect(first.find((p) => p.name === "Hammer")).toMatchObject({
      active: 1,
      price: { value: 25_000, currency: "INR" },
    });
    // No price: kept off sale, in the business's own currency, never a currency guessed for it.
    expect(first.find((p) => p.name === "Spirit level")).toMatchObject({
      active: 0,
      price: { value: 0, currency: "INR" },
    });
    expect((await caps.listProducts({ limit: 50 })).items.map((p) => p.name)).toEqual(["Hammer"]);

    // A row that leaves its price out has not made it free: the last price stays, on sale.
    await caps.feeds.importBody(feed.id, ["id,title,price", "B1,Hammer,", "B2,Spirit level,"].join("\n"), T0 + 1000);
    const second = await caps.setup.listProducts(owner);
    expect(second.find((p) => p.name === "Hammer")).toMatchObject({ active: 1, price: { value: 25_000 } });
    expect(second.find((p) => p.name === "Spirit level")).toMatchObject({ active: 0 });

    // Once it has a price, it is on sale.
    await caps.feeds.importBody(
      feed.id,
      ["id,title,price", "B1,Hammer,250", "B2,Spirit level,99"].join("\n"),
      T0 + 2000,
    );
    expect((await caps.setup.listProducts(owner)).find((p) => p.name === "Spirit level")).toMatchObject({
      active: 1,
      price: { value: 9_900, currency: "INR" },
    });
  });

  it("prices a feed that names no currency in the business's own, as its profile gives it", async () => {
    const { db, caps } = await setup();
    // A hardware shop in Pune sets its currency where the owner app and the owner's tools do.
    await caps.setup.updateProfile(owner, { currency: "INR" });
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    expect(feed.currency).toBe("INR");
    await caps.feeds.importBody(feed.id, ["id,title,price", "B1,Hammer,250.00", "B2,Spirit level,"].join("\n"), T0);
    const listed = await caps.setup.listProducts(owner);
    expect(listed.find((p) => p.name === "Hammer")?.price).toEqual({ value: 25_000, currency: "INR" });
    expect(listed.find((p) => p.name === "Spirit level")?.price).toEqual({ value: 0, currency: "INR" });

    // A feed connected before it kept a currency of its own reads the profile's too.
    await db.client.query({
      sql: "UPDATE connectors SET config_public = ? WHERE id = ?",
      params: [JSON.stringify({ url: feed.url }), feed.id],
      method: "run",
    });
    expect((await caps.feeds.get(owner, feed.id)).currency).toBe("INR");
    await caps.feeds.importBody(feed.id, ["id,title,price", "B1,Hammer,260.00"].join("\n"), T0 + 1000);
    expect((await caps.setup.listProducts(owner)).find((p) => p.name === "Hammer")?.price).toEqual({
      value: 26_000,
      currency: "INR",
    });
  });

  it("sells at a sale's price while it runs on the business's own clock, and at the regular price after", async () => {
    const { caps } = await setup();
    await caps.updateSettings(owner, { doc: { business: { timezone: "America/Vancouver", currency: "CAD" } } });
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    const body = [
      "id,title,price,sale_price,sale_price_effective_date",
      "H1,Helmet,80.00,60.00,2026-10-01/2026-10-20",
    ].join("\n");
    // 02:00 on the 21st in UTC is still the evening of the 20th in Vancouver: the sale is on.
    await caps.feeds.importBody(feed.id, body, Date.parse("2026-10-21T02:00:00Z"));
    expect((await caps.setup.listProducts(owner))[0]?.price).toEqual({ value: 6_000, currency: "CAD" });
    // The next morning there, it is over.
    await caps.feeds.importBody(feed.id, body, Date.parse("2026-10-21T16:00:00Z"));
    expect((await caps.setup.listProducts(owner))[0]?.price).toEqual({ value: 8_000, currency: "CAD" });
  });

  it("deactivates what leaves the feed and never deletes it", async () => {
    const { db, caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    await caps.feeds.importBody(feed.id, FEED_V1, T0);

    const shorter = FEED_V1.split("\n")
      .filter((line) => !line.startsWith("A3"))
      .join("\n");
    const result = await caps.feeds.importBody(feed.id, shorter, T0 + 1000);
    expect(result.deactivated).toBe(1);

    const { rows } = await db.client.query({
      sql: "SELECT name, active FROM products WHERE external_id = 'A3'",
      method: "all",
    });
    // Still there, so an order that points at it keeps its history.
    expect(rows).toHaveLength(1);
    expect((rows[0] as unknown[])[1]).toBe(0);

    // And it comes back when the feed does.
    const back = await caps.feeds.importBody(feed.id, FEED_V1, T0 + 2000);
    expect(back.created).toBe(0);
    expect(back.updated).toBe(1);
    expect((await caps.feeds.get(owner, feed.id)).product_count).toBe(3);
  });

  it("deactivates nothing when the read was truncated, because a short read is not an absence", async () => {
    const { caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    await caps.feeds.importBody(feed.id, FEED_V1, T0);

    // A feed that suddenly hits the row cap must not empty the shop.
    const huge = ["id,title,price", ...Array.from({ length: 6000 }, (_, i) => `B${i},Item ${i},1.00`)].join("\n");
    const result = await caps.feeds.importBody(feed.id, huge, T0 + 1000);
    expect(result.truncated).toBe(true);
    expect(result.deactivated).toBe(0);
  });

  it("marks an availability of out of stock as inactive without losing the product", async () => {
    const { caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    const body = ["id,title,price,availability", "A1,Chain lube,8.50,out of stock"].join("\n");
    await caps.feeds.importBody(feed.id, body, T0);
    const [product] = await caps.setup.listProducts(owner);
    expect(product?.active).toBe(0);
    expect(product?.name).toBe("Chain lube");
  });

  it("leaves a sku that a hand-typed product already owns alone", async () => {
    const { caps } = await setup();
    const mine = await caps.setup.createProduct(owner, {
      sku: "LUBE-100",
      name: "Chain lube, my own listing",
      price: { value: 900, currency: "EUR" },
      active: true,
    });
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    const body = ["id,title,sku,price", "A1,Chain lube,LUBE-100,8.50"].join("\n");
    const result = await caps.feeds.importBody(feed.id, body, T0);

    expect(result.created).toBe(1);
    const products = await caps.setup.listProducts(owner);
    // The hand-typed one keeps its sku; the imported one simply has none.
    expect(products.find((p) => p.id === mine.id)?.sku).toBe("LUBE-100");
    expect(products.find((p) => p.externalId === "A1")?.sku).toBeNull();
  });

  it("never touches a product somebody typed in", async () => {
    const { caps } = await setup();
    const mine = await caps.setup.createProduct(owner, {
      name: "Workshop hour",
      price: { value: 4500, currency: "EUR" },
      active: true,
    });
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    await caps.feeds.importBody(feed.id, FEED_V1, T0);
    await caps.feeds.importBody(feed.id, "id,title,price\nA1,Chain lube,8.50", T0 + 1000);

    const still = (await caps.setup.listProducts(owner)).find((p) => p.id === mine.id);
    expect(still?.active).toBe(1);
    expect(still?.name).toBe("Workshop hour");
  });

  it("records why a broken feed failed, and says so on the connector", async () => {
    const { caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    await expect(caps.feeds.importBody(feed.id, "alpha,beta\n1,2", T0)).rejects.toThrow();
    const after = await caps.feeds.get(owner, feed.id);
    expect(after.status).toBe("error");
    expect(after.last_error).toMatch(/id or a name/);
  });

  it("keeps the skipped rows on the summary so an owner can see what was left out", async () => {
    const { caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    const body = ["id,title,price", "A1,Chain lube,8.50", ",No id,1.00"].join("\n");
    const result = await caps.feeds.importBody(feed.id, body, T0);
    expect(result.created).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe("no_id");
  });
});

describe("disconnecting", () => {
  it("adopts the products back when the same URL is connected again", async () => {
    const { caps } = await setup();
    const first = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    await caps.feeds.importBody(first.id, FEED_V1, T0);
    await caps.feeds.remove(owner, first.id);

    // A new connector row, so a new id. The products must still be the same three products:
    // keying them on the connector id made a second copy of every one of them, beside a
    // deactivated first copy that still held the sku.
    const again = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    expect(again.id).not.toBe(first.id);
    const summary = await caps.feeds.importBody(again.id, FEED_V1, T0 + 1000);

    expect(summary.created).toBe(0);
    expect(summary.updated).toBe(3);
    expect(await caps.setup.listProducts(owner)).toHaveLength(3);
    expect((await caps.feeds.get(owner, again.id)).product_count).toBe(3);
  });

  it("keeps two different feeds' products apart", async () => {
    const { caps } = await setup();
    const a = await caps.feeds.add(owner, { url: "https://shop-a.example.com/feed.csv" });
    const b = await caps.feeds.add(owner, { url: "https://shop-b.example.com/feed.csv" });
    await caps.feeds.importBody(a.id, "id,title,price\nA1,Chain lube,8.50", T0);
    await caps.feeds.importBody(b.id, "id,title,price\nB1,Bar tape,14.00", T0);

    // Importing one must not deactivate the other's products.
    await caps.feeds.importBody(a.id, "id,title,price\nA1,Chain lube,8.50", T0 + 1000);
    const products = await caps.setup.listProducts(owner);
    expect(products.filter((p) => p.active === 1)).toHaveLength(2);
    expect((await caps.feeds.get(owner, a.id)).product_count).toBe(1);
    expect((await caps.feeds.get(owner, b.id)).product_count).toBe(1);
  });

  it("deactivates the products and keeps them, so reconnecting adopts them", async () => {
    const { caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    await caps.feeds.importBody(feed.id, FEED_V1, T0);

    const removed = await caps.feeds.remove(owner, feed.id);
    expect(removed.deactivated).toBe(3);
    expect(await caps.feeds.list(owner)).toHaveLength(0);

    const products = await caps.setup.listProducts(owner);
    expect(products).toHaveLength(3);
    expect(products.every((p) => p.active === 0)).toBe(true);
  });
});

/**
 * Found by an adversarial review of the first cut, each one demonstrated against the real code
 * before it was believed.
 */
describe("two imports at once", () => {
  it("converges instead of importing the catalogue twice", async () => {
    const { db, caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    const body = ["id,title,price", ...Array.from({ length: 30 }, (_, i) => `P${i},Item ${i},1.00`)].join("\n");

    // Both read an empty catalogue and both write. Without a unique key on (source, external_id)
    // this left sixty rows for thirty products, permanently, with both imports reporting success.
    await Promise.all([caps.feeds.importBody(feed.id, body, T0), caps.feeds.importBody(feed.id, body, T0 + 1)]);

    const { rows } = await db.client.query({
      sql: "SELECT COUNT(*), COUNT(DISTINCT external_id) FROM products WHERE source LIKE 'feed:%'",
      method: "all",
    });
    const [total, distinct] = rows[0] as [number, number];
    expect(Number(distinct)).toBe(30);
    expect(Number(total)).toBe(30);
  });
});

describe("a sku that changes in the feed", () => {
  it("is written, rather than reported as unchanged for ever", async () => {
    const { caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    await caps.feeds.importBody(feed.id, "id,title,sku,price\nA1,Chain lube,LUBE-100,8.50", T0);
    expect((await caps.setup.listProducts(owner))[0]?.sku).toBe("LUBE-100");

    const summary = await caps.feeds.importBody(feed.id, "id,title,sku,price\nA1,Chain lube,LUBE-200,8.50", T0 + 1000);
    expect(summary.updated).toBe(1);
    expect(summary.unchanged).toBe(0);
    expect((await caps.setup.listProducts(owner))[0]?.sku).toBe("LUBE-200");
  });
});
