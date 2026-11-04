import { describe, expect, it } from "vitest";
import {
  CATALOGUE_CHECK_MAX,
  CATALOGUE_MULTIPACK_MAX,
  CATALOGUE_SIGNATURE_TYP,
  catalogueCheckRequestSchema,
  catalogueCheckResponseSchema,
  catalogueItemsSchema,
  cataloguePageSchema,
  catalogueSwitchRequestSchema,
  catalogueSwitchResponseSchema,
  isPlaceholderTitle,
  JSON_SCHEMAS,
  jsonSchemaOf,
  manifestSchema,
  pingCatalogueAnswerSchema,
  pingRequestSchema,
  signedPingResponseSchema,
} from "../src/index";

/** The catalogue's messages (protocol §4.18, spec 0.9): what an inbox serves and a network reads. */

const listed = {
  id: "01JC0000000000000000000001",
  state: "listed",
  sku: "MOKA-6",
  name: "Moka pot, 6 cups",
  description: null,
  price: { value: 18990, currency: "BRL" },
  availability: "in_stock",
  gtin: "09506000134352",
  no_gtin: false,
  brand: "Bialetti",
  mpn: null,
  condition: "new",
  url: "https://loja.example/produtos/moka-6",
  image_url: null,
  updated_at: "2026-10-25T09:12:00.000Z",
  hash: "3b0c51d0a7e4b8c3",
};

const page = {
  version: 1,
  domain: "inbox.loja.example",
  as_of: "2026-10-25T09:14:03.000Z",
  catalogue: { count: 1, updated_at: "2026-10-25T09:12:00.000Z", tax_included: true, rev: "0123456789abcdef" },
  items: [listed, { id: "01JC0000000000000000000002", state: "withdrawn", updated_at: "2026-10-25T09:11:00.000Z" }],
  next_cursor: null,
};

describe("a catalogue page", () => {
  it("reads as an inbox serves it, listed and withdrawn products side by side", () => {
    expect(cataloguePageSchema.parse(page)).toEqual(page);
    expect(catalogueItemsSchema.parse({ items: [listed], missing: ["x"] }).missing).toEqual(["x"]);
  });

  it("never lists a product at nothing, a barcode that is not 14 digits, or a page off https", () => {
    for (const bad of [
      { ...listed, price: { value: 0, currency: "EUR" } },
      { ...listed, gtin: "4006381333931" },
      { ...listed, url: "http://loja.example/p" },
      { ...listed, availability: "3 left" },
    ]) {
      expect(cataloguePageSchema.safeParse({ ...page, items: [bad] }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("may say an offer is a pack of identical units (0.12.1); absent or 1 is one, and anything else is refused", () => {
    // Absent: one, as every feed before 0.12.1 says it.
    expect(cataloguePageSchema.parse(page).items[0]).not.toHaveProperty("multipack");
    // A pack of twelve under the single unit's barcode, and a case's own barcode as one case.
    for (const item of [
      { ...listed, multipack: 12 },
      { ...listed, gtin: "19506000134359", multipack: 1 },
      { ...listed, gtin: null, multipack: 6 },
      { ...listed, multipack: 10000 },
    ]) {
      expect(cataloguePageSchema.parse({ ...page, items: [item] }).items[0], JSON.stringify(item)).toEqual(item);
      expect(catalogueItemsSchema.parse({ items: [item], missing: [] }).items[0]).toEqual(item);
    }
    for (const multipack of [0, -1, 2.5, 10001, "12", null]) {
      expect(
        cataloguePageSchema.safeParse({ ...page, items: [{ ...listed, multipack }] }).success,
        String(multipack),
      ).toBe(false);
      expect(catalogueItemsSchema.safeParse({ items: [{ ...listed, multipack }], missing: [] }).success).toBe(false);
    }
    expect(CATALOGUE_MULTIPACK_MAX).toBe(10000);
    // Both JSON Schemas carry it, optional: a reader on 0.12.0 sees one member more and ignores it.
    for (const name of ["catalogue-page", "catalogue-items"]) {
      const item = (jsonSchemaOf(name) as { properties: { items: { items: { oneOf: Record<string, unknown>[] } } } })
        .properties.items.items.oneOf[0] as { properties: Record<string, unknown>; required: string[] };
      expect(item.properties.multipack, name).toMatchObject({ type: "integer", minimum: 1, maximum: 10000 });
      expect(item.required, name).not.toContain("multipack");
    }
  });

  it("ignores a member it does not know, as before", () => {
    const parsed = cataloguePageSchema.parse({ ...page, items: [{ ...listed, pack_of: 12 }] });
    expect(parsed.items[0]).toEqual(listed);
  });

  it("knows a template's sample names, however they are typed", () => {
    for (const name of ["I'm a product", "  I\u2019m A Product ", "Sample product", "PRODUCT NAME"]) {
      expect(isPlaceholderTitle(name), name).toBe(true);
    }
    expect(isPlaceholderTitle("Moka pot, 6 cups")).toBe(false);
  });

  it("is signed with its own typ, and has a JSON Schema for each message", () => {
    expect(CATALOGUE_SIGNATURE_TYP).toBe("sdi-catalogue+jws");
    for (const name of [
      "catalogue-page",
      "catalogue-items",
      "catalogue-switch-request",
      "catalogue-switch-response",
      "catalogue-check-request",
      "catalogue-check-response",
    ]) {
      expect(JSON_SCHEMAS[name], name).toBeDefined();
    }
  });
});

describe("the calls around it", () => {
  it("the ping carries catalogue, listed with its rev or not listed", () => {
    const base = { version: "1.0.0", runtime: "node" };
    const on = { listed: true, count: 212, updated_at: "2026-10-25T09:12:00.000Z", rev: "3b0c51d0a7e4b8c3" };
    expect(pingRequestSchema.parse({ ...base, catalogue: on }).catalogue).toEqual(on);
    expect(pingRequestSchema.parse({ ...base, catalogue: { listed: false } }).catalogue).toEqual({ listed: false });
    expect(pingRequestSchema.safeParse({ ...base, catalogue: { listed: true } }).success).toBe(false);
  });

  it("the signed ping's answer may carry what the network lists and holds", () => {
    const block = {
      listed: true,
      offers_live: 209,
      held: [
        { why: "Its name looks like a template's sample.", count: 3, sample: [{ id: "p1", name: "Product name" }] },
      ],
      checked_at: "2026-10-25T10:42:00.000Z",
    };
    expect(pingCatalogueAnswerSchema.parse(block)).toEqual(block);
    expect(signedPingResponseSchema.shape.catalogue).toBeDefined();
  });

  it("the switch, and the manifest's catalogue member", () => {
    expect(catalogueSwitchRequestSchema.parse({ listed: false })).toEqual({ listed: false });
    expect(catalogueSwitchResponseSchema.parse({ listed: true, offers_live: 0 }).offers_live).toBe(0);
    // The network's answer names the domain too (spec 0.15.1).
    const answer = { domain: "inbox.loja.example", listed: true, offers_live: 212 };
    expect(catalogueSwitchResponseSchema.parse(answer)).toEqual(answer);
    const manifest = manifestSchema.parse({
      spec: "surfingdog-inbox/0",
      instance: "https://inbox.loja.example",
      item_types: ["order"],
      protocols: { rest: "https://inbox.loja.example/v1" },
      agent_policy: { tiers: ["anonymous"] },
      receipt_keys: { keys: [] },
      review_services: [],
      catalogue: {
        feed: "https://inbox.loja.example/v1/catalogue/changes",
        items: "https://inbox.loja.example/v1/catalogue/items",
      },
    });
    expect(manifest.catalogue?.feed).toBe("https://inbox.loja.example/v1/catalogue/changes");
  });
});

describe("the check (0.15.1)", () => {
  it("asks with after and limit, each optional, or nothing", () => {
    expect(catalogueCheckRequestSchema.parse({})).toEqual({});
    expect(catalogueCheckRequestSchema.parse({ after: "MOKA-6", limit: 2 })).toEqual({ after: "MOKA-6", limit: 2 });
    expect(CATALOGUE_CHECK_MAX).toBe(500);
    for (const limit of [0, 501, 2.5])
      expect(catalogueCheckRequestSchema.safeParse({ limit }).success, `${limit}`).toBe(false);
  });

  it("reads an answer as the network gives it: held items by code, listed ones with what it changed", () => {
    const answer = {
      domain: "inbox.loja.example",
      listed: true,
      state: "live",
      version: 2,
      offers_live: 5,
      offers_later: 4,
      offers_held: 5,
      policies: {
        rev: "9f2c4e1a7b3d5068",
        problems: [{ path: "shipping_profiles[1]", code: "policies_unreadable" }],
      },
      items: [
        {
          id: "BEANS",
          dropped: ["list_price_never_seen", "hash_mismatch"],
          later: "search_later",
        },
        {
          id: "FREE",
          held: "unreadable",
          why: "It does not read as catalogue version 2: the member at the path given is missing or not as the spec has it.",
          path: "/price/value",
        },
        {
          id: "VAPE",
          held: "age_kind_off",
          why: "Tobacco and nicotine, cannabis and weapons are kept off the network, ID check or not.",
          also: ["shipping_profile_unknown"],
        },
      ],
      next_after: "VAPE",
      checked_at: "2026-11-04T09:14:03.218734Z",
      description: "Each product this network holds back, or lists with a member dropped, in order of id.",
    };
    expect(catalogueCheckResponseSchema.parse(answer)).toEqual(answer);
    // A member it does not know is no reason to refuse the answer.
    expect(catalogueCheckResponseSchema.safeParse({ ...answer, a_member_of_later: 1 }).success).toBe(true);
    // A network's own code reads as any code; one past the cap that did not read keeps its path.
    const own = {
      ...answer,
      items: [
        { id: "MUG-2", held: "over_cap", why: "It is past the 50000 products one business lists here." },
        { id: "MUG-3", held: "over_cap", why: "It is past the 50000 products one business lists here.", path: "/name" },
      ],
    };
    expect(catalogueCheckResponseSchema.safeParse(own).success).toBe(true);
    // The policies document's failed read, as its code.
    const failed = { ...answer, policies: { problem: "policies_document_unreadable", problems: [] } };
    expect(catalogueCheckResponseSchema.safeParse(failed).success).toBe(true);
  });

  it("reads the answer for a business whose catalogue the network has no record of", () => {
    const off = {
      domain: "inbox.loja.example",
      listed: false,
      state: "off",
      version: 0,
      offers_live: 0,
      offers_later: 0,
      offers_held: 0,
      policies: null,
      items: [],
      next_after: null,
      checked_at: null,
      description: "Each product this network holds back, in order of id.",
    };
    expect(catalogueCheckResponseSchema.parse(off)).toEqual(off);
    expect(catalogueCheckResponseSchema.safeParse({ ...off, state: "gone" }).success).toBe(false);
  });
});
