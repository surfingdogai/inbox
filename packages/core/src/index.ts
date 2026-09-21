/**
 * @surfingdog/core — domain model, state machines, rules engine, receipts.
 * Web-standard APIs only; runtimes plug in through @surfingdog/platform.
 */

export type { Manifest } from "@surfingdog/spec";
export { MANIFEST_PATH, manifestSchema } from "@surfingdog/spec";
export * from "./capabilities/index";
export { createDb, type Db, type Orm, schema } from "./db";
export * from "./domain/types";
export { isUlid, randomToken, ulid } from "./ids";
export * from "./machine/machine";
export * from "./machine/tables";
export { buildManifest } from "./manifest";
export { MIGRATIONS } from "./schema/migrations.generated";
export * from "./settings/schema";
export * from "./write/index";

export const VERSION = "0.0.0";
