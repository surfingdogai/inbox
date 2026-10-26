import { ConnectorError, gallery } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { builtInConnectors, hmacSha256Base64, verifyBase64Hmac, verifyHexHmac } from "../src/index";
import { fakePlatform, json } from "./fakes/platform";

/**
 * What every connector track leans on in this package (ADR-030): the webhook signature helpers, the
 * fake platform tests run against (the inbox's own connector client over it, every production check
 * on), and the host's options for the connectors it offers.
 */

// The HMAC-SHA-256 example every implementation is checked against.
const KEY = "key";
const MESSAGE = "The quick brown fox jumps over the lazy dog";
const HEX = "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8";
const BASE64 = "97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=";

describe("webhook signatures", () => {
  it("are HMAC-SHA-256 over the exact bytes, as base64 or hex", async () => {
    expect(await hmacSha256Base64(KEY, MESSAGE)).toBe(BASE64);
    expect(await verifyBase64Hmac(KEY, MESSAGE, BASE64)).toBe(true);
    expect(await verifyHexHmac(KEY, MESSAGE, HEX.toUpperCase())).toBe(true);
  });

  it("refuse one byte off, another body, another key, and none at all", async () => {
    expect(await verifyBase64Hmac(KEY, MESSAGE, `${BASE64.slice(0, -2)}h=`)).toBe(false);
    expect(await verifyBase64Hmac(KEY, `${MESSAGE}.`, BASE64)).toBe(false);
    expect(await verifyBase64Hmac("other", MESSAGE, BASE64)).toBe(false);
    expect(await verifyBase64Hmac(KEY, MESSAGE, null)).toBe(false);
    expect(await verifyBase64Hmac(KEY, MESSAGE, "")).toBe(false);
    expect(await verifyBase64Hmac("", MESSAGE, BASE64)).toBe(false);
  });
});

describe("the fake platform", () => {
  it("answers by method and address, captures what it was sent, and fails as platforms do", async () => {
    const p = fakePlatform()
      .on("GET", "https://api.tienda.example.com/v1/orders/:id", (req) => json({ id: req.params.id }))
      .on("POST", "https://api.tienda.example.com/v1/orders", () => json({ id: "ord_1" }, 201));
    const ok = await p.http.request({
      method: "POST",
      url: "https://api.tienda.example.com/v1/orders",
      headers: { authorization: "Bearer sk_mx_1", "idempotency-key": "ref_1" },
      body: JSON.stringify({ total: { value: 34_900, currency: "MXN" } }),
    });
    expect(ok.status).toBe(201);
    expect(p.seen[0]?.headers.get("idempotency-key")).toBe("ref_1");
    expect(JSON.parse(p.seen[0]?.body ?? "{}")).toEqual({ total: { value: 34_900, currency: "MXN" } });
    const one = await p.http.request({ method: "GET", url: "https://api.tienda.example.com/v1/orders/ord_9" });
    expect(JSON.parse(one.text)).toEqual({ id: "ord_9" });

    p.fail("GET", "https://api.tienda.example.com/v1/orders/:id", 429);
    const limited = await p.http.request({ method: "GET", url: "https://api.tienda.example.com/v1/orders/ord_9" });
    expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "7"]);
    p.fail("GET", "https://api.tienda.example.com/v1/orders/:id", 503);
    expect(
      (await p.http.request({ method: "GET", url: "https://api.tienda.example.com/v1/orders/ord_9" })).status,
    ).toBe(503);
    p.fail("GET", "https://api.tienda.example.com/v1/orders/:id", "timeout");
    await expect(
      p.http.request({ method: "GET", url: "https://api.tienda.example.com/v1/orders/ord_9" }),
    ).rejects.toMatchObject({ code: "unreachable" });
    // Each failure was once: the route answers again.
    expect(
      (await p.http.request({ method: "GET", url: "https://api.tienda.example.com/v1/orders/ord_9" })).status,
    ).toBe(200);
  });

  it("goes through the inbox's own client: no plain http, no private host, no redirect to one", async () => {
    const p = fakePlatform().on("GET", "https://shop.tienda.example.com/start", () => json({}));
    for (const url of [
      "http://shop.tienda.example.com/start",
      "https://10.1.2.3/start",
      "https://printer.local/start",
    ]) {
      await expect(p.http.request({ method: "GET", url })).rejects.toBeInstanceOf(ConnectorError);
    }
    p.fail("GET", "https://shop.tienda.example.com/start", { redirect: "https://169.254.169.254/latest/meta-data" });
    await expect(
      p.http.request({ method: "GET", url: "https://shop.tienda.example.com/start", followRedirects: true }),
    ).rejects.toMatchObject({ code: "config" });
    // Nothing was ever asked of the private addresses.
    expect(p.seen.map((r) => r.url.hostname)).toEqual(["shop.tienda.example.com"]);
  });
});

describe("the connectors a host offers", () => {
  it("keeps Google soon while its client is in Google's Testing mode, on a hosted inbox or one's own", () => {
    const google = { clientId: "id.apps.googleusercontent.com", clientSecret: "secret" };
    const way = (opts: Parameters<typeof builtInConnectors>[0]) =>
      gallery(new Map(builtInConnectors(opts).map((d) => [d.kind, d])))
        .find((c) => c.id === "calendar")
        ?.ways.find((w) => w.kind === "google_calendar");
    expect(way({ oauth: { google } })?.status).toBe("ready");
    expect(way({ oauth: { google }, hosted: true, googleTesting: true })?.status).toBe("soon");
    expect(way({ oauth: { google }, googleTesting: true })?.status).toBe("soon");
    expect(way({})?.status).toBe("setup");
    // Outlook is the calendar's published link, ready everywhere.
    const outlook = gallery(new Map(builtInConnectors({}).map((d) => [d.kind, d])))
      .find((c) => c.id === "calendar")
      ?.ways.find((w) => w.preset === "outlook");
    expect(outlook).toMatchObject({
      status: "ready",
      auth: "form",
      note: "Busy times only: bookings are not added to Outlook.",
    });
    expect(outlook?.form[0]?.steps?.length).toBe(3);
  });
});
