import { runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { itemEvents, items, jobs, parties, services, slotClaims, threadEntries } from "../src/schema/tables";
import { type Caller, createItem, transitionItem, WriteError } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

const T0 = Date.parse("2026-09-21T10:00:00Z");
const clock = { now: T0 };

async function setup(): Promise<{ db: Db; svc1: string; svc2: string }> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const svc1 = ulid();
  const svc2 = ulid();
  await db.orm.insert(services).values([
    { id: svc1, name: "Full service", durationMin: 90, capacity: 1, granularityMin: 15, createdAt: T0, updatedAt: T0 },
    {
      id: svc2,
      name: "Puncture repair",
      durationMin: 30,
      capacity: 2,
      granularityMin: 15,
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  return { db, svc1, svc2 };
}

const form = (key?: string, accessToken?: string): Caller => ({
  actor: { kind: "customer_human", id: "form", channel: "form" },
  tier: "anonymous",
  sandbox: false,
  now: () => clock.now,
  ...(key ? { idempotency: { scope: "anon:test", key } } : {}),
  ...(accessToken ? { accessToken } : {}),
});
const owner: Caller = {
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock.now,
};
const agent = (key: string, accessToken?: string): Caller => ({
  actor: { kind: "customer_agent", id: "agent:chatgpt", channel: "mcp_public" },
  tier: "signed_agent",
  sandbox: false,
  idempotency: { scope: "agent:chatgpt:mcp", key },
  now: () => clock.now,
  ...(accessToken ? { accessToken } : {}),
});

const booking = (svc: string, start = "2026-09-23T14:00:00Z", end = "2026-09-23T15:30:00Z") => ({
  type: "booking" as const,
  payload: {
    reservationFor: { serviceId: svc, name: "Full service" },
    startTime: start,
    endTime: end,
    totalPrice: { value: 4500, currency: "EUR" },
  },
  contact: { name: "Rita Amaral", email: "rita@example.com" },
  message: "Brakes squeak at low speed.",
});

async function fail(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected a WriteError");
}

describe("createItem", () => {
  it("creates a booking for an anonymous customer with a party, an event, a message and an access token", async () => {
    const { db, svc1 } = await setup();
    const res = await createItem(db, form(), booking(svc1));
    expect(res.replayed).toBe(false);
    expect(res.accessToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(res.view.item).toMatchObject({
      type: "booking",
      state: "requested",
      version: 1,
      subject: "Full service",
      channel: "form",
    });
    expect(res.view.transitions.map((t) => t.event)).toEqual(["cancel"]);
    expect(res.view.human).toMatch(/Booking "Full service" for 2026-09-23 14:00 UTC is requested/);
    const [party] = await db.orm.select().from(parties).where(eq(parties.id, res.view.item.partyId));
    expect(party).toMatchObject({ kind: "human", displayName: "Rita Amaral" });
    const events = await db.orm.select().from(itemEvents).where(eq(itemEvents.itemId, res.view.item.id));
    expect(events.map((e) => [e.seq, e.event, e.toState])).toEqual([[1, "create", "requested"]]);
    const thread = await db.orm.select().from(threadEntries).where(eq(threadEntries.itemId, res.view.item.id));
    expect(thread.map((t) => [t.direction, t.bodyText])).toEqual([["in", "Brakes squeak at low speed."]]);
    const queued = await db.orm.select({ kind: jobs.kind }).from(jobs);
    expect(queued.map((j) => j.kind).sort()).toEqual(["notify", "rules"]);
  });

  it("names the missing fields so an agent can retry once", async () => {
    const { db } = await setup();
    const err = await fail(
      createItem(db, agent("k1"), { type: "booking", payload: { reservationFor: { serviceId: "x" } } }),
    );
    expect(err.code).toBe("invalid_input");
    expect(err.fields?.map((f) => f.path).sort()).toEqual([
      "payload.endTime",
      "payload.reservationFor.name",
      "payload.startTime",
    ]);
    expect(err.message).toMatch(/^Missing: /);
  });

  it("replays the same request for the same idempotency key, and refuses a different one", async () => {
    const { db, svc1 } = await setup();
    const a = await createItem(db, agent("same"), booking(svc1));
    const b = await createItem(db, agent("same"), booking(svc1));
    expect(b.replayed).toBe(true);
    expect(b.view.item.id).toBe(a.view.item.id);
    const all = await db.orm.select({ id: items.id }).from(items);
    expect(all).toHaveLength(1);
    const err = await fail(
      createItem(db, agent("same"), booking(svc1, "2026-09-24T14:00:00Z", "2026-09-24T15:30:00Z")),
    );
    expect(err.code).toBe("idempotency_mismatch");
  });

  it("collapses concurrent identical requests into one item", async () => {
    const { db, svc1 } = await setup();
    const results = await Promise.all(Array.from({ length: 10 }, () => createItem(db, agent("burst"), booking(svc1))));
    const ids = new Set(results.map((r) => r.view.item.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(9);
    const all = await db.orm.select({ id: items.id }).from(items);
    expect(all).toHaveLength(1);
  });
});

describe("transitionItem", () => {
  it("confirms a booking: version 2, slot claims, receipt and notification jobs", async () => {
    const { db, svc1 } = await setup();
    const created = await createItem(db, form(), booking(svc1));
    const res = await transitionItem(db, owner, { itemId: created.view.item.id, event: "confirm" });
    expect(res.view.item).toMatchObject({ state: "confirmed", version: 2 });
    expect(res.view.transitions.map((t) => t.label)).toEqual(["Cancel booking", "Mark completed", "Mark no-show"]);
    const claims = await db.orm.select().from(slotClaims).where(eq(slotClaims.itemId, created.view.item.id));
    expect(claims).toHaveLength(6); // 90 minutes in 15-minute buckets
    expect(claims.every((c) => c.resourceKey === `service:${svc1}` && c.ordinal === 0)).toBe(true);
    const kinds = (await db.orm.select({ kind: jobs.kind, payload: jobs.payload }).from(jobs)).map((j) => j.kind);
    expect(kinds).toContain("issue_receipt");
    expect(kinds.filter((k) => k === "notify")).toHaveLength(2);
    const events = await db.orm
      .select({ seq: itemEvents.seq, event: itemEvents.event })
      .from(itemEvents)
      .where(eq(itemEvents.itemId, created.view.item.id));
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("refuses the wrong actor, the wrong state and an unknown event with precise reasons", async () => {
    const { db, svc1 } = await setup();
    const created = await createItem(db, form(), booking(svc1));
    const id = created.view.item.id;
    expect(
      (await fail(transitionItem(db, form(undefined, created.accessToken), { itemId: id, event: "confirm" }))).code,
    ).toBe("not_allowed");
    expect((await fail(transitionItem(db, owner, { itemId: id, event: "teleport" }))).code).toBe("unknown_event");
    await transitionItem(db, owner, { itemId: id, event: "confirm" });
    const wrong = await fail(transitionItem(db, owner, { itemId: id, event: "confirm" }));
    expect(wrong.code).toBe("wrong_state");
    expect(wrong.details).toMatchObject({ state: "confirmed" });
  });

  it("arbitrates capacity: one bay is one booking, two bays are two", async () => {
    const { db, svc1, svc2 } = await setup();
    const a = await createItem(db, form(), booking(svc1));
    const b = await createItem(db, form(), booking(svc1, "2026-09-23T14:30:00Z", "2026-09-23T16:00:00Z"));
    await transitionItem(db, owner, { itemId: a.view.item.id, event: "confirm" });
    const taken = await fail(transitionItem(db, owner, { itemId: b.view.item.id, event: "confirm" }));
    expect(taken.code).toBe("slot_taken");
    const c = await createItem(db, form(), booking(svc2, "2026-09-23T09:00:00Z", "2026-09-23T09:30:00Z"));
    const d = await createItem(db, form(), booking(svc2, "2026-09-23T09:00:00Z", "2026-09-23T09:30:00Z"));
    const e = await createItem(db, form(), booking(svc2, "2026-09-23T09:15:00Z", "2026-09-23T09:45:00Z"));
    await transitionItem(db, owner, { itemId: c.view.item.id, event: "confirm" });
    await transitionItem(db, owner, { itemId: d.view.item.id, event: "confirm" });
    expect((await fail(transitionItem(db, owner, { itemId: e.view.item.id, event: "confirm" }))).code).toBe(
      "slot_taken",
    );
    const claims = await db.orm
      .select()
      .from(slotClaims)
      .where(eq(slotClaims.resourceKey, `service:${svc2}`));
    expect(claims.map((c) => c.ordinal).sort()).toEqual([0, 0, 1, 1]);
  });

  it("lets exactly one of two concurrent confirmations win the last bay", async () => {
    const { db, svc1 } = await setup();
    const a = await createItem(db, form(), booking(svc1));
    const b = await createItem(db, form(), booking(svc1));
    const results = await Promise.allSettled([
      transitionItem(db, owner, { itemId: a.view.item.id, event: "confirm" }),
      transitionItem(db, owner, { itemId: b.view.item.id, event: "confirm" }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const reason = lost[0]?.reason as WriteError | undefined;
    expect(reason?.code).toBe("slot_taken");
    const claims = await db.orm.select().from(slotClaims);
    expect(new Set(claims.map((c) => c.itemId)).size).toBe(1);
  });

  it("detects a stale version and releases slots on cancellation within the window", async () => {
    const { db, svc1 } = await setup();
    const created = await createItem(db, form(), booking(svc1));
    const id = created.view.item.id;
    await transitionItem(db, owner, { itemId: id, event: "confirm" });
    const stale = await fail(transitionItem(db, owner, { itemId: id, event: "complete", expectedVersion: 1 }));
    expect(stale.code).toBe("version_conflict");
    const stranger = await fail(transitionItem(db, form(), { itemId: id, event: "cancel" }));
    expect(stranger.code).toBe("not_allowed");
    const cancelled = await transitionItem(db, form(undefined, created.accessToken), {
      itemId: id,
      event: "cancel",
      input: { note: "Sorry, family emergency." },
    });
    expect(cancelled.view.item.state).toBe("cancelled_by_customer");
    expect(cancelled.view.item.closedAt).not.toBeNull();
    expect(await db.orm.select().from(slotClaims)).toHaveLength(0);
    const thread = await db.orm
      .select({ body: threadEntries.bodyText, direction: threadEntries.direction })
      .from(threadEntries)
      .where(eq(threadEntries.itemId, id));
    expect(thread.at(-1)).toEqual({ body: "Sorry, family emergency.", direction: "in" });
  });

  it("blocks a late cancellation of a confirmed booking", async () => {
    const { db, svc1 } = await setup();
    const created = await createItem(db, form(), booking(svc1, "2026-09-21T12:00:00Z", "2026-09-21T13:30:00Z"));
    await transitionItem(db, owner, { itemId: created.view.item.id, event: "confirm" });
    const late = await fail(
      transitionItem(db, form(undefined, created.accessToken), { itemId: created.view.item.id, event: "cancel" }),
    );
    expect(late.code).toBe("guard_failed");
    expect(late.details).toMatchObject({ guard: "within_cancellation_window" });
  });

  it("turns an accepted quote into a linked order", async () => {
    const { db } = await setup();
    const q = await createItem(db, form(), {
      type: "quote_request",
      payload: { itemOffered: { name: "Custom gravel build" }, description: "Shimano GRX, 54cm, matte green." },
      contact: { name: "Mariana Lopes" },
    });
    const id = q.view.item.id;
    const quoted = await transitionItem(db, owner, {
      itemId: id,
      event: "quote",
      input: {
        totalPrice: { value: 289000, currency: "EUR" },
        validThrough: "2026-10-05T00:00:00Z",
        lines: [{ name: "Frame and build", quantity: 1, price: { value: 289000, currency: "EUR" } }],
      },
    });
    expect(quoted.view.item.state).toBe("quoted");
    const accepted = await transitionItem(db, form(undefined, q.accessToken), { itemId: id, event: "accept" });
    expect(accepted.view.item.state).toBe("accepted");
    expect(accepted.linked?.item).toMatchObject({
      type: "order",
      state: "received",
      linkedItemId: id,
      subject: "1 × Frame and build",
    });
    const [order] = await db.orm
      .select()
      .from(items)
      .where(eq(items.id, accepted.linked?.item.id ?? ""));
    expect(order?.linkedItemId).toBe(id);
    const [quote] = await db.orm.select().from(items).where(eq(items.id, id));
    expect(quote?.linkedItemId).toBe(order?.id);
    // The anonymous creator's token opens the linked order too.
    const cancelled = await transitionItem(db, form(undefined, q.accessToken), {
      itemId: order?.id ?? "",
      event: "cancel",
    });
    expect(cancelled.view.item.state).toBe("cancelled");
  });

  it("runs a message through reply and reopen", async () => {
    const { db } = await setup();
    const m = await createItem(db, form(), {
      type: "message",
      payload: { text: "Do you fix e-bike batteries?" },
      contact: { email: "tomas@example.com" },
    });
    expect(m.view.item.subject).toBe("Do you fix e-bike batteries?");
    const answered = await transitionItem(db, owner, { itemId: m.view.item.id, event: "answer" });
    expect(answered.view.item.state).toBe("answered");
    const reopened = await transitionItem(db, form(undefined, m.accessToken), {
      itemId: m.view.item.id,
      event: "reopen",
    });
    expect(reopened.view.item).toMatchObject({ state: "open", version: 3 });
  });

  it("replays a transition for the same idempotency key", async () => {
    const { db, svc1 } = await setup();
    const created = await createItem(db, agent("c1"), booking(svc1));
    const first = await transitionItem(db, agent("t1", created.accessToken), {
      itemId: created.view.item.id,
      event: "cancel",
    });
    const again = await transitionItem(db, agent("t1", created.accessToken), {
      itemId: created.view.item.id,
      event: "cancel",
    });
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.view.item.version).toBe(2);
  });
});
