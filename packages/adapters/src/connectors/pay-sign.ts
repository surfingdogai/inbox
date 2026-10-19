/**
 * The signatures payment platforms put on their webhooks (ADR-023), checked with Web Crypto only: an
 * HMAC-SHA-256 over the exact bytes received, compared in constant time.
 */

const encoder = new TextEncoder();

/** HMAC-SHA-256 of `message` under `key`, as lowercase hex. */
export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(message)));
  let out = "";
  for (const b of mac) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Whether two strings are equal, taking as long whatever they hold. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
