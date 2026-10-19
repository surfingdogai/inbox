import { describe, expect, it } from "vitest";
import vectors from "../../spec/vectors/push.json";
import {
  b64uDecode,
  b64uEncode,
  cleanDeviceKey,
  decryptPush,
  encryptPush,
  jwkThumbprint,
  MAX_PUSH_PLAINTEXT,
  pkceS256,
  pointToJwk,
  proofStatement,
  signProof,
  verifyProof,
} from "../src/phones/crypto";

/**
 * The phone's cryptography (ADR-026): Web Push message encryption (RFC 8291) held to the RFC's own
 * worked example, shared with the phone's native decrypter through `packages/spec/vectors/push.json`,
 * and the device-key proofs a phone signs.
 */
const v = vectors.rfc8291;

async function phoneKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicPoint = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { privateKey: pair.privateKey, publicPoint, auth, p256dh: b64uEncode(publicPoint), authB64: b64uEncode(auth) };
}

describe("push encryption (RFC 8291)", () => {
  it("gives exactly the RFC's message for the RFC's keys, salt and plaintext", async () => {
    const senderPublic = b64uDecode(v.as_public);
    const message = await encryptPush({ p256dh: v.ua_public, auth: v.auth_secret }, b64uDecode(v.plaintext), {
      salt: b64uDecode(v.salt),
      senderPrivate: { ...pointToJwk(senderPublic), d: v.as_private },
    });
    expect(b64uEncode(message.slice(0, 86))).toBe(v.header);
    expect(b64uEncode(message)).toBe(v.message);
  });

  it("decrypts the RFC's message with the phone's private key", async () => {
    const uaPublic = b64uDecode(v.ua_public);
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      { ...pointToJwk(uaPublic), d: v.ua_private, ext: true },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const plain = await decryptPush(b64uDecode(v.message), {
      privateKey,
      publicPoint: uaPublic,
      auth: b64uDecode(v.auth_secret),
    });
    expect(new TextDecoder().decode(plain)).toBe("When I grow up, I want to be a watermelon");
  });

  it("round-trips with fresh keys, never twice the same bytes, and refuses another phone's key", async () => {
    const phone = await phoneKeys();
    const other = await phoneKeys();
    const text = new TextEncoder().encode(JSON.stringify({ v: 1, title: "New booking request" }));
    const a = await encryptPush({ p256dh: phone.p256dh, auth: phone.authB64 }, text);
    const b = await encryptPush({ p256dh: phone.p256dh, auth: phone.authB64 }, text);
    expect(b64uEncode(a)).not.toBe(b64uEncode(b));
    // Nothing of the plaintext shows through.
    expect(new TextDecoder("latin1").decode(a)).not.toContain("booking");
    expect(new TextDecoder().decode(await decryptPush(a, phone))).toContain("New booking request");
    await expect(decryptPush(a, other)).rejects.toThrow();
    // The right key with the wrong authentication secret fails too.
    await expect(decryptPush(a, { ...phone, auth: crypto.getRandomValues(new Uint8Array(16)) })).rejects.toThrow();
  });

  it("refuses a payload too large for one push, and keys that are not keys", async () => {
    const phone = await phoneKeys();
    await expect(
      encryptPush({ p256dh: phone.p256dh, auth: phone.authB64 }, new Uint8Array(MAX_PUSH_PLAINTEXT + 1)),
    ).rejects.toThrow(/over/);
    await expect(encryptPush({ p256dh: "AAAA", auth: phone.authB64 }, new Uint8Array(4))).rejects.toThrow();
    await expect(encryptPush({ p256dh: phone.p256dh, auth: "AAAA" }, new Uint8Array(4))).rejects.toThrow();
  });
});

describe("device-key proofs", () => {
  it("verifies a proof for the statement it signed, and nothing else", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = cleanDeviceKey(await crypto.subtle.exportKey("jwk", pair.publicKey));
    expect(jwk).not.toBeNull();
    if (!jwk) return;
    const at = Date.parse("2026-10-19T10:00:00Z");
    const statement = proofStatement("pair", "https://inbox.example.com", "abc", at);
    const proof = await signProof(pair.privateKey, statement);
    expect(await verifyProof(jwk, statement, proof)).toBe(true);
    // Another inbox, another purpose, another time: no.
    expect(await verifyProof(jwk, proofStatement("pair", "https://inbox.evil.example", "abc", at), proof)).toBe(false);
    expect(await verifyProof(jwk, proofStatement("refresh", "https://inbox.example.com", "abc", at), proof)).toBe(
      false,
    );
    expect(await verifyProof(jwk, proofStatement("pair", "https://inbox.example.com", "abc", at + 1), proof)).toBe(
      false,
    );
    expect(await verifyProof(jwk, statement, "not-a-signature")).toBe(false);
  });

  it("keeps only the public half of a device key, and names it by its RFC 7638 thumbprint", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ])) as CryptoKeyPair;
    const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
    expect(cleanDeviceKey(priv)).toBeNull();
    expect(cleanDeviceKey({ kty: "RSA", n: "x", e: "AQAB" })).toBeNull();
    expect(cleanDeviceKey({ kty: "EC", crv: "P-256", x: "AA", y: "AA" })).toBeNull();
    const pub = cleanDeviceKey(await crypto.subtle.exportKey("jwk", pair.publicKey));
    expect(pub && Object.keys(pub).sort()).toEqual(["crv", "kty", "x", "y"]);
    // RFC 7638 §3.1's example key and thumbprint.
    expect(
      await jwkThumbprint({
        kty: "EC",
        crv: "P-256",
        x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
        y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
      }),
    ).toBe(vectors.thumbprint.expected);
  });

  it("computes PKCE S256 as RFC 7636 Appendix B does", async () => {
    expect(await pkceS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});
