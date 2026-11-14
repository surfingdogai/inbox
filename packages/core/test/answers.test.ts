import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { type AnswerDay, answerDays } from "../src/answers/index";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, services } from "../src/schema/tables";
import type { Caller } from "../src/write/index";
import { confirming, makeClient, openWeekdays, resetTables } from "./harness";

/**
 * How fast the business answers (ADR-028 Amendment 5): per day, the requests customers and their
 * assistants sent, and how soon each was first answered — counts only.
 */
const T = Date.parse("2026-11-02T10:00:00Z"); // a Monday, ten in the morning in Lisbon
const MIN = 60_000;

const owner = (at: number): Caller => ({
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => at,
});
const agent = (key: string, at: number, sandbox = false): Caller => ({
  actor: { kind: "customer_agent", id: "agent:assistant", channel: "mcp_public" },
  tier: "signed_agent",
  sandbox,
  now: () => at,
  idempotency: { scope: "agent:assistant", key },
});

async function setup(
  opts: { tz?: string; hours?: boolean } = {},
): Promise<{ db: Db; caps: Capabilities; svc: string }> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm.insert(business).values({
    id: "self",
    name: "Oficina Maré",
    domain: "oficinamare.pt",
    timezone: opts.tz ?? "Europe/Lisbon",
    currency: "EUR",
    createdAt: T,
    updatedAt: T,
  });
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Full service",
    durationMin: 60,
    capacity: 1,
    granularityMin: 30,
    price: { model: "fixed", value: 4500, currency: "EUR" },
    createdAt: T,
    updatedAt: T,
  });
  if (opts.hours !== false) await openWeekdays(db);
  return { db, caps: confirming(new Capabilities(db)), svc };
}

async function message(caps: Capabilities, key: string, at: number, body = "Do you fix e-bike batteries?") {
  const r = (await caps.sendMessage(agent(key, at), {
    body,
    // Each its own sender: one sender's many new requests in a day are held by the spam filter.
    contact: { name: "Rita Amaral", email: `rita.${key}@example.com` },
    idempotency_key: key,
  })) as { view: { item: { id: string } } };
  return r.view.item.id;
}

async function quote(caps: Capabilities, key: string, at: number) {
  const r = await caps.requestQuote(agent(key, at), {
    payload: { itemOffered: { name: "Wheel rebuild" }, description: "How much to rebuild a rear wheel?" },
    contact: { name: "Rui Costa", email: "rui@example.net" },
    idempotency_key: key,
  });
  return r.view.item.id;
}

async function oneDay(db: Db, month: string, opts: { since?: number } = {}): Promise<AnswerDay[]> {
  const days = await answerDays(db, { month, ...opts });
  if (!days) throw new Error("no month");
  return days;
}

/** A phone of the owner's that hears new requests, with its quiet hours and its switches. */
async function phone(
  db: Db,
  notify: Record<string, unknown>,
  opts: { revoked?: boolean; push?: string } = {},
): Promise<void> {
  const id = ulid();
  await db.client.query({
    sql: `INSERT INTO phone_devices (id, user_id, name, platform, key_jwk, key_thumbprint, notify, push_state, confirmed_at, created_at, revoked_at)
          VALUES (?, 'user_1', 'Pixel 8', 'android', '{}', ?, ?, ?, ?, ?, ?)`,
    params: [id, id, JSON.stringify(notify), opts.push ?? "on", T, T, opts.revoked ? T : null],
    method: "run",
  });
}

describe("answer times", () => {
  it("counts replies, offers and transitions as answers, and how soon each came", async () => {
    const { db, caps, svc } = await setup();
    // A reply three minutes later.
    const m1 = await message(caps, "m1", T);
    await caps.reply(owner(T + 3 * MIN), { item_id: m1, body: "Yes, most brands. Bring it in.", internal: false });
    // A price, ten minutes after the request.
    const q1 = await quote(caps, "q1", T + MIN);
    await caps.makeOffer(owner(T + 11 * MIN), {
      item_id: q1,
      input: { totalPrice: { value: 8000, currency: "EUR" } },
    });
    // Accept, forty minutes after.
    const b1 = await caps.createBooking(agent("b1", T + 2 * MIN), {
      payload: {
        reservationFor: { serviceId: svc, name: "Full service" },
        startTime: "2026-11-04T10:00:00Z",
        endTime: "2026-11-04T11:00:00Z",
      },
      contact: { name: "Ana Ribeiro", email: "ana@example.org" },
      idempotency_key: "b1",
    });
    await caps.transitionItem(owner(T + 42 * MIN), { item_id: b1.view.item.id, event: "confirm" });
    // A note to self answers nobody.
    const m2 = await message(caps, "m2", T + 3 * MIN, "Can I bring two bikes?");
    await caps.reply(owner(T + 4 * MIN), { item_id: m2, body: "Check the rack first.", internal: true });
    // A question back, two hours later: an answer, though a slow one.
    const q2 = await quote(caps, "q2", T + 4 * MIN);
    await caps.transitionItem(owner(T + 124 * MIN), {
      item_id: q2,
      event: "request_info",
      input: { note: "Which hub is it?" },
    });
    expect(await oneDay(db, "2026-11")).toEqual([
      {
        day: "2026-11-02",
        requests: 5,
        answered: 4,
        by_person: 4,
        by_rule: 0,
        by_other: 0,
        in_hours: 5,
        within_5: 1,
        within_15: 2,
        within_60: 3,
        // 3, 10, 40 and 120 minutes: halfway between 10 and 40.
        median_s: 25 * 60,
      },
    ]);
    // Another month has none of them.
    expect(await oneDay(db, "2026-12")).toEqual([]);
    expect(await answerDays(db, { month: "2026-13" })).toBeNull();
  });

  it("says who answered first: a person, a rule, or the owner's AI", async () => {
    const { db, caps } = await setup();
    const rule: Caller = {
      actor: { kind: "rule", id: "rule_1", channel: "system" },
      tier: "verified_principal",
      sandbox: false,
      now: () => T + MIN,
    };
    const ai: Caller = {
      actor: { kind: "owner_ai", id: "client_assistant", channel: "mcp_owner" },
      tier: "verified_principal",
      sandbox: false,
      now: () => T + 2 * MIN,
    };
    const byRule = await message(caps, "r1", T);
    await caps.transitionItem(rule, { item_id: byRule, event: "answer", input: { note: "We open at nine." } });
    const byAi = await message(caps, "a1", T);
    await caps.reply(ai, { item_id: byAi, body: "Yes, we do.", internal: false });
    const byOwner = await message(caps, "o1", T);
    await caps.reply(owner(T + 5 * MIN), { item_id: byOwner, body: "Yes.", internal: false });
    const [day] = await oneDay(db, "2026-11");
    expect(day).toMatchObject({ requests: 3, answered: 3, by_person: 1, by_rule: 1, by_other: 1 });
  });

  it("leaves out spam, held items, tests, the business's own, and what came before the door opened", async () => {
    const { db, caps } = await setup();
    const counted = await message(caps, "real", T + 2 * 3_600_000);
    await caps.reply(owner(T + 2 * 3_600_000 + MIN), { item_id: counted, body: "Yes.", internal: false });
    // Put in Spam by the owner.
    const spam = await message(caps, "spam", T + 2 * 3_600_000);
    await caps.transitionItem(owner(T + 2 * 3_600_000 + MIN), { item_id: spam, event: "mark_spam" });
    // Held by the spam filter, and one it held that was let in later: neither reached the owner as it came.
    for (const [key, screen] of [
      ["held", "held"],
      ["aside", "aside"],
      ["released", "released"],
      ["pending", "pending"],
    ] as const) {
      const id = await message(caps, key, T + 2 * 3_600_000);
      await db.client.query({ sql: "UPDATE items SET screen = ? WHERE id = ?", params: [screen, id], method: "run" });
    }
    // Our own probe, which is a test.
    await caps.sendMessage(agent("probe", T + 2 * 3_600_000, true), {
      body: "A test message, sent to check this door.",
      idempotency_key: "probe",
    });
    // What the business wrote down itself.
    const own = await message(caps, "own", T + 2 * 3_600_000);
    await db.client.query({ sql: "UPDATE items SET channel = 'owner_ui' WHERE id = ?", params: [own], method: "run" });
    // Before the door opened, an hour after T.
    await message(caps, "early", T);
    const days = await oneDay(db, "2026-11", { since: T + 3_600_000 });
    expect(days).toEqual([expect.objectContaining({ day: "2026-11-02", requests: 1, answered: 1, within_5: 1 })]);
    // Without the opening, the early one counts too.
    expect((await oneDay(db, "2026-11"))[0]).toMatchObject({ requests: 2, answered: 1 });
  });

  it("counts in hours only what came while open, and while some phone would tell the owner", async () => {
    const { db, caps } = await setup();
    // Sunday: closed all day.
    await message(caps, "sunday", Date.parse("2026-11-01T12:00:00Z"));
    // Tuesday: a closed day.
    await db.client.query({
      sql: "INSERT INTO availability_rules (id, service_id, kind, weekly, created_at) VALUES (?, NULL, 'closed', ?, ?)",
      params: [ulid(), JSON.stringify({ from: "2026-11-03", to: "2026-11-03", reason: "Holiday" }), T],
      method: "run",
    });
    await message(caps, "holiday", Date.parse("2026-11-03T10:00:00Z"));
    // Monday at half past five, open: quiet on the only phone that hears messages.
    await phone(db, { quiet: { on: true, from: "17:00", to: "19:00" }, tz: "Europe/Lisbon" });
    await phone(db, { kinds: { message: false }, quiet: { on: false } });
    await phone(db, { quiet: { on: false } }, { revoked: true });
    await phone(db, { quiet: { on: false } }, { push: "off" });
    await message(caps, "quiet", Date.parse("2026-11-02T17:30:00Z"));
    // A request for a price at the same time: the second phone hears those, and is not quiet.
    await quote(caps, "heard", Date.parse("2026-11-02T17:30:00Z"));
    // Monday at ten: open, and nobody is quiet.
    await message(caps, "open", T);
    const days = await oneDay(db, "2026-11");
    expect(days.map((d) => [d.day, d.requests, d.in_hours])).toEqual([
      ["2026-11-01", 1, 0],
      ["2026-11-02", 3, 2],
      ["2026-11-03", 1, 0],
    ]);
  });

  it("with no hours saved, counts every hour as open", async () => {
    const { db, caps } = await setup({ hours: false });
    await message(caps, "sunday", Date.parse("2026-11-01T23:00:00Z"));
    expect(await oneDay(db, "2026-11")).toEqual([expect.objectContaining({ requests: 1, in_hours: 1 })]);
  });

  it("puts a request on the business's own date", async () => {
    const { db, caps } = await setup({ tz: "Asia/Tokyo", hours: false });
    // Friday the 31st at eight in the evening in UTC is Saturday the 1st in Tokyo.
    await message(caps, "tokyo", Date.parse("2026-10-31T20:00:00Z"));
    expect(await oneDay(db, "2026-10")).toEqual([]);
    expect((await oneDay(db, "2026-11")).map((d) => d.day)).toEqual(["2026-11-01"]);
  });

  it("keeps no word, name or address: a day and numbers", async () => {
    const { db, caps } = await setup();
    const id = await message(caps, "words", T, "Do you fix e-bike batteries on Rua Augusta?");
    await caps.reply(owner(T + MIN), { item_id: id, body: "Yes, most brands. Bring it in.", internal: false });
    const days = await oneDay(db, "2026-11");
    const text = JSON.stringify(days);
    for (const word of ["Rita", "Amaral", "example.com", "batteries", "Augusta", "brands", id])
      expect(text).not.toContain(word);
    for (const d of days) {
      expect(Object.keys(d).sort()).toEqual(
        [
          "answered",
          "by_other",
          "by_person",
          "by_rule",
          "day",
          "in_hours",
          "median_s",
          "requests",
          "within_15",
          "within_5",
          "within_60",
        ].sort(),
      );
      for (const [k, v] of Object.entries(d))
        if (k === "day") expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        else expect(v === null || Number.isInteger(v)).toBe(true);
    }
  });
});
