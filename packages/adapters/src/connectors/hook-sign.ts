import { constantTimeEqual, hmacSha256Hex } from "./pay-sign";

/**
 * Webhook signatures for every connector told by webhook at its own address (ADR-030 §4), with Web
 * Crypto only: an HMAC-SHA-256 over the exact bytes received, as hex or as base64, compared in
 * constant time. Shopify signs with `X-Shopify-Hmac-Sha256` (base64), Square with
 * `x-square-hmacsha256-signature` (base64, over the notification URL and the body), WooCommerce with
 * `X-WC-Webhook-Signature` (base64); each connector says which header and what is signed, and checks it
 * here. `pay-sign.ts` keeps its own exports for Stripe and Mollie.
 *
 * - https://shopify.dev/docs/apps/build/webhooks/subscribe/https#step-5-verify-the-webhook
 * - https://developer.squareup.com/docs/webhooks/step3validate
 * - https://woocommerce.com/document/webhooks/
 */

export { constantTimeEqual, hmacSha256Hex };

const encoder = new TextEncoder();

async function mac(key: string, message: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(message)));
}

/** HMAC-SHA-256 of `message` under `key`, as standard base64 (with padding). */
export async function hmacSha256Base64(key: string, message: string): Promise<string> {
  let binary = "";
  for (const b of await mac(key, message)) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Whether `signature` is the base64 HMAC-SHA-256 of `message` under `key`, in constant time. A
 * signature that is missing or empty never checks out.
 */
export async function verifyBase64Hmac(key: string, message: string, signature: string | null): Promise<boolean> {
  if (!signature || !key) return false;
  return constantTimeEqual(await hmacSha256Base64(key, message), signature.trim());
}

/** Whether `signature` is the hex HMAC-SHA-256 of `message` under `key` (any case), in constant time. */
export async function verifyHexHmac(key: string, message: string, signature: string | null): Promise<boolean> {
  if (!signature || !key) return false;
  return constantTimeEqual(await hmacSha256Hex(key, message), signature.trim().toLowerCase());
}
