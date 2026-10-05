import { z } from "zod";

/**
 * The shapes the REST door answers with, for `/openapi.json` only: a generated client, a ChatGPT
 * Action, an n8n or Make import, or Zapier's CLI gets typed responses from these. Nothing is
 * validated against them at run time — the capabilities' own types are the truth, and these are
 * loose objects so a field added there never breaks a client generated from here.
 */
const iso = z.string().describe("ISO 8601 instant");
const nullableString = z.string().nullable();
const money = z.object({ value: z.number().int(), currency: z.string() });

export const transitionRefSchema = z.object({ event: z.string(), label: z.string() });

export const partyViewSchema = z.looseObject({
  id: z.string(),
  name: nullableString,
  kind: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  verified: z.boolean(),
});

export const receiptViewSchema = z.looseObject({ id: z.string(), kind: z.string() });

export const itemSchema = z.looseObject({
  id: z.string(),
  type: z.enum(["message", "quote_request", "booking", "order", "refund"]),
  state: z.string(),
  version: z.number().int(),
  partyId: z.string(),
  locationId: nullableString,
  channel: z.string(),
  subject: nullableString,
  flags: z.looseObject({ needsHuman: z.boolean(), sandbox: z.boolean(), priority: z.number().int() }),
  linkedItemId: nullableString,
  createdAt: iso,
  updatedAt: iso,
  closedAt: iso.nullable(),
  payload: z.record(z.string(), z.unknown()),
});

export const itemViewSchema = z.looseObject({
  item: itemSchema,
  transitions: z.array(transitionRefSchema),
  human: z.string(),
  party: partyViewSchema.optional(),
  receipts: z.array(receiptViewSchema).optional(),
  identity: z.looseObject({}).optional().describe("On the status door: who the inbox takes the customer for."),
});

/** What the business put to the customer and waits for them to answer (ADR-018 §5). */
export const customerOfferSchema = z.looseObject({
  id: z
    .string()
    .nullable()
    .describe("Name it when you answer (offer_id), so an answer to one since replaced does nothing."),
  kind: z
    .enum(["time", "quote", "order", "change"])
    .describe(
      "time: another time for a booking; quote: a price for a request; order: changes to an order; change: a change to a confirmed booking or an accepted order, which stays as agreed if your person says no.",
    ),
  terms: z
    .looseObject({})
    .describe(
      "startTime, endTime, partySize, totalPrice, lines, notes, validThrough, creates, delivery: what accepting agrees to.",
    ),
  terms_sha: z.string().describe("Send it back with accept: the customer said yes to exactly these terms."),
  deadline: iso.nullable().describe("Until when the customer can answer."),
  obligation_to_pay: z.boolean().describe("Accepting binds the customer to pay."),
  human: z.string().describe("The terms in the business's words: tell your person this, as it is."),
  changes: z
    .array(z.string())
    .describe("What differs from what it answers or replaces, as paths into terms ($.startTime, $.lines[0].quantity)."),
  warnings: z
    .array(z.object({ type: z.literal("warning"), code: z.literal("price_changed"), severity: z.string() }))
    .describe("price_changed whenever money changed: your person sees the new price before they accept."),
  disclosures: z
    .array(z.string())
    .describe("held or unheld (a time: kept for them until they answer, or theirs if still free); withdrawable."),
  expired: z
    .boolean()
    .describe("Its deadline has passed: it can no longer be accepted, though the business may not have closed it yet."),
});

/** An offer as the owner's doors show it (ADR-018 §1): every one of the item's, drafts included. */
export const offerViewSchema = z.looseObject({
  id: z.string(),
  rev: z.number().int(),
  parent_id: nullableString,
  kind: z.string(),
  form: z.enum(["time", "quote", "order", "request", "change"]),
  by: z.enum(["business", "customer"]),
  actor: z.object({ kind: z.string(), id: nullableString }),
  round: z.number().int(),
  status: z.enum(["draft", "open", "accepted", "declined", "countered", "retracted", "expired", "superseded"]),
  valid_through: iso.nullable(),
  terms: z.looseObject({}),
  terms_sha: z.string(),
  changes: z.array(z.string()),
  shown: z.looseObject({}).nullable().describe("What the customer was shown with it, in their language."),
  authored: z.enum(["person", "automated"]),
  binding: z.boolean(),
  reason_code: nullableString,
  note: nullableString,
  created_at: iso,
  closed_at: iso.nullable(),
});
/** What automation would have offered outside the owner's limits, waiting for the owner (ADR-018 §4). */
export const draftViewSchema = z
  .object({
    id: z.string(),
    event: z.string().describe("The transition it would make: propose, quote or propose_change."),
    terms: z.looseObject({}).describe("What the customer would be offered."),
    breaches: z
      .array(z.string())
      .describe(
        "The limits it is outside, as codes: below_floor, above_list, counter_priced, custom_line, time_moved, delivery_later, worse_than_before, rounds_exhausted, change_not_allowed, over_approval_value, amount_named.",
      ),
    by: z.object({ kind: z.string(), id: z.string(), name: z.string().optional() }),
    created_at: iso,
    stale: z
      .boolean()
      .describe(
        "The item has moved since (anything but a flag set or another draft): it can no longer be sent as it is.",
      ),
  })
  .describe("Only the owner sends it (POST …/offers/draft/send), or drops it.");

export const offerListSchema = z.object({ offers: z.array(offerViewSchema), draft: draftViewSchema.nullable() });

/** The item as its customer reads it: no flags of the business's, what it waits for, what they can do. */
export const customerItemViewSchema = z.looseObject({
  item: itemSchema.omit({ flags: true }),
  transitions: z.array(transitionRefSchema),
  human: z.string().describe("In the business's words and language: relay it as it is."),
  reference: z.string().describe("Six characters the customer quotes back to the business."),
  offer: customerOfferSchema.nullable(),
  agreed: z
    .looseObject({ terms: z.looseObject({}), terms_sha: z.string() })
    .nullable()
    .optional()
    .describe("The terms both sides last agreed, and their fingerprint."),
  requested_change: z
    .looseObject({ terms: z.looseObject({}), terms_sha: z.string(), until: iso.nullable() })
    .nullable()
    .optional()
    .describe(
      "A change your person asked for to what was agreed, while the business has not answered: the booking or the order as it would be, and until when it waits. What was agreed stands meanwhile; decline_offer takes it back.",
    ),
  waiting_on: z.enum(["you", "us"]).nullable().describe("you: the business waits for the customer; us: the other way."),
  next: z.array(z.object({ action: z.string(), label: z.string() })).describe("What the customer can do next."),
  withdrawal: z
    .looseObject({
      available: z.boolean(),
      until: iso.nullable().describe("When the period ends; null while the goods have not reached them."),
      label: z.string().describe("The words for the link: Withdraw from contract here, or the law's own."),
      why: z
        .string()
        .optional()
        .describe("Why not: excepted, lapsed, business_customer, not_paid (a booking nothing was paid for), started."),
      reason: z.string().optional().describe("For something excepted, why, in the business's words."),
    })
    .nullable()
    .optional()
    .describe(
      "For a booking or an order: whether your person may withdraw from it now (POST /v1/items/{id}/withdraw), until when, and why not.",
    ),
  refunds: z
    .array(z.object({ item_id: z.string(), reference: z.string(), state: z.string(), human: z.string() }))
    .optional()
    .describe("The returns and refunds of this booking or order, oldest first, each in the business's words."),
  thread: z
    .array(
      z.object({
        from: z.enum(["you", "us"]).describe("you: the customer wrote it; us: the business did."),
        text: z.string(),
        at: iso,
        automated: z.literal(true).optional().describe("Sent automatically: not written by a person."),
      }),
    )
    .optional()
    .describe(
      "On the status door: the conversation, oldest first, the last fifty — the business's replies and the customer's messages, never its internal notes.",
    ),
  receipts: z.array(receiptViewSchema).optional(),
  identity: z.looseObject({}).optional().describe("On the status door: who the inbox takes the customer for."),
});

export const customerResultSchema = z.object({
  view: customerItemViewSchema,
  linked: customerItemViewSchema
    .optional()
    .describe(
      "What an accepted quote became (the booking or order, confirmed), or the return or refund a withdrawal or a return request made.",
    ),
  replayed: z.boolean(),
});

/** A suggestion a person at the business answers: kept as the customer's message, never refused. */
export const passedOnResultSchema = z.object({
  view: customerItemViewSchema,
  waiting_on: z.literal("us"),
  appended: z.literal(true),
  passed_on: z.string().describe("In the business's words: tell your person this, as it is."),
  replayed: z.boolean(),
});

export const eventActorSchema = z.object({
  kind: z.string().describe("owner, owner_ai, integration, connector, rule, system, customer_agent or customer_human"),
  id: nullableString.describe("The user, AI app or key id; null for a customer and for a receipt."),
  name: z.string().optional().describe("The key's or AI app's name."),
});

const mailStatusSchema = z
  .enum(["queued", "sent", "retrying", "failed", "skipped"])
  .describe("sent only once the mail service took it; retrying: it failed and is tried again; failed: for good.");

const mailDeliverySchema = z.object({
  status: mailStatusSchema,
  sent_at: iso.nullable(),
  last_error: nullableString,
  skip_reason: nullableString,
});

export const itemDetailSchema = itemViewSchema.extend({
  events: z.array(
    z.looseObject({
      seq: z.number().int(),
      event: z.string(),
      from: nullableString,
      to: z.string(),
      actor: z.string(),
      by: eventActorSchema,
      channel: nullableString,
      reason: nullableString,
      at: iso,
    }),
  ),
  thread: z.array(
    z.looseObject({
      id: z.string(),
      direction: z.string(),
      channel: z.string(),
      actor: z.string(),
      body: z.string(),
      at: iso,
      delivery: mailDeliverySchema
        .optional()
        .describe("On a reply to the customer: what became of the email it went out in."),
    }),
  ),
  mail: z
    .array(
      z.object({
        id: z.string(),
        recipient: z.enum(["customer", "owner"]),
        template: z.string().describe("Which email it is: ack.booking, booking.proposed, reply, key, …"),
        subject: z.string(),
        body: z.string(),
        status: mailStatusSchema,
        skip_reason: nullableString.describe("Why it was not sent: no_address, no_sender, test_item."),
        last_error: nullableString,
        attempts: z.number().int(),
        sent_at: iso.nullable(),
        created_at: iso,
        entry_id: nullableString.describe("The reply it carries, when it is one."),
      }),
    )
    .describe("Every email about the item, to the customer and to the owner, and what became of each."),
  draft: draftViewSchema
    .nullable()
    .optional()
    .describe("What automation would have offered outside your limits, waiting for you to send or drop."),
});

export const itemPageSchema = z.object({ items: z.array(itemViewSchema), next_cursor: nullableString });

/** Who the inbox takes the customer for (ADR-017 §8.4), on every create and status answer. */
export const identityAnswerSchema = z.looseObject({
  recognised: z
    .enum(["strong", "weak", "none"])
    .describe("strong: a customer the business knows, proven; weak: same email or phone, not proven; none."),
  passes: z
    .array(z.object({ network: z.string(), pass: z.string() }))
    .describe("Passes to keep for the person, one per network: present them next time (pass or Sdi-Pass)."),
  verify: z.object({
    available: z.boolean().describe("A one-time code can prove the customer: POST /v1/customers/verify."),
    sent_to: nullableString.describe("The masked address a code went to."),
  }),
  networks: z.array(z.object({ network: z.string(), state: z.string() })),
  guide: z.string().describe("How an agent identifies itself and its person: https://surfingdog.ai/for-agents.md"),
});

/**
 * An item as a create or a transition answers it: to the business, with its flags; to a customer,
 * without them, as the status door shows it.
 */
const answeredViewSchema = itemViewSchema.extend({
  item: itemSchema.extend({
    flags: itemSchema.shape.flags.optional().describe("The business's own flags; never in a customer's answer."),
  }),
});

export const transitionResultSchema = z.object({
  view: answeredViewSchema,
  linked: answeredViewSchema.optional(),
  replayed: z.boolean(),
  drafted: z
    .object({ id: z.string(), breaches: z.array(z.string()) })
    .optional()
    .describe(
      "What was offered is outside the limits the owner set, so it was not sent: it waits as a draft for the owner (202), and the item is marked for a person. The limits as codes, never a number.",
    ),
  held: z
    .object({ breaches: z.array(z.string()) })
    .optional()
    .describe(
      "A reply that named an amount of money the business has not offered, so it was not sent: it was kept as an internal note for the owner (202), and the item is marked for a person.",
    ),
});

export const createResultSchema = z.object({
  view: answeredViewSchema,
  accessToken: z
    .string()
    .optional()
    .describe("Shown once, to an anonymous creator: keep it to read or cancel the item."),
  replayed: z.boolean(),
  identity: identityAnswerSchema.optional(),
});

export const codeSentSchema = z.object({
  sent_to: z.string().describe("The masked address, like a•••@e•••.pt."),
  test: z
    .literal(true)
    .optional()
    .describe("A test item: nothing was sent; the code is on the item for the business to read."),
});
export const verifiedSchema = z.object({ recognised: z.literal("strong") });

export const thinEventSchema = z.object({
  id: z.string(),
  type: z.string().describe("<item type>.<event>, e.g. booking.confirm"),
  timestamp: iso,
  data: z.looseObject({
    id: z.string(),
    type: z.string(),
    state: z.string(),
    version: z.number().int(),
    url: z.string(),
    actor: eventActorSchema,
    channel: nullableString,
    sandbox: z.boolean(),
  }),
});

export const eventPageSchema = z.object({ events: z.array(thinEventSchema), next_cursor: nullableString });

export const settingsViewSchema = z.object({
  doc: z.record(z.string(), z.unknown()),
  version: z.number().int(),
  redacted: z.array(z.string()).describe("Settings paths that hold a secret this read leaves out."),
  withheld: z
    .array(z.string())
    .describe(
      "Settings only the owner in person reads, left out of doc: negotiation.ai (the limits for automation) and negotiation.rewards. A write that leaves them out keeps them.",
    ),
});

/** The owner's floors (ADR-018 §4): the lowest price automation may go to, per product or service. */
export const floorsSchema = z.object({
  floors: z.array(
    z.object({
      kind: z.enum(["product", "service"]),
      ref_id: z.string(),
      floor_minor: z.number().int().describe("Minor units, on the same basis as the price."),
      updated_at: iso,
    }),
  ),
});

export const profileSchema = z.object({
  name: z.string(),
  domain: nullableString,
  timezone: z.string(),
  currency: z.string(),
  languages: z.array(z.string()),
});

export const businessProfileSchema = profileSchema.extend({
  item_types: z.array(z.string()),
  price_negotiable: z
    .boolean()
    .optional()
    .describe(
      "Whether a customer's own price is taken as an answer (make_offer total_price for a proposed time, unit_price for changes to an order). false: suggest a time, quantities or delivery; a price goes to a person at the business.",
    ),
  return_policy: z
    .looseObject({
      "@type": z.literal("MerchantReturnPolicy"),
      returnPolicyCategory: z.string(),
      merchantReturnDays: z.number().int(),
      returnMethod: z.string(),
      returnFees: z.string(),
      itemDefectReturnFees: z.string(),
      refundType: z.string(),
      returnPolicyCountry: z.string().optional(),
    })
    .optional()
    .describe("The business's return policy, as schema.org's MerchantReturnPolicy: the days, who pays to send back."),
  trader: z
    .looseObject({
      legal_name: z.string(),
      address: z.string().optional(),
      country: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      vat_id: z.string().optional(),
      complaints_url: z.string().optional(),
    })
    .optional()
    .describe("Who the business is, as the law asks before a contract: only what it filled in."),
});

export const serviceSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: nullableString,
  durationMin: z.number().int(),
  bufferBeforeMin: z.number().int(),
  bufferAfterMin: z.number().int(),
  capacity: z.number().int(),
  granularityMin: z.number().int(),
  price: z
    .looseObject({
      model: z.string(),
      value: z.number().optional(),
      currency: z.string().optional(),
      per: z.enum(["booking", "person"]).optional().describe("A fixed price is per booking unless it says per person."),
    })
    .nullable(),
  active: z.number().int(),
  sort: z.number().int(),
  withdrawal: z
    .string()
    .optional()
    .describe(
      "standard: the customer may withdraw within the legal period; else the exception the law allows (dated_leisure, urgent_repair, personalised, …).",
    ),
});

export const productSchema = z.looseObject({
  id: z.string(),
  sku: nullableString,
  name: z.string(),
  description: nullableString,
  price: money,
  stock: z.number().int().nullable(),
  active: z.number().int(),
  withdrawal: z
    .string()
    .optional()
    .describe(
      "standard: the customer may withdraw within the legal period; else the exception the law allows (perishable, personalised, sealed_hygiene, …).",
    ),
});

export const pageOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), next_cursor: nullableString });
export const listOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });

export const availabilitySchema = z.looseObject({
  timezone: z.string(),
  weekly: z.record(z.string(), z.unknown()),
  overrides: z.array(z.looseObject({ service_id: z.string() })),
  closures: z.array(z.looseObject({ from: z.string(), to: z.string() })),
});

export const slotsSchema = z.looseObject({
  service: z.looseObject({ id: z.string(), name: z.string(), durationMin: z.number().int() }),
  slots: z.array(z.looseObject({ startTime: z.string() })),
});

export const ruleViewSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  priority: z.number().int(),
  enabled: z.boolean(),
  version: z.number().int(),
  definition: z.record(z.string(), z.unknown()),
  summary: z.string(),
  created_at: iso,
  updated_at: iso,
});

export const ruleTestSchema = z.looseObject({
  matched: z.boolean(),
  summary: z.string(),
  would: z.array(z.string()),
  skipped: z
    .array(z.string())
    .optional()
    .describe(
      "What a run would hold back on this item, in plain words: a rule reading a customer's record only helps.",
    ),
});

export const deliverySummarySchema = z.object({
  pending: z.number().int(),
  delivered: z.number().int(),
  failed: z.number().int(),
  last_delivery_at: iso.nullable(),
});

export const webhookViewSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  payload_style: z.enum(["thin", "full"]),
  headers: z.array(z.string()).describe("The names of the extra headers; values are never returned."),
  active: z.boolean(),
  failing_since: iso.nullable(),
  disabled_at: iso.nullable(),
  last_error: nullableString,
  created_at: iso,
  updated_at: iso,
  deliveries: deliverySummarySchema,
});

export const webhookWithSecretSchema = webhookViewSchema.extend({
  secret: z.string().nullable().describe("The signing secret, in this answer and in no other."),
  secret_note: z.string(),
  previous_secret_until: iso.nullable(),
});

export const deliveryViewSchema = z.looseObject({
  id: z.string(),
  webhook_id: z.string(),
  event_id: z.string(),
  event_type: z.string(),
  status: z.enum(["pending", "delivered", "failed"]),
  attempts: z.number().int(),
  last_status: z.number().int().nullable(),
  last_error: nullableString,
  duration_ms: z.number().int().nullable(),
  created_at: iso,
  delivered_at: iso.nullable(),
  next_attempt_at: iso.nullable(),
});

export const testEventResultSchema = z.looseObject({
  delivered: z.boolean(),
  status: z.number().int().nullable(),
  duration_ms: z.number().int(),
  error: nullableString,
  event: thinEventSchema.extend({ test: z.literal(true), message: z.string() }),
  delivery: deliveryViewSchema,
});

export const replayReportSchema = z.object({
  webhook_id: z.string(),
  matched: z.number().int(),
  queued: z.number().int(),
  truncated: z.boolean(),
  next_after: nullableString,
});

export const feedSchema = z.looseObject({ id: z.string(), name: z.string(), url: z.string(), status: z.string() });

export const refusalSchema = z.object({
  operation: z.string(),
  scope: z.string(),
  count: z.number().int(),
  enforced: z.boolean(),
  first_at: iso,
  last_at: iso,
});

export const keyViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["owner", "integration"]),
  hint: z.string(),
  scopes: z.array(z.string()),
  active: z.boolean(),
  created_at: iso,
  created_by: nullableString,
  last_used_at: iso.nullable(),
  expires_at: iso.nullable(),
  revoked_at: iso.nullable(),
  refusals: z.array(refusalSchema),
});

export const createdKeySchema = keyViewSchema.extend({
  key: z.string().nullable().describe("The key, in this answer and in no other."),
  key_note: z.string(),
});

export const connectedAppSchema = z.object({
  id: z.string(),
  name: nullableString,
  verified: z.boolean().describe("Its details are published at its own address; otherwise it chose its own name."),
  sends_to: z.array(z.string()).describe("The hosts its sign-in comes back to, which receive its access."),
  scopes: z.array(z.string()),
  connected_at: iso,
  last_used_at: iso.nullable(),
});

export const keyListSchema = z.object({
  items: z.array(keyViewSchema),
  apps: z.array(connectedAppSchema).describe("AI apps connected over OAuth that can still act, newest first."),
  ai_clients: z.array(
    z.object({ kind: z.string(), id: z.string(), name: nullableString, refusals: z.array(refusalSchema) }),
  ),
  scopes: z.array(z.object({ scope: z.string(), label: z.string() })),
  presets: z.array(z.looseObject({ key: z.string(), name: z.string(), scopes: z.array(z.string()) })),
  security: z.object({ ai_may_create_keys: z.boolean(), enforce_scopes: z.boolean() }),
});

export const deletedSchema = z.object({ deleted: z.literal(true) });
export const looseSchema = z.looseObject({});

/** What each network already had about a customer who switched networks off, and since when. */
export const networksOffSchema = z
  .object({
    since: iso,
    via: z.enum(["customer", "owner", "erased"]).nullable().describe("customer: by the link in their code email."),
    networks: z.array(
      z.object({
        network: z.string(),
        receipts: z.number().int().describe("Receipts about them this network took before the stop."),
        open_promises: z
          .number()
          .int()
          .describe(
            "Their promises this network holds without an outcome: it records each as unclosed 9 days after it was due.",
          ),
        person: z.boolean().describe("This network knows their person."),
      }),
    ),
  })
  .nullable()
  .describe("Booking networks are off for this customer: nothing more about them goes to any network. Null: on.");

export const customerSummarySchema = z.object({
  party_id: z.string(),
  name: nullableString,
  parties: z.array(z.string()).describe("Every party that is this customer."),
  items: z.number().int(),
  open_items: z.number().int(),
  entries: z.number().int(),
  emails: z.number().int(),
  erased_at: iso.nullable(),
  networks_off: networksOffSchema,
});

export const eraseResultSchema = z.object({
  erased: z.boolean(),
  already: z.boolean().describe("The customer had been erased already: nothing more was done."),
  customer: customerSummarySchema,
});

export const mailServiceSchema = z.object({
  service: z.boolean().describe("A mail service that delivers is set up."),
  sender: z.boolean().describe("There is an address to send from."),
  links: z.boolean().describe("Emails can carry answer links."),
});
