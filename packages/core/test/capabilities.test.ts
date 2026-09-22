import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { serviceInput } from "../src/capabilities/setup-types";
import { createDb, type Db } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { availabilityRules, business, products, services, slotClaims } from "../src/schema/tables";
import { type Caller, WriteError } from "../src/write/index";
import { bucketRange, bucketsFor } from "../src/write/slots";
import { makeClient, resetTables } from "./harness";

const T0 = Date.parse("2026-09-21T10:00:00Z");
const owner: Caller = {
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const agent = (key: string, accessToken?: string): Caller => ({
  actor: { kind: "customer_agent", id: "agent:claude", channel: "mcp_public" },
  tier: "signed_agent",
  sandbox: false,
  now: () => T0,
  idempotency: { scope: "agent:claude", key },
  ...(accessToken ? { accessToken } : {}),
});

async function setup(): Promise<{ db: Db; caps: Capabilities; svc: string }> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const svc = ulid();
  await db.orm.insert(business).values({
    id: "self",
    name: "Oficina Maré",
    domain: "oficinamare.pt",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    createdAt: T0,
    updatedAt: T0,
  });
  await db.orm.insert(services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    capacity: 1,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  await db.orm.insert(products).values([
    {
      id: ulid(),
      sku: "SM-700",
      name: "Schwalbe Marathon 700×35",
      price: { value: 3920, currency: "EUR" },
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: ulid(),
      sku: "CH-9",
      name: "Chain, 9-speed",
      price: { value: 1850, currency: "EUR" },
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  return { db, caps: new Capabilities(db), svc };
}

async function fail(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected a WriteError");
}

describe("public capabilities", () => {
  it("serves the profile, services and products", async () => {
    const { caps } = await setup();
    expect(await caps.getBusinessProfile()).toMatchObject({
      name: "Oficina Maré",
      timezone: "Europe/Lisbon",
      currency: "EUR",
    });
    const services = await caps.listServices({ limit: 50 });
    expect(services.items.map((s) => s.name)).toEqual(["Full service"]);
    const chain = await caps.listProducts({ limit: 50, q: "chain" });
    expect(chain.items.map((p) => p.sku)).toEqual(["CH-9"]);
    const paged = await caps.listProducts({ limit: 1 });
    expect(paged.items).toHaveLength(1);
    expect(paged.next_cursor).not.toBeNull();
  });

  it("finds free slots inside opening hours in the business time zone, minus claims", async () => {
    const { db, caps, svc } = await setup();
    // Lisbon is UTC+1 in September: 09:00-12:00 local on Tuesday 22 Sep = 08:00-11:00Z.
    await db.orm
      .insert(availabilityRules)
      .values({ id: ulid(), serviceId: svc, kind: "open", weekly: { tue: [["09:00", "12:00"]] }, createdAt: T0 });
    const res = await caps.checkAvailability({
      service_id: svc,
      from: "2026-09-22T00:00:00Z",
      to: "2026-09-23T00:00:00Z",
    });
    expect(res.slots.map((s) => s.startTime)).toEqual([
      "2026-09-22T08:00:00.000Z",
      "2026-09-22T08:30:00.000Z",
      "2026-09-22T09:00:00.000Z",
      "2026-09-22T09:30:00.000Z",
    ]);
    expect(res.slots.every((s) => s.available === 1)).toBe(true);
    await db.orm.insert(slotClaims).values([
      { resourceKey: `service:${svc}`, bucketStart: Date.parse("2026-09-22T08:30:00Z"), ordinal: 0, itemId: "x" },
      { resourceKey: `service:${svc}`, bucketStart: Date.parse("2026-09-22T09:00:00Z"), ordinal: 0, itemId: "x" },
    ]);
    const after = await caps.checkAvailability({
      service_id: svc,
      from: "2026-09-22T00:00:00Z",
      to: "2026-09-23T00:00:00Z",
    });
    expect(after.slots.map((s) => s.startTime)).toEqual(["2026-09-22T09:30:00.000Z"]);
    const bad = await fail(
      caps.checkAvailability({ service_id: "nope", from: "2026-09-22T00:00:00Z", to: "2026-09-23T00:00:00Z" }),
    );
    expect(bad.fields?.[0]?.path).toBe("service_id");
  });

  it("books, reads status with the access token, refuses without it, and cancels", async () => {
    const { caps, svc } = await setup();
    const created = await caps.createBooking(agent("b1"), {
      payload: {
        reservationFor: { serviceId: svc, name: "Full service" },
        startTime: "2026-09-22T08:00:00Z",
        endTime: "2026-09-22T09:30:00Z",
      },
      contact: { name: "Rita Amaral", email: "rita@example.com" },
      idempotency_key: "b1",
    });
    const id = created.view.item.id;
    const status = await caps.getItemStatus(agent("s1", created.accessToken), {
      item_id: id,
      access_token: created.accessToken,
    });
    expect(status.item.state).toBe("requested");
    expect((await fail(caps.getItemStatus(agent("s2"), { item_id: id }))).code).toBe("not_allowed");
    const cancelled = await caps.cancelItem(agent("c1"), {
      item_id: id,
      access_token: created.accessToken,
      reason: "Found a closer shop.",
      idempotency_key: "c1",
    });
    expect(cancelled.view.item.state).toBe("cancelled_by_customer");
  });

  it("starts a conversation, replies on it, and reopens an answered message", async () => {
    const { caps } = await setup();
    const started = (await caps.sendMessage(agent("m1"), {
      body: "Do you fix e-bike batteries?",
      contact: { email: "tomas@example.com" },
      idempotency_key: "m1",
    })) as { view: { item: { id: string } }; accessToken?: string };
    const id = started.view.item.id;
    const answered = await caps.reply(owner, { item_id: id, body: "Yes, most brands. Bring it in.", internal: false });
    expect((answered as { view: { item: { state: string } } }).view.item.state).toBe("answered");
    const reopened = (await caps.sendMessage(agent("m2", started.accessToken), {
      item_id: id,
      body: "Great, Thursday?",
      access_token: started.accessToken,
      idempotency_key: "m2",
    })) as { view: { item: { state: string } } };
    expect(reopened.view.item.state).toBe("open");
    const detail = await caps.getItem(owner, { item_id: id });
    expect(detail.thread.map((t) => t.direction)).toEqual(["in", "out", "in"]);
    expect(detail.events.map((e) => e.event)).toEqual(["create", "answer", "reopen"]);
  });
});

describe("owner capabilities", () => {
  it("lists with filters, search and a cursor, and hides closed items by default", async () => {
    const { caps, svc } = await setup();
    const a = await caps.createBooking(agent("l1"), {
      payload: {
        reservationFor: { serviceId: svc, name: "Full service" },
        startTime: "2026-09-22T08:00:00Z",
        endTime: "2026-09-22T09:30:00Z",
      },
      message: "Squeaky brakes",
      idempotency_key: "l1",
    });
    await caps.sendMessage(agent("l2"), { body: "Opening hours on Saturday?", idempotency_key: "l2" });
    await caps.sendMessage(agent("l3"), { body: "Do you sell chains?", idempotency_key: "l3" });
    expect((await caps.listItems(owner, { limit: 50, open_only: true, sandbox: false })).items).toHaveLength(3);
    expect(
      (await caps.listItems(owner, { limit: 50, open_only: true, sandbox: false, type: "booking" })).items.map(
        (v) => v.item.id,
      ),
    ).toEqual([a.view.item.id]);
    expect(
      (await caps.listItems(owner, { limit: 50, open_only: true, sandbox: false, q: "brakes" })).items.map(
        (v) => v.item.id,
      ),
    ).toEqual([a.view.item.id]);
    const first = await caps.listItems(owner, { limit: 2, open_only: true, sandbox: false });
    expect(first.items).toHaveLength(2);
    const second = await caps.listItems(owner, {
      limit: 2,
      open_only: true,
      sandbox: false,
      cursor: first.next_cursor ?? "",
    });
    expect(second.items).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    await caps.transitionItem(owner, { item_id: a.view.item.id, event: "decline", reason: "Fully booked that week" });
    expect((await caps.listItems(owner, { limit: 50, open_only: true, sandbox: false })).items).toHaveLength(2);
    expect((await caps.listItems(owner, { limit: 50, open_only: false, sandbox: false })).items).toHaveLength(3);
    expect((await fail(caps.listItems(agent("x"), { limit: 50, open_only: true, sandbox: false }))).code).toBe(
      "not_allowed",
    );
  });

  it("stores settings with optimistic versioning", async () => {
    const { caps } = await setup();
    expect((await caps.getSettings(owner)).version).toBe(0);
    const v1 = await caps.updateSettings(owner, {
      doc: { business: { name: "Oficina Maré", timezone: "Europe/Lisbon" }, booking: { cancellationWindowMin: 120 } },
    });
    expect(v1.version).toBe(1);
    expect(v1.doc.booking).toMatchObject({ cancellationWindowMin: 120, holdOnPropose: false });
    const v2 = await caps.updateSettings(owner, { doc: { ...v1.doc, testMode: true }, expected_version: 1 });
    expect(v2.version).toBe(2);
    expect((await fail(caps.updateSettings(owner, { doc: v1.doc, expected_version: 1 }))).code).toBe(
      "version_conflict",
    );
    expect(
      (await fail(caps.updateSettings(owner, { doc: { business: { currency: "EURO" } } }))).fields?.[0]?.path,
    ).toBe("doc.business.currency");
  });
});

/**
 * Found by walking the setup wizard on a brand-new instance: the wizard creates a service on the
 * schema's default 15-minute granularity, and the first thing any agent does is ask what is free
 * on a given day. That asked for slightly more than 96 buckets and was refused with a booking
 * error — so a freshly set-up inbox answered "a booking may span at most 96 slots" to the one
 * question it exists to answer.
 */
describe("availability over a real window", () => {
  /** A service on the schema's DEFAULT granularity, which is what the setup wizard creates. */
  async function lawyer(caps: Capabilities, weekly: Record<string, [string, string][]>) {
    // Through the schema, exactly as the HTTP door does it, so the defaults under test are the
    // real ones rather than numbers written twice.
    const service = await caps.setup.createService(
      owner,
      serviceInput.parse({ name: "Initial consultation", duration_min: 60, active: true }),
    );
    expect(service.granularityMin).toBe(15);
    await caps.setup.setWeekly(owner, { weekly });
    return service;
  }

  it("answers a whole day on the default granularity", async () => {
    const { caps } = await setup();
    const service = await lawyer(caps, { mon: [["09:00", "17:00"]] });
    // A Monday, midnight to midnight: 96 buckets of 15 minutes, and the search looks one
    // duration past the end. That was refused with "a booking may span at most 96 slots".
    const { slots } = await caps.checkAvailability({
      service_id: service.id,
      from: "2026-09-28T00:00:00.000Z",
      to: "2026-09-29T00:00:00.000Z",
    });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0]?.startTime).toBe("2026-09-28T08:00:00.000Z");
  });

  it("answers the fourteen days the endpoint documents", async () => {
    const { caps } = await setup();
    const service = await lawyer(caps, { mon: [["09:00", "10:00"]], tue: [["09:00", "10:00"]] });
    const { slots } = await caps.checkAvailability({
      service_id: service.id,
      from: "2026-09-28T00:00:00.000Z",
      to: "2026-10-12T00:00:00.000Z",
    });
    // Two Mondays and two Tuesdays, one hour each.
    expect(slots).toHaveLength(4);
  });

  it("still caps one booking's span, which is what the cap was for", () => {
    // The cap belongs to a booking, not to a window someone is searching. bucketsFor keeps it;
    // bucketRange, which the search uses, does not have it.
    const spec = { resourceKey: "svc:x", capacity: 1, granularityMin: 15, bufferBeforeMin: 0, bufferAfterMin: 0 };
    expect(() => bucketsFor(spec, "2026-09-28T00:00:00.000Z", "2026-09-30T00:00:00.000Z")).toThrow(/at most 96 slots/);
    expect(bucketRange(spec, "2026-09-28T00:00:00.000Z", "2026-09-30T00:00:00.000Z")).toHaveLength(192);
    // And a real booking, inside the cap, still measures the same either way.
    expect(bucketsFor(spec, "2026-09-28T09:00:00.000Z", "2026-09-28T10:00:00.000Z")).toHaveLength(4);
  });
});
