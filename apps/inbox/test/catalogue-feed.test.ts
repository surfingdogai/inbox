import {
  CATALOGUE_SIGNATURE_HEADER,
  type Caller,
  cataloguePageV2Schema,
  cataloguePoliciesSchema,
  MANIFEST_PATH,
  manifestSchema,
  type PublicJwk,
  readCatalogueItemV2,
  readCataloguePolicies,
  schema,
  ulid,
  verifyCatalogueSignature,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * The signed catalogue at the inbox's public door (ADR-029, protocol §4.18): what a network reads at
 * `GET /v1/catalogue/changes` and `/v1/catalogue/items`, checked as a network checks it, against the
 * receipt keys the manifest publishes; and the manifest naming the feed only while the owner lists the
 * products. Node and workerd.
 */
const ORIGIN = "https://inbox.loja.example";
const NOW = Date.UTC(2026, 9, 26, 9, 0, 0);
const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => NOW,
};

async function setup(opts: { secret?: boolean } = {}) {
  const db = await freshDb();
  const inbox = createInbox({
    db,
    now: () => NOW,
    ...(opts.secret === false ? {} : { secretKey: "catalogue-feed-door-secret-0123456789abcdef" }),
  });
  const id = ulid(NOW);
  await db.orm.insert(schema.products).values({
    id,
    name: "Moka pot, 6 cups",
    price: { value: 18990, currency: "BRL" },
    source: "feed:https://loja.example/feed.xml?token=feed-secret-0123",
    externalId: "ext-1",
    gtin: "09506000134352",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const manifest = async () =>
    manifestSchema.parse(await (await inbox.app.request(`${ORIGIN}${MANIFEST_PATH}`)).json());
  return { db, caps: inbox.caps, app: inbox.app, id, manifest };
}

describe("GET /v1/catalogue/changes", () => {
  it("answers a signed page a network checks against the manifest's keys, never where products came from", async () => {
    const s = await setup();
    const url = `${ORIGIN}/v1/catalogue/changes?limit=10`;
    const res = await s.app.request(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body = await res.text();
    expect(body).not.toMatch(/feed-secret|ext-1|feed:/);
    const page = JSON.parse(body) as { domain: string; items: { id: string; gtin: string | null }[] };
    expect(page.domain).toBe("inbox.loja.example");
    expect(page.items).toEqual([expect.objectContaining({ id: s.id, state: "listed", gtin: "09506000134352" })]);
    const keys = (await s.manifest()).receipt_keys.keys as unknown as PublicJwk[];
    const sig = res.headers.get(CATALOGUE_SIGNATURE_HEADER) as string;
    expect(await verifyCatalogueSignature(sig, keys, body)).toMatchObject({ iss: "inbox.loja.example", url });
    // The same page again, with its ETag: nothing to send.
    const again = await s.app.request(url, { headers: { "If-None-Match": res.headers.get("etag") as string } });
    expect(again.status).toBe(304);
  });

  it("gives products by id, and says which ids it has none for", async () => {
    const s = await setup();
    const res = await s.app.request(`${ORIGIN}/v1/catalogue/items?ids=${s.id},nope`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get(CATALOGUE_SIGNATURE_HEADER)).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(await res.json()).toMatchObject({ items: [{ id: s.id, state: "listed" }], missing: ["nope"] });
  });

  it("answers 404 not_listed while the owner keeps the products off networks, and the manifest stops naming it", async () => {
    const s = await setup();
    expect((await s.manifest()).catalogue).toEqual({
      feed: `${ORIGIN}/v1/catalogue/changes`,
      items: `${ORIGIN}/v1/catalogue/items`,
      versions: [1, 2],
      policies: `${ORIGIN}/v1/catalogue/policies`,
    });
    await s.caps.updateSettings(owner, { doc: { catalogue: { listed: false } } });
    const res = await s.app.request(`${ORIGIN}/v1/catalogue/changes`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_listed" });
    expect((await s.manifest()).catalogue).toBeUndefined();
    // The business's own doors list its products as before.
    const doors = (await (await s.app.request(`${ORIGIN}/v1/products`)).json()) as { items: unknown[] };
    expect(doors.items).toHaveLength(1);
  });

  it("is left out of the manifest of an inbox answering over plain http, which serves the rest of it", async () => {
    const s = await setup();
    const res = await s.app.request(`http://localhost:8787${MANIFEST_PATH}`);
    expect(res.status).toBe(200);
    const m = manifestSchema.parse(await res.json());
    expect(m.instance).toBe("http://localhost:8787");
    expect(m.catalogue).toBeUndefined();
    expect(m.protocols.mcp).toBe("http://localhost:8787/mcp");
  });

  it("is not served, nor named, by an inbox that cannot sign it", async () => {
    const s = await setup({ secret: false });
    expect((await s.app.request(`${ORIGIN}/v1/catalogue/changes`)).status).toBe(404);
    expect((await s.manifest()).catalogue).toBeUndefined();
  });

  it("refuses a cursor it did not give, and a limit past 500, each with the spec's code", async () => {
    const s = await setup();
    const after = await s.app.request(`${ORIGIN}/v1/catalogue/changes?after=zzz`);
    expect(after.status).toBe(422);
    expect(await after.json()).toMatchObject({ code: "cursor_invalid" });
    const limit = await s.app.request(`${ORIGIN}/v1/catalogue/changes?limit=501`);
    expect(limit.status).toBe(422);
    expect(await limit.json()).toMatchObject({ code: "limit_invalid" });
  });
});

describe("catalogue version 2 at the door", () => {
  it("serves version 2 when asked, signed, its items read whole against its signed policies document", async () => {
    const s = await setup();
    const url = `${ORIGIN}/v1/catalogue/changes?version=2&limit=500`;
    const res = await s.app.request(url);
    expect(res.status).toBe(200);
    const body = await res.text();
    const page = cataloguePageV2Schema.parse(JSON.parse(body));
    const keys = (await s.manifest()).receipt_keys.keys as unknown as PublicJwk[];
    expect(
      await verifyCatalogueSignature(res.headers.get(CATALOGUE_SIGNATURE_HEADER) as string, keys, body),
    ).toMatchObject({
      url,
      rev: page.catalogue.rev,
    });
    const pol = await s.app.request(`${ORIGIN}/v1/catalogue/policies`);
    expect(pol.status).toBe(200);
    expect(pol.headers.get("cache-control")).toBe("public, max-age=300");
    const polBody = await pol.text();
    const doc = cataloguePoliciesSchema.parse(JSON.parse(polBody));
    expect(doc.rev).toBe(page.catalogue.policies_rev);
    expect(
      await verifyCatalogueSignature(pol.headers.get(CATALOGUE_SIGNATURE_HEADER) as string, keys, polBody),
    ).toMatchObject({ as_of: doc.as_of, rev: doc.rev });
    const again = await s.app.request(`${ORIGIN}/v1/catalogue/policies`, {
      headers: { "If-None-Match": pol.headers.get("etag") as string },
    });
    expect(again.status).toBe(304);
    const read = readCataloguePolicies(doc);
    for (const item of page.items) {
      expect(readCatalogueItemV2(item, { as_of: page.as_of, policies: read })).toMatchObject({
        state: "listed",
        dropped: [],
      });
    }
  });

  it("answers a version it does not serve, and a cursor of the other version, with the spec's codes", async () => {
    const s = await setup();
    const v3 = await s.app.request(`${ORIGIN}/v1/catalogue/changes?version=3`);
    expect(v3.status).toBe(422);
    expect(await v3.json()).toMatchObject({ code: "version_unsupported" });
    const items = await s.app.request(`${ORIGIN}/v1/catalogue/items?version=2&ids=${s.id},nope`);
    expect(await items.json()).toMatchObject({ version: 2, items: [{ id: s.id, state: "listed" }], missing: ["nope"] });
  });

  it("quotes shipping by the business's own rates, a read anyone may make", async () => {
    const s = await setup();
    const res = await s.app.request(`${ORIGIN}/v1/shipping/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines: [{ product_id: s.id, quantity: 1 }], destination: { country: "BR" } }),
    });
    expect(res.status).toBe(200);
    // No shipping profile yet: the business has not set rates.
    expect(await res.json()).toMatchObject({ quotes: [{ why: "no_profile", product_ids: [s.id] }], unquoted: [] });
  });
});

describe("GET /v1/products by id and by barcode", () => {
  it("reads the live price of what a network showed, by its ids or its barcode", async () => {
    const s = await setup();
    type Page = { items: { id: string }[] };
    const byIds = (await (await s.app.request(`${ORIGIN}/v1/products?ids=${s.id},other`)).json()) as Page;
    expect(byIds.items.map((p) => p.id)).toEqual([s.id]);
    const byGtin = (await (await s.app.request(`${ORIGIN}/v1/products?gtin=9506000134352`)).json()) as Page;
    expect(byGtin.items.map((p) => p.id)).toEqual([s.id]);
    expect((await s.app.request(`${ORIGIN}/v1/products?gtin=9506000134353`)).status).toBe(422);
  });
});
