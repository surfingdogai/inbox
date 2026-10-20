import { ConnectorError, type ConnectorHttp, type ConnectorHttpResponse } from "@surfingdog/core";
import { retryAfterMs } from "../http";

/**
 * Square's REST API as this connector speaks it (ADR-029): the business's own access token in the
 * `Authorization` header, one API version on every call (`Square-Version`), JSON both ways, and
 * Square's own words when it says no. Square answers from two hosts: production, and the Sandbox a
 * developer tests in (https://developer.squareup.com/docs/build-basics/access-tokens#use-access-token).
 * Nothing here ever follows a redirect, so the token goes to those two hosts and nowhere else.
 */

export const SQUARE_API = "https://connect.squareup.com";
export const SQUARE_SANDBOX_API = "https://connect.squareupsandbox.com";

/**
 * The version every call and the inbox's webhook subscription are read in, the newest Square documents
 * (https://developer.squareup.com/docs/changelog/connect). Answers are read leniently: a field added
 * later changes nothing.
 */
export const SQUARE_VERSION = "2026-09-16";

export type SquareEnv = "production" | "sandbox";

export function apiBase(env: SquareEnv): string {
  return env === "sandbox" ? SQUARE_SANDBOX_API : SQUARE_API;
}

/** One of Square's errors, as its answers carry them (`errors[]`). */
export interface SquareError {
  readonly category?: string | undefined;
  readonly code?: string | undefined;
  readonly detail?: string | undefined;
  readonly field?: string | undefined;
}

export interface Answer {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly errors: readonly SquareError[];
}

/** A JSON object, or an empty one: Square's answers are read leniently. */
export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object") : [];
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Square's own words for a refusal, short: its `detail`, or its `code`. */
export function why(errors: readonly SquareError[]): string {
  const e = errors[0];
  const text = (e?.detail ?? e?.code ?? "").trim();
  return text.slice(0, 200);
}

/** Calls Square with the business's own token. Throws for what no caller can fix (a token refused, Square down). */
export class SquareApi {
  constructor(
    private readonly http: ConnectorHttp,
    readonly env: SquareEnv,
    private readonly token: string,
  ) {}

  async call(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    opts: { readonly maxBytes?: number; readonly timeoutMs?: number } = {},
  ): Promise<Answer> {
    const res = await this.http.request({
      method,
      url: `${apiBase(this.env)}${path}`,
      headers: {
        authorization: `Bearer ${this.token}`,
        "square-version": SQUARE_VERSION,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return answerOf(res);
  }

  /** A call that must succeed: Square's refusal is said in its own words, `doing` in the owner's. */
  async must(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    doing: string,
    body?: unknown,
    opts: { readonly maxBytes?: number; readonly timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const a = await this.call(method, path, body, opts);
    if (a.status >= 200 && a.status < 300) return a.json;
    throw refusal(a, doing);
  }
}

/** Square's answer read, or the failure no caller can do anything about. */
export function answerOf(res: ConnectorHttpResponse): Answer {
  let json: Record<string, unknown> = {};
  try {
    json = obj(res.text ? JSON.parse(res.text) : {});
  } catch {
    if (res.status >= 200 && res.status < 300) {
      throw new ConnectorError("bad_response", "Square answered with something this inbox could not read.");
    }
  }
  const errors = arr(json.errors) as SquareError[];
  if (res.status === 401) {
    const expired = errors.some((e) => e.code === "ACCESS_TOKEN_EXPIRED" || e.code === "ACCESS_TOKEN_REVOKED");
    throw new ConnectorError(
      "auth",
      expired
        ? "Square says this inbox's access has ended. Connect Square again."
        : "Square did not take that access token. Copy it again from the Square Developer Console (Credentials → Production) and connect again.",
      { field: "access_token" },
    );
  }
  if (res.status === 429) {
    throw new ConnectorError("rate_limited", "Square asked this inbox to slow down.", {
      retryAfterMs: retryAfterMs(res.headers),
    });
  }
  if (res.status >= 500) {
    throw new ConnectorError(
      "unreachable",
      "Square is not answering properly; this inbox tries again in a few minutes.",
    );
  }
  if (res.status >= 300 && res.status < 400) {
    // Square never sends its API elsewhere; the token is not sent after it.
    throw new ConnectorError("bad_response", "Square answered from another address, which this inbox does not follow.");
  }
  return { status: res.status, json, errors };
}

/** What Square said no to, in the owner's words: not found, not allowed, or refused. */
export function refusal(a: Answer, doing: string): ConnectorError {
  const detail = why(a.errors).replace(/\.$/, "");
  const tail = detail ? `: ${detail}.` : ".";
  if (a.status === 404) return new ConnectorError("not_found", `Square could not find what it needed to ${doing}.`);
  if (a.status === 403) return new ConnectorError("refused", `Square would not let this inbox ${doing}${tail}`);
  return new ConnectorError("refused", `Square would not ${doing}${tail}`);
}

/** SHA-256 of a text, as lowercase hex, with Web Crypto. */
export async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** An ISO 8601 time in UTC, to the second, as Square takes them. */
export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A Square timestamp, or NaN. */
export function msOf(v: unknown): number {
  return typeof v === "string" ? Date.parse(v) : Number.NaN;
}
