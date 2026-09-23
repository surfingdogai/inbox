import { createApiKey } from "@surfingdog/adapters";
import { schema, ulid } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { freshDb } from "./harness";

const T0 = Date.parse("2026-09-21T10:00:00Z");

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
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Oficina Maré",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    createdAt: T0,
    updatedAt: T0,
  });
  const owner = await createApiKey(db, { kind: "owner", name: "test" });
  return { db, svc, app: createApp({ db }), ownerKey: owner.key };
}

const jsonPost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://inbox.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("REST door", () => {
  it("books through the public API with idempotency, then the owner confirms", async () => {
    const { app, svc, ownerKey } = await setup();
    const body = {
      payload: {
        reservationFor: { serviceId: svc, name: "Full service" },
        startTime: "2026-09-22T08:00:00Z",
        endTime: "2026-09-22T09:30:00Z",
      },
      contact: { name: "Rita", email: "rita@example.com" },
    };
    const first = await app.request(jsonPost("/v1/bookings", body, { "idempotency-key": "k-1" }));
    expect(first.status).toBe(201);
    const created = (await first.json()) as { view: { item: { id: string; state: string } }; accessToken: string };
    expect(created.view.item.state).toBe("requested");
    expect(created.accessToken).toBeTruthy();

    const again = await app.request(jsonPost("/v1/bookings", body, { "idempotency-key": "k-1" }));
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(((await again.json()) as { view: { item: { id: string } } }).view.item.id).toBe(created.view.item.id);

    const status = await app.request(
      `https://inbox.test/v1/items/${created.view.item.id}?access_token=${created.accessToken}`,
    );
    expect(status.status).toBe(200);
    const denied = await app.request(`https://inbox.test/v1/items/${created.view.item.id}`);
    expect(denied.status).toBe(403);
    expect(denied.headers.get("content-type")).toContain("application/problem+json");

    const noKey = await app.request(
      jsonPost(`/v1/owner/items/${created.view.item.id}/transitions`, { event: "confirm" }),
    );
    expect(noKey.status).toBe(401);
    const confirmed = await app.request(
      jsonPost(
        `/v1/owner/items/${created.view.item.id}/transitions`,
        { event: "confirm" },
        { authorization: `Bearer ${ownerKey}` },
      ),
    );
    expect(confirmed.status).toBe(200);
    expect(
      ((await confirmed.json()) as { view: { item: { state: string; version: number } } }).view.item,
    ).toMatchObject({ state: "confirmed", version: 2 });

    const list = await app.request("https://inbox.test/v1/owner/items?type=booking&open_only=true", {
      headers: { authorization: `Bearer ${ownerKey}` },
    });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("cancels late through the customer's door, and gives the owner the new transitions", async () => {
    const { app, svc, ownerKey } = await setup();
    const owner = { authorization: `Bearer ${ownerKey}` };
    // Two hours from now: inside the default 24-hour window, so a cancellation now is late.
    const start = Math.ceil((Date.now() + 2 * 3_600_000) / 1_800_000) * 1_800_000;
    const created = (await (
      await app.request(
        jsonPost("/v1/bookings", {
          payload: {
            reservationFor: { serviceId: svc, name: "Full service" },
            startTime: new Date(start).toISOString(),
            endTime: new Date(start + 90 * 60_000).toISOString(),
          },
          contact: { name: "Rita", email: "rita@example.com" },
        }),
      )
    ).json()) as { view: { item: { id: string } }; accessToken: string };
    const id = created.view.item.id;
    expect((await app.request(jsonPost(`/v1/owner/items/${id}/transitions`, { event: "confirm" }, owner))).status).toBe(
      200,
    );
    const cancelled = await app.request(
      jsonPost(`/v1/items/${id}/cancel`, { access_token: created.accessToken, reason: "flight delayed" }),
    );
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { view: { item: { state: string } } }).view.item.state).toBe(
      "cancelled_by_customer",
    );
    const detail = (await (
      await app.request(`https://inbox.test/v1/owner/items/${id}`, { headers: owner })
    ).json()) as {
      events: { event: string }[];
    };
    expect(detail.events.map((e) => e.event)).toEqual(["create", "confirm", "cancel_late"]);

    // An order's payment can fail, and the owner is offered what can follow.
    const order = (await (
      await app.request(
        jsonPost("/v1/orders", {
          payload: {
            orderedItem: [{ name: "Chain", quantity: 1, price: { value: 1500, currency: "EUR" } }],
            totalPrice: { value: 1500, currency: "EUR" },
          },
          contact: { email: "rita@example.com" },
        }),
      )
    ).json()) as { view: { item: { id: string } } };
    const oid = order.view.item.id;
    for (const event of ["accept", "request_payment"]) {
      expect((await app.request(jsonPost(`/v1/owner/items/${oid}/transitions`, { event }, owner))).status).toBe(200);
    }
    const failed = await app.request(
      jsonPost(`/v1/owner/items/${oid}/transitions`, { event: "payment_failed", input: { note: "declined" } }, owner),
    );
    expect(failed.status).toBe(200);
    const view = (await failed.json()) as { view: { item: { state: string }; transitions: { event: string }[] } };
    expect(view.view.item.state).toBe("payment_failed");
    expect(view.view.transitions.map((t) => t.event)).toEqual(["record_payment", "cancel"]);
  });

  it("explains invalid input as a problem document with fields", async () => {
    const { app } = await setup();
    const res = await app.request(jsonPost("/v1/bookings", { payload: { reservationFor: { serviceId: "x" } } }));
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const p = (await res.json()) as { code: string; fields: { path: string; problem: string }[] };
    expect(p.code).toBe("invalid_input");
    expect(p.fields.map((f) => f.path).sort()).toEqual([
      "payload.endTime",
      "payload.reservationFor.name",
      "payload.startTime",
    ]);
  });

  it("prices a fixed-price service and a catalogue product as the business does, whatever the request says", async () => {
    const { db, app, ownerKey } = await setup();
    const owner = { authorization: `Bearer ${ownerKey}` };
    const svc = ulid();
    const product = ulid();
    await db.orm.insert(schema.services).values({
      id: svc,
      name: "Full service",
      durationMin: 60,
      price: { model: "fixed", value: 10_000, currency: "EUR" },
      createdAt: T0,
      updatedAt: T0,
    });
    await db.orm.insert(schema.products).values({
      id: product,
      sku: "SD-1",
      name: "Saddle",
      price: { value: 15_000, currency: "EUR" },
      createdAt: T0,
      updatedAt: T0,
    });
    const booked = await app.request(
      jsonPost("/v1/bookings", {
        payload: {
          reservationFor: { serviceId: svc, name: "Full service" },
          startTime: "2026-09-22T08:00:00Z",
          endTime: "2026-09-22T09:00:00Z",
          totalPrice: { value: 100, currency: "EUR" },
        },
      }),
    );
    expect(booked.status).toBe(201);
    const b = (await booked.json()) as { view: { item: { id: string; payload: object }; human: string } };
    expect(b.view.item.payload).toMatchObject({
      totalPrice: { value: 10_000, currency: "EUR" },
      customerStatedPrice: { value: 100, currency: "EUR" },
    });
    expect(b.view.human).toContain("Our price is €100.00.");

    const ordered = await app.request(
      jsonPost("/v1/orders", {
        payload: {
          orderedItem: [
            {
              sku: "SD-1",
              name: "Saddle",
              quantity: 1,
              price: { value: 100, currency: "EUR" },
              customerStatedPrice: { value: 15_000, currency: "EUR" },
            },
          ],
          totalPrice: { value: 100, currency: "EUR" },
          customerStatedPrice: { value: 15_000, currency: "EUR" },
        },
      }),
    );
    expect(ordered.status).toBe(201);
    const o = (await ordered.json()) as { view: { item: { id: string; payload: object } } };
    // What the request sent as a stated price is not the customer's to set: the inbox writes it.
    expect(o.view.item.payload).toMatchObject({
      orderedItem: [
        { price: { value: 15_000, currency: "EUR" }, customerStatedPrice: { value: 100, currency: "EUR" } },
      ],
      totalPrice: { value: 15_000, currency: "EUR" },
      customerStatedPrice: { value: 100, currency: "EUR" },
    });

    // The owner reads both, and the sentence says which is which.
    const detail = (await (
      await app.request(`https://inbox.test/v1/owner/items/${b.view.item.id}`, { headers: owner })
    ).json()) as { item: { payload: object }; human: string };
    expect(detail.item.payload).toMatchObject({ customerStatedPrice: { value: 100, currency: "EUR" } });
    expect(detail.human).toContain("The customer's assistant suggested €1.00; your price is €100.00.");
  });

  it("serves profile, services, availability and the OpenAPI document", async () => {
    const { app, svc } = await setup();
    expect(((await (await app.request("https://inbox.test/v1/business")).json()) as { name: string }).name).toBe(
      "Oficina Maré",
    );
    const services = (await (await app.request("https://inbox.test/v1/services")).json()) as {
      items: { id: string }[];
    };
    expect(services.items.map((s) => s.id)).toEqual([svc]);
    const slots = await app.request(
      `https://inbox.test/v1/availability?service_id=${svc}&from=2026-09-22T00:00:00Z&to=2026-09-23T00:00:00Z`,
    );
    expect(slots.status).toBe(200);
    expect(((await slots.json()) as { slots: unknown[] }).slots.length).toBeGreaterThan(0);
    const spec = (await (await app.request("https://inbox.test/openapi.json")).json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(["/v1/bookings", "/v1/availability", "/v1/owner/items/{id}/transitions"]),
    );
  });
});
