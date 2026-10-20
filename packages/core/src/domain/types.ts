import { stayQuoteSchema } from "@surfingdog/spec";
import { z } from "zod";

/**
 * Domain schemas: the single source of truth for types, validation, JSON Schema (MCP tools) and
 * OpenAPI. Field names follow schema.org where it fits (Reservation, Order, Offer, PostalAddress).
 */
export const itemTypeSchema = z.enum(["message", "quote_request", "booking", "order", "refund", "stay"]);
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

/** Minor units of the currency's own ISO 4217 exponent (ADR-032: ¥4500 is 4500, KSh 45 is 4500) and its code. */
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
  /**
   * A network carried it here for a person's AI assistant (ADR-025; `Surfing-Dog-Carried: 1`, network
   * protocol §4.17). Said by whoever sent it, never proved: it only holds the acknowledgement email to
   * one a day per address, so saying it falsely costs nobody anything. Absent on everything else.
   */
  carried: z.boolean().optional(),
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

/**
 * Where the item's negotiation stands (ADR-018 §1): its open offer, else the last one both sides
 * agreed, as the inbox keeps it on the payload so webhooks, rules and screens can read it. Only the
 * inbox writes it; `item_offers` holds the offers themselves.
 */
export const offerPointerSchema = z.object({
  id: z.string().min(1).max(64),
  rev: z.number().int().min(1),
  /** Who made it: the business, or the customer (their request, their counter). */
  by: z.enum(["business", "customer"]),
  /** 1 for the first offer, one more for each answer that is not a yes. */
  round: z.number().int().min(1),
  status: z.enum(["open", "accepted"]),
  /** Until when it can be accepted. */
  validThrough: isoDateTime.optional(),
  /** A time we proposed whose place we hold until the customer answers. */
  held: z.literal(true).optional(),
  /** We may withdraw it before the customer answers (`negotiation.binding` off). */
  binding: z.literal(false).optional(),
});
export type OfferPointer = z.infer<typeof offerPointerSchema>;

/** Who asked for a change to a promise: the business, or the customer. */
export const changeBySchema = z.enum(["business", "customer"]);

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
  offer: offerPointerSchema.optional(),
});

/**
 * A price the customer's request stated where the business has its own (ADR-018 §3.2): kept for the
 * owner to read, never the price, never read by a rule. Only the inbox writes it.
 */
export const customerStatedPriceSchema = moneySchema.describe(
  "The price the customer's request stated, where it differed from the business's own. Never the price: the business sets it.",
);

/**
 * A price the inbox chose for this customer (ADR-018 §4, §5): the owner's reward for their record, a
 * discount the owner let automation give, or their own price automation accepted. It carries the list
 * price beside it, and the notice goes with it wherever the price is shown (CRD art. 6(1)(ea)): the
 * owner's own line for the customer (`says`) after it. A price a person typed carries none. Only the
 * inbox writes it.
 */
export const personalisedSchema = z.object({
  listPrice: moneySchema,
  says: z.string().max(200).optional(),
});
export type Personalised = z.infer<typeof personalisedSchema>;

export const bookingPayloadSchema = z.object({
  reservationFor: z.object({ serviceId: z.string().min(1), name: z.string().min(1).max(200) }),
  startTime: isoDateTime,
  endTime: isoDateTime,
  partySize: z.number().int().min(1).max(1_000).optional(),
  /** A fixed-price service's price is the business's, from its catalogue (ADR-018 §3.1). */
  totalPrice: moneySchema.optional(),
  customerStatedPrice: customerStatedPriceSchema.optional(),
  /** The price is this customer's own (a reward, a discount, their price taken): the notice goes with it. */
  personalised: personalisedSchema.optional(),
  resourceId: z.string().optional(),
  notes: z.string().max(5_000).optional(),
  /**
   * A payment or deposit recorded for the booking (`record_payment`): it gates nothing, but a booking
   * paid at a distance is a contract the customer may withdraw from (ADR-018 §3.1, §7). Only the
   * business writes these.
   */
  paymentRef: z.string().max(200).optional(),
  paidAmount: moneySchema.optional(),
  /** An alternative offered by the business; accepting it moves it into startTime/endTime. */
  proposed: z
    .object({
      startTime: isoDateTime,
      endTime: isoDateTime,
      totalPrice: moneySchema.optional(),
      personalised: personalisedSchema.optional(),
    })
    .optional(),
  /**
   * A change to the confirmed booking that one side asked for and the other has not answered yet
   * (ADR-018 §3.1): the booking as it would be. Accepted, it becomes the booking; declined, withdrawn
   * or lapsed, it goes and the booking stays as it was. Only the inbox writes it.
   */
  change: z
    .object({
      by: changeBySchema,
      startTime: isoDateTime,
      endTime: isoDateTime,
      totalPrice: moneySchema.optional(),
    })
    .optional(),
  offer: offerPointerSchema.optional(),
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
  /** The catalogue's unit price, where this line's is the customer's own (a reward, a discount). Only the inbox writes it. */
  listPrice: moneySchema.optional(),
});

export const orderPayloadSchema = z.object({
  orderedItem: z.array(orderLineSchema).min(1).max(200),
  /** The lines' prices times their quantities, once any line is the business's to price (ADR-018 §3.2). */
  totalPrice: moneySchema,
  customerStatedPrice: customerStatedPriceSchema.optional(),
  /** The total is this customer's own (a reward, a discount, their price taken): the notice goes with it. */
  personalised: personalisedSchema.optional(),
  billingAddress: postalAddressSchema.optional(),
  shippingAddress: postalAddressSchema.optional(),
  delivery: z.object({ method: z.enum(["pickup", "delivery", "digital"]), when: isoDateTime.optional() }).optional(),
  paymentMethod: z.string().max(60).optional(),
  paymentRef: z.string().max(200).optional(),
  /** What the payment recorded came to, when it said (`record_payment`). */
  paidAmount: moneySchema.optional(),
  paymentUrl: z.url().optional(),
  notes: z.string().max(5_000).optional(),
  /** When the business marked it fulfilled (`fulfil`): the goods' withdrawal clock starts from delivery, else from this plus the transit days. */
  fulfilledAt: isoDateTime.optional(),
  /** When the goods reached the customer (`fulfil`, `record_delivery`): the withdrawal period runs from it (ADR-018 §7). */
  deliveredAt: isoDateTime.optional(),
  /**
   * The changes the business suggested (ADR-018 §3.2), while the customer's answer is awaited:
   * the lines as they would be, their total, and when it would be delivered. Accepting moves them
   * into the order.
   */
  proposed: z
    .object({
      orderedItem: z.array(orderLineSchema).min(1).max(200),
      totalPrice: moneySchema,
      delivery: z
        .object({ method: z.enum(["pickup", "delivery", "digital"]), when: isoDateTime.optional() })
        .optional(),
      personalised: personalisedSchema.optional(),
    })
    .optional(),
  /**
   * A change to the accepted order that one side asked for and the other has not answered yet
   * (ADR-018 §3.2): its lines, total and delivery as they would be. Accepted, it becomes the order;
   * otherwise the order stays as it was. Only the inbox writes it.
   */
  change: z
    .object({
      by: changeBySchema,
      orderedItem: z.array(orderLineSchema).min(1).max(200),
      totalPrice: moneySchema,
      delivery: z
        .object({ method: z.enum(["pickup", "delivery", "digital"]), when: isoDateTime.optional() })
        .optional(),
    })
    .optional(),
  offer: offerPointerSchema.optional(),
});

/**
 * What the law lets a product or service be excepted from withdrawal (ADR-018 §7; CRD art. 16, PT
 * DL 24/2014 art. 17): `standard` when the right runs. Read narrowly: preset options are not
 * personalisation, and long-life dry goods are not perishable.
 */
export const withdrawalFlagSchema = z
  .enum([
    "standard",
    "personalised",
    "perishable",
    "sealed_hygiene",
    "sealed_media",
    "mixed",
    "dated_leisure",
    "urgent_repair",
    "digital_started",
    "price_fluctuates",
  ])
  .describe(
    "Whether the customer may withdraw within the legal period: standard, or the exception the law allows (personalised, perishable, sealed_hygiene, sealed_media, mixed, dated_leisure, urgent_repair, digital_started, price_fluctuates).",
  );
export type WithdrawalFlag = z.infer<typeof withdrawalFlagSchema>;

/**
 * What a return or a refund is (ADR-018 §3.4): the customer's withdrawal within the legal period,
 * faulty goods under the legal guarantee, a return under the business's own policy, a paid order the
 * business cancelled, or a change that lowered a paid total.
 */
export const refundKindSchema = z.enum(["withdrawal", "faulty", "policy", "cancellation", "price_adjustment"]);
export type RefundKind = z.infer<typeof refundKindSchema>;

/** Why the customer sends it back. */
export const returnReasonSchema = z
  .enum(["changed_mind", "faulty", "wrong_item", "not_as_described", "other"])
  .describe("Why: changed_mind, faulty, wrong_item, not_as_described or other.");

/** Which lines of the order come back, and how many of each (by index in its orderedItem); none named, all of them. */
export const returnLinesSchema = z
  .array(z.object({ index: z.number().int().min(0).max(199), quantity: z.number().int().min(1).max(1_000_000) }))
  .max(200);

/**
 * A return or a refund (ADR-018 §3.4): what is owed (`amount`), for which order or booking, why,
 * and where it stands — what has to come back and by when, when the goods arrived, and when the
 * refund is due. Every field but the order and the amount is optional, so a refund written before
 * returns were built still reads. Only the inbox writes it.
 */
export const refundPayloadSchema = z.object({
  /** The order, or the booking paid at a distance, it refunds. */
  orderItemId: z.string().min(1),
  /** What we owe the customer. */
  amount: moneySchema,
  reason: z.string().min(1).max(2_000).optional(),
  kind: refundKindSchema.optional(),
  reasonCode: returnReasonSchema.optional(),
  /** Only some of the order's lines. */
  lines: returnLinesSchema.optional(),
  /** What the customer would like instead of their money back. */
  wants: z.enum(["refund", "exchange", "credit"]).optional(),
  /** When the customer told us (the withdrawal's notice, the return's request). */
  noticeAt: isoDateTime.optional(),
  /** Whether goods have to come back before the refund; false: nothing does. */
  goodsBack: z.boolean().optional(),
  /** Until when the customer sends them. */
  returnBy: isoDateTime.optional(),
  /** How to send them back. */
  instructions: z
    .object({
      method: z.enum(["post", "drop_off", "collection"]),
      address: z.string().max(500).optional(),
      note: z.string().max(2_000).optional(),
    })
    .optional(),
  /** When the goods, or proof of sending them, reached us. */
  evidenceAt: isoDateTime.optional(),
  /** When the refund is due: fixed once nothing more has to come back (ADR-018 §8). */
  refundDue: isoDateTime.optional(),
  /** The goods that came back are not what was sold: the refund waits while a person sorts it out. */
  disputed: z.object({ note: z.string().min(1).max(2_000), at: isoDateTime }).optional(),
  paymentRef: z.string().max(200).optional(),
  /** What was refunded, when it was. */
  paidAmount: moneySchema.optional(),
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");

/** One room of a stay: which, for how many, and what extras (ADR-033). */
export const stayRoomSchema = z.object({
  /** Absent: "any room for two", the property picks in its quote. */
  roomTypeId: z.string().max(64).optional(),
  roomTypeName: z.string().max(120).default(""),
  ratePlanId: z.string().max(64).optional(),
  ratePlanName: z.string().max(80).optional(),
  adults: z.number().int().min(1).max(20),
  childrenAges: z.array(z.number().int().min(0).max(17)).max(10).default([]),
  extras: z
    .array(z.object({ extraId: z.string().min(1).max(64), quantity: z.number().int().min(1).max(20) }))
    .max(10)
    .default([]),
});

/** One entry of a stay's payment schedule, as it stands: due, paid, at the property, waived, or owed back. */
export const stayPaymentSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(["immediate", "deferred", "at_property"]),
  amount: moneySchema,
  dueAt: isoDateTime.optional(),
  status: z.enum(["due", "paid", "at_property", "waived", "refund_owed"]),
  paymentUrl: z.url().optional(),
  paidAmount: moneySchema.optional(),
  paymentRef: z.string().max(200).optional(),
});

/**
 * A stay (ADR-033): local dates (nights are their difference, never minutes), rooms as lines, the
 * property's binding quote with its breakdown, schedule and dated policy, and where it stands with the
 * property's own system. `startTime`, `endTime` and `totalPrice` are written by the inbox, so the
 * generated columns, the indexes and the auto-complete sweep work as for a booking. Only the property
 * writes `quote`, `payments`, `cancellation` and `external`.
 */
export const stayPayloadSchema = z.object({
  propertyId: z.string().min(1).max(64),
  checkIn: z.iso.date(),
  checkOut: z.iso.date(),
  /** Check-in date at the property's check-in time, check-out at its check-out time, with the zone's offset. */
  startTime: isoDateTime.optional(),
  endTime: isoDateTime.optional(),
  /** The guest's expected arrival window. */
  arrival: z.object({ from: hhmm, to: hhmm }).optional(),
  rooms: z.array(stayRoomSchema).min(1).max(9),
  guests: z
    .object({
      lead: z.object({ name: z.string().max(200) }),
      others: z
        .array(z.object({ name: z.string().max(200) }))
        .max(40)
        .default([]),
    })
    .optional(),
  /** Special requests, in the guest's own words. */
  requests: z.string().max(2_000).optional(),
  /** The offer in force: only the property writes it. */
  quote: stayQuoteSchema.optional(),
  /** What the rates gave before a quote: never binding, never shown as an offer. */
  estimate: stayQuoteSchema.optional(),
  /** = quote.total, for `amount_minor`. */
  totalPrice: moneySchema.optional(),
  /** A hold on the nights, until when, and on what (rooms kept for direct guests, or the connected system). */
  hold: z.object({ until: isoDateTime, source: z.enum(["allotment", "connected"]) }).optional(),
  payments: z
    .object({
      schedules: z.array(stayPaymentSchema).max(6).default([]),
      /** Until when what is due now (a deposit, a card to hold the stay) can be paid: the pay window. */
      dueBy: isoDateTime.optional(),
      guarantee: z
        .object({ status: z.enum(["none", "requested", "saved"]), url: z.url().optional() })
        .prefault({ status: "none" }),
    })
    .optional(),
  cancellation: z
    .object({
      at: isoDateTime,
      fee: moneySchema,
      refundOwed: moneySchema.optional(),
      by: z.enum(["guest", "property"]),
    })
    .optional(),
  /** Where availability came from when the stay was answered. */
  availability: z
    .object({ source: z.enum(["owner", "allotment", "connected", "ical_hint"]), checkedAt: isoDateTime })
    .optional(),
  /** The property system's own booking. */
  external: z
    .object({
      connectorId: z.string().min(1).max(64),
      externalId: z.string().min(1).max(200),
      status: z.string().max(40).optional(),
    })
    .optional(),
  checkedInAt: isoDateTime.optional(),
  checkedOutAt: isoDateTime.optional(),
  /** The property's short-term rental registration number, as shown at booking. */
  registration: z.string().max(60).optional(),
  /** A change one side asked for and the other has not answered (ADR-018): the stay as it would be. */
  change: z
    .object({
      by: changeBySchema,
      checkIn: z.iso.date(),
      checkOut: z.iso.date(),
      rooms: z.array(stayRoomSchema).min(1).max(9).optional(),
      quote: stayQuoteSchema.optional(),
      fee: moneySchema.optional(),
      validThrough: isoDateTime.optional(),
    })
    .optional(),
  offer: offerPointerSchema.optional(),
  /** The cancellation fee the guest confirmed (`fee_sha`), and the terms they accepted (`terms_sha`). */
  termsSha: z.string().max(64).optional(),
});

export const payloadSchemas = {
  message: messagePayloadSchema,
  quote_request: quoteRequestPayloadSchema,
  booking: bookingPayloadSchema,
  order: orderPayloadSchema,
  refund: refundPayloadSchema,
  stay: stayPayloadSchema,
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
  envelopeSchema.extend({ type: z.literal("stay"), payload: stayPayloadSchema }),
]);
export type Item = z.infer<typeof itemSchema>;
export type ItemOf<T extends ItemType> = Extract<Item, { type: T }>;

/** JSON-pointer-ish paths holding personal data, rewritten on erasure (GDPR). */
export const PII_PATHS: Record<ItemType, readonly string[]> = {
  message: ["text", "subject"],
  quote_request: ["description", "deliveryAddress"],
  booking: ["notes"],
  order: ["billingAddress", "shippingAddress", "notes"],
  refund: ["reason", "disputed"],
  // Guests' names, their requests and their arrival window; children's ages are a minor's data too.
  stay: ["guests", "requests", "arrival", "rooms"],
};
