import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import type { Item } from "../src/domain/types";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { ensureLifecycleSweep, LIFECYCLE_SWEEP_KIND, lifecycleSweepHandler } from "../src/jobs/lifecycle";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, items, jobs, outboundMail, products, services, threadEntries } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { type Caller, rowToItem, transitionItem, WriteError } from "../src/write/index";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * Returns and withdrawals under attack (ADR-018 §3.4, §7, §8): the same goods sent back twice for two
 * refunds, a lawful withdrawal the business records as a mere cancellation (and so refuses, or counts
 * late), a return the customer asked for within the period and a person refuses, one written down
 * after the period that the customer asked within it, the owner's AI dropping a refund it owes or
 * ending a paid order on its own word, two returns asked at once, and a confirm step whose fingerprint
 * does not name what was confirmed. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z"); // a Monday, 11:00 in Lisbon
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BASE = "https://inbox.example";
const clock = { now: T0 };
const at = (kind: Caller["actor"]["kind"], channel: Caller["actor"]["channel"]): Caller => ({
  actor: { kind, id: `${kind}_1`, channel },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock.now,
});
const owner = at("owner", "owner_ui");
const ai = at("owner_ai", "mcp_owner");
const shop = at("connector", "connector");
const anon = (accessToken?: string): Caller => ({
  actor: { kind: "customer_agent", id: "agent:test", channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => clock.now,
  ...(accessToken ? { accessToken } : {}),
});
const EUR = (value: number) => ({ value, currency: "EUR" });
const iso = (ms: number) => new Date(ms).toISOString();

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
  const twin = ulid();
  await db.orm.insert(services).values([
    {
      id: svc,
      name: "Full service",
      durationMin: 90,
      capacity: 1,
      granularityMin: 30,
      price: { model: "fixed", value: 4500, currency: "EUR" },
      createdAt: T0,
      updatedAt: T0,
    },
    {
      // Another service at the same price and length: the confirm step must still tell them apart.
      id: twin,
      name: "Wheel truing",
      durationMin: 90,
      capacity: 1,
      granularityMin: 30,
      price: { model: "fixed", value: 4500, currency: "EUR" },
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  const chain = ulid();
  await db.orm
    .insert(products)
    .values([{ id: chain, sku: "CH-9", name: "Chain", price: EUR(1850), active: 1, createdAt: T0, updatedAt: T0 }]);
  const caps = confirming(new Capabilities(db, createSecretBox(["returns-attacks-secret-0123456789abcdef"]), BASE));
  await caps.updateSettings(owner, {
    doc: {
      business: { name: "Oficina Maré" },
      notifications: { ownerEmail: "hello@oficinamare.pt", appUrl: BASE },
      email: { fromAddress: "inbox@oficinamare.pt" },
      commerce: { legal: { legalName: "Oficina Maré Lda", address: "Rua do Mar 1, Lisboa" } },
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
  return { db, caps, svc, twin, chain, drain, sweep };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** Two chains, accepted and paid (€37.00). */
async function paidOrder(s: Setup) {
  const r = await s.caps.createOrder(anon(), {
    payload: { orderedItem: [{ productId: s.chain, quantity: 2, name: "x", price: EUR(1) }], totalPrice: EUR(1) },
    contact: { name: "Rita", email: "rita@example.com", locale: "en" },
  });
  const id = r.view.item.id;
  await transitionItem(s.db, owner, { itemId: id, event: "accept" });
  await transitionItem(s.db, shop, {
    itemId: id,
    event: "record_payment",
    input: { paymentRef: "pi_1", amount: EUR(3700) },
  });
  return { id, token: r.accessToken as string };
}

/** …sent, and reaching the customer on `delivered`. */
async function deliveredOrder(s: Setup, delivered = T0 + DAY) {
  const o = await paidOrder(s);
  clock.now = delivered;
  await transitionItem(s.db, owner, { itemId: o.id, event: "fulfil", input: { deliveredAt: iso(delivered) } });
  return o;
}

async function itemOf(db: Db, id: string): Promise<Item> {
  const [row] = await db.orm.select().from(items).where(eq(items.id, id));
  if (!row) throw new Error(`no item ${id}`);
  return rowToItem(row);
}

async function refundsOf(db: Db, id: string): Promise<Item[]> {
  return (await db.orm.select().from(items).where(eq(items.linkedItemId, id)))
    .filter((r) => r.type === "refund")
    .map(rowToItem);
}

const outcomeJobs = async (db: Db, id: string) =>
  (await db.orm.select().from(jobs))
    .filter((j) => j.kind === "issue_receipt" && (j.payload as { itemId?: string }).itemId === id)
    .map((j) => (j.payload as { outcome?: string }).outcome)
    .filter(Boolean);

async function fail(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected a WriteError");
}

/** The customer withdraws once the goods reached them, sends them back, and is refunded. */
async function returnedAndRefunded(
  s: Setup,
  o: { id: string; token: string },
  lines?: { index: number; quantity: number }[],
) {
  const done = await s.caps.customer.withdraw(anon(o.token), {
    item_id: o.id,
    access_token: o.token,
    confirm_withdrawal: true,
    ...(lines ? { lines } : {}),
  });
  if (!("linked" in done) || !done.linked) throw new Error("expected the return");
  const id = done.linked.item.id;
  await transitionItem(s.db, owner, { itemId: id, event: "goods_back" });
  await transitionItem(s.db, owner, { itemId: id, event: "refund", input: { paymentRef: `re_${id}` } });
  expect((await itemOf(s.db, id)).state).toBe("refunded");
  return id;
}

describe("the same goods cannot be refunded twice", () => {
  it("once all of an order came back and was refunded, another return of it owes nothing more", async () => {
    const s = await setup();
    const o = await deliveredOrder(s);
    clock.now = T0 + 3 * DAY;
    await returnedAndRefunded(s, o);

    // Still within the period: a second withdrawal, or a second return, of the same goods.
    clock.now = T0 + 5 * DAY;
    const again = await fail(
      s.caps.customer.withdraw(anon(o.token), { item_id: o.id, access_token: o.token, confirm_withdrawal: true }),
    );
    expect(again.details).toMatchObject({ guard: "nothing_to_return" });
    expect(again.message).not.toMatch(/refund request|network|inbox/i);
    const asked = await fail(
      s.caps.customer.requestReturn(anon(o.token), { item_id: o.id, access_token: o.token, reason: "changed_mind" }),
    );
    expect(asked.details).toMatchObject({ guard: "nothing_to_return" });
    const opened = await fail(
      transitionItem(s.db, owner, {
        itemId: o.id,
        event: "open_return",
        input: { reasonCode: "faulty", note: "She rang: the chain snapped" },
      }),
    );
    expect(opened.details).toMatchObject({ guard: "nothing_to_return" });
    const refunds = await refundsOf(s.db, o.id);
    expect(refunds).toHaveLength(1);
  });

  it("after part of an order came back, a return owes only what did not", async () => {
    const s = await setup();
    const o = await deliveredOrder(s);
    clock.now = T0 + 3 * DAY;
    await returnedAndRefunded(s, o, [{ index: 0, quantity: 1 }]);
    clock.now = T0 + 5 * DAY;
    // Asking for both chains back again: only the one still with them comes back, for €18.50.
    const r = await s.caps.customer.requestReturn(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      reason: "changed_mind",
    });
    expect(r.linked?.item.payload).toMatchObject({
      kind: "withdrawal",
      amount: EUR(1850),
      lines: [{ index: 0, quantity: 1 }],
    });
    // Naming the chain that already came back is refused.
    const second = await deliveredOrder(s, T0 + 5 * DAY);
    clock.now = T0 + 6 * DAY;
    await returnedAndRefunded(s, second, [{ index: 0, quantity: 2 }]);
    const named = await fail(
      s.caps.customer.requestReturn(anon(second.token), {
        item_id: second.id,
        access_token: second.token,
        reason: "faulty",
        lines: [{ index: 0, quantity: 1 }],
      }),
    );
    expect(named.details).toMatchObject({ guard: "nothing_to_return" });
  });

  it("records no more refunded across an order's returns than was paid for it", async () => {
    const s = await setup();
    const o = await deliveredOrder(s);
    clock.now = T0 + 3 * DAY;
    // One chain back, refunded at the whole order's price (the business paid more than it owed).
    const done = await s.caps.customer.withdraw(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      confirm_withdrawal: true,
      lines: [{ index: 0, quantity: 1 }],
    });
    const first = (done as { linked?: { item: { id: string } } }).linked?.item.id as string;
    await transitionItem(s.db, owner, { itemId: first, event: "goods_back" });
    await transitionItem(s.db, owner, {
      itemId: first,
      event: "refund",
      input: { paymentRef: "re_1", amount: EUR(3700) },
    });
    // The other chain comes back too: nothing is left of what was paid to owe for it.
    clock.now = T0 + 4 * DAY;
    const other = await s.caps.customer.requestReturn(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      reason: "changed_mind",
    });
    const id = other.linked?.item.id as string;
    expect(other.linked?.item.payload).toMatchObject({ amount: EUR(0), lines: [{ index: 0, quantity: 1 }] });
    await transitionItem(s.db, owner, { itemId: id, event: "goods_back" });
    const over = await fail(
      transitionItem(s.db, shop, { itemId: id, event: "refund", input: { paymentRef: "re_2", amount: EUR(1850) } }),
    );
    expect(over.code).toBe("invalid_input");
  });
});

describe("a customer's cancellation the business records while the right of withdrawal runs", () => {
  it("of a paid order, is their withdrawal: owed back within 14 days, and no one may refuse it", async () => {
    const s = await setup();
    const o = await paidOrder(s);
    clock.now = T0 + 2 * DAY;
    const r = await s.caps.transitionItem(owner, {
      item_id: o.id,
      event: "record_cancel",
      input: { note: "She rang to cancel", askedAt: iso(T0 + DAY) },
    });
    expect(r.view.item.state).toBe("cancelled");
    expect(r.linked?.item).toMatchObject({
      state: "approved",
      payload: { kind: "withdrawal", amount: EUR(3700), noticeAt: iso(T0 + DAY), refundDue: iso(T0 + 15 * DAY) },
    });
    expect(await outcomeJobs(s.db, o.id)).toEqual(["order.cancelled_by_customer"]);
    // The customer is told as for any withdrawal, and never reads our own note of the call.
    await s.drain();
    const mail = (await s.db.orm.select().from(outboundMail).where(eq(outboundMail.itemId, o.id))).filter(
      (m) => m.recipient === "customer",
    );
    const ack = mail.find((m) => m.template === "order.withdrawn");
    expect(ack?.bodyText).toMatch(/We will refund €37\.00 by .*, to the way you paid\./);
    for (const m of mail) expect(m.bodyText).not.toMatch(/She rang/);
    const refund = r.linked?.item.id as string;
    const refused = await fail(
      transitionItem(s.db, owner, { itemId: refund, event: "reject", input: { note: "No refunds" } }),
    );
    expect(refused.code).toMatch(/guard_failed|wrong_state/);
  });

  it("of a paid booking, is never late: it is their withdrawal, and what they paid comes back", async () => {
    const s = await setup({ booking: { lateCancellation: "record" } });
    const b = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: iso(T0 + 3 * DAY),
        endTime: iso(T0 + 3 * DAY + 90 * MIN),
      },
      contact: { name: "Rita", email: "rita@example.com" },
    });
    const id = b.view.item.id;
    await transitionItem(s.db, owner, { itemId: id, event: "confirm" });
    await transitionItem(s.db, shop, {
      itemId: id,
      event: "record_payment",
      input: { paymentRef: "pi_9", amount: EUR(4500) },
    });
    // She rings the day before, inside the cancellation window, but within the period to withdraw.
    clock.now = T0 + 2 * DAY + 12 * HOUR;
    const r = await s.caps.transitionItem(owner, {
      item_id: id,
      event: "record_cancel",
      input: { note: "She rang: she cannot come" },
    });
    expect(r.view.item.state).toBe("cancelled_by_customer");
    expect(await outcomeJobs(s.db, id)).toEqual(["booking.cancelled_by_customer"]);
    expect(r.linked?.item).toMatchObject({ state: "approved", payload: { kind: "withdrawal", amount: EUR(4500) } });
  });

  it("of a paid order, is recorded by the owner's AI only from the customer's own message", async () => {
    const s = await setup();
    const o = await paidOrder(s);
    const blind = await fail(
      transitionItem(s.db, ai, { itemId: o.id, event: "record_cancel", input: { note: "They cancelled" } }),
    );
    expect(blind.code).toBe("invalid_input");
    expect((await itemOf(s.db, o.id)).state).toBe("paid");
  });
});

describe("a return the customer asked for within the period", () => {
  it("is not refused by a person, whatever the reason given: the goods may come back regardless", async () => {
    const s = await setup();
    const o = await deliveredOrder(s);
    clock.now = T0 + 3 * DAY;
    const r = await s.caps.customer.requestReturn(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      reason: "faulty",
      note: "It snapped",
    });
    const id = r.linked?.item.id as string;
    expect(r.linked?.item).toMatchObject({ state: "requested", payload: { kind: "faulty" } });
    // The business decides it was not faulty, and refuses after the period ran out.
    clock.now = T0 + 20 * DAY;
    const refused = await fail(
      transitionItem(s.db, owner, { itemId: id, event: "reject", input: { note: "Not faulty" } }),
    );
    expect(refused.details).toMatchObject({ guard: "not_withdrawal" });
  });

  it("written down by the business after the period, is judged when the customer asked", async () => {
    const s = await setup();
    const o = await deliveredOrder(s);
    clock.now = T0 + 10 * DAY;
    await s.caps.sendMessage(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      body: "I would like to send these back, please.",
    });
    const [entry] = await s.db.orm.select().from(threadEntries).where(eq(threadEntries.itemId, o.id));
    clock.now = T0 + 20 * DAY;
    const r = await transitionItem(s.db, owner, {
      itemId: o.id,
      event: "open_return",
      input: { reasonCode: "changed_mind", note: "She wrote on day 10", entryId: entry?.id },
    });
    expect(r.linked?.item).toMatchObject({
      state: "approved",
      payload: { kind: "withdrawal", noticeAt: iso(T0 + 10 * DAY) },
    });
    // A person may date it by what the customer said on the phone.
    const other = await deliveredOrder(s, T0 + 20 * DAY);
    clock.now = T0 + 40 * DAY;
    const phoned = await transitionItem(s.db, owner, {
      itemId: other.id,
      event: "open_return",
      input: { reasonCode: "changed_mind", note: "She rang on day 30", askedAt: iso(T0 + 30 * DAY) },
    });
    expect(phoned.linked?.item.payload).toMatchObject({ kind: "withdrawal", noticeAt: iso(T0 + 30 * DAY) });
  });
});

describe("a refund with nothing to send back", () => {
  it("is automation's only up to what the owner allows for the order, never split into pieces under it", async () => {
    const s = await setup({ negotiation: { ai: { maxRefundMinor: 2_000 } } });
    const o = await deliveredOrder(s);
    clock.now = T0 + 3 * DAY;
    const approve = async (index: number) => {
      const opened = await transitionItem(s.db, ai, {
        itemId: o.id,
        event: "open_return",
        input: { reasonCode: "faulty", note: "She rang: the chain snapped", lines: [{ index: 0, quantity: 1 }] },
      });
      const id = opened.linked?.item.id as string;
      expect(opened.linked?.item.payload, `return ${index}`).toMatchObject({ amount: EUR(1_850) });
      return transitionItem(s.db, ai, { itemId: id, event: "approve", input: { goodsBack: false } });
    };
    // One chain, €18.50, within the €20.00 the owner lets automation agree; the shop pays it.
    const first = await approve(1);
    expect(first.view.item.state).toBe("approved");
    await transitionItem(s.db, shop, { itemId: first.view.item.id, event: "refund", input: { paymentRef: "re_1" } });
    // The other, another €18.50 with nothing back: €37.00 for the order, over it.
    const e = await fail(approve(2));
    expect(e.details).toMatchObject({ guard: "refund_over_max" });
  });

  it("keeps its date: recording goods back cannot push it later", async () => {
    const s = await setup();
    const o = await paidOrder(s);
    const r = await transitionItem(s.db, owner, { itemId: o.id, event: "cancel", input: { note: "Out of stock" } });
    const id = r.linked?.item.id as string;
    expect(r.linked?.item.payload).toMatchObject({ goodsBack: false, refundDue: iso(T0 + 14 * DAY) });
    clock.now = T0 + 10 * DAY;
    const e = await fail(transitionItem(s.db, shop, { itemId: id, event: "goods_back" }));
    expect(e.details).toMatchObject({ guard: "goods_expected" });
    expect((await itemOf(s.db, id)).payload).toMatchObject({ refundDue: iso(T0 + 14 * DAY) });
  });

  it("is not the customer's to drop by mistake: there is nothing to keep, only money owed to them", async () => {
    const s = await setup();
    const o = await paidOrder(s);
    const done = await s.caps.customer.withdraw(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      confirm_withdrawal: true,
    });
    const id = (done as { linked?: { item: { id: string } } }).linked?.item.id as string;
    const status = await s.caps.getItemStatus(anon(o.token), { item_id: id, access_token: o.token });
    expect(status.next?.map((n) => n.action)).not.toContain("cancel_item");
    const e = await fail(s.caps.cancelItem(anon(o.token), { item_id: id, access_token: o.token }));
    expect(e.details).toMatchObject({ guard: "goods_expected" });
    expect(e.message).not.toMatch(/guard|refund request/i);
    expect((await itemOf(s.db, id)).state).toBe("approved");
  });
});

describe("a booking paid in parts", () => {
  it("owes back everything paid for it on withdrawal, not only the last payment", async () => {
    const s = await setup();
    const b = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: iso(T0 + 10 * DAY),
        endTime: iso(T0 + 10 * DAY + 90 * MIN),
      },
      contact: { name: "Rita", email: "rita@example.com" },
    });
    const id = b.view.item.id;
    const token = b.accessToken as string;
    await transitionItem(s.db, owner, { itemId: id, event: "confirm" });
    // A deposit, then the rest; the provider sends the rest's notice twice.
    await transitionItem(s.db, shop, {
      itemId: id,
      event: "record_payment",
      input: { paymentRef: "dep_1", amount: EUR(1000) },
    });
    await transitionItem(s.db, shop, {
      itemId: id,
      event: "record_payment",
      input: { paymentRef: "pi_2", amount: EUR(3500) },
    });
    await transitionItem(s.db, shop, {
      itemId: id,
      event: "record_payment",
      input: { paymentRef: "pi_2", amount: EUR(3500) },
    });
    expect((await itemOf(s.db, id)).payload).toMatchObject({ paidAmount: EUR(4500) });
    clock.now = T0 + 2 * DAY;
    const r = await s.caps.cancelItem(anon(token), { item_id: id, access_token: token });
    expect(r.linked?.item).toMatchObject({ payload: { kind: "withdrawal", amount: EUR(4500) } });
  });
});

describe("a paid booking the business cancels", () => {
  it("owes back what was paid, by a date, and is cancelled by a person, never by the owner's AI", async () => {
    const s = await setup();
    const b = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: iso(T0 + 30 * DAY),
        endTime: iso(T0 + 30 * DAY + 90 * MIN),
      },
      contact: { name: "Rita", email: "rita@example.com" },
    });
    const id = b.view.item.id;
    await transitionItem(s.db, owner, { itemId: id, event: "confirm" });
    await transitionItem(s.db, shop, {
      itemId: id,
      event: "record_payment",
      input: { paymentRef: "pi_9", amount: EUR(4500) },
    });
    await s.drain();
    const byAi = await fail(
      transitionItem(s.db, { ...ai, actsAs: "owner" }, { itemId: id, event: "cancel_by_business" }),
    );
    expect(byAi.details).toMatchObject({ reason: "person_only", draft_for_owner: true });
    const r = await transitionItem(s.db, owner, {
      itemId: id,
      event: "cancel_by_business",
      input: { note: "The workshop is closed that week" },
    });
    expect(r.view.item.state).toBe("cancelled_by_business");
    expect(r.linked?.item).toMatchObject({
      state: "approved",
      payload: { kind: "cancellation", amount: EUR(4500), goodsBack: false, refundDue: iso(T0 + 14 * DAY) },
    });
    await s.drain();
    const told = (await s.db.orm.select().from(outboundMail).where(eq(outboundMail.itemId, id))).find(
      (m) => m.template === "cancelled.by_us",
    );
    expect(told?.bodyText).toMatch(/We will refund €45\.00 by .*, to the way you paid\./);
  });

  it("unpaid, is cancelled as before, by the owner's AI too, and owes nothing", async () => {
    const s = await setup();
    const b = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: iso(T0 + 30 * DAY),
        endTime: iso(T0 + 30 * DAY + 90 * MIN),
      },
      contact: { name: "Rita", email: "rita@example.com" },
    });
    const id = b.view.item.id;
    await transitionItem(s.db, owner, { itemId: id, event: "confirm" });
    const r = await transitionItem(s.db, { ...ai, actsAs: "owner" }, { itemId: id, event: "cancel_by_business" });
    expect(r.view.item.state).toBe("cancelled_by_business");
    expect(await refundsOf(s.db, id)).toHaveLength(0);
  });
});

describe("the owner's AI and a refund owed", () => {
  it("cannot drop it by recording that the customer did", async () => {
    const s = await setup();
    const o = await deliveredOrder(s);
    clock.now = T0 + 3 * DAY;
    const done = await s.caps.customer.withdraw(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      confirm_withdrawal: true,
    });
    const id = (done as { linked?: { item: { id: string } } }).linked?.item.id as string;
    const dropped = await fail(
      transitionItem(s.db, ai, { itemId: id, event: "record_cancel", input: { note: "She keeps them" } }),
    );
    expect(dropped.code).toBe("not_allowed");
    expect(dropped.details).toMatchObject({ reason: "person_only", draft_for_owner: true });
    const asOwner = await fail(
      transitionItem(s.db, { ...ai, actsAs: "owner" }, { itemId: id, event: "record_cancel", input: { note: "x" } }),
    );
    expect(asOwner.details).toMatchObject({ reason: "person_only" });
    expect((await itemOf(s.db, id)).state).toBe("approved");
  });
});

describe("two returns asked at once", () => {
  it("make one", async () => {
    const s = await setup();
    const o = await deliveredOrder(s);
    clock.now = T0 + 3 * DAY;
    const ask = () =>
      s.caps.customer.requestReturn(anon(o.token), { item_id: o.id, access_token: o.token, reason: "faulty" }).then(
        () => "ok",
        (e: unknown) => (e instanceof WriteError ? e.code : "error"),
      );
    const results = await Promise.all([ask(), ask(), ask()]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    const open = (await refundsOf(s.db, o.id)).filter((r) => r.state === "requested");
    expect(open).toHaveLength(1);
  });
});

describe("the confirm step's fingerprint", () => {
  it("names what was confirmed: the fingerprint of one service does not book another at the same price and time", async () => {
    const s = await setup();
    const start = T0 + 20 * DAY;
    const payload = (serviceId: string, name: string) => ({
      reservationFor: { serviceId, name },
      startTime: iso(start),
      endTime: iso(start + 90 * MIN),
    });
    // Unwrapped, so the 409 comes back to us.
    const raw = new Capabilities(s.db, createSecretBox(["returns-attacks-secret-0123456789abcdef"]), BASE);
    const asked = await fail(raw.createBooking(anon(), { payload: payload(s.svc, "Full service") }));
    expect(asked.code).toBe("confirm_terms");
    const sha = (asked.details as { terms_sha: string }).terms_sha;
    const other = await fail(raw.createBooking(anon(), { payload: payload(s.twin, "Wheel truing"), terms_sha: sha }));
    expect(other.code).toBe("confirm_terms");
    expect((await s.db.orm.select().from(items)).filter((i) => i.type === "booking")).toHaveLength(0);
  });
});

describe("the emails about a return", () => {
  it("speak as the business", async () => {
    const s = await setup();
    const o = await deliveredOrder(s);
    clock.now = T0 + 3 * DAY;
    await s.caps.customer.requestReturn(anon(o.token), { item_id: o.id, access_token: o.token, reason: "faulty" });
    await s.drain();
    const mail = (await s.db.orm.select().from(outboundMail)).filter((m) => m.recipient === "customer");
    expect(mail.length).toBeGreaterThan(0);
    for (const m of mail) {
      expect(`${m.subject}\n${m.bodyText}`).not.toMatch(/refund request|network|surfing|inbox@|\bagent\b|\bAI\b/i);
    }
  });
});
