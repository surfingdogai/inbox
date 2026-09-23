import { z } from "zod";
import {
  bookingPayloadSchema,
  contactSchema,
  isoDateTime,
  itemTypeSchema,
  messagePayloadSchema,
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

export const createBookingInput = z.object({
  payload: bookingPayloadSchema.omit({ proposed: true }),
  contact: contactSchema.optional(),
  message: z.string().max(20_000).optional(),
  idempotency_key: idempotencyKey,
  ...carried,
});

export const createOrderInput = z.object({
  payload: orderPayloadSchema.omit({ paymentRef: true, paymentUrl: true }),
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

// ---- owner -----------------------------------------------------------------

export const listItemsInput = z.object({
  type: itemTypeSchema.optional(),
  state: z.string().max(40).optional(),
  needs_human: z.boolean().optional(),
  open_only: z.boolean().default(true).describe("Hide closed items."),
  sandbox: z.boolean().default(false),
  q: z.string().max(200).optional().describe("Full-text search over the conversation."),
  ...paging,
});

export const getItemInput = z.object({ item_id: z.string().min(1) });

export const transitionItemInput = z.object({
  item_id: z.string().min(1),
  event: z.string().min(1).max(60),
  input: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().max(2_000).optional(),
  expected_version: z.number().int().min(1).optional(),
  idempotency_key: idempotencyKey,
});

export const replyInput = z.object({
  item_id: z.string().min(1),
  body: z.string().min(1).max(20_000),
  internal: z.boolean().default(false).describe("A private note for the team instead of a reply to the customer."),
  idempotency_key: idempotencyKey,
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
export type ListItemsInput = z.infer<typeof listItemsInput>;
export type GetItemInput = z.infer<typeof getItemInput>;
export type TransitionItemInput = z.infer<typeof transitionItemInput>;
export type ReplyInput = z.infer<typeof replyInput>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsInput>;

export { messagePayloadSchema };
