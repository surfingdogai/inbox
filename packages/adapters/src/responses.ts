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
  kind: z.enum(["time", "quote"]).describe("time: another time for a booking; quote: a price for a request."),
  terms: z
    .looseObject({})
    .describe(
      "startTime, endTime, partySize, totalPrice, lines, notes, validThrough, creates: what accepting agrees to.",
    ),
  terms_sha: z.string().describe("Send it back with accept: the customer said yes to exactly these terms."),
  deadline: iso.nullable().describe("Until when the customer can answer."),
  obligation_to_pay: z.boolean().describe("Accepting binds the customer to pay."),
  human: z.string().describe("The terms in the business's words: tell your person this, as it is."),
});

/** The item as its customer reads it: no flags of the business's, what it waits for, what they can do. */
export const customerItemViewSchema = z.looseObject({
  item: itemSchema.omit({ flags: true }),
  transitions: z.array(transitionRefSchema),
  human: z.string().describe("In the business's words and language: relay it as it is."),
  reference: z.string().describe("Six characters the customer quotes back to the business."),
  offer: customerOfferSchema.nullable(),
  waiting_on: z.enum(["you", "us"]).nullable().describe("you: the business waits for the customer; us: the other way."),
  next: z.array(z.object({ action: z.string(), label: z.string() })).describe("What the customer can do next."),
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
  linked: customerItemViewSchema.optional().describe("What an accepted quote became: the booking or order, confirmed."),
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
});

export const profileSchema = z.object({
  name: z.string(),
  domain: nullableString,
  timezone: z.string(),
  currency: z.string(),
  languages: z.array(z.string()),
});

export const businessProfileSchema = profileSchema.extend({ item_types: z.array(z.string()) });

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
});

export const productSchema = z.looseObject({
  id: z.string(),
  sku: nullableString,
  name: z.string(),
  description: nullableString,
  price: money,
  stock: z.number().int().nullable(),
  active: z.number().int(),
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

export const keyListSchema = z.object({
  items: z.array(keyViewSchema),
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
