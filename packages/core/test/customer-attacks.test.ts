import { runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, items, jobs, services, threadEntries } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { type Caller, transitionItem, WriteError } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * The customer's doors, attacked: what a hostile assistant, a careless owner's AI or a confused
 * customer could try, each pinned to what must happen instead. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z"); // a Monday
const clock = { now: T0 };
const owner: Caller = {
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock.now,
};
const anon = (accessToken?: string, key?: string): Caller => ({
  actor: { kind: "customer_agent", id: "agent:test", channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => clock.now,
  ...(accessToken ? { accessToken } : {}),
  ...(key ? { idempotency: { scope: "agent:test", key } } : {}),
});

async function setup(): Promise<{ db: Db; caps: Capabilities; svc: string }> {
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
  return { db, caps: new Capabilities(db, createSecretBox(["customer-attacks-test-secret-0123456789"])), svc };
}

async function proposed(s: { caps: Capabilities; db: Db; svc: string }) {
  const created = await s.caps.createBooking(anon(), {
    payload: {
      reservationFor: { serviceId: s.svc, name: "Full service" },
      startTime: "2026-09-23T09:00:00Z",
      endTime: "2026-09-23T10:30:00Z",
    },
    contact: { name: "Rita", email: "rita@example.com", locale: "en" },
  });
  const id = created.view.item.id;
  await transitionItem(s.db, owner, {
    itemId: id,
    event: "propose",
    input: { startTime: "2026-09-23T13:00:00Z", endTime: "2026-09-23T14:30:00Z" },
  });
  return { id, token: created.accessToken as string };
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

const stateOf = async (db: Db, id: string) =>
  (await db.orm.select({ s: items.state }).from(items).where(eq(items.id, id)))[0]?.s;

describe("a yes only a person heard", () => {
  it("is not recorded by an assistant on the owner's MCP, even one holding a full owner key", async () => {
    const s = await setup();
    const { id } = await proposed(s);
    const viaMcp: Caller = {
      actor: { kind: "owner", id: "key_1", channel: "mcp_owner" },
      principal: { via: "api_key", id: "key_1", name: "cli", scopes: ["*"], userId: null, keyKind: "owner" },
      tier: "verified_principal",
      sandbox: false,
      now: () => clock.now,
    };
    const e = await fail(transitionItem(s.db, viaMcp, { itemId: id, event: "confirm" }));
    expect(e.code).toBe("not_allowed");
    expect(await stateOf(s.db, id)).toBe("proposed");
    // The same key from the command line, a person's own tool, may.
    const cli: Caller = { ...viaMcp, actor: { ...viaMcp.actor, channel: "rest" } };
    const r = await transitionItem(s.db, cli, { itemId: id, event: "confirm" });
    expect(r.view.item.state).toBe("confirmed");
  });
});

describe("a message the business put aside as spam", () => {
  it("takes the customer's reply without saying spam, and without our flags", async () => {
    const s = await setup();
    const m = (await s.caps.sendMessage(anon(), {
      body: "Cheap watches",
      contact: { email: "x@example.com" },
    })) as { view: { item: { id: string } }; accessToken: string };
    const mid = m.view.item.id;
    await transitionItem(s.db, owner, { itemId: mid, event: "mark_spam" });
    let text = "";
    try {
      const r = await s.caps.sendMessage(anon(m.accessToken), { item_id: mid, body: "Hello again" });
      text = JSON.stringify(r);
    } catch (e) {
      text = e instanceof Error ? `${e.message} ${JSON.stringify((e as WriteError).details ?? {})}` : String(e);
    }
    expect(text).not.toMatch(/spam/i);
    expect(text).not.toMatch(/needsHuman|priority/);
    let details = "";
    try {
      details = JSON.stringify(
        await s.caps.customer.provideDetails(anon(m.accessToken), { item_id: mid, details: "More" }),
      );
    } catch (e) {
      details = e instanceof Error ? `${e.message} ${JSON.stringify((e as WriteError).details ?? {})}` : String(e);
    }
    expect(details).not.toMatch(/spam/i);
    // It stays where the business put it: both are kept, and nobody is told of either.
    expect(await stateOf(s.db, mid)).toBe("spam");
    const kept = await s.db.orm
      .select({ body: threadEntries.bodyText, direction: threadEntries.direction })
      .from(threadEntries)
      .where(eq(threadEntries.itemId, mid));
    expect(kept.map((k) => k.body)).toEqual(expect.arrayContaining(["Hello again", "More"]));
    const told = (await s.db.orm.select({ kind: jobs.kind, payload: jobs.payload }).from(jobs)).filter(
      (j) => j.kind === "notify" && (j.payload as { event?: string }).event === "message",
    );
    expect(told).toHaveLength(0);
    // The customer reads it exactly as a closed message: its words, its buttons, what comes next.
    const v = await s.caps.getItemStatus(anon(m.accessToken), { item_id: mid });
    expect(v.item.state).toBe("closed");
    expect(v.next?.map((n) => n.action)).toEqual(["send_message"]);
    expect(JSON.stringify(v)).not.toMatch(/spam/i);
  });

  it("answers a customer's reply on any item without the business's flags", async () => {
    const s = await setup();
    const { id, token } = await proposed(s);
    const r = await s.caps.sendMessage(anon(token), { item_id: id, body: "Is there parking?" });
    expect(JSON.stringify(r)).not.toMatch(/needsHuman|priority|"flags"/);
  });
});

describe("a quote a careless owner sends", () => {
  it("is refused when it creates a booking longer than any the business can hold, not when the customer says yes", async () => {
    const s = await setup();
    const q = await s.caps.requestQuote(anon(), {
      payload: { itemOffered: { name: "Wedding weekend", serviceId: s.svc }, description: "Three days" },
      contact: { email: "rita@example.com", locale: "en" },
    });
    const qid = q.view.item.id;
    const e = await fail(
      transitionItem(s.db, owner, {
        itemId: qid,
        event: "quote",
        input: {
          totalPrice: { value: 90000, currency: "EUR" },
          validThrough: "2026-09-28T18:00:00Z",
          creates: "booking",
          startTime: "2026-10-02T09:00:00Z",
          endTime: "2026-10-04T18:00:00Z",
        },
      }),
    );
    expect(e.code).toBe("invalid_input");
    expect(e.fields?.map((f) => f.path)).toEqual(["input.endTime"]);
    expect(await stateOf(s.db, qid)).toBe("received");
  });
});

describe("a time a careless owner proposes", () => {
  it("is refused when no customer could ever accept it: ending before it starts, or longer than a booking can be", async () => {
    const s = await setup();
    const created = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: "2026-09-23T09:00:00Z",
        endTime: "2026-09-23T10:30:00Z",
      },
      contact: { email: "rita@example.com", locale: "en" },
    });
    const id = created.view.item.id;
    const backwards = await fail(
      transitionItem(s.db, owner, {
        itemId: id,
        event: "propose",
        input: { startTime: "2026-09-23T13:00:00Z", endTime: "2026-09-23T12:00:00Z" },
      }),
    );
    expect(backwards.code).toBe("invalid_input");
    expect(backwards.fields?.map((f) => f.path)).toEqual(["input.endTime"]);
    const endless = await fail(
      transitionItem(s.db, owner, {
        itemId: id,
        event: "propose",
        input: { startTime: "2026-09-23T13:00:00Z", endTime: "2026-09-26T13:00:00Z" },
      }),
    );
    expect(endless.code).toBe("invalid_input");
    expect(endless.fields?.map((f) => f.path)).toEqual(["input.endTime"]);
    expect(await stateOf(s.db, id)).toBe("requested");
  });

  it("is refused when that time is already fully booked (ADR-018 N7)", async () => {
    const s = await setup();
    const other = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: "2026-09-23T13:00:00Z",
        endTime: "2026-09-23T14:30:00Z",
      },
    });
    await transitionItem(s.db, owner, { itemId: other.view.item.id, event: "confirm" });
    const created = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: "2026-09-23T09:00:00Z",
        endTime: "2026-09-23T10:30:00Z",
      },
      contact: { email: "rita@example.com", locale: "en" },
    });
    const id = created.view.item.id;
    const e = await fail(
      transitionItem(s.db, owner, {
        itemId: id,
        event: "propose",
        input: { startTime: "2026-09-23T13:30:00Z", endTime: "2026-09-23T15:00:00Z" },
      }),
    );
    expect(e.code).toBe("slot_taken");
    expect(await stateOf(s.db, id)).toBe("requested");
    // A free one goes out.
    const r = await transitionItem(s.db, owner, {
      itemId: id,
      event: "propose",
      input: { startTime: "2026-09-23T15:00:00Z", endTime: "2026-09-23T16:30:00Z" },
    });
    expect(r.view.item.state).toBe("proposed");
  });
});

describe("a time we proposed, then a question instead", () => {
  it("is withdrawn by the question: nothing of it lingers for an assistant to read as booked", async () => {
    const s = await setup();
    const { id, token } = await proposed(s);
    await transitionItem(s.db, owner, { itemId: id, event: "request_info", input: { note: "Which bike?" } });
    const asked = await s.caps.getItemStatus(anon(token), { item_id: id });
    expect(asked.item.state).toBe("needs_info");
    expect((asked.item.payload as { proposed?: unknown }).proposed).toBeUndefined();
    await s.caps.customer.provideDetails(anon(token), { item_id: id, details: "A blue Brompton." });
    const r = await transitionItem(s.db, owner, { itemId: id, event: "confirm" });
    expect(r.view.item.state).toBe("confirmed");
    // Their own time, as asked, and no ghost of ours beside it.
    expect(r.view.item.payload).toMatchObject({ startTime: "2026-09-23T09:00:00Z" });
    expect((r.view.item.payload as { proposed?: unknown }).proposed).toBeUndefined();
  });
});
