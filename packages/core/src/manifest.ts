import { type Manifest, manifestSchema } from "@surfingdog/spec";

/** Builds the discovery manifest for an instance. Settings-driven in the first release. */
export function buildManifest(input: { instanceUrl: string }): Manifest {
  return manifestSchema.parse({
    spec: "surfingdog-inbox/0",
    instance: input.instanceUrl,
    item_types: [],
    protocols: {},
    agent_policy: { tiers: ["anonymous"] },
    receipt_keys: { keys: [] },
    review_services: [],
  });
}
