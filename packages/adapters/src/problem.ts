import { WriteError } from "@surfingdog/core";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Every refusal is an RFC 9457 problem document with the machine code and a human sentence. A
 * refusal about the request itself also carries `fields`, so an agent can repair it and retry
 * once; an auth, not-found or rate-limit refusal has no field to name and omits them.
 */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  readonly fields?: readonly { path: string; problem: string; message: string }[];
  readonly details?: Record<string, unknown>;
}

const TITLES: Record<string, string> = {
  invalid_input: "Invalid input",
  not_found: "Not found",
  not_allowed: "Not allowed",
  wrong_state: "Not possible in this state",
  unknown_event: "Unknown event",
  guard_failed: "Refused by a rule",
  slot_taken: "Slot taken",
  version_conflict: "Changed since you read it",
  idempotency_mismatch: "Idempotency key reused",
  nothing_to_verify: "Nothing to verify",
  already_verified: "Already verified",
  bad_code: "Wrong code",
  code_expired: "Code expired",
  too_many_attempts: "Too many attempts",
  positive_only: "A reputation may only speed things up",
  replayed_signature: "Signature already used",
  confirm_terms: "Confirm the terms first",
  offer_changed: "The proposal changed",
  offer_expired: "No longer valid",
  no_offer: "Nothing to answer",
  confirm_erase: "Confirm the erasure first",
  unauthorized: "Authentication required",
  internal: "Something went wrong",
};

export function problemFrom(error: unknown): Problem {
  if (error instanceof WriteError) {
    return {
      type: `https://surfingdog.ai/problems/${error.code}`,
      title: TITLES[error.code] ?? error.code,
      status: error.status,
      detail: error.message,
      code: error.code,
      ...(error.fields ? { fields: error.fields } : {}),
      ...(error.details ? { details: error.details } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    type: "https://surfingdog.ai/problems/internal",
    title: TITLES.internal ?? "Error",
    status: 500,
    detail: message,
    code: "internal",
  };
}

export function problemResponse(c: Context, error: unknown): Response {
  const p = problemFrom(error);
  return c.json(p, p.status as ContentfulStatusCode, { "Content-Type": "application/problem+json" });
}

export function unauthorized(
  c: Context,
  detail = "Sign in, or send an owner API key or OAuth token as a Bearer token.",
  resourceMetadata?: string,
): Response {
  const p: Problem = {
    type: "https://surfingdog.ai/problems/unauthorized",
    title: TITLES.unauthorized ?? "",
    status: 401,
    detail,
    code: "unauthorized",
  };
  const challenge = resourceMetadata ? `Bearer resource_metadata="${resourceMetadata}"` : 'Bearer realm="owner"';
  return c.json(p, 401, { "Content-Type": "application/problem+json", "WWW-Authenticate": challenge });
}

export function forbidden(c: Context, detail: string): Response {
  const p: Problem = {
    type: "https://surfingdog.ai/problems/not_allowed",
    title: TITLES.not_allowed ?? "",
    status: 403,
    detail,
    code: "not_allowed",
  };
  return c.json(p, 403, { "Content-Type": "application/problem+json" });
}

/** 429 with Retry-After: the caller is told exactly how long to wait, in seconds. */
export function tooManyRequests(c: Context, detail: string, retryAfterSec: number): Response {
  const p: Problem = {
    type: "https://surfingdog.ai/problems/too_many_requests",
    title: "Too many requests",
    status: 429,
    detail,
    code: "too_many_requests",
  };
  return c.json(p, 429, {
    "Content-Type": "application/problem+json",
    "Retry-After": String(Math.max(1, Math.ceil(retryAfterSec))),
  });
}

/**
 * 401 `replayed_signature` (ADR-017 §2.4): a signed request that changes something, seen before,
 * without the idempotency key that would make it a retry. A retry carries its key and gets the
 * first answer; a copy does not.
 */
export function replayedSignature(c: Context): Response {
  const p: Problem = {
    type: "https://surfingdog.ai/problems/replayed_signature",
    title: TITLES.replayed_signature ?? "Signature already used",
    status: 401,
    detail: "This signature was already used. Sign the request again; a retry sends the same Idempotency-Key.",
    code: "replayed_signature",
  };
  return c.json(p, 401, { "Content-Type": "application/problem+json" });
}
