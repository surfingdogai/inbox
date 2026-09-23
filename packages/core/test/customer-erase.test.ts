import { logMailOut, runMigrations, type SqlInput } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { networksStopped } from "../src/identity/stops";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { availabilityRules, services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * One customer's data (Tiago, 23 September 2026): the owner exports everything the inbox holds about
 * them, and erases it at their request — their personal data rewritten to a placeholder, the
 * structure kept (types, states, times, amounts, the event sequence, receipts), booking networks
 * stopped for good. Only the owner in person, or a key given customers:erase, may erase; the owner's
 * AI may export. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BASE = "https://inbox.example.com";
/** What Rita gave, and wrote: none of it may be anywhere after the erasure. */
const PERSONAL = [
  "Rita Carvalho",
  "rita.carvalho@example.com",
  "912 345 678",
  "912345678",
  "Rua das Flores",
  "helmet",
  "sister",
];

const owner = (t = T0, extra: Partial<Caller> = {}): Caller => ({
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
  principal: { via: "session", id: "s1", name: "owner", scopes: ["*"], userId: "u1" },
  ...extra,
});
const assistant = (t = T0): Caller => ({
  actor: { kind: "owner_ai", id: "app_1", channel: "mcp_owner" },
  actsAs: "owner",
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
  principal: { via: "oauth", id: "app_1", name: "An assistant", scopes: ["*"], userId: "u1" },
});
const integration = (scopes: string[], t = T0): Caller => ({
  actor: { kind: "integration", id: "key_1", channel: "rest" },
  actsAs: "owner",
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
  principal: { via: "api_key", id: "key_1", name: "CRM", scopes, userId: null, keyKind: "integration" },
});
const customer = (t = T0): Caller => ({
  actor: { kind: "customer_agent", id: `anon:${ulid()}`, channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => t,
});

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Massage",
    durationMin: 60,
    capacity: 3,
    granularityMin: 30,
    price: { model: "fixed", value: 4_500, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  const week = Object.fromEntries(
    ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [["08:00", "20:00"]]]),
  );
  await db.orm.insert(availabilityRules).values({ id: ulid(), kind: "open", weekly: week, createdAt: T0 });
  const caps = new Capabilities(db, createSecretBox(["erase-test-instance-key-0123456789abcdef"]), BASE);
  await caps.updateSettings(owner(), {
    doc: {
      business: { name: "Oficina Maré" },
      notifications: { ownerEmail: "hello@oficinamare.pt", appUrl: BASE },
      email: { fromAddress: "inbox@oficinamare.pt" },
    },
  });
  const mail = logMailOut();
  caps.attachMail(mail);
  const runner = createRunner({ mailOut: mail, secrets: caps.secrets, baseUrl: BASE, receipts: caps.receipts });
  const drain = async (t: number) => {
    for (let i = 0; i < 12; i++) if ((await runner.runDue(db, { now: t, limit: 100 })).claimed === 0) return;
  };
  const contact = { name: "Rita Carvalho", email: "rita.carvalho@example.com", phone: "+351 912 345 678" };
  // A confirmed booking with her notes, the owner's reply and note; a message; an order to her address.
  const booking = await caps.createBooking(customer(), {
    payload: {
      reservationFor: { serviceId: svc, name: "Massage" },
      startTime: new Date(T0 + 3 * DAY).toISOString(),
      endTime: new Date(T0 + 3 * DAY + 60 * MIN).toISOString(),
      notes: "I will bring my own helmet.",
    },
    contact,
  });
  const bookingId = booking.view.item.id;
  await caps.transitionItem(owner(T0 + MIN), {
    item_id: bookingId,
    event: "confirm",
    input: { note: "See you, Rita Carvalho." },
  });
  await caps.reply(owner(T0 + 2 * MIN), { item_id: bookingId, body: "Her sister booked last year.", internal: true });
  const message = await caps.sendMessage(customer(T0 + 3 * MIN), {
    body: "Can my sister come too? I live at Rua das Flores 12.",
    subject: "Question from Rita Carvalho",
    contact,
  });
  const messageId = (message as { view: { item: { id: string } } }).view.item.id;
  const order = await caps.createOrder(customer(T0 + 4 * MIN), {
    payload: {
      orderedItem: [{ name: "Gift card", quantity: 1, price: { value: 3_000, currency: "EUR" } }],
      totalPrice: { value: 3_000, currency: "EUR" },
      shippingAddress: { streetAddress: "Rua das Flores 12", addressLocality: "Lisboa" },
      notes: "Ring twice, my sister is deaf.",
    },
    contact,
  });
  const orderId = order.view.item.id;
  await drain(T0 + 30 * MIN);
  const partyOf = async (id: string) =>
    String((await rows(db, "SELECT party_id FROM items WHERE id = ?", [id]))[0]?.[0]);
  return { db, caps, mail, drain, bookingId, messageId, orderId, partyOf, svc };
}

const rows = async (db: Db, sql: string, params: SqlInput[] = []) =>
  (await db.client.query({ sql, params, method: "all" })).rows.map((r) => [...r]);

/** Every text in every table, as one string per table: what an erasure has to leave no trace in. */
async function everything(db: Db): Promise<Record<string, string>> {
  const tables = (
    await rows(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'search_fts_%'",
    )
  ).map((r) => String(r[0]));
  const out: Record<string, string> = {};
  for (const t of tables) out[t] = JSON.stringify(await rows(db, `SELECT * FROM "${t}"`));
  return out;
}

describe("one customer's data", () => {
  it("exports everything about them, to the owner and the owner's AI, and never a secret", async () => {
    const s = await setup();
    const party = await s.partyOf(s.bookingId);
    const data = await s.caps.customers.export(assistant(), { party_id: party });
    expect(data.customer).toMatchObject({ name: "Rita Carvalho", items: 3, open_items: 3, erased_at: null });
    expect(data.customer.parties).toHaveLength(3);
    expect(data.contacts.map((c) => c.value)).toEqual(
      expect.arrayContaining(["rita.carvalho@example.com", "351912345678"]),
    );
    expect(data.items.map((i) => i.item.type).sort()).toEqual(["booking", "message", "order"]);
    const booking = data.items.find((i) => i.item.id === s.bookingId);
    expect(booking?.events.map((e) => e.event)).toEqual(["create", "confirm"]);
    expect(booking?.thread.map((t) => t.text)).toEqual(
      expect.arrayContaining(["See you, Rita Carvalho.", "Her sister booked last year."]),
    );
    expect(booking?.emails.length).toBeGreaterThan(0);
    expect(booking?.receipts.map((r) => r.kind)).toEqual(["confirmed"]);
    const text = JSON.stringify(data);
    expect(text).toContain("Rua das Flores 12");
    // No access token, key, pass or answer link: an export is for reading.
    expect(text).not.toMatch(/access_token|accessTokenHash|sdkey1_|sdpass1_|\/c\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}/);
    // A customer's door cannot read it.
    await expect(s.caps.customers.export(customer(), { party_id: party })).rejects.toMatchObject({
      code: "not_allowed",
    });
  });

  it("erases only for the owner, or a key given customers:erase, and never for the owner's AI", async () => {
    const s = await setup();
    const party = await s.partyOf(s.bookingId);
    for (const caller of [
      assistant(),
      owner(T0, { actor: { kind: "owner", id: "u1", channel: "mcp_owner" } }),
      integration(["inbox:read", "inbox:write"]),
      integration(["*"]),
    ]) {
      await expect(s.caps.customers.erase(caller, { party_id: party }), caller.actor.kind).rejects.toMatchObject({
        code: "not_allowed",
        details: { reason: "owner_only" },
      });
    }
    // With the scope, the confirm step: nothing is erased, and the answer says what would be.
    const asked = await s.caps.customers.erase(integration(["customers:erase"]), { party_id: party }).catch((e) => e);
    expect(asked).toMatchObject({ code: "confirm_erase", status: 409 });
    expect(asked.details.summary).toMatchObject({ items: 3, open_items: 3 });
    expect(asked.details.confirm).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await rows(s.db, "SELECT COUNT(*) FROM parties WHERE erased_at IS NOT NULL")).toEqual([[0]]);
    // A confirm that is not the one given: nothing either.
    await expect(
      s.caps.customers.erase(owner(), { party_id: party, confirm: "not-the-one-you-were-given" }),
    ).rejects.toMatchObject({ code: "confirm_erase" });
    const done = await s.caps.customers.erase(integration(["customers:erase"]), {
      party_id: party,
      confirm: asked.details.confirm,
    });
    expect(done).toMatchObject({ erased: true, already: false, customer: { name: "Erased customer" } });
  });

  it("rewrites every trace of them and keeps the structure, and asks again when the customer changed", async () => {
    const s = await setup();
    const party = await s.partyOf(s.bookingId);
    const before = {
      items: await rows(
        s.db,
        "SELECT id, type, state, version, created_at, amount_minor, start_at FROM items ORDER BY id",
      ),
      events: await rows(
        s.db,
        "SELECT item_id, seq, event, from_state, to_state, actor_kind, created_at FROM item_events ORDER BY item_id, seq",
      ),
      receipts: await rows(s.db, "SELECT id, kind, sha, jws FROM receipts ORDER BY id"),
      emails: await rows(s.db, "SELECT id, status, template, message_ref FROM outbound_mail ORDER BY id"),
    };
    const asked = await s.caps.customers.erase(owner(), { party_id: party }).catch((e) => e);
    // She writes again before the owner confirms: the confirm no longer covers her, and is refused.
    await s.caps.sendMessage(customer(T0 + 40 * MIN), {
      body: "One more thing about my helmet.",
      contact: { name: "Rita Carvalho", email: "rita.carvalho@example.com" },
    });
    await expect(
      s.caps.customers.erase(owner(), { party_id: party, confirm: asked.details.confirm }),
    ).rejects.toMatchObject({ code: "confirm_erase", details: { summary: { items: 4 } } });
    const again = await s.caps.customers.erase(owner(), { party_id: party }).catch((e) => e);
    const done = await s.caps.customers.erase(owner(T0 + HOUR), { party_id: party, confirm: again.details.confirm });
    expect(done.erased).toBe(true);

    // Not a trace, in any table, the search index included.
    const all = await everything(s.db);
    for (const [table, text] of Object.entries(all)) {
      for (const word of PERSONAL) expect(text.toLowerCase(), `${word} in ${table}`).not.toContain(word.toLowerCase());
    }
    expect(
      (await s.caps.listItems(owner(), { q: "helmet", open_only: false, limit: 50, sandbox: false })).items,
    ).toEqual([]);
    expect(
      (await s.caps.listItems(owner(), { q: "Carvalho", open_only: false, limit: 50, sandbox: false })).items,
    ).toEqual([]);
    // The structure stands: the same items in the same states, times and amounts, the same history, the receipts.
    expect(
      await rows(
        s.db,
        "SELECT id, type, state, version, created_at, amount_minor, start_at FROM items WHERE id IN (?, ?, ?) ORDER BY id",
        [s.bookingId, s.messageId, s.orderId],
      ),
    ).toEqual(before.items);
    expect(
      await rows(
        s.db,
        "SELECT item_id, seq, event, from_state, to_state, actor_kind, created_at FROM item_events WHERE item_id IN (?, ?, ?) ORDER BY item_id, seq",
        [s.bookingId, s.messageId, s.orderId],
      ),
    ).toEqual(before.events);
    expect(await rows(s.db, "SELECT id, kind, sha, jws FROM receipts ORDER BY id")).toEqual(before.receipts);
    const emails = await rows(s.db, "SELECT id, status, template, message_ref FROM outbound_mail ORDER BY id");
    expect(emails.slice(0, before.emails.length)).toEqual(before.emails);
    // What the owner reads now.
    const detail = await s.caps.getItem(owner(), { item_id: s.bookingId });
    expect(detail.party).toMatchObject({ name: "Erased customer" });
    expect(detail.party?.email).toBeUndefined();
    expect(detail.thread.every((t) => t.body === "[erased]")).toBe(true);
    expect(detail.item.payload).not.toHaveProperty("notes");
    expect(detail.customer?.networks_off).toMatchObject({ via: "erased" });
    // Nobody can read the items at the customer's door any more.
    expect(await rows(s.db, "SELECT COUNT(*) FROM items WHERE access_token_hash IS NOT NULL")).toEqual([[0]]);
    // Their address stays stopped for the networks, by its fingerprint only.
    expect(await networksStopped(s.db, { contact: { email: "rita.carvalho@example.com" } })).toBe(true);
    // Erasing again finds nothing to do.
    expect(await s.caps.customers.erase(owner(), { party_id: party })).toMatchObject({ erased: false, already: true });
  });

  it("reaches every record with her email address, and nobody who only shares her phone", async () => {
    const s = await setup();
    // Her husband books with the family's phone and his own address.
    const his = await s.caps.createBooking(customer(T0 + 50 * MIN), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Massage" },
        startTime: new Date(T0 + 4 * DAY).toISOString(),
        endTime: new Date(T0 + 4 * DAY + 60 * MIN).toISOString(),
        notes: "Pedro's back again.",
      },
      contact: { name: "Pedro Carvalho", email: "pedro@example.com", phone: "+351 912 345 678" },
    });
    const party = await s.partyOf(s.bookingId);
    const summary = await s.caps.customers.summary(owner(), { party_id: party });
    expect(summary.items).toBe(3);
    expect(summary.parties).not.toContain(await s.partyOf(his.view.item.id));
    const asked = await s.caps.customers.erase(owner(), { party_id: party }).catch((e) => e);
    await s.caps.customers.erase(owner(), { party_id: party, confirm: asked.details.confirm });
    const detail = await s.caps.getItem(owner(), { item_id: his.view.item.id });
    expect(detail.party).toMatchObject({ name: "Pedro Carvalho", email: "pedro@example.com" });
    expect(detail.item.payload).toMatchObject({ notes: "Pedro's back again." });
    // And the networks keep working for him: only her address is stopped.
    expect(await networksStopped(s.db, { contact: { email: "pedro@example.com", phone: "+351 912 345 678" } })).toBe(
      false,
    );
  });
});

const HOUR = 60 * MIN;
