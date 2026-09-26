import { z } from "zod";

/**
 * Shapes shared by every network message (ADR-017 §2, §7.4). A network is any service that
 * implements `docs/protocol/network.md`; these schemas are what an inbox sends it and reads back.
 */

/** A network's lowercase punycode host, as keys and passes carry it; it never contains "_". */
export const NETWORK_HOST_PATTERN = "(?:[a-z0-9-]|[a-z0-9-][a-z0-9.-]{0,251}[a-z0-9-])";
const B32_ID = "[a-z2-7]{16}";
const B32_SECRET = "[a-z2-7]{32}";

export const networkHostSchema = z
  .string()
  .max(253)
  .regex(new RegExp(`^${NETWORK_HOST_PATTERN}$`))
  .describe("A network's lowercase punycode host: its API is https://<host>.");

/** `sdkey1_<network host>_<id>_<secret>`: proves the person and mints passes, nothing more. */
export const keyStringSchema = z
  .string()
  .max(200)
  .regex(new RegExp(`^sdkey1_${NETWORK_HOST_PATTERN}_${B32_ID}_${B32_SECRET}$`))
  .describe("A person's key: sdkey1_<network host>_<id>_<secret>. Issued once; exchanged for passes.");

/** `sdpass1_<network host>_<id>_<secret>`: presented to businesses; revocable on its own. */
export const passStringSchema = z
  .string()
  .max(200)
  .regex(new RegExp(`^sdpass1_${NETWORK_HOST_PATTERN}_${B32_ID}_${B32_SECRET}$`))
  .describe("A pass: sdpass1_<network host>_<id>_<secret>. What an agent presents for its person.");

/** `sdpass1_<network host>_<id>`: names a pass; honoured only in a request signed by a key delegated to it. */
export const passRefSchema = z
  .string()
  .max(200)
  .regex(new RegExp(`^sdpass1_${NETWORK_HOST_PATTERN}_${B32_ID}$`))
  .describe("A pass reference: sdpass1_<network host>_<id>. Only valid with a signature by a delegated key.");

/** `sdps_<secret>`: a person's 24-hour session, from an emailed code. */
export const sessionStringSchema = z
  .string()
  .regex(new RegExp(`^sdps_${B32_SECRET}$`))
  .describe("A person's session (Authorization: Bearer), valid 24 hours.");

/** The 16-character public id of a key or a pass (the wire `pass_id`). */
export const publicIdSchema = z.string().regex(new RegExp(`^${B32_ID}$`));

/** An RFC 7638 JWK thumbprint (a signing key's `keyid`, an agent's `jkt`): 43 base64url characters. */
export const jktSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** base64url(SHA-256(a receipt's compact JWS)), no padding. */
export const receiptShaSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** A presentation id: 22 base64url characters (16 random bytes). */
export const presentationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

/** `ppid = base64url(HMAC-SHA-256(pairwise secret, "<pid>|https://<business domain>"))[:22]`. */
export const ppidSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22}$/)
  .describe("The person's pairwise id at this business: stable here, different at every other business.");

/** RFC 3339 / ISO 8601, UTC. */
export const timestampSchema = z.iso.datetime();

export const tierSchema = z.enum(["new", "building", "trusted"]);
export type Tier = z.infer<typeof tierSchema>;

/** The rules a network applies, by version (`GET /v1/ranking?version=N`). */
export const rulesRefSchema = z.object({
  version: z.int().min(1),
  effective_at: timestampSchema,
});

/** Rules announced and not yet in force (§11): published at least 15 days ahead. */
export const nextRulesSchema = z.object({
  version: z.int().min(1),
  effective_at: timestampSchema,
  url: z.url(),
});

/**
 * Every `code` a network's RFC 9457 problem may carry (§7.4), plus the inbox's own. A refused
 * acknowledgement prefixes its code with `ack_` (`ack_bad_signature`).
 */
export const networkErrorCodeSchema = z.enum([
  // 400
  "malformed",
  "bad_payload",
  // 401
  "unknown_instance",
  "bad_signature",
  "expired",
  "not_signed_in",
  "replayed_signature",
  // 403
  "pass_requires_signature",
  "not_your_receipt",
  "report_requires_signature",
  "unlinked",
  // 404
  "unknown_pass",
  "unknown_issuer",
  "not_found",
  // 409
  "person_exists",
  "nonce_reused",
  "already_reported",
  "you_acknowledged_it",
  "nothing_to_verify",
  "already_verified",
  // 410
  "revoked",
  "cursor_expired",
  // 413
  "too_large",
  // 422
  "unknown_key",
  "unknown_ref",
  "bad_alg",
  "bad_typ",
  "not_yet",
  "report_window",
  "contest_window",
  "bad_code",
  "code_expired",
  "positive_only",
  // 429
  "too_many_receipts",
  "rate_limited",
  "too_many_attempts",
]);
export type NetworkErrorCode = z.infer<typeof networkErrorCodeSchema>;

/** RFC 9457. `code` is one of `networkErrorCodeSchema` (or `ack_` + one); a 400 may have none. */
export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.int().min(400).max(599),
  code: z.string().optional(),
  detail: z.string().optional(),
  instance: z.string().optional(),
});
export type Problem = z.infer<typeof problemSchema>;

/**
 * What an inbox does with a refused publication (§3.2): these are retried, with backoff, up to the
 * job's limit; every other refusal is final.
 */
export function isRetriedPublication(status: number, code: string | undefined): boolean {
  if (status === 404 || status === 429 || status >= 500) return true;
  return status === 422 && (code === "unknown_key" || code === "unknown_ref");
}
