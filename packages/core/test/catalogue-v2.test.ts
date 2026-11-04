import { runMigrations } from "@surfingdog/platform";
import {
  type CatalogueItem,
  type CatalogueListedItemV2,
  type CataloguePageV2,
  catalogueItemHash,
  catalogueItemsV2Schema,
  catalogueItemV1Of,
  cataloguePageSchema,
  cataloguePageV2Schema,
  cataloguePoliciesSchema,
  readCatalogueGroups,
  readCatalogueItemV2,
  readCataloguePolicies,
} from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { upsertCatalogue } from "../src/connectors/catalogue";
import { createDb } from "../src/db";
import { parseFeed } from "../src/feeds/parse";
import { menuFieldsSchema } from "../src/menu/schema";
import { verifyCatalogueSignature } from "../src/receipts/sign";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, productGroups, productPrices, products } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { readSettings } from "../src/settings/schema";
import type { Caller } from "../src/write/index";
import { priceFromCatalogue } from "../src/write/pricing";
import { publishedRefundDays } from "../src/write/returns";
import { makeClient, resetTables } from "./harness";

/**
 * Catalogue version 2 at the inbox (protocol §4.18 as amended, ADR-047): the owner's model (groups and
 * options, price models, "was" and unit prices, availability, age, shipping profiles and return policies),
 * the v2 feed and its v1 pages, the signed policies document, the shipping quote, and who may write what.
 * Every page is read back as a network reads it, by the spec's own reader. Node and workerd.
 */
const T0 = Date.parse("2026-11-02T09:00:00Z");
const DAY = 86_400_000;
const DOMAIN = "inbox.loja.example";
const BASE = `https://${DOMAIN}/v1/catalogue`;
const EUR = (value: number) => ({ value, currency: "EUR" });

let clock = T0;
const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock,
};
const ai: Caller = {
  actor: { kind: "owner_ai", id: "client_1", channel: "rest" },
  actsAs: "owner",
  principal: { via: "oauth", id: "client_1", name: "Assistant", scopes: ["*"], userId: "u1" },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock,
};
const zapier: Caller = {
  actor: { kind: "integration", id: "key_zap", channel: "rest" },
  principal: { via: "api_key", id: "key_zap", name: "Zapier", scopes: ["*"], userId: null, keyKind: "integration" },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock,
};

async function setup() {
  clock = T0;
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm.insert(business).values({
    id: "self",
    name: "Loja",
    domain: "loja.pt",
    timezone: "UTC",
    currency: "EUR",
    createdAt: T0,
    updatedAt: T0,
  });
  const caps = new Capabilities(db, createSecretBox(["catalogue-v2-test-secret-0123456789abcdef"]));
  return { db, caps };
}

type Caps = Capabilities;
const req = (url: string) => ({ domain: DOMAIN, url, now: clock });

async function pageV2(caps: Caps, after?: string): Promise<CataloguePageV2> {
  const url = `${BASE}/changes?version=2&limit=500${after ? `&after=${after}` : ""}`;
  const r = await caps.catalogue.changes({ version: "2", limit: "500", ...(after ? { after } : {}) }, req(url));
  if (r.status !== 200) throw new Error(`HTTP ${r.status} ${"code" in r ? r.code : ""}`);
  return cataloguePageV2Schema.parse(JSON.parse(r.body));
}

async function pageV1(caps: Caps) {
  const r = await caps.catalogue.changes({ limit: "500" }, req(`${BASE}/changes?limit=500`));
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return cataloguePageSchema.parse(JSON.parse(r.body));
}

async function policiesOf(caps: Caps) {
  const r = await caps.catalogue.policies(req(`${BASE}/policies`));
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return { body: r.body, signature: r.signature, doc: cataloguePoliciesSchema.parse(JSON.parse(r.body)) };
}

/** The shipping profile most tests ship under: mainland Portugal by weight, free over 50, no ID check. */
const STANDARD_SHIPPING = {
  id: "standard",
  name: "Standard",
  default: true,
  zones: [
    {
      name: "Mainland",
      destinations: [{ country: "PT" }],
      excluded: [{ country: "PT", regions: ["PT-20", "PT-30"] }],
      services: [
        {
          id: "ctt",
          name: "CTT",
          carrier: "ctt",
          tracked: true,
          id_check: false,
          transit_days: { min: 1, max: 3 },
          rate: {
            basis: "by_weight" as const,
            unit: "kg" as const,
            bands: [
              { up_to: 2, amount: EUR(450) },
              { up_to: null, amount: EUR(990) },
            ],
          },
          free_over: EUR(5000),
        },
      ],
    },
  ],
};

/** A catalogue with something of everything version 2 carries. */
async function seedEverything(caps: Caps) {
  await caps.putShippingProfile(owner, STANDARD_SHIPPING);
  const moka = await caps.setup.upsertProductGroup(owner, { title: "Moka pot" });
  const v = [];
  for (const [size, price, pos] of [
    ["3 cups", 2490, 1],
    ["6 cups", 3490, 2],
  ] as const) {
    v.push(
      await caps.setup.createProduct(owner, {
        name: `Moka pot, ${size}`,
        price: EUR(price),
        stock: 4,
        active: true,
        group_id: moka.id,
        group_position: pos,
        options: [{ key: "colour", name: "Size", value: size }],
        fulfil_methods: ["pickup", "shipping"],
        weight: { value: 0.65, unit: "kg" },
        image_url: "https://cdn.loja.pt/img/moka.jpg",
        url: "https://loja.pt/p/moka",
      }),
    );
  }
  const haircut = await caps.setup.createProduct(owner, {
    name: "Gift box, made for you",
    price: EUR(2500),
    price_model: "from",
    availability: "made_to_order",
    active: true,
  });
  const repair = await caps.setup.createProduct(owner, {
    name: "Bike repair",
    price: EUR(4000),
    price_model: "range",
    price_max: EUR(12000),
    active: true,
  });
  const cake = await caps.setup.createProduct(owner, { name: "Wedding cake", price_model: "quote", active: true });
  const coffee = await caps.setup.createProduct(owner, {
    name: "Coffee, 500 g",
    price: EUR(450),
    unit_price: { measure: { value: 500, unit: "g" }, reference: { value: 1, unit: "kg" } },
    stock: 2,
    few_left: 3,
    active: true,
  });
  const book = await caps.setup.createProduct(owner, {
    name: "The new book",
    price: EUR(1990),
    availability: "preorder",
    available_from: new Date(T0 + 10 * DAY).toISOString(),
    active: true,
  });
  const wine = await caps.setup.createProduct(owner, {
    name: "Vinho Verde",
    price: EUR(890),
    stock: 12,
    age_restricted: { min_age: 18, kind: "wine" },
    fulfil_methods: ["pickup"],
    multipack: 6,
    active: true,
  });
  const hamper = await caps.setup.createProduct(owner, {
    name: "Christmas hamper",
    price: EUR(6500),
    is_bundle: true,
    available_until: new Date(T0 + 20 * DAY).toISOString(),
    tax_included: true,
    active: true,
  });
  return { moka, variants: v, haircut, repair, cake, coffee, book, wine, hamper };
}

describe("the version 2 feed", () => {
  it("serves every product as a network's reader takes it whole: nothing held, nothing dropped", async () => {
    const { caps } = await setup();
    await seedEverything(caps);
    const page = await pageV2(caps);
    const { doc } = await policiesOf(caps);
    const read = readCataloguePolicies(doc);
    expect(read?.problems).toEqual([]);
    expect(page.catalogue.policies_rev).toBe(doc.rev);
    const listed: CatalogueListedItemV2[] = [];
    for (const item of page.items) {
      const r = readCatalogueItemV2(item, { as_of: page.as_of, policies: read, site: ["loja.pt"] });
      expect(r, JSON.stringify(item)).toMatchObject({ state: "listed", dropped: [] });
      if (item.state === "listed") {
        listed.push(item);
        expect(await catalogueItemHash(item)).toBe(item.hash);
      }
    }
    expect(page.catalogue.count).toBe(listed.length);
    expect(listed).toHaveLength(9);
    const groups = readCatalogueGroups(listed);
    expect(groups).toEqual([expect.objectContaining({ state: "grouped", problems: [], held: [] })]);
    // colour is read as color, as the vocabulary spells it.
    expect(listed.find((i) => i.group)?.options?.[0]?.key).toBe("color");
    const by = (name: string) => listed.find((i) => i.name === name) as CatalogueListedItemV2;
    expect(by("Wedding cake")).toMatchObject({ price_model: "quote", price: null });
    expect(by("Bike repair")).toMatchObject({ price_model: "range", price_max: EUR(12000) });
    expect(by("Coffee, 500 g")).toMatchObject({ availability: "limited", unit_price: { measure: { value: 500 } } });
    expect(by("The new book")).toMatchObject({ availability: "preorder", available_from: expect.any(String) });
    expect(by("Vinho Verde")).toMatchObject({
      age_restricted: { min_age: 18, kind: "alcohol", check: "id_at_handover" },
      multipack: 6,
    });
    expect(by("Christmas hamper")).toMatchObject({ is_bundle: true, tax_included: true });
    expect(by("Moka pot, 6 cups")).toMatchObject({
      media: [{ type: "image", url: "https://cdn.loja.pt/img/moka.jpg" }],
      fulfil_methods: ["pickup", "shipping"],
      withdrawal: "standard",
    });
    // Shipped under the default profile: it names none of its own.
    expect(by("Moka pot, 6 cups")).not.toHaveProperty("shipping_profile");
    // Never a count, never where it came from, never the owner's few-left mark.
    expect(JSON.stringify(page)).not.toMatch(/"stock"|few_left|"source"|timed_at/);
  });

  it("serves version 1 to a reader that names none: each item as version 1 says it, what it cannot say withdrawn", async () => {
    const { caps } = await setup();
    await seedEverything(caps);
    const v1 = await pageV1(caps);
    const v2 = await pageV2(caps);
    expect(v1.version).toBe(1);
    for (const [i, item] of v2.items.entries()) {
      expect(v1.items[i]).toEqual(await catalogueItemV1Of(item, { as_of: v1.as_of }));
    }
    const listed = v1.items.filter((i): i is Extract<CatalogueItem, { state: "listed" }> => i.state === "listed");
    // The two moka pots and the coffee: from, range, quote, made to order, a pre-order, an age, an own tax basis are not version 1's.
    expect(listed.map((i) => i.name).sort()).toEqual(["Coffee, 500 g", "Moka pot, 3 cups", "Moka pot, 6 cups"]);
    expect(listed.find((i) => i.name === "Coffee, 500 g")?.availability).toBe("in_stock");
    expect(v1.catalogue.count).toBe(listed.length);
    // One rev for both versions, so a ping's rev means the same to either reader.
    expect(v1.catalogue.rev).toBe(v2.catalogue.rev);
  });

  it("gives products by id in version 2, and the ids it has none for, long ones included", async () => {
    const { caps } = await setup();
    const { coffee } = await seedEverything(caps);
    const long = `gid://shop/ProductVariant/${"9".repeat(200)}`;
    const r = await caps.catalogue.items([coffee.id, long, "x".repeat(300)], req(`${BASE}/items?version=2`), {
      version: "2",
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const body = catalogueItemsV2Schema.parse(JSON.parse(r.body));
    expect(body.items.map((i) => i.id)).toEqual([coffee.id]);
    expect(body.missing).toEqual([long]);
  });

  it("keeps cursors to their version, and refuses what the spec refuses with its codes", async () => {
    const { caps } = await setup();
    for (let i = 0; i < 3; i++)
      await caps.setup.createProduct(owner, { name: `P${i}`, price: EUR(100 + i), active: true });
    const two = await caps.catalogue.changes({ version: "2", limit: "1" }, req(`${BASE}/changes?version=2&limit=1`));
    const one = await caps.catalogue.changes({ limit: "1" }, req(`${BASE}/changes?limit=1`));
    if (two.status !== 200 || one.status !== 200) throw new Error("no page");
    const c2 = JSON.parse(two.body).next_cursor as string;
    const c1 = JSON.parse(one.body).next_cursor as string;
    expect(c2).toMatch(/^[A-Za-z0-9._~-]{1,200}$/);
    expect(await caps.catalogue.changes({ version: "1", after: c2 }, req(BASE))).toMatchObject({
      status: 422,
      code: "cursor_invalid",
    });
    expect(await caps.catalogue.changes({ version: "2", after: c1 }, req(BASE))).toMatchObject({
      status: 422,
      code: "cursor_invalid",
    });
    expect((await caps.catalogue.changes({ version: "2", after: c2 }, req(BASE))).status).toBe(200);
    expect(await caps.catalogue.changes({ version: "3" }, req(BASE))).toMatchObject({ code: "version_unsupported" });
    expect(await caps.catalogue.changes({ version: "2", limit: "0" }, req(BASE))).toMatchObject({
      code: "limit_invalid",
    });
    expect(await caps.catalogue.changes({ version: "2", limit: "501" }, req(BASE))).toMatchObject({
      code: "limit_invalid",
    });
    // Each version's page has its own ETag.
    expect(two.etag).not.toBe(one.etag);
  });

  it("signs the policies document over its as_of and rev, and publishes today's returns as the default", async () => {
    const { caps } = await setup();
    await caps.updateSettings(owner, { doc: { returns: { days: 30, postage: "business" } } });
    const { body, signature, doc } = await policiesOf(caps);
    expect(doc.return_policies).toEqual([
      {
        id: "standard",
        name: "Standard",
        default: true,
        eligibility: "window",
        window_days: 30,
        resolutions: ["refund"],
        methods: ["by_post"],
        return_postage: "business",
      },
    ]);
    const keys = (await caps.receipts.jwks()).keys;
    expect(await verifyCatalogueSignature(signature, keys, body)).toMatchObject({
      iss: DOMAIN,
      url: `${BASE}/policies`,
      as_of: doc.as_of,
      rev: doc.rev,
    });
    // The profile says the same, in schema.org's words.
    expect((await caps.getBusinessProfile()).return_policy).toMatchObject({
      merchantReturnDays: 30,
      returnFees: "https://schema.org/FreeReturn",
    });
  });
});

describe("the owner's model", () => {
  it("keeps every money, age and policy field the owner's in person: never their AI, never another system's key", async () => {
    const { caps } = await setup();
    const p = await caps.setup.createProduct(owner, { name: "Kettle", price: EUR(3000), active: true });
    const g = await caps.setup.upsertProductGroup(ai, { title: "Kettle" });
    for (const [field, value] of [
      ["price_model", "from"],
      ["list_price", EUR(4000)],
      ["unit_price", { measure: { value: 1, unit: "l" }, reference: { value: 1, unit: "l" } }],
      ["tax_included", false],
      ["age_restricted", { min_age: 18, kind: "blades" }],
      ["fulfil_methods", ["shipping"]],
      ["shipping_profile", "standard"],
      ["weight", { value: 1, unit: "kg" }],
      ["return_policy", "standard"],
      ["few_left", 2],
      ["multipack", 2],
      ["availability", "made_to_order"],
    ] as const) {
      for (const who of [ai, zapier]) {
        await expect(
          caps.setup.updateProduct(who, { product_id: p.id, [field]: value } as never),
          `${field} by ${who.actor.kind}`,
        ).rejects.toMatchObject({ code: "not_allowed", details: { reason: "owner_in_person" } });
      }
    }
    // Writing one back as it is changes nothing, and is never refused; a group and its options are no money.
    await caps.setup.updateProduct(ai, { product_id: p.id, price_model: "fixed" });
    const grouped = await caps.setup.updateProduct(ai, {
      product_id: p.id,
      group_id: g.id,
      options: [{ key: "capacity", name: "Capacity", value: "1.7 l" }],
    });
    expect(grouped).toMatchObject({ groupId: g.id, groupPosition: 1 });
    for (const who of [ai, zapier]) {
      await expect(caps.putShippingProfile(who, STANDARD_SHIPPING)).rejects.toMatchObject({ code: "not_allowed" });
      await expect(
        caps.putReturnPolicy(who, {
          id: "thirty",
          name: "30 days",
          eligibility: "window",
          window_days: 30,
          resolutions: ["refund"],
          methods: ["in_store"],
        }),
      ).rejects.toMatchObject({ code: "not_allowed" });
    }
  });

  it("refuses a price of 0, a range with no top, a 'was' price without 30 days behind it, and dates the wrong way round", async () => {
    const { caps } = await setup();
    await expect(
      caps.setup.createProduct(owner, { name: "Free", price: EUR(0), price_model: "from", active: true }),
    ).rejects.toMatchObject({ details: { code: "price_missing" } });
    await expect(
      caps.setup.createProduct(owner, { name: "Fix", price: EUR(1000), price_model: "range", active: true }),
    ).rejects.toMatchObject({ details: { code: "price_max_missing" } });
    await expect(
      caps.setup.createProduct(owner, { name: "Sale", price: EUR(800), list_price: EUR(1000), active: true }),
    ).rejects.toMatchObject({ details: { code: "list_price_never_seen" } });
    await expect(
      caps.setup.createProduct(owner, {
        name: "Late",
        price: EUR(800),
        available_from: new Date(T0 + 5 * DAY).toISOString(),
        available_until: new Date(T0 + DAY).toISOString(),
        availability: "backorder",
        active: true,
      }),
    ).rejects.toMatchObject({ details: { code: "available_dates_order" } });
    await expect(
      caps.setup.createProduct(owner, { name: "Pack", price: EUR(800), multipack: 6, is_bundle: true, active: true }),
    ).rejects.toMatchObject({ details: { code: "bundle_multipack" } });
    await expect(
      caps.setup.createProduct(owner, {
        name: "Knife",
        price: EUR(800),
        age_restricted: { min_age: 18, kind: "knives" },
        active: true,
      }),
    ).rejects.toMatchObject({ details: { code: "age_kind_unknown" } });
    await expect(
      caps.setup.createProduct(owner, { name: "X", price: EUR(800), shipping_profile: "nope", active: true }),
    ).rejects.toMatchObject({ details: { code: "shipping_profile_unknown" } });
  });

  it("publishes a 'was' price only once the price held at or above it for the 30 days before the cut", async () => {
    const { caps } = await setup();
    const p = await caps.setup.createProduct(owner, { name: "Lamp", price: EUR(1000), active: true });
    // Ten days on, a cut: the record does not reach back 30 days before it.
    clock = T0 + 10 * DAY;
    await expect(
      caps.setup.updateProduct(owner, { product_id: p.id, price: EUR(800), list_price: EUR(1000) }),
    ).rejects.toMatchObject({ details: { code: "list_price_history_short" } });
    // Forty days at 1000, then the cut: shown.
    clock = T0 + 40 * DAY;
    await caps.setup.updateProduct(owner, { product_id: p.id, price: EUR(800), list_price: EUR(1000) });
    const item = (await pageV2(caps)).items.find((i) => i.id === p.id);
    expect(item).toMatchObject({ price: EUR(800), list_price: EUR(1000) });
    const door = (await caps.listProducts({ limit: 10 })).items.find((i) => i.id === p.id);
    expect(door?.list_price).toEqual(EUR(1000));
    // The price back up to it: the "was" price is left unshown, never the price refused.
    clock = T0 + 41 * DAY;
    await caps.setup.updateProduct(owner, { product_id: p.id, price: EUR(1000) });
    expect((await pageV2(caps)).items.find((i) => i.id === p.id)).not.toHaveProperty("list_price");
  });

  it("keeps tobacco, cannabis and weapons on sale at the business's own doors and off networks, with why", async () => {
    const { caps } = await setup();
    const vape = await caps.setup.createProduct(owner, {
      name: "Vape pen",
      price: EUR(2500),
      age_restricted: { min_age: 18, kind: "vape" },
      active: true,
    });
    const tea = await caps.setup.createProduct(owner, { name: "Green tea", price: EUR(500), active: true });
    const page = await pageV2(caps);
    expect(page.items.find((i) => i.id === vape.id)?.state).toBe("withdrawn");
    expect(page.items.find((i) => i.id === tea.id)?.state).toBe("listed");
    expect(page.catalogue.count).toBe(1);
    const door = (await caps.listProducts({ limit: 10 })).items.find((i) => i.id === vape.id);
    expect(door?.age_restricted).toMatchObject({ kind: "tobacco_nicotine", label: "ID checked at handover: 18+" });
    expect((await caps.getBusinessProfile()).age_check?.sentence).toMatch(/ID checked at handover: 18\+/);
    const status = await caps.catalogueStatus(owner);
    expect(status.products.find((p) => p.id === vape.id)?.notes).toEqual([
      expect.objectContaining({ code: "catalogue_problem", problem: "age_kind_off" }),
    ]);
  });

  it("refuses a return policy under the 14 days in the EU and the UK, and shows a shorter one plainly elsewhere", async () => {
    const { caps } = await setup();
    const seven = {
      id: "seven",
      name: "7 days",
      default: true,
      eligibility: "window" as const,
      window_days: 7,
      resolutions: ["exchange" as const],
      methods: ["in_store" as const],
    };
    await expect(caps.putReturnPolicy(owner, seven)).rejects.toMatchObject({ details: { code: "withdrawal_14_days" } });
    await caps.updateSettings(owner, { doc: { commerce: { legal: { country: "PT" } } } });
    await expect(caps.putReturnPolicy(owner, seven)).rejects.toMatchObject({ details: { code: "withdrawal_14_days" } });
    await caps.updateSettings(owner, { doc: { commerce: { legal: { country: "BR" } } } });
    const state = await caps.putReturnPolicy(owner, seven);
    // The standard policy it stood in for is kept, no longer the default.
    expect(state.return_policies.map((p) => [p.id, p.default ?? false])).toEqual([
      ["standard", false],
      ["seven", true],
    ]);
    expect((await caps.getBusinessProfile()).return_policy).toMatchObject({
      merchantReturnDays: 7,
      returnMethod: "https://schema.org/ReturnInStore",
      refundType: "https://schema.org/ExchangeRefund",
    });
    await expect(caps.deletePolicy(owner, { kind: "returns", id: "seven" })).rejects.toMatchObject({
      details: { code: "default_policy" },
    });
  });

  it("refuses a shipping profile a reader would drop a part of, and one a product still names from going", async () => {
    const { caps } = await setup();
    const bad = structuredClone(STANDARD_SHIPPING);
    (bad.zones[0]?.services[0] as { transit_days: { min: number; max: number } }).transit_days = { min: 3, max: 1 };
    await expect(caps.putShippingProfile(owner, bad)).rejects.toMatchObject({
      details: { code: "policies_transit_order" },
    });
    await caps.putShippingProfile(owner, STANDARD_SHIPPING);
    await caps.setup.createProduct(owner, { name: "Pot", price: EUR(900), shipping_profile: "standard", active: true });
    await expect(caps.deletePolicy(owner, { kind: "shipping", id: "standard" })).rejects.toMatchObject({
      details: { code: "in_use" },
    });
  });
});

describe("time is a change", () => {
  it("withdraws a product past its last day, and gives a pre-order a new position when it comes out", async () => {
    const { db, caps } = await setup();
    const { hamper, book } = await seedEverything(caps);
    const first = await pageV2(caps);
    const seqOf = async (id: string) =>
      (await db.client.query({ sql: "SELECT catalogue_seq FROM products WHERE id = ?", params: [id], method: "all" }))
        .rows[0]?.[0];
    const before = { hamper: await seqOf(hamper.id), book: await seqOf(book.id) };
    clock = T0 + 21 * DAY;
    const later = await pageV2(caps);
    expect(later.catalogue.rev).not.toBe(first.catalogue.rev);
    expect(later.items.find((i) => i.id === hamper.id)?.state).toBe("withdrawn");
    expect(later.items.find((i) => i.id === book.id)).toMatchObject({ state: "listed", availability: "on_sale" });
    expect(await seqOf(hamper.id)).not.toBe(before.hamper);
    expect(await seqOf(book.id)).not.toBe(before.book);
    // Once each: read again, nothing moves.
    const again = await seqOf(book.id);
    await pageV2(caps);
    expect(await seqOf(book.id)).toBe(again);
  });
});

describe("quote_shipping", () => {
  it("quotes a basket by the owner's rate tables, free over the threshold, an age only by a service that checks ID", async () => {
    const { caps } = await setup();
    const { variants, cake, wine } = await seedEverything(caps);
    const pot = variants[0]?.id as string;
    const q = await caps.quoteShipping({ lines: [{ product_id: pot, quantity: 2 }], destination: { country: "PT" } });
    expect(q.quotes).toEqual([
      expect.objectContaining({
        zone: "Mainland",
        product_ids: [pot],
        services: [expect.objectContaining({ fee: EUR(450) })],
      }),
    ]);
    const heavy = await caps.quoteShipping({
      lines: [{ product_id: pot, quantity: 4 }],
      destination: { country: "PT" },
    });
    // 4 × 24.90 is over 50: free.
    expect(heavy.quotes[0]?.services[0]?.fee).toEqual(EUR(0));
    const azores = await caps.quoteShipping({
      lines: [{ product_id: pot, quantity: 1 }],
      destination: { country: "PT", region: "PT-20" },
    });
    expect(azores.quotes[0]?.why).toBe("not_shipped_there");
    const other = await caps.quoteShipping({
      lines: [
        { product_id: cake.id, quantity: 1 },
        { product_id: wine.id, quantity: 1 },
        { product_id: "nope", quantity: 1 },
      ],
      destination: { country: "PT" },
    });
    expect(other.unquoted).toEqual([
      { product_id: cake.id, why: "not_priced" },
      { product_id: wine.id, why: "not_shipped" },
      { product_id: "nope", why: "unknown_product" },
    ]);
  });
});

describe("create_order", () => {
  it("sends a price that is not fixed to a person to quote, naming the product as the catalogue has it", async () => {
    const { db, caps } = await setup();
    const { cake, repair, coffee } = await seedEverything(caps);
    for (const p of [cake, repair]) {
      const r = await priceFromCatalogue(db, "order", {
        orderedItem: [{ productId: p.id, name: "anything", quantity: 1, price: EUR(1) }],
        totalPrice: EUR(1),
      });
      expect(r.unpriced, p.name).toBe(true);
      expect((r.payload as { orderedItem: { name: string }[] }).orderedItem[0]?.name).toBe(p.name);
    }
    const fixed = await priceFromCatalogue(db, "order", {
      orderedItem: [{ productId: coffee.id, name: "Coffee", quantity: 1, price: EUR(1) }],
      totalPrice: EUR(1),
    });
    expect(fixed.unpriced).toBe(false);
    expect(fixed.payload).toMatchObject({ totalPrice: EUR(450) });
  });
});

describe("create_order, past the last day", () => {
  it("refuses a line for a product past the last moment it could be ordered, as for one off sale", async () => {
    const { db, caps } = await setup();
    const { hamper } = await seedEverything(caps);
    const order = {
      orderedItem: [{ productId: hamper.id, name: "Hamper", quantity: 1, price: EUR(6500) }],
      totalPrice: EUR(6500),
    };
    expect((await priceFromCatalogue(db, "order", order, undefined, T0)).unpriced).toBe(false);
    await expect(priceFromCatalogue(db, "order", order, undefined, T0 + 21 * DAY)).rejects.toMatchObject({
      code: "invalid_input",
      fields: [{ message: "not on sale" }],
    });
  });
});

describe("feed imports", () => {
  it("keep a feed's variants as one group, and a group whose variants do not hold together as products of their own", async () => {
    const { db } = await setup();
    const csv = [
      "id,title,price,item_group_id,color,size",
      "TEE-S-RED,Tee S red,12.00 EUR,TEE,Red,S",
      "TEE-M-RED,Tee M red,12.00 EUR,TEE,Red,M",
      "MUG-1,Mug blue,8.00 EUR,MUG,Blue,",
      "MUG-2,Mug blue large,9.00 EUR,MUG,Blue,L",
      "PLAIN,Plain thing,5.00 EUR,,,",
    ].join("\n");
    const parsed = parseFeed(csv, { now: T0 });
    expect(parsed.products.find((p) => p.externalId === "TEE-S-RED")?.variant).toEqual({
      group: "TEE",
      options: [
        { key: "color", name: "Colour", value: "Red" },
        { key: "size", name: "Size", value: "S" },
      ],
    });
    await upsertCatalogue(db, {
      source: "feed:test",
      products: parsed.products.map((p) => ({ ...p, ...(p.variant ? { variant: p.variant } : {}) })),
      now: T0,
      seenAt: T0,
      currency: "EUR",
    });
    const groups = await db.orm.select().from(productGroups);
    expect(groups.map((g) => [g.externalId, g.title])).toEqual([["TEE", "Tee"]]);
    const rows = await db.orm.select().from(products);
    const tee = rows.filter((r) => r.externalId?.startsWith("TEE"));
    expect(tee.map((r) => [r.groupId, r.groupPosition])).toEqual([
      [groups[0]?.id, 1],
      [groups[0]?.id, 2],
    ]);
    // The mugs name different options: each is a product of its own.
    expect(rows.filter((r) => r.externalId?.startsWith("MUG")).map((r) => r.groupId)).toEqual([null, null]);
    // Every price that came in is the start of its record.
    expect((await db.orm.select().from(productPrices)).length).toBe(5);
  });
});

describe("what a page counts", () => {
  const seqOf = async (db: Awaited<ReturnType<typeof setup>>["db"], id: string) =>
    Number(
      (await db.client.query({ sql: "SELECT catalogue_seq FROM products WHERE id = ?", params: [id], method: "all" }))
        .rows[0]?.[0],
    );

  it("counts what it lists: an import that takes a price past its range's top withdraws it, and the count with it", async () => {
    const { db, caps } = await setup();
    const feed = (price: string) => parseFeed(`id,title,price\nLAMP,Lamp,${price} EUR`, { now: clock }).products;
    await upsertCatalogue(db, { source: "feed:test", products: feed("40.00"), now: T0, seenAt: T0, currency: "EUR" });
    const [lamp] = await db.orm.select().from(products);
    if (!lamp) throw new Error("no lamp");
    await caps.setup.updateProduct(owner, { product_id: lamp.id, price_model: "range", price_max: EUR(6000) });
    expect((await pageV2(caps)).catalogue.count).toBe(1);
    // The shop's price goes to 70.00, past the top the owner set: a reader holds it, so it is withdrawn.
    clock = T0 + DAY;
    await upsertCatalogue(db, {
      source: "feed:test",
      products: feed("70.00"),
      now: clock,
      seenAt: clock,
      currency: "EUR",
    });
    const v2 = await pageV2(caps);
    expect(v2.items).toEqual([expect.objectContaining({ id: lamp.id, state: "withdrawn" })]);
    expect(v2.catalogue.count).toBe(0);
    const v1 = await pageV1(caps);
    expect(v1.catalogue.count).toBe(v1.items.filter((i) => i.state === "listed").length);
    const status = await caps.catalogueStatus(owner);
    expect(status.products.find((p) => p.id === lamp.id)?.notes).toEqual([
      expect.objectContaining({ code: "catalogue_problem", problem: "price_max_not_above" }),
    ]);
    expect(status.counts.listed).toBe(0);
  });

  it("counts what it lists in both versions when a stored price is in no ISO currency", async () => {
    const { db, caps } = await setup();
    const odd = await caps.setup.createProduct(owner, { name: "Token", price: EUR(500), active: true });
    await caps.setup.createProduct(owner, { name: "Tea", price: EUR(300), active: true });
    await db.client.query({
      sql: `UPDATE products SET price = json_set(price, '$.currency', 'XXA'), catalogue_seq = catalogue_seq + 10 WHERE id = ?`,
      params: [odd.id],
      method: "run",
    });
    for (const page of [await pageV2(caps), await pageV1(caps)]) {
      const listed = page.items.filter((i) => i.state === "listed");
      expect(listed.map((i) => i.id)).not.toContain(odd.id);
      expect(page.catalogue.count).toBe(listed.length);
      expect(page.catalogue.count).toBe(1);
    }
  });

  it("moves an age-restricted product when the default shipping profile it shipped under goes", async () => {
    const { db, caps } = await setup();
    await caps.putShippingProfile(owner, STANDARD_SHIPPING);
    const wine = await caps.setup.createProduct(owner, {
      name: "Vinho Tinto",
      price: EUR(1200),
      age_restricted: { min_age: 18, kind: "wine" },
      fulfil_methods: ["shipping"],
      active: true,
    });
    // Shipping only, by a profile none of whose services checks ID: held.
    const before = await pageV2(caps);
    expect(before.items.find((i) => i.id === wine.id)?.state).toBe("withdrawn");
    expect(before.catalogue.count).toBe(0);
    const seq = await seqOf(db, wine.id);
    clock = T0 + 1000;
    await caps.deletePolicy(owner, { kind: "shipping", id: "standard" });
    expect(await seqOf(db, wine.id)).toBeGreaterThan(seq);
    const after = await pageV2(caps);
    expect(after.items.find((i) => i.id === wine.id)?.state).toBe("listed");
    expect(after.catalogue.count).toBe(1);
  });
});

describe("a price of 0", () => {
  it("leaves one stored at 0 as it is: renamed, given pictures, and withdrawn from the feed, never refused", async () => {
    const { db, caps } = await setup();
    const tasting = await caps.setup.createProduct(owner, { name: "Tasting", price: EUR(100), active: true });
    // Stored at 0 as version 1 allowed (a free tasting).
    await db.client.query({
      sql: `UPDATE products SET price = json_set(price, '$.value', 0) WHERE id = ?`,
      params: [tasting.id],
      method: "run",
    });
    // The owner app's form always sends the price, as it is.
    const renamed = await caps.setup.updateProduct(owner, {
      product_id: tasting.id,
      name: "Free tasting, two glasses",
      price: EUR(0),
      media: [{ type: "image", url: "https://cdn.loja.pt/img/tasting.jpg" }],
    });
    expect(renamed).toMatchObject({ name: "Free tasting, two glasses", price: EUR(0) });
    const page = await pageV2(caps);
    expect(page.items.find((i) => i.id === tasting.id)?.state).toBe("withdrawn");
    expect(page.catalogue.count).toBe(0);
    const notes = (await caps.catalogueStatus(owner)).products.find((p) => p.id === tasting.id)?.notes;
    expect(notes).toEqual([expect.objectContaining({ code: "price_zero" })]);
  });

  it("refuses a write that makes a listed price 0, and keeps one at 0 that networks never see", async () => {
    const { caps } = await setup();
    const lamp = await caps.setup.createProduct(owner, { name: "Lamp", price: EUR(2000), active: true });
    await expect(caps.setup.updateProduct(owner, { product_id: lamp.id, price: EUR(0) })).rejects.toMatchObject({
      details: { code: "price_missing" },
    });
    const cake = await caps.setup.createProduct(owner, { name: "Cake", price_model: "quote", active: true });
    await expect(caps.setup.updateProduct(owner, { product_id: cake.id, price_model: "fixed" })).rejects.toMatchObject({
      details: { code: "price_missing" },
    });
    // Kept off networks, a price of 0 is the owner's to keep at their own doors.
    const side = await caps.setup.createProduct(owner, { name: "Bread", price: EUR(0), listed: false, active: true });
    expect(side).toMatchObject({ price: EUR(0), listed: 0 });
  });
});

describe("one quote for one profile", () => {
  it("quotes a product that names the default profile and one that names none as one basket", async () => {
    const { caps } = await setup();
    await caps.putShippingProfile(owner, STANDARD_SHIPPING);
    const a = await caps.setup.createProduct(owner, {
      name: "Bowl",
      price: EUR(3000),
      shipping_profile: "standard",
      weight: { value: 0.5, unit: "kg" },
      active: true,
    });
    const b = await caps.setup.createProduct(owner, {
      name: "Plate",
      price: EUR(3000),
      weight: { value: 0.5, unit: "kg" },
      active: true,
    });
    const q = await caps.quoteShipping({
      lines: [
        { product_id: a.id, quantity: 1 },
        { product_id: b.id, quantity: 1 },
      ],
      destination: { country: "PT" },
    });
    // 60.00 together is over the 50.00 it ships free over: one quote, at nothing.
    expect(q.quotes).toEqual([
      expect.objectContaining({
        profile: "standard",
        product_ids: [a.id, b.id],
        services: [expect.objectContaining({ fee: EUR(0) })],
      }),
    ]);
  });
});

describe("the barcode a feed publishes", () => {
  it("is the stored one read again by today's check, as the doors give it", async () => {
    const { db, caps } = await setup();
    const p = await caps.setup.createProduct(owner, { name: "Kettle", price: EUR(3000), active: true });
    // A barcode stored before, whose check digit is wrong.
    await db.client.query({
      sql: "UPDATE products SET gtin = '09506000134353' WHERE id = ?",
      params: [p.id],
      method: "run",
    });
    expect((await pageV2(caps)).items.find((i) => i.id === p.id)).toMatchObject({ state: "listed", gtin: null });
    expect((await pageV1(caps)).items.find((i) => i.id === p.id)).toMatchObject({ state: "listed", gtin: null });
    expect((await caps.listProducts({ limit: 10 })).items.find((i) => i.id === p.id)?.gtin).toBeNull();
  });
});

describe("a menu's own age", () => {
  it("keeps a drink its menu sells at 18+ off networks until its kind is given, labelled at the doors and in the profile", async () => {
    const { db, caps } = await setup();
    const beer = await caps.setup.createProduct(owner, { name: "Super Bock", price: EUR(250), active: true });
    const seq = Number(
      (
        await db.client.query({
          sql: "SELECT catalogue_seq FROM products WHERE id = ?",
          params: [beer.id],
          method: "all",
        })
      ).rows[0]?.[0],
    );
    await caps.food.setMenuItem(owner, {
      product_id: beer.id,
      menu: menuFieldsSchema.parse({ section: "drinks", ageRestricted: 18 }),
    });
    const moved = Number(
      (
        await db.client.query({
          sql: "SELECT catalogue_seq FROM products WHERE id = ?",
          params: [beer.id],
          method: "all",
        })
      ).rows[0]?.[0],
    );
    expect(moved).toBeGreaterThan(seq);
    const page = await pageV2(caps);
    expect(page.items.find((i) => i.id === beer.id)?.state).toBe("withdrawn");
    expect(page.catalogue.count).toBe(0);
    const door = (await caps.listProducts({ limit: 10 })).items.find((i) => i.id === beer.id);
    expect(door?.age_restricted).toMatchObject({ min_age: 18, kind: null, label: "ID checked at handover: 18+" });
    expect((await caps.getBusinessProfile()).age_check?.min_ages).toEqual([18]);
    const notes = (await caps.catalogueStatus(owner)).products.find((p) => p.id === beer.id)?.notes;
    expect(notes).toEqual([
      expect.objectContaining({
        code: "catalogue_problem",
        problem: "age_kind_unknown",
        words: expect.stringMatching(/menu sells it at 18\+/),
      }),
    ]);
    // Its kind given: listed, with its age.
    await caps.setup.updateProduct(owner, { product_id: beer.id, age_restricted: { min_age: 18, kind: "beer" } });
    expect((await pageV2(caps)).items.find((i) => i.id === beer.id)).toMatchObject({
      state: "listed",
      age_restricted: { min_age: 18, kind: "alcohol", check: "id_at_handover" },
    });
  });
});

describe("the return policies the inbox holds to", () => {
  it("holds a refund return open as long as the published policy of each line says, never less than the settings", async () => {
    const { db, caps } = await setup();
    await caps.putReturnPolicy(owner, {
      id: "sixty",
      name: "60 days",
      default: true,
      eligibility: "window",
      window_days: 60,
      resolutions: ["refund"],
      methods: ["by_post"],
      return_postage: "customer",
    });
    await caps.putReturnPolicy(owner, {
      id: "swap",
      name: "Exchange, 90 days",
      eligibility: "window",
      window_days: 90,
      resolutions: ["exchange"],
      methods: ["in_store"],
    });
    const lamp = await caps.setup.createProduct(owner, { name: "Lamp", price: EUR(2000), active: true });
    const vase = await caps.setup.createProduct(owner, {
      name: "Vase",
      price: EUR(2000),
      return_policy: "swap",
      active: true,
    });
    const settings = await readSettings(db);
    const days = (ids: string[]) =>
      publishedRefundDays(
        db,
        { orderedItem: ids.map((productId) => ({ productId, name: "x", quantity: 1 })) },
        settings,
      );
    expect(await days([lamp.id])).toBe(60);
    // An exchange is no refund: the settings' days and the law's stand for that line.
    expect(await days([vase.id])).toBe(0);
    expect(await days([lamp.id, vase.id])).toBe(0);
  });

  it("refuses to move the business to a country whose law gives 14 days while a policy is shorter", async () => {
    const { caps } = await setup();
    await caps.updateSettings(owner, { doc: { commerce: { legal: { country: "BR" } } } });
    await caps.putReturnPolicy(owner, {
      id: "seven",
      name: "7 days",
      default: true,
      eligibility: "window",
      window_days: 7,
      resolutions: ["exchange"],
      methods: ["in_store"],
    });
    await expect(caps.updateSettings(owner, { doc: { commerce: { legal: { country: "PT" } } } })).rejects.toMatchObject(
      { details: { code: "withdrawal_14_days", policies: ["seven"] } },
    );
    await expect(caps.updateSettings(owner, { doc: { commerce: { legal: { country: "" } } } })).rejects.toMatchObject({
      details: { code: "withdrawal_14_days" },
    });
    await caps.updateSettings(owner, { doc: { commerce: { legal: { country: "US" } } } });
  });
});
