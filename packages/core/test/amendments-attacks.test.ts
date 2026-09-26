import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { linksForEmail } from "../src/customer/links";
import { openOffer } from "../src/customer/offer";
import { createDb } from "../src/db";
import type { Item } from "../src/domain/types";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { ensureLifecycleSweep, LIFECYCLE_SWEEP_KIND, lifecycleSweepHandler } from "../src/jobs/lifecycle";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, items, products, services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { type Caller, createItem, rowToItem, transitionItem, WriteError } from "../src/write/index";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * Attacks on changes to a promise (ADR-018 §3.1, §3.2, Amendment 3), each found by a failing test
 * and kept: money moving after payment was asked for, the owner's AI putting a price back up
 * through a change, a promise pushed past the limits by a date it never had, a change in another
 * currency, and a changed promise reaching a network switched on after it changed.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z"); // a Monday, 11:00 in Lisbon
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BASE = "https://inbox.example";
const NET = "https://network.example.com";
const clock = { now: T0 };
const at = (kind: Caller["actor"]["kind"], channel: Caller["actor"]["channel"]): Caller => ({
  actor: { kind, id: `${kind}_1`, channel },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock.now,
});
const owner = at("owner", "owner_ui");
const ai = at("owner_ai", "mcp_owner");
const connector = at("connector", "rest");
const anon = (accessToken?: string): Caller => ({
  actor: { kind: "customer_agent", id: "agent:test", channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => clock.now,
  ...(accessToken ? { accessToken } : {}),
});
const EUR = (value: number) => ({ value, currency: "EUR" });
const iso = (ms: number) => new Date(ms).toISOString();

/** Thursday 24 September, 12:00 in Lisbon. */
const THU_12 = Date.parse("2026-09-24T11:00:00Z");
/** Friday 25 September, 14:00 in Lisbon. */
const FRI_14 = Date.parse("2026-09-25T13:00:00Z");

async function setup(doc: Record<string, unknown> = {}) {
  clock.now = T0;
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm.insert(business).values({
    id: "self",
    name: "Oficina Maré",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    languages: ["en", "pt"],
    createdAt: T0,
    updatedAt: T0,
  });
  const svc = ulid();
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
  await db.orm.insert(products).values({
    id: ulid(),
    sku: "CH-9",
    name: "Chain",
    price: EUR(1850),
    active: 1,
    createdAt: T0,
    updatedAt: T0,
  });
  const caps = confirming(new Capabilities(db, createSecretBox(["amendments-attacks-secret-0123456789abcdef"]), BASE));
  await caps.updateSettings(owner, {
    doc: {
      business: { name: "Oficina Maré" },
      notifications: { ownerEmail: "hello@oficinamare.pt", appUrl: BASE },
      email: { fromAddress: "inbox@oficinamare.pt" },
      ...doc,
    },
  });
  const runner = createRunner({
    mailOut: logMailOut(),
    receipts: caps.receipts,
    baseUrl: BASE,
    secrets: caps.secrets,
  }).register(LIFECYCLE_SWEEP_KIND, lifecycleSweepHandler());
  const drain = async () => {
    for (let i = 0; i < 30; i++) if ((await runner.runDue(db, { now: clock.now, limit: 100 })).claimed === 0) return;
  };
  const sweep = async (t: number) => {
    clock.now = t;
    await ensureLifecycleSweep(db, t);
    await drain();
  };
  return { db, caps, svc, drain, sweep };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function fail(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected a WriteError");
}

const itemOf = async (s: Setup, id: string): Promise<Item> => {
  const [row] = await s.db.orm.select().from(items).where(eq(items.id, id));
  if (!row) throw new Error("no item");
  return rowToItem(row);
};

/** An order of three chains the customer's assistant placed, in Portuguese, accepted by the owner. */
async function acceptedOrder(s: Setup, payload: Record<string, unknown> = {}) {
  const r = await s.caps.createOrder(anon(), {
    payload: {
      orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 3, price: EUR(1850) }],
      totalPrice: EUR(5550),
      ...payload,
    },
    contact: { email: "rita@example.com", locale: "pt" },
  });
  const id = r.view.item.id;
  await transitionItem(s.db, owner, { itemId: id, event: "accept" });
  return { id, token: r.accessToken as string };
}

describe("money after payment was asked for", () => {
  it("a change asked for before payment cannot move the total once payment was asked for", async () => {
    const s = await setup();
    const o = await acceptedOrder(s);
    // Five chains instead of three, asked while nothing was owed yet.
    await s.caps.customer.makeOffer(anon(o.token), { item_id: o.id, terms: { lines: [{ index: 0, quantity: 5 }] } });
    expect((await itemOf(s, o.id)).payload).toMatchObject({ change: { totalPrice: EUR(9250) } });
    // Then payment is asked for, at the total agreed.
    await transitionItem(s.db, owner, { itemId: o.id, event: "request_payment" });
    const taken = await fail(transitionItem(s.db, owner, { itemId: o.id, event: "accept_change" }));
    expect(taken.details).toMatchObject({ guard: "total_fixed" });
    expect(taken.message).toMatch(/second order for more, or refund what comes off/);
    expect((await itemOf(s, o.id)).payload).toMatchObject({ totalPrice: EUR(5550), orderedItem: [{ quantity: 3 }] });
    // The owner's AI no more than the owner.
    const byAi = await fail(transitionItem(s.db, ai, { itemId: o.id, event: "accept_change" }));
    expect(byAi.details).toMatchObject({ guard: "total_fixed" });
  });

  it("our change to the total, accepted after the customer paid, is not made: a person answers it", async () => {
    const s = await setup();
    const o = await acceptedOrder(s);
    // One chain fewer: ours, asked before any payment.
    await transitionItem(s.db, owner, {
      itemId: o.id,
      event: "propose_change",
      input: { orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 2, price: EUR(1850) }] },
    });
    // The customer pays what was agreed before answering.
    await transitionItem(s.db, connector, {
      itemId: o.id,
      event: "record_payment",
      input: { paymentRef: "pi_1", amount: EUR(5550) },
    });
    const item = await itemOf(s, o.id);
    const offer = await openOffer(item);
    expect(offer?.kind).toBe("change");
    // Their yes to our binding change is never refused: it goes to a person as their message, and a
    // person is told, in the business's voice and the customer's language.
    const passed = await s.caps.customer.acceptOffer(anon(o.token), {
      item_id: o.id,
      terms_sha: offer?.termsSha as string,
      idempotency_key: "yes-1",
    });
    expect(passed).toMatchObject({ waiting_on: "us", appended: true, replayed: false });
    expect((passed as { passed_on: string }).passed_on).toMatch(/^Passámos o seu pedido a uma pessoa/);
    expect((await itemOf(s, o.id)).payload).toMatchObject({
      totalPrice: EUR(5550),
      paidAmount: EUR(5550),
      orderedItem: [{ quantity: 3 }],
    });
    const { rows: thread } = await s.db.client.query({
      sql: "SELECT direction, body_text FROM thread_entries WHERE item_id = ? ORDER BY id",
      params: [o.id],
      method: "all",
    });
    expect(thread.at(-1)?.[0]).toBe("in");
    expect(String(thread.at(-1)?.[1])).toMatch(/^Aceito a alteração que sugeriram: 2 × Chain; total 37,00/);
    await s.drain();
    const { rows: told } = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM jobs WHERE kind = 'notify' AND json_extract(payload, '$.to') = 'owner' AND json_extract(payload, '$.itemId') = ?",
      params: [o.id],
      method: "all",
    });
    expect(Number(told[0]?.[0])).toBeGreaterThan(0);
    // The same request again is the same answer, and writes nothing twice.
    const again = await s.caps.customer.acceptOffer(anon(o.token), {
      item_id: o.id,
      terms_sha: offer?.termsSha as string,
      idempotency_key: "yes-1",
    });
    expect(again).toMatchObject({ waiting_on: "us", replayed: true });
    const { rows: after } = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM thread_entries WHERE item_id = ? AND direction = 'in'",
      params: [o.id],
      method: "all",
    });
    expect(Number(after[0]?.[0])).toBe(thread.filter((r) => r[0] === "in").length);
  });

  it("a change that keeps the total still goes through after payment", async () => {
    const s = await setup();
    const o = await acceptedOrder(s);
    const when = iso(T0 + 5 * DAY);
    await s.caps.customer.makeOffer(anon(o.token), { item_id: o.id, terms: { delivery_when: when } });
    await transitionItem(s.db, owner, { itemId: o.id, event: "request_payment" });
    await transitionItem(s.db, owner, { itemId: o.id, event: "accept_change" });
    expect((await itemOf(s, o.id)).payload).toMatchObject({ totalPrice: EUR(5550), delivery: { when } });
  });
});

describe("the owner's AI and the price, through a change", () => {
  it("never puts a price a person gave back up to the catalogue's", async () => {
    const s = await setup({ negotiation: { ai: { mayProposeChanges: true } } });
    const r = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 3, price: EUR(1850) }], totalPrice: EUR(5550) },
      contact: { email: "rita@example.com", locale: "en" },
    });
    const id = r.view.item.id;
    // The owner, in person, lets the chains go at 15.00 each; the customer accepts.
    await transitionItem(s.db, owner, {
      itemId: id,
      event: "propose",
      input: { orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 3, price: EUR(1500) }] },
    });
    await transitionItem(s.db, anon(r.accessToken as string), { itemId: id, event: "accept" });
    expect((await itemOf(s, id)).payload).toMatchObject({ totalPrice: EUR(4500) });
    // The AI asks for "a change" that is the catalogue price again: a draft for the owner, never sent.
    const dearer = await transitionItem(s.db, ai, {
      itemId: id,
      event: "propose_change",
      input: { orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 3, price: EUR(1850) }] },
    });
    expect(dearer.drafted?.breaches).toEqual(["worse_than_before"]);
    expect((await itemOf(s, id)).payload).not.toHaveProperty("change");
  });
});

describe("the owner's AI and the cutoff for changes", () => {
  it("cannot move the cancellation window that bounds it, then take a last-minute change", async () => {
    const s = await setup();
    // A booking tomorrow, 20 hours away: inside the cancellation window (a day), a person takes a change.
    const created = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: iso(T0 + 20 * HOUR),
        endTime: iso(T0 + 20 * HOUR + 90 * MIN),
      },
      contact: { email: "rita@example.com", locale: "en" },
    });
    const id = created.view.item.id;
    await transitionItem(s.db, owner, { itemId: id, event: "confirm" });
    await transitionItem(s.db, anon(created.accessToken as string), {
      itemId: id,
      event: "propose_change",
      input: { startTime: iso(FRI_14) },
    });
    const late = await fail(transitionItem(s.db, ai, { itemId: id, event: "accept_change" }));
    expect(late.details).toMatchObject({ guard: "change_allowed" });
    // A customer's message asks the AI to shorten the window first: it is the AI's own limit.
    const moved = await fail(s.caps.updateSettings(ai, { doc: { booking: { cancellationWindowMin: 60 } } }));
    expect(moved.code).toBe("not_allowed");
    expect((await s.caps.getSettings(owner)).doc.booking.cancellationWindowMin).toBe(1440);
    expect((await fail(transitionItem(s.db, ai, { itemId: id, event: "accept_change" }))).details).toMatchObject({
      guard: "change_allowed",
    });
    // Making it longer only binds the AI more; and once the owner sets a cutoff of its own, the
    // window is the business's policy again.
    await s.caps.updateSettings(ai, { doc: { booking: { cancellationWindowMin: 2880 } } });
    await s.caps.updateSettings(owner, { doc: { negotiation: { changes: { customerCutoffMin: 1440 } } } });
    await s.caps.updateSettings(ai, { doc: { booking: { cancellationWindowMin: 60 } } });
  });
});

describe("limits a date the promise never had cannot escape", () => {
  it("an order agreed with no delivery date moves at most 90 days from when it was due", async () => {
    const s = await setup();
    const o = await acceptedOrder(s);
    // orders.dueDays after it was accepted is when it was due; 200 days on is far past 90 from that.
    const far = await fail(
      transitionItem(s.db, anon(o.token), {
        itemId: o.id,
        event: "propose_change",
        input: { deliveryWhen: iso(T0 + 200 * DAY) },
      }),
    );
    expect(far.details).toMatchObject({ guard: "changes_left", reason: "shift" });
    const ours = await fail(
      transitionItem(s.db, owner, {
        itemId: o.id,
        event: "propose_change",
        input: { delivery: { method: "delivery", when: iso(T0 + 200 * DAY) } },
      }),
    );
    expect(ours.details).toMatchObject({ guard: "changes_left", reason: "shift" });
    // Within the limit it is a change like any other.
    await transitionItem(s.db, anon(o.token), {
      itemId: o.id,
      event: "propose_change",
      input: { deliveryWhen: iso(T0 + 30 * DAY) },
    });
  });

  it("we never ask to deliver an order in the past", async () => {
    const s = await setup();
    const o = await acceptedOrder(s);
    const past = await fail(
      transitionItem(s.db, owner, {
        itemId: o.id,
        event: "propose_change",
        input: { delivery: { method: "delivery", when: iso(T0 - DAY) } },
      }),
    );
    expect(past.code).toBe("invalid_input");
    expect(past.fields?.map((f) => f.path)).toEqual(["input.delivery.when"]);
  });
});

describe("a change in another currency", () => {
  it("is refused: a booking priced in euros is changed in euros", async () => {
    const s = await setup();
    const created = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: iso(THU_12),
        endTime: iso(THU_12 + 90 * MIN),
      },
      contact: { email: "rita@example.com", locale: "en" },
    });
    const id = created.view.item.id;
    await transitionItem(s.db, owner, { itemId: id, event: "confirm" });
    // 40 of another currency reads as "less" than 45 euros, and would ask no obligation to pay.
    const other = await fail(
      transitionItem(s.db, owner, {
        itemId: id,
        event: "propose_change",
        input: { startTime: iso(FRI_14), totalPrice: { value: 4000, currency: "USD" } },
      }),
    );
    expect(other.code).toBe("invalid_input");
    expect(other.fields?.map((f) => f.path)).toEqual(["input.totalPrice.currency"]);
  });
});

describe("two answers at once", () => {
  it("a yes from the email and one from the assistant move the booking once", async () => {
    const s = await setup({ booking: { holdOnPropose: true } });
    const created = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: iso(THU_12),
        endTime: iso(THU_12 + 90 * MIN),
      },
      contact: { email: "rita@example.com", locale: "en" },
    });
    const id = created.view.item.id;
    const token = created.accessToken as string;
    await transitionItem(s.db, owner, { itemId: id, event: "confirm" });
    await transitionItem(s.db, owner, { itemId: id, event: "propose_change", input: { startTime: iso(FRI_14) } });
    const links = await linksForEmail(s.db, s.caps.secrets, await itemOf(s, id), {
      mailKey: "test:race",
      lang: "en",
      base: BASE,
      now: clock.now,
      minNoticeMin: 60,
    });
    const link = String(links?.get("accept_change" as never)).split("/c/")[1] as string;
    const page = await s.caps.customer.linkView(link, { now: clock.now });
    const status = await s.caps.getItemStatus(anon(token), { item_id: id });
    const answers = await Promise.allSettled([
      s.caps.customer.linkAct(link, page.form?.hidden ?? {}, { now: clock.now }),
      s.caps.customer.acceptOffer(anon(token), { item_id: id, terms_sha: status.offer?.terms_sha as string }),
      s.caps.customer.acceptOffer(anon(token), { item_id: id, terms_sha: status.offer?.terms_sha as string }),
    ]);
    const moved = await itemOf(s, id);
    expect(moved.payload).toMatchObject({ startTime: iso(FRI_14) });
    const { rows: accepted } = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM item_offers WHERE item_id = ? AND kind = 'change' AND status = 'accepted'",
      params: [id],
      method: "all",
    });
    expect(Number(accepted[0]?.[0])).toBe(1);
    const { rows: claims } = await s.db.client.query({
      sql: "SELECT bucket_start, offer_id FROM slot_claims WHERE item_id = ? ORDER BY bucket_start",
      params: [id],
      method: "all",
    });
    expect(claims.map((c) => [Number(c[0]), String(c[1])])).toEqual(
      [FRI_14, FRI_14 + 30 * MIN, FRI_14 + 60 * MIN].map((b) => [b, ""]),
    );
    expect(answers.filter((a) => a.status === "fulfilled").length).toBeGreaterThan(0);
  });
});

describe("a changed promise and the networks", () => {
  it("a yes from the email to our change, after a network was switched on, goes to a person", async () => {
    const s = await setup();
    const created = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: iso(THU_12),
        endTime: iso(THU_12 + 90 * MIN),
      },
      contact: { email: "rita@example.com", locale: "en" },
    });
    const id = created.view.item.id;
    await transitionItem(s.db, owner, { itemId: id, event: "confirm" });
    await transitionItem(s.db, owner, { itemId: id, event: "propose_change", input: { startTime: iso(FRI_14) } });
    const links = await linksForEmail(s.db, s.caps.secrets, await itemOf(s, id), {
      mailKey: "test:change",
      lang: "en",
      base: BASE,
      now: clock.now,
      minNoticeMin: 60,
    });
    const token = String(links?.get("accept_change" as never)).split("/c/")[1] as string;
    const page = await s.caps.customer.linkView(token, { now: clock.now });
    // Before they answer, the owner switches a network on: the change can no longer be recorded.
    await s.caps.updateSettings(owner, { doc: { networks: { [NET]: { enabled: true } } } });
    const done = await s.caps.customer.linkAct(token, page.form?.hidden ?? {}, { now: clock.now });
    expect(done).toMatchObject({ page: { status: 200 } });
    const heading = (done as { page: { heading: string } }).page.heading;
    expect(heading).toMatch(
      /^We have passed your request on to a person on our team.*Your booking stays as agreed, for Thu/,
    );
    expect((await itemOf(s, id)).payload).toMatchObject({ startTime: iso(THU_12) });
    const { rows } = await s.db.client.query({
      sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND direction = 'in'",
      params: [id],
      method: "all",
    });
    expect(String(rows.at(-1)?.[0])).toMatch(/^I accept the change you suggested: Fri/);
  });

  it("a network switched on after a promise changed is not sent that promise or its outcome while it holds dates first agreed", async () => {
    const s = await setup();
    const created = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: iso(THU_12),
        endTime: iso(THU_12 + 90 * MIN),
      },
      contact: { email: "rita@example.com", locale: "en" },
    });
    const id = created.view.item.id;
    const token = created.accessToken as string;
    await transitionItem(s.db, owner, { itemId: id, event: "confirm" });
    await s.drain();
    // No network is on: the change is recorded, a week later than first agreed.
    const moved = THU_12 + 7 * DAY;
    await transitionItem(s.db, anon(token), { itemId: id, event: "propose_change", input: { startTime: iso(moved) } });
    await transitionItem(s.db, owner, { itemId: id, event: "accept_change" });
    // Another booking, never changed, for comparison.
    const plain = await createItem(s.db, anon(), {
      type: "booking",
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: iso(FRI_14),
        endTime: iso(FRI_14 + 90 * MIN),
      },
      contact: { email: "ana@example.com" },
    });
    await transitionItem(s.db, owner, { itemId: plain.view.item.id, event: "confirm" });
    await s.drain();
    // Now the owner switches a network on; the booking completes at its new time.
    await s.caps.updateSettings(owner, { doc: { networks: { [NET]: { enabled: true } } } });
    // settings.booking.autoCompleteHours (48) after it ended, the sweep completes it.
    await s.sweep(moved + 90 * MIN + 49 * HOUR);
    await s.sweep(moved + 90 * MIN + 49 * HOUR + 20 * MIN);
    expect((await itemOf(s, id)).state).toBe("completed");
    const queued = async (itemId: string) =>
      (
        await s.db.client.query({
          sql: `SELECT r.kind FROM network_publications p JOIN receipts r ON r.id = p.receipt_id WHERE r.item_id = ?`,
          params: [itemId],
          method: "all",
        })
      ).rows.map((r) => String(r[0]));
    const { rows: receipts } = await s.db.client.query({
      sql: "SELECT kind FROM receipts WHERE item_id = ? ORDER BY kind",
      params: [id],
      method: "all",
    });
    // Its promise names the date first agreed, its amendment the new one (rules version 6)…
    expect(receipts.map((r) => String(r[0]))).toEqual(["amended", "confirmed", "outcome"]);
    // …and a network whose rules in force are not 6 would hold it to the first: none is queued for it
    // (its backfill takes them once it applies version 6).
    expect(await queued(id)).toEqual([]);
    expect(await queued(plain.view.item.id)).toContain("outcome");
  });
});
