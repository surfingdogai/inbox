import { z } from "zod";
import {
  bookingPayloadSchema,
  contactSchema,
  isoDateTime,
  itemTypeSchema,
  messagePayloadSchema,
  moneySchema,
  orderLineSchema,
  orderPayloadSchema,
  quoteRequestPayloadSchema,
  returnLinesSchema,
  returnReasonSchema,
} from "../domain/types";
import { reasonCodeSchema } from "../machine/tables";

/**
 * Inputs of the capability set. Every door (REST, MCP, A2A, …) validates against these, so an
 * agent gets the same field-level error whichever way it comes in. Top-level API fields are
 * snake_case; payload objects keep their schema.org camelCase names.
 */
const accessToken = z
  .string()
  .min(16)
  .max(200)
  .optional()
  .describe("Capability secret returned when the item was created without an account.");
const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe("Same key + same request = same answer. Required for agents.");
const paging = { cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(50) };

/**
 * What an agent carries for its person (ADR-017 §2, §8.4): passes, at most eight, space-separated,
 * each at most 200 characters (the `Sdi-Pass` header works the same way, and a GET reads only the
 * header). Presented to the network that issued each one; never stored, never hashed with the request.
 */
const pass = z
  .string()
  .max(8 * 201)
  .optional()
  .describe(
    "The person's passes (sdpass1_…), space-separated, at most 8: presented to the network that issued each, so the business recognises the customer. Or send them in the Sdi-Pass header. Never stored.",
  );
const key = z
  .string()
  .max(200)
  .optional()
  .describe(
    "The person's key (sdkey1_…), if that is all you have: it is exchanged once for a pass, which comes back in identity.passes — keep the pass and send it next time instead. Never stored.",
  );
const carried = { pass, key };

export const listServicesInput = z.object(paging);
export const listProductsInput = z.object({ ...paging, q: z.string().max(100).optional() });

export const checkAvailabilityInput = z.object({
  service_id: z.string().min(1),
  from: isoDateTime.describe("Start of the window to search, ISO 8601."),
  to: isoDateTime.describe("End of the window, at most 14 days after from."),
  party_size: z.number().int().min(1).max(1000).optional(),
});

export const requestQuoteInput = z.object({
  payload: quoteRequestPayloadSchema.omit({ quote: true, offer: true }),
  contact: contactSchema.optional(),
  message: z.string().max(20_000).optional(),
  idempotency_key: idempotencyKey,
  ...carried,
});

/**
 * The customer's side of a booking or an order: the business's own fields (a proposal, a payment
 * reference, the price a request stated, ADR-018 §3.2) are not the customer's to send.
 */
/**
 * The confirm step before a priced request binds a consumer (ADR-018 §5; CRD art. 8(2)): the
 * fingerprint of the terms they said yes to, from the `409 confirm_terms` a request without it gets.
 */
const confirmedTerms = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .optional()
  .describe(
    "The fingerprint of the terms your person confirmed (details.terms_sha of the 409 confirm_terms a priced request without it gets). Nothing is sent to the business without it when the request carries a price.",
  );

export const createBookingInput = z.object({
  payload: bookingPayloadSchema.omit({
    proposed: true,
    customerStatedPrice: true,
    offer: true,
    change: true,
    paymentRef: true,
    paidAmount: true,
  }),
  contact: contactSchema.optional(),
  message: z.string().max(20_000).optional(),
  terms_sha: confirmedTerms,
  idempotency_key: idempotencyKey,
  ...carried,
});

export const createOrderInput = z.object({
  payload: orderPayloadSchema
    .omit({
      paymentRef: true,
      paymentUrl: true,
      paidAmount: true,
      customerStatedPrice: true,
      proposed: true,
      offer: true,
      change: true,
      fulfilledAt: true,
      deliveredAt: true,
    })
    .extend({
      orderedItem: z
        .array(orderLineSchema.omit({ customerStatedPrice: true }))
        .min(1)
        .max(200),
    }),
  contact: contactSchema.optional(),
  message: z.string().max(20_000).optional(),
  terms_sha: confirmedTerms,
  idempotency_key: idempotencyKey,
  ...carried,
});

export const getItemStatusInput = z.object({ item_id: z.string().min(1), access_token: accessToken, ...carried });

export const cancelItemInput = z.object({
  item_id: z.string().min(1),
  reason: z.string().max(2_000).optional(),
  access_token: accessToken,
  idempotency_key: idempotencyKey,
  ...carried,
});

export const sendMessageInput = z.object({
  item_id: z.string().min(1).optional().describe("Reply on an existing item; omit to start a new conversation."),
  subject: z.string().max(500).optional(),
  body: z.string().min(1).max(20_000),
  contact: contactSchema.optional(),
  /** Dedupe key of the underlying message, e.g. an email Message-ID. */
  message_id: z.string().min(1).max(998).optional(),
  access_token: accessToken,
  idempotency_key: idempotencyKey,
  ...carried,
});

export const acknowledgeReceiptInput = z.object({
  item_id: z.string().min(1),
  counter_signature: z
    .string()
    .min(1)
    .max(8_192)
    .optional()
    .describe(
      'A compact JWS by the customer\'s agent, EdDSA, header carrying its Ed25519 public `jwk`, payload `{"rcp": "<receipt id>", "sha": "<base64url(SHA-256(receipt JWS))>", "iat": <unix seconds>}`. Or, for an agent that signs its requests instead (sdi-agent/1) and carries a pass reference, `receipt_id` alone.',
    ),
  receipt_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "The receipt to acknowledge, for an agent that signs this request (sdi-agent/1) with a key delegated to the pass reference it sends: the inbox forwards the signature to the network (ADR-017 §3.4). Send this or counter_signature.",
    ),
  receipt: z
    .string()
    .min(1)
    .max(8_192)
    .optional()
    .describe("The receipt JWS being acknowledged, if you want the instance to check it is the one it holds."),
  access_token: accessToken,
  ...carried,
});

/**
 * ADR-017 §8.2: proves the customer is one the business already knows. Without `code`, six digits
 * are emailed to the address the business has for them; with it, the code is checked.
 */
export const verifyCustomerInput = z.object({
  item_id: z.string().min(1),
  access_token: accessToken,
  code: z
    .string()
    .regex(/^[0-9]{6}$/)
    .optional()
    .describe("The six digits the customer received. Omit to have them sent."),
});

/**
 * ADR-018 §5–6: the customer answers what the business put to them — another time for a booking, or
 * a quote. Accepting binds the customer, so it takes the confirm step: the `terms_sha` of the terms
 * they said yes to, from `offer.terms_sha` in the item's status. Without it nothing is written and
 * the answer carries the terms to show them.
 */
/** The offer an answer is for, so an answer to one the business has since replaced does nothing. */
const offerId = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe(
    "The offer you answer: offer.id from get_item_status. If the business has replaced it since, nothing is done (409 offer_changed, with the current one).",
  );

export const acceptOfferInput = z.object({
  item_id: z.string().min(1),
  offer_id: offerId,
  terms_sha: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional()
    .describe(
      "The fingerprint of the terms your person said yes to: offer.terms_sha from get_item_status. Leave it out to be told the terms first; nothing is booked without it.",
    ),
  access_token: accessToken,
  idempotency_key: idempotencyKey,
  ...carried,
});

export const declineOfferInput = z.object({
  item_id: z.string().min(1),
  offer_id: offerId,
  reason: z.string().max(2_000).optional().describe("Anything your person wants the business to know."),
  reason_code: reasonCodeSchema.optional(),
  access_token: accessToken,
  idempotency_key: idempotencyKey,
  ...carried,
});

export const suggestTimeInput = z.object({
  item_id: z.string().min(1),
  start_time: isoDateTime.describe(
    "The start your person would like instead: one of the free times check_availability lists. The end follows the service's length.",
  ),
  note: z.string().max(2_000).optional(),
  access_token: accessToken,
  idempotency_key: idempotencyKey,
  ...carried,
});

/**
 * The customer's own terms in answer to what the business proposed (ADR-018 §2, §6): only what they
 * would change. Time, quantities and delivery come back to the business as their request; a price of
 * their own, or a change past the last round, goes to a person there as their message, never refused.
 */
export const makeOfferInput = z.object({
  item_id: z.string().min(1),
  offer_id: offerId,
  terms: z
    .object({
      start_time: isoDateTime
        .optional()
        .describe(
          "Another start: for a booking, one of the free times check_availability lists (the end follows the service's length); for a quote request, the time it is for.",
        ),
      party_size: z.number().int().min(1).max(1_000).optional().describe("Another number of people."),
      quantity: z.number().int().min(1).max(1_000_000).optional().describe("How many, for a quote request."),
      lines: z
        .array(
          z.object({
            index: z.number().int().min(0).max(199),
            quantity: z.number().int().min(0).max(1_000_000),
            unit_price: moneySchema.optional(),
          }),
        )
        .max(200)
        .optional()
        .describe(
          "For changes the business suggested to an order: other quantities for its lines, by index in offer.terms.lines; 0 drops a line. unit_price, a price of your own for a line, only where the business's profile says price_negotiable.",
        ),
      delivery_when: isoDateTime.optional().describe("Another delivery date, for an order."),
      total_price: moneySchema
        .optional()
        .describe(
          "A price of your own for a time the business proposed. Taken as your answer only where the business's profile says price_negotiable; otherwise it goes to a person there as your message, and what it proposed still stands.",
        ),
    })
    .describe("Only what your person would change."),
  note: z.string().max(2_000).optional().describe("Anything your person wants the business to know."),
  reason_code: reasonCodeSchema.optional(),
  access_token: accessToken,
  idempotency_key: idempotencyKey,
  ...carried,
});

export const provideDetailsInput = z.object({
  item_id: z.string().min(1),
  details: z.string().trim().min(1).max(5_000).describe("The answer to what the business asked."),
  access_token: accessToken,
  idempotency_key: idempotencyKey,
  ...carried,
});

/**
 * The customer withdraws from their contract (ADR-018 §7; CRD art. 11a, "Withdraw from contract
 * here"): two steps. Without `confirm_withdrawal`, nothing is sent and the answer is the statement to
 * show them (`409 confirm_withdrawal`); with it, the withdrawal, then an acknowledgement by email.
 */
export const withdrawInput = z.object({
  item_id: z.string().min(1),
  confirm_withdrawal: z
    .boolean()
    .optional()
    .describe(
      "true once your person confirmed the statement you were shown. Left out, nothing is sent: you get the statement.",
    ),
  lines: returnLinesSchema
    .optional()
    .describe(
      "Once the goods reached them: only these lines (by index in the order's orderedItem), and how many of each.",
    ),
  note: z.string().max(2_000).optional().describe("Anything your person wants to tell the business."),
  access_token: accessToken,
  idempotency_key: idempotencyKey,
  ...carried,
});

/** The customer asks to send goods back (ADR-018 §3.4): faulty, not as described, the wrong item, or changed their mind. */
export const requestReturnInput = z.object({
  item_id: z.string().min(1),
  reason: returnReasonSchema,
  lines: returnLinesSchema
    .optional()
    .describe("Which lines of the order (by index in orderedItem), and how many of each; all of them when left out."),
  wants: z
    .enum(["refund", "exchange", "credit"])
    .optional()
    .describe("What your person would like: a refund, an exchange, or credit."),
  note: z.string().max(2_000).optional(),
  access_token: accessToken,
  idempotency_key: idempotencyKey,
  ...carried,
});

// ---- owner -----------------------------------------------------------------

/** A return a customer asked for by email or phone, which the business writes down to answer later. */
export const openReturnInput = z.object({
  item_id: z.string().min(1),
  reason: returnReasonSchema,
  note: z.string().trim().min(1).max(2_000).describe("What the customer asked, in their words: kept for the business."),
  lines: returnLinesSchema.optional(),
  wants: z.enum(["refund", "exchange", "credit"]).optional(),
  entry_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "The customer's message asking for it (an entry of the order's thread, from get_item): the return is judged as of its arrival.",
    ),
  asked_at: isoDateTime
    .optional()
    .describe("When they asked by phone or in person (a person only; default now): the return is judged as of then."),
  written_by: z.enum(["person", "automation"]).optional(),
  idempotency_key: idempotencyKey,
});

export const listItemsInput = z.object({
  type: itemTypeSchema.optional(),
  state: z.string().max(40).optional(),
  needs_human: z.boolean().optional(),
  open_only: z.boolean().default(true).describe("Hide closed items."),
  sandbox: z.boolean().default(false),
  q: z
    .string()
    .max(200)
    .optional()
    .describe("Full-text search over the conversation, or the six-character reference the customer quotes."),
  mail_failed: z
    .boolean()
    .optional()
    .describe(
      "Only items with an email that was not sent: one that failed, or one to the customer never sent (no address, nothing to send from, no mail service, the day's acknowledgements used). A test item's are left out.",
    ),
  ...paging,
});

export const getItemInput = z.object({ item_id: z.string().min(1) });

/**
 * The business's offer on an item (ADR-018 §6), for the event the item's state takes: another time
 * for a booking (`propose`), changes to an order (`propose`), a quote for a quote request (`quote`).
 * `input` is that event's input, as `transition_item` takes it.
 */
export const makeBusinessOfferInput = z.object({
  item_id: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  expected_version: z.number().int().min(1).optional(),
  written_by: z.enum(["person", "automation"]).optional(),
  idempotency_key: idempotencyKey,
});

/**
 * An item's draft (ADR-018 §4): what the owner's AI, a rule or another system would have offered
 * outside the owner's limits. `draft_id` pins the one the owner read, so a newer one is never sent or
 * dropped by mistake.
 */
export const offerDraftInput = z.object({
  item_id: z.string().min(1),
  draft_id: z.string().min(1).max(64).optional().describe("The draft's id, as the item or its offers show it."),
  idempotency_key: idempotencyKey,
});

/**
 * Who wrote what goes to the customer (Tiago, 23 September 2026): anything a person did not type
 * carries one line saying it was sent automatically. `automation` from anyone adds the line;
 * `person` is honoured only from an integration key (a CRM or a helpdesk whose user typed it) — the
 * owner in the app is a person already, and the owner's AI never is.
 */
export const writtenBy = z
  .enum(["person", "automation"])
  .optional()
  .describe(
    "Who wrote the words the customer gets. person: someone typed them (honoured from an integration key; the owner's AI is always automatic); automation: nobody did. An email nobody typed says it was sent automatically.",
  );

export const transitionItemInput = z.object({
  item_id: z.string().min(1),
  event: z.string().min(1).max(60),
  input: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().max(2_000).optional(),
  expected_version: z.number().int().min(1).optional(),
  written_by: writtenBy,
  idempotency_key: idempotencyKey,
});

export const replyInput = z.object({
  item_id: z.string().min(1),
  body: z.string().min(1).max(20_000),
  internal: z.boolean().default(false).describe("A private note for the team instead of a reply to the customer."),
  written_by: writtenBy,
  idempotency_key: idempotencyKey,
});

/** One customer, as the owner names them: the party an item names (`party.id` on the item). */
export const customerInput = z.object({
  party_id: z.string().min(1).max(64).describe("The customer: party.id on any of their items."),
});

export const eraseCustomerInput = customerInput.extend({
  confirm: z
    .string()
    .max(100)
    .optional()
    .describe(
      "The confirm value the answer without it gave (409 confirm_erase, details.confirm), after the owner saw what it erases. Erasing cannot be undone.",
    ),
});

export const updateSettingsInput = z.object({
  doc: z
    .record(z.string(), z.unknown())
    .describe(
      'The changes, merged over the current settings: objects merge key by key, anything you leave out keeps its value, null removes a key (its default applies again), and arrays replace. Networks are a map keyed by https origin, e.g. {"networks": {"https://network.example.com": {"enabled": true}}}: that adds or switches on one network and leaves the others as they are; {"enabled": false} switches one off. At most 8.',
    ),
  expected_version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("The version you read; a write over a newer version is refused instead of overwriting it."),
});

export type ListServicesInput = z.infer<typeof listServicesInput>;
export type ListProductsInput = z.infer<typeof listProductsInput>;
export type CheckAvailabilityInput = z.infer<typeof checkAvailabilityInput>;
export type RequestQuoteInput = z.infer<typeof requestQuoteInput>;
export type CreateBookingInput = z.infer<typeof createBookingInput>;
export type CreateOrderInput = z.infer<typeof createOrderInput>;
export type GetItemStatusInput = z.infer<typeof getItemStatusInput>;
export type AcknowledgeReceiptInput = z.infer<typeof acknowledgeReceiptInput>;
export type CancelItemInput = z.infer<typeof cancelItemInput>;
export type SendMessageInput = z.infer<typeof sendMessageInput>;
export type VerifyCustomerInput = z.infer<typeof verifyCustomerInput>;
export type AcceptOfferInput = z.infer<typeof acceptOfferInput>;
export type DeclineOfferInput = z.infer<typeof declineOfferInput>;
export type SuggestTimeInput = z.infer<typeof suggestTimeInput>;
export type MakeOfferInput = z.infer<typeof makeOfferInput>;
export type ProvideDetailsInput = z.infer<typeof provideDetailsInput>;
export type WithdrawInput = z.infer<typeof withdrawInput>;
export type RequestReturnInput = z.infer<typeof requestReturnInput>;
export type OpenReturnInput = z.infer<typeof openReturnInput>;
export type ListItemsInput = z.infer<typeof listItemsInput>;
export type GetItemInput = z.infer<typeof getItemInput>;
export type MakeBusinessOfferInput = z.infer<typeof makeBusinessOfferInput>;
export type OfferDraftInput = z.infer<typeof offerDraftInput>;
export type TransitionItemInput = z.infer<typeof transitionItemInput>;
export type ReplyInput = z.infer<typeof replyInput>;
export type CustomerInput = z.infer<typeof customerInput>;
export type EraseCustomerInput = z.infer<typeof eraseCustomerInput>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsInput>;

export { messagePayloadSchema };
