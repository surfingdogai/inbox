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
  manifest_url: z.url(),
  verified_at: timestampSchema,
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
});
export type Listing = z.infer<typeof listingSchema>;

/** `GET /v1/businesses/{domain}`: a listing and a count for every §3 outcome code. */
export const listingDetailSchema = listingSchema.extend({
  outcomes: z.partialRecord(outcomeCodeSchema, z.int().min(0)),
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
    .describe("A slug of the categories list, found by its slug, a label or a synonym; anything else matches a tag."),
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
});

export const businessesResponseSchema = z.object({
  businesses: z.array(listingSchema),
  next_cursor: z.string().nullable(),
});
export type BusinessesResponse = z.infer<typeof businessesResponseSchema>;

/** A cursor, decoded: base64url JSON `{m, p}`, the mode and the last `rank_pos` (rules version 3). */
export const rankCursorSchema = z.object({ m: z.enum(["rank", "near"]), p: z.int().min(1) });

/** `GET /v1/categories`: the categories list's slugs and labels, from `vocab/categories.json` (ADR-017 A2.5). */
export const categoriesResponseSchema = z.object({
  version: z.int().min(1),
  categories: z.array(
    z.object({
      slug: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/),
      labels: z.record(z.string(), z.string()).describe("Language → label."),
    }),
  ),
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
