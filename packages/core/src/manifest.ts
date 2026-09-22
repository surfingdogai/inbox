import { type Manifest, manifestSchema, type Profile } from "@surfingdog/spec";

/** The discovery manifest: what this instance accepts and where each door is. */
export function buildManifest(input: {
  instanceUrl: string;
  itemTypes?: readonly string[];
  profile?: Profile | undefined;
  reviewServices?: readonly string[];
  /** The instance's receipt-signing public keys (ADR-016), as `/.well-known/jwks.json` serves them. */
  receiptKeys?: readonly Record<string, unknown>[] | undefined;
}): Manifest {
  const origin = input.instanceUrl.replace(/\/$/, "");
  return manifestSchema.parse({
    spec: "surfingdog-inbox/0",
    instance: origin,
    ...(input.profile ? { profile: input.profile } : {}),
    item_types: input.itemTypes ?? [],
    protocols: {
      openapi: `${origin}/openapi.json`,
      rest: `${origin}/v1`,
      mcp: `${origin}/mcp`,
      mcp_owner: `${origin}/mcp/owner`,
    },
    agent_policy: { tiers: ["anonymous", "verified_principal"] },
    receipt_keys: { keys: input.receiptKeys ?? [] },
    review_services: input.reviewServices ?? [],
  });
}
