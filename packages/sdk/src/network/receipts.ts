import { b64u, utf8 } from "../agent/encoding.js";
import { thumbprint } from "../agent/keys.js";
import { RECEIPT_TYP } from "../agent/receipts.js";
import type { InstanceSigningKey } from "./instance.js";

/**
 * Issuing a receipt (ADR-016; network protocol §6): what an inbox signs when it makes a promise and
 * when the promise closes, and a network verifies with `verifyReceipt` against the `receipt_keys` of
 * the issuer's manifest. A compact JWS, `EdDSA` over Ed25519, header `{alg, typ, kid}`.
 *
 * The claims are the caller's, written as §6 lists them; this signs them as given, and
 * `@surfingdog/spec` has their schemas to check them first.
 */
export async function signReceipt(claims: Readonly<Record<string, unknown>>, key: InstanceSigningKey): Promise<string> {
  const header = { alg: "EdDSA", typ: RECEIPT_TYP, kid: key.kid };
  const signingInput = `${b64u(utf8(JSON.stringify(header)))}.${b64u(utf8(JSON.stringify(claims)))}`;
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: key.privateJwk.x, d: key.privateJwk.d, key_ops: ["sign"], ext: true },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, privateKey, utf8(signingInput) as BufferSource),
  );
  return `${signingInput}.${b64u(signature)}`;
}

/** A new Ed25519 receipt key, named by its RFC 7638 thumbprint as a manifest publishes it. */
export async function generateReceiptKey(): Promise<
  InstanceSigningKey & { readonly publicJwk: { kty: "OKP"; crv: "Ed25519"; x: string; kid: string } }
> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as { x: string; d: string };
  const kid = await thumbprint({ kty: "OKP", crv: "Ed25519", x: jwk.x });
  return {
    kid,
    privateJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d },
    publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, kid },
  };
}
