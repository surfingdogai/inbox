import { mintWebhookSecret, signWebhook as signOne, webhookSecretBytes } from "@surfingdog/core";

/**
 * Standard Webhooks v1.0.0, verbatim (ADR-015 §4).
 *
 * Three headers travel with every delivery — `webhook-id`, `webhook-timestamp` and
 * `webhook-signature` — and the signed content is exactly `{id}.{timestamp}.{body}`. This is what
 * OpenAI, Anthropic, Google, Twilio, Resend, Clerk and Render already send, so a developer
 * verifies us with an off-the-shelf library in any language and writes no code of their own. A
 * bare HMAC of the body, as GitHub sends, is replayable forever by anyone who captures one
 * request; a bespoke header means every integrator writes their own verifier and gets it wrong.
 *
 * **The HMAC itself is not computed here.** `@surfingdog/core` owns it, because the owner-facing
 * capability signs the test event and core cannot import adapters. This module is the delivery
 * side's ergonomics — a payload object rather than four positional arguments, several secrets
 * during a rotation, and the verifier our own tests check the format with — over that one
 * implementation. WebCrypto only: it runs unchanged on Workers and on Node.
 */

/** Secrets are issued as `whsec_<base64 of 32 random bytes>`; the key is the decoded remainder. */
export const SECRET_PREFIX = "whsec_";
/** The one signature scheme we emit. A receiver matches on this prefix and ignores what it cannot read. */
export const SIGNATURE_SCHEME = "v1";
/** How far the timestamp may be from the verifier's clock, in seconds, before a replay is refused. */
export const DEFAULT_TOLERANCE_SEC = 5 * 60;

export interface WebhookPayload {
  /** The `events_v1` id: the `webhook-id` header, and what the receiver deduplicates on. */
  readonly id: string;
  /** Unix **seconds**, not milliseconds. */
  readonly timestamp: number;
  /** The exact bytes of the request body, as a string. Sign what you send, byte for byte. */
  readonly body: string;
}

export type VerifyFailure = "malformed" | "timestamp" | "signature";
export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly reason: VerifyFailure };

/** A fresh signing secret. Shown to the owner once, then sealed by the secret box. */
export const newWebhookSecret = mintWebhookSecret;

/** The key material behind a secret, for a caller that wants to check the two halves agree. */
export const secretKeyBytes = webhookSecretBytes;

/** Exactly what is HMAC'd: `{id}.{timestamp}.{body}`. Exported because a test vector needs it. */
export function signedContent(payload: WebhookPayload): string {
  return `${payload.id}.${payload.timestamp}.${payload.body}`;
}

/**
 * The `webhook-signature` value. During a rotation two signatures travel, space separated, newest
 * first, so a receiver that has only the old secret and one that has only the new both verify.
 */
export async function signWebhook(secrets: string | readonly string[], payload: WebhookPayload): Promise<string> {
  const list = secretList(secrets);
  if (list.length === 0) throw new Error("signWebhook: no signing secret");
  const parts: string[] = [];
  for (const secret of list) parts.push(`${SIGNATURE_SCHEME},${await hmac(secret, payload)}`);
  return parts.join(" ");
}

/** The three signature headers. The rest of a delivery's headers come from core's `webhookHeaders`. */
export async function signedHeaders(
  secrets: string | readonly string[],
  payload: WebhookPayload,
): Promise<Record<string, string>> {
  return {
    "webhook-id": payload.id,
    "webhook-timestamp": String(payload.timestamp),
    "webhook-signature": await signWebhook(secrets, payload),
  };
}

/**
 * The other half of the signer, so our own tests — and the `verifyWebhook` helper the SDK ships —
 * prove the format end to end rather than agreeing with themselves. Any one of the space-separated
 * signatures matching any one of the secrets is enough; the comparison is constant time.
 */
export async function verifyWebhook(
  secrets: string | readonly string[],
  payload: WebhookPayload & { readonly signature: string },
  opts: { readonly toleranceSec?: number; readonly now?: number } = {},
): Promise<VerifyResult> {
  const list = secretList(secrets);
  if (list.length === 0 || !payload.id || !Number.isFinite(payload.timestamp))
    return { ok: false, reason: "malformed" };
  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  if (tolerance > 0 && Math.abs(nowSec - payload.timestamp) > tolerance) return { ok: false, reason: "timestamp" };
  const offered = payload.signature
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SIGNATURE_SCHEME},`))
    .map((part) => part.slice(SIGNATURE_SCHEME.length + 1));
  if (offered.length === 0) return { ok: false, reason: "malformed" };
  let matched = false;
  for (const secret of list) {
    const expected = await hmac(secret, payload);
    // No early exit: every candidate is compared, so timing says nothing about which one matched.
    for (const candidate of offered) matched = timingSafeEqual(expected, candidate) || matched;
  }
  return matched ? { ok: true } : { ok: false, reason: "signature" };
}

/** Reads the three headers off a Request, for a receiver that has one in hand. */
export function webhookHeadersFrom(headers: Headers): { id: string; timestamp: number; signature: string } | null {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signature = headers.get("webhook-signature");
  if (!id || !timestamp || !signature) return null;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return null;
  return { id, timestamp: seconds, signature };
}

function secretList(secrets: string | readonly string[]): string[] {
  return (typeof secrets === "string" ? [secrets] : [...secrets]).filter((s) => s.length > 0);
}

function hmac(secret: string, payload: WebhookPayload): Promise<string> {
  return signOne(secret, payload.id, payload.timestamp, payload.body);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
