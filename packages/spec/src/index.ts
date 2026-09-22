import { z } from "zod";

/**
 * The discovery manifest an instance publishes at MANIFEST_PATH. Tiny on purpose: it says what
 * the instance accepts and where each protocol endpoint lives; agents pick the door they prefer.
 * The path is a single constant so the final well-known name (ADR-002) is a one-line change.
 */
export const MANIFEST_PATH = "/.well-known/agent-inbox.json";

export const itemTypeSchema = z.enum(["message", "quote_request", "booking", "order", "refund"]);
export type ItemType = z.infer<typeof itemTypeSchema>;

export const trustTierSchema = z.enum(["anonymous", "signed_agent", "verified_principal", "reputed_principal"]);

/** Public profile data the directory may index. Nothing else about a business ever leaves the instance. */
export const profileSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  categories: z.array(z.string().max(60)).max(10).default([]),
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
export const receiptKindSchema = z.enum(["confirmed", "paid"]);
export type ReceiptKind = z.infer<typeof receiptKindSchema>;

export const moneySchema = z.object({
  value: z.number().int().describe("Minor units: 4500 is €45.00."),
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
  knd: receiptKindSchema,
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
  iat: z.number().int().positive(),
});
export type ReceiptAckPayload = z.infer<typeof receiptAckPayloadSchema>;

export const manifestSchema = z.object({
  spec: z.literal("surfingdog-inbox/0"),
  instance: z.url(),
  profile: profileSchema.optional(),
  item_types: z.array(itemTypeSchema),
  /** Protocol name → entry URL (openapi, mcp, a2a, ucp, arp, email, form, …). */
  protocols: z.record(z.string(), z.url()),
  agent_policy: z.object({ tiers: z.array(trustTierSchema).min(1) }),
  /** JWKS with the instance's Ed25519 receipt-signing keys. */
  receipt_keys: z.object({ keys: z.array(z.record(z.string(), z.unknown())) }),
  review_services: z.array(z.url()),
});
export type Manifest = z.infer<typeof manifestSchema>;
