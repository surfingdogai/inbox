import { z } from "zod";
import ageKindsVocab from "../../vocab/age-kinds.json" with { type: "json" };
import optionKeysVocab from "../../vocab/option-keys.json" with { type: "json" };
import {
  CATALOGUE_ITEMS_MAX,
  CATALOGUE_MULTIPACK_MAX,
  CATALOGUE_NAME_MAX,
  CATALOGUE_PAGE_MAX,
  catalogueConditionSchema,
  catalogueSummarySchema,
} from "./catalogue";

/**
 * Catalogue version 2 (protocol §4.18, as amended; spec Unreleased, ADR-next): what an inbox, or any
 * business's own system, serves at `GET /v1/catalogue/changes?version=2` and
 * `GET /v1/catalogue/items?version=2`, and the signed policies document its items name.
 *
 * Version 2 adds, to each listed offer: a product group with the variant's options (`group`, `options`), a
 * price model (`price_model`, `price_max`), a "was" price (`list_price`), a unit price (`unit_price`), tax
 * per offer (`tax_included`), four more ways to be available (`limited`, `preorder`, `backorder`,
 * `made_to_order`) with `available_from` and `available_until`, `is_bundle`, pictures and videos
 * (`media`), an age checked at handover (`age_restricted`), how it reaches the buyer (`fulfil_methods`)
 * with its `shipping_profile`, `weight` and `return_policy`; and ids of up to 256 characters.
 *
 * The schemas here are the shape a producer serves. A reader checks each item alone
 * (`readCatalogueItemV2`, `catalogue-v2-read.ts`): an item that does not read, or that a check refuses, is
 * held, and every other item on the page is kept.
 */

/** The catalogue versions this spec defines. A manifest without `catalogue.versions` serves version 1 only. */
export const CATALOGUE_VERSIONS = [1, 2] as const;
export type CatalogueVersion = (typeof CATALOGUE_VERSIONS)[number];
/** A version 2 id, of an offer, a group, a shipping profile or a return policy, at most (version 1: 64). */
export const CATALOGUE_ID_MAX_V2 = 256;
/** A version 2 description at most, in characters; version 1 cuts it to 1,000. */
export const CATALOGUE_DESCRIPTION_MAX_V2 = 5000;
/** The most offers one product group lists; a reader holds those past it (by `position`, then id). */
export const CATALOGUE_GROUP_MAX = 250;
/** The most options one variant names. */
export const CATALOGUE_OPTIONS_MAX = 5;
/** The most pictures and videos one offer links to. */
export const CATALOGUE_MEDIA_MAX = 10;
/** The longest address an item names (its page, a picture). */
export const CATALOGUE_URL_MAX = 2048;
/** How long an inbox that serves version 2 goes on serving version 1 pages, from the day it first serves version 2. */
export const CATALOGUE_V1_MONTHS_AFTER_V2 = 12;
/** A "was" price is shown only when the offer was at or above it for this many days before the reduction began. */
export const WAS_PRICE_DAYS = 30;
/** The youngest and oldest `min_age` an offer may give, and the oldest an age `by_country` may be. */
export const AGE_MIN = 12;
export const AGE_MAX = 21;
export const AGE_BY_COUNTRY_MAX = 25;

/**
 * An id in version 2: 1 to 256 printable ASCII characters (U+0021 to U+007E), never a comma, so a list of
 * them can be asked as `ids=a,b` with each id percent-encoded as a query component.
 */
export const catalogueIdV2Schema = z
  .string()
  .regex(/^[\x21-\x2B\x2D-\x7E]{1,256}$/, "1 to 256 printable ASCII characters, no comma or space");

/** A cursor: opaque, at most 200 characters that a query string carries as they are. */
export const catalogueCursorV2Schema = z
  .string()
  .regex(/^[A-Za-z0-9._~-]{1,200}$/, "at most 200 of A-Z a-z 0-9 . _ ~ -")
  .describe("Pass it as after, exactly, for the next page; null at the end.");

const isoTime = z.iso.datetime({ offset: true });
const hex16 = z.string().regex(/^[0-9a-f]{16}$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const httpsUrl = z.url({ protocol: /^https$/ }).max(CATALOGUE_URL_MAX);

/** A price: `value` an integer count of its currency's ISO 4217 minor unit, never 0 (`minorUnits`). */
export const catalogueMoneySchema = z.object({
  value: z
    .int()
    .min(1)
    .max(1_000_000_000_000_000)
    .describe("Minor units of the currency's ISO 4217 exponent: 4500 is EUR 45.00, JPY 4,500, KWD 4.500. Never 0."),
  currency,
});
export type CatalogueMoney = z.infer<typeof catalogueMoneySchema>;

/** A number a catalogue may hold that is not a count: above 0, at most three decimals (checked by the reader). */
const measureNumber = z.number().positive().max(1_000_000);

/** One of a variant's options, as `{key, name, value}`: what it is, the business's label, and its value. */
export const catalogueOptionSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .describe(
      "A key of vocab/option-keys.json (color, size, flavour…), or any other lower-case name of the business's own.",
    ),
  name: z.string().min(1).max(40).describe("The business's own label for it, in its own language: Colour, Cor, Größe."),
  value: z
    .string()
    .min(1)
    .max(100)
    .describe("This variant's value, as the business writes it: Navy, 500 g, Medium roast."),
});
export type CatalogueOption = z.infer<typeof catalogueOptionSchema>;

/** The product group a variant belongs to: its id, the product's title, and where this variant comes in it. */
export const catalogueGroupSchema = z.object({
  id: catalogueIdV2Schema.describe(
    "The group's id, the same on every variant of it: the network's key group:<business>:<id>.",
  ),
  title: z
    .string()
    .min(1)
    .max(CATALOGUE_NAME_MAX)
    .describe("The product's title, without any variant's options: Moka pot."),
  position: z
    .int()
    .min(1)
    .max(CATALOGUE_GROUP_MAX)
    .describe("Where this variant comes among the group's, from 1; ties come in order of id."),
});
export type CatalogueGroup = z.infer<typeof catalogueGroupSchema>;

/** How a price is meant: the price itself, the lowest, a range, or on request (no price at all). */
export const cataloguePriceModelSchema = z.enum(["fixed", "from", "range", "quote"]);
export type CataloguePriceModel = z.infer<typeof cataloguePriceModelSchema>;

/**
 * A unit price: the offer's whole net quantity as sold (`measure`, every unit of a multipack together)
 * and the quantity the price is given per (`reference`). The amount is never published: a reader works
 * it out from the price (`unitPriceOf`).
 */
export const catalogueUnitPriceSchema = z.object({
  measure: z.object({
    value: measureNumber.describe("The net quantity, above 0, at most three decimals: 500, 0.75, 15.25."),
    unit: z
      .string()
      .regex(/^[a-z][a-z0-9]{0,9}$/)
      .describe("One of UNIT_PRICE_UNITS: g, kg, ml, l, oz, ct…"),
  }),
  reference: z.object({
    value: z.int().min(1).max(1000).describe("The quantity the price is given per: 1, 10, 100…"),
    unit: z.string().regex(/^[a-z][a-z0-9]{0,9}$/),
  }),
});
export type CatalogueUnitPrice = z.infer<typeof catalogueUnitPriceSchema>;

/**
 * Whether it can be had, never a count:
 * - `in_stock`: counted, more than none (and above the owner's own few-left mark, when the owner set one);
 * - `limited`: counted, more than none, at or below the few-left mark the owner chose to publish;
 * - `out_of_stock`: counted, none; it cannot be ordered now;
 * - `on_sale`: it can be ordered now and the business keeps no count of it;
 * - `preorder`: not out yet; it can be ordered now and comes from `available_from`, which it must give;
 * - `backorder`: none now; it can be ordered and comes later, from `available_from` when it gives one;
 * - `made_to_order`: made after it is ordered.
 */
export const catalogueAvailabilityV2Schema = z.enum([
  "in_stock",
  "limited",
  "out_of_stock",
  "on_sale",
  "preorder",
  "backorder",
  "made_to_order",
]);
export type CatalogueAvailabilityV2 = z.infer<typeof catalogueAvailabilityV2Schema>;

/** A picture or a video of the offer, linked and never copied; the first picture is its main one. */
export const catalogueMediaSchema = z.object({
  type: z.enum(["image", "video"]),
  url: httpsUrl,
  alt: z.string().max(200).optional().describe("What it shows, for a person who cannot see it."),
});
export type CatalogueMedia = z.infer<typeof catalogueMediaSchema>;

/**
 * Sold only above an age, with ID checked when it is handed over. The business picks the age for each
 * product (`min_age`, and `by_country` where it sells in a country whose age it puts higher or lower);
 * nothing here says what any law requires. A kind of `vocab/age-kinds.json` whose `network` is `off`
 * (tobacco and nicotine, cannabis, weapons) is kept off networks, ID check or not.
 */
export const catalogueAgeRestrictedSchema = z.object({
  min_age: z.int().min(AGE_MIN).max(AGE_MAX),
  kind: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .describe("A kind of vocab/age-kinds.json: alcohol, blades, fireworks…"),
  by_country: z
    .record(z.string().regex(/^[A-Z]{2}$/), z.int().min(AGE_MIN).max(AGE_BY_COUNTRY_MAX))
    .optional()
    .describe("ISO 3166-1 alpha-2 country → the age there, where it is not min_age."),
  check: z
    .literal("id_at_handover")
    .describe("ID is checked when it is handed over: by the business, or a carrier service it marks id_check."),
});
export type CatalogueAgeRestricted = z.infer<typeof catalogueAgeRestrictedSchema>;

/** How the offer reaches the buyer. */
export const catalogueFulfilMethodSchema = z.enum([
  "pickup",
  "reserve_pickup",
  "local_delivery",
  "shipping",
  "dine_in",
  "digital",
]);
export type CatalogueFulfilMethod = z.infer<typeof catalogueFulfilMethodSchema>;

/** The offer's weight as packed for sending: what a `by_weight` rate is worked out from. */
export const catalogueWeightSchema = z.object({
  value: measureNumber.describe("Above 0, at most three decimals."),
  unit: z
    .string()
    .regex(/^[a-z]{1,4}$/)
    .describe("g, kg, oz or lb."),
});
export type CatalogueWeight = z.infer<typeof catalogueWeightSchema>;

/** One offer, listed, in catalogue version 2. */
export const catalogueListedItemV2Schema = z.object({
  id: catalogueIdV2Schema.describe(
    "The business's own id for this offer (a variant's, when it has variants): what an order names.",
  ),
  state: z.literal("listed"),
  sku: z.string().max(64).nullable(),
  name: z
    .string()
    .min(1)
    .max(CATALOGUE_NAME_MAX)
    .describe("The offer's whole name, a variant's options in it: Moka pot, 6 cups."),
  description: z.string().max(CATALOGUE_DESCRIPTION_MAX_V2).nullable(),
  group: catalogueGroupSchema
    .optional()
    .describe("The product group it is a variant of; with options, and only with them."),
  options: z
    .array(catalogueOptionSchema)
    .min(1)
    .max(CATALOGUE_OPTIONS_MAX)
    .optional()
    .describe("What sets this variant apart in its group: every variant of a group names the same keys."),
  price_model: cataloguePriceModelSchema,
  price: catalogueMoneySchema
    .nullable()
    .describe(
      "fixed: the price; from: the lowest; range: the lowest, to price_max; quote: null, the price is asked for.",
    ),
  price_max: catalogueMoneySchema.optional().describe("range only: the highest, above price, in its currency."),
  list_price: catalogueMoneySchema
    .optional()
    .describe(
      "fixed only: the 'was' price, above price, in its currency, shown only when the offer was at or above it for the 30 days before the price went below it.",
    ),
  unit_price: catalogueUnitPriceSchema
    .optional()
    .describe("fixed only: the net quantity, so a reader gives the price per kg, per litre."),
  tax_included: z
    .boolean()
    .optional()
    .describe("Whether this offer's prices include tax, where it is not what the catalogue says of every price."),
  availability: catalogueAvailabilityV2Schema,
  available_from: isoTime.optional().describe("preorder (required) and backorder: when it can be had from."),
  available_until: isoTime.optional().describe("The last moment it can be ordered: a season, a menu that ends."),
  gtin: z
    .string()
    .regex(/^\d{14}$/)
    .nullable()
    .describe(
      "Its barcode as 14 digits, check digit verified and never a shop's own code or a coupon (vectors/gtin.json), or null.",
    ),
  no_gtin: z
    .boolean()
    .describe(
      "true: the owner says it has no barcode at all (bread, a print, a repair, something made to order), and gtin is null. false: it has one, or none was given.",
    ),
  multipack: z
    .int()
    .min(1)
    .max(CATALOGUE_MULTIPACK_MAX)
    .optional()
    .describe("As in version 1: this many identical units of one item."),
  is_bundle: z
    .boolean()
    .optional()
    .describe(
      "Different items sold together at one price (a hamper, a set menu, a kit); its gtin, if any, is the bundle's own.",
    ),
  brand: z.string().max(70).nullable(),
  mpn: z.string().max(70).nullable(),
  condition: catalogueConditionSchema,
  url: httpsUrl.nullable().describe("Its page, an absolute https address on the business's own site, or null."),
  media: z
    .array(catalogueMediaSchema)
    .max(CATALOGUE_MEDIA_MAX)
    .describe("Pictures and videos, linked; the first image is the main one. Empty when there are none."),
  age_restricted: catalogueAgeRestrictedSchema.optional(),
  fulfil_methods: z
    .array(catalogueFulfilMethodSchema)
    .min(1)
    .max(6)
    .optional()
    .describe("How it reaches the buyer; absent, the business has not said for this offer."),
  shipping_profile: catalogueIdV2Schema
    .optional()
    .describe("A shipping profile of the policies document; absent, its default profile, when it ships."),
  weight: catalogueWeightSchema.optional(),
  return_policy: catalogueIdV2Schema
    .optional()
    .describe("A return policy of the policies document; absent, its default policy."),
  updated_at: isoTime,
  hash: hex16.describe(
    "The first 16 hex digits of SHA-256 over the item's canonical JSON (canonicalJson), every member it carries but updated_at and hash.",
  ),
});
export type CatalogueListedItemV2 = z.infer<typeof catalogueListedItemV2Schema>;

/** An offer no longer listed: archived, kept off networks, sold no more, or past `available_until`. Never deleted. */
export const catalogueWithdrawnItemV2Schema = z.object({
  id: catalogueIdV2Schema,
  state: z.literal("withdrawn"),
  updated_at: isoTime,
});
export type CatalogueWithdrawnItemV2 = z.infer<typeof catalogueWithdrawnItemV2Schema>;

export const catalogueItemV2Schema = z.discriminatedUnion("state", [
  catalogueListedItemV2Schema,
  catalogueWithdrawnItemV2Schema,
]);
export type CatalogueItemV2 = z.infer<typeof catalogueItemV2Schema>;

/** Version 2's summary: version 1's, and the `rev` of the policies document its items name. */
export const catalogueSummaryV2Schema = catalogueSummarySchema.extend({
  policies_rev: hex16
    .nullable()
    .describe("The policies document's rev: a reader whose copy has another reads it again. null: there is none."),
});
export type CatalogueSummaryV2 = z.infer<typeof catalogueSummaryV2Schema>;

/** `GET /v1/catalogue/changes?version=2`: `200`. */
export const cataloguePageV2Schema = z.object({
  version: z.literal(2),
  domain: z.string().min(1).max(253),
  as_of: isoTime,
  catalogue: catalogueSummaryV2Schema,
  items: z.array(catalogueItemV2Schema).max(CATALOGUE_PAGE_MAX),
  next_cursor: catalogueCursorV2Schema.nullable(),
});
export type CataloguePageV2 = z.infer<typeof cataloguePageV2Schema>;

/** `GET /v1/catalogue/items?version=2&ids=…`: `200`. `missing`: the ids it has no offer for. */
export const catalogueItemsV2Schema = z.object({
  version: z.literal(2),
  items: z.array(catalogueItemV2Schema).max(CATALOGUE_ITEMS_MAX),
  missing: z.array(catalogueIdV2Schema).max(CATALOGUE_ITEMS_MAX),
});
export type CatalogueItemsV2 = z.infer<typeof catalogueItemsV2Schema>;

/* --- the vocabularies -------------------------------------------------------------------------- */

const labels = z.object({
  en: z.string().min(1),
  pt: z.string().min(1),
  es: z.string().min(1),
  fr: z.string().min(1),
  de: z.string().min(1),
});

export const optionKeysVocabSchema = z.object({
  description: z.string(),
  version: z.int().min(1),
  languages: z.array(z.string()),
  keys: z.array(
    z.object({
      key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
      labels,
      gmc: z.string().nullable(),
      also: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)),
    }),
  ),
});
export type OptionKeysVocab = z.infer<typeof optionKeysVocabSchema>;

export const ageKindsVocabSchema = z.object({
  description: z.string(),
  version: z.int().min(1),
  languages: z.array(z.string()),
  kinds: z.array(
    z.object({
      kind: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
      labels,
      covers: z.string().min(1),
      network: z.enum(["listed", "off"]),
    }),
  ),
});
export type AgeKindsVocab = z.infer<typeof ageKindsVocabSchema>;

/** `vocab/option-keys.json`, read. */
export const OPTION_KEYS: OptionKeysVocab = optionKeysVocabSchema.parse(optionKeysVocab);
/** `vocab/age-kinds.json`, read. */
export const AGE_KINDS: AgeKindsVocab = ageKindsVocabSchema.parse(ageKindsVocab);

const optionKeyByWord = new Map<string, string>();
for (const k of OPTION_KEYS.keys) {
  optionKeyByWord.set(k.key, k.key);
  for (const a of k.also) optionKeyByWord.set(a, k.key);
}

/** The vocabulary's key a word names (`colour` is `color`), or null for a key of the business's own. */
export function optionKeyOf(word: string): string | null {
  return optionKeyByWord.get(word.trim().toLowerCase()) ?? null;
}

/** The kinds a network keeps off at product level, ID check or not: tobacco and nicotine, cannabis, weapons. */
export const AGE_KINDS_OFF: readonly string[] = AGE_KINDS.kinds.filter((k) => k.network === "off").map((k) => k.kind);

/** Whether an age-restricted kind is kept off networks. A kind the vocabulary does not know is not. */
export function ageKindIsOff(kind: string): boolean {
  return AGE_KINDS_OFF.includes(kind);
}

/** The label an agent shows beside an age-restricted offer: "ID checked at handover: 18+". */
export function ageLabel(age: number): string {
  return `ID checked at handover: ${age}+`;
}

/** The age a buyer in a country must be for an offer: its `by_country` there, else its `min_age`. */
export function ageFor(age: CatalogueAgeRestricted, country?: string | null): number {
  const c = country?.toUpperCase();
  return (c && age.by_country?.[c]) || age.min_age;
}
