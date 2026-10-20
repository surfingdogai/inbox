import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  connectorSource,
  deactivateSource,
  deactivateUnseen,
  SHOP_CHARGES_SKU,
  upsertCatalogue,
} from "../src/connectors/catalogue";
import { cardOf, GALLERY, gallery, galleryGroups, leanOf } from "../src/connectors/gallery";
import { inboundHash, isInboundToken, newInboundToken } from "../src/connectors/hooks";
import { type ConnectorDefinition, field, secretField } from "../src/connectors/sdk";
import { shopOrderOf } from "../src/connectors/shop";
import { createDb, type Db } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { makeClient, resetTables } from "./harness";

/**
 * The connectors' shared base (ADR-026), piece by piece: the one catalogue upsert feeds and shops
 * share, the honest gallery, the order as a shop is told it, and a connection's own address. The end
 * to end is in apps/inbox/test/connectors-base.test.ts.
 */

async function freshDb(): Promise<Db> {
  const client = await makeClient();
  await runMigrations(client, MIGRATIONS);
  await resetTables(client);
  return createDb(client);
}

async function catalogue(db: Db, source: string) {
  const { rows } = await db.client.query({
    sql: "SELECT external_id, sku, price, stock, active, withdrawal, negotiable FROM products WHERE source = ? ORDER BY external_id",
    params: [source],
    method: "all",
  });
  return rows.map((r) => ({
    externalId: String(r[0]),
    sku: r[1] === null ? null : String(r[1]),
    price: JSON.parse(String(r[2])) as { value: number; currency: string },
    stock: r[3] === null ? null : Number(r[3]),
    active: Number(r[4]) === 1,
    withdrawal: String(r[5]),
    negotiable: Number(r[6]),
  }));
}

const T0 = Date.parse("2026-11-02T08:00:00Z");

describe("the catalogue upsert feeds and shops share", () => {
  const source = connectorSource("kibanda", "store_ke_01");
  const row = (externalId: string, over: Record<string, unknown> = {}) => ({
    externalId,
    name: `Product ${externalId}`,
    description: null,
    sku: null,
    price: { value: 25_000, currency: "INR" },
    stock: null,
    available: true,
    ...over,
  });

  it("keys on the source and the shop's id, so a second pass updates rather than copies", async () => {
    const db = await freshDb();
    const first = await upsertCatalogue(db, {
      source,
      products: [row("p:1"), row("p:2")],
      now: T0,
      seenAt: T0,
      currency: "INR",
    });
    expect(first).toEqual({ created: 2, updated: 0, unchanged: 0, priceless: 0 });
    const again = await upsertCatalogue(db, {
      source,
      products: [row("p:1"), row("p:2", { price: { value: 27_500, currency: "INR" } })],
      now: T0 + 1,
      seenAt: T0 + 1,
      currency: "INR",
    });
    expect(again).toEqual({ created: 0, updated: 1, unchanged: 1, priceless: 0 });
    expect((await catalogue(db, source)).map((p) => [p.externalId, p.price.value])).toEqual([
      ["p:1", 25_000],
      ["p:2", 27_500],
    ]);
  });

  it("keeps the last price when one is left out, and never puts a product with no price ever on sale", async () => {
    const db = await freshDb();
    await upsertCatalogue(db, {
      source,
      products: [row("p:1"), row("p:2", { price: null })],
      now: T0,
      seenAt: T0,
      currency: "INR",
    });
    await upsertCatalogue(db, {
      source,
      products: [row("p:1", { price: null }), row("p:2", { price: null })],
      now: T0 + 1,
      seenAt: T0 + 1,
      currency: "INR",
    });
    const rows = await catalogue(db, source);
    expect(rows[0]).toMatchObject({ externalId: "p:1", active: true, price: { value: 25_000, currency: "INR" } });
    // In the business's own currency (a hardware shop in Pune: rupees), and off sale: never a currency guessed.
    expect(rows[1]).toMatchObject({ externalId: "p:2", active: false, price: { value: 0, currency: "INR" } });
    // Once it has a price, it is on sale.
    await upsertCatalogue(db, {
      source,
      products: [row("p:2", { price: { value: 9_900, currency: "INR" } })],
      now: T0 + 2,
      seenAt: T0 + 2,
      currency: "INR",
    });
    expect((await catalogue(db, source))[1]).toMatchObject({ active: true, price: { value: 9_900 } });
  });

  it("drops a SKU another product holds and one the inbox keeps for itself, and never writes the owner's fields", async () => {
    const db = await freshDb();
    await db.client.query({
      sql: `INSERT INTO products (id, sku, name, price, source, active, withdrawal, negotiable, created_at, updated_at)
            VALUES (?, 'HAMMER-1', 'Hammer', ?, 'builtin', 1, 'standard', 0, ?, ?)`,
      params: [ulid(T0), JSON.stringify({ value: 45_000, currency: "INR" }), T0, T0],
      method: "run",
    });
    await upsertCatalogue(db, {
      source,
      products: [
        row("p:1", { sku: "HAMMER-1" }),
        row("p:2", { sku: SHOP_CHARGES_SKU }),
        row("p:3", { sku: "NAIL-50" }),
      ],
      now: T0,
      seenAt: T0,
      currency: "INR",
    });
    const rows = await catalogue(db, source);
    expect(rows.map((p) => p.sku)).toEqual([null, null, "NAIL-50"]);
    // The owner's own say on withdrawal and price suggestions is left at its default, never set by a source.
    expect(rows.every((p) => p.withdrawal === "standard" && p.negotiable === 1)).toBe(true);
  });

  it("takes off sale what a complete pass did not see, and everything when the source goes", async () => {
    const db = await freshDb();
    await upsertCatalogue(db, {
      source,
      products: [row("p:1"), row("p:2"), row("p:3")],
      now: T0,
      seenAt: T0,
      currency: "INR",
    });
    const pass = T0 + 6 * 3_600_000;
    await upsertCatalogue(db, { source, products: [row("p:1"), row("p:3")], now: pass, seenAt: pass, currency: "INR" });
    expect(await deactivateUnseen(db, source, pass, pass)).toBe(1);
    expect((await catalogue(db, source)).map((p) => [p.externalId, p.active])).toEqual([
      ["p:1", true],
      ["p:2", false],
      ["p:3", true],
    ]);
    // Another source's products are not touched.
    const feed = "feed:https://ferreteria.example.com/feed.xml";
    await upsertCatalogue(db, { source: feed, products: [row("f:1")], now: T0, seenAt: T0, currency: "INR" });
    expect(await deactivateSource(db, source, pass)).toBe(2);
    expect((await catalogue(db, feed))[0]?.active).toBe(true);
  });
});

/* --- the gallery ------------------------------------------------------------------------------------ */

const def = (kind: string, over: Partial<ConnectorDefinition> = {}): ConnectorDefinition => ({
  kind,
  title: kind,
  group: "shops",
  capabilities: [],
  auth: "form",
  form: z.object({ key: secretField(z.string(), { label: "Key" }) }),
  ...over,
});

describe("the gallery says only what is true", () => {
  it("lists no card for a connector nobody is building, and says soon only for what is", () => {
    const cards = gallery(new Map());
    // Nothing registered: only the cards being built show, each soon, with nothing to press.
    expect(cards.map((c) => c.id)).toEqual(["calendly", "ics_feed", "woocommerce", "square"]);
    expect(
      cards.every((c) => c.status === "soon" && c.ways.every((w) => w.status === "soon" && w.form.length === 0)),
    ).toBe(true);
    // Every card being built belongs to a track of this workflow; every other one has a connector today.
    const building = GALLERY.filter((c) => c.building).map((c) => c.id);
    expect(building).toEqual(["calendly", "ics_feed", "woocommerce", "square"]);
  });

  it("turns a card from soon to ready the moment its connector registers, a way at a time", () => {
    const woo = def("woocommerce", {
      title: "WooCommerce",
      auth: "oauth",
      action: "Connect your shop",
      oauth: {
        before: z.object({
          store_url: field(z.string(), { label: "Shop address", input: "url", prefill: "website" }),
        }),
        authorizeUrl: () => "https://shop.example.com/authorize",
        exchange: async () => {
          throw new Error("not here");
        },
      },
      presets: [{ id: "keys", label: "Paste the keys", values: {}, auth: "form" }],
    });
    const cards = gallery(new Map([["woocommerce", woo]]), { prefill: { website: "https://pizzaria-sp.example.com" } });
    const card = cards.find((c) => c.id === "woocommerce");
    expect(card?.status).toBe("ready");
    expect(card?.ways.map((w) => [w.label, w.status, w.auth, w.advanced ?? false])).toEqual([
      ["WooCommerce", "ready", "oauth", false],
      ["Paste the keys instead", "ready", "form", true],
    ]);
    // What the sign-in asks first is filled in from the business's own website, to keep or change.
    expect(card?.ways[0]).toMatchObject({
      action: "Connect your shop",
      before: [{ key: "store_url", label: "Shop address", value: "https://pizzaria-sp.example.com" }],
    });
    // Square, not registered, still says soon.
    expect(cards.find((c) => c.id === "square")?.status).toBe("soon");
  });

  it("keeps a one-click sign-in soon until the server has its app, while the key way works", () => {
    const shopify = def("shopify", {
      title: "Shopify",
      presets: [
        {
          id: "oauth",
          label: "Sign in with Shopify",
          values: {},
          auth: "oauth",
          ready: () => "Shopify sign-in is not set up here.",
          whenNotReady: { status: "soon" },
        },
      ],
      oauth: { authorizeUrl: () => "", exchange: async () => Promise.reject(new Error("no")) },
    });
    const card = gallery(new Map([["shopify", shopify]])).find((c) => c.id === "shopify");
    expect(card?.status).toBe("ready");
    expect(card?.ways.map((w) => [w.label, w.status])).toEqual([
      ["Your app's keys", "ready"],
      ["Sign in with Shopify", "soon"],
    ]);
  });

  it("orders the groups and cards by what the inbox holds, hiding none", () => {
    expect(leanOf({ services: 0, products: 0 })).toBeNull();
    expect(leanOf({ services: 4, products: 1 })).toBe("appointments");
    expect(leanOf({ services: 1, products: 30 })).toBe("shop");
    expect(galleryGroups("shop").map((g) => g.label)).toEqual(["Shops and tills", "Payments", "Calendars"]);
    expect(galleryGroups(null).map((g) => g.label)).toEqual(["Calendars", "Payments", "Shops and tills"]);
    const forSalon = gallery(new Map(), { lean: "appointments" }).filter((c) => c.group === "shops");
    expect(forSalon.map((c) => c.id)).toEqual(["square", "woocommerce"]);
    const forBakery = gallery(new Map(), { lean: "shop" }).filter((c) => c.group === "shops");
    expect(forBakery.map((c) => c.id)).toEqual(["woocommerce", "square"]);
  });

  it("knows the card of every way, Outlook's calendar link included", () => {
    expect(cardOf("ics", "outlook")).toBe("calendar");
    expect(cardOf("caldav", "icloud")).toBe("calendar");
    expect(cardOf("woocommerce", "keys")).toBe("woocommerce");
    expect(cardOf("nothing")).toBeUndefined();
  });
});

/* --- the order as a shop is told it ------------------------------------------------------------------ */

describe("an order as the business's own shop is told it", () => {
  async function order(db: Db, payload: Record<string, unknown>, party: { erased?: boolean } = {}) {
    const partyId = ulid(T0);
    const itemId = ulid(T0 + 1);
    await db.client.batch([
      {
        sql: "INSERT INTO parties (id, kind, display_name, locale, contact, erased_at, created_at, updated_at) VALUES (?, 'person', ?, 'pt-BR', ?, ?, ?, ?)",
        params: [
          partyId,
          "João Pereira",
          JSON.stringify({ name: "João Pereira", email: "joao@example.com", phone: "+55 11 90000-0000" }),
          party.erased ? T0 : null,
          T0,
          T0,
        ],
        method: "run",
      },
      {
        sql: `INSERT INTO items (id, type, state, party_id, channel, payload, flags, created_at, updated_at)
              VALUES (?, 'order', 'accepted', ?, 'api', ?, '{}', ?, ?)`,
        params: [itemId, partyId, JSON.stringify(payload), T0, T0],
        method: "run",
      },
    ]);
    return itemId;
  }

  it("names the shop's own products, leaves out the charges line the shop adds itself, and only what fulfilling needs", async () => {
    const db = await freshDb();
    const source = connectorSource("shopify", "pizzaria.example.com");
    await upsertCatalogue(db, {
      source,
      products: [
        {
          externalId: "gid://shopify/ProductVariant/7",
          name: "Margherita",
          description: null,
          sku: "MRG",
          price: { value: 5_900, currency: "BRL" },
          stock: null,
          available: true,
        },
      ],
      now: T0,
      seenAt: T0,
      currency: "BRL",
    });
    const { rows } = await db.client.query({ sql: "SELECT id FROM products", method: "all" });
    const productId = String(rows[0]?.[0]);
    const itemId = await order(db, {
      orderedItem: [
        { productId, sku: "MRG", name: "Margherita", quantity: 2, price: { value: 5_900, currency: "BRL" } },
        { name: "Borda recheada", quantity: 1, price: { value: 900, currency: "BRL" } },
        { sku: SHOP_CHARGES_SKU, name: "Impostos e encargos", quantity: 1, price: { value: 1_270, currency: "BRL" } },
      ],
      totalPrice: { value: 13_970, currency: "BRL" },
      delivery: { method: "delivery", when: "2026-11-03T19:00:00-03:00" },
      shippingAddress: { streetAddress: "Rua Augusta 900", addressLocality: "São Paulo", addressCountry: "BR" },
      notes: "Sem cebola, por favor.",
    });
    const sent = await shopOrderOf(db, itemId, { source, languages: ["pt-BR"] });
    expect(sent).toEqual({
      lines: [
        {
          externalId: "gid://shopify/ProductVariant/7",
          sku: "MRG",
          name: "Margherita",
          quantity: 2,
          unit: { value: 5_900, currency: "BRL" },
        },
        { externalId: null, sku: null, name: "Borda recheada", quantity: 1, unit: { value: 900, currency: "BRL" } },
      ],
      charges: { value: 1_270, currency: "BRL" },
      total: { value: 13_970, currency: "BRL" },
      delivery: "delivery",
      when: "2026-11-03T19:00:00-03:00",
      customer: { name: "João Pereira", email: "joao@example.com", phone: "+55 11 90000-0000", language: "pt-BR" },
      shipping: { streetAddress: "Rua Augusta 900", addressLocality: "São Paulo", addressCountry: "BR" },
      billing: null,
      note: "Sem cebola, por favor.",
    });
    // Another shop's products are not this shop's to name.
    const other = await shopOrderOf(db, itemId, { source: connectorSource("square", "loc_1"), languages: [] });
    expect(other?.lines[0]?.externalId).toBeNull();
  });

  it("tells the shop nothing about a customer who was erased", async () => {
    const db = await freshDb();
    const itemId = await order(
      db,
      {
        orderedItem: [{ name: "Calzone", quantity: 1, price: { value: 4_500, currency: "BRL" } }],
        totalPrice: { value: 4_500, currency: "BRL" },
        shippingAddress: { streetAddress: "Rua Augusta 900" },
        notes: "Portão azul",
      },
      { erased: true },
    );
    const sent = await shopOrderOf(db, itemId, { source: "x", languages: ["pt-BR"] });
    expect(sent?.customer).toEqual({ name: null, email: null, phone: null, language: "pt-BR" });
    expect(sent?.shipping).toBeNull();
    expect(sent?.note).toBeNull();
  });
});

describe("a connection's own address", () => {
  it("is 32 random bytes, and only its hash is kept", async () => {
    const a = newInboundToken();
    const b = newInboundToken();
    expect(isInboundToken(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(isInboundToken("authorized")).toBe(false);
    expect(isInboundToken(`${a}x`)).toBe(false);
    expect(await inboundHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(await inboundHash(a)).not.toContain(a);
  });
});
