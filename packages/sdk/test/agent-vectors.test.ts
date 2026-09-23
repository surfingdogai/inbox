import { describe, expect, it } from "vitest";
import passes from "../../spec/vectors/passes.json";
import receiptsV1 from "../../spec/vectors/receipts.json";
import receiptsV2 from "../../spec/vectors/receipts-v2.json";
import signatures from "../../spec/vectors/signatures.json";
import { signUnchecked } from "../src/agent/sign";
import {
  parseCredential,
  passRefOf,
  ReceiptVerificationError,
  receiptSha,
  SigningError,
  sdiPassHeader,
  signAck,
  signRequest,
  thumbprint,
  verifyReceipt,
} from "../src/index";

/**
 * The agent half of the SDK against the protocol's published vectors (packages/spec/vectors, MIT),
 * which the inbox's own code and the network's Go code are held to as well: every signed agent
 * request is reproduced byte for byte, every string a person holds parses the same way, every
 * receipt verifies (or is refused with the code a network gives), and every acknowledgement is
 * re-signed to the same JWS. Node and workerd.
 */

type Vector = (typeof signatures.requests)[number];

/** What an agent would have passed to produce a vector: its key, its passes, its platform, its clock. */
function inputOf(v: Vector) {
  const h = v.request.headers as Record<string, string>;
  const params = v.signature_input;
  const created = Number(/;created=(\d+)/.exec(params)?.[1]);
  const expires = Number(/;expires=(\d+)/.exec(params)?.[1]);
  const nonce = /;nonce="([^"]*)"/.exec(params)?.[1] ?? null;
  const platform = h["Signature-Agent"];
  const passList = h["Sdi-Pass"] ? [...h["Sdi-Pass"].matchAll(/"([^"]+)"/g)].map((m) => m[1] as string) : undefined;
  const extra: Record<string, string> = {};
  if (h.Authorization) extra.Authorization = h.Authorization;
  return {
    method: v.request.method,
    url: v.request.url,
    body: v.request.body || null,
    headers: extra,
    key: { privateJwk: (platform ? signatures.platform : signatures.agent).private_jwk as never },
    ...(passList ? { passes: passList } : {}),
    ...(platform ? { platform: signatures.directory.origin, legacySignatureAgent: platform.startsWith('"') } : {}),
    now: created * 1000,
    windowSeconds: expires - created,
    nonce,
  };
}

describe("signing requests (sdi-agent/1) against signatures.json", () => {
  const valid = signatures.requests.filter((v) => v.profile === "sdi-agent/1" && v.expect.ok);

  it("covers every valid agent request: self-held keys and Web Bot Auth, both forms", () => {
    expect(valid.map((v) => v.name)).toEqual([
      "sdi-agent/1, self-held key: POST a booking to an inbox with a pass reference",
      "sdi-agent/1, self-held key: GET with a query and Sdi-Pass, no body",
      "sdi-agent/1, self-held key: POST /v1/delegations to the network (with the person's session)",
      "sdi-agent/1, web-bot-auth: Signature-Agent as a dictionary member",
      "sdi-agent/1, web-bot-auth: Signature-Agent in the legacy string form",
    ]);
  });

  for (const v of valid) {
    it(`reproduces byte for byte: ${v.name}`, async () => {
      const signed = await signUnchecked(inputOf(v));
      expect(signed.signatureInput).toBe(v.signature_input);
      expect(signed.signatureBase).toBe(v.signature_base);
      expect(signed.signature).toBe(v.signature);
      expect(signed.keyid).toBe(v.expect.keyid);
      const sent = v.request.headers as Record<string, string>;
      for (const name of [
        "Sdi-Agent-Key",
        "Signature-Agent",
        "Sdi-Pass",
        "Content-Digest",
        "Signature-Input",
        "Signature",
      ]) {
        expect(signed.headers[name], name).toBe(sent[name]);
      }
    });
  }

  it("signs the same through signRequest, except a URL that carries the item's access token", async () => {
    for (const v of valid) {
      const input = inputOf(v);
      if (new URL(input.url).searchParams.has("access_token")) {
        await expect(signRequest(input)).rejects.toMatchObject({ code: "secret_in_url" });
        // In X-Access-Token instead, the token never enters the signature, nor anything forwarded.
        const url = new URL(input.url);
        url.searchParams.delete("access_token");
        const moved = await signRequest({ ...input, url: url.href, headers: { "X-Access-Token": "at_example" } });
        expect(moved.signatureBase).not.toContain("at_example");
        continue;
      }
      expect((await signRequest(input)).signature).toBe(v.signature);
    }
  });

  it("refuses to sign a secret into Sdi-Pass, where every network the inbox forwards it to would read it", async () => {
    const input = inputOf(valid[0] as Vector);
    await expect(signRequest({ ...input, passes: [signatures.pass] })).rejects.toBeInstanceOf(SigningError);
    await expect(signRequest({ ...input, passes: [signatures.pass] })).rejects.toMatchObject({
      code: "secret_in_signed_pass",
    });
    // The reference is what a signing agent carries.
    expect(passRefOf(signatures.pass)).toBe(signatures.pass_ref);
    expect(sdiPassHeader([signatures.pass_ref])).toBe(`"${signatures.pass_ref}"`);
  });

  it("names its key by the RFC 7638 thumbprint the vectors give", async () => {
    expect(await thumbprint(signatures.agent.public_jwk)).toBe(signatures.agent.kid);
    expect(await thumbprint(signatures.platform.public_jwk)).toBe(signatures.platform.kid);
  });
});

describe("the strings a person holds, against passes.json", () => {
  for (const c of passes.parse) {
    it(`parses ${JSON.stringify(c.input).slice(0, 60)} as ${c.kind ?? "nothing"}`, () => {
      const got = parseCredential(c.input);
      if (c.kind === null || c.kind === undefined) {
        expect(got).toBeNull();
        return;
      }
      expect(got).toEqual({
        kind: c.kind,
        host: c.host,
        id: c.id,
        ...("secret" in c && c.secret ? { secret: c.secret } : {}),
      });
    });
  }
});

describe("receipts, against receipts.json and receipts-v2.json", () => {
  const keysV1 = [receiptsV1.issuer.public_jwk];
  const keysV2 = { keys: [receiptsV2.issuer.public_jwk] };

  it("verifies every receipt an inbox signed, v1 and v2, and hashes it as an acknowledgement names it", async () => {
    for (const r of receiptsV1.receipts) {
      const v = await verifyReceipt(r.jws, keysV1, { issuer: "https://inbox.example.com", now: r.payload.iat * 1000 });
      expect(v).toMatchObject({ version: 1, kid: receiptsV1.issuer.kid, claims: r.payload });
    }
    for (const r of receiptsV2.receipts) {
      const v = await verifyReceipt(r.jws, keysV2, { now: receiptsV2.now * 1000 });
      expect(v.version, r.name).toBe(2);
      expect(v.claims).toEqual(r.payload);
      expect(v.sha).toBe(r.sha);
      expect(await receiptSha(r.jws)).toBe(r.sha);
    }
  });

  it("refuses what a network refuses, with the same code", async () => {
    const codeOf = async (jws: string, keys: Parameters<typeof verifyReceipt>[1], now: number) => {
      try {
        await verifyReceipt(jws, keys, { now });
        return "ok";
      } catch (e) {
        expect(e).toBeInstanceOf(ReceiptVerificationError);
        return (e as ReceiptVerificationError).code;
      }
    };
    for (const r of receiptsV1.refused_receipts) {
      expect(await codeOf(r.jws, keysV1, 1_790_000_500_000), r.name).toBe(r.error);
    }
    for (const r of receiptsV2.refused_receipts) {
      expect(await codeOf(r.jws, keysV2, receiptsV2.now * 1000), r.name).toBe(r.code);
    }
    // Another inbox's receipt, however well signed, is not this one's.
    const first = receiptsV2.receipts[0] as (typeof receiptsV2.receipts)[number];
    await expect(
      verifyReceipt(first.jws, keysV2, { issuer: "https://other.example.com", now: receiptsV2.now * 1000 }),
    ).rejects.toMatchObject({ code: "wrong_issuer" });
    // The manifest's receipt_keys, as the inbox publishes them, work as well as a JWKS.
    expect((await verifyReceipt(first.jws, { receipt_keys: keysV2 }, { now: receiptsV2.now * 1000 })).claims.itm).toBe(
      first.payload.itm,
    );
  });

  it("re-signs every acknowledgement to the same JWS", async () => {
    const ack1 = receiptsV1.acknowledgements[0] as (typeof receiptsV1.acknowledgements)[number];
    expect(
      await signAck({
        receipt: ack1.receipt_jws,
        receiptId: ack1.receipt_id,
        key: { privateJwk: receiptsV1.agent.private_jwk as never },
        now: ack1.payload.iat * 1000,
      }),
    ).toBe(ack1.jws);
    const ack2 = receiptsV2.acknowledgements[0] as (typeof receiptsV2.acknowledgements)[number];
    expect(
      await signAck({
        receipt: ack2.receipt_jws,
        receiptId: ack2.payload.rcp,
        key: { privateJwk: receiptsV2.agent.private_jwk as never },
        passRef: ack2.payload.pas,
        now: ack2.payload.iat * 1000,
      }),
    ).toBe(ack2.jws);
    // Never the pass itself.
    await expect(
      signAck({
        receipt: ack2.receipt_jws,
        receiptId: ack2.payload.rcp,
        key: { privateJwk: receiptsV2.agent.private_jwk as never },
        passRef: signatures.pass,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
