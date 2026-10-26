import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { productNotes } from "../src/catalogue/diagnostics";
import { createDb, type Db } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { products } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * What the owner sees of their products on networks (ADR-029): the status, and each product's "what
 * needs a look" in plain words, Merchant Center style; and the one-time offer to use product codes
 * that are barcodes as barcodes. Node and workerd.
 */
const T0 = Date.parse("2026-10-26T09:00:00Z");
const NET = "https://network.example.com";
let clock = T0;
const owner: Caller = {
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock,
};
const ai: Caller = {
  actor: { kind: "owner_ai", id: "client_1", channel: "rest" },
  actsAs: "owner",
  principal: { via: "oauth", id: "client_1", name: "Assistant", scopes: ["*"], userId: "user_1" },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock,
};

type Row = typeof products.$inferInsert;
async function setup(opts: { sign?: boolean } = {}) {
  clock = T0;
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const caps = new Capabilities(
    db,
    opts.sign === false ? null : createSecretBox(["catalogue-status-test-0123456789abcdef"]),
  );
  return { db, caps };
}
async function add(db: Db, over: Partial<Row>): Promise<string> {
  const id = ulid();
  await db.orm.insert(products).values({
    id,
    name: "Moka pot",
    price: { value: 1890, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
    ...over,
  });
  return id;
}
const words = (row: Partial<Row>) =>
  productNotes(
    {
      name: "Moka pot",
      price: { value: 1890, currency: "EUR" },
      active: 1,
      listed: 1,
      source: "builtin",
      gtin: null,
      gtinGiven: null,
      ...row,
    } as Parameters<typeof productNotes>[0],
    [],
  ).map((n) => n.words);

describe("what needs a look", () => {
  it("says what is wrong with a barcode, and why it is listed without one", () => {
    expect(words({ gtinGiven: "4006381333932" })).toEqual([
      "The barcode 4006381333932 does not add up: its last digit should be 1, so one digit is probably wrong. Fix it where it came from (your feed or shop) and it updates at the next read, or ask your AI to propose the right one for you to confirm. Listed without a barcode until then.",
    ]);
    expect(words({ gtinGiven: "12345" })).toEqual([
      "A barcode has 8, 12, 13 or 14 digits; 12345 has 5. Listed without a barcode until it is fixed.",
    ]);
    expect(words({ gtinGiven: "4.00638E+12" })).toEqual([
      "The barcode came in as 4.00638E+12: a spreadsheet turned it into a number, which can lose its digits. Set that column to text, export it again and import it. Listed without a barcode until then.",
    ]);
    expect(words({ gtinGiven: "3017620422003.0" })).toEqual([
      "The barcode came in as 3017620422003.0: a spreadsheet turned it into a number, which can lose its digits. Set that column to text, export it again and import it. Listed without a barcode until then.",
    ]);
    expect(words({ gtinGiven: "2001234567893" })).toEqual([
      "2001234567893 is a shop's own code, which works only where it was printed, so it is not used as a barcode. If the pack has a barcode, put it where this came from (your feed or shop), or ask your AI to propose it for you to confirm.",
    ]);
    expect(words({ gtinGiven: "9811234567891" })).toEqual([
      "9811234567891 is a coupon or receipt number, not a product's barcode.",
    ]);
  });

  it("offers a barcode the owner's AI proposed, for one tap", () => {
    const notes = productNotes(
      {
        name: "Moka pot",
        price: { value: 1890, currency: "EUR" },
        active: 1,
        listed: 1,
        source: "builtin",
        gtin: null,
        gtinGiven: "04006381333931",
      } as Parameters<typeof productNotes>[0],
      [],
    );
    expect(notes).toEqual([
      {
        code: "gtin_proposed",
        words: "Your AI proposed the barcode 4006381333931. Use it?",
        action: "confirm_barcode",
      },
    ]);
  });

  it("says why a product is on no network: no price yet, a price of 0, a template's sample name", () => {
    expect(
      words({ price: { value: 0, currency: "EUR" }, active: 0, source: "feed:https://shop.example.com/f.csv" }),
    ).toEqual(["No price yet, so it is on no network."]);
    expect(words({ price: { value: 0, currency: "EUR" } })).toEqual(["Priced at 0, so it is on no network."]);
    expect(words({ name: "I'm a product" })).toEqual(["Its name looks like a template's sample."]);
    expect(words({})).toEqual([]);
  });

  it("gives a network's own reason for holding a product, by the network's name", () => {
    const notes = productNotes(
      {
        name: "Moka pot",
        price: { value: 1890, currency: "EUR" },
        active: 1,
        listed: 1,
        source: "builtin",
        gtin: null,
        gtinGiven: null,
      } as Parameters<typeof productNotes>[0],
      [{ network: NET, why: "Its picture did not load." }],
    );
    expect(notes.map((n) => n.words)).toEqual(["network.example.com holds it back: Its picture did not load."]);
  });
});

describe("the owner's catalogue status", () => {
  it("counts what is listed and what needs a look, and puts each note beside its product", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { networks: { [NET]: { enabled: true } } } });
    await add(db, { name: "Kettle" });
    const bad = await add(db, { name: "Mug", gtinGiven: "4006381333932" });
    const off = await add(db, { name: "Teapot", listed: 0 });
    const held = await add(db, { name: "Tray" });
    await db.client.query({
      sql: "INSERT INTO network_status (network, registration, catalogue_listed, catalogue_count, catalogue_held, catalogue_at, updated_at) VALUES (?, 'registered', 1, 2, ?, ?, ?)",
      params: [
        NET,
        JSON.stringify({
          listed: true,
          held: [{ why: "Its picture did not load.", count: 1, sample: [{ id: held, name: "Tray" }] }],
          checked_at: "2026-10-26T10:42:00.000Z",
        }),
        T0,
        T0,
      ],
      method: "run",
    });
    const st = await caps.catalogueStatus(owner);
    expect(st).toMatchObject({
      listed: true,
      tax_included: null,
      blocked: null,
      counts: { listed: 3, needs_look: 2, kept_off: 1, off_sale: 0 },
    });
    expect(st.products.find((p) => p.id === bad)?.notes[0]?.code).toBe("gtin_check_digit");
    expect(st.products.find((p) => p.id === held)?.notes[0]?.words).toBe(
      "network.example.com holds it back: Its picture did not load.",
    );
    expect(st.products.some((p) => p.id === off)).toBe(false);
    expect(st.networks).toEqual([
      expect.objectContaining({
        origin: NET,
        wants: true,
        told: true,
        offers_live: 2,
        checked_at: "2026-10-26T10:42:00.000Z",
      }),
    ]);
  });

  it("says why the switch cannot work: out of the directories, no network, no key to sign with", async () => {
    const { caps } = await setup();
    expect((await caps.catalogueStatus(owner)).blocked).toBe("no_network");
    await caps.updateSettings(owner, { doc: { networks: { [NET]: { enabled: true } } } });
    expect((await caps.catalogueStatus(owner)).blocked).toBeNull();
    await caps.updateSettings(owner, { doc: { directory: { listed: false } } });
    expect((await caps.catalogueStatus(owner)).blocked).toBe("out_of_directory");
    const unsigned = await setup({ sign: false });
    await unsigned.caps.updateSettings(owner, { doc: { networks: { [NET]: { enabled: true } } } });
    expect((await unsigned.caps.catalogueStatus(owner)).blocked).toBe("cannot_sign");
  });
});

describe("product codes that look like barcodes", () => {
  it("are offered once, for imported products only, and used only on the owner's tap", async () => {
    const { db, caps } = await setup();
    const feed = "feed:https://shop.example.com/products.csv";
    const a = await add(db, { name: "Kettle", sku: "4006381333931", source: feed, externalId: "1" });
    // A product whose code is its barcode already tells how this shop numbers its products.
    await add(db, { name: "Tray", sku: "96385074", gtin: "00000096385074", source: feed, externalId: "3" });
    await add(db, { name: "Bowl", sku: "6161234567890", gtin: "06161234567890", source: feed, externalId: "4" });
    await add(db, { name: "Mug", sku: "MUG-1", source: feed, externalId: "2" });
    await add(db, { name: "Typed in", sku: "036000291452" });
    expect((await caps.catalogueStatus(owner)).sku_offer).toEqual({ count: 1 });
    await expect(caps.useSkusAsBarcodes(ai, { use: true })).rejects.toMatchObject({ code: "not_allowed" });
    clock = T0 + 1000;
    expect(await caps.useSkusAsBarcodes(owner, { use: true })).toEqual({ used: 1 });
    const [kettle] = await db.orm
      .select()
      .from(products)
      .where((await import("drizzle-orm")).eq(products.id, a));
    expect(kettle).toMatchObject({ gtin: "04006381333931", updatedAt: T0 + 1000 });
    expect((await caps.catalogueStatus(owner)).sku_offer).toBeNull();
  });

  it("are not offered when no more of them pass the check than chance would", async () => {
    const { db, caps } = await setup();
    // A shop's own numbers: 1 in 10 passes the check digit by chance (10000007 and 10000014 here).
    for (let n = 10000001; n <= 10000020; n++) {
      await add(db, {
        name: `Product ${n}`,
        sku: String(n),
        source: "feed:https://shop.example.com/p.csv",
        externalId: String(n),
      });
    }
    expect((await caps.catalogueStatus(owner)).sku_offer).toBeNull();
    expect(await caps.useSkusAsBarcodes(owner, { use: true })).toEqual({ used: 0 });
    const rows = await db.orm.select().from(products);
    expect(rows.filter((r) => r.gtin !== null)).toEqual([]);
  });

  it("are not offered on one or two codes, which chance could pass", async () => {
    const { db, caps } = await setup();
    await add(db, {
      name: "Kettle",
      sku: "4006381333931",
      source: "feed:https://shop.example.com/p.csv",
      externalId: "1",
    });
    await add(db, { name: "Cup", sku: "10000007", source: "feed:https://shop.example.com/p.csv", externalId: "2" });
    expect((await caps.catalogueStatus(owner)).sku_offer).toBeNull();
  });

  it("are not offered again once the owner says not now", async () => {
    const { db, caps } = await setup();
    await add(db, {
      name: "Kettle",
      sku: "4006381333931",
      source: "feed:https://shop.example.com/p.csv",
      externalId: "1",
    });
    expect(await caps.useSkusAsBarcodes(owner, { use: false })).toEqual({ used: 0 });
    expect((await caps.catalogueStatus(owner)).sku_offer).toBeNull();
  });
});
