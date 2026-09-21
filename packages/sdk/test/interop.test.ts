import { describe, expect, it } from "vitest";
import { RETRY_SCHEDULE_MS } from "../../adapters/src/webhooks/deliver";
import {
  DEFAULT_TOLERANCE_SEC,
  newWebhookSecret,
  signedHeaders,
  verifyWebhook as verifyWithSigner,
} from "../../adapters/src/webhooks/sign";
// The producer, imported from the Inbox itself. The shipped SDK never imports it: @surfingdog/sdk
// is MIT so that verifying an event costs no one an AGPL dependency, and the point of this file is
// that the two implementations are PROVEN to agree rather than assumed to.
import { TEST_EVENT_TYPE as SIGNER_TEST_EVENT_TYPE } from "../../core/src/capabilities/webhooks";
import type { ThinInboxEvent } from "../src/index";
import {
  DEFAULT_TOLERANCE_SECONDS,
  RETRY_SCHEDULE_SECONDS,
  TEST_EVENT_TYPE,
  verifyWebhook,
  WebhookVerificationError,
} from "../src/index";

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const SECONDS = Math.floor(NOW / 1000);

const EVENT: ThinInboxEvent = {
  id: "01K5RJ3B4C5D6E7F8G9H0JKMNP",
  type: "order.record_payment",
  timestamp: "2026-09-21T12:00:00.000Z",
  data: {
    id: "01K5RJ2X9Y8Z7W6V5U4T3S2R1R",
    type: "order",
    state: "paid",
    version: 4,
    url: "https://inbox.example.com/v1/owner/items/01K5RJ2X9Y8Z7W6V5U4T3S2R1R",
  },
};

describe("the SDK verifier and the Inbox signer", () => {
  it("agree on a delivery, freshly generated secret and all", async () => {
    const secret = newWebhookSecret();
    expect(secret.startsWith("whsec_")).toBe(true);
    const body = JSON.stringify(EVENT);
    const headers = await signedHeaders(secret, { id: EVENT.id, timestamp: SECONDS, body });
    const event = await verifyWebhook<ThinInboxEvent>({ payload: body, headers, secret, now: NOW });
    expect(event).toEqual(EVENT);
  });

  it("agree on a body with unicode, emoji and the awkward characters a customer types", async () => {
    const secret = newWebhookSecret();
    const body = JSON.stringify({
      ...EVENT,
      data: { ...EVENT.data, note: 'Sofía — “mañana”, 15 €, 🐕\n\ttab\\slash"quote' },
    });
    const headers = await signedHeaders(secret, { id: EVENT.id, timestamp: SECONDS, body });
    await expect(verifyWebhook({ payload: body, headers, secret, now: NOW })).resolves.toMatchObject({ id: EVENT.id });
    // And on the bytes, which is how a Worker or an Express raw body arrives.
    const bytes = new TextEncoder().encode(body);
    await expect(verifyWebhook({ payload: bytes, headers, secret, now: NOW })).resolves.toMatchObject({ id: EVENT.id });
  });

  it("agree during a rotation, when two signatures travel and the receiver has only one secret", async () => {
    const older = newWebhookSecret();
    const newer = newWebhookSecret();
    const body = JSON.stringify(EVENT);
    const headers = await signedHeaders([newer, older], { id: EVENT.id, timestamp: SECONDS, body });
    expect(headers["webhook-signature"]?.split(" ")).toHaveLength(2);
    for (const secret of [older, newer]) {
      await expect(verifyWebhook({ payload: body, headers, secret, now: NOW })).resolves.toMatchObject({
        id: EVENT.id,
      });
    }
    await expect(
      verifyWebhook({ payload: body, headers, secret: newWebhookSecret(), now: NOW }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("agree on a secret that is not base64, which both sides read as its own bytes", async () => {
    const secret = "whsec_a passphrase someone typed";
    const body = JSON.stringify(EVENT);
    const headers = await signedHeaders(secret, { id: EVENT.id, timestamp: SECONDS, body });
    await expect(verifyWebhook({ payload: body, headers, secret, now: NOW })).resolves.toMatchObject({ id: EVENT.id });
  });

  it("refuse the same things: the signer rejects what the SDK rejects", async () => {
    const secret = newWebhookSecret();
    const body = JSON.stringify(EVENT);
    const headers = await signedHeaders(secret, { id: EVENT.id, timestamp: SECONDS, body });
    const signature = headers["webhook-signature"] as string;

    const tampered = body.replace('"version":4', '"version":5');
    expect(
      await verifyWithSigner(secret, { id: EVENT.id, timestamp: SECONDS, body: tampered, signature }, { now: NOW }),
    ).toEqual({ ok: false, reason: "signature" });
    await expect(verifyWebhook({ payload: tampered, headers, secret, now: NOW })).rejects.toMatchObject({
      code: "no_matching_signature",
    });

    const stale = NOW + 3_600_000;
    expect(
      await verifyWithSigner(secret, { id: EVENT.id, timestamp: SECONDS, body, signature }, { now: stale }),
    ).toEqual({ ok: false, reason: "timestamp" });
    await expect(verifyWebhook({ payload: body, headers, secret, now: stale })).rejects.toMatchObject({
      code: "timestamp_too_old",
    });
  });

  it("and the signer accepts what the SDK accepts, so the agreement runs both ways", async () => {
    const secret = newWebhookSecret();
    const body = JSON.stringify(EVENT);
    const headers = await signedHeaders(secret, { id: EVENT.id, timestamp: SECONDS, body });
    expect(
      await verifyWithSigner(
        secret,
        { id: EVENT.id, timestamp: SECONDS, body, signature: headers["webhook-signature"] as string },
        { now: NOW },
      ),
    ).toEqual({ ok: true });
  });
});

/**
 * The SDK cannot import the Inbox — it is MIT and published on its own — so these three facts are
 * written down twice. A receiver that believes the wrong schedule tells its owner the wrong thing
 * about why nothing arrived, and a tolerance that is tighter on one side than the other rejects
 * deliveries the sender thinks are fine. So they are checked against each other here, where the
 * test may reach across the boundary the package may not.
 */
describe("what the SDK has to repeat about the sender", () => {
  it("has the same retry schedule, in seconds", () => {
    expect(RETRY_SCHEDULE_SECONDS).toEqual(RETRY_SCHEDULE_MS.map((ms) => ms / 1000));
  });

  it("has the same replay window", () => {
    expect(DEFAULT_TOLERANCE_SECONDS).toBe(DEFAULT_TOLERANCE_SEC);
  });

  it("calls the test event by the name the sender sends", () => {
    expect(TEST_EVENT_TYPE).toBe(SIGNER_TEST_EVENT_TYPE);
  });
});
