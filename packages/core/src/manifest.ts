import { type Manifest, manifestSchema, type Profile } from "@surfingdog/spec";
import { AGENT_GUIDE_URL } from "./identity/types";

/** The discovery manifest: what this instance accepts and where each door is. */
export function buildManifest(input: {
  instanceUrl: string;
  itemTypes?: readonly string[];
  profile?: Profile | undefined;
  reviewServices?: readonly string[];
  /** The instance's receipt-signing public keys (ADR-016), as `/.well-known/jwks.json` serves them. */
  receiptKeys?: readonly Record<string, unknown>[] | undefined;
  /** ADR-017 §8.4: the networks whose people it recognises, and whether it can present passes at all. */
  identity?: { readonly passes: boolean; readonly networks: readonly string[] } | undefined;
  /**
   * Whether to be in the networks' directories (ADR-017 A2.3): `{listed: false}` leaves them all,
   * and absent means listed. It is the one switch for every network at once, for the networks this
   * inbox cannot sign a `POST /v1/instances/{domain}/listing` to; the signed call says it per network.
   */
  directory?: { readonly listed: boolean } | undefined;
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
      // The owner's door (`/mcp/owner`) is still served, for the owner's own AI; it is not a door
      // for anyone the manifest is for, so it is not advertised.
    },
    agent_policy: {
      tiers: ["anonymous", "signed_agent", "verified_principal", "reputed_principal"],
      // Both are verified on every public door (`protocol/httpsig.ts`): the agent's own key, or a
      // platform's directory named by Signature-Agent (Web Bot Auth).
      signatures: ["sdi-agent/1", "web-bot-auth"],
      passes: input.identity?.passes ?? false,
      networks: [...(input.identity?.networks ?? [])],
      guide: AGENT_GUIDE_URL,
    },
    receipt_keys: { keys: input.receiptKeys ?? [] },
    review_services: input.reviewServices ?? [],
    ...(input.directory ? { directory: { listed: input.directory.listed } } : {}),
  });
}
