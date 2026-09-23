/**
 * The strings a person holds (ADR-017 §2), which an agent carries for them:
 *
 *   key        sdkey1_<network host>_<id>_<secret>    the person's own: proves them, makes passes
 *   pass       sdpass1_<network host>_<id>_<secret>   presented to businesses; one per agent
 *   pass ref   sdpass1_<network host>_<id>            names a pass; only in a request you sign
 *
 * `<id>` is 16 and `<secret>` 32 characters of lowercase base32; the host is the issuing network's
 * lowercase punycode host (its API is `https://<host>`). Keys and passes are secrets: send them in
 * a body field or the `Sdi-Pass` header, never in a URL, a message or a log line.
 */

export type CredentialKind = "key" | "pass" | "pass_ref";

export interface Credential {
  readonly kind: CredentialKind;
  /** The issuing network's host. */
  readonly host: string;
  readonly id: string;
  /** Absent for a pass reference. */
  readonly secret?: string;
}

/** At most this many strings are presented at once, each at most this long (§2.4). */
export const MAX_PASSES = 8;
export const MAX_CREDENTIAL_LENGTH = 200;

const isBase32 = (s: string, n: number) => s.length === n && /^[a-z2-7]*$/.test(s);
const isHost = (h: string) =>
  h.length > 0 && h.length <= 253 && !h.startsWith(".") && !h.endsWith(".") && /^[a-z0-9.-]+$/.test(h);

/** A key, a pass or a pass reference, or null when the string is none of them. */
export function parseCredential(text: string): Credential | null {
  if (typeof text !== "string" || text.length > MAX_CREDENTIAL_LENGTH) return null;
  let kind: CredentialKind;
  let rest: string;
  if (text.startsWith("sdkey1_")) {
    kind = "key";
    rest = text.slice(7);
  } else if (text.startsWith("sdpass1_")) {
    kind = "pass";
    rest = text.slice(8);
  } else {
    return null;
  }
  const parts = rest.split("_");
  let host: string;
  let id: string;
  let secret: string | undefined;
  if (parts.length === 3) {
    [host, id, secret] = parts as [string, string, string];
    if (!isBase32(secret, 32)) return null;
  } else if (parts.length === 2 && kind === "pass") {
    kind = "pass_ref";
    [host, id] = parts as [string, string];
  } else {
    return null;
  }
  if (!isHost(host) || !isBase32(id, 16)) return null;
  return secret === undefined ? { kind, host, id } : { kind, host, id, secret };
}

/** The reference naming a pass (its secret dropped), or null when `pass` is no pass. */
export function passRefOf(pass: string): string | null {
  const c = parseCredential(pass);
  return c && (c.kind === "pass" || c.kind === "pass_ref") ? `sdpass1_${c.host}_${c.id}` : null;
}

/** The API of the network a credential names: `https://<host>`. */
export function networkOf(credential: string): string | null {
  const c = parseCredential(credential);
  return c ? `https://${c.host}` : null;
}

/**
 * The `Sdi-Pass` header: an RFC 8941 list of strings, `"sdpass1_…", "sdpass1_…"`. At most eight,
 * each a key, a pass or a pass reference.
 */
export function sdiPassHeader(strings: readonly string[]): string {
  if (strings.length === 0 || strings.length > MAX_PASSES) {
    throw new RangeError(`Sdi-Pass carries 1 to ${MAX_PASSES} strings`);
  }
  return strings
    .map((s) => {
      if (!parseCredential(s)) throw new TypeError("Sdi-Pass carries keys, passes and pass references only");
      return `"${s}"`;
    })
    .join(", ");
}

/**
 * The passes to keep, one per network (§8.4): what you hold, with those an inbox handed back in
 * `identity.passes` taking their network's place. Keep the result and present it next time.
 *
 *   held = keepPasses(held, answer.identity?.passes);
 */
export function keepPasses(
  held: readonly string[],
  fresh: readonly { readonly network?: string; readonly pass: string }[] | undefined,
): string[] {
  const byNetwork = new Map<string, string>();
  for (const s of held) {
    const c = parseCredential(s);
    if (c && !byNetwork.has(c.host)) byNetwork.set(c.host, s);
  }
  for (const f of fresh ?? []) {
    const c = parseCredential(f.pass);
    if (c && c.kind !== "key") byNetwork.set(c.host, f.pass);
  }
  return [...byNetwork.values()];
}

/** Whether a string holds a secret: a key or a pass with its secret (a pass reference does not). */
export function isSecret(text: string): boolean {
  const c = parseCredential(text);
  return c !== null && c.secret !== undefined;
}
