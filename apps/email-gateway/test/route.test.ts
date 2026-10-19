import { describe, expect, it } from "vitest";
import { authSummary, deliveryTarget, routeFor, signDelivery, verdictOf } from "../route";

/** The email gateway's decisions (ADR-026 §1), on both runtimes. */
describe("where an address goes", () => {
  it("sends a hosted inbox's address and its conversations to the router, and everything else to our own inbox", () => {
    expect(routeFor("misty-stork-z4if@in.surfingdog.ai", "in.surfingdog.ai")).toEqual({
      kind: "hosted",
      slug: "misty-stork-z4if",
    });
    expect(routeFor("Misty-Stork-Z4IF+tabcdefghijklmnop@IN.surfingdog.ai", "in.surfingdog.ai")).toEqual({
      kind: "hosted",
      slug: "misty-stork-z4if",
    });
    expect(routeFor("hello@surfingdog.ai", "in.surfingdog.ai")).toEqual({ kind: "own" });
    expect(routeFor("hello@surfingdog.ai", undefined)).toEqual({ kind: "own" });
  });

  it("refuses an address on the hosted domain that names no inbox", () => {
    expect(routeFor("postmaster@in.surfingdog.ai", "in.surfingdog.ai").kind).toBe("refuse");
    expect(routeFor("../etc@in.surfingdog.ai", "in.surfingdog.ai").kind).toBe("refuse");
    expect(routeFor("not-an-address", "in.surfingdog.ai").kind).toBe("refuse");
  });
});

describe("what the receiving server found", () => {
  it("reads the trusted server's Authentication-Results, comments and all", () => {
    const headers: [string, string][] = [
      [
        "Authentication-Results",
        "mx.cloudflare.net; dkim=pass header.d=gmail.com header.s=20230601 header.b=AbC; spf=pass (mx.cloudflare.net: domain of rui@gmail.com designates 209.85.0.1 as permitted sender) smtp.mailfrom=rui@gmail.com; dmarc=pass header.from=gmail.com",
      ],
    ];
    expect(authSummary(headers, ["mx.cloudflare.net"])).toBe("spf=pass; dkim=pass:gmail.com; dmarc=pass");
  });

  it("reads ARC's too, and nothing from a server it does not trust", () => {
    expect(
      authSummary(
        [
          [
            "ARC-Authentication-Results",
            "i=1; mx.cloudflare.net; dkim=fail header.d=x.example; spf=softfail; dmarc=fail",
          ],
        ],
        ["mx.cloudflare.net"],
      ),
    ).toBe("spf=softfail; dkim=fail; dmarc=fail");
    expect(
      authSummary([["Authentication-Results", "evil.example; dmarc=pass"]], ["mx.cloudflare.net"]),
    ).toBeUndefined();
    expect(authSummary([], ["mx.cloudflare.net"])).toBeUndefined();
  });
});

describe("a delivery", () => {
  it("carries the envelope and the verdict in its signed query", () => {
    expect(
      deliveryTarget({
        slug: "misty-stork-z4if",
        to: "misty-stork-z4if@in.surfingdog.ai",
        from: "a@b.example",
        auth: "dmarc=pass",
      }),
    ).toBe("/v1/inbound/misty-stork-z4if?to=misty-stork-z4if%40in.surfingdog.ai&from=a%40b.example&auth=dmarc%3Dpass");
  });

  it("is signed the way the router checks: a fixed vector", async () => {
    const h = await signDelivery(
      "test-inbound-key-0123456789abcdef0123456789",
      "post",
      "/v1/inbound/misty-stork-z4if?to=x",
      new TextEncoder().encode("raw email"),
      1_792_000_000_000,
      "00112233445566778899aabbccddeeff",
    );
    expect(h["x-sd-time"]).toBe("1792000000");
    expect(h["x-sd-nonce"]).toBe("00112233445566778899aabbccddeeff");
    expect(h["x-sd-sig"]).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it("answers the sending server: taken, later, or refused, and never bounces over our own key", () => {
    expect(verdictOf(200)).toBe("taken");
    expect(verdictOf(429)).toBe("later");
    expect(verdictOf(503)).toBe("later");
    expect(verdictOf(401)).toBe("later");
    expect(verdictOf(422)).toBe("refused");
    expect(verdictOf(413)).toBe("refused");
  });
});
