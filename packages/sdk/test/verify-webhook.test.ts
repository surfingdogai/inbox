import { describe, expect, it } from "vitest";
import type { ThinInboxEvent } from "../src/index";
import {
  DEFAULT_TOLERANCE_SECONDS,
  isAcceptedStatus,
  isFullEvent,
  isRetryableStatus,
  verifyWebhook,
  WebhookVerificationError,
} from "../src/index";

/**
 * Runs on Node and inside workerd, because a receiver may be either and the verifier is WebCrypto
 * only. The producer here is a hand-written Standard Webhooks signer: `interop.test.ts` proves the
 * verifier also agrees with the signer the Inbox itself ships.
 */

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

const EVENT: ThinInboxEvent = {
  id: "01K5RJ3B4C5D6E7F8G9H0JKMNP",
  type: "booking.create",
  timestamp: "2026-09-21T12:00:00.000Z",
  data: {
    id: "01K5RJ2X9Y8Z7W6V5U4T3S2R1Q",
    type: "booking",
    state: "requested",
    version: 1,
    url: "https://inbox.example.com/v1/owner/items/01K5RJ2X9Y8Z7W6V5U4T3S2R1Q",
  },
};

async function sign(secret: string, id: string, timestampSeconds: number, body: string): Promise<string> {
  const material = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const raw = Uint8Array.from(atob(material), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const content = new TextEncoder().encode(`${id}.${timestampSeconds}.${body}`);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, content as BufferSource));
  return btoa(String.fromCharCode(...mac));
}

interface Delivery {
  body: string;
  headers: Record<string, string>;
}

async function deliver(
  overrides: { secret?: string; nowMs?: number; body?: string; id?: string } = {},
): Promise<Delivery> {
  const body = overrides.body ?? JSON.stringify(EVENT);
  const id = overrides.id ?? EVENT.id;
  const seconds = Math.floor((overrides.nowMs ?? NOW) / 1000);
  const signature = await sign(overrides.secret ?? SECRET, id, seconds, body);
  return {
    body,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(seconds),
      "webhook-signature": `v1,${signature}`,
    },
  };
}

async function expectRefusal(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(WebhookVerificationError);
  await promise.then(
    () => expect.unreachable("verification should have been refused"),
    (error: WebhookVerificationError) => expect(error.code).toBe(code),
  );
}

describe("verifyWebhook", () => {
  it("accepts a good delivery and returns the parsed event", async () => {
    const { body, headers } = await deliver();
    const event = await verifyWebhook<ThinInboxEvent>({ payload: body, headers, secret: SECRET, now: NOW });
    expect(event.id).toBe(EVENT.id);
    expect(event.type).toBe("booking.create");
    expect(event.data.state).toBe("requested");
    expect(isFullEvent(event)).toBe(false);
  });

  it("takes the headers as a Headers, a plain object, a Map or pairs, whatever the framework hands you", async () => {
    const { body, headers } = await deliver();
    const shapes = [
      new Headers(headers),
      headers,
      new Map(Object.entries(headers)),
      Object.entries(headers),
      // Node's req.headers folds a repeated header into an array.
      { ...headers, "webhook-signature": [headers["webhook-signature"] as string] },
      // And a framework that shouts its header names is still talking HTTP.
      Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toUpperCase(), v])),
    ];
    for (const shape of shapes) {
      await expect(verifyWebhook({ payload: body, headers: shape, secret: SECRET, now: NOW })).resolves.toMatchObject({
        id: EVENT.id,
      });
    }
  });

  it("verifies raw bytes as well as a string, because req.arrayBuffer() is the safer read", async () => {
    const { body, headers } = await deliver();
    const bytes = new TextEncoder().encode(body);
    await expect(verifyWebhook({ payload: bytes, headers, secret: SECRET, now: NOW })).resolves.toMatchObject({
      id: EVENT.id,
    });
    await expect(
      verifyWebhook({ payload: bytes.buffer as ArrayBuffer, headers, secret: SECRET, now: NOW }),
    ).resolves.toMatchObject({ id: EVENT.id });
  });

  it("passes when any one of several signatures matches, which is what a rotation looks like", async () => {
    const { body, headers } = await deliver({ secret: "whsec_Y0d5YUNIYXROZXdlclNlY3JldEZvclJvdA==" });
    const old = await sign(SECRET, EVENT.id, Math.floor(NOW / 1000), body);
    const both = `v1,${old} ${headers["webhook-signature"]}`;
    await expect(
      verifyWebhook({ payload: body, headers: { ...headers, "webhook-signature": both }, secret: SECRET, now: NOW }),
    ).resolves.toMatchObject({ id: EVENT.id });
  });

  it("ignores signature versions it does not know, so a future v2 breaks nobody", async () => {
    const { body, headers } = await deliver();
    const mixed = `v2,bm90LWEtdjEtc2lnbmF0dXJl ${headers["webhook-signature"]}`;
    await expect(
      verifyWebhook({ payload: body, headers: { ...headers, "webhook-signature": mixed }, secret: SECRET, now: NOW }),
    ).resolves.toMatchObject({ id: EVENT.id });
  });

  it("refuses a body that was changed by one byte after signing", async () => {
    const { body, headers } = await deliver();
    const tampered = body.replace('"version":1', '"version":2');
    expect(tampered).not.toBe(body);
    await expectRefusal(
      verifyWebhook({ payload: tampered, headers, secret: SECRET, now: NOW }),
      "no_matching_signature",
    );
  });

  it("refuses when the id or the timestamp is replayed with another body's signature", async () => {
    const { body, headers } = await deliver();
    await expectRefusal(
      verifyWebhook({
        payload: body,
        headers: { ...headers, "webhook-id": "01K5RJ0000000000000000000" },
        secret: SECRET,
        now: NOW,
      }),
      "no_matching_signature",
    );
  });

  it("refuses another endpoint's secret", async () => {
    const { body, headers } = await deliver();
    await expectRefusal(
      verifyWebhook({ payload: body, headers, secret: "whsec_c29tZW9uZS1lbHNlcy1zZWNyZXQtaGVyZQ==", now: NOW }),
      "no_matching_signature",
    );
  });

  it("refuses a delivery older than the tolerance, and one from the future", async () => {
    const stale = await deliver({ nowMs: NOW - (DEFAULT_TOLERANCE_SECONDS + 30) * 1000 });
    await expectRefusal(
      verifyWebhook({ payload: stale.body, headers: stale.headers, secret: SECRET, now: NOW }),
      "timestamp_too_old",
    );
    const ahead = await deliver({ nowMs: NOW + (DEFAULT_TOLERANCE_SECONDS + 30) * 1000 });
    await expectRefusal(
      verifyWebhook({ payload: ahead.body, headers: ahead.headers, secret: SECRET, now: NOW }),
      "timestamp_too_new",
    );
  });

  it("honours a tolerance you choose, in both directions", async () => {
    const old = await deliver({ nowMs: NOW - 600_000 });
    await expect(
      verifyWebhook({ payload: old.body, headers: old.headers, secret: SECRET, now: NOW, toleranceSeconds: 900 }),
    ).resolves.toMatchObject({ id: EVENT.id });
    await expectRefusal(
      verifyWebhook({ payload: old.body, headers: old.headers, secret: SECRET, now: NOW, toleranceSeconds: 60 }),
      "timestamp_too_old",
    );
    const soon = await deliver({ nowMs: NOW + 600_000 });
    await expect(
      verifyWebhook({ payload: soon.body, headers: soon.headers, secret: SECRET, now: NOW, toleranceSeconds: 900 }),
    ).resolves.toMatchObject({ id: EVENT.id });
  });

  it("names the header that is missing", async () => {
    const { body, headers } = await deliver();
    for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const without = { ...headers };
      delete without[name];
      await expectRefusal(
        verifyWebhook({ payload: body, headers: without, secret: SECRET, now: NOW }),
        "missing_header",
      );
    }
  });

  it("refuses a timestamp that is not Unix seconds, and a signature header with nothing v1 in it", async () => {
    const { body, headers } = await deliver();
    await expectRefusal(
      verifyWebhook({
        payload: body,
        headers: { ...headers, "webhook-timestamp": "2026-09-21T12:00:00Z" },
        secret: SECRET,
        now: NOW,
      }),
      "bad_timestamp",
    );
    await expectRefusal(
      verifyWebhook({
        payload: body,
        headers: { ...headers, "webhook-signature": "sha256=abc" },
        secret: SECRET,
        now: NOW,
      }),
      "bad_signature_header",
    );
  });

  it("refuses an empty secret, and takes one with or without the whsec_ prefix", async () => {
    const { body, headers } = await deliver();
    await expectRefusal(verifyWebhook({ payload: body, headers, secret: "  ", now: NOW }), "bad_secret");
    await expect(
      verifyWebhook({ payload: body, headers, secret: SECRET.slice("whsec_".length), now: NOW }),
    ).resolves.toMatchObject({ id: EVENT.id });
  });

  it("says so when the signature is good but the body is not JSON", async () => {
    const { body, headers } = await deliver({ body: "not json at all" });
    await expectRefusal(verifyWebhook({ payload: body, headers, secret: SECRET, now: NOW }), "bad_payload");
  });

  it("defaults now to the clock, so a fresh delivery needs no arguments", async () => {
    const { body, headers } = await deliver({ nowMs: Date.now() });
    await expect(verifyWebhook({ payload: body, headers, secret: SECRET })).resolves.toMatchObject({ id: EVENT.id });
  });
});

describe("isFullEvent", () => {
  it("tells the two styles apart by the item the full style carries", async () => {
    const full = {
      ...EVENT,
      data: {
        ...EVENT.data,
        item: { id: EVENT.data.id, type: "booking", state: "requested", version: 1, payload: {} },
        transitions: [{ event: "confirm", label: "Confirm booking" }],
        human: "A booking requested for two people.",
        party: { id: "01K5RJ2PARTY000000000000AA", name: "Sofía", kind: "person", verified: true },
      },
    };
    const { body, headers } = await deliver({ body: JSON.stringify(full) });
    const event = await verifyWebhook({ payload: body, headers, secret: SECRET, now: NOW });
    expect(isFullEvent(event)).toBe(true);
    if (isFullEvent(event)) expect(event.data.party?.name).toBe("Sofía");
  });
});

describe("isRetryableStatus", () => {
  it("treats 2xx as delivered and everything else, redirects included, as a failure", () => {
    for (const ok of [200, 201, 202, 204, 299]) {
      expect(isAcceptedStatus(ok)).toBe(true);
      expect(isRetryableStatus(ok)).toBe(false);
    }
    for (const bad of [301, 302, 307, 308, 400, 401, 404, 410, 429, 500, 503]) {
      expect(isAcceptedStatus(bad)).toBe(false);
      expect(isRetryableStatus(bad)).toBe(true);
    }
  });
});
