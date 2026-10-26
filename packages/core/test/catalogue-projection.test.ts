import { runMigrations } from "@surfingdog/platform";
import { cataloguePageSchema } from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { availabilityOf, catalogueItem, listableWhy, publicProduct, siteDomains } from "../src/catalogue/publish";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { products } from "../src/schema/tables";
import { makeClient, resetTables } from "./harness";

/**
 * One public view of a product (ADR-029): what `GET /v1/products`, MCP `list_products` and the signed
 * catalogue feed say of it, and what none of them ever says. Node and workerd.
 */
const T0 = Date.parse("2026-10-26T09:00:00Z");

type Row = typeof products.$inferSelect;
const row = (over: Partial<Row> = {}): Row => ({
  id: "01JC0000000000000000000001",
  locationId: "loc_1",
  sku: "MOKA-6",
  name: "Moka pot, 6 cups",
  description: "Aluminium, for the hob.",
  price: { value: 18990, currency: "BRL" },
  stock: 4,
  source: "feed:https://loja.example/feed.xml?token=feed-secret-1",
  externalId: "ext-77",
  active: 1,
  withdrawal: "standard",
  negotiable: 1,
  gtin: "09506000134352",
  gtinGiven: null,
  noGtin: 0,
  brand: "Bialetti",
  mpn: "BIA-6",
  condition: "new",
  url: "https://www.loja.example/produtos/moka-6",
  imageUrl: "https://cdn.example.net/moka.jpg",
  sourceCategory: "Kitchen > Coffee",
  listed: 1,
  catalogueSeq: 7,
  menu: null,
  soldOutOn: null,
  createdAt: T0 - 86_400_000,
  updatedAt: T0,
  seenAt: T0,
  ...over,
});
const ctx = { sites: siteDomains({ domain: "loja.example", website: "" }) };

const DOOR_FIELDS = [
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
const FEED_FIELDS = [
  "availability",
  "brand",
  "condition",
  "description",
  "gtin",
  "hash",
  "id",
  "image_url",
  "mpn",
  "name",
  "no_gtin",
  "price",
  "sku",
  "state",
  "updated_at",
  "url",
];
const NEVER = /feed-secret|ext-77|feed:|loc_1|Kitchen|created/;

describe("a product's public view", () => {
  it("has these fields at the doors and no others, never where it came from", () => {
    const p = publicProduct(row(), ctx);
    expect(Object.keys(p).sort()).toEqual(DOOR_FIELDS);
    expect(p).toMatchObject({
      gtin: "09506000134352",
      no_gtin: false,
      availability: "in_stock",
      url: "https://www.loja.example/produtos/moka-6",
      updated_at: "2026-10-26T09:00:00.000Z",
    });
    expect(JSON.stringify(p)).not.toMatch(NEVER);
  });

  it("says in stock, out of stock or on sale, and a network never sees a count", async () => {
    expect(availabilityOf(row({ stock: 3 }))).toBe("in_stock");
    expect(availabilityOf(row({ stock: 0 }))).toBe("out_of_stock");
    expect(availabilityOf(row({ stock: null }))).toBe("on_sale");
    const item = await catalogueItem(row({ stock: 3 }), ctx);
    expect(Object.keys(item).sort()).toEqual(FEED_FIELDS);
    expect(JSON.stringify(item)).not.toMatch(NEVER);
    expect(JSON.stringify(item)).not.toMatch(/"stock"|withdrawal|negotiable/);
  });

  it("publishes a product's page only on the business's own site", () => {
    expect(publicProduct(row({ url: "https://loja.example/p" }), ctx).url).toBe("https://loja.example/p");
    expect(publicProduct(row({ url: "https://shop.loja.example/p" }), ctx).url).toBe("https://shop.loja.example/p");
    for (const url of [
      "https://marketplace.example/loja/p",
      "https://notloja.example/p",
      "https://loja.example.evil.net/p",
    ]) {
      expect(publicProduct(row({ url }), ctx).url, url).toBeNull();
    }
    expect(publicProduct(row(), { sites: [] }).url).toBeNull();
    // The business's own website, from its directory profile, counts as its site too.
    const both = { sites: siteDomains({ domain: null, website: "https://www.loja.example/" }) };
    expect(publicProduct(row(), both).url).toBe("https://www.loja.example/produtos/moka-6");
  });

  it("hashes what the item says, never when it was said", async () => {
    const a = await catalogueItem(row(), ctx);
    const later = await catalogueItem(row({ updatedAt: T0 + 60_000 }), ctx);
    const dearer = await catalogueItem(row({ price: { value: 19990, currency: "BRL" } }), ctx);
    expect("hash" in a && a.hash).toMatch(/^[0-9a-f]{16}$/);
    expect("hash" in later && later.hash).toBe("hash" in a && a.hash);
    expect("hash" in dearer && dearer.hash).not.toBe("hash" in a && a.hash);
  });

  it("lists a product only on sale, kept on networks, priced above nothing and not a template's sample", async () => {
    expect(listableWhy(row())).toBeNull();
    expect(listableWhy(row({ active: 0 }))).toBe("off_sale");
    expect(listableWhy(row({ listed: 0 }))).toBe("kept_off");
    expect(listableWhy(row({ price: { value: 0, currency: "EUR" } }))).toBe("price_zero");
    expect(listableWhy(row({ name: "I'm a product" }))).toBe("sample_name");
    for (const r of [row({ active: 0 }), row({ listed: 0 }), row({ name: "Sample product" })]) {
      expect(await catalogueItem(r, ctx)).toEqual({
        id: r.id,
        state: "withdrawn",
        updated_at: "2026-10-26T09:00:00.000Z",
      });
    }
    const long = await catalogueItem(row({ name: "x".repeat(200), description: "y".repeat(1500) }), ctx);
    expect(cataloguePageSchema.shape.items.element.safeParse(long).success).toBe(true);
    expect("name" in long && long.name).toHaveLength(150);
  });
});

describe("list_products", () => {
  async function setup() {
    const db = createDb(await makeClient());
    await runMigrations(db.client, MIGRATIONS);
    await resetTables(db.client);
    const caps = new Capabilities(db);
    const add = (over: Partial<Row>) =>
      db.orm.insert(products).values({
        ...row(),
        id: ulid(),
        sku: null,
        locationId: null,
        externalId: null,
        createdAt: T0,
        updatedAt: T0,
        ...over,
      });
    await add({ name: "Moka pot", gtin: "04006381333931" });
    await add({ name: "Kettle", gtin: null });
    await add({ name: "Grinder", gtin: "00036000291452" });
    return { db, caps };
  }

  it("answers with the public view at the doors, by ids and by barcode in any of its lengths", async () => {
    const { caps } = await setup();
    const all = await caps.listProducts({ limit: 50 });
    expect(all.items.map((p) => p.name)).toEqual(["Grinder", "Kettle", "Moka pot"]);
    expect(Object.keys(all.items[0] ?? {}).sort()).toEqual(DOOR_FIELDS);
    const ids = all.items.filter((p) => p.name !== "Kettle").map((p) => p.id);
    expect((await caps.listProducts({ limit: 50, ids })).items.map((p) => p.name)).toEqual(["Grinder", "Moka pot"]);
    expect((await caps.listProducts({ limit: 50, gtin: "4006381333931" })).items.map((p) => p.name)).toEqual([
      "Moka pot",
    ]);
    expect((await caps.listProducts({ limit: 50, gtin: "036000291452" })).items.map((p) => p.name)).toEqual([
      "Grinder",
    ]);
  });

  it("refuses a barcode that does not read as one, rather than matching nothing quietly", async () => {
    const { caps } = await setup();
    await expect(caps.listProducts({ limit: 50, gtin: "4006381333932" })).rejects.toMatchObject({
      code: "invalid_input",
      fields: [{ path: "gtin" }],
    });
  });
});
