import { z } from "zod";
import type { Db } from "../db";
import { settings as settingsTable } from "../schema/tables";
import { canonicalNetworkOrigin, networkOriginOfUrl } from "../util/hosts";

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
    })
    .prefault({}),
});
export type NetworkEntry = z.infer<typeof networkEntrySchema>;
export type NetworkShare = keyof NetworkEntry["share"];

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
      /** Customers reply here; usually the business mailbox. */
      replyTo: z.email().optional(),
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
       */
      emailKey: z
        .boolean()
        .default(true)
        .describe(
          "A day after a new customer's first booking or order, email them a code their assistant can show next time so you recognise them.",
        ),
    })
    .prefault({}),
  testMode: z.boolean().default(false),
};

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
export const SETTINGS_KEYS: ReadonlySet<string> = new Set([...Object.keys(sections), "networks", "network"]);

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
export const settingsSchema = z.preprocess(migrateLegacyNetwork, z.object({ ...sections, networks: networksRead }));
/** The strict form a write is checked against before anything is stored. */
export const settingsWriteSchema = z.preprocess(
  migrateLegacyNetwork,
  z.object({ ...sections, networks: networksWrite }),
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
