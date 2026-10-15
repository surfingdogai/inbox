/**
 * @surfingdog/spec (MIT) — the open formats: the discovery manifest and receipts (`base`), every
 * message an inbox exchanges with a network (`network`, ADR-017 §7; `docs/protocol/network.md`),
 * and the conformance check that holds a manifest, a receipt or an acknowledgement to them.
 */
export * from "./base";
export * from "./conformance";
export * from "./network/index";
export { JSON_SCHEMAS, jsonSchemaOf, SCHEMA_BASE } from "./schemas";
