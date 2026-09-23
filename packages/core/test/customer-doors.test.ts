import { runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, itemEvents, items, jobs, services, slotClaims, threadEntries } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { type Caller, setFlags, transitionItem, WriteError } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * The customer's answers to what the business proposed (ADR-018 §5, §6), through the assistant's
 * door: accept (with the confirm step), decline, another time, the details asked for; and the status
 * door that shows the offer, who it waits on and what comes next. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z"); // a Monday
const MIN = 60_000;
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
    languages: ["pt", "en"],
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
  return { db, caps: new Capabilities(db, createSecretBox(["customer-doors-test-secret-0123456789"])), svc };
}

/** A booking an anonymous customer asked for, to which the owner proposed another time. */
async function proposed(s: { caps: Capabilities; db: Db; svc: string }, locale?: string) {
  const created = await s.caps.createBooking(anon(), {
    payload: {
      reservationFor: { serviceId: s.svc, name: "Full service" },
      startTime: "2026-09-23T09:00:00Z",
      endTime: "2026-09-23T10:30:00Z",
    },
    contact: { name: "Rita", email: "rita@example.com", ...(locale ? { locale } : {}) },
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

const versionOf = async (db: Db, id: string) =>
  (await db.orm.select({ v: items.version }).from(items).where(eq(items.id, id)))[0]?.v;

describe("the status door", () => {
  it("shows what we proposed, who it waits on, what comes next and a short reference; never our flags or the id", async () => {
    const s = await setup();
    const { id, token } = await proposed(s);
    const v = await s.caps.getItemStatus(anon(token), { item_id: id });
    expect(v.reference).toBe(id.slice(-6).toUpperCase());
    expect(v.waiting_on).toBe("you");
    expect(v.next?.map((n) => n.action)).toEqual(["accept_offer", "decline_offer", "suggest_time"]);
    expect(v.offer).toMatchObject({
      kind: "time",
      terms: { startTime: "2026-09-23T13:00:00Z", endTime: "2026-09-23T14:30:00Z", totalPrice: { value: 4500 } },
      // The minimum notice (an hour by default) before the time is the last moment to answer.
      deadline: "2026-09-23T12:00:00.000Z",
      obligation_to_pay: true,
    });
    expect(v.offer?.terms_sha).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect("flags" in v.item).toBe(false);
    // The business speaks Portuguese first, the customer gave no language of their own.
    expect(v.human).toContain("Sugerimos outra hora");
    expect(v.human).toContain("hora");
    expect(v.human).not.toMatch(/[0-9A-HJKMNP-TV-Z]{26}/);
    expect(v.offer?.human).toContain("Aceitar implica a obrigação de pagar");
    expect(v.transitions.map((t) => t.label)).toEqual(["Aceitar", "Escolher outra hora", "Recusar"]);
  });

  it("speaks the customer's own language when they gave one", async () => {
    const s = await setup();
    const { id, token } = await proposed(s, "en-GB");
    const v = await s.caps.getItemStatus(anon(token), { item_id: id });
    expect(v.human).toMatch(/^We suggest another time for your booking "Full service": .*\(.+\)\. Price: €45\.00\./);
    expect(v.human).toContain("Please answer by");
    expect(v.human).toContain("accept it, decline it or pick another time");
  });

  it("shows a spam message as closed", async () => {
    const s = await setup();
    const m = await s.caps.sendMessage(anon(), { body: "Cheap watches", contact: { email: "x@example.com" } });
    const mid = (m as { view: { item: { id: string } }; accessToken: string }).view.item.id;
    await transitionItem(s.db, owner, { itemId: mid, event: "mark_spam" });
    const v = await s.caps.getItemStatus(anon((m as { accessToken: string }).accessToken), { item_id: mid });
    expect(v.item.state).toBe("closed");
    expect(v.waiting_on).toBeNull();
  });
});

describe("none of the business's flags, through any door (Tiago, 23 September 2026)", () => {
  /** The business's own marks on an item: priority, a person needed, a test item. */
  const OURS = /"(flags|needsHuman|priority|sandbox)"/;

  it("answers a create, a message, a cancellation and an answer without them; the owner still sees them", async () => {
    const s = await setup();
    const created = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: "2026-09-24T09:00:00Z",
        endTime: "2026-09-24T10:30:00Z",
      },
      contact: { email: "rita@example.com" },
    });
    expect(JSON.stringify(created)).not.toMatch(OURS);
    const id = created.view.item.id;
    const token = created.accessToken as string;
    await setFlags(s.db, owner, { itemId: id, flags: { needsHuman: true, priority: 2 } });
    const message = await s.caps.sendMessage(anon(token), { item_id: id, body: "Can I bring my own tyres?" });
    expect(JSON.stringify(message)).not.toMatch(OURS);
    const status = await s.caps.getItemStatus(anon(token), { item_id: id });
    expect(JSON.stringify(status.item)).not.toMatch(OURS);
    const cancelled = await s.caps.cancelItem(anon(token), { item_id: id, reason: "Plans changed" });
    expect(JSON.stringify(cancelled)).not.toMatch(OURS);
    // A time we proposed, accepted: the answer and the booking it is, without them.
    const p = await proposed(s, "en");
    const offer = await s.caps.getItemStatus(anon(p.token), { item_id: p.id });
    const accepted = await s.caps.customer.acceptOffer(anon(p.token), {
      item_id: p.id,
      terms_sha: offer.offer?.terms_sha as string,
    });
    expect(JSON.stringify(accepted)).not.toMatch(OURS);
    // The business reads its own marks as ever.
    const detail = await s.caps.getItem(owner, { item_id: id });
    expect(detail.item.flags).toMatchObject({ needsHuman: true, priority: 2 });
  });
});

describe("accept_offer", () => {
  it("writes nothing without the fingerprint of the terms, and says what to confirm", async () => {
    const s = await setup();
    const { id, token } = await proposed(s, "en");
    const before = await versionOf(s.db, id);
    const e = await fail(s.caps.customer.acceptOffer(anon(token), { item_id: id }));
    expect(e.code).toBe("confirm_terms");
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/^Before this binds your customer, show them: We suggest another time/);
    expect(e.message).toContain("Accepting means an obligation to pay €45.00.");
    expect(e.details).toMatchObject({ obligation_to_pay: true });
    expect(await versionOf(s.db, id)).toBe(before);
  });

  it("refuses another fingerprint with the current terms", async () => {
    const s = await setup();
    const { id, token } = await proposed(s, "en");
    const e = await fail(s.caps.customer.acceptOffer(anon(token), { item_id: id, terms_sha: "A".repeat(43) }));
    expect(e.code).toBe("offer_changed");
    expect((e.details as { offer: { terms_sha: string } }).offer.terms_sha).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(e.message).toMatch(/^We changed what we proposed since you read it\. The current proposal: /);
  });

  it("books the proposed time on the customer's yes, with its claims and receipt, and says so in their view", async () => {
    const s = await setup();
    const { id, token } = await proposed(s, "en");
    const status = await s.caps.getItemStatus(anon(token), { item_id: id });
    const r = await s.caps.customer.acceptOffer(anon(token, "acc-1"), {
      item_id: id,
      terms_sha: status.offer?.terms_sha as string,
    });
    expect(r.view.item.state).toBe("confirmed");
    expect(r.view.item.payload).toMatchObject({ startTime: "2026-09-23T13:00:00Z", endTime: "2026-09-23T14:30:00Z" });
    expect((r.view.item.payload as { proposed?: unknown }).proposed).toBeUndefined();
    expect(r.view.offer).toBeNull();
    expect(r.view.waiting_on).toBe("us");
    expect("flags" in r.view.item).toBe(false);
    expect(await s.db.orm.select().from(slotClaims).where(eq(slotClaims.itemId, id))).toHaveLength(3);
    const queued = await s.db.orm.select({ kind: jobs.kind, payload: jobs.payload }).from(jobs);
    expect(queued.filter((j) => j.kind === "issue_receipt")).toHaveLength(1);
    // Both sides hear of it: the owner, and the customer's confirmation.
    const notifies = queued.filter((j) => j.kind === "notify").map((j) => j.payload as { to: string; event: string });
    expect(notifies).toEqual(
      expect.arrayContaining([
        { to: "owner", itemId: id, event: "accept", eventId: expect.any(String) },
        { to: "customer", itemId: id, event: "accept", eventId: expect.any(String) },
      ]),
    );
    // The same request again is the same answer, however the item stands now.
    const again = await s.caps.customer.acceptOffer(anon(token, "acc-1"), {
      item_id: id,
      terms_sha: status.offer?.terms_sha as string,
    });
    expect(again.replayed).toBe(true);
    expect(again.view.item.state).toBe("confirmed");
    // A new request on a booked item finds nothing to accept.
    expect((await fail(s.caps.customer.acceptOffer(anon(token), { item_id: id }))).code).toBe("no_offer");
  });

  it("is refused to a stranger, and allowed to a caller the item recognises as its customer", async () => {
    const s = await setup();
    const { id, token } = await proposed(s, "en");
    expect((await fail(s.caps.customer.acceptOffer(anon(), { item_id: id }))).code).toBe("not_allowed");
    const [row] = await s.db.orm.select({ partyId: items.partyId }).from(items).where(eq(items.id, id));
    const status = await s.caps.getItemStatus(anon(token), { item_id: id });
    // What a pass the item recognises gives the caller: its party.
    const recognised: Caller = { ...anon(), actor: { ...anon().actor, partyId: row?.partyId as string } };
    const r = await s.caps.customer.acceptOffer(recognised, { item_id: id, terms_sha: status.offer?.terms_sha });
    expect(r.view.item.state).toBe("confirmed");
  });

  it("tells a customer whose time was taken meanwhile, in their words", async () => {
    const s = await setup();
    const { id, token } = await proposed(s, "en");
    const other = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: "2026-09-23T13:30:00Z",
        endTime: "2026-09-23T15:00:00Z",
      },
    });
    await transitionItem(s.db, owner, { itemId: other.view.item.id, event: "confirm" });
    const status = await s.caps.getItemStatus(anon(token), { item_id: id });
    const e = await fail(s.caps.customer.acceptOffer(anon(token), { item_id: id, terms_sha: status.offer?.terms_sha }));
    expect(e.code).toBe("slot_taken");
    expect(e.message).toBe("That time is no longer free.");
  });

  it("refuses a time that has started, for everyone", async () => {
    const s = await setup();
    const { id, token } = await proposed(s, "en");
    const status = await s.caps.getItemStatus(anon(token), { item_id: id });
    clock.now = Date.parse("2026-09-23T13:05:00Z");
    const e = await fail(s.caps.customer.acceptOffer(anon(token), { item_id: id, terms_sha: status.offer?.terms_sha }));
    expect(e.code).toBe("guard_failed");
    expect(e.details).toMatchObject({ guard: "not_too_soon" });
    expect(e.message).toBe("It is too close to that time to book it now.");
  });

  it("accepts a quote with the confirm step, and refuses one past its validity", async () => {
    const s = await setup();
    const q = await s.caps.requestQuote(anon(), {
      payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel, 28 spokes" },
      contact: { email: "rita@example.com", locale: "en" },
    });
    const qid = q.view.item.id;
    const token = q.accessToken as string;
    await transitionItem(s.db, owner, {
      itemId: qid,
      event: "quote",
      input: {
        totalPrice: { value: 31000, currency: "EUR" },
        validThrough: "2026-09-28T18:00:00Z",
        lines: [
          { name: "Rim", quantity: 1, price: { value: 9500, currency: "EUR" } },
          { name: "Spokes", quantity: 28, price: { value: 250, currency: "EUR" } },
          { name: "Build", quantity: 1, price: { value: 14500, currency: "EUR" } },
        ],
      },
    });
    const status = await s.caps.getItemStatus(anon(token), { item_id: qid });
    expect(status.offer).toMatchObject({ kind: "quote", deadline: "2026-09-28T18:00:00Z", obligation_to_pay: true });
    expect(status.human).toMatch(
      /^Our quote for "Wheel rebuild": €310\.00, valid until .*\. Accept it or decline it\./,
    );
    const e = await fail(s.caps.customer.acceptOffer(anon(token), { item_id: qid }));
    expect(e.code).toBe("confirm_terms");

    clock.now = Date.parse("2026-09-29T09:00:00Z");
    const late = await fail(
      s.caps.customer.acceptOffer(anon(token), { item_id: qid, terms_sha: status.offer?.terms_sha }),
    );
    expect(late.code).toBe("offer_expired");
    expect(late.status).toBe(410);

    clock.now = T0 + 60 * MIN;
    const r = await s.caps.customer.acceptOffer(anon(token), { item_id: qid, terms_sha: status.offer?.terms_sha });
    expect(r.view.item.state).toBe("accepted");
    expect(r.linked?.item).toMatchObject({ type: "order", state: "accepted" });
    expect(r.linked?.human).toMatch(/^Your order .* is accepted\./);
  });
});

describe("decline_offer", () => {
  it("closes a booking request whose proposed time the customer declines, as their own choice", async () => {
    const s = await setup();
    const { id, token } = await proposed(s, "en");
    const r = await s.caps.customer.declineOffer(anon(token), { item_id: id, reason: "Mornings only, sorry." });
    expect(r.view.item.state).toBe("cancelled_by_customer");
    expect(r.view.human).toContain("is cancelled, as you asked");
    const [entry] = await s.db.orm
      .select({ body: threadEntries.bodyText, direction: threadEntries.direction })
      .from(threadEntries)
      .where(eq(threadEntries.itemId, id))
      .orderBy(threadEntries.createdAt);
    expect(entry).toBeDefined();
    expect((await fail(s.caps.customer.declineOffer(anon(token), { item_id: id }))).code).toBe("no_offer");
  });

  it("declines a quote", async () => {
    const s = await setup();
    const q = await s.caps.requestQuote(anon(), {
      payload: { itemOffered: { name: "Paint job" }, description: "Matte green" },
    });
    await transitionItem(s.db, owner, {
      itemId: q.view.item.id,
      event: "quote",
      input: { totalPrice: { value: 20000, currency: "EUR" }, validThrough: "2026-10-01T00:00:00Z" },
    });
    const r = await s.caps.customer.declineOffer(anon(q.accessToken), { item_id: q.view.item.id });
    expect(r.view.item.state).toBe("declined");
    expect(r.view.human).toMatch(/is closed, as you asked|foi fechado, como pediu/);
  });
});

describe("suggest_time", () => {
  it("takes a free time we would offer, with the service's length, and nothing proposed left", async () => {
    const s = await setup();
    const { id, token } = await proposed(s, "en");
    const r = await s.caps.customer.suggestTime(anon(token), {
      item_id: id,
      start_time: "2026-09-24T10:00:00Z",
      note: "Thursday suits me better.",
    });
    expect(r.view.item.state).toBe("requested");
    expect(r.view.item.payload).toMatchObject({
      startTime: "2026-09-24T10:00:00.000Z",
      endTime: "2026-09-24T11:30:00.000Z",
      totalPrice: { value: 4500, currency: "EUR" },
    });
    expect((r.view.item.payload as { proposed?: unknown }).proposed).toBeUndefined();
    expect(r.view.waiting_on).toBe("us");
    expect(await s.db.orm.select().from(slotClaims).where(eq(slotClaims.itemId, id))).toHaveLength(0);
    const events = await s.db.orm.select({ event: itemEvents.event }).from(itemEvents).where(eq(itemEvents.itemId, id));
    expect(events.map((e) => e.event)).toEqual(["create", "propose", "counter"]);
  });

  it("refuses a time that is closed or taken, naming it as not free", async () => {
    const s = await setup();
    const { id, token } = await proposed(s, "en");
    // Saturday: closed on the default hours.
    const closed = await fail(
      s.caps.customer.suggestTime(anon(token), { item_id: id, start_time: "2026-09-26T10:00:00Z" }),
    );
    expect(closed.code).toBe("slot_taken");
    expect(closed.message).toMatch(/is not free\. Pick one of the free times\.$/);
    const other = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: "2026-09-24T10:00:00Z",
        endTime: "2026-09-24T11:30:00Z",
      },
    });
    await transitionItem(s.db, owner, { itemId: other.view.item.id, event: "confirm" });
    const taken = await fail(
      s.caps.customer.suggestTime(anon(token), { item_id: id, start_time: "2026-09-24T10:30:00Z" }),
    );
    expect(taken.code).toBe("slot_taken");
    // A time not proposed any more has nothing to answer.
    const confirmed = await fail(
      s.caps.customer.suggestTime(anon(other.accessToken), {
        item_id: other.view.item.id,
        start_time: "2026-09-24T14:00:00Z",
      }),
    );
    expect(confirmed.code).toBe("no_offer");
  });
});

describe("provide_details", () => {
  it("moves an item waiting on the customer's details on, and keeps them as their message elsewhere", async () => {
    const s = await setup();
    const created = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: "2026-09-23T09:00:00Z",
        endTime: "2026-09-23T10:30:00Z",
      },
      contact: { locale: "en" },
    });
    const id = created.view.item.id;
    const token = created.accessToken as string;
    await transitionItem(s.db, owner, { itemId: id, event: "request_info", input: { note: "Which bike is it?" } });
    const status = await s.caps.getItemStatus(anon(token), { item_id: id });
    expect(status.human).toContain("needs a detail from you: Which bike is it?");
    expect(status.next?.[0]?.action).toBe("provide_details");
    const r = await s.caps.customer.provideDetails(anon(token), { item_id: id, details: "A 2019 Brompton." });
    expect("appended" in r).toBe(false);
    expect(r.view.item.state).toBe("requested");
    const thread = await s.db.orm
      .select({ body: threadEntries.bodyText, direction: threadEntries.direction })
      .from(threadEntries)
      .where(eq(threadEntries.itemId, id));
    expect(thread).toContainEqual({ body: "A 2019 Brompton.", direction: "in" });

    const more = await s.caps.customer.provideDetails(anon(token), { item_id: id, details: "It has a dynamo." });
    expect("appended" in more && more.waiting_on).toBe("us");
    expect(more.view.item.state).toBe("requested");
  });

  it("answers a question through any door: a message on an item waiting on details moves it on", async () => {
    const s = await setup();
    const created = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: "2026-09-23T09:00:00Z",
        endTime: "2026-09-23T10:30:00Z",
      },
    });
    const id = created.view.item.id;
    await transitionItem(s.db, owner, { itemId: id, event: "request_info", input: { note: "Which bike?" } });
    const r = await s.caps.sendMessage(anon(created.accessToken), {
      item_id: id,
      body: "The blue one.",
      message_id: "<reply-1@mail.example.com>",
    });
    expect((r as { view: { item: { state: string } } }).view.item.state).toBe("requested");
    const [entry] = await s.db.orm
      .select({ messageId: threadEntries.messageId })
      .from(threadEntries)
      .where(eq(threadEntries.bodyText, "The blue one."));
    expect(entry?.messageId).toBe("<reply-1@mail.example.com>");
  });
});
