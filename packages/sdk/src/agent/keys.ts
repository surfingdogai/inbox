import { b64u, fromB64u, sha256, utf8 } from "./encoding.js";

/**
 * An agent's own Ed25519 key (ADR-017 §2.4, §7.2): generated here, kept by the agent, never sent.
 * Only its public half travels, in `Sdi-Agent-Key` on a signed request and as `jwk` in an
 * acknowledgement's header; a network knows it by its RFC 7638 thumbprint once the person
 * delegates it to their pass.
 */

/** An Ed25519 public key as a JWK: exactly what `Sdi-Agent-Key` carries. */
export interface AgentPublicJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
}

/** The private half, `d`: store it as you would a password. */
export interface AgentPrivateJwk extends AgentPublicJwk {
  readonly d: string;
}

export interface AgentKey {
  readonly publicJwk: AgentPublicJwk;
  readonly privateJwk: AgentPrivateJwk;
  /** RFC 7638 thumbprint of the public key, base64url: the `keyid` of every signature it makes. */
  readonly thumbprint: string;
}

/** What a signing call accepts: a key from `generateAgentKey`, or just its private JWK. */
export type AgentKeyInput = AgentKey | { readonly privateJwk: AgentPrivateJwk; readonly thumbprint?: string };

const ED25519 = { name: "Ed25519" } as const;

/** A fresh key. Keep `privateJwk` somewhere safe; anyone holding it signs as this agent. */
export async function generateAgentKey(): Promise<AgentKey> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as { x?: string; d?: string };
  if (!jwk.x || !jwk.d) throw new Error("this runtime did not export an Ed25519 key");
  const publicJwk: AgentPublicJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x };
  return { publicJwk, privateJwk: { ...publicJwk, d: jwk.d }, thumbprint: await thumbprint(publicJwk) };
}

/**
 * RFC 7638: SHA-256 over the required members in lexicographic order with no whitespace
 * (`{"crv":"Ed25519","kty":"OKP","x":"…"}`), base64url. 43 characters.
 */
export async function thumbprint(jwk: {
  readonly crv: string;
  readonly kty: string;
  readonly x: string;
}): Promise<string> {
  const canonical = `{"crv":${JSON.stringify(jwk.crv)},"kty":${JSON.stringify(jwk.kty)},"x":${JSON.stringify(jwk.x)}}`;
  return b64u(await sha256(utf8(canonical)));
}

/** Checks a key's shape and fills in its public half and thumbprint. */
export async function resolveAgentKey(key: AgentKeyInput): Promise<AgentKey> {
  const p = key.privateJwk;
  if (p?.kty !== "OKP" || p.crv !== "Ed25519" || typeof p.x !== "string" || typeof p.d !== "string") {
    throw new TypeError("an agent key is an Ed25519 private JWK: kty OKP, crv Ed25519, x and d");
  }
  if (fromB64u(p.x).length !== 32 || fromB64u(p.d).length !== 32) {
    throw new TypeError("x and d are 32 bytes each, base64url");
  }
  const publicJwk: AgentPublicJwk = { kty: "OKP", crv: "Ed25519", x: p.x };
  const tp = await thumbprint(publicJwk);
  if (key.thumbprint !== undefined && key.thumbprint !== tp) {
    throw new TypeError("the thumbprint given is not this key's");
  }
  return { publicJwk, privateJwk: { kty: "OKP", crv: "Ed25519", x: p.x, d: p.d }, thumbprint: tp };
}

/** Ed25519 over `message`, with the key's private half. */
export async function signBytes(key: AgentKey, message: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    { ...key.privateJwk, key_ops: ["sign"], ext: true },
    ED25519,
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign(ED25519, cryptoKey, message as BufferSource));
}

/** Ed25519 verification under a public JWK; false for anything malformed. */
export async function verifyBytes(
  jwk: { readonly x: string },
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: jwk.x, key_ops: ["verify"], ext: true },
      ED25519,
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(ED25519, key, signature as BufferSource, message as BufferSource);
  } catch {
    return false;
  }
}
