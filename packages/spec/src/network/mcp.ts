import { z } from "zod";
import { profileServiceSchema } from "../base";
import { tierSchema } from "./common";
import { categoriesResponseSchema, listingAddressSchema, listingHoursSchema } from "./directory";
import { outcomeCodeSchema } from "./receipts";

/**
 * The tools a network offers assistants at `POST /mcp` (ADR-017 A2.7, `docs/protocol/network.md` §4.7): what each
 * takes and what each answers, so that every network offers the same ones and an assistant moves between networks
 * without learning anything new. Each is read-only and answers the same whoever asks. The JSON Schemas generated from
 * these (`schemas/mcp-*.json`) are the tools' `inputSchema` and `outputSchema`, word for word.
 */

/** The tools, by name. */
export const MCP_TOOL_NAMES = ["search_businesses", "get_business", "list_categories"] as const;

/** `search_businesses`: `GET /v1/businesses` for an assistant, in the same order and with the same filters. */
export const searchBusinessesInputSchema = z.object({
  query: z
    .string()
    .max(80)
    .optional()
    .describe(
      'A few words about what the business does or where, like "haircut alfama" or "padaria". Every word must match its name, town, description, categories, tags or services, ignoring capitals and accents. Words like "open" or "near me" belong in open_now and near instead.',
    ),
  near: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      radius_km: z
        .number()
        .positive()
        .max(1000)
        .optional()
        .describe("How far from the point, in kilometres: 10 when left out."),
    })
    .optional()
    .describe("Only businesses within radius_km of this point, each with its distance."),
  category: z
    .string()
    .max(60)
    .optional()
    .describe(
      "A slug from list_categories, like hair-beauty. Its English or Portuguese label or a synonym works too; any other word matches the tags businesses gave themselves.",
    ),
  item_type: z
    .enum(["booking", "order", "quote_request", "message"])
    .optional()
    .describe("Only businesses whose inbox takes this."),
  language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
    .max(12)
    .optional()
    .describe("Only businesses that speak this language, as a tag like pt or en; pt also finds pt-br."),
  open_now: z
    .boolean()
    .optional()
    .describe(
      "true: only businesses open right now by the hours they published. One that published no hours is left out.",
    ),
  limit: z.int().min(1).max(20).optional().describe("How many to return: 10 when left out."),
  cursor: z
    .string()
    .max(512)
    .optional()
    .describe("next_cursor from the previous answer, for the next page of the same search."),
});
export type SearchBusinessesInput = z.infer<typeof searchBusinessesInputSchema>;

/**
 * A business as an assistant needs it: what it does, where and when, what it takes, where to go to book or order,
 * and its standing in words. Name, description, city, tags and services' names are the business's own words.
 */
export const businessCardSchema = z.object({
  domain: z.string().describe("The business's own domain, where its inbox is."),
  name: z.string().describe("As the business wrote it."),
  description: z.string().optional().describe("As the business wrote it."),
  website: z.string().optional(),
  city: z.string().optional(),
  country: z.string().length(2).optional().describe("ISO 3166-1 alpha-2."),
  distance_km: z.number().min(0).optional().describe("Searches near a point only."),
  categories: z.array(z.string()).describe("Slugs of the categories list."),
  tags: z.array(z.string()).describe("Other words the business gave for what it does."),
  languages: z.array(z.string()),
  takes: z.array(z.string()).describe("What its inbox takes: booking, order, quote_request, message, refund."),
  services: z
    .array(profileServiceSchema)
    .describe("Names and how each is taken; prices, durations and free times are at its inbox."),
  open_now: z
    .boolean()
    .nullable()
    .describe(
      "Open at the moment of the answer by the hours it published, in its own time zone; null when it published none.",
    ),
  hours_today: z
    .string()
    .nullable()
    .describe(
      'Today\'s hours in its own time zone, like "09:00–13:00, 14:00–19:00", or "closed today"; null when it published none.',
    ),
  answering: z.boolean().describe("Its inbox answered this network within the last day."),
  inbox: z
    .object({
      url: z.url(),
      mcp: z.url().optional().describe("Where an assistant books, orders or asks."),
      rest: z.url().optional(),
      openapi: z.url().optional(),
    })
    .describe("The business's own inbox: go there to book, order or ask. This directory takes nothing."),
  standing: z
    .object({
      tier: tierSchema,
      ranked: z.boolean().describe("Its record puts it before the daily shuffle."),
      in_words: z.string().describe("The tier in one plain sentence; never a mark against the business."),
    })
    .optional()
    .describe("From the last nightly count of the promises it kept; absent while the directory's order is neutral."),
  listing_url: z.url().describe("Its full listing on this network (GET /v1/businesses/{domain})."),
});
export type BusinessCard = z.infer<typeof businessCardSchema>;

export const searchBusinessesOutputSchema = z.object({
  businesses: z.array(businessCardSchema).describe("In the directory's published order: no one can pay to move in it."),
  next_cursor: z.string().nullable().describe("Pass it as cursor for the next page; null on the last."),
  rules: z
    .object({ version: z.int().min(1), url: z.url() })
    .describe("The rules that ordered these businesses (GET /v1/ranking?version=N)."),
});
export type SearchBusinessesOutput = z.infer<typeof searchBusinessesOutputSchema>;

/** `get_business`: `GET /v1/businesses/{domain}` for an assistant. */
export const getBusinessInputSchema = z.object({
  domain: z
    .string()
    .min(1)
    .max(253)
    .describe("The business's domain, like ana-salon.example, as search_businesses gave it."),
});
export type GetBusinessInput = z.infer<typeof getBusinessInputSchema>;

export const getBusinessOutputSchema = businessCardSchema.extend({
  address: listingAddressSchema.optional().describe("The street only when the business published one."),
  hours: listingHoursSchema.optional().describe("The whole week, and the closures that have not ended."),
  outcomes: z
    .partialRecord(outcomeCodeSchema, z.int().min(0))
    .describe("How many of the promises made at this business closed with each outcome (ADR-017 §3)."),
});
export type GetBusinessOutput = z.infer<typeof getBusinessOutputSchema>;

/** `list_categories`: `GET /v1/categories` for an assistant. */
export const listCategoriesInputSchema = z.object({});
export const listCategoriesOutputSchema = categoriesResponseSchema;
