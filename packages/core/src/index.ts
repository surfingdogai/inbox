/**
 * @surfingdog/core — domain model, state machines, rules engine, receipts.
 * Web-standard APIs only; runtimes plug in through @surfingdog/platform.
 */

export type { Manifest } from "@surfingdog/spec";
export { MANIFEST_PATH, manifestSchema } from "@surfingdog/spec";
export * from "./capabilities/index";
export { createDb, type Db, type Orm, schema } from "./db";
export * from "./domain/types";
export * from "./feeds/parse";
export { isUlid, randomToken, ulid } from "./ids";
export * from "./jobs/index";
export * from "./machine/machine";
export * from "./machine/tables";
export { buildManifest } from "./manifest";
export * from "./rules/index";
export { MIGRATIONS } from "./schema/migrations.generated";
export {
  createSecretBox,
  parseSecretKeys,
  requireSecretBox,
  type SecretBox,
  type SecretPurpose,
} from "./secrets/box";
export * from "./settings/schema";
export { USER_AGENT, VERSION } from "./version";
export * from "./write/index";
