import { WriteError } from "@surfingdog/core";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Every refusal is an RFC 9457 problem document with the machine code, a human sentence, and the
 * exact fields to fix, so an agent can repair its request and retry once.
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
