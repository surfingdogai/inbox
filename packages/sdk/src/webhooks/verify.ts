import type { InboxEvent } from "./events";

/**
 * Standard Webhooks v1.0.0 verification (ADR-015 §4), in about a hundred lines of WebCrypto so it
 * runs unchanged in a Worker, in Node and in a browser. This file is MIT on purpose: verifying our
 * events must never cost anyone an AGPL dependency, and a receiver that cannot be bothered to
 * check a signature will accept anything anyone posts at that URL.
 *
 * The contract, verbatim:
 *
 * - the signed content is `{webhook-id}.{webhook-timestamp}.{body}`, over the raw body bytes
 *   exactly as they arrived — not a re-serialised object, whose key order and spacing differ;
 * - `webhook-signature` carries one or more space-separated `v1,<base64>` values, and any one of
 *   them matching is a pass, because during a secret rotation both signatures travel for a day;
 * - `webhook-timestamp` is Unix seconds and must be within the tolerance in both directions, five
 *   minutes by default, which is what stops a captured request being replayed at you tomorrow;
 * - the comparison is constant time.
 */

/** The three headers we send. Nothing is branded; any Standard Webhooks library reads them. */
export const WEBHOOK_ID_HEADER = "webhook-id";
export const WEBHOOK_TIMESTAMP_HEADER = "webhook-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "webhook-signature";

export const DEFAULT_TOLERANCE_SECONDS = 300;

const SECRET_PREFIX = "whsec_";
const SIGNATURE_VERSION = "v1";
const encoder = new TextEncoder();

export type WebhookVerificationCode =
  | "missing_header"
  | "bad_timestamp"
  | "timestamp_too_old"
  | "timestamp_too_new"
  | "bad_signature_header"
  | "no_matching_signature"
  | "bad_secret"
  | "bad_payload";

/** Every refusal is this error, and `code` says which one, so a receiver can log it usefully. */
export class WebhookVerificationError extends Error {
  readonly code: WebhookVerificationCode;

  constructor(code: WebhookVerificationCode, message: string) {
    super(message);
    this.name = "WebhookVerificationError";
    this.code = code;
  }
}

/**
 * Whatever your framework hands you. A `Headers`, a `Map`, Node's `req.headers` (where a repeated
 * header is an array), or any iterable of pairs — we normalise, and the lookup is case-insensitive
 * either way, because HTTP header names are.
 */
export type HeadersLike =
  | Headers
  | Map<string, string | string[]>
  | Record<string, string | string[] | number | undefined>
  | Iterable<readonly [string, string]>;

export interface VerifyWebhookInput {
  /**
   * The raw request body. A string, or the bytes — never an object you parsed and re-serialised:
   * `JSON.stringify` will not reproduce the bytes we signed.
   */
  readonly payload: string | ArrayBuffer | ArrayBufferView;
  readonly headers: HeadersLike;
  /** The endpoint's signing secret, `whsec_…`, shown once when the endpoint was added. */
  readonly secret: string;
  /** How far the timestamp may be from now, in seconds, in both directions. Default 300. */
  readonly toleranceSeconds?: number;
  /** Milliseconds since the epoch; defaults to `Date.now()`. For tests and for clock injection. */
  readonly now?: number;
}

/**
 * Verifies a delivery and returns the parsed event. Throws `WebhookVerificationError` and returns
 * nothing useful otherwise: there is no "maybe" to act on.
 *
 * ```ts
 * const event = await verifyWebhook({ payload: await req.text(), headers: req.headers, secret });
 * ```
 */
export async function verifyWebhook<T = InboxEvent>(input: VerifyWebhookInput): Promise<T> {
  const body = toBytes(input.payload);
  const headers = normaliseHeaders(input.headers);
  const id = required(headers, WEBHOOK_ID_HEADER);
  const timestamp = required(headers, WEBHOOK_TIMESTAMP_HEADER);
  const signatureHeader = required(headers, WEBHOOK_SIGNATURE_HEADER);

  checkTimestamp(timestamp, input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS, input.now ?? Date.now());

  const candidates = parseSignatureHeader(signatureHeader);
  if (candidates.length === 0) {
    throw new WebhookVerificationError(
      "bad_signature_header",
      `the ${WEBHOOK_SIGNATURE_HEADER} header carries no ${SIGNATURE_VERSION} signature`,
    );
  }

  const key = await importSecret(input.secret);
  const signed = concat(encoder.encode(`${id}.${timestamp}.`), body);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed as BufferSource));

  // Every candidate is compared, and the comparison is constant time: no early exit tells a
  // guesser which byte of a forged signature was the first wrong one.
  let matched = false;
  for (const candidate of candidates) {
    const bytes = decodeBase64(candidate, true);
    matched = (bytes !== null && timingSafeEqual(expected, bytes)) || matched;
  }
  if (!matched) {
    throw new WebhookVerificationError(
      "no_matching_signature",
      "no signature in the header matches this secret — check you are using the right endpoint's secret and the raw body",
    );
  }

  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    throw new WebhookVerificationError("bad_payload", "the signature is good but the body is not JSON");
  }
}

function required(headers: Map<string, string>, name: string): string {
  const value = headers.get(name);
  if (value === undefined || value.trim() === "") {
    throw new WebhookVerificationError("missing_header", `missing the ${name} header`);
  }
  return value.trim();
}

function checkTimestamp(raw: string, toleranceSeconds: number, nowMs: number): void {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || !/^-?\d+$/.test(raw)) {
    throw new WebhookVerificationError("bad_timestamp", `${WEBHOOK_TIMESTAMP_HEADER} is not Unix seconds: ${raw}`);
  }
  const drift = Math.floor(nowMs / 1000) - seconds;
  if (drift > toleranceSeconds) {
    throw new WebhookVerificationError(
      "timestamp_too_old",
      `this delivery is ${drift}s old; tolerance is ${toleranceSeconds}s`,
    );
  }
  if (-drift > toleranceSeconds) {
    throw new WebhookVerificationError(
      "timestamp_too_new",
      `this delivery is timestamped ${-drift}s in the future; tolerance is ${toleranceSeconds}s — check your clock`,
    );
  }
}

/**
 * `v1,<base64> v1,<base64>` — space separated, any may match. Other versions are ignored rather
 * than refused, so a future `v2` alongside `v1` does not break a receiver written today.
 */
function parseSignatureHeader(header: string): string[] {
  const out: string[] = [];
  for (const raw of header.split(/\s+/)) {
    // A framework that folded two repeated headers into one comma-joined value leaves strays.
    const token = raw.replace(/^,+|,+$/g, "");
    const comma = token.indexOf(",");
    if (comma <= 0) continue;
    if (token.slice(0, comma) !== SIGNATURE_VERSION) continue;
    const value = token.slice(comma + 1);
    if (value.length > 0) out.push(value);
  }
  return out;
}

/**
 * `whsec_` then base64, as Standard Webhooks issues them: the key is the decoded remainder. A
 * secret that is not base64 at all is used as its own UTF-8 bytes, prefix included — which is what
 * the Inbox's own signer does, so a passphrase somebody typed by hand still verifies rather than
 * failing mysteriously.
 */
async function importSecret(secret: string): Promise<CryptoKey> {
  const trimmed = secret.trim();
  if (trimmed === "") throw new WebhookVerificationError("bad_secret", "the signing secret is empty");
  const material = trimmed.startsWith(SECRET_PREFIX) ? trimmed.slice(SECRET_PREFIX.length) : trimmed;
  const bytes = decodeBase64(material) ?? encoder.encode(trimmed);
  if (bytes.length === 0) throw new WebhookVerificationError("bad_secret", "the signing secret decodes to no bytes");
  return crypto.subtle.importKey("raw", bytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function normaliseHeaders(headers: HeadersLike): Map<string, string> {
  const out = new Map<string, string>();
  const put = (name: unknown, value: unknown): void => {
    if (value === undefined || value === null) return;
    const key = String(name).toLowerCase();
    const text = Array.isArray(value) ? value.join(" ") : String(value);
    const existing = out.get(key);
    out.set(key, existing === undefined ? text : `${existing} ${text}`);
  };
  if (headers === null || headers === undefined) {
    throw new WebhookVerificationError("missing_header", "no headers were given");
  }
  const iterable = (headers as Iterable<readonly [string, string]>)[Symbol.iterator];
  if (typeof iterable === "function") {
    // Headers, Map and arrays of pairs all iterate as [name, value].
    for (const entry of headers as Iterable<readonly [string, unknown]>) put(entry[0], entry[1]);
    return out;
  }
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) put(name, value);
  return out;
}

function toBytes(payload: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof payload === "string") return encoder.encode(payload);
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Constant time in the length of the expected signature; the length itself is not a secret. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/**
 * Standard base64. A signature may also arrive base64url, because someone's gateway re-encoded it,
 * and decoding that costs nothing — but a *secret* is read strictly, so that a secret which is not
 * base64 falls back to its own bytes here exactly as it does in the signer.
 */
function decodeBase64(value: string, urlSafe = false): Uint8Array | null {
  const normalised = urlSafe ? value.replace(/-/g, "+").replace(/_/g, "/") : value;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalised) || normalised.length === 0) return null;
  try {
    const binary = atob(normalised);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
