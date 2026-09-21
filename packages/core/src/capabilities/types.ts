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
});

export const createBookingInput = z.object({
  payload: bookingPayloadSchema.omit({ proposed: true }),
  contact: contactSchema.optional(),
  message: z.string().max(20_000).optional(),
  idempotency_key: idempotencyKey,
});

export const createOrderInput = z.object({
  payload: orderPayloadSchema.omit({ paymentRef: true, paymentUrl: true }),
  contact: contactSchema.optional(),
  message: z.string().max(20_000).optional(),
  idempotency_key: idempotencyKey,
});

export const getItemStatusInput = z.object({ item_id: z.string().min(1), access_token: accessToken });

export const cancelItemInput = z.object({
  item_id: z.string().min(1),
  reason: z.string().max(2_000).optional(),
  access_token: accessToken,
  idempotency_key: idempotencyKey,
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
});

export const acknowledgeReceiptInput = z.object({
  item_id: z.string().min(1),
  receipt: z.string().min(1).describe("The compact JWS the instance returned."),
  counter_signature: z.string().min(1).describe("A compact JWS by the customer's agent over the receipt hash."),
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
  doc: z.record(z.string(), z.unknown()),
  expected_version: z.number().int().min(1).optional(),
});

export type ListServicesInput = z.infer<typeof listServicesInput>;
export type ListProductsInput = z.infer<typeof listProductsInput>;
export type CheckAvailabilityInput = z.infer<typeof checkAvailabilityInput>;
export type RequestQuoteInput = z.infer<typeof requestQuoteInput>;
export type CreateBookingInput = z.infer<typeof createBookingInput>;
export type CreateOrderInput = z.infer<typeof createOrderInput>;
export type GetItemStatusInput = z.infer<typeof getItemStatusInput>;
export type CancelItemInput = z.infer<typeof cancelItemInput>;
export type SendMessageInput = z.infer<typeof sendMessageInput>;
export type ListItemsInput = z.infer<typeof listItemsInput>;
export type GetItemInput = z.infer<typeof getItemInput>;
export type TransitionItemInput = z.infer<typeof transitionItemInput>;
export type ReplyInput = z.infer<typeof replyInput>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsInput>;

export { messagePayloadSchema };
