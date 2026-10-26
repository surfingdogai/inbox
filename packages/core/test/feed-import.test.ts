import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import type { Caller } from "../src/write/index";
import { confirming, makeClient, resetTables } from "./harness";

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

  it("refuses a currency prices here are not counted in, as every other door does", async () => {
    const { caps } = await setup();
    for (const currency of ["JPY", "kwd"]) {
      await expect(
        caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv", currency }),
        currency,
      ).rejects.toMatchObject({ code: "invalid_input", fields: [{ path: "currency" }] });
    }
    expect((await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv", currency: "huf" })).currency).toBe(
      "HUF",
    );
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

  it("puts nothing on sale at nothing or less, or in a currency it does not count", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { business: { currency: "USD" } } });
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    // A product stored before a feed's yen were refused: on sale, at whole yen.
    await db.client.query({
      sql: `INSERT INTO products (id, name, price, source, external_id, active, created_at, updated_at)
            VALUES ('old_yen', 'Record sleeve', ?, 'feed:https://shop.example.com/feed.csv', 'R2', 1, ?, ?)`,
      params: [JSON.stringify({ value: 350, currency: "JPY" }), T0, T0],
      method: "run",
    });
    await caps.feeds.importBody(
      feed.id,
      [
        "id,title,price",
        "P1,Gift card,0.00 USD",
        "P2,Refund,-5.00 USD",
        "R1,Vinyl record,4980 JPY",
        "R2,Record sleeve,¥350",
        "K1,Dates,12.500 KWD",
        "M1,Mug,8.50",
      ].join("\n"),
      T0,
    );
    expect((await caps.listProducts({ limit: 50 })).items.map((p) => [p.name, p.price])).toEqual([
      ["Mug", { value: 850, currency: "USD" }],
    ]);
    const all = await caps.setup.listProducts(owner);
    // Never relabelled as the business's own currency, nor a thousand times the amount.
    expect(all.find((p) => p.name === "Dates")).toMatchObject({ active: 0, price: { value: 0, currency: "USD" } });
    expect(all.find((p) => p.name === "Refund")).toMatchObject({ active: 0, price: { value: 0, currency: "USD" } });
    // What was on sale in yen is taken off it, and kept.
    expect(all.find((p) => p.name === "Record sleeve")).toMatchObject({ id: "old_yen", active: 0 });
    // An order for one is refused, as for anything off sale.
    await expect(
      caps.createOrder(customer, {
        payload: {
          orderedItem: [
            { productId: "old_yen", name: "Record sleeve", quantity: 1, price: { value: 350, currency: "JPY" } },
          ],
          totalPrice: { value: 350, currency: "JPY" },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("takes a product off sale at its last price when the feed now prices it at nothing or less", async () => {
    const { caps } = await setup();
    await caps.updateSettings(owner, { doc: { business: { currency: "EUR" } } });
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    await caps.feeds.importBody(feed.id, ["id,title,price", "A1,Tea,12.00", "A2,Mug,8.00"].join("\n"), T0);
    // A shop that marks what it no longer sells at 0.00, or a refund's -5.00: neither stays on sale.
    await caps.feeds.importBody(feed.id, ["id,title,price", "A1,Tea,0.00", "A2,Mug,-5.00"].join("\n"), T0 + 1000);
    const all = await caps.setup.listProducts(owner);
    expect(all.find((p) => p.name === "Tea")).toMatchObject({ active: 0, price: { value: 1_200, currency: "EUR" } });
    expect(all.find((p) => p.name === "Mug")).toMatchObject({ active: 0, price: { value: 800, currency: "EUR" } });
    expect((await caps.listProducts({ limit: 50 })).items).toEqual([]);
    const tea = all.find((p) => p.name === "Tea");
    await expect(
      confirming(caps).createOrder(customer, {
        payload: {
          orderedItem: [{ productId: tea?.id, name: "Tea", quantity: 1, price: { value: 1_200, currency: "EUR" } }],
          totalPrice: { value: 1_200, currency: "EUR" },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // A price again puts it back on sale.
    await caps.feeds.importBody(feed.id, ["id,title,price", "A1,Tea,12.50", "A2,Mug,8.00"].join("\n"), T0 + 2000);
    expect((await caps.setup.listProducts(owner)).find((p) => p.name === "Tea")).toMatchObject({
      active: 1,
      price: { value: 1_250, currency: "EUR" },
    });
  });

  it("prices `$` and `kr` in the business's own dollars or crowns, and orders in them", async () => {
    // A shop in Sydney, one in Toronto and one in Bergen: `$` and `kr` were US dollars and Swedish crowns.
    for (const [currency, cell, value] of [
      ["AUD", "$25.00", 2_500],
      ["CAD", "$25.00", 2_500],
      ["NOK", "199,00 kr", 19_900],
    ] as const) {
      const { caps } = await setup();
      await caps.setup.updateProfile(owner, { currency });
      const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
      await caps.feeds.importBody(feed.id, ["id,title,price", `B1,Bell,"${cell}"`].join("\n"), T0);
      const [bell] = (await caps.listProducts({ limit: 50 })).items;
      expect(bell?.price, currency).toEqual({ value, currency });
      const order = await confirming(caps).createOrder(customer, {
        payload: {
          orderedItem: [{ productId: bell?.id, name: "Bell", quantity: 1, price: { value, currency } }],
          totalPrice: { value, currency },
        },
      });
      expect(order.view.item.payload, currency).toMatchObject({ totalPrice: { value, currency } });
    }
  });

  it("changes a price when its sale starts and ends, not at the next read", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { business: { currency: "USD" } } });
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.xml" });
    await db.client.query({ sql: "DELETE FROM jobs", method: "run" });
    const xml = `<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel><item><g:id>H1</g:id><g:title>Helmet</g:title><g:price>80.00 USD</g:price><g:sale_price>40.00 USD</g:sale_price><g:sale_price_effective_date>2026-11-27T00:00Z/2026-11-28T13:00Z</g:sale_price_effective_date></item></channel></rss>`;
    const noon = Date.parse("2026-11-28T12:00:00Z");
    const end = Date.parse("2026-11-28T13:00:00Z");
    await caps.feeds.importBody(feed.id, xml, noon);
    expect((await caps.listProducts({ limit: 5 })).items[0]?.price).toEqual({ value: 4_000, currency: "USD" });
    // One job, at the sale's end, carrying what it sells at from then.
    const jobs = await db.client.query({ sql: "SELECT kind, run_at, payload FROM jobs", method: "all" });
    expect(jobs.rows).toHaveLength(1);
    const [kind, runAt, payload] = jobs.rows[0] as [string, number, string];
    expect([kind, Number(runAt)]).toEqual(["feed_import", end]);
    const changes = (JSON.parse(payload) as { changes: never[] }).changes;
    expect(changes).toEqual([{ at: end, externalId: "H1", price: { value: 8_000, currency: "USD" }, available: true }]);
    // Reading the feed again replaces that job rather than adding another.
    await caps.feeds.importBody(feed.id, xml, noon + 60_000);
    expect((await db.client.query({ sql: "SELECT COUNT(*) FROM jobs", method: "all" })).rows[0]?.[0]).toBe(1);
    // Before its moment, nothing changes; at it, the regular price, though the feed was not read.
    expect(await caps.feeds.applyPriceChanges(feed.id, changes, end - 1)).toEqual({ applied: 0 });
    expect(await caps.feeds.applyPriceChanges(feed.id, changes, end)).toEqual({ applied: 1 });
    expect((await caps.listProducts({ limit: 5 })).items[0]?.price).toEqual({ value: 8_000, currency: "USD" });
    // An order placed after the sale ended pays the regular price.
    const helmet = (await caps.listProducts({ limit: 5 })).items[0];
    const order = await confirming(caps).createOrder(
      { ...customer, now: () => Date.parse("2026-11-28T17:00:00Z") },
      {
        payload: {
          orderedItem: [
            { productId: helmet?.id as string, name: "Helmet", quantity: 1, price: { value: 4_000, currency: "USD" } },
          ],
          totalPrice: { value: 4_000, currency: "USD" },
        },
      },
    );
    expect(order.view.item.payload).toMatchObject({ totalPrice: { value: 8_000, currency: "USD" } });
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

describe("what a product is (ADR-029)", () => {
  const FEED = [
    "id,title,price,ean,brand,mpn,condition,link,image_link,google_product_category",
    "A1,Moka pot,18.90,4006381333931,Bialetti,BIA-1,used,https://shop.example.com/moka,https://cdn.example.net/moka.jpg,Kitchen",
    "A2,Tea towel,4.00,4006381333932,,,,http://shop.example.com/towel,http://cdn.example.net/towel.jpg,",
    "A3,In-store bread,2.50,2001234567893,,,,,,",
  ].join("\n");

  it("stores the barcode checked to 14 digits, the brand, part number, condition and links", async () => {
    const { caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    await caps.feeds.importBody(feed.id, FEED, T0);
    const byName = new Map((await caps.setup.listProducts(owner)).map((p) => [p.name, p]));
    expect(byName.get("Moka pot")).toMatchObject({
      // The part number comes before the barcode among the sku's names, as it always did.
      sku: "BIA-1",
      gtin: "04006381333931",
      gtinGiven: null,
      brand: "Bialetti",
      mpn: "BIA-1",
      condition: "used",
      url: "https://shop.example.com/moka",
      imageUrl: "https://cdn.example.net/moka.jpg",
      sourceCategory: "Kitchen",
      noGtin: 0,
      listed: 1,
    });
    // A barcode whose last digit is wrong is kept as it came, for the owner, and is not the barcode;
    // a link that is not https is not kept.
    expect(byName.get("Tea towel")).toMatchObject({
      gtin: null,
      gtinGiven: "4006381333932",
      condition: "new",
      url: null,
      imageUrl: null,
    });
    // A shop's own code is never its barcode either.
    expect(byName.get("In-store bread")).toMatchObject({ gtin: null, gtinGiven: "2001234567893" });
  });

  it("never takes a barcode a spreadsheet wrote as a decimal number, nor ten UPC digits as a book", async () => {
    const { caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    await caps.feeds.importBody(feed.id, "id,title,price,ean\nA1,Hazelnut spread 400 g,4.50,3017620422003.0", T0);
    const other = await caps.feeds.add(owner, { url: "https://shop.example.com/upc.csv" });
    await caps.feeds.importBody(other.id, "id,title,price,upc\nB1,Potato chips 200 g,2.50,2840000059", T0);
    const byName = new Map((await caps.setup.listProducts(owner)).map((p) => [p.name, p]));
    expect(byName.get("Hazelnut spread 400 g")).toMatchObject({ gtin: null, gtinGiven: "3017620422003.0" });
    expect(byName.get("Potato chips 200 g")).toMatchObject({ gtin: null, gtinGiven: "2840000059" });
  });

  it("updates a row whose barcode alone changed, and keeps what a later read leaves out", async () => {
    const { caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    const head = "id,title,sku,price,gtin,brand";
    await caps.feeds.importBody(feed.id, `${head}\nA1,Moka pot,MOKA,18.90,4006381333932,Bialetti`, T0);
    const fixed = await caps.feeds.importBody(
      feed.id,
      `${head}\nA1,Moka pot,MOKA,18.90,4006381333931,Bialetti`,
      T0 + 1000,
    );
    expect(fixed.updated).toBe(1);
    const [moka] = await caps.setup.listProducts(owner);
    expect(moka).toMatchObject({ gtin: "04006381333931", gtinGiven: null, updatedAt: T0 + 1000 });
    // A read without the columns has not said the product lost its barcode or its brand.
    const plain = await caps.feeds.importBody(feed.id, "id,title,sku,price\nA1,Moka pot,MOKA,18.90", T0 + 2000);
    expect(plain.unchanged).toBe(1);
    expect((await caps.setup.listProducts(owner))[0]).toMatchObject({ gtin: "04006381333931", brand: "Bialetti" });
  });
});
