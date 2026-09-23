/**
 * Email normalisation (ADR-017 §2), byte for byte the network's, with no Unicode table on either
 * side: no two Unicode lowercasings (JavaScript's, Go's) agree on every letter, and the network keys
 * a person by `HMAC(secret, normalised email)`, so one differing byte is a different person.
 *
 * - Trim ASCII whitespace; refuse spaces and control characters inside, and anything over 320
 *   bytes of UTF-8.
 * - Split at the last `@`. The local part must be a dot-atom: none of RFC 5322's specials
 *   `( ) < > [ ] \ , ; : @ "` (so a quoted local part is refused). Only ASCII `A`–`Z` is
 *   lowercased; no NFC, no dot or plus folding.
 * - Drop one trailing dot from the domain. Lowercase ASCII `A`–`Z` in each label, encode a label
 *   with any non-ASCII character as RFC 3492 punycode (hand-rolled here, never `new URL()`, which
 *   applies UTS 46), then require letters, digits and hyphens, 1 to 63 of them.
 *
 * Anything else is refused, not repaired: a code is mailed to the address as typed, and
 * `me@evil.example,x@gmail.com` must not become one person at gmail.com whose codes a mail API may
 * also deliver to evil.example.
 */

const encoder = new TextEncoder();

const ASCII_WHITESPACE = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;
const LOCAL_SPECIALS = /["()<>[\]\\,;:@]/;

/** The normalised address, or null when it is not one this protocol can use ("no email, no issuance"). */
export function normaliseEmail(input: string): string | null {
  // A string that crossed a JSON boundary to the network has its lone surrogates replaced with
  // U+FFFD by the network's decoder; doing the same here keeps the two byte-identical.
  const s = input.toWellFormed().replace(ASCII_WHITESPACE, "");
  if (s === "" || encoder.encode(s).length > 320) return null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return null;
  }
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return null;
  const local = s.slice(0, at);
  let domain = s.slice(at + 1);
  if (LOCAL_SPECIALS.test(local)) return null;
  if (domain.endsWith(".")) domain = domain.slice(0, -1);
  if (domain === "") return null;
  const labels = domain.split(".");
  for (let i = 0; i < labels.length; i++) {
    let label = labels[i] as string;
    if (label === "") return null;
    label = asciiLower(label);
    if (!isAscii(label)) {
      const encoded = punycodeEncode(label);
      if (encoded === null) return null;
      label = `xn--${encoded}`;
    }
    if (!/^[a-z0-9-]{1,63}$/.test(label)) return null;
    labels[i] = label;
  }
  return `${asciiLower(local)}@${labels.join(".")}`;
}

/** Lowercases ASCII `A`–`Z` and nothing else. */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0x80) return false;
  return true;
}

/* --- RFC 3492 ------------------------------------------------------------------------------- */

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const MAX_INT = 2 ** 31 - 1;

const digit = (d: number): string => String.fromCharCode(d < 26 ? 97 + d : 22 + d); // a–z, then 0–9

function adapt(delta: number, numPoints: number, first: boolean): number {
  let d = first ? Math.floor(delta / DAMP) : Math.floor(delta / 2);
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > Math.floor(((BASE - T_MIN) * T_MAX) / 2)) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

/** One label as RFC 3492 punycode, without the `xn--` prefix; null on overflow. */
export function punycodeEncode(label: string): string | null {
  const points = Array.from(label, (c) => c.codePointAt(0) as number);
  let out = "";
  for (const p of points) if (p < 0x80) out += String.fromCharCode(p);
  const b = out.length;
  let h = b;
  if (b > 0) out += "-";
  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  while (h < points.length) {
    let m = 0x110000;
    for (const p of points) if (p >= n && p < m) m = p;
    if (m - n > Math.floor((MAX_INT - delta) / (h + 1))) return null;
    delta += (m - n) * (h + 1);
    n = m;
    for (const p of points) {
      if (p < n) delta++;
      if (p === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = k - bias < T_MIN ? T_MIN : k - bias > T_MAX ? T_MAX : k - bias;
          if (q < t) break;
          out += digit(t + ((q - t) % (BASE - t)));
          q = Math.floor((q - t) / (BASE - t));
        }
        out += digit(q);
        bias = adapt(delta, h + 1, h === b);
        delta = 0;
        h++;
      }
    }
    delta++;
    n++;
  }
  return out;
}
