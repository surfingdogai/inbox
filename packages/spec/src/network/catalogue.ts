import { z } from "zod";

/**
 * The catalogue (protocol §4.18, spec 0.9, optional for a network; ADR-029): what an inbox whose
 * owner lists its products on networks serves, signed, and the three small calls that tell a
 * network about it. The network pulls; the inbox never writes its catalogue to a network.
 *
 * - `GET /v1/catalogue/changes?after=<cursor>&limit=<1..500>` on the inbox: its products in
 *   `(updated_at, id)` order, each one listed or withdrawn (`cataloguePageSchema`).
 * - `GET /v1/catalogue/items?ids=a,b` on the inbox: up to 50 products by id, as the feed has them.
 * - Both carry `Catalogue-Signature`: a compact JWS (`CATALOGUE_SIGNATURE_TYP`, EdDSA) by a key the
 *   inbox's manifest publishes under `receipt_keys`, over `catalogueSignatureSchema`.
 * - The hourly signed ping carries `catalogue` (`pingCatalogueSchema`), and its answer may carry the
 *   network's own `catalogue` block (`pingCatalogueAnswerSchema`).
 * - `POST /v1/instances/{domain}/catalogue` on the network, signed sdi-instance/1: the owner's switch,
 *   at once (`catalogueSwitchRequestSchema`).
 */

/** The JWS `typ` of a catalogue page's signature, so it is never mistaken for a receipt or a token. */
export const CATALOGUE_SIGNATURE_TYP = "sdi-catalogue+jws";
/** The response header that carries it. */
export const CATALOGUE_SIGNATURE_HEADER = "Catalogue-Signature";
/** A feed page holds at most this many products, and `/v1/catalogue/items` answers at most 50 ids. */
export const CATALOGUE_PAGE_MAX = 500;
export const CATALOGUE_ITEMS_MAX = 50;
/** A product's name as a network indexes it, and its description as the feed carries it, at most. */
export const CATALOGUE_NAME_MAX = 150;
export const CATALOGUE_DESCRIPTION_MAX = 1000;

const isoTime = z.iso.datetime({ offset: true });

/** In stock (counted, above 0), out of stock (counted, 0), or on sale with no count kept. Never a count. */
export const catalogueAvailabilitySchema = z.enum(["in_stock", "out_of_stock", "on_sale"]);
export const catalogueConditionSchema = z.enum(["new", "used", "refurbished"]);

/** One product as a network may list it: what the business's own doors show, never what they keep. */
export const catalogueListedItemSchema = z.object({
  id: z.string().min(1).max(64).describe("The inbox's own id for the product: what an order names."),
  state: z.literal("listed"),
  sku: z.string().max(64).nullable(),
  name: z.string().min(1).max(CATALOGUE_NAME_MAX),
  description: z.string().max(CATALOGUE_DESCRIPTION_MAX).nullable(),
  price: z.object({
    value: z.int().min(1).describe("Minor units: 4500 is €45.00. Never 0: a product with no price is not listed."),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
  availability: catalogueAvailabilitySchema,
  gtin: z
    .string()
    .regex(/^\d{14}$/)
    .nullable()
    .describe(
      "Its barcode as 14 digits, check digit verified and never a shop's own code or a coupon (vectors/gtin.json), or null.",
    ),
  no_gtin: z.boolean().describe("The owner says it has no barcode (bread, a print, a repair)."),
  brand: z.string().max(70).nullable(),
  mpn: z.string().max(70).nullable().describe("The maker's part number, as the business gave it."),
  condition: catalogueConditionSchema,
  url: z
    .url({ protocol: /^https$/ })
    .nullable()
    .describe("Its page, only when it is on the business's own site."),
  image_url: z
    .url({ protocol: /^https$/ })
    .nullable()
    .describe("A link to its picture; the picture is never copied."),
  updated_at: isoTime,
  hash: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .describe("The first 16 hex digits of SHA-256 over the item's canonical JSON, without updated_at and hash."),
});
export type CatalogueListedItem = z.infer<typeof catalogueListedItemSchema>;

/** A product no longer listed: archived, kept off networks, or no longer listable. The inbox never deletes one. */
export const catalogueWithdrawnItemSchema = z.object({
  id: z.string().min(1).max(64),
  state: z.literal("withdrawn"),
  updated_at: isoTime,
});

export const catalogueItemSchema = z.discriminatedUnion("state", [
  catalogueListedItemSchema,
  catalogueWithdrawnItemSchema,
]);
export type CatalogueItem = z.infer<typeof catalogueItemSchema>;

/** What a page says of the whole catalogue, so a reader knows when it has all of it. */
export const catalogueSummarySchema = z.object({
  count: z.int().min(0).describe("Products listed now."),
  updated_at: isoTime.nullable().describe("The latest change to any product, listed or not; null with none."),
  tax_included: z.boolean().nullable().describe("Whether the prices include tax; null when the business has not said."),
  rev: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .describe("Changes whenever count, updated_at or anything else the items are read with changes."),
});
export type CatalogueSummary = z.infer<typeof catalogueSummarySchema>;

/** `GET /v1/catalogue/changes`: `200`. `404 not_listed` while the owner keeps the products off networks. */
export const cataloguePageSchema = z.object({
  version: z.literal(1),
  domain: z.string().min(1).max(253),
  as_of: isoTime,
  catalogue: catalogueSummarySchema,
  items: z.array(catalogueItemSchema).max(CATALOGUE_PAGE_MAX),
  next_cursor: z.string().max(200).nullable().describe("Pass it as after for the next page; null at the end."),
});
export type CataloguePage = z.infer<typeof cataloguePageSchema>;

/** `GET /v1/catalogue/items?ids=…`: `200`. `missing` names ids the inbox has no product for. */
export const catalogueItemsSchema = z.object({
  items: z.array(catalogueItemSchema).max(CATALOGUE_ITEMS_MAX),
  missing: z.array(z.string().max(64)).max(CATALOGUE_ITEMS_MAX),
});

/**
 * The payload of `Catalogue-Signature`. A reader checks the JWS under a key the business's manifest
 * publishes, then that `iss` is the business's domain, `url` the address it asked, and `body_sha256`
 * the SHA-256 of the body it got, in lowercase hex.
 */
export const catalogueSignatureSchema = z.object({
  iss: z.string().min(1).max(253).describe("The inbox's domain, as it registered with networks."),
  url: z.url().describe("The address the page was asked at, query string included."),
  body_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  as_of: isoTime,
  rev: z.string().regex(/^[0-9a-f]{16}$/),
});
export type CatalogueSignature = z.infer<typeof catalogueSignatureSchema>;

/**
 * The hourly signed ping's `catalogue` (an unsigned ping never carries it): listed, with what a reader
 * compares to know whether to read the feed again; or `{"listed": false}`, once, to a network last told
 * the products were listed.
 */
export const pingCatalogueSchema = z.union([
  z.object({
    listed: z.literal(true),
    count: z.int().min(0),
    updated_at: isoTime.nullable(),
    rev: z.string().regex(/^[0-9a-f]{16}$/),
  }),
  z.object({ listed: z.literal(false) }),
]);
export type PingCatalogue = z.infer<typeof pingCatalogueSchema>;

/** `POST /v1/instances/{domain}/catalogue`, signed sdi-instance/1 by that domain: the owner's switch. */
export const catalogueSwitchRequestSchema = z.object({ listed: z.boolean() });
/** `200`: what the network now holds of the business's products. */
export const catalogueSwitchResponseSchema = z.object({
  listed: z.boolean(),
  offers_live: z.int().min(0),
});

/** Why a network holds a product back, in its own words for the owner, with a few of them by name. */
export const catalogueHeldSchema = z.object({
  why: z.string().min(1).max(200),
  count: z.int().min(1),
  sample: z.array(z.object({ id: z.string().max(64), name: z.string().max(CATALOGUE_NAME_MAX) })).max(5),
});

/** A signed ping's answer, `catalogue`: what the network lists of the business's products, and when it last checked. */
export const pingCatalogueAnswerSchema = z.object({
  listed: z.boolean(),
  offers_live: z.int().min(0),
  held: z.array(catalogueHeldSchema).max(20),
  checked_at: isoTime.nullable(),
});
export type PingCatalogueAnswer = z.infer<typeof pingCatalogueAnswerSchema>;
