import { z } from "zod";
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

export const listingSchema = z.object({
  domain: z.string(),
  name: z.string(),
  description: z.string().optional(),
  city: z.string().optional(),
  country: z.string().length(2).optional().describe("ISO 3166-1 alpha-2."),
  categories: z.array(z.string()),
  languages: z.array(z.string()),
  item_types: z.array(z.string()),
  protocols: z.record(z.string(), z.string()).describe("Protocol name → entry URL."),
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
  category: z.string().optional(),
  item_type: z.string().optional(),
  q: z.string().optional(),
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
