import { runMigrations } from "@surfingdog/platform";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
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
    // The customer is answered in the business's voice.
    expect(res.view.human).toMatch(
      /^Your booking "Full service" for Wednesday, 23 September 2026 at 14:00 \(UTC\) is with us; we will confirm it or suggest another time\. Reference [0-9A-Z]{6}\.$/,
    );
    const [party] = await db.orm.select().from(parties).where(eq(parties.id, res.view.item.partyId));
    expect(party).toMatchObject({ kind: "human", displayName: "Rita Amaral" });
    const events = await db.orm.select().from(itemEvents).where(eq(itemEvents.itemId, res.view.item.id));
    expect(events.map((e) => [e.seq, e.event, e.toState])).toEqual([[1, "create", "requested"]]);
    const thread = await db.orm.select().from(threadEntries).where(eq(threadEntries.itemId, res.view.item.id));
    expect(thread.map((t) => [t.direction, t.bodyText])).toEqual([["in", "Brakes squeak at low speed."]]);
    const queued = await db.orm.select({ kind: jobs.kind, payload: jobs.payload, runAt: jobs.runAt }).from(jobs);
    expect(queued.map((j) => j.kind).sort()).toEqual(["notify", "notify", "rules"]);
    // The owner hears now; the customer's acknowledgement waits a moment, for a rule's answer to go instead.
    const ack = queued.find((j) => (j.payload as { to?: string }).to === "customer");
    expect(ack?.payload).toMatchObject({ to: "customer", event: "create" });
    expect(Number(ack?.runAt)).toBeGreaterThan(
      Math.max(...queued.filter((j) => j !== ack).map((j) => Number(j.runAt))),
    );
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
    expect(res.view.transitions.map((t) => t.label)).toEqual([
      "Mark completed",
      "Mark no-show",
      "Cancel booking",
      "Customer cancelled",
    ]);
    const claims = await db.orm.select().from(slotClaims).where(eq(slotClaims.itemId, created.view.item.id));
    expect(claims).toHaveLength(6); // 90 minutes in 15-minute buckets
    expect(claims.every((c) => c.resourceKey === `service:${svc1}` && c.ordinal === 0)).toBe(true);
    const kinds = (await db.orm.select({ kind: jobs.kind, payload: jobs.payload }).from(jobs)).map((j) => j.kind);
    expect(kinds).toContain("issue_receipt");
    // The owner's and the customer's for the create (the acknowledgement), the customer's confirmation.
    expect(kinds.filter((k) => k === "notify")).toHaveLength(3);
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

  it("turns an accepted quote into a linked order, accepted at once", async () => {
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
      state: "accepted",
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

// ---- the customer's answers and the owner's buttons (ADR-018 N13, N14; §3.3) ----------------------

const ownerAi: Caller = {
  actor: { kind: "owner_ai", id: "client_ai", channel: "mcp_owner" },
  actsAs: "owner",
  principal: { via: "oauth", id: "client_ai", name: "An AI app", scopes: ["*"], userId: "user_1" },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock.now,
};
const integration: Caller = {
  actor: { kind: "integration", id: "key_1", channel: "rest" },
  actsAs: "owner",
  principal: { via: "api_key", id: "key_1", name: "Till", scopes: ["*"], userId: null, keyKind: "integration" },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock.now,
};
const rule: Caller = {
  actor: { kind: "rule", id: "rule_1", channel: "system" },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock.now,
};
const later = { startTime: "2026-09-23T16:00:00Z", endTime: "2026-09-23T17:30:00Z" };

async function jobsOf(db: Db, kind: string): Promise<(Record<string, unknown> & { dedupe: string | null })[]> {
  return (
    await db.orm.select({ payload: jobs.payload, dedupe: jobs.dedupeKey }).from(jobs).where(eq(jobs.kind, kind))
  ).map((j) => ({ ...(j.payload as Record<string, unknown>), dedupe: j.dedupe }));
}

describe("the owner's Confirm and the customer's answers", () => {
  it("books the proposed time when a person confirms it, and refuses the owner's AI, a key and a rule", async () => {
    clock.now = T0;
    const { db, svc1 } = await setup();
    const created = await createItem(db, form(), booking(svc1));
    const id = created.view.item.id;
    await transitionItem(db, owner, { itemId: id, event: "propose", input: later });
    for (const who of [ownerAi, integration]) {
      const refused = await fail(transitionItem(db, who, { itemId: id, event: "confirm" }));
      expect(refused.code).toBe("not_allowed");
      expect(refused.details).toMatchObject({ reason: "person_only" });
      expect(refused.message).toMatch(/^Only a person can record that the customer agreed/);
    }
    expect((await fail(transitionItem(db, rule, { itemId: id, event: "confirm" }))).code).toBe("not_allowed");
    const r = await transitionItem(db, owner, {
      itemId: id,
      event: "confirm",
      input: { note: "She said yes on the phone." },
    });
    expect(r.view.item.state).toBe("confirmed");
    expect(r.view.item.payload).toMatchObject(later);
    expect((r.view.item.payload as { proposed?: unknown }).proposed).toBeUndefined();
    // How they agreed is the business's own record: never sent to the customer as its words.
    const [entry] = await db.orm
      .select({ direction: threadEntries.direction })
      .from(threadEntries)
      .where(eq(threadEntries.bodyText, "She said yes on the phone."));
    expect(entry?.direction).toBe("note");
    const claims = await db.orm.select().from(slotClaims).where(eq(slotClaims.itemId, id));
    expect(Math.min(...claims.map((c) => c.bucketStart))).toBe(Date.parse(later.startTime));
  });

  it("confirms from waiting on details, and a customer's details put it back with the business", async () => {
    clock.now = T0;
    const { db, svc1 } = await setup();
    const created = await createItem(db, form(), booking(svc1));
    const id = created.view.item.id;
    await transitionItem(db, owner, { itemId: id, event: "request_info", input: { note: "Which bike?" } });
    expect((await transitionItem(db, owner, { itemId: id, event: "confirm" })).view.item.state).toBe("confirmed");
    const again = await createItem(db, form(), booking(svc1, "2026-09-24T14:00:00Z", "2026-09-24T15:30:00Z"));
    await transitionItem(db, owner, { itemId: again.view.item.id, event: "request_info" });
    const answered = await transitionItem(db, form(undefined, again.accessToken), {
      itemId: again.view.item.id,
      event: "provide_info",
      input: { note: "x".repeat(5_000) },
    });
    expect(answered.view.item.state).toBe("requested");
  });

  it("never books or proposes a time that has started, whoever asks", async () => {
    clock.now = T0;
    const { db, svc1 } = await setup();
    const created = await createItem(db, form(), booking(svc1));
    const id = created.view.item.id;
    const past = await fail(
      transitionItem(db, owner, {
        itemId: id,
        event: "propose",
        input: { startTime: "2026-09-21T09:00:00Z", endTime: "2026-09-21T10:30:00Z" },
      }),
    );
    expect(past.code).toBe("guard_failed");
    expect(past.details).toMatchObject({ guard: "not_too_soon" });
    clock.now = Date.parse("2026-09-23T14:30:00Z");
    expect((await fail(transitionItem(db, owner, { itemId: id, event: "confirm" }))).details).toMatchObject({
      guard: "not_too_soon",
    });
  });

  it("records a customer's own cancellation as theirs, judged when they asked, and never by a rule", async () => {
    clock.now = T0;
    const { db, svc1 } = await setup();
    const caps = new Capabilities(db);
    const early = await createItem(db, form(), booking(svc1));
    expect(
      (
        await fail(
          transitionItem(db, rule, { itemId: early.view.item.id, event: "record_cancel", input: { note: "x" } }),
        )
      ).code,
    ).toBe("not_allowed");
    expect(
      (await fail(transitionItem(db, owner, { itemId: early.view.item.id, event: "record_cancel", input: {} }))).code,
    ).toBe("invalid_input");
    const before = await transitionItem(db, ownerAi, {
      itemId: early.view.item.id,
      event: "record_cancel",
      input: { note: "Rang to say she found another shop." },
    });
    expect(before.view.item.state).toBe("cancelled_by_customer");
    const [note] = await db.orm
      .select({ direction: threadEntries.direction })
      .from(threadEntries)
      .where(eq(threadEntries.bodyText, "Rang to say she found another shop."));
    expect(note?.direction).toBe("note");

    // Confirmed, then the customer rings two days before: inside the window, their neutral cancel.
    const kept = await createItem(db, form(), booking(svc1, "2026-09-25T14:00:00Z", "2026-09-25T15:30:00Z"));
    await transitionItem(db, owner, { itemId: kept.view.item.id, event: "confirm" });
    const r1 = await caps.transitionItem(owner, {
      item_id: kept.view.item.id,
      event: "record_cancel",
      input: { note: "Called: cannot make it." },
    });
    expect(r1.view.item.state).toBe("cancelled_by_customer");
    // Confirmed, and they ring an hour before: late, where the owner records late cancellations.
    const late = await createItem(db, form(), booking(svc1, "2026-09-21T15:00:00Z", "2026-09-21T16:30:00Z"));
    await transitionItem(db, owner, { itemId: late.view.item.id, event: "confirm" });
    clock.now = Date.parse("2026-09-21T14:00:00Z");
    const r2 = await caps.transitionItem(owner, {
      item_id: late.view.item.id,
      event: "record_cancel",
      input: { note: "Called an hour before." },
    });
    expect(r2.view.item.state).toBe("cancelled_by_customer");
    const outcomes = (await jobsOf(db, "issue_receipt")).filter((j) => j.kind === "outcome").map((j) => j.outcome);
    expect(outcomes.sort()).toEqual(["booking.cancelled_by_customer", "booking.cancelled_late_by_customer"]);
    expect(outcomes).not.toContain("booking.cancelled_by_business");
    // When the customer asked, not when it was typed, decides it: they asked in time.
    clock.now = T0;
    const typedLate = await createItem(db, form(), booking(svc1, "2026-09-23T09:00:00Z", "2026-09-23T10:30:00Z"));
    await transitionItem(db, owner, { itemId: typedLate.view.item.id, event: "confirm" });
    clock.now = Date.parse("2026-09-23T08:00:00Z");
    const r3 = await caps.transitionItem(owner, {
      item_id: typedLate.view.item.id,
      event: "record_cancel",
      input: { note: "Emailed two days ago.", askedAt: "2026-09-21T12:00:00Z" },
    });
    const events = await db.orm
      .select({ event: itemEvents.event })
      .from(itemEvents)
      .where(eq(itemEvents.itemId, r3.view.item.id));
    expect(events.map((e) => e.event)).toEqual(["create", "confirm", "record_cancel"]);
  });

  it("records an accepted order's cancellation the customer asked for as theirs", async () => {
    clock.now = T0;
    const { db } = await setup();
    const o = await createItem(db, form(), {
      type: "order",
      payload: {
        orderedItem: [{ name: "Custom saddle", quantity: 1, price: { value: 9000, currency: "EUR" } }],
        totalPrice: { value: 9000, currency: "EUR" },
      },
    });
    await transitionItem(db, owner, { itemId: o.view.item.id, event: "accept" });
    const r = await transitionItem(db, owner, {
      itemId: o.view.item.id,
      event: "record_cancel",
      input: { note: "Changed her mind by phone." },
    });
    expect(r.view.item.state).toBe("cancelled");
    const outcome = (await jobsOf(db, "issue_receipt")).find((j) => j.kind === "outcome");
    expect(outcome?.outcome).toBe("order.cancelled_by_customer");
  });
});

describe("an accepted quote is the promise (ADR-018 §3.3)", () => {
  async function quoted(db: Db, svc: string, input: Record<string, unknown>, requestedFor?: string) {
    const q = await createItem(db, form(), {
      type: "quote_request",
      payload: {
        itemOffered: { name: "Full service, custom", serviceId: svc },
        description: "With a new chain",
        ...(requestedFor ? { requestedFor } : {}),
      },
    });
    await transitionItem(db, owner, { itemId: q.view.item.id, event: "quote", input });
    return q;
  }

  it("refuses a quote whose lines do not add up, or that books without a time", async () => {
    clock.now = T0;
    const { db, svc1 } = await setup();
    const q = await createItem(db, form(), {
      type: "quote_request",
      payload: { itemOffered: { name: "Full service, custom", serviceId: svc1 }, description: "x" },
    });
    const sum = await fail(
      transitionItem(db, owner, {
        itemId: q.view.item.id,
        event: "quote",
        input: {
          totalPrice: { value: 10000, currency: "EUR" },
          validThrough: "2026-09-30T00:00:00Z",
          lines: [{ name: "Chain", quantity: 2, price: { value: 3000, currency: "EUR" } }],
        },
      }),
    );
    expect(sum.code).toBe("invalid_input");
    expect(sum.fields?.map((f) => f.path)).toEqual(["input.totalPrice.value"]);
    const noTime = await fail(
      transitionItem(db, owner, {
        itemId: q.view.item.id,
        event: "quote",
        input: {
          totalPrice: { value: 10000, currency: "EUR" },
          validThrough: "2026-09-30T00:00:00Z",
          creates: "booking",
        },
      }),
    );
    expect(noTime.fields?.map((f) => f.path)).toEqual(["input.startTime"]);
    const noService = await createItem(db, form(), {
      type: "quote_request",
      payload: { itemOffered: { name: "Something" }, description: "x" },
    });
    const refused = await fail(
      transitionItem(db, owner, {
        itemId: noService.view.item.id,
        event: "quote",
        input: {
          totalPrice: { value: 10000, currency: "EUR" },
          validThrough: "2026-09-30T00:00:00Z",
          creates: "booking",
          startTime: "2026-09-24T10:00:00Z",
        },
      }),
    );
    expect(refused.fields?.map((f) => f.path)).toEqual(["input.creates"]);
  });

  it("creates the booking confirmed, its places claimed and its receipt queued, in the accept's batch", async () => {
    clock.now = T0;
    const { db, svc1 } = await setup();
    const q = await quoted(db, svc1, {
      totalPrice: { value: 12000, currency: "EUR" },
      validThrough: "2026-09-30T00:00:00Z",
      creates: "booking",
      startTime: "2026-09-24T10:00:00Z",
    });
    const r = await transitionItem(db, form(undefined, q.accessToken), { itemId: q.view.item.id, event: "accept" });
    const linked = r.linked?.item;
    expect(linked).toMatchObject({
      type: "booking",
      state: "confirmed",
      payload: {
        startTime: "2026-09-24T10:00:00.000Z",
        endTime: "2026-09-24T11:30:00.000Z",
        totalPrice: { value: 12000, currency: "EUR" },
      },
    });
    const id = linked?.id as string;
    expect(await db.orm.select().from(slotClaims).where(eq(slotClaims.itemId, id))).toHaveLength(6);
    const receipts = (await jobsOf(db, "issue_receipt")).filter((j) => j.itemId === id);
    expect(receipts).toEqual([expect.objectContaining({ kind: "confirmed", dedupe: `receipt:${id}:confirmed` })]);
    const notify = await jobsOf(db, "notify");
    // The customer's one email is the acceptance's; the booking it became tells the owner only.
    expect(notify.filter((n) => n.itemId === id).map((n) => n.to)).toEqual(["owner"]);
    expect(
      notify
        .filter((n) => n.itemId === q.view.item.id && n.event === "accept")
        .map((n) => n.to)
        .sort(),
    ).toEqual(["customer", "owner"]);
  });

  it("refuses a quote past its validity, and a booking quote whose time was taken meanwhile", async () => {
    clock.now = T0;
    const { db, svc1 } = await setup();
    const q = await quoted(db, svc1, {
      totalPrice: { value: 12000, currency: "EUR" },
      validThrough: "2026-09-22T00:00:00Z",
      creates: "booking",
      startTime: "2026-09-24T10:00:00Z",
    });
    const taken = await createItem(db, form(), booking(svc1, "2026-09-24T10:30:00Z", "2026-09-24T12:00:00Z"));
    await transitionItem(db, owner, { itemId: taken.view.item.id, event: "confirm" });
    const slot = await fail(
      transitionItem(db, form(undefined, q.accessToken), { itemId: q.view.item.id, event: "accept" }),
    );
    expect(slot.code).toBe("slot_taken");
    clock.now = Date.parse("2026-09-22T01:00:00Z");
    const expired = await fail(
      transitionItem(db, form(undefined, q.accessToken), { itemId: q.view.item.id, event: "accept" }),
    );
    expect(expired.code).toBe("offer_expired");
    expect(expired.status).toBe(410);
  });

  it("makes an order of a quote with no lines at the quoted total, never quantity times it", async () => {
    clock.now = T0;
    const { db } = await setup();
    const q = await createItem(db, form(), {
      type: "quote_request",
      payload: { itemOffered: { name: "Chainring" }, quantity: 3, description: "3 of them" },
    });
    await transitionItem(db, owner, {
      itemId: q.view.item.id,
      event: "quote",
      input: { totalPrice: { value: 9000, currency: "EUR" }, validThrough: "2026-09-30T00:00:00Z" },
    });
    const r = await transitionItem(db, form(undefined, q.accessToken), { itemId: q.view.item.id, event: "accept" });
    expect(r.linked?.item).toMatchObject({
      type: "order",
      state: "accepted",
      payload: {
        orderedItem: [{ name: "3 × Chainring", quantity: 1, price: { value: 9000, currency: "EUR" } }],
        totalPrice: { value: 9000, currency: "EUR" },
      },
    });
    const lines = (r.linked?.item.payload ?? {}) as { orderedItem?: { productId?: string }[] };
    expect(lines.orderedItem?.[0]?.productId).toBeUndefined();
  });

  it("lets one of two racing acceptances through: one event, one set of places", async () => {
    clock.now = T0;
    const { db, svc1 } = await setup();
    const q = await quoted(db, svc1, {
      totalPrice: { value: 12000, currency: "EUR" },
      validThrough: "2026-09-30T00:00:00Z",
      creates: "booking",
      startTime: "2026-09-24T10:00:00Z",
    });
    const results = await Promise.allSettled([
      transitionItem(db, form(undefined, q.accessToken), { itemId: q.view.item.id, event: "accept" }),
      transitionItem(db, form(undefined, q.accessToken), { itemId: q.view.item.id, event: "accept" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const accepts = await db.orm
      .select()
      .from(itemEvents)
      .where(and(eq(itemEvents.itemId, q.view.item.id), eq(itemEvents.event, "accept")));
    expect(accepts).toHaveLength(1);
    expect(new Set((await db.orm.select().from(slotClaims)).map((c) => c.itemId)).size).toBe(1);
    expect((await db.orm.select().from(items).where(eq(items.type, "booking"))).length).toBe(1);
  });
});
