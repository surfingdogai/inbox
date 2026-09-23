import { z } from "zod";
import {
  nextRulesSchema,
  passRefSchema,
  receiptShaSchema,
  rulesRefSchema,
  tierSchema,
  timestampSchema,
} from "./common";

/**
 * An inbox and a network (ADR-017 §7.1, §7.3): registration, the hourly ping and its answer, and the
 * reports and contests a business answers.
 */

/** `POST /v1/instances`: the network fetches `https://<domain>/.well-known/agent-inbox.json` to verify it. */
export const instanceRegistrationRequestSchema = z.object({ domain: z.string().min(1).max(253) });

/** `202` */
export const instanceRegistrationResponseSchema = z.object({
  domain: z.string(),
  status: z.string(),
  status_url: z.string(),
  manifest_url: z.url(),
  message: z.string(),
});

/** `GET /v1/instances/{domain}/status` */
export const instanceStatusSchema = z.object({
  domain: z.string(),
  status: z.enum(["pending", "verified", "unreachable"]),
  listed: z.boolean(),
  verified_at: timestampSchema.nullable(),
  last_checked_at: timestampSchema.nullable(),
  last_ping_at: timestampSchema.nullable(),
  fail_count: z.int().min(0),
  manifest_url: z.url(),
  verification: z
    .object({ attempts: z.int().min(0), next_attempt_at: timestampSchema, last_error: z.string().optional() })
    .optional(),
});

/** The last 24 hours' items, by type; no content, no customers. */
export const pingCountsSchema = z.object({
  bookings: z.int().min(0).max(1_000_000_000),
  orders: z.int().min(0).max(1_000_000_000),
  quotes: z.int().min(0).max(1_000_000_000),
  messages: z.int().min(0).max(1_000_000_000),
});

/**
 * `POST /v1/instances/{domain}/ping`, hourly. Unsigned: `204`, no body. Signed sdi-instance/1 by the
 * domain's own key: `200` with `signedPingResponseSchema`. Both count as answering (§6); a signature
 * that fails is answered `204` with `Sdi-Signature: invalid; reason="<code>"`.
 */
export const pingRequestSchema = z.object({
  version: z.string().max(64),
  runtime: z.string().max(32),
  counts: pingCountsSchema.optional(),
});
export type PingRequest = z.infer<typeof pingRequestSchema>;

export const reportOutSchema = z.enum(["booking.no_show_business", "order.not_received"]);
export const reportWhySchema = z.enum(["closed", "no_one_there", "not_delivered", "other"]);

/** An open report the business may still dispute (until `respond_by`). */
export const reportCaseSchema = z.object({
  id: z.string(),
  receipt_sha: receiptShaSchema,
  out: reportOutSchema,
  why: reportWhySchema,
  created_at: timestampSchema,
  respond_by: timestampSchema,
});
export type ReportCase = z.infer<typeof reportCaseSchema>;

/** An open contest of one of the business's broken outcomes about a customer. */
export const contestCaseSchema = z.object({
  id: z.string(),
  evidence_id: z.string(),
  out: z.string(),
  created_at: timestampSchema,
});
export type ContestCase = z.infer<typeof contestCaseSchema>;

/** The business's own standing in the last nightly snapshot. */
export const businessStandingSchema = z.object({
  score: z.number().min(0).max(1),
  tier: tierSchema,
  ranked: z.boolean().describe("score_int ≥ 4000 (building): sorts before the newcomers' shuffle."),
});

/** A signed ping's `200`: only the domain's own key sees this, since anyone may ping for any domain. */
export const signedPingResponseSchema = z.object({
  ok: z.literal(true),
  rules: rulesRefSchema.describe("The rules in force."),
  next_rules: nextRulesSchema.nullable().describe("Rules announced and not yet in force, or null."),
  reports: z.array(reportCaseSchema).max(200),
  contests: z.array(contestCaseSchema).max(200),
  standing: businessStandingSchema,
});
export type SignedPingResponse = z.infer<typeof signedPingResponseSchema>;

/**
 * `POST /v1/reports`, straight from the customer's agent to the network, signed sdi-agent/1 by a key
 * delegated to the pass `pass_ref` names (else `403 report_requires_signature`).
 */
export const reportRequestSchema = z.object({
  receipt: z.string().min(1).max(8192).describe("Any receipt of the item: its compact JWS, or its sha."),
  out: reportOutSchema,
  why: reportWhySchema,
  pass_ref: passRefSchema,
});
export const reportFiledSchema = z.object({ id: z.string(), status: z.literal("open"), respond_by: timestampSchema });

/** `POST /v1/reports/{id}/response` (sdi-instance/1, the reported business). */
export const reportAnswerSchema = z.object({ answer: z.literal("dispute") });
/** `POST /v1/contests/{id}/response` (sdi-instance/1, the business that recorded the outcome). */
export const contestAnswerSchema = z.object({ answer: z.literal("withdraw") });
export const caseAnsweredSchema = z.object({
  id: z.string(),
  status: z.string().describe("disputed, for a report; withdrawn, for a contest."),
  answer: z.enum(["dispute", "withdraw"]),
});
