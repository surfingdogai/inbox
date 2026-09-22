import type { ReceiptAckPayload, ReceiptHeader, ReceiptPayload } from "@surfingdog/spec";

/**
 * Receipts: Ed25519 compact JWS, hand-rolled on WebCrypto (ADR-016).
 *
 * Hand-rolled because the whole of it is below, it runs unchanged in a Worker, in Node and in a
 * browser, and a signature format is not a place to inherit a dependency's opinions. The format
 * is plain JWS -- base64url(header).base64url(payload).base64url(signature) -- which any JOSE
 * library in any language verifies.
 *
 * Nothing here touches the database. Keys in, bytes out, which is what makes the awkward parts
 * testable against fixed vectors.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const RECEIPT_TYP = "sdi-receipt+jws";
export const ACK_TYP = "sdi-receipt-ack+jws";
export const ALG = "EdDSA";

/** Ed25519 as WebCrypto names it. Node, workerd and browsers all take this shape. */
const ED25519 = { name: "Ed25519" } as const;

export interface PublicJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
  readonly [k: string]: unknown;
}

export interface PrivateJwk extends PublicJwk {
  readonly d: string;
}

export interface KeyPair {
  readonly kid: string;
  readonly publicJwk: PublicJwk;
  readonly privateJwk: PrivateJwk;
}

/* --- base64url ----------------------------------------------------------- */

export function b64u(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function b64uJson(value: unknown): string {
  return b64u(encoder.encode(JSON.stringify(value)));
}

/* --- keys ---------------------------------------------------------------- */

/**
 * A new signing key. `kid` is the RFC 7638 thumbprint of the public JWK, so it is derived from
 * the key rather than allocated: two instances cannot collide, and a key's name cannot be wrong.
 */
export async function generateKeyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as { x?: string };
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as { d?: string };
  const clean = { kty: "OKP", crv: "Ed25519", x: String(pub.x) } as const;
  const kid = await thumbprint(clean);
  return {
    kid,
    publicJwk: { ...clean, kid, alg: ALG, use: "sig" },
    privateJwk: { ...clean, d: String(priv.d), kid, alg: ALG, use: "sig" },
  };
}

/**
 * RFC 7638: SHA-256 over the required members, lexicographic, no whitespace. For an OKP key that
 * is crv, kty and x, and the order below is that order -- it is not alphabetical by accident,
 * it is the specification.
 */
export async function thumbprint(jwk: { kty: string; crv: string; x: string }): Promise<string> {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`;
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical) as BufferSource);
  return b64u(new Uint8Array(digest));
}

async function importPrivate(jwk: PrivateJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["sign"], ext: true }, ED25519, false, ["sign"]);
}

async function importPublic(jwk: PublicJwk): Promise<CryptoKey> {
  const { d: _drop, ...rest } = jwk as PrivateJwk;
  return crypto.subtle.importKey("jwk", { ...rest, key_ops: ["verify"], ext: true }, ED25519, false, ["verify"]);
}

/* --- signing ------------------------------------------------------------- */

/** A receipt, signed. The header's `typ` is ours, so a receipt cannot be mistaken for a token. */
export async function signReceipt(payload: ReceiptPayload, key: KeyPair): Promise<string> {
  const header: ReceiptHeader = { alg: ALG, typ: RECEIPT_TYP, kid: key.kid };
  return compactSign(header, payload, key.privateJwk);
}

async function compactSign(header: object, payload: object, privateJwk: PrivateJwk): Promise<string> {
  const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;
  const signature = await crypto.subtle.sign(
    ED25519,
    await importPrivate(privateJwk),
    encoder.encode(signingInput) as BufferSource,
  );
  return `${signingInput}.${b64u(new Uint8Array(signature))}`;
}

export class ReceiptError extends Error {
  readonly code:
    | "malformed"
    | "bad_alg"
    | "bad_typ"
    | "unknown_key"
    | "bad_signature"
    | "bad_payload"
    | "expired"
    | "not_yet";

  constructor(code: ReceiptError["code"], message: string) {
    super(message);
    this.name = "ReceiptError";
    this.code = code;
  }
}

interface Parsed {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly signingInput: string;
  readonly signature: Uint8Array;
}

function parse(jws: string): Parsed {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new ReceiptError("malformed", "a compact JWS has three parts");
  const [h, p, s] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(decoder.decode(unb64u(h) as BufferSource)) as Record<string, unknown>;
    payload = JSON.parse(decoder.decode(unb64u(p) as BufferSource)) as Record<string, unknown>;
  } catch {
    throw new ReceiptError("malformed", "the header or the payload is not base64url JSON");
  }
  return { header, payload, signingInput: `${h}.${p}`, signature: unb64u(s) };
}

/**
 * The published key a receipt names. A JWKS entry normally carries its `kid`; one that does not is
 * still legal, so the thumbprint is recomputed for it rather than the receipt refused — the kid IS
 * the thumbprint, so nothing else could match.
 */
async function keyFor(keys: readonly PublicJwk[], kid: string): Promise<PublicJwk | undefined> {
  if (!kid) return undefined;
  const named = keys.find((k) => k.kid === kid);
  if (named) return named;
  for (const k of keys) {
    if (k.kid === undefined && k.kty === "OKP" && k.crv === "Ed25519" && (await thumbprint(k)) === kid) return k;
  }
  return undefined;
}

/**
 * Verifies a receipt against the keys an instance publishes.
 *
 * The algorithm comes from OUR list, never from the token: `alg` is read only to refuse anything
 * that is not EdDSA, which is the oldest mistake in JOSE and still the commonest.
 */
export async function verifyReceipt(jws: string, keys: readonly PublicJwk[]): Promise<ReceiptPayload> {
  const { header, payload, signingInput, signature } = parse(jws);
  if (header.alg !== ALG) throw new ReceiptError("bad_alg", `a receipt is signed ${ALG}, not ${String(header.alg)}`);
  if (header.typ !== RECEIPT_TYP) throw new ReceiptError("bad_typ", `this is not a ${RECEIPT_TYP}`);
  const kid = typeof header.kid === "string" ? header.kid : "";
  const jwk = await keyFor(keys, kid);
  if (!jwk) throw new ReceiptError("unknown_key", `no published key with kid ${kid || "(none)"}`);
  const ok = await crypto.subtle.verify(
    ED25519,
    await importPublic(jwk),
    signature as BufferSource,
    encoder.encode(signingInput) as BufferSource,
  );
  if (!ok) throw new ReceiptError("bad_signature", "the signature does not match that key");
  return payload as unknown as ReceiptPayload;
}

/* --- the acknowledgement ------------------------------------------------- */

/**
 * The customer's agent counter-signs with its own key, carried in the header as `jwk` because
 * the instance has no directory of customer agents and should not want one. The key proves only
 * that whoever acked held it, which is the whole claim being made.
 */
/** base64url(SHA-256(compact JWS)), the value an acknowledgement carries as `sha`. */
export async function receiptSha(receiptJws: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(receiptJws) as BufferSource);
  return b64u(new Uint8Array(digest));
}

/**
 * Verifies an acknowledgement: the agent's own signature under the key in its header, and that
 * it names THIS receipt — by the id the instance gave it and by the hash of the receipt itself,
 * which is the check a network can repeat without knowing any id.
 */
export async function verifyAck(
  jws: string,
  expect: { receiptId: string; receiptJws: string; now: number; maxAgeSec?: number },
): Promise<{ payload: ReceiptAckPayload; agentJwk: PublicJwk; agentKid: string }> {
  const { header, payload, signingInput, signature } = parse(jws);
  if (header.alg !== ALG) throw new ReceiptError("bad_alg", `an acknowledgement is signed ${ALG}`);
  if (header.typ !== undefined && header.typ !== ACK_TYP) {
    throw new ReceiptError("bad_typ", `this is not a ${ACK_TYP}`);
  }
  const jwk = header.jwk as PublicJwk | undefined;
  if (jwk?.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new ReceiptError("malformed", "the header must carry the agent's Ed25519 public jwk");
  }
  const ok = await crypto.subtle.verify(
    ED25519,
    await importPublic(jwk),
    signature as BufferSource,
    encoder.encode(signingInput) as BufferSource,
  );
  if (!ok) throw new ReceiptError("bad_signature", "the signature does not match the key in the header");

  const body = payload as unknown as ReceiptAckPayload;
  if (body.rcp !== expect.receiptId) {
    throw new ReceiptError("bad_payload", "this acknowledges a different receipt");
  }
  if (typeof body.sha !== "string" || body.sha !== (await receiptSha(expect.receiptJws))) {
    throw new ReceiptError("bad_payload", "sha does not match the receipt being acknowledged");
  }
  const iat = Number(body.iat);
  if (!Number.isFinite(iat)) throw new ReceiptError("bad_payload", "iat is missing");
  const age = Math.floor(expect.now / 1000) - iat;
  const maxAge = expect.maxAgeSec ?? 3600;
  // Both directions: an acknowledgement dated tomorrow is as wrong as one from last year, and
  // accepting it would let a captured one be replayed at us later.
  if (age > maxAge) throw new ReceiptError("expired", `this acknowledgement is ${age}s old`);
  if (-age > 300) throw new ReceiptError("not_yet", "this acknowledgement is dated in the future");

  return { payload: body, agentJwk: jwk, agentKid: await thumbprint(jwk) };
}

/**
 * Which receipt an acknowledgement claims to be for, read WITHOUT verifying anything. It exists
 * only so the caller can fetch that row and then hand its id to `verifyAck`, which checks the
 * claim properly; nothing is decided on this value alone.
 */
export function peekAckReceiptId(jws: string): string | null {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    const body = JSON.parse(decoder.decode(unb64u(parts[1] as string))) as { rcp?: unknown };
    return typeof body.rcp === "string" && body.rcp.length > 0 && body.rcp.length <= 64 ? body.rcp : null;
  } catch {
    return null;
  }
}

/** 128 bits of hex. A network deduplicates a receipt on (iss, nonce). */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The subject: who a receipt is about, without saying who they are. An HMAC under a key only this
 * instance holds, so the same customer at another instance hashes differently and nobody can
 * assemble a history across instances without us — and nobody who sees a pseudonym can work
 * backwards to the address, even by trying every address they can think of.
 *
 * HMAC and not `SHA-256(secret || identity)`: that construction can be extended by anyone holding
 * one output, and a pseudonym is exactly the kind of value that gets published.
 */
export async function subjectHash(key: CryptoKey, identity: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(identity) as BufferSource);
  return b64u(new Uint8Array(mac));
}
