import { describe, expect, it } from "vitest";
import {
  CATALOGUE_SIGNATURE_TYP,
  catalogueItemsSchema,
  cataloguePageSchema,
  catalogueSwitchRequestSchema,
  catalogueSwitchResponseSchema,
  isPlaceholderTitle,
  JSON_SCHEMAS,
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

  it("knows a template's sample names, however they are typed", () => {
    for (const name of ["I'm a product", "  I\u2019m A Product ", "Sample product", "PRODUCT NAME"]) {
      expect(isPlaceholderTitle(name), name).toBe(true);
    }
    expect(isPlaceholderTitle("Moka pot, 6 cups")).toBe(false);
  });

  it("is signed with its own typ, and has a JSON Schema for each message", () => {
    expect(CATALOGUE_SIGNATURE_TYP).toBe("sdi-catalogue+jws");
    for (const name of ["catalogue-page", "catalogue-items", "catalogue-switch-request", "catalogue-switch-response"]) {
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
