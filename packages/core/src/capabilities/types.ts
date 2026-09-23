import { z } from "zod";
import {
  bookingPayloadSchema,
  contactSchema,
  isoDateTime,
  itemTypeSchema,
  messagePayloadSchema,
  orderLineSchema,
  orderPayloadSchema,
  quoteRequestPayloadSchema,
} from "../domain/types";

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
  payload: quoteRequestPayloadSchema.omit({ quote: true }),
  contact: contactSchema.optional(),
  message: z.string().max(20_000).optional(),
  idempotency_key: idempotencyKey,
  ...carried,
});

/**
 * The customer's side of a booking or an order: the business's own fields (a proposal, a payment
 * reference, the price a request stated, ADR-018 §3.2) are not the customer's to send.
 */
export const createBookingInput = z.object({
  payload: bookingPayloadSchema.omit({ proposed: true, customerStatedPrice: true }),
  contact: contactSchema.optional(),
  message: z.string().max(20_000).optional(),
  idempotency_key: idempotencyKey,
  ...carried,
});

export const createOrderInput = z.object({
  payload: orderPayloadSchema.omit({ paymentRef: true, paymentUrl: true, customerStatedPrice: true }).extend({
    orderedItem: z
      .array(orderLineSchema.omit({ customerStatedPrice: true }))
      .min(1)
      .max(200),
  }),
  contact: contactSchema.optional(),
  message: z.string().max(20_000).optional(),
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
export const acceptOfferInput = z.object({
  item_id: z.string().min(1),
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
  reason: z.string().max(2_000).optional().describe("Anything your person wants the business to know."),
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

export const provideDetailsInput = z.object({
  item_id: z.string().min(1),
  details: z.string().trim().min(1).max(5_000).describe("The answer to what the business asked."),
  access_token: accessToken,
  idempotency_key: idempotencyKey,
  ...carried,
});

// ---- owner -----------------------------------------------------------------

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
export type ProvideDetailsInput = z.infer<typeof provideDetailsInput>;
export type ListItemsInput = z.infer<typeof listItemsInput>;
export type GetItemInput = z.infer<typeof getItemInput>;
export type TransitionItemInput = z.infer<typeof transitionItemInput>;
export type ReplyInput = z.infer<typeof replyInput>;
export type CustomerInput = z.infer<typeof customerInput>;
export type EraseCustomerInput = z.infer<typeof eraseCustomerInput>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsInput>;

export { messagePayloadSchema };
