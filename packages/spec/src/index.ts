/**
 * @surfingdog/spec (MIT) — the open formats: the discovery manifest and receipts (`base`), and every
 * message an inbox exchanges with a network (`network`, ADR-017 §7; `docs/protocol/network.md`).
 */
export * from "./base";
export * from "./network/index";
export { JSON_SCHEMAS, jsonSchemaOf } from "./schemas";
