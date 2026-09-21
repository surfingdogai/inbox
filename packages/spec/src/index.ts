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
