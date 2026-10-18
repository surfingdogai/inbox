import { z } from "zod";
import { timestampSchema } from "./common";

/**
 * Carried requests (ADR-020, `docs/protocol/network.md` §4.16): a network may carry an assistant's
 * question, request for a quote or request for a booking to a business's own inbox, through the
 * inbox's public API, when the inbox allows it (its manifest's `carried_requests`, on unless the
 * owner switched it off). The network keeps only a record that it was delivered: when, to which
 * business, and the outcome. Nothing anyone wrote, and nothing about the person.
 *
 * The person's contact is an email address they agreed to give the business, never a phone
 * number. The answer is the inbox's own: its item, its words, and the access token it hands an
 * anonymous creator.
 */

/** A domain as search_businesses and get_business give it. */
const domainArg = z
  .string()
  .min(1)
  .max(253)
  .describe("The business's domain, as search_businesses or get_business gave it, like bikes.example.");

/** An email address, as a person types it: one @, a dot after it, no spaces. */
export const CARRY_EMAIL_PATTERN = '^[^\\s@<>()\\[\\],;:"]{1,64}@[^\\s@<>()\\[\\],;:"]+\\.[^\\s@<>()\\[\\],;:"]{2,}$';

/** Where the business answers: an email address the person agreed to give it. Never a phone number. */
export const carryContactSchema = z
  .strictObject({
    email: z
      .string()
      .max(254)
      .regex(new RegExp(CARRY_EMAIL_PATTERN))
      .describe("Your person's email address, which they agreed to give this business for its answer."),
    name: z.string().min(1).max(100).optional().describe("The name your person wants the business to use."),
  })
  .describe("Where the business answers. Only an email address and a name: never a phone number.");

const consentArg = z
  .literal(true)
  .describe(
    "true only when your person agreed to give this business their email address for its answer. Without it nothing is sent.",
  );

const languageArg = z
  .string()
  .max(12)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
  .optional()
  .describe("The language your person wants the answer in, as a tag like en, pt or pt-BR.");

/** `ask_business`: a question for a business, carried to its own inbox as a message. */
export const askBusinessInputSchema = z.object({
  domain: domainArg,
  message: z.string().min(1).max(4000).describe("What your person wants to ask, in their words."),
  subject: z.string().min(1).max(150).optional().describe("A few words the business sees first."),
  contact: carryContactSchema,
  consent: consentArg,
  language: languageArg,
});
export type AskBusinessInput = z.infer<typeof askBusinessInputSchema>;

/** `request_quote`: a request for a price, carried to the business's own inbox. */
export const requestQuoteInputSchema = z.object({
  domain: domainArg,
  what: z.string().min(1).max(200).describe("What the quote is for, in a few words: Wheel rebuild, Kitchen tiling."),
  details: z.string().min(1).max(4000).describe("What the business needs to know to give a price."),
  quantity: z.int().min(1).max(100000).optional().describe("How many, when it is a number of things."),
  needed_by: z.iso.date().optional().describe("The date your person needs it by, as YYYY-MM-DD."),
  contact: carryContactSchema,
  consent: consentArg,
  language: languageArg,
});
export type RequestQuoteInput = z.infer<typeof requestQuoteInputSchema>;

/**
 * `request_booking`: without `start`, the business's free times for a service (nothing is sent);
 * with it, a request for that time, carried to the business's own inbox. A priced service asks the
 * person to confirm its terms first: the answer gives them (`confirm`), and the same call again with
 * `terms_sha` sends the request.
 */
export const requestBookingInputSchema = z.object({
  domain: domainArg,
  service: z
    .string()
    .min(1)
    .max(200)
    .describe("The service's name, as get_business lists it, or its id from this tool's answer."),
  start: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("When your person wants it to start, from this tool's free times. Leave it out to see them first."),
  from: z.iso.date().optional().describe("Without start: the first day to show free times for (today when left out)."),
  party_size: z.int().min(1).max(50).optional().describe("How many people it is for, when that matters."),
  notes: z.string().min(1).max(2000).optional().describe("Anything the business should know."),
  terms_sha: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional()
    .describe("The confirm.terms_sha of the last answer, sent only after your person said yes to its summary."),
  contact: carryContactSchema.optional().describe("Needed with start: where the business answers."),
  consent: z
    .literal(true)
    .optional()
    .describe("Needed with start: true only when your person agreed to give this business their email address."),
  language: languageArg,
});
export type RequestBookingInput = z.infer<typeof requestBookingInputSchema>;

/** What became of one carried request (§4.16). */
export const carryOutcomeSchema = z
  .enum([
    "delivered",
    "confirm",
    "times",
    "not_free",
    "refused",
    "busy",
    "failed",
    "switched_off",
    "no_inbox",
    "not_taken",
    "elsewhere",
  ])
  .describe(
    "delivered: in the business's inbox. confirm: nothing sent yet, the terms are for your person to confirm. times: the free times, nothing sent. not_free: that time is not free, nothing sent. refused: the inbox refused it (its words say why). busy: the inbox asked for a pause. failed: the inbox could not be reached. switched_off: the business does not take requests carried by a network. no_inbox: the business has no inbox to carry it to. not_taken: its inbox does not take this kind of request. elsewhere: it takes this kind somewhere else.",
  );
export type CarryOutcome = z.infer<typeof carryOutcomeSchema>;

const carryTimeSchema = z.object({ start: timestampSchema, end: timestampSchema });

/** The same answer for the three tools: what became of the request, and the inbox's own answer. */
export const carryOutputSchema = z.object({
  outcome: carryOutcomeSchema,
  delivered: z.boolean().describe("Whether the request is in the business's inbox now."),
  business: z.string().describe("The business's domain."),
  inbox: z.url().optional().describe("The business's own inbox, where the request went."),
  item: z
    .object({
      id: z.string(),
      type: z.enum(["message", "quote_request", "booking"]),
      state: z.string(),
    })
    .optional()
    .describe("The request as the inbox keeps it."),
  status_url: z.url().optional().describe("Where its state can be read, with access_token."),
  access_token: z
    .string()
    .optional()
    .describe("The inbox gives it once, to read or cancel this request at status_url: keep it for your person only."),
  access_token_withheld: z
    .literal(true)
    .optional()
    .describe("A repeat of a request already delivered: the inbox gives the access token only the first time."),
  replayed: z.boolean().optional().describe("The same request again: the inbox answered as it did the first time."),
  answer: z
    .string()
    .optional()
    .describe("The business's own words about the request, from its inbox: tell your person as they are."),
  confirm: z
    .object({
      summary: z.string().describe("The terms in the business's words: show your person this, as it is."),
      terms_sha: z.string().describe("Send it back as terms_sha only after your person said yes."),
      obligation_to_pay: z.boolean(),
    })
    .optional(),
  service: z
    .object({ id: z.string(), name: z.string(), duration_min: z.int() })
    .optional()
    .describe("The service a booking is for."),
  services: z
    .array(z.string())
    .optional()
    .describe("The services the business books, when service named none of them."),
  times: z.array(carryTimeSchema).max(24).optional().describe("Free times, in UTC; timezone says the business's own."),
  timezone: z.string().optional().describe("The business's time zone."),
  elsewhere: z.url().optional().describe("Where the business takes this kind of request instead."),
  kept: z.string().describe("What this network keeps of the request."),
});
export type CarryOutput = z.infer<typeof carryOutputSchema>;

/**
 * What a signed ping's `200` says of the requests the network carried to this inbox, and tried to
 * (§4.16): counts only, for the business itself, over the last 30 days.
 */
export const pingCarriedSchema = z.object({
  since: timestampSchema.describe("The start of the 30 days the counts cover."),
  delivered: z.int().min(0).describe("Requests in the inbox."),
  confirm: z.int().min(0).describe("Bookings shown to a person to confirm, not sent yet."),
  not_delivered: z
    .record(z.string().max(40), z.int().min(0))
    .describe(
      "Requests assistants tried to send that did not arrive, by outcome: switched_off, failed, busy, refused…",
    ),
});
export type PingCarried = z.infer<typeof pingCarriedSchema>;
