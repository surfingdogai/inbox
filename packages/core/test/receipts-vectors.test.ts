import { describe, expect, it } from "vitest";
import vectors from "../../spec/vectors/receipts.json";
import {
  generateKeyPair,
  ReceiptError,
  signReceipt,
  subjectHash,
  thumbprint,
  verifyAck,
  verifyReceipt,
} from "../src/receipts/sign";
import { createSecretBox } from "../src/secrets/box";

/**
 * The published vectors (packages/spec/vectors/receipts.json, MIT) hold on both runtimes. A second
 * implementation — the Go network, another inbox — is right when it agrees with this file, so this
 * file has to agree with the code, byte for byte where Ed25519 makes that possible.
 */
type Jwk = { kty: "OKP"; crv: "Ed25519"; x: string; kid?: string; d?: string };
const issuer = vectors.issuer as { kid: string; public_jwk: Jwk; private_jwk: Jwk & { d: string } };
const agent = vectors.agent as { kid: string; public_jwk: Jwk; private_jwk: Jwk & { d: string } };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "accepted";
  } catch (e) {
    return e instanceof ReceiptError ? e.code : `other:${String(e)}`;
  }
}

describe("receipt vectors", () => {
  it("name their keys by RFC 7638 thumbprint", async () => {
    expect(await thumbprint(issuer.public_jwk)).toBe(issuer.kid);
    expect(await thumbprint(agent.public_jwk)).toBe(agent.kid);
    // RFC 8037 A.1 — the published key, so the vector is anyone's to reproduce.
    expect(issuer.public_jwk.x).toBe("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo");
  });

  it("verify against a JWKS entry that carries no kid, by recomputing the thumbprint", async () => {
    const { kid: _dropped, ...bare } = issuer.public_jwk;
    const v = vectors.receipts[0];
    if (!v) throw new Error("no vector");
    expect(await verifyReceipt(v.jws, [bare as never])).toEqual(v.payload);
  });

  it("derive the subject exactly as documented", async () => {
    const box = createSecretBox([vectors.subject.secret]);
    if (!box) throw new Error("box");
    expect(await subjectHash(await box.mac("receipt-subject"), vectors.subject.identity)).toBe(vectors.subject.sub);
  });

  for (const v of vectors.receipts) {
    it(`receipt: ${v.name} verifies and re-signs identically`, async () => {
      expect(await verifyReceipt(v.jws, [issuer.public_jwk])).toEqual(v.payload);
      const again = await signReceipt(v.payload as never, {
        kid: issuer.kid,
        publicJwk: issuer.public_jwk,
        privateJwk: issuer.private_jwk,
      });
      expect(again).toBe(v.jws);
      // And not against some other key.
      const other = await generateKeyPair();
      expect(await codeOf(verifyReceipt(v.jws, [other.publicJwk]))).toBe("unknown_key");
    });
  }

  for (const v of vectors.refused_receipts) {
    it(`refused receipt: ${v.name} → ${v.error}`, async () => {
      expect(await codeOf(verifyReceipt(v.jws, [issuer.public_jwk]))).toBe(v.error);
    });
  }

  for (const v of vectors.acknowledgements) {
    it(`acknowledgement: ${v.name}`, async () => {
      const out = await verifyAck(v.jws, { receiptId: v.receipt_id, now: v.verify_at * 1000 });
      expect(out.payload).toEqual(v.payload);
      expect(out.agentKid).toBe(agent.kid);
    });
  }

  for (const v of vectors.refused_acknowledgements) {
    it(`refused acknowledgement: ${v.name} → ${v.error}`, async () => {
      expect(await codeOf(verifyAck(v.jws, { receiptId: v.receipt_id, now: v.verify_at * 1000 }))).toBe(v.error);
    });
  }
});
