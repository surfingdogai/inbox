/**
 * @surfingdog/core — domain model, state machines, rules engine, receipts.
 * Web-standard APIs only. the first release fills this in; the groundwork exposes the manifest shape so the app
 * and the tests have something real to serve on both runtimes.
 */
import { type Manifest, manifestSchema } from "@surfingdog/spec";

export const VERSION = "0.0.0";

export type { Manifest } from "@surfingdog/spec";
export { MANIFEST_PATH, manifestSchema } from "@surfingdog/spec";

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
