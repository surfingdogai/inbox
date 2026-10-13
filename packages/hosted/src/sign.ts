import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed calls between this runtime and whoever runs it, over local sockets. Every request carries:
 *
 * - `X-SD-Time`: Unix seconds;
 * - `X-SD-Nonce`: 16 random bytes, hex;
 * - `X-SD-Sig`: `v1=` and the hex HMAC-SHA256, under the key for that direction, of
 *   `METHOD\nTARGET\nTIME\nNONCE\n` followed by the hex SHA-256 of the body. TARGET is the path and,
 *   when there is one, `?` and the query, exactly as sent. The key is the configured string's UTF-8
 *   bytes; the method is upper case.
 *
 * Refused (401): a time more than 60 s off, a nonce seen in the last 120 s, a signature that does
 * not match. One key per direction, so a key that leaks lets nobody answer as the other side.
 */

export const SKEW_SECONDS = 60;
export const NONCE_WINDOW_MS = 120_000;
export const MAX_SIGNED_BODY = 1024 * 1024;

export const TIME_HEADER = "x-sd-time";
export const NONCE_HEADER = "x-sd-nonce";
export const SIG_HEADER = "x-sd-sig";

function material(method: string, target: string, time: string, nonce: string, body: Uint8Array): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return `${method.toUpperCase()}\n${target}\n${time}\n${nonce}\n${digest}`;
}

export function signature(
  key: string,
  method: string,
  target: string,
  time: string,
  nonce: string,
  body: Uint8Array,
): string {
  return `v1=${createHmac("sha256", Buffer.from(key, "utf8"))
    .update(material(method, target, time, nonce, body))
    .digest("hex")}`;
}

/** The three headers for one request. */
export function signHeaders(
  key: string,
  method: string,
  target: string,
  body: Uint8Array = new Uint8Array(),
  now: number = Date.now(),
): Record<string, string> {
  const time = String(Math.floor(now / 1000));
  const nonce = randomBytes(16).toString("hex");
  return {
    [TIME_HEADER]: time,
    [NONCE_HEADER]: nonce,
    [SIG_HEADER]: signature(key, method, target, time, nonce, body),
  };
}

/** Nonces seen in the window, forgotten once they are too old to be accepted again anyway. */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly windowMs: number = NONCE_WINDOW_MS) {}

  /** True the first time `nonce` is seen within the window; false for a replay. */
  claim(nonce: string, now: number): boolean {
    this.sweep(now);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now);
    return true;
  }

  private sweep(now: number): void {
    for (const [nonce, at] of this.seen) {
      if (now - at < this.windowMs) break;
      this.seen.delete(nonce);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly why: string };

/** Checks one signed request: the headers, the time, the signature, then the nonce. */
export function verifySigned(
  key: string,
  nonces: NonceCache,
  req: {
    readonly method: string;
    readonly target: string;
    readonly headers: { get(name: string): string | null };
    readonly body: Uint8Array;
  },
  now: number = Date.now(),
): VerifyResult {
  const time = req.headers.get(TIME_HEADER) ?? "";
  const nonce = req.headers.get(NONCE_HEADER) ?? "";
  const sig = req.headers.get(SIG_HEADER) ?? "";
  if (!/^\d{1,12}$/.test(time) || !/^[0-9a-f]{32}$/.test(nonce) || !/^v1=[0-9a-f]{64}$/.test(sig)) {
    return { ok: false, why: "unsigned" };
  }
  if (Math.abs(Math.floor(now / 1000) - Number(time)) > SKEW_SECONDS) return { ok: false, why: "stale" };
  const want = Buffer.from(signature(key, req.method, req.target, time, nonce, req.body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, why: "bad_signature" };
  // Only a request that is otherwise good spends its nonce: a forged one cannot burn a real one.
  if (!nonces.claim(nonce, now)) return { ok: false, why: "replayed" };
  return { ok: true };
}
