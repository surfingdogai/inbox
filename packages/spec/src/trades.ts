import { z } from "zod";
import { moneySchema } from "./base";
import { paymentScheduleSchema } from "./schedule";

/**
 * Trades and projects (spec 0.11, ADR-034): files on a request, where a business works, and the job
 * a request for a price describes.
 *
 * - **Files.** A request may carry photos and plans: JPEG, PNG, WebP or PDF, told apart by their first
 *   bytes and never by the type a sender declares. An item names each by an `attachmentRefSchema`; the
 *   file itself never leaves the business's inbox, and nobody but the business sees it.
 * - **Area.** A business says where it goes as a radius, as postal-code prefixes, or anywhere. What it
 *   publishes (`areaSummarySchema`) is the radius in kilometres or the prefixes, never the place the
 *   radius is measured from: a tradesperson's base is often their home. The inbox writes what it
 *   could tell of a request's site (`areaCheckSchema`) as a band of kilometres, never a distance.
 * - **Job.** A request for a price says how urgent it is, whether a visit comes first, the site and a
 *   few windows that suit, and a budget range (`jobSchema`). A quote says whether it is an estimate or
 *   fixed, how it is paid in stages (the 0.10 payment schedule, adding up to the total), any call-out
 *   or visit fee and whether accepting credits it, and whether tax is included (`tradeQuoteSchema`).
 */

/* --- files ------------------------------------------------------------------ */

/** The kinds of file a request may carry, as their first bytes show them. */
export const ATTACHMENT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

/**
 * How many files and how large (est.; ADR-034 §2): at most six on a request, each up to 10 MB; over
 * MCP up to 4 MB each sent inline and 8 MB in one call (larger ones by address, or uploaded first);
 * an upload is kept for an hour for a request to name.
 *
 * Files no request has taken yet have an allowance of their own, apart from the files requests took:
 * 60 MB in one inbox, and 30 MB from one sender's address. Anyone may upload, so without it one address
 * could fill an inbox with uploads it never names and turn away real customers' photos for the hour.
 */
export const ATTACHMENT_LIMITS = {
  perRequest: 6,
  maxBytes: 10 * 1024 * 1024,
  inlineBytes: 4 * 1024 * 1024,
  inlinePerCall: 8 * 1024 * 1024,
  uploadTtlMs: 60 * 60_000,
  waitingBytes: 60 * 1024 * 1024,
  waitingPerSender: 30 * 1024 * 1024,
} as const;

/** A file as an item names it. Written by the inbox once it checked and cleaned the file. */
export const attachmentRefSchema = z.object({
  id: z
    .string()
    .regex(/^att_[A-Za-z0-9_-]{16,48}$/)
    .describe("The inbox's own id for the file."),
  name: z.string().min(1).max(200).describe("The file's name, as it was sent, cleaned."),
  content_type: z.enum(ATTACHMENT_TYPES).describe("What the file's first bytes show it is."),
  size: z.number().int().min(1).max(ATTACHMENT_LIMITS.maxBytes).describe("Its size in bytes, once cleaned."),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe("SHA-256 of the bytes as kept, in hex."),
});
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

/* --- area ------------------------------------------------------------------- */

export const areaModeSchema = z.enum(["radius", "postal", "anywhere"]);
export type AreaMode = z.infer<typeof areaModeSchema>;

/** A postal-code prefix in one country: `{country: "KE", prefix: "00100"}`, `{country: "DE", prefix: "04"}`. */
export const postalPrefixSchema = z.object({
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .describe("ISO 3166-1 alpha-2, in capitals."),
  prefix: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Z0-9]+$/)
    .describe("The start of the postal code, in capitals, with no spaces or dashes."),
});
export type PostalPrefix = z.infer<typeof postalPrefixSchema>;

/** The bands a distance is told in: within 5, 10, 25 or 50 km. Never the distance itself. */
export const AREA_BANDS_KM = [5, 10, 25, 50] as const;

/**
 * Where a business works, as it says so in public: a radius in kilometres or postal prefixes, and what
 * happens to a request from outside. Never the place a radius is measured from.
 */
export const areaSummarySchema = z.object({
  mode: areaModeSchema,
  radius_km: z.number().int().min(1).max(1000).optional().describe("For radius: how far the business goes."),
  postal: z.array(postalPrefixSchema).max(100).optional().describe("For postal: the prefixes it covers."),
  outside: z
    .enum(["decline", "on_request"])
    .describe("A request from outside: declined, or taken for the business to decide."),
});
export type AreaSummary = z.infer<typeof areaSummarySchema>;

/**
 * What the inbox could tell of a request's site against the business's area: inside, outside or
 * unknown (no postal code it could read, no point for a radius), and for a radius the band it fell
 * in. Written by the inbox only.
 */
export const areaCheckSchema = z.object({
  status: z.enum(["inside", "outside", "unknown"]),
  by: areaModeSchema,
  within_km: z
    .union([z.literal(5), z.literal(10), z.literal(25), z.literal(50)])
    .optional()
    .describe("For a radius: the smallest band the site falls in, when it is inside 50 km."),
});
export type AreaCheck = z.infer<typeof areaCheckSchema>;

/** `check_area`: a postal code with its country, or a point. */
export const checkAreaInputSchema = z
  .object({
    postal_code: z.string().min(1).max(20).optional().describe("The site's postal code, as written."),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional()
      .describe("The site's country, ISO 3166-1 alpha-2, with a postal code."),
    lat: z.number().min(-90).max(90).optional().describe("The site's latitude, when you have a point."),
    lng: z.number().min(-180).max(180).optional().describe("The site's longitude, with lat."),
  })
  .refine(
    (v) => (v.postal_code !== undefined && v.country !== undefined) || (v.lat !== undefined && v.lng !== undefined),
    { message: "a postal_code with its country, or lat and lng" },
  );
export type CheckAreaInput = z.infer<typeof checkAreaInputSchema>;

/**
 * `check_area`'s answer: `inside`, `outside` (a request from there is declined), or `on_request` (the
 * business decides: outside where it takes those, or not known). Never a yes it cannot stand behind.
 */
export const checkAreaOutputSchema = z.object({
  answer: z.enum(["inside", "outside", "on_request"]),
  within_km: z.union([z.literal(5), z.literal(10), z.literal(25), z.literal(50)]).optional(),
  area: areaSummarySchema,
  words: z.string().max(500).describe("What to tell your person, in the business's words."),
});
export type CheckAreaOutput = z.infer<typeof checkAreaOutputSchema>;

/* --- the job ----------------------------------------------------------------- */

export const jobUrgencySchema = z.enum(["emergency", "within_24h", "this_week", "flexible"]);
export type JobUrgency = z.infer<typeof jobUrgencySchema>;

const isoDateTime = z.iso.datetime({ offset: true });

/** A window that suits the customer for a visit or a start: at most three on a request. */
export const jobWindowSchema = z
  .object({ from: isoDateTime, to: isoDateTime })
  .refine((w) => Date.parse(w.to) > Date.parse(w.from), { message: "a window ends after it starts", path: ["to"] });

const postalAddressSchema = z.object({
  streetAddress: z.string().max(200).optional(),
  addressLocality: z.string().max(100).optional(),
  addressRegion: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  addressCountry: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .optional(),
});

/**
 * Where the work is: its address, the point on a map when the agent has one (for a radius: nothing is
 * geocoded here), how to find the way, and what kind of place it is. Seen by the business only.
 */
export const jobSiteSchema = z.object({
  address: postalAddressSchema.optional(),
  geo: z
    .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
    .optional()
    .describe("The site's point, when you have it: a radius is checked against it."),
  accessNotes: z.string().max(500).optional().describe("Gate codes are never asked for: only how to find the way."),
  propertyType: z.enum(["home", "business", "other"]).optional(),
});

/**
 * What a request for a price says of the job. `areaCheck` and `visitBookingId` are the inbox's (the
 * customer never sends them); `budgetMax` makes the request's `budget` the low end of a range.
 */
export const jobSchema = z.object({
  urgency: jobUrgencySchema.default("flexible"),
  visit: z.enum(["needed", "not_needed", "unsure"]).default("unsure"),
  site: jobSiteSchema.optional(),
  windows: z.array(jobWindowSchema).min(1).max(3).optional(),
  budgetMax: moneySchema.optional(),
  areaCheck: areaCheckSchema.optional(),
  /** The site visit booked for it, when one was. */
  visitBookingId: z.string().min(1).max(64).optional(),
});
export type Job = z.infer<typeof jobSchema>;

/* --- the quote --------------------------------------------------------------- */

/** A call-out or visit fee, and whether it is already taken off the quote's total (else it is paid apart). */
export const tradeFeeSchema = z.object({
  amount: moneySchema,
  creditedIfAccepted: z.boolean().default(false),
});

/**
 * What a trade's quote adds to a quote: an estimate or a fixed price; stages it is paid in (each a
 * payment schedule, adding up to the total; at most four); call-out and visit fees, each already taken
 * off the total or paid apart from it; and whether its prices include tax, with the tax lines when they
 * do not. The quote's total is always what the customer pays, tax included: with prices before tax,
 * its lines and the tax lines together make it.
 */
export const tradeQuoteSchema = z.object({
  kind: z.enum(["estimate", "fixed"]).default("fixed"),
  stages: z.array(paymentScheduleSchema).min(1).max(4).optional(),
  callOutFee: tradeFeeSchema.optional(),
  visitFee: tradeFeeSchema.optional(),
  tax: z
    .object({
      included: z.boolean(),
      lines: z
        .array(z.object({ name: z.string().min(1).max(80), amount: moneySchema }))
        .max(5)
        .optional()
        .describe("When included is false: the tax on top of the prices, at least one line; part of the total."),
    })
    .optional(),
});
export type TradeQuote = z.infer<typeof tradeQuoteSchema>;

/** What kind of work a quote's line is. */
export const quoteLineKindSchema = z.enum(["labour", "materials", "other"]);

/* --- what agents are told of the work ---------------------------------------------- */

/**
 * How a trade takes work, as its public profile says it (`get_business_profile`'s `work`): where it
 * goes, whether it takes emergencies online and when, its call-out fee, and how visits confirm.
 */
export const workProfileSchema = z.object({
  area: areaSummarySchema,
  emergency: z
    .enum(["off", "opening_hours", "always"])
    .describe("Emergency jobs online: not taken, only while open, or at any hour (inside the area)."),
  call_out_fee: z.object({ amount: moneySchema, credited_if_accepted: z.boolean() }).optional(),
  out_of_hours: z
    .object({
      surcharge: z.union([
        z.object({ kind: z.literal("amount"), amount: moneySchema }),
        z.object({ kind: z.literal("percent"), percent: z.number().int().min(1).max(300) }),
      ]),
    })
    .optional()
    .describe("What a visit outside opening hours adds."),
  free_estimates: z.boolean(),
  visits: z
    .enum(["on_request", "set_aside"])
    .describe("set_aside: some visit times confirm at once; the rest are on request."),
});
export type WorkProfile = z.infer<typeof workProfileSchema>;
