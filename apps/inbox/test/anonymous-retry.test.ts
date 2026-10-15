import { schema, ulid } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { confirmed, freshDb, futureDay, openWeekdays } from "./harness";

/**
 * What an anonymous caller's fingerprint opens (security review): nothing. A caller without a key is
 * known by a hash of its address and user agent, which many people share (a carrier's NAT, an
 * assistant platform's servers) and a caller can choose. Someone who sends the same address, user
 * agent, idempotency key and body as another person gets neither that person's access token nor
 * their item: a retry is answered only to the item's owner.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const DAY = futureDay();
/** One address and one user agent, as two people behind the same NAT with the same browser send them. */
const SHARED = { "cf-connecting-ip": "198.51.100.23", "user-agent": "Mozilla/5.0 (same browser)" };

async function setup() {
  const db = await freshDb();
  const svc = ulid();
  await db.orm.insert(schema.services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    capacity: 1,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  await openWeekdays(db);
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Oficina Maré",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    createdAt: T0,
    updatedAt: T0,
  });
  return { db, svc, app: createApp({ db }) };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://inbox.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...SHARED, ...headers },
    body: JSON.stringify(body),
  });

type Created = {
  view: { item: { id: string } };
  accessToken?: string;
  accessTokenWithheld?: boolean;
  identity?: { passes: unknown[] };
};

describe("an anonymous caller's fingerprint (security review)", () => {
  it("never hands another person's access token to a retry from the same address and user agent", async () => {
    const { app } = await setup();
    const body = { body: "Do you have a table for two tonight?", contact: { email: "rita@example.com" } };
    const first = await app.request(post("/v1/messages", body, { "idempotency-key": "msg-1" }));
    expect(first.status).toBe(201);
    const created = (await first.json()) as Created;
    expect(created.accessToken).toBeTruthy();

    // Someone else, or the same person: from here they cannot be told apart. The answer is the same
    // item, and no token: it was shown once.
    const again = await app.request(post("/v1/messages", body, { "idempotency-key": "msg-1" }));
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    const replayed = (await again.json()) as Created;
    expect(replayed.view.item.id).toBe(created.view.item.id);
    expect(replayed.accessToken).toBeUndefined();
    // Said, so an assistant that lost the first answer knows the token is gone, not that there was none.
    expect(replayed.accessTokenWithheld).toBe(true);
    expect(created.accessTokenWithheld).toBeUndefined();
    expect(JSON.stringify(replayed)).not.toContain(created.accessToken as string);
    expect(replayed.identity?.passes ?? []).toEqual([]);

    // The fingerprint alone reads nothing; the token does.
    const id = created.view.item.id;
    const bare = await app.request(new Request(`https://inbox.test/v1/items/${id}`, { headers: SHARED }));
    expect(bare.status).toBe(403);
    const owned = await app.request(
      new Request(`https://inbox.test/v1/items/${id}`, {
        headers: { ...SHARED, "x-access-token": created.accessToken as string },
      }),
    );
    expect(owned.status).toBe(200);
  });

  it("answers a retried cancellation only to the item's owner", async () => {
    const { app, svc } = await setup();
    const created = (await (
      await confirmed(
        (r) => app.request(r),
        post("/v1/bookings", {
          payload: {
            reservationFor: { serviceId: svc, name: "Full service" },
            startTime: `${DAY}T08:00:00Z`,
            endTime: `${DAY}T09:30:00Z`,
          },
          contact: { name: "Rita", email: "rita@example.com" },
        }),
      )
    ).json()) as Created;
    const id = created.view.item.id;
    const token = created.accessToken as string;
    const cancel = { reason: "flight delayed" };
    const first = await app.request(
      post(`/v1/items/${id}/cancel`, { ...cancel, access_token: token }, { "idempotency-key": "cancel-1" }),
    );
    expect(first.status).toBe(200);

    // The same request without the token, from the same address and user agent with the same key:
    // refused as any other write on someone else's item, never the stored answer.
    const copy = await app.request(post(`/v1/items/${id}/cancel`, cancel, { "idempotency-key": "cancel-1" }));
    expect(copy.status).toBe(403);
    expect(await copy.text()).not.toContain("rita@example.com");

    // The owner's own retry is still a retry.
    const retry = await app.request(
      post(`/v1/items/${id}/cancel`, { ...cancel, access_token: token }, { "idempotency-key": "cancel-1" }),
    );
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { replayed: boolean }).replayed).toBe(true);
  });
});
