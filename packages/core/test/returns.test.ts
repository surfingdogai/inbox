import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { linksForEmail } from "../src/customer/links";
import { createDb, type Db } from "../src/db";
import type { Item } from "../src/domain/types";
import { customerHistory } from "../src/identity/history";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { ensureLifecycleSweep, LIFECYCLE_SWEEP_KIND, lifecycleSweepHandler } from "../src/jobs/lifecycle";
import { startOfDay } from "../src/negotiation/withdrawal";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, items, jobs, outboundMail, products, services, threadEntries } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { type Caller, createItem, rowToItem, transitionItem, WriteError } from "../src/write/index";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * Returns, refunds and the right of withdrawal (ADR-018 §3.4, §7), end to end through the doors: a
 * customer withdraws from a paid order before or after it was sent, asks to send faulty goods back,
 * or cancels a paid booking; the business agrees, gets the goods back and refunds, or cancels a paid
 * order itself. A withdrawal within the period is never refused, anything less than what is owed
 * needs the customer, and the owner's AI approves returns only inside the owner's policy, never
 * paying one. Every email speaks as the business. Runs on Node and in workerd.
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
/** The last millisecond of a calendar day in Lisbon. */
const endOf = (date: string) => startOfDay(date, "Europe/Lisbon") + DAY - 1;

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
  const chain = ulid();
  const cheese = ulid();
  await db.orm.insert(products).values([
    { id: chain, sku: "CH-9", name: "Chain", price: EUR(1850), active: 1, createdAt: T0, updatedAt: T0 },
    {
      id: cheese,
      sku: "QJ-1",
      name: "Fresh cheese",
      price: EUR(900),
      active: 1,
      withdrawal: "perishable",
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  const caps = confirming(new Capabilities(db, createSecretBox(["returns-test-secret-0123456789abcdef"]), BASE));
  await caps.updateSettings(owner, {
    doc: {
      business: { name: "Oficina Maré" },
      notifications: { ownerEmail: "hello@oficinamare.pt", appUrl: BASE },
      email: { fromAddress: "inbox@oficinamare.pt" },
      commerce: {
        legal: {
          legalName: "Oficina Maré Lda",
          address: "Rua do Mar 1, Lisboa",
          email: "hello@oficinamare.pt",
          vatId: "PT500000000",
          complaintsUrl: "https://complaints.example/oficina",
        },
      },
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
  return { db, caps, svc, chain, cheese, drain, sweep };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** An order the customer's assistant made for two chains, accepted and paid (€37.00). */
async function paidOrder(s: Setup, lines = [{ productId: s.chain, quantity: 2 }]) {
  const r = await s.caps.createOrder(anon(), {
    payload: {
      orderedItem: lines.map((l) => ({ ...l, name: "x", price: EUR(1) })),
      totalPrice: EUR(1),
    },
    contact: { name: "Rita", email: "rita@example.com", locale: "en" },
  });
  const id = r.view.item.id;
  await transitionItem(s.db, owner, { itemId: id, event: "accept" });
  const total = (await itemOf(s.db, id)).payload as { totalPrice: { value: number } };
  await transitionItem(s.db, shop, {
    itemId: id,
    event: "record_payment",
    input: { paymentRef: "pi_1", amount: EUR(total.totalPrice.value) },
  });
  return { id, token: r.accessToken as string };
}

/** …and sent, reaching the customer on `delivered`. */
async function deliveredOrder(s: Setup, delivered = T0 + DAY, lines?: { productId: string; quantity: number }[]) {
  const o = await paidOrder(s, lines);
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

const customerMail = async (db: Db, id: string) =>
  (await db.orm.select().from(outboundMail).where(eq(outboundMail.itemId, id))).filter(
    (m) => m.recipient === "customer",
  );

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

describe("a withdrawal before the goods went out", () => {
  it("shows the statement first and sends nothing; confirmed, it ends the order and owes back what was paid", async () => {
    const s = await setup();
    const o = await paidOrder(s);
    const status = await s.caps.getItemStatus(anon(o.token), { item_id: o.id, access_token: o.token });
    expect(status.withdrawal).toEqual({ available: true, until: null, label: "Withdraw from contract here" });
    expect(status.next?.map((n) => n.action)).toContain("withdraw_from_contract");

    const asked = await fail(s.caps.customer.withdraw(anon(o.token), { item_id: o.id, access_token: o.token }));
    expect(asked.code).toBe("confirm_withdrawal");
    expect(asked.status).toBe(409);
    const statement = (asked.details as { statement: Record<string, unknown> }).statement;
    expect(statement).toMatchObject({
      name: "Rita",
      email: "rita@example.com",
      available: true,
      until: null,
      label: "Withdraw from contract here",
      confirm: "Confirm withdrawal",
    });
    expect(statement.text).toMatch(/^I withdraw from my contract for "2 × Chain" \(reference [0-9A-Z]{6}\)\.$/);
    expect((await itemOf(s.db, o.id)).state).toBe("paid");
    expect(await refundsOf(s.db, o.id)).toHaveLength(0);

    clock.now = T0 + HOUR;
    const done = await s.caps.customer.withdraw(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      confirm_withdrawal: true,
      note: "Changed my mind",
    });
    if (!("linked" in done) || !done.linked) throw new Error("expected the refund");
    expect(done.view.item.state).toBe("cancelled");
    expect(done.linked.item).toMatchObject({ type: "refund", state: "approved", linkedItemId: o.id });
    expect(done.linked.item.payload).toMatchObject({
      orderItemId: o.id,
      amount: EUR(3700),
      kind: "withdrawal",
      goodsBack: false,
      noticeAt: iso(T0 + HOUR),
      refundDue: iso(T0 + HOUR + 14 * DAY),
    });
    // Neutral for the network: the customer's own choice, never late.
    expect(await outcomeJobs(s.db, o.id)).toEqual(["order.cancelled_by_customer"]);

    // The refund is the same customer's: their party, their access token.
    const [refund] = await refundsOf(s.db, o.id);
    if (!refund) throw new Error("no refund");
    const [orderRow] = await s.db.orm.select().from(items).where(eq(items.id, o.id));
    const [refundRow] = await s.db.orm.select().from(items).where(eq(items.id, refund.id));
    expect(refundRow?.partyId).toBe(orderRow?.partyId);
    expect(refundRow?.accessTokenHash).toBe(orderRow?.accessTokenHash);
    const refundStatus = await s.caps.getItemStatus(anon(o.token), { item_id: refund.id, access_token: o.token });
    expect(refundStatus.human).toMatch(/^Your refund of €37\.00 for "2 × Chain" is agreed: we will refund you by /);

    await s.drain();
    const mails = await customerMail(s.db, o.id);
    const ack = mails.find((m) => m.template === "order.withdrawn");
    expect(ack?.subject).toBe("We have received your withdrawal: 2 × Chain");
    expect(ack?.bodyText).toMatch(/You withdrew from "2 × Chain" on .*\. This is what you sent us:/);
    expect(ack?.bodyText).toMatch(/I withdraw from my contract for "2 × Chain" \(reference /);
    expect(ack?.bodyText).toMatch(/We will refund €37\.00 by .*, to the way you paid\./);
    expect(ack?.bodyText).not.toMatch(/Changed my mind/);
    // The refund's own creation is not a second email: the order's said it all.
    expect(await customerMail(s.db, refund.id)).toHaveLength(0);

    // Only a payment provider or a person records the money going back, and all of it.
    expect(
      (await fail(transitionItem(s.db, ai, { itemId: refund.id, event: "refund", input: { paymentRef: "r" } }))).code,
    ).toBe("not_allowed");
    const less = await fail(
      transitionItem(s.db, owner, {
        itemId: refund.id,
        event: "refund",
        input: { paymentRef: "re_1", amount: EUR(3000) },
      }),
    );
    expect(less.code).toBe("guard_failed");
    expect(less.details).toMatchObject({ guard: "refund_amount", owed: EUR(3700) });
    const more = await fail(
      transitionItem(s.db, owner, {
        itemId: refund.id,
        event: "refund",
        input: { paymentRef: "re_1", amount: EUR(9999) },
      }),
    );
    expect(more.code).toBe("invalid_input");
    await transitionItem(s.db, shop, { itemId: refund.id, event: "refund", input: { paymentRef: "re_1" } });
    const paid = await itemOf(s.db, refund.id);
    expect(paid.state).toBe("refunded");
    expect(paid.payload).toMatchObject({ paymentRef: "re_1", paidAmount: EUR(3700) });
    await s.drain();
    const refunded = (await customerMail(s.db, refund.id)).find((m) => m.template === "refund.refunded");
    expect(refunded?.bodyText).toMatch(/We have refunded €37\.00 to the way you paid \(reference re_1\)\./);
  });

  it("cancels a paid order through the customer's cancel as a withdrawal; before payment a cancel stays a cancel", async () => {
    const s = await setup();
    const o = await paidOrder(s);
    const r = await s.caps.cancelItem(anon(o.token), { item_id: o.id, access_token: o.token });
    expect(r.view.item.state).toBe("cancelled");
    const [ev] = (
      await s.db.client.query({
        sql: "SELECT event FROM item_events WHERE item_id = ? ORDER BY seq DESC LIMIT 1",
        params: [o.id],
        method: "all",
      })
    ).rows;
    expect(ev?.[0]).toBe("withdraw");
    expect(await refundsOf(s.db, o.id)).toHaveLength(1);

    const unpaid = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ productId: s.chain, name: "x", quantity: 1, price: EUR(1) }], totalPrice: EUR(1) },
      contact: { email: "ana@example.com" },
    });
    await transitionItem(s.db, owner, { itemId: unpaid.view.item.id, event: "accept" });
    await s.caps.cancelItem(anon(unpaid.accessToken), {
      item_id: unpaid.view.item.id,
      access_token: unpaid.accessToken,
    });
    const [last] = (
      await s.db.client.query({
        sql: "SELECT event FROM item_events WHERE item_id = ? ORDER BY seq DESC LIMIT 1",
        params: [unpaid.view.item.id],
        method: "all",
      })
    ).rows;
    expect(last?.[0]).toBe("cancel");
    expect(await refundsOf(s.db, unpaid.view.item.id)).toHaveLength(0);
  });

  it("of something that does not keep, goes to a person as the customer's message: never refused", async () => {
    const s = await setup();
    const o = await paidOrder(s, [{ productId: s.cheese, quantity: 1 }]);
    const status = await s.caps.getItemStatus(anon(o.token), { item_id: o.id, access_token: o.token });
    expect(status.withdrawal).toMatchObject({
      available: false,
      why: "excepted",
      reason: "This cannot be returned: it does not keep.",
    });
    const asked = await fail(s.caps.customer.withdraw(anon(o.token), { item_id: o.id, access_token: o.token }));
    expect((asked.details as { statement: { available: boolean; why: string } }).statement).toMatchObject({
      available: false,
      why: "This cannot be returned: it does not keep.",
    });
    const passed = await s.caps.customer.withdraw(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      confirm_withdrawal: true,
    });
    if (!("passed_on" in passed)) throw new Error("expected it passed on");
    expect(passed.passed_on).toBe(
      "We have passed your message to a person on our team, who will reply soon. This cannot be returned: it does not keep.",
    );
    expect((await itemOf(s.db, o.id)).state).toBe("paid");
    const said = await s.db.orm.select().from(threadEntries).where(eq(threadEntries.itemId, o.id));
    expect(said.map((t) => [t.direction, t.bodyText])).toEqual([
      ["in", expect.stringMatching(/^I withdraw from my contract for "1 × Fresh cheese"/)],
    ]);
  });

  it("is refused to a request not agreed yet: the customer cancels that", async () => {
    const s = await setup();
    const r = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ productId: s.chain, name: "x", quantity: 1, price: EUR(1) }], totalPrice: EUR(1) },
    });
    const e = await fail(
      s.caps.customer.withdraw(anon(r.accessToken), { item_id: r.view.item.id, access_token: r.accessToken }),
    );
    expect(e.code).toBe("wrong_state");
    expect(e.message).toBe("Nothing is agreed yet: to change your mind, simply cancel.");
  });
});

describe("a withdrawal once the goods reached the customer", () => {
  it("brings them back within 14 days, and the refund follows them", async () => {
    const s = await setup();
    const o = await deliveredOrder(s, T0 + DAY);
    const status = await s.caps.getItemStatus(anon(o.token), { item_id: o.id, access_token: o.token });
    // Delivered on Tuesday 22 September: the period ends with Tuesday 6 October, in Lisbon.
    expect(status.withdrawal).toEqual({
      available: true,
      until: iso(endOf("2026-10-06")),
      label: "Withdraw from contract here",
    });
    expect(status.next?.map((n) => n.action)).toEqual(["request_return", "withdraw_from_contract", "send_message"]);

    clock.now = T0 + 3 * DAY;
    const done = await s.caps.customer.withdraw(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      confirm_withdrawal: true,
      lines: [{ index: 0, quantity: 1 }],
    });
    if (!("linked" in done) || !done.linked) throw new Error("expected the return");
    // The order was kept: it stays fulfilled.
    expect(done.view.item.state).toBe("fulfilled");
    expect(done.linked.item.state).toBe("approved");
    expect(done.linked.item.payload).toMatchObject({
      kind: "withdrawal",
      amount: EUR(1850),
      lines: [{ index: 0, quantity: 1 }],
      goodsBack: true,
      returnBy: iso(T0 + 17 * DAY),
    });
    expect((done.linked.item.payload as { refundDue?: string }).refundDue).toBeUndefined();
    expect(await outcomeJobs(s.db, o.id)).toEqual(["order.fulfilled"]);
    // One return at a time; the customer adds to it by writing.
    const again = await fail(
      s.caps.customer.withdraw(anon(o.token), { item_id: o.id, access_token: o.token, confirm_withdrawal: true }),
    );
    expect(again.code).toBe("guard_failed");
    expect(again.details).toMatchObject({ guard: "no_open_return" });

    await s.drain();
    const refundId = done.linked.item.id;
    const ack = (await customerMail(s.db, refundId)).find((m) => m.template === "refund.withdrawn");
    expect(ack?.subject).toBe("We have received your withdrawal: 2 × Chain");
    expect(ack?.bodyText).toMatch(/Please send the items back by .*\nSending them back is at your cost\./);
    expect(ack?.bodyText).toMatch(/We will refund €18\.50 once they reach us, or once you show us you sent them\./);

    clock.now = T0 + 20 * DAY;
    await transitionItem(s.db, owner, {
      itemId: refundId,
      event: "goods_back",
      input: { receivedAt: iso(T0 + 19 * DAY) },
    });
    const back = await itemOf(s.db, refundId);
    // Notice on day 3, goods on day 19: due three days after the goods, the later of the two.
    expect(back.payload).toMatchObject({ evidenceAt: iso(T0 + 19 * DAY), refundDue: iso(T0 + 22 * DAY) });
    await s.drain();
    const received = (await customerMail(s.db, refundId)).find((m) => m.template === "refund.goods_back");
    expect(received?.bodyText).toMatch(/We have received the items you sent back\. We will refund €18\.50 by /);
    await transitionItem(s.db, owner, { itemId: refundId, event: "refund", input: { paymentRef: "re_2" } });
    expect((await itemOf(s.db, refundId)).state).toBe("refunded");
  });

  it("from the link in the confirmation: the statement, then one button; past the period, a return we answer", async () => {
    const s = await setup();
    const o = await deliveredOrder(s, T0 + DAY);
    const item = await itemOf(s.db, o.id);
    const links = await linksForEmail(s.db, s.caps.secrets, item, {
      mailKey: "test:fulfilled",
      lang: "en",
      base: BASE,
      now: clock.now,
      withdraw: { until: endOf("2026-10-06") },
    });
    const token = String(links?.get("withdraw")).split("/c/")[1] as string;
    const page = await s.caps.customer.linkView(token, { now: clock.now });
    expect(page.heading).toBe("Withdraw from your contract");
    expect(page.rows).toEqual([
      { label: "Name", value: "Rita" },
      { label: "Contract", value: expect.stringMatching(/^"2 × Chain", [0-9A-Z]{6}$/) },
      { label: "Email for your copy", value: "rita@example.com" },
    ]);
    expect(page.form?.button).toBe("Confirm withdrawal");
    // A GET writes nothing.
    expect(await refundsOf(s.db, o.id)).toHaveLength(0);
    const sent = await s.caps.customer.linkAct(token, page.form?.hidden ?? {}, { now: clock.now });
    expect(sent).toEqual({ redirect: `/c/${token}` });
    expect((await refundsOf(s.db, o.id)).map((r) => [r.state, (r.payload as { kind?: string }).kind])).toEqual([
      ["approved", "withdrawal"],
    ]);
    const after = await s.caps.customer.linkView(token, { now: clock.now });
    expect(after.heading).toMatch(/^Your withdrawal was sent on .*\. We have emailed you a copy\.$/);

    // A second order, past its period: the page says so, and what is sent is a return we answer.
    const late = await deliveredOrder(s, T0 + DAY);
    clock.now = T0 + 30 * DAY;
    const lateLinks = await linksForEmail(s.db, s.caps.secrets, await itemOf(s.db, late.id), {
      mailKey: "test:late",
      lang: "en",
      base: BASE,
      now: T0 + DAY,
      withdraw: { until: endOf("2026-10-06") + 60 * DAY },
    });
    const lateToken = String(lateLinks?.get("withdraw")).split("/c/")[1] as string;
    const closed = await s.caps.customer.linkView(lateToken, { now: clock.now });
    expect(closed.paragraphs).toEqual([
      "Your order can no longer be withdrawn from online.",
      "You can still send it: a person on our team will answer.",
    ]);
    await s.caps.customer.linkAct(lateToken, closed.form?.hidden ?? {}, { now: clock.now });
    expect((await refundsOf(s.db, late.id)).map((r) => [r.state, (r.payload as { kind?: string }).kind])).toEqual([
      ["requested", "policy"],
    ]);
  });
});

describe("a return the customer asks for", () => {
  it("of faulty goods: under the legal guarantee, answered by us; the owner's AI may agree to it, not refuse it", async () => {
    const s = await setup();
    const o = await deliveredOrder(s, T0 + DAY);
    const r = await s.caps.customer.requestReturn(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      reason: "faulty",
      note: "The chain snapped",
    });
    if (!r.linked) throw new Error("expected the return");
    const id = r.linked.item.id;
    expect(r.linked.item).toMatchObject({ state: "requested", payload: { kind: "faulty", reasonCode: "faulty" } });
    expect(r.view.item.state).toBe("fulfilled");
    await s.drain();
    const ack = (await customerMail(s.db, id)).find((m) => m.template === "refund.received");
    expect(ack?.subject).toBe("Your return: 2 × Chain");
    expect(ack?.bodyText).toMatch(
      /We are sorry "2 × Chain" is not right\. We will answer within 48 hours, and sending it back costs you nothing\./,
    );

    // Refusing it, or paying without the goods, is a person's.
    const refuse = await fail(transitionItem(s.db, ai, { itemId: id, event: "reject", input: { note: "No" } }));
    expect(refuse.code).toBe("not_allowed");
    // …and so it is when the AI acts with the owner's rights, as it does through the owner's doors.
    const asOwner = await fail(
      transitionItem(s.db, { ...ai, actsAs: "owner" }, { itemId: id, event: "reject", input: { note: "No" } }),
    );
    expect(asOwner.details).toMatchObject({ reason: "person_only", draft_for_owner: true });
    const noGoods = await fail(transitionItem(s.db, ai, { itemId: id, event: "approve", input: { goodsBack: false } }));
    expect(noGoods.details).toMatchObject({ guard: "owner_money", draft_for_owner: true });
    await transitionItem(s.db, ai, {
      itemId: id,
      event: "approve",
      input: { instructions: { method: "post", address: "Rua do Mar 1, Lisboa" } },
    });
    const approved = await itemOf(s.db, id);
    expect(approved.payload).toMatchObject({ goodsBack: true, returnBy: iso(T0 + DAY + 14 * DAY) });
    await s.drain();
    const agreed = (await customerMail(s.db, id)).find((m) => m.template === "refund.approved");
    expect(agreed?.bodyText).toMatch(
      /You can send "2 × Chain" back\. Please send it by .*\nSend it by post\.\nRua do Mar 1, Lisboa\nWe pay for sending them back\./,
    );
  });

  it("refused by a person, with the reason and where to complain; a withdrawal no one may refuse", async () => {
    const s = await setup();
    const o = await deliveredOrder(s, T0 + DAY);
    // Asked once the period to withdraw has run out: within it, the goods may come back whatever the reason.
    clock.now = T0 + 20 * DAY;
    const r = await s.caps.customer.requestReturn(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      reason: "not_as_described",
    });
    const id = r.linked?.item.id as string;
    expect((await fail(transitionItem(s.db, owner, { itemId: id, event: "reject" }))).code).toBe("invalid_input");
    await transitionItem(s.db, owner, {
      itemId: id,
      event: "reject",
      input: { note: "The chain was worn by use, not as sold." },
    });
    await s.drain();
    const refused = (await customerMail(s.db, id)).find((m) => m.template === "refund.rejected");
    expect(refused?.bodyText).toMatch(
      /We cannot accept the return of "2 × Chain":\n\nThe chain was worn by use, not as sold\.\n\nIf you disagree, reply to this email\.\nYou can also make a complaint at https:\/\/complaints\.example\/oficina\./,
    );

    // A withdrawal waiting for us (as a legacy record might be) cannot be refused either.
    const legacy = await createItem(s.db, owner, {
      type: "refund",
      payload: { orderItemId: o.id, amount: EUR(1850), kind: "withdrawal" },
    });
    const no = await fail(
      transitionItem(s.db, owner, { itemId: legacy.view.item.id, event: "reject", input: { note: "no" } }),
    );
    expect(no.details).toMatchObject({ guard: "not_withdrawal" });
  });

  it("changing their mind within the period is a withdrawal, agreed at once; after it, our policy", async () => {
    const s = await setup();
    const o = await deliveredOrder(s, T0 + DAY);
    const r = await s.caps.customer.requestReturn(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      reason: "changed_mind",
    });
    expect(r.linked?.item).toMatchObject({ state: "approved", payload: { kind: "withdrawal", goodsBack: true } });
    const later = await deliveredOrder(s, T0 + DAY);
    clock.now = T0 + 40 * DAY;
    const p = await s.caps.customer.requestReturn(anon(later.token), {
      item_id: later.id,
      access_token: later.token,
      reason: "changed_mind",
    });
    expect(p.linked?.item).toMatchObject({ state: "requested", payload: { kind: "policy" } });
    // …which the owner's AI may not approve: outside the owner's return policy, a person decides.
    const outside = await fail(transitionItem(s.db, ai, { itemId: p.linked?.item.id as string, event: "approve" }));
    expect(outside.details).toMatchObject({ guard: "return_outside_policy", draft_for_owner: true });
  });

  it("is for goods that reached the customer: before that there is nothing to return", async () => {
    const s = await setup();
    const o = await paidOrder(s);
    const e = await fail(
      s.caps.customer.requestReturn(anon(o.token), { item_id: o.id, access_token: o.token, reason: "faulty" }),
    );
    expect(e.code).toBe("wrong_state");
    expect(e.message).toBe("Nothing has been sent to you yet: to change your mind, cancel instead.");
  });

  it("disputed by a person when the goods that came back are not what we sold; the refund waits", async () => {
    const s = await setup();
    const o = await deliveredOrder(s, T0 + DAY);
    const r = await s.caps.customer.withdraw(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      confirm_withdrawal: true,
    });
    const id = ("linked" in r ? r.linked?.item.id : undefined) as string;
    await transitionItem(s.db, owner, { itemId: id, event: "goods_back" });
    const byAi = await fail(
      transitionItem(s.db, ai, { itemId: id, event: "dispute_goods", input: { note: "An empty box." } }),
    );
    expect(byAi.code).toBe("not_allowed");
    await transitionItem(s.db, owner, {
      itemId: id,
      event: "dispute_goods",
      input: { note: "An empty box came back." },
    });
    const disputed = await itemOf(s.db, id);
    expect(disputed.state).toBe("goods_received");
    expect(disputed.payload).toMatchObject({ disputed: { note: "An empty box came back.", at: iso(clock.now) } });
    const seen = await s.caps.getItemStatus(anon(o.token), { item_id: id, access_token: o.token });
    expect(seen.human).toMatch(
      /^The items that came back for "2 × Chain" are not what we sold you: we are holding the refund/,
    );
    await s.drain();
    const told = (await customerMail(s.db, id)).find((m) => m.template === "refund.disputed");
    expect(told?.bodyText).toMatch(
      /The items we received for "2 × Chain" are not what we sold you:\n\nAn empty box came back\.\n\nWe are holding the refund/,
    );
  });

  it("dropped by the customer, is cancelled", async () => {
    const s = await setup();
    const o = await deliveredOrder(s, T0 + DAY);
    const r = await s.caps.customer.requestReturn(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      reason: "faulty",
    });
    const id = r.linked?.item.id as string;
    const status = await s.caps.getItemStatus(anon(o.token), { item_id: id, access_token: o.token });
    expect(status.next).toEqual(expect.arrayContaining([{ action: "cancel_item", label: "Cancel the return" }]));
    await s.caps.cancelItem(anon(o.token), { item_id: id, access_token: o.token });
    expect((await itemOf(s.db, id)).state).toBe("cancelled");
  });
});

describe("the owner's AI and returns (time yes, money no)", () => {
  it("approves one inside the owner's policy with the goods coming back, and only while the owner lets it", async () => {
    // A business selling to businesses: no withdrawal, and every return is under its own policy.
    const s = await setup({ commerce: { customers: "businesses" } });
    const o = await deliveredOrder(s, T0 + DAY);
    const r = await s.caps.customer.requestReturn(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      reason: "changed_mind",
    });
    const id = r.linked?.item.id as string;
    expect(r.linked?.item).toMatchObject({ state: "requested", payload: { kind: "policy" } });
    await s.caps.updateSettings(owner, { doc: { negotiation: { ai: { mayAuthorizeReturnsInPolicy: false } } } });
    const off = await fail(transitionItem(s.db, ai, { itemId: id, event: "approve" }));
    expect(off.details).toMatchObject({ guard: "return_allowed", draft_for_owner: true });
    await s.caps.updateSettings(owner, { doc: { negotiation: { ai: { mayAuthorizeReturnsInPolicy: true } } } });
    await transitionItem(s.db, ai, { itemId: id, event: "approve" });
    expect((await itemOf(s.db, id)).state).toBe("approved");
    // …and cannot widen the policy it is held to.
    const widen = await fail(s.caps.updateSettings(ai, { doc: { returns: { days: 60 } } }));
    expect(widen.code).toBe("not_allowed");
  });

  it("records a withdrawal only from the customer's own message, dated by its arrival", async () => {
    const s = await setup();
    const o = await deliveredOrder(s, T0 + DAY);
    const blind = await fail(
      transitionItem(s.db, ai, { itemId: o.id, event: "record_withdrawal", input: { note: "They withdrew" } }),
    );
    expect(blind.code).toBe("invalid_input");
    // The customer wrote on day 10, within the period; the AI records it on day 20, after it.
    clock.now = T0 + 10 * DAY;
    await s.caps.sendMessage(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      body: "I withdraw from this order.",
    });
    const [entry] = await s.db.orm.select().from(threadEntries).where(eq(threadEntries.itemId, o.id));
    clock.now = T0 + 20 * DAY;
    const r = await transitionItem(s.db, ai, {
      itemId: o.id,
      event: "record_withdrawal",
      input: { note: "They wrote that they withdraw", entryId: entry?.id },
    });
    expect(r.linked?.item.payload).toMatchObject({ kind: "withdrawal", noticeAt: iso(T0 + 10 * DAY) });
  });
});

describe("a paid order the business cannot fulfil", () => {
  it("is cancelled by a person, never by the owner's AI, and what was paid is owed back at once", async () => {
    const s = await setup();
    const o = await paidOrder(s);
    await s.drain();
    const byAi = await fail(transitionItem(s.db, { ...ai, actsAs: "owner" }, { itemId: o.id, event: "cancel" }));
    expect(byAi.details).toMatchObject({ reason: "person_only" });
    const r = await transitionItem(s.db, owner, { itemId: o.id, event: "cancel", input: { note: "Out of stock" } });
    expect(r.view.item.state).toBe("cancelled");
    expect(r.linked?.item).toMatchObject({
      state: "approved",
      payload: { kind: "cancellation", amount: EUR(3700), goodsBack: false, refundDue: iso(T0 + 14 * DAY) },
    });
    expect(await outcomeJobs(s.db, o.id)).toEqual(["order.not_fulfilled"]);
    await s.drain();
    const told = (await customerMail(s.db, o.id)).find((m) => m.template === "cancelled.by_us");
    expect(told?.bodyText).toMatch(
      /We are sorry: we had to cancel your order "2 × Chain"\.\nWe will refund €37\.00 by .*, to the way you paid\./,
    );
  });

  it("cancelled because the customer asked, is theirs: a refund for us to settle", async () => {
    const s = await setup();
    // Fresh cheese: excepted from withdrawal, so their cancellation is not a withdrawal (that is owed at once).
    const o = await paidOrder(s, [{ productId: s.cheese, quantity: 2 }]);
    await s.drain();
    const r = await transitionItem(s.db, owner, {
      itemId: o.id,
      event: "record_cancel",
      input: { note: "She rang to cancel" },
    });
    expect(r.linked?.item).toMatchObject({ state: "requested", payload: { kind: "policy", amount: EUR(1800) } });
    expect(await outcomeJobs(s.db, o.id)).toEqual(["order.cancelled_by_customer"]);
    await s.drain();
    const told = (await customerMail(s.db, o.id)).find((m) => m.template === "cancelled.as_asked");
    expect(told?.bodyText).toMatch(/We will be in touch about refunding the €18\.00 you paid\./);
  });

  it("charged back while a return is open, records nothing against the customer", async () => {
    const s = await setup();
    const o = await deliveredOrder(s, T0 + DAY);
    await s.caps.customer.requestReturn(anon(o.token), { item_id: o.id, access_token: o.token, reason: "faulty" });
    await transitionItem(s.db, shop, { itemId: o.id, event: "charge_back", input: { note: "disputed with the bank" } });
    expect(await outcomeJobs(s.db, o.id)).toEqual(["order.fulfilled"]);
    // …where, with no return, it would.
    const other = await deliveredOrder(s, T0 + DAY);
    await transitionItem(s.db, shop, { itemId: other.id, event: "charge_back" });
    expect(await outcomeJobs(s.db, other.id)).toEqual(["order.fulfilled", "order.charged_back"]);
  });
});

describe("a booking paid for at a distance", () => {
  async function booking(s: Setup, start: number) {
    const r = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: iso(start),
        endTime: iso(start + 90 * MIN),
      },
      contact: { name: "Rita", email: "rita@example.com" },
    });
    await transitionItem(s.db, owner, { itemId: r.view.item.id, event: "confirm" });
    return { id: r.view.item.id, token: r.accessToken as string };
  }

  it("is withdrawn from until it starts, never late, and what was paid comes back; unpaid, a cancel stays a cancel", async () => {
    const s = await setup();
    const unpaid = await booking(s, T0 + 10 * DAY);
    const seen = await s.caps.getItemStatus(anon(unpaid.token), { item_id: unpaid.id, access_token: unpaid.token });
    expect(seen.withdrawal).toMatchObject({ available: false, why: "not_paid" });
    await s.caps.cancelItem(anon(unpaid.token), { item_id: unpaid.id, access_token: unpaid.token });
    expect(await refundsOf(s.db, unpaid.id)).toHaveLength(0);

    const paid = await booking(s, T0 + 10 * DAY + 3 * HOUR);
    // Recorded by the payment provider or a person; the owner's AI records no money.
    expect(
      (await fail(transitionItem(s.db, ai, { itemId: paid.id, event: "record_payment", input: { paymentRef: "x" } })))
        .code,
    ).toBe("not_allowed");
    await transitionItem(s.db, shop, {
      itemId: paid.id,
      event: "record_payment",
      input: { paymentRef: "pi_9", amount: EUR(4500) },
    });
    expect((await itemOf(s.db, paid.id)).payload).toMatchObject({ paymentRef: "pi_9", paidAmount: EUR(4500) });
    await s.drain();
    expect((await customerMail(s.db, paid.id)).map((m) => m.template)).toContain("booking.paid");
    const status = await s.caps.getItemStatus(anon(paid.token), { item_id: paid.id, access_token: paid.token });
    // Booked on Monday 21 September: 14 days is Monday 5 October (a holiday in Portugal, not here).
    expect(status.withdrawal).toEqual({
      available: true,
      until: iso(endOf("2026-10-05")),
      label: "Withdraw from contract here",
    });
    clock.now = T0 + 2 * DAY;
    const r = await s.caps.cancelItem(anon(paid.token), { item_id: paid.id, access_token: paid.token });
    expect(r.view.item.state).toBe("cancelled_by_customer");
    expect(r.linked?.item).toMatchObject({
      state: "approved",
      payload: { kind: "withdrawal", amount: EUR(4500), refundDue: iso(T0 + 16 * DAY) },
    });
    expect(await outcomeJobs(s.db, paid.id)).toEqual(["booking.cancelled_by_customer"]);
  });

  it("offers the owner no withdrawal to record until something was paid", async () => {
    const s = await setup();
    const b = await booking(s, T0 + 10 * DAY);
    const view = await s.caps.getItem(owner, { item_id: b.id });
    expect(view.transitions.map((t) => t.event)).not.toContain("record_withdrawal");
    await transitionItem(s.db, owner, { itemId: b.id, event: "record_payment", input: { paymentRef: "cash" } });
    const paid = await s.caps.getItem(owner, { item_id: b.id });
    expect(paid.transitions.map((t) => t.event)).toContain("record_withdrawal");
  });

  it("in Portugal, says it in Portuguese and counts past a public holiday", async () => {
    const s = await setup({ commerce: { legal: { country: "PT" } } });
    const r = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: iso(T0 + 20 * DAY),
        endTime: iso(T0 + 20 * DAY + 90 * MIN),
      },
      contact: { email: "rita@example.com", locale: "pt-PT" },
    });
    const id = r.view.item.id;
    await transitionItem(s.db, owner, { itemId: id, event: "confirm" });
    await transitionItem(s.db, owner, { itemId: id, event: "record_payment", input: { paymentRef: "mb_1" } });
    const status = await s.caps.getItemStatus(anon(r.accessToken), { item_id: id, access_token: r.accessToken });
    // 5 October is Republic Day in Portugal: the period runs to Tuesday 6 October.
    expect(status.withdrawal).toEqual({
      available: true,
      until: iso(endOf("2026-10-06")),
      label: "Retrate-se do contrato aqui",
    });
  });
});

describe("returns and the business's record of the customer", () => {
  it("change no count: a return is neither an item nor a completion", async () => {
    const s = await setup();
    const o = await deliveredOrder(s, T0 + DAY);
    const [row] = await s.db.orm.select().from(items).where(eq(items.id, o.id));
    const before = await customerHistory(s.db, row?.partyId as string);
    await s.caps.customer.requestReturn(anon(o.token), { item_id: o.id, access_token: o.token, reason: "faulty" });
    const after = await customerHistory(s.db, row?.partyId as string);
    expect(after.items).toBe(before.items);
    expect(after.completed).toBe(before.completed);
  });
});

describe("the catalogue's exceptions", () => {
  it("are the owner's to set, never the owner's AI's", async () => {
    const s = await setup();
    const refused = await fail(
      s.caps.setup.createProduct(ai, { name: "Cake", price: EUR(1500), active: true, withdrawal: "perishable" }),
    );
    expect(refused.code).toBe("not_allowed");
    const made = await s.caps.setup.createProduct(owner, {
      name: "Cake",
      price: EUR(1500),
      active: true,
      withdrawal: "perishable",
    });
    expect(made.withdrawal).toBe("perishable");
    const change = await fail(s.caps.setup.updateProduct(ai, { product_id: made.id, withdrawal: "standard" }));
    expect(change.code).toBe("not_allowed");
    // Written back as it was read, nothing changes and nothing is refused.
    await s.caps.setup.updateProduct(ai, { product_id: made.id, withdrawal: "perishable", name: "Cake, whole" });
    const svc = await s.caps.setup.updateService(owner, { service_id: s.svc, withdrawal: "dated_leisure" });
    expect(svc.withdrawal).toBe("dated_leisure");
  });
});

describe("a refund whose date is near", () => {
  it("is brought to the owner once, three days before it", async () => {
    const s = await setup();
    const o = await paidOrder(s);
    await transitionItem(s.db, owner, { itemId: o.id, event: "cancel" });
    const [refund] = await refundsOf(s.db, o.id);
    await s.sweep(T0 + 10 * DAY);
    const alerts = async () =>
      (
        await s.db.orm
          .select()
          .from(outboundMail)
          .where(eq(outboundMail.itemId, refund?.id as string))
      ).filter((m) => m.template === "owner.refund_due");
    expect(await alerts()).toHaveLength(0);
    await s.sweep(T0 + 11 * DAY + HOUR);
    const [alert] = await alerts();
    expect(alert?.subject).toMatch(/^Refund due by 2026-10-05: /);
    await s.sweep(T0 + 12 * DAY);
    expect(await alerts()).toHaveLength(1);
  });
});

describe("the confirmations of a contract the customer may withdraw from", () => {
  it("carry the right, its link, the model form and who we are; a product excepted says why", async () => {
    const s = await setup();
    const made = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ productId: s.chain, name: "x", quantity: 2, price: EUR(1) }], totalPrice: EUR(1) },
      contact: { name: "Rita", email: "rita@example.com", locale: "en" },
    });
    const o = { id: made.view.item.id };
    await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
    await s.drain();
    const accepted = (await customerMail(s.db, o.id)).find((m) => m.template === "order.accepted");
    expect(accepted?.bodyText).toContain("You can withdraw within 14 days of receiving it, without giving a reason.");
    expect(accepted?.bodyText).toMatch(
      /Withdraw from contract here: https:\/\/inbox\.example\/c\/[A-Za-z0-9_-]{22}\.…/,
    );
    expect(accepted?.bodyText).toContain(
      "Model withdrawal form (complete and return this form only if you wish to withdraw from the contract):\n— To Oficina Maré Lda, hello@oficinamare.pt, Rua do Mar 1, Lisboa",
    );
    expect(accepted?.bodyText).toMatch(
      /for the provision of the following service: "2 × Chain" \(reference [0-9A-Z]{6}\)/,
    );
    expect(accepted?.bodyText).toContain(
      "Oficina Maré Lda · Rua do Mar 1, Lisboa · hello@oficinamare.pt · VAT PT500000000",
    );

    clock.now = T0 + DAY;
    await transitionItem(s.db, owner, { itemId: o.id, event: "fulfil", input: { deliveredAt: iso(T0 + DAY) } });
    await s.drain();
    const sent = (await customerMail(s.db, o.id)).find((m) => m.template === "order.fulfilled");
    expect(sent?.bodyText).toMatch(
      /You can withdraw until Tuesday, 6 October 2026 at 23:59 \(.+\), without giving a reason\./,
    );
    expect(sent?.bodyText).toMatch(/Withdraw from contract here: https:\/\/inbox\.example\/c\//);
    // Only the first confirmation carries the form.
    expect(sent?.bodyText).not.toContain("Model withdrawal form");

    const cheese = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ productId: s.cheese, name: "x", quantity: 1, price: EUR(1) }], totalPrice: EUR(1) },
      contact: { email: "rita@example.com", locale: "en" },
    });
    await transitionItem(s.db, owner, { itemId: cheese.view.item.id, event: "accept" });
    await s.drain();
    const noRight = (await customerMail(s.db, cheese.view.item.id)).find((m) => m.template === "order.accepted");
    expect(noRight?.bodyText).toContain("This cannot be returned: it does not keep.");
    expect(noRight?.bodyText).not.toMatch(/Withdraw from contract here/);
  });

  it("in Portugal, in Portuguese: the right, the link and the model form of DL 24/2014", async () => {
    const s = await setup({
      commerce: { legal: { country: "PT", legalName: "Oficina Maré Lda", vatId: "500000000" } },
    });
    const r = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ productId: s.chain, name: "x", quantity: 1, price: EUR(1) }], totalPrice: EUR(1) },
      contact: { email: "rita@example.com", locale: "pt-PT" },
    });
    await transitionItem(s.db, owner, { itemId: r.view.item.id, event: "accept" });
    await s.drain();
    const mail = (await customerMail(s.db, r.view.item.id)).find((m) => m.template === "order.accepted");
    expect(mail?.bodyText).toContain("Pode retratar-se no prazo de 14 dias após a receção, sem indicar motivo.");
    expect(mail?.bodyText).toMatch(/Retrate-se do contrato aqui: https:\/\/inbox\.example\/c\//);
    expect(mail?.bodyText).toContain("Modelo de formulário de livre resolução");
    expect(mail?.bodyText).toContain("NIF 500000000");
  });
});
