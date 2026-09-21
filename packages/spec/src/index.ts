import { z } from "zod";

/**
 * The discovery manifest an instance publishes at MANIFEST_PATH. Tiny on purpose: it says what
 * the instance accepts and where each protocol endpoint lives; agents pick the door they prefer.
 * The path is a single constant so the final well-known name (ADR-002) is a one-line change.
 */
export const MANIFEST_PATH = "/.well-known/inbox.json";

export const itemTypeSchema = z.enum(["message", "quote_request", "booking", "order", "refund"]);
export type ItemType = z.infer<typeof itemTypeSchema>;

export const trustTierSchema = z.enum(["anonymous", "signed_agent", "verified_principal", "reputed_principal"]);

export const manifestSchema = z.object({
  spec: z.literal("surfingdog-inbox/0"),
  instance: z.url(),
  item_types: z.array(itemTypeSchema),
  /** Protocol name → entry URL (openapi, mcp, a2a, ucp, arp, email, form, …). */
  protocols: z.record(z.string(), z.url()),
  agent_policy: z.object({ tiers: z.array(trustTierSchema).min(1) }),
  /** JWKS with the instance's Ed25519 receipt-signing keys. */
  receipt_keys: z.object({ keys: z.array(z.record(z.string(), z.unknown())) }),
  review_services: z.array(z.url()),
});
export type Manifest = z.infer<typeof manifestSchema>;
