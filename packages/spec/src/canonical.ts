/**
 * Canonical JSON, as the catalogue's `hash` is taken over (docs/protocol/network.md §4.18; vectors in
 * `vectors/catalogue-signature.json`): RFC 8785, the JSON Canonicalization Scheme, over the values a
 * catalogue holds.
 *
 * - An object's members sorted by their names, compared as sequences of UTF-16 code units; a member whose
 *   value is absent is not written, and `null` is written as `null`.
 * - An array in its own order.
 * - No whitespace anywhere.
 * - A string as ECMAScript's `JSON.stringify` writes it: `"` and `\` escaped, U+0008, U+0009, U+000A,
 *   U+000C and U+000D as `\b`, `\t`, `\n`, `\f`, `\r`, every other code point below U+0020 as `\u00xx` in
 *   lower case, and everything else as itself in UTF-8: `<`, `>`, `&`, U+2028, U+2029 and every
 *   non-ASCII character are never escaped. A string holding half of a surrogate pair is not JSON a
 *   catalogue may carry, and is refused.
 * - A number as ECMAScript writes it (`4500`, `15.25`, `0.001`, `-1`); `-0` as `0`. Every number a catalogue
 *   holds is an integer or has at most three decimals, so a reader in any language writes the same digits.
 *
 * Go's `encoding/json` is not this: it escapes `<`, `>` and `&` unless told not to, and escapes U+2028 and
 * U+2029 always.
 */
export function canonicalJson(value: unknown): string {
  return write(value, "");
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function write(value: unknown, at: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`${at || "the value"}: not a finite number`);
      return JSON.stringify(value === 0 ? 0 : value);
    case "string":
      if (LONE_SURROGATE.test(value)) throw new TypeError(`${at || "the value"}: half of a surrogate pair`);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v, i) => write(v, `${at}[${i}]`)).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${write(k, at)}:${write(obj[k], at ? `${at}.${k}` : k)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`${at || "the value"}: ${typeof value} is not JSON`);
  }
}

/** SHA-256 of a text's UTF-8 bytes, as lowercase hex (Web Crypto: Node, workerd and browsers alike). */
export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text) as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
