import type { ReceiptPayload } from "@surfingdog/spec";
import { receiptPayloadSchema } from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import {
  ACK_TYP,
  ALG,
  b64u,
  generateKeyPair,
  newNonce,
  RECEIPT_TYP,
  ReceiptError,
  signReceipt,
  subjectHash,
  thumbprint,
  unb64u,
  verifyAck,
  verifyReceipt,
} from "../src/receipts/sign";
import { createSecretBox, requireSecretBox } from "../src/secrets/box";

/**
 * Receipts (ADR-016). Ed25519 compact JWS on WebCrypto, so this has to hold on Node and inside
 * workerd identically: a receipt issued on one and verified on the other is the whole point.
 */
const NOW = Date.parse("2026-09-22T12:00:00Z");

function payload(over: Partial<ReceiptPayload> = {}): ReceiptPayload {
  return receiptPayloadSchema.parse({
    iss: "https://inbox.example.com",
    sub: "Zm9vYmFyYmF6cXV1eGZvb2JhcmJhenF1dXhmb29iYXJiYXo",
    itm: "01M34AVYNXTNSE2RC495H3W8QS",
    typ: "booking",
    knd: "confirmed",
    iat: Math.floor(NOW / 1000),
    nonce: "0123456789abcdef0123456789abcdef",
    ...over,
  });
}

describe("base64url", () => {
  it("round-trips bytes, with no padding and no + or /", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const text = b64u(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect([...unb64u(text)]).toEqual([...bytes]);
  });
});

describe("keys", () => {
  it("names a key by its own thumbprint, so two instances cannot collide", async () => {
    const key = await generateKeyPair();
    expect(key.publicJwk.kty).toBe("OKP");
    expect(key.publicJwk.crv).toBe("Ed25519");
    expect(key.kid).toBe(await thumbprint(key.publicJwk));
    // The public half must never carry the private one.
    expect(Object.keys(key.publicJwk)).not.toContain("d");
    expect(key.privateJwk.d).toBeTruthy();
  });

  it("is RFC 7638: crv, kty, x, in that order, no whitespace", async () => {
    // The published vector from RFC 8037 appendix A.3.
    const kid = await thumbprint({ kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" });
    expect(kid).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
  });
});

describe("a receipt", () => {
  it("is signed and verifies against the published key", async () => {
    const key = await generateKeyPair();
    const jws = await signReceipt(payload(), key);
    expect(jws.split(".")).toHaveLength(3);

    const header = JSON.parse(new TextDecoder().decode(unb64u(jws.split(".")[0] as string)));
    expect(header).toEqual({ alg: ALG, typ: RECEIPT_TYP, kid: key.kid });

    const back = await verifyReceipt(jws, [key.publicJwk]);
    expect(back.itm).toBe("01M34AVYNXTNSE2RC495H3W8QS");
    expect(back.knd).toBe("confirmed");
  });

  it("carries the amount when there is one", async () => {
    const key = await generateKeyPair();
    const jws = await signReceipt(payload({ knd: "paid", amt: { value: 4500, currency: "EUR" }, pay: "card" }), key);
    const back = await verifyReceipt(jws, [key.publicJwk]);
    expect(back.amt).toEqual({ value: 4500, currency: "EUR" });
    expect(back.pay).toBe("card");
  });

  it("refuses a tampered payload", async () => {
    const key = await generateKeyPair();
    const jws = await signReceipt(payload({ amt: { value: 4500, currency: "EUR" } }), key);
    const [h, p, s] = jws.split(".") as [string, string, string];
    const forged = JSON.parse(new TextDecoder().decode(unb64u(p)));
    forged.amt.value = 1;
    const tampered = `${h}.${b64u(new TextEncoder().encode(JSON.stringify(forged)))}.${s}`;
    await expect(verifyReceipt(tampered, [key.publicJwk])).rejects.toThrow(/does not match/);
  });

  it("refuses a key it never published", async () => {
    const mine = await generateKeyPair();
    const theirs = await generateKeyPair();
    const jws = await signReceipt(payload(), theirs);
    await expect(verifyReceipt(jws, [mine.publicJwk])).rejects.toThrow(ReceiptError);
  });

  it("takes the algorithm from our list, never from the token", async () => {
    const key = await generateKeyPair();
    const jws = await signReceipt(payload(), key);
    const [, p, s] = jws.split(".") as [string, string, string];
    // The classic attack: claim "none" and hope the verifier believes the header.
    const none = b64u(new TextEncoder().encode(JSON.stringify({ alg: "none", typ: RECEIPT_TYP, kid: key.kid })));
    await expect(verifyReceipt(`${none}.${p}.${s}`, [key.publicJwk])).rejects.toThrow(/signed EdDSA/);
    await expect(verifyReceipt(`${none}.${p}.`, [key.publicJwk])).rejects.toThrow(ReceiptError);
  });

  it("refuses something that is merely a token", async () => {
    const key = await generateKeyPair();
    const jws = await signReceipt(payload(), key);
    const [, p, s] = jws.split(".") as [string, string, string];
    const jwt = b64u(new TextEncoder().encode(JSON.stringify({ alg: ALG, typ: "JWT", kid: key.kid })));
    await expect(verifyReceipt(`${jwt}.${p}.${s}`, [key.publicJwk])).rejects.toThrow(/not a sdi-receipt/);
  });

  it("refuses what is not a JWS at all", async () => {
    const key = await generateKeyPair();
    for (const bad of ["", "a.b", "a.b.c.d", "not-base64.not-base64.not-base64"]) {
      await expect(verifyReceipt(bad, [key.publicJwk]), bad).rejects.toThrow(ReceiptError);
    }
  });
});

describe("the acknowledgement", () => {
  /** An agent counter-signs with its own key, carried in the header. */
  async function ack(receiptId: string, iatSec: number, typ: string | undefined = ACK_TYP) {
    const agent = await generateKeyPair();
    const header: Record<string, unknown> = { alg: ALG, jwk: agent.publicJwk };
    if (typ !== undefined) header.typ = typ;
    const enc = new TextEncoder();
    const signingInput = `${b64u(enc.encode(JSON.stringify(header)))}.${b64u(enc.encode(JSON.stringify({ rcp: receiptId, iat: iatSec })))}`;
    const key = await crypto.subtle.importKey(
      "jwk",
      { ...agent.privateJwk, key_ops: ["sign"], ext: true },
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(signingInput) as BufferSource);
    return { jws: `${signingInput}.${b64u(new Uint8Array(sig))}`, agent };
  }

  it("is accepted, and names the agent that signed it", async () => {
    const { jws, agent } = await ack("rcp_1", Math.floor(NOW / 1000));
    const out = await verifyAck(jws, { receiptId: "rcp_1", now: NOW });
    expect(out.payload.rcp).toBe("rcp_1");
    expect(out.agentKid).toBe(agent.kid);
  });

  it("refuses one for a different receipt", async () => {
    const { jws } = await ack("rcp_1", Math.floor(NOW / 1000));
    await expect(verifyAck(jws, { receiptId: "rcp_2", now: NOW })).rejects.toThrow(/different receipt/);
  });

  it("refuses a stale one, and one dated in the future", async () => {
    const old = await ack("rcp_1", Math.floor(NOW / 1000) - 7200);
    await expect(verifyAck(old.jws, { receiptId: "rcp_1", now: NOW })).rejects.toThrow(/old/);
    const ahead = await ack("rcp_1", Math.floor(NOW / 1000) + 600);
    await expect(verifyAck(ahead.jws, { receiptId: "rcp_1", now: NOW })).rejects.toThrow(/future/);
  });

  it("refuses one with no key in the header", async () => {
    const enc = new TextEncoder();
    const header = b64u(enc.encode(JSON.stringify({ alg: ALG, typ: ACK_TYP })));
    const body = b64u(enc.encode(JSON.stringify({ rcp: "rcp_1", iat: Math.floor(NOW / 1000) })));
    await expect(verifyAck(`${header}.${body}.AA`, { receiptId: "rcp_1", now: NOW })).rejects.toThrow(/public jwk/);
  });
});

describe("the subject", () => {
  it("is stable on one instance and different on another", async () => {
    const a = await requireSecretBox(createSecretBox(["instance-a-secret"])).mac("receipt-subject");
    const b = await requireSecretBox(createSecretBox(["instance-b-secret"])).mac("receipt-subject");
    const a1 = await subjectHash(a, "rita@example.com");
    const a2 = await subjectHash(a, "rita@example.com");
    const b1 = await subjectHash(b, "rita@example.com");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
    // And it never contains the address it was made from.
    expect(a1).not.toContain("rita");
    expect(a1.length).toBe(43);
  });

  it("separates two customers, and the pepper never leaves the box", async () => {
    const box = requireSecretBox(createSecretBox(["one-secret"]));
    const key = await box.mac("receipt-subject");
    expect(await subjectHash(key, "rita@example.com")).not.toBe(await subjectHash(key, "rui@example.com"));
    // A CryptoKey, not bytes: there is nothing here to log or export.
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(["sign"]);
  });
});

describe("the nonce", () => {
  it("is 128 bits of hex and does not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newNonce()));
    expect(seen.size).toBe(200);
    for (const n of seen) expect(n).toMatch(/^[0-9a-f]{32}$/);
  });
});
