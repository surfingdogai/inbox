import { runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, itemEvents, items, jobs, services, threadEntries } from "../src/schema/tables";
import { type Caller, transitionItem, WriteError } from "../src/write/index";
import { rowToItem } from "../src/write/views";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * What automation writes to a customer names only money the business offered (ADR-018 §4; DL 7/2004
 * art. 32(1), an online message with every element of a contract is a binding proposal): a reply from
 * the owner's AI, or a key without money:write, that names another amount — a price, a discount, the
 * customer's own price back to them — is kept as a note for a person, never sent; a note with an offer
 * that does makes the offer a draft; with anything else it is refused. The owner in person, and a key
 * with money:write, write what they like. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const EUR = (value: number) => ({ value, currency: "EUR" });
const at = (t: number) => () => t;
const iso = (t: number) => new Date(t).toISOString();
const HOUR = 3_600_000;

const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  principal: { via: "session", id: "s1", name: "owner@example.com", scopes: ["*"], userId: "u1" },
  tier: "verified_principal",
  sandbox: false,
  now: at(T0),
};
const ai: Caller = {
  actor: { kind: "owner_ai", id: "client_1", channel: "mcp_owner" },
  actsAs: "owner",
  principal: { via: "oauth", id: "client_1", name: "Assistant", scopes: ["*"], userId: "u1" },
  tier: "verified_principal",
  sandbox: false,
  now: at(T0),
};
const key = (scopes: string[]): Caller => ({
  actor: { kind: "integration", id: "key_1", channel: "rest" },
  actsAs: "owner",
  tier: "verified_principal",
  sandbox: false,
  now: at(T0),
  principal: { via: "api_key", id: "key_1", name: "CRM", scopes, userId: null, keyKind: "integration" },
});
const customer = (token: string): Caller => ({
  actor: { kind: "customer_agent", id: "anon:agent", channel: "mcp_public" },
  tier: "anonymous",
  sandbox: false,
  accessToken: token,
  now: at(T0),
});

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm
    .insert(business)
    .values({ id: "self", name: "Oficina Maré", timezone: "UTC", currency: "EUR", createdAt: T0, updatedAt: T0 });
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    capacity: 2,
    granularityMin: 30,
    price: { model: "fixed", value: 4_500, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  const caps = confirming(new Capabilities(db));
  let hour = 8;
  const booking = async () => {
    hour++;
    const start = Date.parse(`2026-09-22T${String(hour).padStart(2, "0")}:00:00Z`);
    const b = await caps.createBooking(customer(""), {
      payload: {
        reservationFor: { serviceId: svc, name: "Full service" },
        startTime: iso(start),
        endTime: iso(start + 90 * 60_000),
      },
      contact: { email: "rita@example.com" },
    });
    return { id: b.view.item.id, token: b.accessToken as string, start };
  };
  const itemOf = async (id: string) =>
    rowToItem((await db.orm.select().from(items).where(eq(items.id, id)))[0] as never);
  const entries = (id: string) => db.orm.select().from(threadEntries).where(eq(threadEntries.itemId, id));
  const notices = async (id: string) =>
    (await db.orm.select().from(jobs).where(eq(jobs.kind, "notify")))
      .map((j) => j.payload as { to: string; itemId: string; event: string })
      .filter((p) => p.itemId === id && p.event !== "create");
  return { db, caps, svc, booking, itemOf, entries, notices };
}

async function refusal(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("a reply from the owner's AI", () => {
  it("naming our price, or none, goes to the customer", async () => {
    const s = await setup();
    const b = await s.booking();
    for (const body of ["It is €45.00, as listed.", "See you on Tuesday at 10:00, a table for 2."]) {
      const r = await s.caps.reply(ai, { item_id: b.id, internal: false, body });
      expect("held" in r && r.held).toBeFalsy();
    }
    expect((await s.entries(b.id)).filter((e) => e.direction === "out")).toHaveLength(2);
    expect((await s.notices(b.id)).filter((n) => n.to === "customer")).toHaveLength(2);
  });

  it("naming a price we never offered, or something off one, is kept as a note for a person", async () => {
    const s = await setup();
    const b = await s.booking();
    for (const [i, body] of [
      "Our lowest price is €30.",
      "For you, 40% off.",
      "Your refund of €200 is approved.",
    ].entries()) {
      const r = await s.caps.reply(ai, { item_id: b.id, internal: false, body, idempotency_key: `held-${i}` });
      expect(r).toMatchObject({ held: { breaches: ["amount_named"] } });
    }
    const said = await s.entries(b.id);
    expect(said.filter((e) => e.direction === "out")).toEqual([]);
    expect(said.filter((e) => e.direction === "note").map((e) => e.bodyText)).toContain("Our lowest price is €30.");
    const item = await s.itemOf(b.id);
    expect(item.flags.needsHuman).toBe(true);
    const notices = await s.notices(b.id);
    expect(notices.filter((n) => n.to === "customer")).toEqual([]);
    // The owner hears once an hour for the item, however many are kept.
    expect(notices.filter((n) => n.to === "owner" && n.event === "held_reply")).toHaveLength(1);
    const [held] = await s.db.orm.select().from(itemEvents).where(eq(itemEvents.event, "flags"));
    expect(held?.meta).toMatchObject({ breaches: ["amount_named"] });
  });

  it("is kept once when retried, with the answer it had", async () => {
    const s = await setup();
    const b = await s.booking();
    const first = await s.caps.reply(ai, {
      item_id: b.id,
      internal: false,
      body: "€30 and it's yours.",
      idempotency_key: "k1",
    });
    const again = await s.caps.reply(ai, {
      item_id: b.id,
      internal: false,
      body: "€30 and it's yours.",
      idempotency_key: "k1",
    });
    expect(again).toMatchObject({ held: { breaches: ["amount_named"] } });
    expect("view" in first && "view" in again && again.view.item.version).toBe(
      "view" in first && first.view.item.version,
    );
    expect((await s.entries(b.id)).filter((e) => e.direction === "note")).toHaveLength(1);
  });

  it("never writes the customer's own price back to them: taking it is an acceptance, judged as one", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { negotiation: { priceCounters: true } } });
    const b = await s.booking();
    await s.caps.transitionItem(owner, {
      item_id: b.id,
      event: "propose",
      input: { startTime: iso(b.start + 4 * HOUR), endTime: iso(b.start + 5.5 * HOUR) },
    });
    await s.caps.customer.makeOffer(customer(b.token), { item_id: b.id, terms: { total_price: EUR(4_000) } });
    const r = await s.caps.reply(ai, { item_id: b.id, internal: false, body: "OK, €40 works for us." });
    expect(r).toMatchObject({ held: { breaches: ["amount_named"] } });
    // What we proposed can still be said.
    const ours = await s.caps.reply(ai, { item_id: b.id, internal: false, body: "Our price is €45." });
    expect("held" in ours && ours.held).toBeFalsy();
  });

  it("as an internal note, says what it likes: that is how it tells the owner", async () => {
    const s = await setup();
    const b = await s.booking();
    const r = await s.caps.reply(ai, { item_id: b.id, body: "She asks for €30; I'd give 10% off.", internal: true });
    expect("held" in r && r.held).toBeFalsy();
  });
});

describe("the owner, and the keys of their other systems", () => {
  it("the owner in person, and a key with money:write, write any amount; a key without it is held", async () => {
    const s = await setup();
    const b = await s.booking();
    for (const who of [owner, key(["inbox:write", "money:write"])]) {
      const r = await s.caps.reply(who, { item_id: b.id, internal: false, body: "We can do €40." });
      expect("held" in r && r.held).toBeFalsy();
    }
    const r = await s.caps.reply(key(["inbox:write"]), { item_id: b.id, internal: false, body: "We can do €40." });
    expect(r).toMatchObject({ held: { breaches: ["amount_named"] } });
    // Unless a person at the business typed it into that system, and the key says so.
    const typed = await s.caps.reply(key(["inbox:write"]), {
      item_id: b.id,
      internal: false,
      body: "We can do €40.",
      written_by: "person",
    });
    expect("held" in typed && typed.held).toBeFalsy();
    // The owner's AI cannot say so for itself.
    const claimed = await s.caps.reply(ai, {
      item_id: b.id,
      internal: false,
      body: "We can do €40.",
      written_by: "person",
    });
    expect(claimed).toMatchObject({ held: { breaches: ["amount_named"] } });
  });
});

describe("the note automation sends with a transition", () => {
  it("with an offer, naming money the offer does not hold, makes it a draft", async () => {
    const s = await setup();
    const b = await s.booking();
    const r = await transitionItem(s.db, ai, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(b.start + 2 * HOUR), endTime: iso(b.start + 3.5 * HOUR), note: "€35 if you come then." },
    });
    expect(r.drafted?.breaches).toEqual(["amount_named"]);
    expect((await s.itemOf(b.id)).state).toBe("requested");
    // Its own price may be said.
    const ok = await transitionItem(s.db, ai, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(b.start + 2 * HOUR), endTime: iso(b.start + 3.5 * HOUR), note: "Still €45 then." },
    });
    expect(ok.drafted).toBeUndefined();
    expect(ok.view.item.state).toBe("proposed");
  });

  it("with anything else, is refused for a person, with codes and no number", async () => {
    const s = await setup();
    const b = await s.booking();
    const e = await refusal(
      transitionItem(s.db, ai, {
        itemId: b.id,
        event: "confirm",
        input: { note: "Confirmed, and 20% off next time." },
      }),
    );
    expect(e.code).toBe("outside_limits");
    expect(e.details).toEqual({ breaches: ["amount_named"], draft_for_owner: true });
    expect(e.message).not.toMatch(/\d/);
    const fine = await transitionItem(s.db, ai, { itemId: b.id, event: "confirm", input: { note: "See you then." } });
    expect(fine.view.item.state).toBe("confirmed");
  });
});
