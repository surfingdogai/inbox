import { z } from "zod";
import {
  manifestSchema,
  receiptAckPayloadSchema,
  receiptPayloadSchema,
  receiptPublishResultSchema,
  receiptPublishSchema,
} from "./base";
import {
  businessesResponseSchema,
  caseAnsweredSchema,
  contestAnswerSchema,
  contestCreatedSchema,
  contestRequestSchema,
  delegationRequestSchema,
  delegationResponseSchema,
  instanceRegistrationRequestSchema,
  instanceRegistrationResponseSchema,
  instanceStatusSchema,
  listingDetailSchema,
  passMintRequestSchema,
  passMintResponseSchema,
  passRevokeRequestSchema,
  passRevokeResponseSchema,
  personIssuanceRequestSchema,
  personIssuedSchema,
  personViewSchema,
  pingRequestSchema,
  presentationRequestSchema,
  presentationResponseSchema,
  problemSchema,
  rankingDocumentSchema,
  receiptAckPayloadV2Schema,
  receiptPayloadV2Schema,
  recoveredKeySchema,
  recoveryFinishRequestSchema,
  recoverySessionSchema,
  recoveryStartRequestSchema,
  recoveryStartResponseSchema,
  reportAnswerSchema,
  reportFiledSchema,
  reportRequestSchema,
  signedPingResponseSchema,
} from "./network/index";

/**
 * The JSON Schemas published in `packages/spec/schemas/`, one file per name, generated from the Zod
 * schemas with `z.toJSONSchema` (`packages/core/scripts/gen-network-vectors.ts`). Each describes
 * what may be sent (a member with a default may be left out), and none forbids members it does not
 * name: a receiver ignores what it does not know, so a network can add a field without breaking
 * anyone. Cross-field rules (an outcome's `out` and `ref`, "exactly one of") cannot be said in JSON
 * Schema; the Zod schemas and the vectors hold them.
 */
export const JSON_SCHEMAS: Record<string, { schema: z.ZodType; title: string }> = {
  manifest: { schema: manifestSchema, title: "Discovery manifest (/.well-known/agent-inbox.json)" },
  "receipt-v1": { schema: receiptPayloadSchema, title: "Receipt claims, v1 (ADR-016)" },
  "receipt-v2": { schema: receiptPayloadV2Schema, title: "Receipt claims, v2 (ADR-017 §3.2)" },
  "receipt-ack-v1": { schema: receiptAckPayloadSchema, title: "Acknowledgement claims (ADR-016)" },
  "receipt-ack-v2": { schema: receiptAckPayloadV2Schema, title: "Acknowledgement claims with pas" },
  "receipts-request": { schema: receiptPublishSchema, title: "POST /v1/receipts" },
  "receipts-response": { schema: receiptPublishResultSchema, title: "POST /v1/receipts: answer" },
  problem: { schema: problemSchema, title: "RFC 9457 problem with a code" },
  "instances-request": { schema: instanceRegistrationRequestSchema, title: "POST /v1/instances" },
  "instances-response": {
    schema: instanceRegistrationResponseSchema,
    title: "POST /v1/instances: 202",
  },
  "instance-status": { schema: instanceStatusSchema, title: "GET /v1/instances/{domain}/status" },
  "ping-request": { schema: pingRequestSchema, title: "POST /v1/instances/{domain}/ping" },
  "ping-response": {
    schema: signedPingResponseSchema,
    title: "POST /v1/instances/{domain}/ping: a signed ping's 200",
  },
  "persons-request": { schema: personIssuanceRequestSchema, title: "POST /v1/persons" },
  "persons-response": { schema: personIssuedSchema, title: "POST /v1/persons: 201" },
  "presentations-request": { schema: presentationRequestSchema, title: "POST /v1/presentations" },
  "presentations-response": {
    schema: presentationResponseSchema,
    title: "POST /v1/presentations: 200",
  },
  "passes-request": { schema: passMintRequestSchema, title: "POST /v1/passes" },
  "passes-response": { schema: passMintResponseSchema, title: "POST /v1/passes: 201" },
  "passes-revoke-request": { schema: passRevokeRequestSchema, title: "POST /v1/passes/revoke" },
  "passes-revoke-response": {
    schema: passRevokeResponseSchema,
    title: "POST /v1/passes/revoke: 200",
  },
  "delegations-request": { schema: delegationRequestSchema, title: "POST /v1/delegations" },
  "delegations-response": { schema: delegationResponseSchema, title: "POST /v1/delegations: 201" },
  person: { schema: personViewSchema, title: "GET /v1/person" },
  "contests-request": { schema: contestRequestSchema, title: "POST /v1/person/contests" },
  "contests-response": { schema: contestCreatedSchema, title: "POST /v1/person/contests: 201 or 200" },
  "recovery-start-request": { schema: recoveryStartRequestSchema, title: "POST /v1/recovery/start" },
  "recovery-start-response": {
    schema: recoveryStartResponseSchema,
    title: "POST /v1/recovery/start: 202",
  },
  "recovery-finish-request": { schema: recoveryFinishRequestSchema, title: "POST /v1/recovery/finish" },
  "recovery-finish-session": {
    schema: recoverySessionSchema,
    title: "POST /v1/recovery/finish: sign_in",
  },
  "recovery-finish-key": { schema: recoveredKeySchema, title: "POST /v1/recovery/finish: recover" },
  "reports-request": { schema: reportRequestSchema, title: "POST /v1/reports" },
  "reports-response": { schema: reportFiledSchema, title: "POST /v1/reports: 202" },
  "report-answer": { schema: reportAnswerSchema, title: "POST /v1/reports/{id}/response" },
  "contest-answer": { schema: contestAnswerSchema, title: "POST /v1/contests/{id}/response" },
  "case-answered": { schema: caseAnsweredSchema, title: "A report or contest answered" },
  businesses: { schema: businessesResponseSchema, title: "GET /v1/businesses" },
  business: { schema: listingDetailSchema, title: "GET /v1/businesses/{domain}" },
  ranking: { schema: rankingDocumentSchema, title: "GET /v1/ranking" },
};

/** One JSON Schema document, as it is written to `schemas/<name>.json`. */
export function jsonSchemaOf(name: string): Record<string, unknown> {
  const entry = JSON_SCHEMAS[name];
  if (!entry) throw new Error(`no schema named ${name}`);
  const { $schema, ...rest } = z.toJSONSchema(entry.schema, { io: "input" }) as Record<string, unknown>;
  return { $schema, title: entry.title, ...rest };
}
