/**
 * The strings a person holds (ADR-017 §2), plain text any assistant can carry and paste:
 *
 *   key        sdkey1_<network host>_<id>_<secret>    proves the person, mints passes
 *   pass       sdpass1_<network host>_<id>_<secret>   presented to businesses, revocable alone
 *   pass ref   sdpass1_<network host>_<id>            names a pass; only in a request signed by a delegated key
 *   session    sdps_<secret>                          24 h, from an emailed code
 *
 * `<id>` is 16 and `<secret>` 32 characters of RFC 4648 base32, lowercase and unpadded; the host is
 * the issuing network's lowercase punycode host, which cannot hold `_`, so the strings split
 * unambiguously. Reading one checks its shape only: which network the host names, and whether that
 * network knows it, are the caller's questions.
 */

export const KEY_PREFIX = "sdkey1_";
export const PASS_PREFIX = "sdpass1_";
export const SESSION_PREFIX = "sdps_";

export const PUBLIC_ID_LENGTH = 16;
export const SECRET_LENGTH = 32;
/** Any string an agent presents is at most this long (§2.4). */
export const MAX_CREDENTIAL_LENGTH = 200;
/** An agent presents at most this many strings (§2.4). */
export const MAX_CREDENTIALS = 8;

export type CredentialKind = "key" | "pass" | "pass_ref";

export interface Credential {
  readonly kind: CredentialKind;
  /** The issuing network's host: its API is `https://<host>`. */
  readonly host: string;
  /** The public id (the wire `pass_id` for a pass). */
  readonly id: string;
  /** Absent for a pass reference. */
  readonly secret?: string;
}

/** Exactly `n` characters of lowercase RFC 4648 base32. */
export function isBase32(s: string, n: number): boolean {
  return s.length === n && /^[a-z2-7]*$/.test(s);
}

/** A network host as the strings carry it: lowercase ASCII letters, digits, dots and hyphens. */
export function isNetworkHost(h: string): boolean {
  return h.length > 0 && h.length <= 253 && !h.startsWith(".") && !h.endsWith(".") && /^[a-z0-9.-]+$/.test(h);
}

/** A key, a pass or a pass reference, or null when the string is none of them. */
export function parseCredential(s: string): Credential | null {
  if (s.length > MAX_CREDENTIAL_LENGTH) return null;
  let kind: CredentialKind;
  let rest: string;
  if (s.startsWith(KEY_PREFIX)) {
    kind = "key";
    rest = s.slice(KEY_PREFIX.length);
  } else if (s.startsWith(PASS_PREFIX)) {
    kind = "pass";
    rest = s.slice(PASS_PREFIX.length);
  } else {
    return null;
  }
  const parts = rest.split("_");
  let host: string;
  let id: string;
  let secret: string | undefined;
  if (parts.length === 3) {
    [host, id, secret] = parts as [string, string, string];
    if (!isBase32(secret, SECRET_LENGTH)) return null;
  } else if (parts.length === 2 && kind === "pass") {
    kind = "pass_ref";
    [host, id] = parts as [string, string];
  } else {
    return null;
  }
  if (!isNetworkHost(host) || !isBase32(id, PUBLIC_ID_LENGTH)) return null;
  return secret === undefined ? { kind, host, id } : { kind, host, id, secret };
}

export const formatKey = (host: string, id: string, secret: string): string => `${KEY_PREFIX}${host}_${id}_${secret}`;
export const formatPass = (host: string, id: string, secret: string): string => `${PASS_PREFIX}${host}_${id}_${secret}`;
export const formatPassRef = (host: string, id: string): string => `${PASS_PREFIX}${host}_${id}`;

/** The reference that names a pass (its secret dropped), or null when `pass` is not a pass. */
export function passRefOf(pass: string): string | null {
  const c = parseCredential(pass);
  return c && (c.kind === "pass" || c.kind === "pass_ref") ? formatPassRef(c.host, c.id) : null;
}

/** The host of the network an https origin names, as credentials carry it: `https://Net.Example.com` → `net.example.com`. */
export function networkHostOf(origin: string): string {
  return origin
    .replace(/^https:\/\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** A presentation id (22 base64url characters) or a ppid (the same shape). */
export function isPresentationId(s: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(s);
}

/** An RFC 7638 thumbprint or a receipt `sha`: 43 base64url characters. */
export function isThumbprint(s: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(s);
}

/** SHA-256 of a secret, hex: all a network keeps of one. */
export async function secretHash(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret) as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
