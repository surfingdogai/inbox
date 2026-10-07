import { z } from "zod";
import { profileServiceSchema } from "../base";
import { tierSchema, timestampSchema } from "./common";
import {
  attributesResponseSchema,
  categoriesResponseSchema,
  doorTypeSchema,
  levelNameSchema,
  listingAdditionsShape,
  listingAddressSchema,
  listingFactSchema,
  listingHoursSchema,
  proofLabelSchema,
} from "./directory";
import { outcomeCodeSchema } from "./receipts";

/**
 * The tools a network offers assistants at `POST /mcp` (ADR-017 A2.7, `docs/protocol/network.md` §4.7): what each
 * takes and what each answers, so that every network offers the same ones and an assistant moves between networks
 * without learning anything new. Each is read-only and answers the same whoever asks. The JSON Schemas generated from
 * these (`schemas/mcp-*.json`) are the tools' `inputSchema` and `outputSchema`, word for word.
 */

/** The tools, by name. */
export const MCP_TOOL_NAMES = ["search_businesses", "get_business", "list_categories"] as const;

/**
 * Tools a network may also offer (protocol 0.2): `list_attributes`, read-only; `register_business` and `update_business`,
 * which a business's own AI calls to register, claim, correct or remove its listing (§4.12).
 */
export const MCP_OPTIONAL_TOOL_NAMES = ["list_attributes", "register_business", "update_business"] as const;

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
      "A slug from list_categories, like hair-beauty, or a place category id like hair_salon, with every category below it. Its label or a synonym works too. Under rules before version 7 any other word matches the tags businesses gave themselves; from version 7 it is an error that names up to 5 categories to try.",
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
  // Protocol 0.2 (§4.10): each only leaves businesses out, and none moves one.
  attributes: z
    .array(z.string().max(60))
    .max(10)
    .optional()
    .describe(
      'Keys from list_attributes, like "delivery" or "walk_ins", or key=value for one with values; every one must hold. This only leaves businesses out.',
    ),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .optional()
    .describe(
      "A country code like PT or BR: a business located there, serving it or shipping there. This only leaves businesses out.",
    ),
  price_band: z
    .string()
    .regex(/^[1-4](-[1-4])?$/)
    .optional()
    .describe('1 (cheapest) to 4, as "2" or a range "1-2". This only leaves businesses out.'),
  accepts: z
    .array(z.string().max(40))
    .max(8)
    .optional()
    .describe(
      "What its live doors take and what it accepts as payment, all of them: ask, quote, book, order, pay, or a payment from list_attributes like card or pix. This only leaves businesses out.",
    ),
  requestable: z
    .enum(["ask", "quote"])
    .optional()
    .describe("A live door that declared it answers this kind. This only leaves businesses out."),
  door_type: z
    .array(doorTypeSchema.or(z.literal("platform")))
    .max(5)
    .optional()
    .describe(
      'A live door of any of these types: inbox, mcp, a2a, openapi, api, ucp, acp, nlweb, other, "platform" for any platform, or platform:<name>. This only leaves businesses out.',
    ),
  level: z
    .enum(["listed", "readable", "askable", "bookable", "orderable", "payable"])
    .optional()
    .describe(
      "At this readiness level or above: askable (an AI can ask), bookable or orderable, payable. Nothing below askable is listed yet. This only leaves businesses out.",
    ),
  has_inbox: z
    .boolean()
    .optional()
    .describe("true: with an inbox door; false: without one. This only leaves businesses out."),
  source: z
    .array(z.enum(["member", "registered", "found"]))
    .max(3)
    .optional()
    .describe(
      "member (through its inbox), registered (by the business), found (by this network on the business's own website); any of them. This only leaves businesses out.",
    ),
  order: z
    .enum(["rank", "nearest"])
    .optional()
    .describe("rank: the published order (the default); nearest: by distance, and it needs near."),
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
    .optional()
    .describe(
      "The business's own inbox: go there to book, order or ask. This directory takes nothing. Present whenever has_inbox is true or absent.",
    ),
  standing: z
    .object({
      tier: tierSchema,
      ranked: z.boolean().describe("Its record puts it before the daily shuffle."),
      in_words: z.string().describe("The tier in one plain sentence; never a mark against the business."),
    })
    .optional()
    .describe("From the last nightly count of the promises it kept; absent while the directory's order is neutral."),
  listing_url: z.url().describe("Its full listing on this network (GET /v1/businesses/{domain})."),
  ...listingAdditionsShape,
  human_contact_only: z
    .boolean()
    .optional()
    .describe("It publishes only human channels; never served while nothing below askable is listed."),
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
  facts: z
    .array(listingFactSchema)
    .optional()
    .describe("Every displayed value of an entry that is not a member, with its source and date."),
  rules: z.object({ version: z.int().min(1), url: z.url() }).optional(),
});
export type GetBusinessOutput = z.infer<typeof getBusinessOutputSchema>;

/** `list_categories`: `GET /v1/categories` for an assistant. */
export const listCategoriesInputSchema = z.object({});
export const listCategoriesOutputSchema = categoriesResponseSchema;

/** `list_attributes`: `GET /v1/attributes` for an assistant (protocol 0.2). */
export const listAttributesInputSchema = z.object({});
export const listAttributesOutputSchema = attributesResponseSchema;

/* --- register_business and update_business (§4.12) ----------------------------------------------------------------- */

/**
 * A door as a business declares it. Its type and URL are read loosely here so that a network can answer what it
 * refused, part by part, in `dropped`, instead of failing the whole call.
 */
export const declaredDoorSchema = z.object({
  type: z
    .string()
    .max(60)
    .describe(
      "inbox, mcp, a2a, openapi, api, ucp, acp, nlweb, webhook, other, or platform:<name>. Mail, phone, messaging, forms and web pages are human channels and never doors.",
    ),
  url: z.string().max(2048).describe("https, with no user in it."),
  kinds: z.array(z.string().max(20)).max(4).optional().describe("Of ask, quote, book, order: what it answers."),
  protocol: z.string().max(40).optional().describe('What it speaks, for type "other": like beckn or graphql.'),
  rate_limit: z.int().optional().describe("Requests a day this door takes, 1 to 20; it only lowers the network's own."),
  terms_url: z.string().max(2048).optional(),
});

const registerFields = {
  name: z.string().min(1).max(200).describe("As the business writes it."),
  category: z
    .object({
      primary: z.string().max(80).describe("A place category id (GET /v1/categories?group=…) or a group slug."),
      alternates: z.array(z.string().max(80)).max(2).optional(),
    })
    .describe("What the business is: one category, and at most two more."),
  description: z.string().min(1).max(500).describe("One line on what it does; the first line is at most 160."),
  where: z
    .object({
      kind: z.array(z.enum(["storefront", "service_area", "online"])).min(1),
      address: z
        .object({
          street: z.string().max(200).optional(),
          locality: z.string().max(100).optional(),
          region: z.string().max(100).optional(),
          postal_code: z.string().max(20).optional(),
          country: z.string().max(2).optional(),
        })
        .optional(),
      geo: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
      service_area: z
        .object({
          radius_km: z.number().optional().describe("At most 300."),
          countries: z.array(z.string().max(2)).optional().describe("At most 50."),
        })
        .optional(),
      ships_to: z.array(z.string().max(2)).max(250).optional(),
    })
    .describe("A storefront needs an address or geo, a service area its radius or countries, online its ships_to."),
  languages: z.array(z.string().max(35)).min(1).max(10).describe("Language tags, like pt or fr-CA."),
  doors: z.array(declaredDoorSchema).max(10).optional(),
  want_inbox: z.boolean().optional(),
  hours: z
    .object({
      timezone: z.string().max(64),
      weekly: z.record(z.string(), z.array(z.array(z.string().max(5)))),
      closures: z
        .array(z.object({ from: z.string().max(10), to: z.string().max(10) }))
        .max(100)
        .optional(),
    })
    .optional()
    .describe('As a profile\'s hours: {"timezone": "Europe/Paris", "weekly": {"tue": [["09:00", "19:00"]]}}.'),
  currencies: z.array(z.string().max(3)).max(5).optional().describe("ISO 4217."),
  price_band: z.int().optional().describe("1 (cheapest) to 4."),
  attributes: z
    .record(z.string().max(60), z.union([z.boolean(), z.string().max(60)]))
    .optional()
    .describe("Keys of list_attributes."),
  pay: z.array(z.string().max(40)).max(30).optional().describe("Payment tokens of list_attributes."),
  alternate_names: z
    .array(z.string().max(200))
    .max(5)
    .optional()
    .describe(
      "Other names the business goes by; a name longer than the network keeps is dropped (the reference network keeps 60 characters and 4 words at most).",
    ),
  locale: z.string().max(35).optional().describe("The language to answer in."),
};

/** How the caller proves it speaks for the business (§4.12). */
export const claimProofSchema = z.object({
  method: z.enum(["well_known", "manifest", "dns", "key", "code"]),
  challenge_id: z.string().max(64).optional(),
  kid: z.string().max(200).optional().describe("key: the key that signed."),
  signature: z.string().max(1024).optional().describe("key: base64url of the signature."),
  email: z
    .string()
    .max(254)
    .optional()
    .describe(
      "code: an address at exactly the business's own domain (not a subdomain), typed by the owner; never a public mail or internet provider's domain.",
    ),
  code: z
    .string()
    .regex(/^[0-9]{8}$/)
    .optional()
    .describe("code: the 8 digits sent to that address."),
});

export const claimTokenSchema = z
  .string()
  .regex(/^sdc_[A-Za-z0-9_-]{43}$/)
  .describe("Given by a successful register_business: proof again for 90 days, for this listing only.");

export const registerBusinessInputSchema = z.object({
  domain: z
    .string()
    .min(1)
    .max(253)
    .describe("The business's own website domain. A business without a website is not supported yet."),
  ...registerFields,
  agree: z
    .literal(true)
    .describe("The business agrees to be listed by the network's published rules (GET /v1/ranking) and listing terms."),
  proof: claimProofSchema.optional(),
  claim_token: claimTokenSchema.optional(),
});
export type RegisterBusinessInput = z.infer<typeof registerBusinessInputSchema>;

const challengeWaySchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("well_known"), url: z.url(), content: z.string() }),
  z.object({ method: z.literal("manifest"), member: z.literal("claims"), value: z.record(z.string(), z.string()) }),
  z.object({ method: z.literal("dns"), name: z.string(), type: z.literal("TXT"), value: z.string() }),
  z.object({ method: z.literal("key"), sign: z.string(), algs: z.array(z.enum(["EdDSA", "ES256"])) }),
  z.object({ method: z.literal("code"), note: z.string() }),
]);

const listingAnswerShape = {
  domain: z.string(),
  claimed: z.boolean().optional(),
  proof: proofLabelSchema.optional(),
  level: levelNameSchema.optional(),
  listed: z.boolean().optional().describe("Whether search shows it now."),
  next_level: z
    .object({ level: levelNameSchema, how: z.string() })
    .optional()
    .describe("What it takes to reach the next level, in plain words."),
  card: businessCardSchema.optional().describe("The card search_businesses gives, as it stands now."),
  dropped: z
    .array(z.object({ field: z.string(), reason: z.string(), detail: z.string() }))
    .optional()
    .describe(
      "Each part not taken and why: refused_kind, category_not_listed, contact_detail, not_in_vocabulary, and the like.",
    ),
  challenge: z
    .object({ id: z.string(), token: z.string(), expires_at: timestampSchema, ways: z.array(challengeWaySchema) })
    .optional()
    .describe("Put the token in place one of these ways, then call again with proof.method and challenge_id."),
  claim_token: claimTokenSchema.optional(),
  claim_token_expires_at: timestampSchema.optional(),
  want_inbox: z.string().optional(),
  notes: z.array(z.string()).optional(),
  detail: z.string().optional().describe("The answer in one plain sentence."),
};

const registerStatusSchema = z.enum([
  "listed",
  "not_agent_ready",
  "probe_pending",
  "proof_needed",
  "code_sent",
  "member",
  "refused",
]);

export const registerBusinessOutputSchema = z.object({
  status: registerStatusSchema.describe(
    "listed: in search now; not_agent_ready: claimed, below askable; probe_pending: doors declared, not yet probed; proof_needed: see challenge; code_sent: call again with the code; member: it is listed through its inbox; refused: see detail.",
  ),
  ...listingAnswerShape,
});
export type RegisterBusinessOutput = z.infer<typeof registerBusinessOutputSchema>;

export const updateBusinessInputSchema = z.object({
  domain: z.string().min(1).max(253),
  claim_token: claimTokenSchema.optional(),
  proof: claimProofSchema.optional(),
  set: z.object(registerFields).partial().optional().describe("Any field register_business takes, but domain."),
  doors: z
    .object({
      add: z.array(declaredDoorSchema).max(10).optional(),
      remove: z.array(z.string().max(2048)).max(10).optional().describe("Door URLs."),
    })
    .optional(),
  listing: z.enum(["on", "off"]).optional().describe("off hides it from search and keeps it in the index."),
  opt_out: z
    .object({
      scopes: z
        .array(z.enum(["list", "crawl", "all"]))
        .min(1)
        .max(3),
    })
    .optional()
    .describe(
      "Stops the listing (list), the crawl (crawl) or both (all). Without a claim token or a proof it removes an entry the network found that nobody claimed, and never a claimed or registered listing, which needs its claim_token or a proof as strong as its claim. A business that opted out comes back with a domain or key proof.",
    ),
});
export type UpdateBusinessInput = z.infer<typeof updateBusinessInputSchema>;

export const updateBusinessOutputSchema = z.object({
  status: z
    .enum([...registerStatusSchema.options, "off", "removed"])
    .describe("As register_business's, and: off, hidden from search; removed, after an opt-out."),
  ...listingAnswerShape,
});
export type UpdateBusinessOutput = z.infer<typeof updateBusinessOutputSchema>;
