import { WriteError } from "../write/errors";

/**
 * The secret box (ADR-015 §2): AES-256-GCM through WebCrypto, so one implementation seals a
 * connector's credentials and a webhook's signing secret on Workers and on Node alike. No
 * node:crypto, no password stretching — the key material is already a secret, and PBKDF2 at a
 * defensible iteration count would cost about a hundred milliseconds, which the Workers CPU budget
 * cannot pay per request.
 *
 * `INBOX_SECRET_KEY` may hold several comma-separated keys, newest first. We seal with the first
 * and try each in turn when opening, so a key can be rotated without downtime: add the new key in
 * front, and every row re-seals under it the next time it is written.
 *
 * Stored form: `v1.<base64url iv>.<base64url ciphertext and tag>`.
 */

const VERSION = "v1";
const IV_BYTES = 12;
/** Domain separation for HKDF: a key derived here can never collide with one derived elsewhere. */
const INFO_PREFIX = "surfingdog-inbox/v1/";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One derived key per purpose, so a connector config is never opened as a webhook secret. */
export type SecretPurpose = "connector-config" | "webhook-secret" | "receipt-key";

/**
 * What a deterministic key is derived for. Sealing is randomised and must be; these are the few
 * places where the same input has to give the same output every time, and each gets its own key
 * so one cannot be replayed as another.
 */
export type MacPurpose = "receipt-subject";

export interface SecretBox {
  /**
   * `rowId` is bound in as additional authenticated data, so a ciphertext copied to another row —
   * or to another table — no longer opens.
   */
  seal(purpose: SecretPurpose, rowId: string, plaintext: string): Promise<string>;
  /** Rejects on a wrong key, a wrong row or a tampered byte; it never returns rubbish. */
  open(purpose: SecretPurpose, rowId: string, sealed: string): Promise<string>;
  /**
   * An HMAC key derived from the newest secret, for turning an identity into a pseudonym that is
   * stable on this instance and meaningless anywhere else. It is a `CryptoKey`, never bytes, so
   * the pepper cannot be read out of the box, logged, or exported — only used to MAC.
   *
   * Rotation is deliberately not supported here: changing the key changes every pseudonym, which
   * would break the link between a receipt already in the world and the party it is about. The
   * newest key at the time of writing is the one that counts, so put a new key at the FRONT for
   * sealing only once no pseudonym needs to match an old one.
   */
  mac(purpose: MacPurpose): Promise<CryptoKey>;
}

/** Splits an `INBOX_SECRET_KEY` value into its keys, newest first. Empty entries are dropped. */
export function parseSecretKeys(value: string | undefined | null): string[] {
  return (value ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/** Null when no usable key was given: the caller must then refuse the write, never store plaintext. */
export function createSecretBox(keys: readonly string[]): SecretBox | null {
  const material = keys.map((k) => k.trim()).filter((k) => k.length > 0);
  const newest = material[0];
  if (newest === undefined) return null;

  // Deriving an AES key runs HKDF over the key material; the result depends only on that material
  // and the purpose, both fixed for the life of the box, so the cache can never hand back a key
  // for the wrong purpose. The CryptoKey is non-extractable and the box already holds the material
  // it came from, so keeping it costs no secrecy — and every message is still unique, because the
  // uniqueness comes from the random IV, never from the key.
  const derived = new Map<string, Promise<CryptoKey>>();
  const keyFor = (index: number, secret: string, purpose: SecretPurpose): Promise<CryptoKey> => {
    const cacheKey = `${index}:${purpose}`;
    let pending = derived.get(cacheKey);
    if (!pending) {
      pending = deriveKey(secret, purpose).catch((error) => {
        derived.delete(cacheKey);
        throw error;
      });
      derived.set(cacheKey, pending);
    }
    return pending;
  };

  const macs = new Map<MacPurpose, Promise<CryptoKey>>();

  return {
    mac(purpose) {
      let pending = macs.get(purpose);
      if (!pending) {
        pending = deriveMac(newest, purpose).catch((error) => {
          macs.delete(purpose);
          throw error;
        });
        macs.set(purpose, pending);
      }
      return pending;
    },

    async seal(purpose, rowId, plaintext) {
      const key = await keyFor(0, newest, purpose);
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad(purpose, rowId) },
        key,
        encoder.encode(plaintext) as BufferSource,
      );
      return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
    },

    async open(purpose, rowId, sealed) {
      const [version, ivPart, cipherPart] = sealed.split(".");
      if (version !== VERSION || !ivPart || !cipherPart) {
        throw new Error(`not a sealed value: expected ${VERSION}.<iv>.<ciphertext>`);
      }
      const iv = fromBase64Url(ivPart);
      const cipher = fromBase64Url(cipherPart);
      if (iv.length !== IV_BYTES) throw new Error(`sealed value has a ${iv.length}-byte iv, expected ${IV_BYTES}`);
      for (let i = 0; i < material.length; i++) {
        const secret = material[i];
        if (secret === undefined) continue;
        try {
          const key = await keyFor(i, secret, purpose);
          const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad(purpose, rowId) },
            key,
            cipher as BufferSource,
          );
          return decoder.decode(plain);
        } catch {
          // Wrong key for this ciphertext: try the next one in the rotation.
        }
      }
      throw new Error(`could not open a ${purpose} secret: wrong key, wrong row, or tampered bytes`);
    },
  };
}

/**
 * Fail closed (ADR-015 §2). Without a key the instance runs exactly as it does today; what it will
 * not do is store a credential in the clear.
 */
export function requireSecretBox(box: SecretBox | null): SecretBox {
  if (box) return box;
  throw new WriteError(
    "not_allowed",
    "This instance has no INBOX_SECRET_KEY, so credentials cannot be stored. Set INBOX_SECRET_KEY to a long random string, restart, and connect again.",
    { details: { variable: "INBOX_SECRET_KEY" } },
  );
}

async function deriveKey(secret: string, purpose: SecretPurpose): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret) as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      // The key material is already high-entropy, so HKDF is here for domain separation, not for
      // stretching; an empty salt is what RFC 5869 prescribes when there is none to give.
      salt: new Uint8Array(0) as BufferSource,
      info: encoder.encode(INFO_PREFIX + purpose) as BufferSource,
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function deriveMac(secret: string, purpose: MacPurpose): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret) as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0) as BufferSource,
      info: encoder.encode(`${INFO_PREFIX}mac/${purpose}`) as BufferSource,
    },
    base,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function aad(purpose: SecretPurpose, rowId: string): BufferSource {
  return encoder.encode(`${purpose}|${rowId}`) as BufferSource;
}

/** Base64url without Buffer: the btoa idiom `randomToken` already uses, minus padding. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
