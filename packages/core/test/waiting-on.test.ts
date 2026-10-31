import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { waitingOn } from "../src/customer/describe";
import { createDb } from "../src/db";
import type { Item } from "../src/domain/types";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { type Caller, transitionItem } from "../src/write/index";
import { confirming, makeClient, openWeekdays, resetTables } from "./harness";

/**
 * Who an item waits on, as the customer's status says it (ADR-044 §3): a confirmed booking said
 * "waiting_on: us" while nothing was pending. Now only who must act is named, and nobody when nothing
 * is pending. Runs on Node and in workerd.
 */
const item = (
  type: Item["type"],
  state: string,
  payload: Record<string, unknown> = {},
  closedAt: string | null = null,
) =>
  ({
    id: "01J0000000000000000000000",
    type,
    state,
    version: 1,
    partyId: null,
    locationId: null,
    channel: "rest",
    subject: null,
    flags: { needsHuman: false, sandbox: false, priority: 0 },
    linkedItemId: null,
    createdAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-30T10:00:00.000Z",
    closedAt,
    payload,
  }) as unknown as Item;

const booking = { reservationFor: { serviceId: "s", name: "Full service" }, startTime: "", endTime: "" };

describe("waiting_on", () => {
  it("names nobody on a confirmed booking with nothing pending, and the side that must act otherwise", () => {
    expect(waitingOn(item("booking", "confirmed", booking))).toBeNull();
    expect(waitingOn(item("booking", "requested", booking))).toBe("us");
    expect(waitingOn(item("booking", "proposed", booking))).toBe("you");
    expect(waitingOn(item("booking", "needs_info", booking))).toBe("you");
  });

  it("names whoever did not ask for a change to what was agreed", () => {
    expect(waitingOn(item("booking", "confirmed", { ...booking, change: { by: "customer" } }))).toBe("us");
    expect(waitingOn(item("booking", "confirmed", { ...booking, change: { by: "business" } }))).toBe("you");
    expect(waitingOn(item("order", "accepted", { change: { by: "customer" } }))).toBe("us");
  });

  it("names us while the business still has to do something, and nobody once it is done", () => {
    expect(waitingOn(item("order", "received"))).toBe("us");
    expect(waitingOn(item("order", "accepted"))).toBe("us");
    expect(waitingOn(item("order", "paid"))).toBe("us");
    expect(waitingOn(item("order", "awaiting_payment"))).toBe("you");
    expect(waitingOn(item("order", "fulfilled"))).toBeNull();
    expect(waitingOn(item("message", "open"))).toBe("us");
    expect(waitingOn(item("message", "answered"))).toBeNull();
    expect(waitingOn(item("quote_request", "quoted"))).toBe("you");
    expect(waitingOn(item("stay", "confirmed"))).toBeNull();
    expect(waitingOn(item("stay", "checked_in"))).toBeNull();
  });

  it("names nobody once it is closed", () => {
    expect(waitingOn(item("booking", "completed", booking, "2026-10-31T10:00:00.000Z"))).toBeNull();
    expect(waitingOn(item("message", "spam"))).toBeNull();
  });
});

const T0 = Date.parse("2026-09-21T10:00:00Z"); // a Monday
const MIN = 60_000;
const clock = { now: T0 };
const owner: Caller = {
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock.now,
};
const anon = (accessToken?: string): Caller => ({
  actor: { kind: "customer_agent", id: "agent:test", channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => clock.now,
  ...(accessToken ? { accessToken } : {}),
});

/** A confirmed booking an anonymous customer asked for, with a note, and the owner confirmed. */
async function confirmedBooking() {
  clock.now = T0;
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const svc = ulid();
  await db.orm.insert(business).values({
    id: "self",
    name: "Oficina Maré",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    languages: ["en"],
    createdAt: T0,
    updatedAt: T0,
  });
  await db.orm.insert(services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    capacity: 1,
    granularityMin: 30,
    price: { model: "fixed", value: 4500, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  await openWeekdays(db);
  const caps = confirming(new Capabilities(db, createSecretBox(["waiting-on-test-secret-0123456789abcdef"])));
  const created = await caps.createBooking(anon(), {
    payload: {
      reservationFor: { serviceId: svc, name: "Full service" },
      startTime: "2026-09-23T09:00:00Z",
      endTime: "2026-09-23T10:30:00Z",
    },
    contact: { name: "Rita", email: "rita@example.com" },
    message: "The rear brake squeaks.",
  });
  const id = created.view.item.id;
  const token = created.accessToken as string;
  clock.now += MIN;
  await transitionItem(db, owner, { itemId: id, event: "confirm" });
  return { caps, id, token };
}

describe("waiting_on on a promise in force", () => {
  it("names nobody once confirmed, though the request carried a note the confirmation answered", async () => {
    const { caps, id, token } = await confirmedBooking();
    expect((await caps.getItemStatus(anon(token), { item_id: id })).waiting_on).toBeNull();
  });

  it("names us while the customer's question waits for the business's answer, and nobody once it replied", async () => {
    const { caps, id, token } = await confirmedBooking();
    clock.now += MIN;
    const asked = await caps.customer.provideDetails(anon(token), { item_id: id, details: "Can I come at 08:45?" });
    expect("appended" in asked && asked.waiting_on).toBe("us");
    expect((asked.view as { waiting_on?: unknown }).waiting_on).toBe("us");
    expect((await caps.getItemStatus(anon(token), { item_id: id })).waiting_on).toBe("us");

    clock.now += MIN;
    await caps.reply(owner, { item_id: id, body: "Of course, the door is open from 08:30.", internal: false });
    expect((await caps.getItemStatus(anon(token), { item_id: id })).waiting_on).toBeNull();

    // A note the team keeps for itself answers nobody.
    clock.now += MIN;
    await caps.sendMessage(anon(token), { item_id: id, body: "And may I leave it until Friday?" });
    expect((await caps.getItemStatus(anon(token), { item_id: id })).waiting_on).toBe("us");
    clock.now += MIN;
    await caps.reply(owner, { item_id: id, body: "Ask Ana about Friday.", internal: true });
    expect((await caps.getItemStatus(anon(token), { item_id: id })).waiting_on).toBe("us");
    clock.now += MIN;
    await caps.reply(owner, { item_id: id, body: "Friday is fine.", internal: false });
    expect((await caps.getItemStatus(anon(token), { item_id: id })).waiting_on).toBeNull();
  });
});
