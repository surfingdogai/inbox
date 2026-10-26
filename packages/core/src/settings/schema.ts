import {
  cleanDoorUrl,
  DOOR_PLATFORM_ID,
  type DoorElsewhere,
  doorPlatform,
  doorPlatformFit,
  doorPlatformHolds,
  doorPlatformOf,
  doorTrackingParams,
  hostIsOn,
  isPaymentToken,
  MAX_PROFILE_PAYMENTS,
  ownSiteDomain,
  readDoorsElsewhere,
} from "@surfingdog/spec";
import { z } from "zod";
import type { Db } from "../db";
import { settings as settingsTable } from "../schema/tables";
import { canonicalNetworkOrigin, isPublicHost, networkOriginOfUrl } from "../util/hosts";

/**
 * The settings document: one versioned, Zod-validated JSON. It grows toward the full wizard;
 * these are the fields the write path needs today.
 *
 * What is stored is the raw document the owner wrote, merged key by key (`merge.ts`), never the
 * parsed result: a key this version does not know is kept for the version that does, and a
 * default is never written back as if the owner had chosen it. Reading is lenient
 * (`parseStoredSettings`): a stored value this version rejects falls back to its own default and
 * nothing else moves, so one bad field can never reset the rest of the document.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

/** The network a fresh instance lists, switched off, so joining it is one switch away. */
export const DEFAULT_NETWORK = "https://network.surfingdog.ai";

/** At most this many networks, the same bound as a receipt's `per` claim (ADR-017 §8.1). */
export const MAX_NETWORKS = 8;

/**
 * One network (ADR-017 §8.1), keyed by its origin in `networks`. Switching one off is
 * `enabled: false`; its receipts stay queued for it, and switching it on again publishes them.
 */
export const networkEntrySchema = z.object({
  enabled: z
    .boolean()
    .default(false)
    .describe("Report to this network: register, ping every hour, and publish what `share` allows."),
  issue: z
    .boolean()
    .default(true)
    .describe(
      "Let this network issue a key to a first-time customer through this inbox (ADR-017 §2.1): on a booking or order with an email and no pass, the inbox asks it for one and emails the key to the customer.",
    ),
  share: z
    .object({
      listing: z
        .boolean()
        .default(true)
        .describe(
          "Be listed in the network's directory. A network takes counts and receipts only from an inbox registered with it, so the inbox registers while any of the three is on.",
        ),
      counts: z
        .boolean()
        .default(true)
        .describe("Send the hourly counts of new bookings, orders, quotes and messages."),
      receipts: z
        .boolean()
        .default(true)
        .describe("Publish every receipt and acknowledgement; the manifest names the network under review_services."),
      catalogue: z
        .boolean()
        .default(true)
        .describe(
          "List my products here while 'Your products on networks' is on (ADR-029). Only the owner in person changes it.",
        ),
    })
    .prefault({}),
  resume: z
    .boolean()
    .optional()
    .describe(
      "Written only by a host that holds every network off for now (a hosted inbox until it is live at the business's own address): whether this one comes back on when the host lets go. Nobody else writes it.",
    ),
});
export type NetworkEntry = z.infer<typeof networkEntrySchema>;
export type NetworkShare = keyof NetworkEntry["share"];

/**
 * Where one detail of a setup plan came from (`capabilities/plan.ts`): `declared` when the site
 * states it in structured data, `read` when it was read from the page's words and the owner should
 * check it, `confirmed` when the owner confirmed it themselves.
 */
export const setupSourceSchema = z.object({
  source_url: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .describe("The page it was read from."),
  checked_at: z.iso.datetime({ offset: true }).describe("When it was read."),
  confidence: z
    .enum(["declared", "read", "confirmed"])
    .describe(
      "declared: the site states it in structured data; read: read from the page's words, for the owner to check; confirmed: the owner confirmed it.",
    ),
});
export type SetupSource = z.infer<typeof setupSourceSchema>;

/** A field a setup plan names a source for: `hours`, `services`, `profile.name`, `directory.address`. */
export const setupFieldSchema = z
  .string()
  .max(64)
  .regex(/^[a-z_]+(\.[a-z_]+)*$/, "a field like hours, services or profile.name");

/** At most this many fields with a source. */
export const MAX_SETUP_SOURCES = 30;

/** At most this many services suggested to the owner by a setup plan. */
export const MAX_SUGGESTED_SERVICES = 30;

const disabledNetwork = (): NetworkEntry => networkEntrySchema.parse({});
const defaultNetworks = (): Record<string, NetworkEntry> => ({ [DEFAULT_NETWORK]: disabledNetwork() });

const sections = {
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION).default(SETTINGS_SCHEMA_VERSION),
  business: z
    .object({
      name: z.string().max(200).default(""),
      timezone: z.string().max(64).default("UTC"),
      currency: z.string().length(3).default("EUR"),
      languages: z.array(z.string().max(12)).default(["en"]),
    })
    .prefault({}),
  booking: z
    .object({
      /** Minutes before the start time until which a customer may cancel a confirmed booking. */
      cancellationWindowMin: z
        .number()
        .int()
        .min(0)
        .default(24 * 60),
      /**
       * Minutes before a start time after which customers can no longer book it online: no free
       * time inside it is offered, and no customer, rule, AI or key books one; the owner or staff
       * in person still may. Nobody proposes or quotes one: the customer could not accept it. A
       * time that has started is never booked by anyone.
       */
      minNoticeMin: z
        .number()
        .int()
        .min(0)
        .max(10_080)
        .default(60)
        .describe("Minutes before a start time after which customers can no longer book it online."),
      /**
       * Hold the time we propose until the customer answers (ADR-018 §3.1): nobody else can book it
       * meanwhile. Off, a proposed time goes out unheld, theirs if it is still free when they say yes.
       */
      holdOnPropose: z
        .boolean()
        .default(false)
        .describe("Hold the time you propose until the customer answers, so nobody else books it."),
      /**
       * At most this many times held at once for one customer (their party, or the assistant that
       * made the request), across their bookings; past it a proposed time goes out unheld, so nobody
       * parks places by asking.
       */
      maxHolds: z
        .number()
        .int()
        .min(0)
        .max(10)
        .default(2)
        .describe("Times held at once for one customer, at most; past it a proposed time goes out unheld."),
      /**
       * A booking request nobody answered lapses this many hours after it came in, or after the
       * customer last answered us, and at its start at the latest; the customer is told.
       */
      autoExpireHours: z
        .number()
        .int()
        .min(1)
        .default(72)
        .describe("Hours after which a booking request nobody answered lapses; the customer is told."),
      /**
       * A customer who cancels a confirmed booking after the window has closed (ADR-017 §3.1):
       * `record` takes the cancellation and records it as late (the network weighs it only when it
       * comes under 48 hours before the start); `refuse` keeps today's answer, "ask the business".
       * Instances that existed before this setting keep `refuse` until the owner changes it.
       */
      lateCancellation: z
        .enum(["record", "refuse"])
        .default("record")
        .describe("After the cancellation window: record a late cancellation, or refuse and send the customer to you."),
      /**
       * Hours after a confirmed booking's end at which the system marks it completed, unless it was
       * marked a no-show; also how long either can be corrected once (ADR-017 §3, §14).
       */
      autoCompleteHours: z
        .number()
        .int()
        .min(1)
        .max(168)
        .default(48)
        .describe("Hours after the end at which a confirmed booking counts as completed unless marked a no-show."),
    })
    .prefault({}),
  orders: z
    .object({
      maxValueWithoutApprovalMinor: z.number().int().min(0).default(0),
      /** Days after payment was requested at which an unpaid order lapses: a neutral close (ADR-017 §3.1). */
      payDays: z
        .number()
        .int()
        .min(1)
        .max(90)
        .default(14)
        .describe(
          "Days after a payment request at which an unpaid order lapses: closed for the network, open for you.",
        ),
      /** When an accepted order is due, if it names no delivery time: this many days after the promise. */
      dueDays: z
        .number()
        .int()
        .min(1)
        .max(365)
        .default(30)
        .describe("Days after acceptance by which an order with no delivery time is due."),
    })
    .prefault({}),
  /**
   * Offers (ADR-018 §1, §10): how long what we propose and what the customer asks stay open, how
   * many answers a negotiation takes before a person does the rest, and whether we may withdraw
   * what we proposed. They bound what the owner's AI and rules do, so only the owner in person
   * changes them (`guard.ts`).
   */
  negotiation: z
    .object({
      /**
       * How long what we propose can be accepted when it gives no date of its own: a quote, changes to
       * an order. What the owner's AI or a rule proposes lasts at most this long, whatever it says. A
       * time a person proposes lasts until its start less the minimum notice.
       */
      offerValidHours: z
        .number()
        .int()
        .min(1)
        .max(2_160)
        .default(48)
        .describe(
          "Hours a quote or changes you send without a date can be accepted; what your AI or a rule proposes lasts at most this long.",
        ),
      /** An order or a quote request the customer sent, or answered, lapses this long after, unanswered. */
      counterValidHours: z
        .number()
        .int()
        .min(1)
        .max(2_160)
        .default(72)
        .describe("Hours after which an order or quote request nobody answered lapses; the customer is told."),
      /**
       * Rounds in a negotiation: its first offer is round 1, each answer that is not a yes one more.
       * Past it the owner's AI and rules make no further offer, and a customer's further suggestion
       * goes to a person as their message; never refused.
       */
      maxRounds: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(3)
        .describe("Rounds of back-and-forth before a person answers; a customer's suggestion is never refused."),
      /**
       * What we propose binds us until it lapses. Off, it says it is subject to our confirmation,
       * and we may withdraw it (`retract`) before the customer answers.
       */
      binding: z
        .boolean()
        .default(true)
        .describe("What you propose binds you until it lapses. Off, you may withdraw it before the customer answers."),
      /**
       * Whether a customer's own price is taken as their answer (Q1: off out of the box). Off, a price
       * they suggest goes to a person as their message, never refused; time, quantities and delivery can
       * always be suggested. On, it is their counter, for a person to take or answer — or for the owner's
       * AI and rules to take at or above the owner's floor, never to haggle.
       */
      priceCounters: z
        .boolean()
        .default(false)
        .describe(
          "Customers may suggest a price of their own (a counter you take or answer). Off, a price they suggest goes to a person as their message.",
        ),
      /**
       * How far one customer (their party, the assistant that signs for them, or their device) may haggle:
       * negotiations open at once, and price counters per product or service in `days`. Past either, what
       * they suggest goes to a person as their message; never refused.
       */
      perCustomer: z
        .object({
          open: z
            .number()
            .int()
            .min(1)
            .max(20)
            .default(3)
            .describe("Negotiations on price one customer may have open at once."),
          priceCounters: z
            .number()
            .int()
            .min(0)
            .max(20)
            .default(3)
            .describe("Prices one customer may suggest for the same product or service within the days below."),
          days: z.number().int().min(1).max(365).default(30).describe("The window the price counters are counted in."),
        })
        .prefault({}),
      /**
       * Rewards for good customers (Q3): a lower price the inbox gives a customer whose record here, or
       * whose standing their assistant showed, meets the owner's condition. Keyed by id; each is checked
       * when written (`negotiation/rewards.ts`) and one that does not check out is never applied. Only
       * the owner in person reads or changes them.
       */
      rewards: z
        .record(z.string(), z.unknown())
        .default({})
        .describe(
          "Rewards for good customers, keyed by a name of yours: { if: a condition on the customer's record, pct: 1-50 percent off, only: product or service ids (null: all), says?: a line for the customer }.",
        ),
      /**
       * Changes to a confirmed booking or an accepted order (ADR-018 §3.1, §3.2): how many each may
       * have, and how close to a booking's start a customer's own change still goes through without a
       * person. A change declined, withdrawn or lapsed leaves the promise as it was.
       */
      changes: z
        .object({
          maxPerItem: z
            .number()
            .int()
            .min(0)
            .max(3)
            .default(3)
            .describe(
              "Changes a booking or an order may have once agreed (at most 3). Past it, a customer's request goes to a person as their message.",
            ),
          customerCutoffMin: z
            .number()
            .int()
            .min(0)
            .max(43_200)
            .nullable()
            .default(null)
            .describe(
              "Minutes before a booking's start after which only a person may accept a customer's change; empty means the cancellation window.",
            ),
        })
        .prefault({}),
      /**
       * What the owner's AI and rules may agree to on their own (Q2, time yes, money no). Only the
       * owner in person changes these.
       */
      ai: z
        .object({
          maxDiscountPct: z
            .number()
            .min(0)
            .max(50)
            .default(0)
            .describe(
              "Percent below a customer's price your AI and rules may go on a catalogue line, never under your lowest price for it. 0: no discount.",
            ),
          mayPriceCustom: z
            .boolean()
            .default(false)
            .describe(
              "Your AI and rules may put a price on what the catalogue does not price: a quote, a line of their own, a longer booking.",
            ),
          maxTimeShiftMin: z
            .number()
            .int()
            .min(0)
            .max(43_200)
            .default(10_080)
            .describe("Minutes from the time the customer asked for that your AI and rules may propose instead."),
          maxDelayDays: z
            .number()
            .int()
            .min(0)
            .max(90)
            .default(0)
            .describe("Days past the delivery date the customer asked for that your AI and rules may propose."),
          maxRefundMinor: z
            .number()
            .int()
            .min(0)
            .default(0)
            .describe(
              "Up to this amount (in cents) for an order, your AI and rules may agree refunds with nothing to send back. 0: never.",
            ),
          mayAcceptChanges: z
            .boolean()
            .default(true)
            .describe(
              "Your AI and rules may accept a customer's change to a free time before the cutoff; never one that changes a price.",
            ),
          mayProposeChanges: z
            .boolean()
            .default(false)
            .describe("Your AI and rules may ask a customer to change a confirmed booking or an accepted order."),
          mayAuthorizeReturnsInPolicy: z
            .boolean()
            .default(true)
            .describe(
              "Your AI and rules may approve a return inside your return policy, with the goods coming back; never pay a refund, refuse a return or settle for less.",
            ),
        })
        .prefault({}),
    })
    .prefault({}),
  /**
   * Returns (ADR-018 §7): the business's policy, which may be more generous than the law and never
   * less. Only the owner in person changes it (`guard.ts`): it bounds what the owner's AI approves.
   */
  returns: z
    .object({
      days: z
        .number()
        .int()
        .min(14)
        .max(365)
        .default(14)
        .describe(
          "Days after delivery (or after booking, for a service) a customer may withdraw or return; 14 at least.",
        ),
      postage: z
        .enum(["customer", "business"])
        .default("customer")
        .describe(
          "Who pays to send a withdrawn or returned item back: the customer, or you. Faulty goods are always yours.",
        ),
      refundDays: z
        .number()
        .int()
        .min(1)
        .max(14)
        .default(14)
        .describe("Days you take to refund once nothing more has to come back; 14 at most."),
      respondHours: z
        .number()
        .int()
        .min(1)
        .max(336)
        .default(48)
        .describe("Hours within which you answer a return request; the customer is told."),
      assumedTransitDays: z
        .number()
        .int()
        .min(0)
        .max(30)
        .default(7)
        .describe(
          "When an order was fulfilled with no delivery date recorded, the days it is taken to have been on its way: the customer's period starts after them.",
        ),
    })
    .prefault({}),
  /**
   * Who the business sells to, and who it is (ADR-018 §5, §7): its customers are consumers unless it
   * sells only to businesses, and its legal identity goes in every confirmation. Only the owner in
   * person changes it.
   */
  commerce: z
    .object({
      customers: z
        .enum(["consumers", "businesses", "both"])
        .default("both")
        .describe(
          "Who you sell to. Unless it is only businesses, a customer is taken for a consumer: they confirm the price before they order, and may withdraw.",
        ),
      legal: z
        .object({
          legalName: z.string().max(200).default("").describe("Your legal or trading name."),
          address: z.string().max(500).default("").describe("Your geographical address."),
          country: z
            .string()
            .regex(/^[A-Z]{2}$/, "a two-letter country code, like PT or GB")
            .or(z.literal(""))
            .default("")
            .describe("The country whose consumer law applies to you (PT, GB, …): it picks the words and holidays."),
          phone: z.string().max(40).default(""),
          email: z.email().or(z.literal("")).default(""),
          vatId: z.string().max(40).default("").describe("Your VAT or tax number."),
          complaintsUrl: z
            .url()
            .or(z.literal(""))
            .default("")
            .describe("Where a customer can complain (in Portugal, the Livro de Reclamações)."),
        })
        .prefault({}),
    })
    .prefault({}),
  notifications: z
    .object({
      /** Where the owner is told about new items; empty = the first owner's sign-in address. */
      ownerEmail: z.email().optional(),
      /** Public base URL of the owner app, used in links. */
      appUrl: z.url().optional(),
    })
    .prefault({}),
  email: z
    .object({
      fromAddress: z.email().optional(),
      fromName: z.string().max(100).optional(),
      /**
       * Customers reply here when the inbox has no address of its own (`inboundAddress`). With one,
       * every email carries the address of its own conversation instead (ADR-026 §4).
       */
      replyTo: z.email().optional(),
      /**
       * The inbox's own email address: mail sent to it, or forwarded to it, reaches this inbox (its
       * host's routing, the operator's own, or a provider's inbound webhook). Each conversation is
       * one of its plus addresses (`name+t…@domain`), and the owner's alerts can be answered at
       * another (ADR-026). Set by the host on a hosted inbox.
       */
      inboundAddress: z.email().optional(),
      /** Shared secret for the raw-MIME inbound webhook (Mailgun routes, forwarders). */
      inboundSecret: z.string().min(16).max(200).optional(),
    })
    .prefault({}),
  integrations: z
    .object({
      /** Outbound webhooks (ADR-015 §3–§5): where this inbox sends its events. */
      webhooks: z
        .object({
          enabled: z.boolean().default(true).describe("Off, no endpoint is called and nothing is queued."),
          timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
          /** Attempts at 0s, 5s, 5m, 30m, 2h, 5h, 10h, 10h; the last delay repeats beyond eight. */
          maxAttempts: z.number().int().min(1).max(12).default(8),
          /** An endpoint that has done nothing but fail for this long is deactivated, never deleted. */
          disableAfterDays: z.number().int().min(1).max(30).default(5),
          retainDeliveryDays: z.number().int().min(1).max(90).default(30),
          /**
           * Allows an endpoint on a private, local or plain-http address. Only for a machine you
           * control: it lets anything with owner access make this instance call an internal host.
           */
          allowPrivateTargets: z.boolean().default(false),
        })
        .prefault({}),
      /** Product feeds (ADR-015 ship order 3): a catalogue from a URL, with no credentials at all. */
      feeds: z
        .object({
          enabled: z.boolean().default(true),
          refreshHours: z.number().int().min(1).max(168).default(6),
          maxProducts: z.number().int().min(1).max(50_000).default(5_000),
          /** Archive the products a feed stopped listing instead of leaving them on sale. */
          deactivateMissing: z.boolean().default(true),
        })
        .prefault({}),
      /** Platform connectors (ADR-015 §1): a connector is a row, so only its cadence lives here. */
      connectors: z
        .object({
          enabled: z.boolean().default(true),
          syncMinutes: z.number().int().min(5).max(1_440).default(15),
          retainEventDays: z.number().int().min(1).max(90).default(30),
        })
        .prefault({}),
    })
    .prefault({}),
  /**
   * Who may do what with keys and scopes, and where security reports go. Only the owner in person —
   * signed in to the owner app, or with a full owner key — can change this section; the owner's AI
   * and integration keys cannot.
   */
  security: z
    .object({
      /**
       * Retired: the owner's AI no longer creates or revokes keys, whatever this says (a customer's
       * message could talk it into handing one out). Kept so a stored document still reads.
       */
      aiMayCreateKeys: z
        .boolean()
        .default(false)
        .describe("Retired: the owner's AI cannot create or revoke keys, whatever this says."),
      enforceScopes: z
        .boolean()
        .default(false)
        .describe(
          "Refuse a call outside the scopes of the key or AI app that makes it. Off, such a call goes through and is recorded under Settings → Keys; a later release turns this on for everyone.",
        ),
      /**
       * Where someone who finds a security problem in this inbox reports it, as
       * `/.well-known/security.txt` says (RFC 9116): an email address or an https URL. Empty, it is
       * this inbox's own message form, /p/message.
       */
      contact: z
        .union([z.email(), z.url({ protocol: /^https$/ })])
        .optional()
        .describe(
          "Where security problems are reported: an email address or an https URL, published in /.well-known/security.txt. Empty: hello@ this inbox's host.",
        ),
    })
    .prefault({}),
  /**
   * Signed agents (ADR-017 §2.4): a signature names the host it was made for, which is this
   * inbox's public host (`INBOX_PUBLIC_URL`, else the Inbox address). A host this inbox also
   * answers on — an old name, a second domain — goes here, or signatures made for it do not verify.
   */
  identity: z
    .object({
      extraAuthorities: z
        .array(
          z
            .string()
            .max(253)
            .regex(/^[a-z0-9.-]+(:[0-9]{1,5})?$/, "a lowercase host, with a port only when it is not 443"),
        )
        .max(8)
        .default([])
        .describe("Other hosts this inbox answers on, which an agent's signature may name."),
    })
    .prefault({}),
  /**
   * Customers the business already knows (ADR-017 §8.2). A customer who gives the same email as
   * one it knows, and nothing that proves it, is asked for a one-time code sent to that address.
   */
  customers: z
    .object({
      otp: z
        .object({
          ttlMinutes: z.number().int().min(1).max(60).default(10).describe("How long a code works."),
          attempts: z.number().int().min(1).max(10).default(5).describe("Wrong tries before a code stops working."),
          sendsPerHour: z
            .number()
            .int()
            .min(1)
            .max(10)
            .default(3)
            .describe("Codes sent to one address in an hour, at most."),
          sendsPerDay: z
            .number()
            .int()
            .min(1)
            .max(50)
            .default(5)
            .describe("Codes sent to one address in a day, at most."),
          guessesPerDay: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(10)
            .describe("Tries at the codes sent to one address in a day, right or wrong, at most."),
        })
        .prefault({}),
      /**
       * A first-time customer's code for their assistant (ADR-017 §2.1): a day after their first
       * booking or order, an email of its own with the code and one line about the booking network.
       * Off, no email carries it; the assistant still gets what it needs in the answer to its request.
       * Only for a network that hands this inbox the code: one that emails the code itself sends none.
       */
      emailKey: z
        .boolean()
        .default(true)
        .describe(
          "A day after a new customer's first booking or order, email them a code their assistant can show next time so you recognise them.",
        ),
    })
    .prefault({}),
  /**
   * The business in the networks' directories (ADR-017 A2.3, A2.5): whether to be there at all, and
   * the public profile a directory shows. Every field here is published as it is written, to every
   * network this inbox reports to, so it holds only what the business says about itself in public:
   * never a person's email or phone. Off, the inbox tells each network it can sign for to delist it,
   * and its manifest says `directory.listed: false` to the rest.
   */
  directory: z
    .object({
      listed: z.boolean().default(true).describe("Be in the directories of the networks you report to."),
      resume: z
        .boolean()
        .optional()
        .describe(
          "Written only by a host that holds the business out of the directories for now: whether it comes back in when the host lets go. Nobody else writes it.",
        ),
      description: z.string().max(500).default("").describe("A sentence or two about the business, in public."),
      categories: z
        .array(z.string().max(60))
        .max(10)
        .default([])
        .describe("What the business is, as category slugs (vocab/categories.json) or free tags."),
      address: z
        .object({
          streetAddress: z.string().max(200).default(""),
          addressLocality: z.string().max(100).default(""),
          postalCode: z.string().max(20).default(""),
          addressCountry: z
            .string()
            .regex(/^([A-Z]{2})?$/, "a two-letter country code in capitals, like PT, or nothing")
            .default(""),
        })
        .prefault({})
        .describe("Where customers find the business; leave it empty for a business with no premises."),
      geo: z
        .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
        .nullable()
        .default(null)
        .describe("The premises on a map, so a directory can say how far away it is."),
      url: z
        .url({ protocol: /^https?$/ })
        .max(2048)
        .or(z.literal(""))
        .default("")
        .describe("The business's own website, if it has one."),
    })
    .prefault({}),
  /**
   * How customers and their agents can pay the business (Settings → Payments): tokens of the payments vocabulary
   * (`@surfingdog/spec`'s `vocab/payments.json`: card, apple_pay, paypal, pix…), ticked by the owner, or filled in
   * from what its own website showed by a setup plan (its source is then `setup.sources.payments`, until the owner
   * saves the tab). The manifest publishes them in its profile (`profile.payments`, with card for a card brand), so an
   * agent knows before it pays, and a network shows them as declared by the business. A token is never removed from the
   * vocabulary, so a stored one always reads. It is what the business says of itself to every agent, so only the owner
   * in person changes it (`guard.ts`).
   */
  payments: z
    .object({
      accepted: z
        .array(z.string().refine(isPaymentToken, "a payment of vocab/payments.json, like card or apple_pay"))
        .max(MAX_PROFILE_PAYMENTS)
        .refine((all) => new Set(all).size === all.length, "each payment once")
        .default([])
        .describe("How customers and their agents can pay you: card, apple_pay, paypal, pix… (vocab/payments.json)."),
    })
    .prefault({}),
  /**
   * What agents can do here, door by door (`capabilities/directory.ts`): left out, a door follows
   * what the inbox holds — a message always, a booking with a service and opening hours, a request
   * for a price with something to ask about. `false` shuts a door whatever it holds: agents are not
   * told of it, and one that asks anyway is refused. `quoteRequest: true` opens the request for a
   * price before anything is listed, the job described in the request's own words. `true` opens no
   * booking without a service and hours to book it in. People who write by email, or on the
   * business's own page, are not agents: these leave them as they are.
   */
  doors: z
    .object({
      booking: z.boolean().optional().describe("Agents can see your free times and ask to book."),
      quoteRequest: z.boolean().optional().describe("Agents can ask you for a price."),
      message: z.boolean().optional().describe("Agents can send you a message."),
    })
    .prefault({})
    .describe("What agents can do here. Left out, a door follows what the inbox holds; false shuts it."),
  /**
   * Requests a network carries to this inbox for someone's AI assistant (ADR-025): a question, a
   * request for a quote or for a booking, sent through the inbox's own public doors with the email
   * address the person agreed to give, never a phone number. On for every inbox unless the owner
   * switches it off; off, the manifest says `carried_requests: {"accepted": false}` and every
   * network leaves the inbox be. The inbox's own doors and their limits are the same either way.
   */
  carried: z
    .object({
      accepted: z
        .boolean()
        .default(true)
        .describe(
          "Let networks bring you requests from people's AI assistants, with the email they agreed to give you.",
        ),
    })
    .prefault({})
    .describe("Requests a network carries to you for people's AI assistants."),
  /**
   * The business's products on the networks it reports to (ADR-029): on for every inbox unless the
   * owner switches it off (the founder, 26 October 2026), and listed only while the business is in a
   * network's directory (`wantsCatalogue`). On, the inbox serves its signed feed of what is on sale
   * (`GET /v1/catalogue/changes`) and its ping tells each network when the catalogue changed; off, the
   * feed answers 404 and each network is told to stop showing them. The business's own doors list and
   * take orders for its products either way. Who the business sells to, at what price, is the owner's:
   * only the owner in person changes any of this (`guard.ts`).
   */
  catalogue: z
    .object({
      listed: z
        .boolean()
        .default(true)
        .describe("List your products on the networks you report to. Only the owner in person changes it."),
      taxIncluded: z
        .boolean()
        .nullable()
        .default(null)
        .describe("Whether your prices include tax; null when not said, which networks show as tax not said."),
      skuBarcodes: z
        .enum(["ask", "used", "not_now"])
        .default("ask")
        .describe(
          "The one-time offer to use product codes that look like barcodes as barcodes: ask, used, or not_now once the owner said not now.",
        ),
    })
    .prefault({})
    .describe("Your products on the networks you report to."),
  /**
   * Where the details a setup plan filled in came from (`capabilities/plan.ts`), per field: the page,
   * when it was read, and how. Kept so the owner app can ask the owner to check what was only read
   * from a page's words. Never published. And what it read but did not apply (`suggestions`): the
   * services only a language model read, for the owner to add with one press each.
   */
  setup: z
    .object({
      sources: z
        .record(setupFieldSchema, setupSourceSchema)
        .refine((s) => Object.keys(s).length <= MAX_SETUP_SOURCES, {
          message: `at most ${MAX_SETUP_SOURCES} fields`,
        })
        .default({})
        .describe("Where each detail a setup plan filled in was read, keyed by field (hours, services, profile.name)."),
      suggestions: z
        .object({
          services: z
            .array(z.object({ name: z.string().trim().min(1).max(120) }))
            .max(MAX_SUGGESTED_SERVICES)
            .default([])
            .describe(
              "Services a setup plan read on the business's site but could not vouch for (a language model's reading of its words): offered to the owner to add, never on offer until they do.",
            ),
        })
        .prefault({})
        .describe("What a setup plan read and left for the owner to add. Never published, never booked."),
    })
    .prefault({}),
  testMode: z.boolean().default(false),
};

/**
 * A place a door elsewhere may send customers: what any reader of the manifest keeps
 * (`readDoorsElsewhere`), on a host this instance would call itself (`isPublicHost`).
 */
export function isDoorElsewhereUrl(url: string): boolean {
  if (readDoorsElsewhere({ doors_elsewhere: [{ item_type: "booking", url }] }).length !== 1) return false;
  return isPublicHost(new URL(url).hostname);
}

/**
 * One door elsewhere as a write sets it (ADR-035): the kind, the page, and the platform the owner picked it on from
 * `vocab/door-platforms.json`, if any. A page is the business's own: on the platform it names, past the platform's
 * own pages, and with no tracking or affiliate parameter in it. A platform that also serves the business's own domain
 * (Shopify, Wix, SimplyBook.me…) takes a page there too, which the write checks against the business's domain
 * (`doorElsewhereDomainProblems`). Only a write is held to this: a stored door is read by
 * `doorElsewhereStoredSchema`.
 */
export function doorElsewhereSettingSchema() {
  return z
    .object({
      itemType: z.enum(["booking", "order"]).describe("booking: at a booking platform. order: in your own checkout."),
      url: z
        .url({ protocol: /^https$/ })
        .max(2048)
        .refine(isDoorElsewhereUrl, "an https address on a public host, with no user or password in it")
        .refine((url) => doorTrackingParams(url).length === 0, {
          message: "the link carries tracking (like utm_source or fbclid): send people to the page itself",
        })
        .describe("Where customers go for it: an https address."),
      platform: z
        .string()
        .regex(DOOR_PLATFORM_ID)
        .refine((id) => doorPlatform(id) !== undefined, "a platform of vocab/door-platforms.json, like fresha or toast")
        .optional()
        .describe(
          "The platform the page is on, from vocab/door-platforms.json (fresha, opentable, toast, shopify…). Left out for any other page.",
        ),
    })
    .superRefine((d, ctx) => {
      const p = doorPlatform(d.platform);
      if (!p) return;
      const fit = doorPlatformFit(d.url, p, d.itemType);
      const kinds = p.item_types.map((t) => (t === "booking" ? "bookings" : "orders")).join(" and ");
      if (fit === "kind")
        ctx.addIssue({ code: "custom", path: ["platform"], message: `${p.name} takes ${kinds} only` });
      else if (fit === "not_on_platform")
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: `that link is not on ${p.name}: paste the link to your page there, or pick Another page`,
        });
      else if (fit === "platform_page")
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: `that is ${p.name}'s own page: paste the link to your business's page on ${p.name}`,
        });
    });
}

/**
 * One door elsewhere as a stored document is read: as leniently as `readDoorsElsewhere` reads a manifest. The link is
 * cleaned of tracking (`cleanDoorUrl`) and a platform that no longer fits it, or that this vocabulary no longer knows,
 * is dropped, but the door stands. A door saved before 0.10.0 with `?utm_source=` on it, or one on a host a later
 * vocabulary narrows away, is never lost: losing it would put bookings back here while the platform still takes them.
 * What a write may set is `doorElsewhereSettingSchema`'s.
 */
export function doorElsewhereStoredSchema() {
  return z.preprocess(
    (raw) => {
      if (!isPlainObject(raw)) return raw;
      const door: Record<string, unknown> = { ...raw };
      if (typeof door.url === "string") door.url = cleanDoorUrl(door.url);
      if ("platform" in door) {
        const p = doorPlatform(door.platform);
        const fit = p && typeof door.url === "string" ? doorPlatformFit(door.url, p, String(door.itemType)) : null;
        if (fit !== "on_platform" && fit !== "own_site") delete door.platform;
      }
      return door;
    },
    z.object({
      itemType: z.enum(["booking", "order"]),
      url: z
        .url({ protocol: /^https$/ })
        .max(2048)
        .refine(isDoorElsewhereUrl, "an https address on a public host, with no user or password in it"),
      platform: z.string().regex(DOOR_PLATFORM_ID).optional(),
    }),
  );
}

/**
 * Kinds of request the business takes somewhere else, and where: bookings at a booking platform,
 * orders in its own shop's checkout. Each is named in the manifest (`doors_elsewhere`) and on the
 * business's own page ("Book at …"), and is no longer among the kinds the inbox lists as its own,
 * so an agent goes there for it. It sends customers to another address, so the owner's AI may not
 * change it (`guard.ts`). A write is held to every rule of a door (`doorElsewhereSettingSchema`); a
 * stored document is read leniently (`doorElsewhereStoredSchema`), so no upgrade loses a door.
 */
function doorsElsewhereList<T extends z.ZodType<{ readonly itemType: "booking" | "order" }>>(door: T) {
  return z
    .array(door)
    .max(2)
    .refine((all) => new Set(all.map((d) => d.itemType)).size === all.length, "one place for each kind")
    .default([])
    .describe(
      "Kinds of request you take somewhere else, and where: bookings at a booking platform, orders in your own checkout.",
    );
}

const doorsElsewhereRead = doorsElsewhereList(doorElsewhereStoredSchema());
const doorsElsewhereWrite = doorsElsewhereList(doorElsewhereSettingSchema());

/**
 * The business's own: a page on a platform that also serves the business's domain (`own_site`) and is not on the
 * platform's own hosts must be on one of the business's own domains (`business.domain`, the website in
 * `directory.url`) or a name under one, so a door never names a stranger's shop as the business's checkout. With no
 * domain of its own set, such a page is refused until the owner adds the website. Paths are the write's (`doc.…`).
 */
export function doorElsewhereDomainProblems(
  entries: readonly Settings["doorsElsewhere"][number][],
  domains: readonly (string | null | undefined)[],
): { path: string; problem: "invalid"; message: string }[] {
  const own = domains.map(ownSiteDomain).filter((d) => d !== "");
  return entries.flatMap((d, i) => {
    const p = doorPlatform(d.platform);
    if (!p?.own_site || doorPlatformFit(d.url, p, d.itemType) !== "own_site") return [];
    if (own.some((o) => hostIsOn(new URL(d.url).hostname, o))) return [];
    const what = d.itemType === "order" ? "shop" : "page";
    const where = p.hosts.length ? `on your website (${own[0]}) or on ${p.name}` : `on your website (${own[0]})`;
    return [
      {
        path: `doc.doorsElsewhere.${i}.url`,
        problem: "invalid" as const,
        message: own.length
          ? `that link is not ${where}: paste your own page's link`
          : `add your website in General first, so agents know this ${what} is yours`,
      },
    ];
  });
}

/**
 * The doors elsewhere as the manifest, the business's profile and its page name them: each with its platform, the
 * one the owner picked, or else the one the page is plainly on (a Fresha page pasted as "Another page" still says
 * Fresha). A platform that serves the business's own domain is named only for a page on one of `ownDomains` (the
 * business's domain, its website), checked each time, so a door whose domain no longer matches keeps its link and
 * loses the name. Never a platform for a page on the business's own website that the owner did not name.
 */
export function publishedDoorsElsewhere(
  entries: Settings["doorsElsewhere"],
  ownDomains: readonly (string | null | undefined)[] = [],
): DoorElsewhere[] {
  const own = ownDomains.map(ownSiteDomain).filter((d) => d !== "");
  return entries.map((d) => {
    const named = doorPlatform(d.platform);
    const platform =
      named && doorPlatformHolds(d.url, named, d.itemType, own) ? named.id : doorPlatformOf(d.url, d.itemType)?.id;
    return { item_type: d.itemType, url: d.url, ...(platform ? { platform } : {}) };
  });
}

/** Settings paths that hold a secret: never returned by a read, only ever written. */
export const SECRET_SETTINGS_PATHS: readonly (readonly [string, string])[] = [["email", "inboundSecret"]];

/**
 * What a read shows in place of a secret that is set. The key stays in the document, so a client
 * that read the previous shape keeps working: one that writes the document back as it read it
 * sends this, and a write that carries it keeps the stored secret (it is too short to be one). An
 * owner app tab opened before the upgrade therefore saves General without wiping the secret the
 * mail gateway authenticates with; leaving the key out would have made it send `null`, which removes.
 */
export const REDACTED_SECRET = "(redacted)";

export const NETWORK_KEY_RULE =
  "a network is an https origin on a public host, like https://network.example.com: no path, no port other than 443";

/** The top-level keys a settings write may name; `network` is the legacy spelling, translated. */
export const SETTINGS_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(sections),
  "doorsElsewhere",
  "networks",
  "network",
]);

/**
 * Reading: keys are canonicalised, anything that is not an https origin is dropped, and at most
 * eight are kept (switched-on ones first), so a hand-edited document can never break the rest.
 * Each entry falls back to a switched-off one when it does not parse (ADR-017 §8.1).
 */
const networksRead = z
  .preprocess(
    cleanNetworks,
    z.record(
      z.string(),
      networkEntrySchema.catch(() => disabledNetwork()),
    ),
  )
  .default(defaultNetworks);

/** Writing: the same shape, strict — a bad key or entry is a field error, never a silent "off". */
const networksWrite = z
  .record(z.string(), networkEntrySchema)
  .superRefine((networks, ctx) => {
    for (const key of Object.keys(networks)) {
      if (canonicalNetworkOrigin(key) !== key) {
        ctx.addIssue({ code: "custom", path: [key], message: NETWORK_KEY_RULE });
      }
    }
    if (Object.keys(networks).length > MAX_NETWORKS) {
      ctx.addIssue({
        code: "custom",
        message: `at most ${MAX_NETWORKS} networks; remove one that is switched off first`,
      });
    }
  })
  .default(defaultNetworks);

/** The settings as every reader sees them. Parse stored documents with `parseStoredSettings`. */
export const settingsSchema = z.preprocess(
  migrateLegacyNetwork,
  z.object({ ...sections, doorsElsewhere: doorsElsewhereRead, networks: networksRead }),
);
/** The strict form a write is checked against before anything is stored. */
export const settingsWriteSchema = z.preprocess(
  migrateLegacyNetwork,
  z.object({ ...sections, doorsElsewhere: doorsElsewhereWrite, networks: networksWrite }),
);
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

/**
 * Before `networks` there was one network: `network: { url, join }`. When a stored document has
 * no `networks` yet, the legacy pair is read as a map with one entry, so an instance that had
 * joined keeps reporting to the same network after the upgrade with nothing for the owner to do.
 * A legacy URL that was never usable (not https on a public host) yields no entry, as it never
 * reached a network before either.
 */
export function legacyNetworks(legacy: unknown): Record<string, unknown> {
  const l = isPlainObject(legacy) ? legacy : {};
  const origin = l.url === undefined ? DEFAULT_NETWORK : networkOriginOfUrl(l.url);
  if (!origin) return {};
  return {
    [origin]: { enabled: l.join === true, issue: true, share: { listing: true, counts: true, receipts: true } },
  };
}

function migrateLegacyNetwork(raw: unknown): unknown {
  if (!isPlainObject(raw) || raw.networks !== undefined || !isPlainObject(raw.network)) return raw;
  return { ...raw, networks: legacyNetworks(raw.network) };
}

function cleanNetworks(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const kept: [string, unknown][] = [];
  const seen = new Set<string>();
  for (const [key, entry] of Object.entries(raw)) {
    const origin = canonicalNetworkOrigin(key);
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    kept.push([origin, entry]);
  }
  if (kept.length > MAX_NETWORKS) {
    const on = (e: unknown) => isPlainObject(e) && e.enabled === true;
    const keep = new Set([...kept.filter(([, e]) => on(e)), ...kept.filter(([, e]) => !on(e))].slice(0, MAX_NETWORKS));
    return Object.fromEntries(kept.filter((k) => keep.has(k)));
  }
  return Object.fromEntries(kept);
}

/**
 * A stored document as this version reads it. A value it rejects is left out, so its default
 * applies, and only that value: the rest of the document stands. `ignored` names what was left
 * out (`booking.autoExpireHours`), for whoever wants to tell the owner.
 */
export function parseStoredSettings(raw: unknown): { settings: Settings; ignored: string[] } {
  let doc: unknown = isPlainObject(raw) ? structuredClone(raw) : {};
  const ignored: string[] = [];
  // Each pass removes at least one offending value, so this ends; the bound is only a backstop.
  for (let pass = 0; pass < 50; pass++) {
    const parsed = settingsSchema.safeParse(doc);
    if (parsed.success) return { settings: parsed.data, ignored };
    let removed = false;
    for (const issue of parsed.error.issues) {
      // An array is one value to the owner: a bad element drops the list, not the element.
      const cut = issue.path.findIndex((p) => typeof p !== "string");
      const path = (cut === -1 ? issue.path : issue.path.slice(0, cut)).map(String);
      if (path.length === 0) {
        doc = {};
        removed = true;
        break;
      }
      if (deleteAt(doc, path)) {
        ignored.push(path.join("."));
        removed = true;
      }
    }
    if (!removed) break;
  }
  return { settings: DEFAULT_SETTINGS, ignored: [...ignored, "(the whole document)"] };
}

function deleteAt(doc: unknown, path: readonly string[]): boolean {
  let node: unknown = doc;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(node)) return false;
    node = node[key];
  }
  const last = path[path.length - 1];
  if (!isPlainObject(node) || last === undefined || !(last in node)) return false;
  delete node[last];
  return true;
}

export async function readSettings(db: Db): Promise<Settings> {
  const [row] = await db.orm.select({ doc: settingsTable.doc }).from(settingsTable).limit(1);
  if (!row) return DEFAULT_SETTINGS;
  return parseStoredSettings(row.doc).settings;
}

/**
 * The networks that are switched on, by origin, sorted. With `share`, only those that share that:
 * `"receipts"` is who receipts are published to and who the manifest names.
 */
export function enabledNetworks(settings: Settings, share?: NetworkShare): string[] {
  return Object.entries(settings.networks)
    .filter(([, n]) => n.enabled && (share === undefined || n.share[share]))
    .map(([origin]) => origin)
    .sort();
}

/** Whether a switched-on network gets anything at all: with nothing to share there is no reason to call it. */
export function reportsTo(entry: NetworkEntry | undefined): entry is NetworkEntry {
  return !!entry?.enabled && (entry.share.listing || entry.share.counts || entry.share.receipts);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
