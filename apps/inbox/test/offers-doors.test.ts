import { createApiKey } from "@surfingdog/adapters";
import { schema, ulid } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb, confirmed as sentConfirmed } from "./harness";

/**
 * Offers through the REST doors as the app serves them (ADR-018 §6): the owner suggests changes to
 * an order, the customer's assistant reads them, answers with a price of its own (kept for a person,
 * 202), names a replaced offer (409), and accepts the one that stands through its own path; the
 * owner lists every offer. Runs on Node and in workerd.
 */
const BASE = "https://inbox.example.com";

async function setup() {
  const db = await freshDb();
  const now = Date.now();
  const prod = ulid();
  await db.orm.insert(schema.products).values({
    id: prod,
    sku: "CH-9",
    name: "Chain",
    price: { value: 1850, currency: "EUR" },
    active: 1,
    createdAt: now,
    updatedAt: now,
  });
  const inbox = createInbox({
    db,
    mailOut: logMailOut(),
    baseUrl: BASE,
    secretKey: "offers-doors-test-secret-0123456789",
    background: () => {},
  });
  const key = await createApiKey(db, { kind: "owner", name: "t" });
  const owner = { authorization: `Bearer ${key.key}` };
  // A priced request is sent as the customer's assistant sends it once its person confirmed it.
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    sentConfirmed(
      (r) => inbox.app.request(r),
      new Request(`${BASE}${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { db, prod, call, owner };
}

describe("offers through the REST doors", () => {
  it("changes to an order: read, answered with a price (to a person), pinned, and accepted by its path", async () => {
    const s = await setup();
    const business = (await (await s.call("GET", "/v1/business")).json()) as { price_negotiable: boolean };
    expect(business.price_negotiable).toBe(false);
    const created = await s.call("POST", "/v1/orders", {
      payload: {
        orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 3, price: { value: 1850, currency: "EUR" } }],
        totalPrice: { value: 5550, currency: "EUR" },
      },
      contact: { email: "rita@example.com", locale: "en" },
      idempotency_key: "order-1",
    });
    expect(created.status).toBe(201);
    const { view, accessToken } = (await created.json()) as { view: { item: { id: string } }; accessToken: string };
    const id = view.item.id;
    const q = `access_token=${accessToken}`;

    const proposed = await s.call(
      "POST",
      `/v1/owner/items/${id}/offers`,
      {
        input: {
          orderedItem: [{ productId: s.prod, name: "Chain", quantity: 2, price: { value: 1700, currency: "EUR" } }],
          note: "Two left, at a better price.",
        },
        idempotency_key: "offer-1",
      },
      s.owner,
    );
    expect(proposed.status).toBe(200);
    const status = (await (await s.call("GET", `/v1/items/${id}?${q}`)).json()) as {
      offer: { id: string; kind: string; terms_sha: string; warnings: { code: string }[] };
      next: { action: string }[];
    };
    expect(status.offer).toMatchObject({ kind: "order", warnings: [{ code: "price_changed" }] });
    expect(status.next.map((n) => n.action)).toEqual(["accept_offer", "decline_offer", "make_offer"]);

    // A price of their own goes to a person: 202, and what we proposed still stands.
    const priced = await s.call("POST", `/v1/items/${id}/offers?${q}`, {
      terms: { total_price: { value: 3000, currency: "EUR" } },
      idempotency_key: "counter-1",
    });
    expect(priced.status).toBe(202);
    expect(await priced.json()).toMatchObject({
      waiting_on: "us",
      appended: true,
      view: { item: { state: "proposed" } },
    });

    // An offer named that is not the one standing does nothing.
    const stale = await s.call("POST", `/v1/items/${id}/offers/not-this-one/accept?${q}`, {
      terms_sha: status.offer.terms_sha,
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("offer_changed");

    const unconfirmed = await s.call("POST", `/v1/items/${id}/offers/${status.offer.id}/accept?${q}`, {});
    expect(unconfirmed.status).toBe(409);
    expect(((await unconfirmed.json()) as { code: string }).code).toBe("confirm_terms");
    const accepted = await s.call("POST", `/v1/items/${id}/offers/${status.offer.id}/accept?${q}`, {
      terms_sha: status.offer.terms_sha,
      idempotency_key: "accept-1",
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      view: { item: { state: "accepted", payload: { totalPrice: { value: 3400, currency: "EUR" } } } },
    });

    const list = (await (await s.call("GET", `/v1/owner/items/${id}/offers`, undefined, s.owner)).json()) as {
      offers: { by: string; status: string; form: string }[];
    };
    expect(list.offers.map((o) => [o.by, o.form, o.status])).toEqual([
      ["customer", "order", "countered"],
      ["business", "order", "accepted"],
    ]);
  });
});
