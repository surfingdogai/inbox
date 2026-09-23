import { isSecret, sdiPassHeader } from "./credentials.js";
import { b64u, base64, sha256, utf8 } from "./encoding.js";
import { type AgentKeyInput, resolveAgentKey, signBytes } from "./keys.js";

/**
 * `sdi-agent/1` (ADR-017 §2.4): an agent signing its own requests, RFC 9421 HTTP Message
 * Signatures with Ed25519, compatible with Web Bot Auth. A business's inbox verifies it and says
 * whether it did in `Sdi-Signature`; a network verifies it when you delegate your key, and again
 * when an inbox forwards it. An unsigned request is served just the same: signing is how a person's
 * record counts as verified, and how you carry them without anything copyable.
 *
 * What is covered, in this order: `"@method"`, `"@authority"`, `"@path"`, `"@query"` when the URL
 * has one, `"content-digest"` when there is a body, then `"sdi-agent-key";key="<label>"` (your own
 * key, sent in `Sdi-Agent-Key`) or `"signature-agent";key="<label>"` (a platform whose directory lists
 * the key), then `"sdi-pass"` when you carry pass references. Parameters: `created`, `expires` (at
 * most 300 s later), `keyid` (your key's thumbprint), `alg="ed25519"`, `tag`, and a random `nonce`:
 * Ed25519 is deterministic, and the same request twice in one second would otherwise carry the same
 * signature, which is refused as a replay.
 */

export const SIGNATURE_LABEL = "sig1";
export const MAX_WINDOW_SECONDS = 300;

export type SigningErrorCode = "secret_in_url" | "secret_in_signed_pass" | "bad_input";

/** A request this module refuses to sign, and why. */
export class SigningError extends Error {
  readonly code: SigningErrorCode;

  constructor(code: SigningErrorCode, message: string) {
    super(message);
    this.name = "SigningError";
    this.code = code;
  }
}

export interface SignRequestInput {
  readonly method: string;
  /** The full URL; its host is what the signature names (`@authority`). */
  readonly url: string;
  /** The body exactly as it will be sent. A string is sent as UTF-8. */
  readonly body?: string | Uint8Array | null | undefined;
  /** Headers to send that the signature need not cover (Content-Type, Authorization, …). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly key: AgentKeyInput;
  /**
   * Pass references to carry, in `Sdi-Pass`, covered by the signature. References only: a signed
   * header travels whole to every network the inbox forwards it to, so a secret there would reach
   * networks that did not issue it. Present a pass or a key unsigned, or in the body's `pass` field.
   */
  readonly passes?: readonly string[] | undefined;
  /**
   * Web Bot Auth: the platform whose `/.well-known/http-message-signatures-directory` lists your
   * key, sent in `Signature-Agent` (tag `web-bot-auth`). Without it you sign with your own key,
   * sent in `Sdi-Agent-Key` (tag `sdi-agent`).
   */
  readonly platform?: string | undefined;
  /** `Signature-Agent` in the older plain string form instead of a dictionary member. */
  readonly legacySignatureAgent?: boolean | undefined;
  /** The signature's label, `sig1` by default. */
  readonly label?: string | undefined;
  /** Milliseconds since the epoch; defaults to the clock. */
  readonly now?: number | undefined;
  /** `expires − created`, 1 to 300 seconds; 60 by default. */
  readonly windowSeconds?: number | undefined;
  /** A nonce of your own; a random one by default. `null` for none (only to reproduce a vector). */
  readonly nonce?: string | null | undefined;
}

export interface SignedRequest {
  /** Every header to send: yours, plus Sdi-Agent-Key or Signature-Agent, Sdi-Pass, Content-Digest, Signature-Input and Signature. */
  readonly headers: Record<string, string>;
  readonly keyid: string;
  /** The inner list with its parameters, as it appears in `Signature-Input` after `<label>=`. */
  readonly signatureInput: string;
  /** base64 of the 64 signature bytes, as in `Signature`. */
  readonly signature: string;
  /** What was signed (RFC 9421 §2.5), for debugging. */
  readonly signatureBase: string;
}

/**
 * Signs one request. Send the returned headers with it and the body byte for byte as given:
 *
 *   const signed = await signRequest({ method: "POST", url, body, key, passes: [passRef] });
 *   await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", ...signed.headers } });
 */
export async function signRequest(input: SignRequestInput): Promise<SignedRequest> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new SigningError("bad_input", "url must be an absolute URL");
  }
  // A signed request's base — its query included — may be forwarded whole to a network (§7.2).
  if (url.search.length > 1 && hasSecretParam(url.search.slice(1))) {
    throw new SigningError(
      "secret_in_url",
      "the URL carries an access token or a credential: send the token in X-Access-Token and passes in Sdi-Pass or the body, never in a URL",
    );
  }
  if (input.passes?.some(isSecret)) {
    throw new SigningError(
      "secret_in_signed_pass",
      "a signed Sdi-Pass carries pass references only (sdpass1_<host>_<id>): present a pass or a key unsigned, or in the body's pass field",
    );
  }
  return signUnchecked(input);
}

/**
 * The signature itself, without `signRequest`'s refusals: what reproduces the published vectors,
 * one of which signs a URL with an access token in it.
 *
 * @internal
 */
export async function signUnchecked(input: SignRequestInput): Promise<SignedRequest> {
  const key = await resolveAgentKey(input.key);
  const method = input.method.toUpperCase();
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new SigningError("bad_input", "url must be an absolute URL");
  }
  const label = input.label ?? SIGNATURE_LABEL;
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(label)) throw new SigningError("bad_input", "label is a lowercase token");
  const window = input.windowSeconds ?? 60;
  if (!Number.isInteger(window) || window < 1 || window > MAX_WINDOW_SECONDS) {
    throw new SigningError("bad_input", `windowSeconds is 1 to ${MAX_WINDOW_SECONDS}`);
  }
  const body =
    input.body === null || input.body === undefined
      ? new Uint8Array()
      : typeof input.body === "string"
        ? utf8(input.body)
        : input.body;
  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  const covered: string[] = ['"@method"', '"@authority"', '"@path"'];
  const values: string[] = [method, url.host, url.pathname || "/"];
  if (url.search.length > 1) {
    covered.push('"@query"');
    values.push(url.search);
  }
  if (body.length > 0) {
    headers["Content-Digest"] = `sha-256=:${base64(await sha256(body))}:`;
    covered.push('"content-digest"');
    values.push(headers["Content-Digest"]);
  }
  let tag: string;
  if (input.platform !== undefined) {
    const platform = originOf(input.platform);
    tag = "web-bot-auth";
    if (input.legacySignatureAgent) {
      headers["Signature-Agent"] = `"${platform}"`;
      covered.push('"signature-agent"');
      values.push(headers["Signature-Agent"]);
    } else {
      headers["Signature-Agent"] = `${label}="${platform}"`;
      covered.push(`"signature-agent";key="${label}"`);
      values.push(`"${platform}"`);
    }
  } else {
    tag = "sdi-agent";
    const member = `:${base64(utf8(JSON.stringify(key.publicJwk)))}:`;
    headers["Sdi-Agent-Key"] = `${label}=${member}`;
    covered.push(`"sdi-agent-key";key="${label}"`);
    values.push(member);
  }
  if (input.passes && input.passes.length > 0) {
    headers["Sdi-Pass"] = sdiPassHeader(input.passes);
    covered.push('"sdi-pass"');
    values.push(headers["Sdi-Pass"]);
  }
  const created = Math.floor((input.now ?? Date.now()) / 1000);
  const nonce = input.nonce === undefined ? b64u(crypto.getRandomValues(new Uint8Array(16))) : input.nonce;
  if (nonce !== null && !/^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/.test(nonce)) {
    throw new SigningError("bad_input", "nonce is printable ASCII without quotes or backslashes");
  }
  const signatureInput =
    `(${covered.join(" ")});created=${created};expires=${created + window}` +
    `;keyid="${key.thumbprint}";alg="ed25519";tag="${tag}"` +
    (nonce === null ? "" : `;nonce="${nonce}"`);
  let base = "";
  for (const [i, id] of covered.entries()) {
    const v = values[i] as string;
    if (/[\r\n]/.test(v)) throw new SigningError("bad_input", "a covered value spans lines");
    base += `${id}: ${v}\n`;
  }
  const signatureBase = `${base}"@signature-params": ${signatureInput}`;
  const signature = base64(await signBytes(key, utf8(signatureBase)));
  headers["Signature-Input"] = `${label}=${signatureInput}`;
  headers.Signature = `${label}=:${signature}:`;
  return { headers, keyid: key.thumbprint, signatureInput, signature, signatureBase };
}

/** RFC 9530 Content-Digest with sha-256, for a body you send yourself. */
export async function contentDigest(body: string | Uint8Array): Promise<string> {
  return `sha-256=:${base64(await sha256(typeof body === "string" ? utf8(body) : body))}:`;
}

function originOf(platform: string): string {
  let u: URL;
  try {
    u = new URL(platform);
  } catch {
    throw new SigningError("bad_input", "platform is an https origin, like https://platform.example");
  }
  if (u.protocol !== "https:" || u.origin !== platform.replace(/\/$/, "")) {
    throw new SigningError("bad_input", "platform is an https origin, like https://platform.example");
  }
  return u.origin;
}

function hasSecretParam(query: string): boolean {
  return query.split("&").some((part) => {
    const [rawName = "", rawValue = ""] = part.split("=");
    let name = rawName;
    let value = rawValue;
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, " "));
      value = decodeURIComponent(rawValue.replace(/\+/g, " "));
    } catch {
      // Compared as they are.
    }
    return name.toLowerCase() === "access_token" || isSecret(value) || /^sdps_[a-z2-7]{32}$/.test(value);
  });
}
