import { z } from "zod";
import { closureDaysSchema, profileServiceSchema, weeklyHoursSchema } from "../base";
import { reportHintSchema, tierSchema, timestampSchema } from "./common";
import { outcomeCodeSchema } from "./receipts";

/**
 * The public directory (ADR-017 §6, §7.2): listings, their reputation, and the order. Nothing about
 * any customer is ever returned.
 */

/**
 * A listing's reputation, from the last nightly snapshot (present once the ranked order is in force). From rules
 * version 8 (ADR-017 Amendment 4) a record less than a fifth of which is kept outcomes a verified acknowledgement
 * backs (`verified_kept_share` < 0.2) rests on the business's own word and is self-reported: it shows its counts,
 * `kept`, `broken` and `open`, and no `score` and no `customers`, and it is neither ranked nor above `new`.
 */
export const reputationSchema = z.object({
  ranked: z
    .boolean()
    .describe(
      "score ≥ 0.40 (building): sorts before the daily shuffle; from rules version 8 only with verified_kept_share ≥ 0.2, as shown.",
    ),
  score: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Absent from rules version 8 when self_reported: a record that rests on the business's own word alone has no score.",
    ),
  tier: tierSchema,
  kept: z.int().min(0),
  broken: z.int().min(0),
  open: z
    .int()
    .min(0)
    .optional()
    .describe(
      "From rules version 8: its v2 promises still open (issued, not yet closed by an outcome and not unclosed). Never scored.",
    ),
  customers: z
    .int()
    .min(0)
    .optional()
    .describe("Distinct customers (§5.3). From rules version 8 absent when self_reported: the business chooses them."),
  verified_share: z.number().min(0).max(1).describe("The share of weight from verified evidence, reports included."),
  verified_kept_share: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "From rules version 8: the share of weight from kept outcomes a verified acknowledgement backs. Ranked and scored from 0.2, as shown (four decimals).",
    ),
  self_reported: z
    .boolean()
    .optional()
    .describe(
      "From rules version 8, true when the record rests on the business's own word (verified_kept_share below 0.2): not ranked, tier new, no score, no customers, and its counts are the business's own word.",
    ),
  rules: z.int().min(1).describe("The rules version that ordered this listing."),
  rules_url: z.url().optional(),
});
export type Reputation = z.infer<typeof reputationSchema>;

/**
 * A member's track record (§4.3): what its reputation was computed from, in counts and words, from
 * the same nightly snapshot and shown under the same rules. It shows only past a new member's hold
 * (R31) and once `threshold` is met; each state carries only what it can say. From rules version 8
 * (ADR-017 A4.1) a record that rests on the business's own word is `self_reported`, as its
 * reputation is: its counts and no score, and never how many customers, since the business chooses
 * who they are. `confirmed` counts only kept outcomes a verified acknowledgement backs. Never on an
 * entry that is not a member.
 */
export const trackRecordSchema = z
  .object({
    state: z
      .enum(["held", "none", "pending", "gathering", "shown"])
      .describe(
        "held: a new member's 30 days after it joins, when nothing is counted; none: no receipts yet; pending: receipts the next nightly count reaches; gathering: fewer closed promises, or customers, than threshold; shown: the record.",
      ),
    in_words: z
      .string()
      .describe(
        "The record in one or two plain sentences, with how many of its closed promises the customer's side confirmed; the rest are the business's own word.",
      ),
    as_of: timestampSchema.optional().describe("The nightly count it is from (00:00 UTC)."),
    held_until: timestampSchema.optional().describe("held: the night its record is counted from."),
    self_reported: z
      .boolean()
      .optional()
      .describe(
        "gathering and shown, from rules version 8: the record rests on the business's own word (less than a fifth of it is kept outcomes a verified acknowledgement backs, as its reputation's self_reported), so it has no customers, and its threshold none.",
      ),
    closed: z.int().min(0).optional().describe("gathering and shown: kept plus broken."),
    customers: z
      .int()
      .min(0)
      .optional()
      .describe(
        "gathering and shown, unless self_reported: the distinct customers the closed promises came from, as its receipts name them (the customer's mailbox when known, else, before rules version 8, the receipt's sub; from rules version 8 a sub that names no person is never a customer, and every receipt at a business that names nobody is one anonymous customer). Not reputation.customers, which counts only customers this network can tell apart.",
      ),
    kept: z.int().min(0).optional().describe("shown."),
    broken: z
      .int()
      .min(0)
      .optional()
      .describe(
        "shown: closed as not kept by the business or by a customer's report that stands, left open 9 days past due, or a refund paid late.",
      ),
    open: z
      .int()
      .min(0)
      .optional()
      .describe("shown, from rules version 8: its v2 promises still open (reputation.open)."),
    unclosed: z.int().min(0).optional().describe("shown, of broken: left open 9 days past due (promise.unclosed)."),
    refunds_late: z.int().min(0).optional().describe("shown, of broken: refunds paid late (refund.late)."),
    from: timestampSchema
      .optional()
      .describe(
        "shown: the earliest day of the evidence counted, at 00:00 UTC (a day, never the moment of a promise).",
      ),
    to: timestampSchema
      .optional()
      .describe("shown: the latest day of the evidence counted, at 00:00 UTC (a day, never the moment of a promise)."),
    confirmed: z
      .int()
      .min(0)
      .optional()
      .describe(
        "shown: how many of the closed are kept outcomes a verified acknowledgement backs, confirmed by the customer's side (a customer's report is not a confirmation); the rest are the business's own word.",
      ),
    confirmable: z
      .boolean()
      .optional()
      .describe(
        "shown: whether this network can verify any acknowledgement yet (a recognised platform's agent key, or an established person's).",
      ),
    threshold: z
      .object({ closed: z.int().min(1), customers: z.int().min(1).optional() })
      .optional()
      .describe(
        "What a record shows from: closed promises, from customers distinct customers; a self_reported record is not asked for customers, and has none here.",
      ),
    rules_url: z.url().optional(),
  })
  .describe(
    "A member's track record, from the same nightly count as its standing and shown under the same rules: the promises it kept and broke, and when. From rules version 8, one that rests on the business's own word is self_reported: its counts, with no score and no count of customers. Only what its state can say is present; a business that is not a member has none.",
  );
export type TrackRecord = z.infer<typeof trackRecordSchema>;

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

/**
 * The readiness ladder (§4.9), by name. A network never shows a number for a level. `bookable` and `orderable` are one
 * rung: bookable when a door takes bookings, orderable when the doors take orders and no bookings.
 */
export const levelNameSchema = z.enum(["listed", "readable", "askable", "bookable", "orderable", "payable"]);
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
  checked: z
    .object({
      status: z.enum(["answered", "failing", "could_not_check"]),
      at: timestampSchema,
      by: z.literal("network"),
    })
    .optional()
    .describe(
      "A member's inbox door, on its detail: what the network's own reads last found in the past 24 hours (§4.8). answered; failing; could_not_check, the door refused the read (403, 429, a challenge page), so the business's signed ping alone says it answers. Absent when the network made no read.",
    ),
});
export type CardDoor = z.infer<typeof cardDoorSchema>;

/**
 * A door's history (§4.8, ADR-020): what the network's own reads found of one door type at one host of the
 * business, from a line a day it keeps for good. Never anything an agent reported. `checks` only for a door the
 * network reads every day, and only from 14 checked days; below that it is absent, and nothing says why. A network
 * may leave `checks` and `summary` out altogether. `vectors/door-history.json` pins it down.
 */
export const doorHistoryEntrySchema = z.object({
  type: doorTypeSchema,
  host: z.string().describe("The door's host, lower case."),
  first_seen: z.iso
    .date()
    .describe("The first UTC day a read of the network's found a door of this type at this host answering."),
  last_seen: z.iso.date().describe("The last such day."),
  days_seen: z
    .int()
    .min(1)
    .describe(
      "On how many days a read of the network's found it answering: a door read about once a month is seen on few days, and nothing is said of the days between.",
    ),
  current: z.boolean().describe("Whether a door of this type is at this host now (not gone)."),
  checks: z
    .object({
      first_checked: z.iso.date().describe("The first day checked."),
      last_checked: z.iso.date().describe("The last day checked."),
      days: z
        .int()
        .min(1)
        .describe(
          "Days checked: days on which the network's daily read of the door concluded. A read an agent's report or the business asked for is no check.",
        ),
      answered: z
        .int()
        .min(0)
        .describe(
          "Of them, days on which every check answered: one missed check (failed, or blocked while the door is down by the network's reads) makes the day missed, and one refused check (blocked otherwise) makes it refused.",
        ),
      refused: z
        .int()
        .min(0)
        .describe("Of them, days on which a check was refused and none was missed: never answered days."),
      recent: z
        .string()
        .regex(/^[axb.]{90}$/)
        .describe(
          "The last 90 days ending on as_of, oldest first: a every check answered, x one was missed, b one was refused and none missed, . no check that day.",
        ),
    })
    .optional()
    .describe("A door the network reads every day (a member's, a claimed listing's), from 14 checked days."),
  summary: z
    .string()
    .optional()
    .describe(
      'With checks, in English: "Answered every check on 41 of 42 days checked since 3 Oct 2026 (97%).", the share floored, the days refused after it ("(75%; refused our check on 5)"), "from … to …" when the last check is more than 7 days old. Informative: another network may word it its own way.',
    ),
});
export type DoorHistoryEntry = z.infer<typeof doorHistoryEntrySchema>;

export const doorHistorySchema = z
  .object({
    as_of: z.iso.date().describe("The UTC day it was read on."),
    doors: z.array(doorHistoryEntrySchema),
  })
  .describe(
    "What the network's own reads found of the business's doors, kept for good: each door type at each host, the doors there now first, when it was first and last seen answering and on how many days, and for a door read every day, on how many days every check answered. Absent when there is nothing to say.",
  );
export type DoorHistory = z.infer<typeof doorHistorySchema>;

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
    acknowledged: z
      .int()
      .min(0)
      .describe(
        "Promises an acknowledgement came with; from rules version 8, receipts an acknowledgement the network verified backs.",
      ),
    customers: z
      .int()
      .min(0)
      .optional()
      .describe("On the detail: the distinct subs its promises name. From rules version 8 absent when self_reported."),
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
  track_record: trackRecordSchema.optional(),
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
  door_history: doorHistorySchema.optional().describe("The history of the doors this listing shows (§4.8)."),
  report: reportHintSchema.optional(),
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
    .describe(
      "At this level or above; bookable and orderable are one rung, bookable asking for doors that take bookings and orderable for doors that take orders. Below askable nothing is listed yet.",
    ),
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
  report: reportHintSchema.optional(),
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
