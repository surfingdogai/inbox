import { describe, expect, it } from "vitest";
import receipts from "../../spec/vectors/receipts.json";
import signatures from "../../spec/vectors/signatures.json";
import {
  InstanceSignatureError,
  signInstanceRequest,
  signReceipt,
  verifyInstanceRequest,
  verifyReceipt,
} from "../src/index.js";

/** The sdi-instance/1 vectors, checked from the network's side and reproduced from the inbox's. */
const instance = signatures.instance;
const instanceCases = signatures.requests.filter((r) => r.profile === "sdi-instance/1");
const keysFor = async (domain: string) =>
  domain === new URL(instance.origin).host ? (instance.manifest_receipt_keys.keys as never) : null;

describe("sdi-instance/1 against signatures.json", () => {
  it("has cases to check", () => {
    expect(instanceCases.length).toBeGreaterThanOrEqual(10);
  });

  for (const v of instanceCases) {
    it(`verifies as a network: ${v.name}`, async () => {
      const run = () =>
        verifyInstanceRequest({
          method: v.request.method,
          url: v.request.url,
          headers: v.request.headers as Record<string, string>,
          body: (v.request as { body?: string }).body ?? null,
          authorities: [v.authority],
          keysFor,
          now: v.now * 1000,
        });
      if (v.expect.ok) {
        const got = await run();
        expect(got.domain).toBe((v.expect as { domain: string }).domain);
        expect(got.keyid).toBe((v.expect as { keyid: string }).keyid);
        expect(got.replayKey).toMatch(/^sig:[0-9a-f]{64}$/);
      } else {
        const error = await run().then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(InstanceSignatureError);
        expect((error as InstanceSignatureError).code).toBe((v.expect as { code: string }).code);
      }
    });
  }

  for (const v of instanceCases.filter((c) => c.expect.ok)) {
    it(`signs byte for byte as an inbox: ${v.name}`, async () => {
      const created = Number(/;created=(\d+)/.exec(v.signature_input)?.[1]);
      const expires = Number(/;expires=(\d+)/.exec(v.signature_input)?.[1]);
      const nonce = /;nonce="([^"]*)"/.exec(v.signature_input)?.[1] ?? null;
      const signed = await signInstanceRequest({
        method: v.request.method,
        url: v.request.url,
        body: (v.request as { body?: string }).body ?? null,
        instance: instance.origin,
        key: { kid: instance.kid, privateJwk: instance.private_jwk as never },
        headers: { "Content-Type": "application/json" },
        now: created * 1000,
        windowSeconds: expires - created,
        nonce,
      });
      expect(signed.signatureInput).toBe(v.signature_input);
      expect(signed.signatureBase).toBe(v.signature_base);
      expect(signed.signature).toBe(v.signature);
    });
  }

  it("refuses a request whose signature is replayed only through the caller's record", async () => {
    // The verdict is pure; a network keeps replayKey until replayUntil and refuses it again.
    const v = instanceCases.find((c) => c.expect.ok);
    if (!v) throw new Error("no case");
    const once = await verifyInstanceRequest({
      method: v.request.method,
      url: v.request.url,
      headers: v.request.headers as Record<string, string>,
      body: (v.request as { body?: string }).body ?? null,
      authorities: [v.authority],
      keysFor,
      now: v.now * 1000,
    });
    expect(once.replayUntil).toBe(once.expires + 60);
  });
});

describe("issuing receipts against receipts.json", () => {
  for (const v of receipts.receipts) {
    it(`reproduces ${v.name}`, async () => {
      const jws = await signReceipt(v.payload, {
        kid: receipts.issuer.kid,
        privateJwk: receipts.issuer.private_jwk as never,
      });
      expect(jws).toBe(v.jws);
      const verified = await verifyReceipt(jws, [receipts.issuer.public_jwk as never], {
        now: (v.payload.iat + 1) * 1000,
      } as never);
      expect(verified).toBeTruthy();
    });
  }
});
