/**
 * The cryptography a phone and its inbox share (ADR-026), on Web Crypto alone so one implementation
 * runs on Workers and on Node alike, and the phone app's own fallback uses the very same code.
 *
 * - Push payloads are encrypted for the phone as Web Push encrypts them (RFC 8291, `aes128gcm`
 *   content coding of RFC 8188): an ECDH P-256 key and a 16-byte authentication secret the phone
 *   made and only the phone and this inbox know. The relay that carries the message to Google's
 *   push service sees ciphertext and nothing else.
 * - A phone proves it holds its device key (an ECDSA P-256 key that never leaves the phone's
 *   keystore) by signing a short statement when it pairs and each time it refreshes its token, so a
 *   copied refresh token is worthless on any other device.
 */

const encoder = new TextEncoder();

export function b64uEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function b64uDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("not base64url");
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const bin = atob(value.replaceAll("-", "+").replaceAll("_", "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as BufferSource));
}

/** An uncompressed P-256 point (65 bytes, 0x04 ‖ x ‖ y) as a public JWK, and back. */
export function pointToJwk(point: Uint8Array): JsonWebKey {
  if (point.length !== 65 || point[0] !== 4) throw new Error("expected an uncompressed P-256 point of 65 bytes");
  return { kty: "EC", crv: "P-256", x: b64uEncode(point.slice(1, 33)), y: b64uEncode(point.slice(33, 65)) };
}

export function jwkToPoint(jwk: JsonWebKey): Uint8Array {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new Error("expected a P-256 JWK");
  const x = b64uDecode(jwk.x);
  const y = b64uDecode(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new Error("expected 32-byte coordinates");
  return concat(new Uint8Array([4]), x, y);
}

/** RFC 8291 §4: the record size this inbox writes. One record holds every payload it sends. */
export const RECORD_SIZE = 4096;
/** The most a push payload may hold before encryption: FCM carries 4 KB of data, base64 grows it. */
export const MAX_PUSH_PLAINTEXT = 2_048;

export interface PushKeys {
  /** The phone's ECDH P-256 public key, uncompressed, base64url (as Web Push's `p256dh`). */
  readonly p256dh: string;
  /** The phone's 16-byte authentication secret, base64url (as Web Push's `auth`). */
  readonly auth: string;
}

/** What `encryptPush` may take from a test instead of fresh randomness (RFC 8291 Appendix A). */
export interface FixedEncryption {
  readonly salt: Uint8Array;
  readonly senderPrivate: JsonWebKey;
}

async function deriveKeys(
  ecdhSecret: Uint8Array,
  auth: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
  salt: Uint8Array,
): Promise<{ cek: Uint8Array; nonce: Uint8Array }> {
  // RFC 8291 §3.3-3.4, then RFC 8188 §2.2-2.3.
  const prkKey = await hmac(auth, ecdhSecret);
  const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hmac(prkKey, concat(keyInfo, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, encoder.encode("Content-Encoding: aes128gcm\0\x01"))).slice(0, 16);
  const nonce = (await hmac(prk, encoder.encode("Content-Encoding: nonce\0\x01"))).slice(0, 12);
  return { cek, nonce };
}

async function ecdh(privateKey: CryptoKey, publicPoint: Uint8Array): Promise<Uint8Array> {
  const pub = await crypto.subtle.importKey(
    "raw",
    publicPoint as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, privateKey, 256));
}

/**
 * Encrypts `plaintext` for one phone (RFC 8291 with RFC 8188 `aes128gcm`): the whole message body,
 * header (salt, record size, the sender's one-time public key) and one record. A fresh sender key
 * and salt each time, so two identical notifications look nothing alike.
 */
export async function encryptPush(keys: PushKeys, plaintext: Uint8Array, fixed?: FixedEncryption): Promise<Uint8Array> {
  if (plaintext.length > MAX_PUSH_PLAINTEXT) throw new Error(`push payload over ${MAX_PUSH_PLAINTEXT} bytes`);
  const uaPublic = b64uDecode(keys.p256dh);
  const auth = b64uDecode(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("p256dh is not an uncompressed P-256 point");
  if (auth.length !== 16) throw new Error("auth is not 16 bytes");
  let senderPrivate: CryptoKey;
  let asPublic: Uint8Array;
  if (fixed) {
    senderPrivate = await crypto.subtle.importKey(
      "jwk",
      { ...fixed.senderPrivate, key_ops: ["deriveBits"], ext: true },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    asPublic = jwkToPoint(fixed.senderPrivate);
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    senderPrivate = pair.privateKey;
    asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  }
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const secret = await ecdh(senderPrivate, uaPublic);
  const { cek, nonce } = await deriveKeys(secret, auth, uaPublic, asPublic, salt);
  const key = await crypto.subtle.importKey("raw", cek as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
  // One record, the last: the plaintext and the delimiter 0x02, no padding.
  const record = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      key,
      concat(plaintext, new Uint8Array([2])) as BufferSource,
    ),
  );
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, record);
}

/**
 * Decrypts a message `encryptPush` made, with the phone's private key. The phone does this natively
 * (it must work while the app is closed); this is the same algorithm for the app's own fallback and
 * for the tests that hold the two to each other.
 */
export async function decryptPush(
  message: Uint8Array,
  phone: { privateKey: CryptoKey; publicPoint: Uint8Array; auth: Uint8Array },
): Promise<Uint8Array> {
  if (message.length < 21) throw new Error("too short");
  const salt = message.slice(0, 16);
  const idlen = message[20] ?? 0;
  const asPublic = message.slice(21, 21 + idlen);
  const body = message.slice(21 + idlen);
  if (asPublic.length !== 65) throw new Error("the sender key is not a P-256 point");
  const secret = await ecdh(phone.privateKey, asPublic);
  const { cek, nonce } = await deriveKeys(secret, phone.auth, phone.publicPoint, asPublic, salt);
  const key = await crypto.subtle.importKey("raw", cek as BufferSource, { name: "AES-GCM" }, false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, body as BufferSource),
  );
  // Strip the padding: the last non-zero byte is the delimiter, 0x02 for the last record.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 2) throw new Error("no last-record delimiter");
  return padded.slice(0, end);
}

/** RFC 7638 thumbprint of a P-256 public key, base64url: what names a phone's device key. */
export async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return b64uEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonical))));
}

/** A public device key as a phone sends it: P-256, x and y only, nothing private. */
export function cleanDeviceKey(value: unknown): JsonWebKey | null {
  if (!value || typeof value !== "object") return null;
  const k = value as Record<string, unknown>;
  if (k.kty !== "EC" || k.crv !== "P-256" || typeof k.x !== "string" || typeof k.y !== "string") return null;
  if (k.d !== undefined) return null;
  try {
    jwkToPoint({ kty: "EC", crv: "P-256", x: k.x, y: k.y });
  } catch {
    return null;
  }
  return { kty: "EC", crv: "P-256", x: k.x, y: k.y };
}

/**
 * The statement a phone signs to prove it holds its device key: what for, which inbox, a hash of
 * the secret or token it presents (never the secret itself), and when, one per line. Bound to the
 * inbox's origin so a proof made for one inbox is no use at another.
 */
export function proofStatement(purpose: "pair" | "link" | "refresh", origin: string, hash: string, at: number): string {
  return `surfingdog-inbox-phone/1\n${purpose}\n${origin}\n${hash}\n${at}`;
}

/** How far a proof's time may be from ours: a phone's clock drifts, a replay must not last. */
export const PROOF_SKEW_MS = 5 * 60_000;

/**
 * Checks a proof: an ECDSA P-256 SHA-256 signature, raw r ‖ s (64 bytes) as Web Crypto and the
 * phone's keystore (converted) give it, over `proofStatement`.
 */
export async function verifyProof(jwk: JsonWebKey, statement: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x ?? "", y: jwk.y ?? "", ext: true } satisfies JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const sig = b64uDecode(signature);
    if (sig.length !== 64) return false;
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      sig as BufferSource,
      encoder.encode(statement) as BufferSource,
    );
  } catch {
    return false;
  }
}

/** Signs a statement with a device key: the phone app's fallback, and the tests' phone. */
export async function signProof(privateKey: CryptoKey, statement: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(statement) as BufferSource,
  );
  return b64uEncode(new Uint8Array(sig));
}

/** SHA-256 of a string, base64url: what a proof names instead of a secret. */
export async function sha256b64u(value: string): Promise<string> {
  return b64uEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

/** PKCE S256 (RFC 7636): the challenge for a verifier. */
export async function pkceS256(verifier: string): Promise<string> {
  return sha256b64u(verifier);
}
