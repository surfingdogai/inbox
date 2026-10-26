import { z } from "zod";
import { DOOR_PLATFORM_ID, doorPlatform, doorPlatformHolds, ownSiteDomain } from "./door-platforms";
import { MAX_PROFILE_PAYMENTS } from "./payments";

/**
 * The discovery manifest an instance publishes at MANIFEST_PATH. Tiny on purpose: it says what
 * the instance accepts and where each protocol endpoint lives; agents pick the door they prefer.
 * The path is a single constant so the final well-known name (ADR-002) is a one-line change.
 */
export const MANIFEST_PATH = "/.well-known/agent-inbox.json";

export const itemTypeSchema = z.enum(["message", "quote_request", "booking", "order", "refund"]);
export type ItemType = z.infer<typeof itemTypeSchema>;

export const trustTierSchema = z.enum(["anonymous", "signed_agent", "verified_principal", "reputed_principal"]);

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
/** A closing time: HH:MM, or 24:00 for a window that runs to midnight. */
const closes = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, "use HH:MM, or 24:00 for midnight");

/**
 * One opening window, `[opens, closes)` in the business's zone. Closing is after opening: no overnight
 * windows. A window may close at 24:00, so `["00:00", "24:00"]` is the whole day; open through the
 * night is a window to 24:00 and the next day's from 00:00.
 */
export const openingWindowSchema = z
  .tuple([hhmm, closes])
  .refine(([opens, closes]) => opens < closes, { message: "closing time must be after opening time" });
const openingDay = z.array(openingWindowSchema).max(6);

/** The inbox's own weekly hours: windows per weekday, at most six a day; a day left out is closed. */
export const weeklyHoursSchema = z
  .object({
    mon: openingDay,
    tue: openingDay,
    wed: openingDay,
    thu: openingDay,
    fri: openingDay,
    sat: openingDay,
    sun: openingDay,
  })
  .partial();

/** Whole days closed, inclusive, as dates in the business's zone. */
export const closureDaysSchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((c) => c.to >= c.from, { message: "to must not be before from", path: ["to"] });

/**
 * When the business is open (ADR-017 A2.5): its weekly hours and closures exactly as the inbox keeps them, with the
 * IANA zone they are in. A network keeps them only with a zone it knows and at least one good window, and shows
 * closures that have not ended.
 */
export const profileHoursSchema = z.object({
  timezone: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "IANA zone, e.g. America/Toronto, Africa/Nairobi or Asia/Kolkata: every time and date in hours is in it.",
    ),
  weekly: weeklyHoursSchema,
  closures: z.array(closureDaysSchema).max(100).default([]),
});
export type ProfileHours = z.infer<typeof profileHoursSchema>;

/** A service the business offers, by name, and how it is taken; prices and durations stay at the inbox. */
export const profileServiceSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(["booking", "order", "quote_request"]),
});

/**
 * Public profile data the directory may index. Nothing else about a business ever leaves the instance. A network
 * checks each field alone and drops a bad one alone (ADR-017 A2.5; `vectors/profile.json`).
 */
export const profileSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  categories: z
    .array(z.string().max(60))
    .max(10)
    .default([])
    .describe(
      "Slugs from vocab/categories.json (a label or synonym in any of its languages is read as its slug); anything else is kept as a free tag.",
    ),
  languages: z.array(z.string().max(12)).max(10).default([]),
  address: z
    .object({
      streetAddress: z.string().max(200).optional(),
      addressLocality: z.string().max(100).optional(),
      postalCode: z.string().max(20).optional(),
      addressCountry: z.string().length(2).optional(),
    })
    .optional(),
  geo: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional(),
  url: z.url().optional(),
  contact_email: z.email().optional(),
  hours: profileHoursSchema.optional(),
  services: z.array(profileServiceSchema).max(30).optional(),
  // Protocol 0.2 (network.md §4.6). A network checks each alone and drops a bad one alone.
  place_category: z
    .object({
      primary: z.string().max(80),
      alternates: z.array(z.string().max(80)).max(2).optional(),
    })
    .optional()
    .describe("Overture Place Categories ids (GET /v1/categories?group=…): what the business is, most specific first."),
  attributes: z
    .record(z.string().max(60), z.union([z.boolean(), z.string().max(60)]))
    .optional()
    .describe("Keys of a network's GET /v1/attributes: true, or one of the key's values."),
  price_band: z.int().min(1).max(4).optional().describe("1 (cheapest) to 4."),
  currencies: z
    .array(z.string().regex(/^[A-Z]{3}$/))
    .max(5)
    .optional()
    .describe("ISO 4217."),
  payments: z
    .array(z.string().regex(/^[a-z0-9_]{2,40}$/))
    .max(MAX_PROFILE_PAYMENTS)
    .optional()
    .describe(
      "How a customer or their agent can pay: tokens of vocab/payments.json (card, apple_pay, paypal, pix…). A network keeps the tokens it knows and drops the rest alone; a card brand (visa) says card too.",
    ),
});
export type Profile = z.infer<typeof profileSchema>;

/**
 * A receipt: the signed record an instance issues when an item completes, and the proof both
 * sides end up holding (ADR-016).
 *
 * **These claim names are frozen.** A receipt outlives the software that wrote it, and renaming
 * a claim later invalidates every receipt already issued. Three-letter names because a receipt
 * travels in headers and URLs; `iss`, `sub` and `iat` are RFC 7519 and mean what they mean there.
 */
/** The kinds a v1 receipt's `knd` may carry (ADR-016). Frozen with the v1 claims. */
export const receiptKindV1Schema = z.enum(["confirmed", "paid"]);
export type ReceiptKindV1 = z.infer<typeof receiptKindV1Schema>;

/**
 * Every kind of receipt an inbox issues and returns on an item: the v1 promises, and since claims
 * v2 (ADR-017 §3.2) the promise `accepted` and the `outcome` that closes a promise; since rules
 * version 6 (ADR-017 Amendment 3) also `amended`, a change to a promise both sides agreed. A v1
 * receipt's claims still name only the v1 kinds.
 */
export const receiptKindSchema = z.enum(["confirmed", "paid", "accepted", "outcome", "amended"]);
export type ReceiptKind = z.infer<typeof receiptKindSchema>;

export const moneySchema = z.object({
  value: z
    .number()
    .int()
    .describe(
      "Minor units in the currency's ISO 4217 exponent: 4500 is CA$45.00 or ₹45.00, ¥4,500 in JPY, 4.500 in KWD.",
    ),
  currency: z.string().length(3),
});

export const receiptPayloadSchema = z.object({
  /** The issuing instance, an https origin with no trailing slash. */
  iss: z.url(),
  /**
   * Who the receipt is about, pseudonymously: base64url(HMAC-SHA-256(instance pepper, identity)).
   * Never an address, and never a bare hash of one — an address space is small enough to enumerate. Two receipts for one customer on one instance share it, which is what
   * makes a reputation possible; the same customer elsewhere does not, which is what stops one
   * being assembled about them without their knowledge.
   */
  sub: z.string().min(16).max(64),
  /** The item's id on the issuing instance. */
  itm: z.string().min(1).max(64),
  typ: itemTypeSchema,
  knd: receiptKindV1Schema,
  iat: z.number().int().positive().describe("Issued at, Unix seconds."),
  /** 128 bits of hex. A network deduplicates on (iss, nonce), so a receipt shows once. */
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  amt: moneySchema.optional(),
  pay: z.string().max(40).optional().describe("How it was paid, when the instance knows."),
});
export type ReceiptPayload = z.infer<typeof receiptPayloadSchema>;

/** The JOSE header an instance signs with. `alg` is EdDSA and nothing else is accepted. */
export const receiptHeaderSchema = z.object({
  alg: z.literal("EdDSA"),
  typ: z.literal("sdi-receipt+jws"),
  kid: z.string().min(1).max(128),
});
export type ReceiptHeader = z.infer<typeof receiptHeaderSchema>;

/** What a customer's agent counter-signs, to say it holds the same receipt. */
export const receiptAckPayloadSchema = z.object({
  rcp: z.string().min(1).max(64).describe("The receipt's id on the issuing instance."),
  /**
   * base64url(SHA-256(the receipt's compact JWS, as UTF-8)), no padding. This is what makes the
   * acknowledgement verifiable by anyone holding the two JWS strings and nothing else: a network
   * never sees the instance's receipt ids, but it can hash what it was handed.
   */
  sha: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .describe("base64url(SHA-256(receipt JWS))."),
  iat: z.number().int().positive(),
});
export type ReceiptAckPayload = z.infer<typeof receiptAckPayloadSchema>;

/**
 * What an instance sends each network it publishes receipts to: `POST <network>/v1/receipts`. The
 * network verifies the receipt against the keys published at the issuer's own domain and, when
 * an acknowledgement is present, the acknowledgement against the key it carries and the
 * receipt's hash. Nothing in the body is trusted; everything in it is checked.
 */
export const receiptPublishSchema = z.object({
  receipt: z.string().min(1).max(8_192).describe("The receipt, a compact JWS."),
  ack: z.string().min(1).max(8_192).optional().describe("The customer agent's acknowledgement, when there is one."),
});
export type ReceiptPublish = z.infer<typeof receiptPublishSchema>;

/** The service's answer. `duplicate` means it already held this receipt in this state. */
export const receiptPublishResultSchema = z.object({
  ok: z.literal(true),
  state: z.enum(["issued", "acknowledged"]),
  duplicate: z.boolean(),
});
export type ReceiptPublishResult = z.infer<typeof receiptPublishResultSchema>;

/**
 * A kind of request the business takes somewhere else, and where: bookings at a booking platform,
 * orders in its own shop's checkout. An agent goes there for that kind, and to the inbox for the rest.
 * A writer names a kind once, and never a kind it lists in `item_types`; a reader holds every
 * manifest to that with `readDoorsElsewhere` (`vectors/doors-elsewhere.json`).
 *
 * `platform` (0.9.0, ADR-031) names the platform the page is on, from `vocab/door-platforms.json`, so an
 * agent can say "Book at Fresha". A reader that does not know it, or the token it names, goes by the URL.
 */
export const doorElsewhereSchema = z.object({
  item_type: itemTypeSchema,
  url: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .describe("Where to go for it: an https page on a named host, with no user or password in it."),
  platform: z
    .string()
    .regex(DOOR_PLATFORM_ID)
    .optional()
    .describe(
      "The platform the page is on, from vocab/door-platforms.json (fresha, opentable, shopify…), only when the page is the business's own page there. Absent for any other page.",
    ),
});
export type DoorElsewhere = z.infer<typeof doorElsewhereSchema>;

/**
 * What a reader keeps of a manifest's `doors_elsewhere`, each entry checked alone and dropped alone:
 * one of the five item types, not one the manifest lists in `item_types` (the inbox takes those
 * itself) and not one an entry kept before it names; and a URL, kept as written, that is https,
 * at most 2048 characters, with no user or password, on a host name of two labels or more whose
 * last label starts with a letter, so never an IP address. Anything else about the manifest is
 * not this function's to judge.
 *
 * Since 0.9.0 an entry's `platform` is kept with it when the vocabulary knows the token, the platform takes
 * that kind of request, and the URL is the business's own page there; or the platform serves pages on the
 * business's own domain (`own_site`) and the URL's host is on the business's own website, the manifest's
 * `profile.url`. A reader never trusts an `own_site` token on any other host: anyone can call a stranger's
 * shop theirs. Otherwise the platform alone is dropped and the entry is kept: a door is never lost for its name.
 */
export function readDoorsElsewhere(manifest: unknown): DoorElsewhere[] {
  const m = (typeof manifest === "object" && manifest !== null ? manifest : {}) as Record<string, unknown>;
  const entries = Array.isArray(m.doors_elsewhere) ? (m.doors_elsewhere as unknown[]) : [];
  const here = new Set(Array.isArray(m.item_types) ? m.item_types : []);
  const profile = (typeof m.profile === "object" && m.profile !== null ? m.profile : {}) as Record<string, unknown>;
  const own = typeof profile.url === "string" ? [ownSiteDomain(profile.url)] : [];
  const kept: DoorElsewhere[] = [];
  for (const entry of entries) {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const type = itemTypeSchema.safeParse(e.item_type);
    if (!type.success || here.has(type.data) || kept.some((k) => k.item_type === type.data)) continue;
    const url = elsewhereUrl(e.url);
    if (!url) continue;
    const platform = elsewherePlatform(e.platform, url, type.data, own);
    kept.push({ item_type: type.data, url, ...(platform ? { platform } : {}) });
  }
  return kept;
}

function elsewherePlatform(value: unknown, url: string, kind: string, own: readonly string[]): string | null {
  if (typeof value !== "string" || !DOOR_PLATFORM_ID.test(value)) return null;
  const platform = doorPlatform(value);
  return platform && doorPlatformHolds(url, platform, kind, own) ? platform.id : null;
}

function elsewhereUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  // A name of two labels or more whose last one starts with a letter: never an IP address, however written.
  const labels = url.hostname.replace(/\.$/, "").split(".");
  if (labels.length < 2 || !/^[a-z]/i.test(labels[labels.length - 1] ?? "")) return null;
  return value;
}

/** `vocab/door-platforms.json` (0.9.0): the platforms a door elsewhere may name, as a JSON Schema checks it. */
export const doorPlatformsVocabSchema = z.object({
  version: z.int().min(1),
  description: z.string(),
  groups: z.array(z.object({ id: z.string().regex(DOOR_PLATFORM_ID), label: z.string().min(1).max(60) })).min(1),
  tracking_params: z.array(z.string().regex(/^[a-z0-9_]+\*?$/)),
  reserved_subdomains: z
    .array(z.string().regex(/^[a-z0-9-]+$/))
    .describe("Names under a platform's host that are the platform's own (help, app, admin…), never a business's."),
  reserved_paths: z
    .array(z.string().regex(/^[a-z0-9-]+$/))
    .describe("First path segments that are a platform's own pages (login, pricing, blog…), never a business's."),
  platforms: z.array(
    z.object({
      id: z
        .string()
        .regex(DOOR_PLATFORM_ID)
        .describe("The token a doors_elsewhere entry names, and a door type platform:<id>."),
      name: z.string().min(1).max(60),
      group: z.string().regex(DOOR_PLATFORM_ID),
      item_types: z.array(z.enum(["booking", "order"])).min(1),
      hosts: z
        .array(z.string().regex(/^([a-z0-9-]+\.)+[a-z][a-z0-9-]*$/))
        .describe("Registrable names: a host is on the platform when it is one of these or a name under one."),
      page: z
        .enum(["path", "subdomain", "any"])
        .describe(
          "How the business's own page is told apart on a platform with no pages: a path other than / whose first segment is not reserved, a name under the host other than www and the reserved names, or either.",
        ),
      pages: z
        .array(
          z
            .string()
            .min(2)
            .max(200)
            .refine((re) => {
              try {
                new RegExp(re, "i");
                return true;
              } catch {
                return false;
              }
            }, "a pattern a JavaScript RegExp reads"),
        )
        .optional()
        .describe(
          "Where the platform's pages for a business are known to sit: patterns, matched without regard to case against the host without www. followed by the path. With them, a page there is the business's own only when one matches.",
        ),
      own_site: z
        .boolean()
        .optional()
        .describe(
          "The platform also serves the business's pages on the business's own domain, named there by their host.",
        ),
      source: z.url().describe("The platform's own public page or help the hosts were read from."),
    }),
  ),
});

export const manifestSchema = z.object({
  spec: z.literal("surfingdog-inbox/0"),
  instance: z.url(),
  profile: profileSchema.optional(),
  item_types: z.array(itemTypeSchema),
  /** Protocol name → entry URL (openapi, mcp, a2a, ucp, arp, email, form, …). */
  protocols: z.record(z.string(), z.url()),
  agent_policy: z.object({
    tiers: z.array(trustTierSchema).min(1),
    /** Request signatures this instance verifies (ADR-017 §2.4): `sdi-agent/1`, Web Bot Auth compatible. */
    signatures: z.array(z.string().max(40)).max(8).optional(),
    /** Whether it presents a person's passes and keys (`pass`/`key` fields, `Sdi-Pass`) to their networks. */
    passes: z.boolean().optional(),
    /** The networks whose people it recognises, and which may issue a first contact a key through it. */
    networks: z.array(z.url()).max(8).optional(),
    /** How an agent identifies itself and its person here, step by step (R26). */
    guide: z.url().optional(),
  }),
  /** JWKS with the instance's Ed25519 receipt-signing keys. */
  receipt_keys: z.object({ keys: z.array(z.record(z.string(), z.unknown())) }),
  /** The networks this instance publishes its receipts to, as https origins; empty when none. */
  review_services: z.array(z.url()),
  /**
   * Whether to be in the networks' directories (ADR-017 A2.3), for an inbox that cannot sign its calls:
   * `{"listed": false}` leaves, and saying nothing or `true` comes back. A network acts when this changes,
   * and it never undoes a signed `POST /v1/instances/{domain}/listing`.
   */
  directory: z.object({ listed: z.boolean() }).optional(),
  /**
   * Whether a network may carry an assistant's request to this inbox (ADR-025; network.md §4.17): a
   * question, a request for a quote or for a booking, sent through this inbox's own public API with the
   * person's email address, given with their consent. An inbox with the owner's switch publishes it
   * either way: `{"accepted": true}`, the default, says yes; `{"accepted": false}` says no to every
   * network. Saying nothing is an inbox from before the switch, whose owner could not say no: a network
   * carries nothing to it.
   */
  carried_requests: z.object({ accepted: z.boolean() }).optional(),
  /**
   * Claim tokens, by network host (network.md §4.12): how a business proves to a network that its manifest is its own
   * when it registers or claims a listing there. Protocol 0.2.
   */
  claims: z.record(z.string().max(253), z.string().max(200)).optional(),
  /**
   * Kinds of request the business takes somewhere else, and where: `[{"item_type": "booking", "url":
   * "https://…", "platform": "fresha"}]`. Absent or empty, the inbox's own doors are all there is.
   */
  doors_elsewhere: z.array(doorElsewhereSchema).max(5).optional(),
  /**
   * Where a network reads the business's products (network.md §4.18, spec 0.9), while its owner lists
   * them on networks: the signed feed of changes, and products by id. Absent, it lists none.
   */
  catalogue: z.object({ feed: z.url({ protocol: /^https$/ }), items: z.url({ protocol: /^https$/ }) }).optional(),
});
export type Manifest = z.infer<typeof manifestSchema>;
