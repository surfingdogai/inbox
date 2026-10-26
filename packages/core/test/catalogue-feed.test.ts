import { runMigrations } from "@surfingdog/platform";
import { type CataloguePage, cataloguePageSchema } from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { ulid } from "../src/ids";
import { verifyCatalogueSignature } from "../src/receipts/sign";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import type { products } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * The signed catalogue feed (ADR-029, protocol §4.18): `GET /v1/catalogue/changes`, as a network
 * reads it, page by page, while the business keeps changing its products. Node and workerd.
 */
const T0 = Date.parse("2026-10-26T09:00:00Z");
const DOMAIN = "inbox.loja.example";
const URL0 = `https://${DOMAIN}/v1/catalogue/changes`;

let clock = T0;
const owner: Caller = {
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock,
};

async function setup(opts: { sign?: boolean } = {}) {
  clock = T0;
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const caps = new Capabilities(
    db,
    opts.sign === false ? null : createSecretBox(["catalogue-feed-test-secret-0123456789"]),
  );
  return { db, caps };
}

async function seed(db: Db, n: number, at: number, over: Partial<typeof products.$inferInsert> = {}) {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: ulid(at),
    name: `Product ${String(i).padStart(4, "0")}`,
    price: { value: 100 + i, currency: "EUR" },
    createdAt: at,
    updatedAt: at,
    ...over,
  }));
  // One row a statement, forty statements a batch: D1 binds at most 100 values a statement.
  const statements = rows.map((r) => ({
    sql: `INSERT INTO products (id, name, price, active, listed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [r.id, r.name, JSON.stringify(r.price), r.active ?? 1, r.listed ?? 1, r.createdAt, r.updatedAt],
    method: "run" as const,
  }));
  for (let i = 0; i < statements.length; i += 40) await db.batch(statements.slice(i, i + 40));
  return rows;
}

type Read = Awaited<ReturnType<Capabilities["catalogue"]["changes"]>>;
const pageOf = (r: Read): CataloguePage => {
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return cataloguePageSchema.parse(JSON.parse(r.body));
};
const read = (caps: Capabilities, after?: string, limit = 500) =>
  caps.catalogue.changes(
    { ...(after ? { after } : {}), limit },
    { domain: DOMAIN, url: `${URL0}?limit=${limit}${after ? `&after=${after}` : ""}`, now: clock },
  );

/** Every page, from the start or from `after`, until the end; the ids each page held. */
async function readAll(caps: Capabilities, after?: string, between?: (n: number) => Promise<void>) {
  const seen: string[][] = [];
  let cursor = after;
  for (let n = 0; n < 50; n++) {
    const page = pageOf(await read(caps, cursor));
    seen.push(page.items.map((i) => i.id));
    if (page.next_cursor === null) return { seen, last: cursor };
    cursor = page.next_cursor;
    await between?.(n);
  }
  throw new Error("the feed never ended");
}

describe("the switch", () => {
  it("answers 404 while the products are kept off networks, or the business is out of the directories", async () => {
    const { db, caps } = await setup();
    await seed(db, 1, T0);
    expect((await read(caps)).status).toBe(200);
    await caps.updateSettings(owner, { doc: { catalogue: { listed: false } } });
    expect((await read(caps)).status).toBe(404);
    await caps.updateSettings(owner, { doc: { catalogue: { listed: true }, directory: { listed: false } } });
    expect((await read(caps)).status).toBe(404);
  });

  it("answers 404 from an inbox that cannot sign, since no network could check the products came from it", async () => {
    const { db, caps } = await setup({ sign: false });
    await seed(db, 1, T0);
    expect(await read(caps)).toMatchObject({ status: 404, why: "cannot_sign" });
  });
});

describe("pages", () => {
  it("come 500 at a time in the order things changed, and end", async () => {
    const { db, caps } = await setup();
    await seed(db, 1200, T0);
    const { seen } = await readAll(caps);
    expect(seen.map((p) => p.length)).toEqual([500, 500, 200]);
    expect(new Set(seen.flat()).size).toBe(1200);
  });

  it("miss nothing written while a network reads, even at the same millisecond as what it read", async () => {
    const { db, caps } = await setup();
    const rows = await seed(db, 1200, T0);
    const late: string[] = [];
    const { seen } = await readAll(caps, undefined, async (n) => {
      if (n > 0) return;
      // After the first page: one product written with the same time as the page's last, but an id
      // before it (a slow batch committing late), and one new one.
      const early = rows[3] as { id: string };
      await caps.setup.updateProduct({ ...owner, now: () => T0 }, { product_id: early.id, name: "Renamed" });
      late.push(early.id, ...(await seed(db, 1, T0 + 2000)).map((r) => r.id));
    });
    for (const id of late) expect(seen.slice(1).flat(), id).toContain(id);
  });

  it("resume from the after a reader asked its last page with, and give it what changed since", async () => {
    const { db, caps } = await setup();
    await seed(db, 600, T0);
    const { seen, last } = await readAll(caps);
    expect(seen.map((p) => p.length)).toEqual([500, 100]);
    clock = T0 + 60_000;
    const added = await seed(db, 2, clock);
    const again = await readAll(caps, last);
    // The last page again, which changes nothing a reader holds, and the two new ones after it.
    expect(again.seen.flat()).toEqual([...(seen[1] as string[]), ...added.map((r) => r.id)]);
  });

  it("refuse a cursor they did not give", async () => {
    const { caps } = await setup();
    await expect(read(caps, "not-a-cursor")).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("give archived, kept-off and zero-priced products as withdrawn, never their details", async () => {
    const { db, caps } = await setup();
    await seed(db, 1, T0, { name: "Archived", active: 0 });
    await seed(db, 1, T0, { name: "Kept off", listed: 0 });
    await seed(db, 1, T0, { name: "Free", price: { value: 0, currency: "EUR" } });
    await seed(db, 1, T0, { name: "Listed" });
    const page = pageOf(await read(caps));
    expect(page.items.map((i) => i.state).sort()).toEqual(["listed", "withdrawn", "withdrawn", "withdrawn"]);
    expect(JSON.stringify(page)).not.toMatch(/Archived|Kept off|Free/);
    expect(page.catalogue.count).toBe(1);
  });
});

describe("what a reader compares", () => {
  it("rev moves when a product changes, and when the tax chooser does", async () => {
    const { db, caps } = await setup();
    await seed(db, 2, T0);
    const a = (await caps.catalogue.summary()).rev;
    await caps.updateSettings(owner, { doc: { catalogue: { taxIncluded: true } } });
    const b = (await caps.catalogue.summary()).rev;
    expect(b).not.toBe(a);
    expect((await caps.catalogue.summary()).tax_included).toBe(true);
    await db.client.query({ sql: "UPDATE products SET updated_at = ?", params: [T0 + 1], method: "run" });
    expect((await caps.catalogue.summary()).rev).not.toBe(b);
  });

  it("an ETag the reader sends back gets a 304 while nothing changed", async () => {
    const { db, caps } = await setup();
    await seed(db, 2, T0);
    const first = await read(caps);
    if (first.status !== 200) throw new Error("expected a page");
    const again = await caps.catalogue.changes(
      { limit: 500 },
      { domain: DOMAIN, url: `${URL0}?limit=500`, now: clock, ifNoneMatch: first.etag },
    );
    expect(again.status).toBe(304);
  });

  it("every way a product changes moves it to the end of the feed", async () => {
    const { caps } = await setup();
    const when = async (fn: () => Promise<unknown>) => {
      clock += 1000;
      await fn();
      const page = pageOf(await read(caps));
      return { id: page.items.at(-1)?.id, at: page.items.at(-1)?.updated_at };
    };
    const made = await caps.setup.createProduct(owner, {
      name: "Kettle",
      price: { value: 2500, currency: "EUR" },
      active: true,
    });
    await caps.setup.createProduct(owner, { name: "Teapot", price: { value: 1500, currency: "EUR" }, active: true });
    const updated = await when(() => caps.setup.updateProduct(owner, { product_id: made.id, name: "Kettle, 1 l" }));
    expect(updated).toEqual({ id: made.id, at: new Date(clock).toISOString() });
    const kept = await when(() => caps.setup.updateProduct(owner, { product_id: made.id, listed: false }));
    expect(kept.id).toBe(made.id);
    const archived = await when(() => caps.setup.archiveProduct(owner, { product_id: made.id }));
    expect(archived).toEqual({ id: made.id, at: new Date(clock).toISOString() });
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    const fed = await when(() =>
      caps.feeds.importBody(feed.id, "id,title,sku,price\nF1,Mug,,8.00\nF2,Cup,4006381333931,5.00", clock),
    );
    expect(fed.at).toBe(new Date(clock).toISOString());
    const byName = async (name: string) => (await caps.setup.listProducts(owner)).find((p) => p.name === name)?.id;
    const cupId = await byName("Cup");
    const mugId = await byName("Mug");
    // The one-tap offer of barcodes, a barcode the owner's AI proposed and the owner took, a product
    // that left the feed, and a feed disconnected.
    expect((await when(() => caps.useSkusAsBarcodes(owner, { use: true }))).id).toBe(cupId);
    const ai: Caller = {
      actor: { kind: "owner_ai", id: "client_1", channel: "rest" },
      actsAs: "owner",
      principal: { via: "oauth", id: "client_1", name: "Assistant", scopes: ["*"], userId: "user_1" },
      tier: "verified_principal",
      sandbox: false,
      now: () => clock,
    };
    await caps.setup.updateProduct(ai, { product_id: made.id, gtin: "036000291452" });
    expect((await when(() => caps.setup.confirmBarcode(owner, { product_id: made.id }))).id).toBe(made.id);
    expect(
      (await when(() => caps.feeds.importBody(feed.id, "id,title,sku,price\nF2,Cup,4006381333931,5.00", clock))).id,
    ).toBe(mugId);
    expect((await when(() => caps.feeds.remove(owner, feed.id))).id).toBe(cupId);
  });
});

describe("the signature", () => {
  it("verifies under a key the manifest publishes, over the exact body, and names the domain and URL", async () => {
    const { db, caps } = await setup();
    await seed(db, 2, T0);
    const r = await read(caps);
    if (r.status !== 200) throw new Error("expected a page");
    const keys = (await caps.receipts.jwks()).keys;
    const claims = await verifyCatalogueSignature(r.signature, keys, r.body);
    expect(claims).toMatchObject({ iss: DOMAIN, url: `${URL0}?limit=500`, rev: pageOf(r).catalogue.rev });
    // One byte changed in the body, and it no longer holds.
    await expect(
      verifyCatalogueSignature(r.signature, keys, r.body.replace("Product", "Produkt")),
    ).rejects.toMatchObject({
      code: "bad_payload",
    });
    const [h, p, s] = r.signature.split(".");
    const flipped = `${h}.${p}.${(s as string).startsWith("A") ? "B" : "A"}${(s as string).slice(1)}`;
    await expect(verifyCatalogueSignature(flipped, keys, r.body)).rejects.toMatchObject({ code: "bad_signature" });
  });
});
