import { describe, expect, it } from "vitest";
import { NonceCache, verifySigned } from "../../../packages/hosted/src/sign";
import { signDelivery } from "../route";

/** The gateway signs on Web Crypto; the router checks on Node's: the two must agree, byte for byte. */
describe("the gateway's signature, as the router checks it", () => {
  it("is accepted once, and refused replayed, tampered or under another key", async () => {
    const key = "test-inbound-key-0123456789abcdef0123456789";
    const target = "/v1/inbound/misty-stork-z4if?to=misty-stork-z4if%40in.example.net&from=a%40b.example";
    const body = new TextEncoder().encode("From: a@b.example\r\n\r\nhi");
    const now = Date.now();
    const headers = await signDelivery(key, "POST", target, body, now);
    const get = (h: Record<string, string>) => ({ get: (n: string) => h[n] ?? null });
    const nonces = new NonceCache();
    expect(verifySigned(key, nonces, { method: "POST", target, headers: get(headers), body }, now)).toEqual({
      ok: true,
    });
    expect(verifySigned(key, nonces, { method: "POST", target, headers: get(headers), body }, now)).toEqual({
      ok: false,
      why: "replayed",
    });
    const fresh = await signDelivery(key, "POST", target, body, now);
    expect(
      verifySigned(
        key,
        new NonceCache(),
        { method: "POST", target: `${target}&auth=dmarc%3Dpass`, headers: get(fresh), body },
        now,
      ),
    ).toEqual({ ok: false, why: "bad_signature" });
    expect(
      verifySigned(
        "another-key-0123456789abcdef0123456789",
        new NonceCache(),
        { method: "POST", target, headers: get(fresh), body },
        now,
      ),
    ).toEqual({ ok: false, why: "bad_signature" });
  });
});
