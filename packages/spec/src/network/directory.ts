import { z } from "zod";
import { closureDaysSchema, profileServiceSchema, weeklyHoursSchema } from "../base";
import { tierSchema, timestampSchema } from "./common";
import { outcomeCodeSchema } from "./receipts";

/**
 * The public directory (ADR-017 §6, §7.2): listings, their reputation, and the order. Nothing about
 * any customer is ever returned.
 */

/** A listing's reputation, from the last nightly snapshot (present once the ranked order is in force). */
export const reputationSchema = z.object({
  ranked: z.boolean().describe("score ≥ 0.40 (building): sorts before the daily shuffle."),
  score: z.number().min(0).max(1),
  tier: tierSchema,
  kept: z.int().min(0),
  broken: z.int().min(0),
  customers: z.int().min(0).describe("Distinct customers (§5.3)."),
  verified_share: z.number().min(0).max(1).describe("The share of weight from verified evidence."),
  rules: z.int().min(1).describe("The rules version that ordered this listing."),
  rules_url: z.url().optional(),
});
export type Reputation = z.infer<typeof reputationSchema>;

/** A listing's address (ADR-017 A2.5): the street only when the business's inbox published one. */
export const listingAddressSchema = z.object({
  street: z.string().optional(),
  locality: z.string().optional(),
  postal_code: z.string().optional(),
  country: z.string().length(2).optional(),
});

/** A listing's hours: the business's zone, its weekly windows, and the closures that have not ended. */
export const listingHoursSchema = z.object({
  timezone: z.string(),
  weekly: weeklyHoursSchema,
  closures: z.array(closureDaysSchema),
});

/* --- protocol 0.2: doors, readiness, and what a listing holds (§4.8–§4.11) ---------------------------------------- */

/** The readiness ladder (§4.9), by name. A network never shows a number for a level. */
export const levelNameSchema = z.enum(["listed", "readable", "askable", "bookable", "payable"]);
export type LevelName = z.infer<typeof levelNameSchema>;

/** What an AI can do through a door (§4.8): ask, ask for a quote, book, order, pay. */
export const doorKindSchema = z.enum(["ask", "quote", "book", "order", "pay"]);
export type DoorKind = z.infer<typeof doorKindSchema>;

/**
 * A door's type (§4.8, `vocab/doors.json`): a machine endpoint the business published for agents. `platform:<slug>` is
 * a commerce or booking platform's door for this business. Human channels (mail, phone, messaging, forms, web pages)
 * are never doors.
 */
export const doorTypeSchema = z
  .string()
  .regex(/^(inbox|mcp|a2a|openapi|api|ucp|acp|nlweb|webhook|other|platform:[a-z0-9-]{1,40})$/);

/**
 * Where a value comes from (§4.10): `declared` by the business (its manifest, its registration, its own structured
 * data), `seen` on its own pages or at its own door, or `probably`, read from its pages by a model or a heuristic. A
 * `probably` value never counts in a filter, except page language.
 */
export const factSourceSchema = z.enum(["declared", "seen", "probably"]);
export type FactSource = z.infer<typeof factSourceSchema>;

/** A door as a listing and a card show it (§4.8). A gone door is never shown. */
export const cardDoorSchema = z.object({
  type: doorTypeSchema,
  url: z.url(),
  level: levelNameSchema.describe("What this door alone reaches, from the network's own probe."),
  status: z.enum(["live", "failing"]).describe("failing: 3 failures in 7 days; it counts for nothing until it works."),
  kinds: z.array(doorKindSchema),
  src: z.enum(["declared", "seen"]).describe("declared: the business said so; seen: read from the door's own tools."),
  protocol: z.string().max(40).optional().describe('The protocol it speaks, for type "other" only.'),
  checked_at: timestampSchema.optional(),
});
export type CardDoor = z.infer<typeof cardDoorSchema>;

/** A place category: an Overture Place Categories id (CC BY 4.0) with its label, or a group slug. */
export const placeCategorySchema = z.object({ id: z.string(), label: z.string(), src: factSourceSchema });

export const cardCategorySchema = z.object({
  primary: placeCategorySchema,
  alternates: z.array(placeCategorySchema).max(2),
  path: z.array(z.string()).describe("Ancestor ids of the primary, root first, the primary last."),
  group: z.string().optional().describe("Its group: a slug of GET /v1/categories."),
});

export const cardPlaceSchema = z.object({
  locality: z.string().optional(),
  region: z.string().optional(),
  country: z.string().length(2).optional().describe("ISO 3166-1 alpha-2."),
  kind: z.array(z.enum(["storefront", "service_area", "online"])),
  service_area: z
    .object({
      radius_km: z.number().positive().max(300).optional(),
      countries: z.array(z.string().length(2)).max(50).optional(),
    })
    .optional(),
  ships_to: z.array(z.string()).optional().describe('ISO 3166-1 alpha-2 codes, or ["*"] for anywhere.'),
});

/** On an entry the network found on the business's own website (§4.11). */
export const cardFoundSchema = z.object({
  note: z.string().describe('"found on its own website · not a member · checked <YYYY-MM-DD>"'),
  checked_at: timestampSchema,
  about_url: z.url().describe("The network's page for businesses: why it is here, and how to correct it or opt out."),
});

/** A displayed value with where it came from and when (§4.10, §4.11). */
export const listingFactSchema = z.object({
  field: z.string(),
  v: z.unknown(),
  src: factSourceSchema,
  url: z.url().optional().describe("The page or door it was read from."),
  at: timestampSchema,
  via: z.string().optional(),
});
export type ListingFact = z.infer<typeof listingFactSchema>;

/** The proof a claimed entry carries (§4.12); a card says the label and never the word "verified". */
export const proofLabelSchema = z.enum(["domain", "key", "platform", "code"]);
export type ProofLabel = z.infer<typeof proofLabelSchema>;

/**
 * What protocol 0.2 adds to a listing and to a card, all optional (§4.10). A network at 0.1 sends none of it; a reader
 * at 0.1 ignores it.
 */
export const listingAdditionsShape = {
  source: z
    .enum(["member", "registered", "found"])
    .optional()
    .describe("member: through its inbox; registered: by the business, with a proof; found: by the network's crawler."),
  claimed: z.boolean().optional(),
  proof: proofLabelSchema.optional(),
  level: levelNameSchema.optional().describe("The highest level of its live doors (§4.9)."),
  has_inbox: z.boolean().optional().describe("It has an inbox door: ours or any compatible inbox."),
  doors: z.array(cardDoorSchema).optional(),
  requestable: z
    .array(z.enum(["ask", "quote"]))
    .optional()
    .describe("The kinds a live door declared it answers; never from what the crawler saw alone."),
  accepts: z
    .object({
      kinds: z.array(doorKindSchema),
      pay: z.array(z.string()).optional().describe("Payment tokens of GET /v1/attributes' payments."),
    })
    .optional(),
  category: cardCategorySchema.optional(),
  attributes: z
    .record(z.string(), z.object({ v: z.union([z.boolean(), z.string(), z.number()]), src: factSourceSchema }))
    .optional()
    .describe("Keys of GET /v1/attributes."),
  place: cardPlaceSchema
    .optional()
    .describe("For entries that are not members; a member keeps city, country and address."),
  why: z.string().optional().describe("Why it is in this place of the list, in plain words."),
  found: cardFoundSchema.optional(),
} as const;

export const listingSchema = z.object({
  domain: z.string(),
  name: z.string(),
  description: z.string().optional(),
  city: z.string().optional(),
  country: z.string().length(2).optional().describe("ISO 3166-1 alpha-2."),
  address: listingAddressSchema.optional(),
  categories: z.array(z.string()).describe("Slugs of the categories list (GET /v1/categories)."),
  tags: z.array(z.string()).optional().describe("What the profile named that is not in the categories list (A2.5)."),
  languages: z.array(z.string()),
  item_types: z.array(z.string()),
  protocols: z.record(z.string(), z.string()).describe("Protocol name → entry URL."),
  hours: listingHoursSchema
    .optional()
    .describe("Absent when the business published none, or none the network could read."),
  open_now: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      "Open at the moment of the answer by the hours it published, in its own zone, a closure winning; null when it published none. A cached answer may be minutes old.",
    ),
  services: z.array(profileServiceSchema).optional(),
  geo: z.object({ lat: z.number(), lng: z.number() }).optional(),
  distance_km: z.number().min(0).optional().describe("Near searches only."),
  url: z.string().optional(),
  manifest_url: z.url().optional().describe("Always present for a member."),
  verified_at: timestampSchema.optional().describe("Always present for a member."),
  last_ping_at: timestampSchema.optional(),
  software: z.object({ version: z.string().optional(), runtime: z.string().optional() }).optional(),
  receipts: z.object({
    issued: z.int().min(0).describe("Promises only."),
    acknowledged: z.int().min(0),
    customers: z.int().min(0).optional(),
    last_at: timestampSchema.optional(),
  }),
  answering: z.boolean().describe("A ping, signed or not, within 24 h and no failed manifest sweep since."),
  online: z.boolean().describe("An alias of answering."),
  not_answering_since: timestampSchema.nullable(),
  rank_pos: z.int().min(1).optional().describe("Position in the hourly snapshot's order."),
  rank_shuffle: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional()
    .describe('The first 16 hex digits of SHA-256("<YYYY-MM-DD>:<business uuid>"): a string, never a number.'),
  reputation: reputationSchema.optional(),
  ...listingAdditionsShape,
});
export type Listing = z.infer<typeof listingSchema>;

/** `GET /v1/businesses/{domain}`: a listing and a count for every §3 outcome code. */
export const listingDetailSchema = listingSchema.extend({
  outcomes: z.partialRecord(outcomeCodeSchema, z.int().min(0)),
  facts: z
    .array(listingFactSchema)
    .optional()
    .describe("Every displayed value of an entry that is not a member, with its source and date (§4.11)."),
});
export type ListingDetail = z.infer<typeof listingDetailSchema>;

/** `GET /v1/businesses` query parameters. */
export const businessesQuerySchema = z.object({
  near: z
    .string()
    .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
    .optional()
    .describe("lat,lng"),
  radius_km: z.number().positive().max(1000).optional().describe("Near searches; 10 by default."),
  category: z
    .string()
    .optional()
    .describe(
      "A slug of the categories list, or a place category id with every category below it, found by its id, slug, label or synonym. Under rules before version 7 anything else matches a tag; from version 7 it is 400 category_unresolved with up to 5 candidates.",
    ),
  item_type: z.string().optional(),
  language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
    .max(12)
    .optional()
    .describe(
      "A language tag: a business that speaks it or a variant of it (pt keeps pt and pt-br; pt-br keeps pt-br only).",
    ),
  q: z
    .string()
    .max(80)
    .optional()
    .describe(
      "Words that must all be in the business's name, city, description, categories (with their labels and synonyms), tags or services' names, ignoring case and accents; words of one letter, and a few that say nothing about a business, are ignored. A q with no word left is 400.",
    ),
  open_now: z
    .boolean()
    .optional()
    .describe("true: only businesses open now by the hours they published; one that published none is left out."),
  limit: z.int().min(1).max(100).optional(),
  cursor: z.string().optional().describe("next_cursor from the previous page; another cursor is 410 cursor_expired."),
  // Protocol 0.2 (§4.10). Every one only leaves businesses out.
  attributes: z
    .string()
    .max(620)
    .optional()
    .describe("Comma-separated keys of GET /v1/attributes (key=value for one with values), at most 10: all must hold."),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .optional()
    .describe("ISO 3166-1 alpha-2: a business located there, serving it, or shipping there."),
  price_band: z
    .string()
    .regex(/^[1-4](-[1-4])?$/)
    .optional()
    .describe('"2", or a range like "1-2".'),
  accepts: z
    .string()
    .max(330)
    .optional()
    .describe("Comma-separated kinds (ask, quote, book, order, pay) and payment tokens, at most 8: all must hold."),
  requestable: z.enum(["ask", "quote"]).optional().describe("A live door that declared this kind."),
  door_type: z
    .string()
    .max(250)
    .optional()
    .describe('Comma-separated door types, or "platform" for any platform door, at most 5: any of them.'),
  level: z
    .enum(["listed", "readable", "askable", "bookable", "orderable", "payable"])
    .optional()
    .describe("At this level or above (orderable is bookable); below askable nothing is listed yet."),
  has_inbox: z.boolean().optional(),
  source: z.string().max(40).optional().describe("Comma-separated: member, registered, found; any of them."),
  order: z
    .enum(["rank", "nearest"])
    .optional()
    .describe("rank, the published order, by default; nearest sorts by distance and needs near."),
});

export const businessesResponseSchema = z.object({
  businesses: z.array(listingSchema),
  next_cursor: z.string().nullable(),
});
export type BusinessesResponse = z.infer<typeof businessesResponseSchema>;

/** A cursor, decoded: base64url JSON `{m, p}`, the mode and the last `rank_pos` (rules version 3). */
export const rankCursorSchema = z.object({ m: z.enum(["rank", "near"]), p: z.int().min(1) });

/**
 * Cursors of rules version 7's directory (§4.3, §4.4), decoded: `{m, p}` with `found` or `foundnear` continues the tier
 * of entries that are not members after every member, while an earlier version is in force; `{m, o}` is the place
 * reached in version 7's order, at most 1000 deep.
 */
export const rankCursorFoundSchema = z.object({ m: z.enum(["found", "foundnear"]), p: z.int().min(1) });
export const rankCursorV7Schema = z.object({ m: z.enum(["v7", "v7near", "nearest"]), o: z.int().min(0).max(1000) });

/** The place taxonomy a network names its categories in (§4.10), and its licence. */
export const placeTaxonomySchema = z.object({
  name: z.string().describe('"Overture Place Categories"'),
  release: z.string(),
  licence: z.string().describe('"CC BY 4.0"'),
  url: z.url(),
});

/**
 * `GET /v1/categories`: the categories list's slugs and labels, from `vocab/categories.json` (ADR-017 A2.5). With
 * `?group=<slug>` (protocol 0.2), also that group's place categories and the taxonomy they come from.
 */
export const categoriesResponseSchema = z.object({
  version: z.int().min(1),
  categories: z.array(
    z.object({
      slug: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/),
      kind: z
        .enum(["local_and_retail", "software_and_ai"])
        .optional()
        .describe("software_and_ai: software, API and AI companies, kept apart from local and retail businesses."),
      labels: z.record(z.string(), z.string()).describe("Language → label."),
    }),
  ),
  place_categories: z
    .array(z.object({ id: z.string(), label: z.string(), parent: z.string().nullable() }))
    .optional()
    .describe("With ?group: every place category of that group; parent is null at the taxonomy's top."),
  taxonomy: placeTaxonomySchema.optional(),
});
export type CategoriesResponse = z.infer<typeof categoriesResponseSchema>;

/**
 * The file `vocab/categories.json`: every slug with its labels and synonyms in each language. A term (slug, label or
 * synonym, compared in lower case, without accents, with every run of other characters as one space and the words
 * "and" and "e" left out) names one slug only.
 */
export const categoryVocabularySchema = z.object({
  description: z.string(),
  version: z.int().min(1),
  languages: z.array(z.string()).min(1),
  categories: z.array(
    z.object({
      slug: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/),
      labels: z.record(z.string(), z.string().min(1)),
      synonyms: z.record(z.string(), z.array(z.string().min(1))),
    }),
  ),
});
export type CategoryVocabulary = z.infer<typeof categoryVocabularySchema>;

/** `GET /c/{id}`: one place category (§4.10). */
export const placeCategoryResponseSchema = z.object({
  id: z.string(),
  label: z.string(),
  parent: z.string().nullable(),
  path: z.array(z.string()).describe("Ancestor ids, root first, this one last."),
  group: z.string().optional().describe("Its group's slug, when one covers it."),
  regulated: z
    .string()
    .optional()
    .describe("Why entries that are not members are not listed in it, when they are not (§4.11)."),
  taxonomy: placeTaxonomySchema,
});
export type PlaceCategoryResponse = z.infer<typeof placeCategoryResponseSchema>;

/** One attribute as `GET /v1/attributes` and `list_attributes` give it (§4.10). */
export const attributeKeySchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  group: z.string(),
  type: z.enum(["bool", "enum"]),
  values: z.array(z.string()).optional().describe('The values of an "enum" key; a filter names one as key=value.'),
  labels: z.record(z.string(), z.string()).describe("Language → label."),
  filterable: z.boolean().optional().describe("false: shown in the list, never filterable or shown yet."),
});

/** `GET /v1/attributes`: the attribute keys, and the payment tokens `accepts` takes (§4.10). */
export const attributesResponseSchema = z.object({
  version: z.int().min(1),
  keys: z.array(attributeKeySchema),
  payments: z.object({
    methods: z.array(z.string()),
    wallets: z.array(z.string()),
    agent: z.array(z.string()).describe("Ways an agent itself pays: AP2, ACP delegated payment, x402, UCP handlers."),
  }),
});
export type AttributesResponse = z.infer<typeof attributesResponseSchema>;

/**
 * The file `vocab/attributes.json` (§4.10): every attribute key, the group it belongs to, the categories it applies to
 * (group slugs, or `*`), whether a crawler may read it (`declared`: from the business's own structured data;
 * `seen`: also from an explicit statement on its own pages; `never`), whether it needs a proof a register would give
 * (never filterable or shown until one exists), and its labels.
 */
export const attributeVocabularySchema = z.object({
  description: z.string().optional(),
  version: z.int().min(1),
  keys: z.array(
    z.object({
      key: z.string().regex(/^[a-z][a-z0-9_]*$/),
      group: z.string(),
      type: z.enum(["bool", "enum"]),
      values: z.array(z.string().regex(/^[a-z0-9_]+$/)).optional(),
      applies_to: z.array(z.string()).min(1),
      crawlable: z.enum(["declared", "seen", "never"]),
      needs_proof: z.boolean(),
      labels: z.record(z.string(), z.string().min(1)),
      schemaorg: z.string().optional(),
      osm: z.string().optional(),
    }),
  ),
});
export type AttributeVocabulary = z.infer<typeof attributeVocabularySchema>;

/**
 * The file `vocab/doors.json` (§4.8): the door types, the prefix of a platform's door, what is refused as a door
 * (types, URL schemes and hosts of human channels), the kinds, and the kinds a network may deliver.
 */
export const doorVocabularySchema = z.object({
  version: z.int().min(1),
  types: z.array(z.string()),
  experimental: z
    .array(z.string())
    .optional()
    .describe(
      "Version 2: door types a network reads and may count toward the agentic score (§4.13), never toward a level, a listing or the order; a business cannot declare them.",
    ),
  platform_prefix: z.string(),
  refused: z.array(z.string()),
  refused_url_schemes: z.array(z.string()),
  refused_hosts: z.array(z.string()),
  kinds: z.array(doorKindSchema),
  delivery_kinds: z.array(doorKindSchema),
});
export type DoorVocabulary = z.infer<typeof doorVocabularySchema>;
