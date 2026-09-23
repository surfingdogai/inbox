import { z } from "zod";

/**
 * Domain schemas: the single source of truth for types, validation, JSON Schema (MCP tools) and
 * OpenAPI. Field names follow schema.org where it fits (Reservation, Order, Offer, PostalAddress).
 */
export const itemTypeSchema = z.enum(["message", "quote_request", "booking", "order", "refund"]);
export type ItemType = z.infer<typeof itemTypeSchema>;

export const actorKindSchema = z.enum([
  "customer_agent",
  "customer_human",
  "owner",
  "staff",
  "owner_ai",
  /** A key the owner minted for another system (Zapier, a shop, a till). Acts with the owner's rights; scopes narrow it. */
  "integration",
  "rule",
  "connector",
  "system",
]);
export type ActorKind = z.infer<typeof actorKindSchema>;

export const CUSTOMER_ACTORS: readonly ActorKind[] = ["customer_agent", "customer_human"];
export const BUSINESS_ACTORS: readonly ActorKind[] = ["owner", "staff", "owner_ai", "rule"];

export const channelSchema = z.enum([
  "rest",
  "mcp_public",
  "mcp_owner",
  "a2a",
  "ucp",
  "acp",
  "arp",
  "email",
  "form",
  "owner_ui",
  "action_link",
  "simulator",
  "connector",
  "system",
]);
export type Channel = z.infer<typeof channelSchema>;

export const actorSchema = z.object({
  kind: actorKindSchema,
  id: z.string().min(1).max(200),
  partyId: z.string().optional(),
  channel: channelSchema,
});
export type Actor = z.infer<typeof actorSchema>;

/** Minor units (cents) and an ISO 4217 code. */
export const moneySchema = z.object({ value: z.number().int().min(0), currency: z.string().length(3).toUpperCase() });
export type Money = z.infer<typeof moneySchema>;

export const isoDateTime = z.iso.datetime({ offset: true });

export const contactSchema = z.object({
  name: z.string().max(200).optional(),
  email: z.email().optional(),
  phone: z.string().max(40).optional(),
  locale: z.string().max(12).optional(),
});
export type Contact = z.infer<typeof contactSchema>;

export const postalAddressSchema = z.object({
  streetAddress: z.string().max(200).optional(),
  addressLocality: z.string().max(100).optional(),
  addressRegion: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  addressCountry: z.string().length(2).optional(),
});

export const itemFlagsSchema = z.object({
  needsHuman: z.boolean().default(false),
  sandbox: z.boolean().default(false),
  priority: z.number().int().min(0).max(3).default(0),
});
export type ItemFlags = z.infer<typeof itemFlagsSchema>;

// ---- payloads -------------------------------------------------------------

export const messagePayloadSchema = z.object({
  text: z.string().min(1).max(20_000),
  subject: z.string().max(500).optional(),
  inReplyTo: z.string().optional(),
});

export const quoteLineSchema = z.object({
  name: z.string().max(200),
  quantity: z.number().int().min(1),
  price: moneySchema,
});

export const quoteRequestPayloadSchema = z.object({
  itemOffered: z.object({
    name: z.string().min(1).max(200),
    sku: z.string().max(100).optional(),
    serviceId: z.string().optional(),
    productId: z.string().optional(),
  }),
  quantity: z.number().int().min(1).optional(),
  description: z.string().min(1).max(5_000),
  budget: moneySchema.optional(),
  requestedFor: isoDateTime.optional(),
  deliveryAddress: postalAddressSchema.optional(),
  /** Filled by the business when it quotes. */
  quote: z
    .object({
      totalPrice: moneySchema,
      validThrough: isoDateTime,
      lines: z.array(quoteLineSchema).max(100).default([]),
      notes: z.string().max(2_000).optional(),
      /** What accepting the quote creates. */
      creates: z.enum(["booking", "order"]).default("order"),
      /** For a quote that creates a booking: the time it is for (ADR-018 §3.3). */
      startTime: isoDateTime.optional(),
      endTime: isoDateTime.optional(),
    })
    .optional(),
});

/**
 * A price the customer's request stated where the business has its own (ADR-018 §3.2): kept for the
 * owner to read, never the price, never read by a rule. Only the inbox writes it.
 */
export const customerStatedPriceSchema = moneySchema.describe(
  "The price the customer's request stated, where it differed from the business's own. Never the price: the business sets it.",
);

export const bookingPayloadSchema = z.object({
  reservationFor: z.object({ serviceId: z.string().min(1), name: z.string().min(1).max(200) }),
  startTime: isoDateTime,
  endTime: isoDateTime,
  partySize: z.number().int().min(1).max(1_000).optional(),
  /** A fixed-price service's price is the business's, from its catalogue (ADR-018 §3.1). */
  totalPrice: moneySchema.optional(),
  customerStatedPrice: customerStatedPriceSchema.optional(),
  resourceId: z.string().optional(),
  notes: z.string().max(5_000).optional(),
  /** An alternative offered by the business; accepting it moves it into startTime/endTime. */
  proposed: z.object({ startTime: isoDateTime, endTime: isoDateTime, totalPrice: moneySchema.optional() }).optional(),
});

export const orderLineSchema = z.object({
  productId: z.string().optional(),
  sku: z.string().max(100).optional(),
  name: z.string().min(1).max(200),
  quantity: z.number().int().min(1),
  /** The unit price: the business's, for a line naming a catalogue product by productId or sku (ADR-018 §3.2). */
  price: moneySchema,
  /** The unit price the customer's request stated for this line, where it differed from the business's. */
  customerStatedPrice: customerStatedPriceSchema.optional(),
});

export const orderPayloadSchema = z.object({
  orderedItem: z.array(orderLineSchema).min(1).max(200),
  /** The lines' prices times their quantities, once any line is the business's to price (ADR-018 §3.2). */
  totalPrice: moneySchema,
  customerStatedPrice: customerStatedPriceSchema.optional(),
  billingAddress: postalAddressSchema.optional(),
  shippingAddress: postalAddressSchema.optional(),
  delivery: z.object({ method: z.enum(["pickup", "delivery", "digital"]), when: isoDateTime.optional() }).optional(),
  paymentMethod: z.string().max(60).optional(),
  paymentRef: z.string().max(200).optional(),
  paymentUrl: z.url().optional(),
  notes: z.string().max(5_000).optional(),
});

export const refundPayloadSchema = z.object({
  orderItemId: z.string().min(1),
  amount: moneySchema,
  reason: z.string().min(1).max(2_000),
});

export const payloadSchemas = {
  message: messagePayloadSchema,
  quote_request: quoteRequestPayloadSchema,
  booking: bookingPayloadSchema,
  order: orderPayloadSchema,
  refund: refundPayloadSchema,
} as const satisfies Record<ItemType, z.ZodType>;

export type PayloadOf<T extends ItemType> = z.infer<(typeof payloadSchemas)[T]>;

// ---- the item envelope ----------------------------------------------------

export const envelopeSchema = z.object({
  id: z.string(),
  type: itemTypeSchema,
  state: z.string(),
  version: z.number().int().min(1),
  partyId: z.string(),
  locationId: z.string().nullable(),
  channel: channelSchema,
  subject: z.string().nullable(),
  flags: itemFlagsSchema,
  linkedItemId: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  closedAt: isoDateTime.nullable(),
});
export type Envelope = z.infer<typeof envelopeSchema>;

export const itemSchema = z.discriminatedUnion("type", [
  envelopeSchema.extend({ type: z.literal("message"), payload: messagePayloadSchema }),
  envelopeSchema.extend({ type: z.literal("quote_request"), payload: quoteRequestPayloadSchema }),
  envelopeSchema.extend({ type: z.literal("booking"), payload: bookingPayloadSchema }),
  envelopeSchema.extend({ type: z.literal("order"), payload: orderPayloadSchema }),
  envelopeSchema.extend({ type: z.literal("refund"), payload: refundPayloadSchema }),
]);
export type Item = z.infer<typeof itemSchema>;
export type ItemOf<T extends ItemType> = Extract<Item, { type: T }>;

/** JSON-pointer-ish paths holding personal data, rewritten on erasure (GDPR). */
export const PII_PATHS: Record<ItemType, readonly string[]> = {
  message: ["text", "subject"],
  quote_request: ["description", "deliveryAddress"],
  booking: ["notes"],
  order: ["billingAddress", "shippingAddress", "notes"],
  refund: ["reason"],
};
