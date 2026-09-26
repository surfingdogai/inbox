import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import type { Item } from "../src/domain/types";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { ensureLifecycleSweep, LIFECYCLE_SWEEP_KIND, lifecycleSweepHandler } from "../src/jobs/lifecycle";
import { networkRulesStatement } from "../src/network/index";
import { trmOf as keyedTrm, termsKeyFor } from "../src/receipts/sign";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, items, products, services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { type Caller, rowToItem, transitionItem, WriteError } from "../src/write/index";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * Rules version 6's receipts, attacked (ADR-017 Amendment 3, ADR-018 §8 and Amendment 6): what a
 * network holds a business to must be what the inbox let it agree. The limits on changes are
 * measured from the date the network was sent, not from a setting the owner can move later; an
 * order changed without a date keeps the date it had; and a promise signed after a change still
 * states what was promised when it was made.
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
const secs = (ms: number) => Math.floor(ms / 1000);

/** Thursday 24 September, 12:00 in Lisbon. */
const THU_12 = Date.parse("2026-09-24T11:00:00Z");
/** Friday 25 September, 14:00 in Lisbon. */
const FRI_14 = Date.parse("2026-09-25T13:00:00Z");

async function setup() {
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
  await db.orm
    .insert(products)
    .values({ id: chain, sku: "CH-9", name: "Chain", price: EUR(1850), active: 1, createdAt: T0, updatedAt: T0 });
  const caps = confirming(new Capabilities(db, createSecretBox(["receipts-v6-test-secret-0123456789ab"]), BASE));
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
  /** The network's rules as its `/v1/ranking` last said them: in force, and announced next. */
  const rules = async (version: number, next: number | null = null) => {
    await db.client.query(
      networkRulesStatement(NET, clock.now, { version, next, nextAt: next ? clock.now + 15 * DAY : null }),
    );
  };
  const networkOn = () => caps.updateSettings(owner, { doc: { networks: { [NET]: { enabled: true } } } });
  /** `trm` as the business would disclose it: the offer's own key, over its fingerprint. */
  const trmFor = async (offerId: string, termsSha: string) => {
    const master = await caps.secrets?.mac("receipt-terms");
    if (!master) throw new Error("no secret box");
    return keyedTrm(await termsKeyFor(master, offerId), termsSha);
  };
  return { db, caps, svc, chain, drain, sweep, rules, networkOn, trmFor };
}
type Setup = Awaited<ReturnType<typeof setup>>;

type Claims = Record<string, unknown> & { knd: string; typ: string; nonce: string; due: number; iat: number };

/** The item's receipts, in the order they were issued, with their claims. */
async function receiptsOf(db: Db, itemId: string) {
  const { rows } = await db.client.query({
    sql: `SELECT kind, outcome, offer_id, payload, jws FROM receipts WHERE item_id = ?
           ORDER BY CASE kind WHEN 'outcome' THEN 2 WHEN 'amended' THEN 1 ELSE 0 END, json_extract(payload, '$.iat'), id`,
    params: [itemId],
    method: "all",
  });
  return rows.map((r) => ({
    kind: String(r[0]),
    outcome: String(r[1]),
    offerId: String(r[2]),
    claims: (typeof r[3] === "string" ? JSON.parse(r[3]) : r[3]) as Claims,
    jws: String(r[4]),
  }));
}

async function itemOf(db: Db, id: string): Promise<Item> {
  const [row] = await db.orm.select().from(items).where(eq(items.id, id));
  if (!row) throw new Error(`no item ${id}`);
  return rowToItem(row);
}

async function _acceptedChanges(db: Db, itemId: string) {
  const { rows } = await db.client.query({
    sql: "SELECT id, terms_sha, by FROM item_offers WHERE item_id = ? AND kind = 'change' AND status = 'accepted' ORDER BY rev",
    params: [itemId],
    method: "all",
  });
  return rows.map((r) => ({ id: String(r[0]), termsSha: String(r[1]), by: String(r[2]) }));
}

async function _eventTime(db: Db, itemId: string, event: string): Promise<number> {
  const { rows } = await db.client.query({
    sql: "SELECT created_at FROM item_events WHERE item_id = ? AND event = ? ORDER BY seq DESC LIMIT 1",
    params: [itemId, event],
    method: "all",
  });
  return Number(rows[0]?.[0]);
}

async function fail(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected the write to fail");
}

/** A booking a customer's assistant made for Thursday at 12:00 (or `start`), confirmed. */
async function confirmedBooking(s: Setup, start = THU_12) {
  const r = await s.caps.createBooking(anon(), {
    payload: {
      reservationFor: { serviceId: s.svc, name: "Full service" },
      startTime: iso(start),
      endTime: iso(start + 90 * MIN),
    },
    contact: { name: "Rita", email: "rita@example.com", locale: "en" },
  });
  const id = r.view.item.id;
  await transitionItem(s.db, owner, { itemId: id, event: "confirm" });
  await s.drain();
  return { id, token: r.accessToken as string };
}

/** An order the customer's assistant made for two chains, accepted and paid (€37.00). */
async function paidOrder(s: Setup) {
  const r = await s.caps.createOrder(anon(), {
    payload: { orderedItem: [{ productId: s.chain, name: "x", quantity: 2, price: EUR(1) }], totalPrice: EUR(1) },
    contact: { name: "Rita", email: "rita@example.com", locale: "en" },
  });
  const id = r.view.item.id;
  await transitionItem(s.db, owner, { itemId: id, event: "accept" });
  await transitionItem(s.db, shop, {
    itemId: id,
    event: "record_payment",
    input: { paymentRef: "pi_1", amount: EUR(3700) },
  });
  await s.drain();
  return { id, token: r.accessToken as string };
}

/** The item's earliest promise, as a network reads it. */
async function promiseOf(db: Db, itemId: string) {
  return (await receiptsOf(db, itemId)).find((r) => ["confirmed", "accepted", "paid"].includes(r.kind));
}

/**
 * Every amendment stays within what a network honours without an acknowledgement (A3.1): its `due`,
 * and the date R30 reads (a booking's `end`, else `due`), each within 90 days of the promise's.
 */
async function withinNetworkLimits(db: Db, itemId: string) {
  const promise = await promiseOf(db, itemId);
  const amended = (await receiptsOf(db, itemId)).filter((r) => r.kind === "amended");
  expect(amended.length).toBeLessThanOrEqual(3);
  const r30 = (c: Claims | undefined) => Number(c?.end ?? c?.due ?? 0);
  for (const a of amended) {
    expect(Math.abs(a.claims.due - (promise?.claims.due ?? 0))).toBeLessThanOrEqual(90 * 86_400);
    expect(Math.abs(r30(a.claims) - r30(promise?.claims))).toBeLessThanOrEqual(90 * 86_400);
  }
}

describe("the limits on changes are the network's, measured from the date it was sent", () => {
  it("an order due some days after it was accepted: raising that setting later does not buy more room", async () => {
    const s = await setup();
    const r = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ productId: s.chain, name: "x", quantity: 2, price: EUR(1) }], totalPrice: EUR(1) },
      contact: { name: "Rita", email: "rita@example.com", locale: "en" },
    });
    const id = r.view.item.id;
    await transitionItem(s.db, owner, { itemId: id, event: "accept" });
    await s.drain();
    const promise = await promiseOf(s.db, id);
    // Due 30 days after it was accepted, as its promise says to every network.
    expect(promise?.claims.due).toBe(secs(T0) + 30 * 86_400);

    // The owner then says orders with no date are due in a year…
    await s.caps.updateSettings(owner, { doc: { orders: { dueDays: 365 } } });
    // …and proposes a delivery 300 days out: within 90 of a year, 270 days past the date the network holds.
    const far = T0 + 300 * DAY;
    const e = await fail(
      transitionItem(s.db, owner, {
        itemId: id,
        event: "propose_change",
        input: { delivery: { method: "delivery", when: iso(far) } },
      }),
    );
    expect(e.details).toMatchObject({ guard: "changes_left", reason: "shift" });
    await withinNetworkLimits(s.db, id);
  });

  it("a booking kept before offers were: its second move is measured from the first promise, not the first move", async () => {
    const s = await setup();
    const b = await confirmedBooking(s);
    // Promised before this release kept offers: no row, no pointer.
    await s.db.client.batch([
      { sql: "DELETE FROM item_offers WHERE item_id = ?", params: [b.id], method: "run" },
      {
        sql: "UPDATE items SET payload = json_remove(payload, '$.offer') WHERE id = ?",
        params: [b.id],
        method: "run",
      },
    ]);
    const move = async (to: number) => {
      await transitionItem(s.db, owner, { itemId: b.id, event: "propose_change", input: { startTime: iso(to) } });
      await transitionItem(s.db, anon(b.token), { itemId: b.id, event: "accept_change" });
      await s.drain();
    };
    // 80 days later: within the 90.
    await move(THU_12 + 80 * DAY);
    // Another 80: 160 days from the date first promised.
    const e = await fail(
      transitionItem(s.db, owner, {
        itemId: b.id,
        event: "propose_change",
        input: { startTime: iso(THU_12 + 160 * DAY) },
      }),
    );
    expect(e.details).toMatchObject({ guard: "changes_left", reason: "shift" });
    await withinNetworkLimits(s.db, b.id);
  });
});

describe("a booking's end is held to the limits as its start is", () => {
  it("a long booking moved 89 days whose end moves more than 90: refused, as a network would not honour it", async () => {
    const s = await setup();
    // Boat hire by the half day: a booking may run to 96 slots, sixteen days.
    const boat = ulid();
    await s.db.orm.insert(services).values({
      id: boat,
      name: "Boat hire",
      durationMin: 240,
      capacity: 1,
      granularityMin: 240,
      price: { model: "fixed", value: 9000, currency: "EUR" },
      createdAt: T0,
      updatedAt: T0,
    });
    const start = Date.parse("2026-10-05T08:00:00Z");
    const r = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: boat, name: "Boat hire" },
        startTime: iso(start),
        endTime: iso(start + 4 * HOUR),
      },
      contact: { name: "Ana", email: "ana@example.com", locale: "en" },
    });
    const id = r.view.item.id;
    await transitionItem(s.db, owner, { itemId: id, event: "confirm" });
    await s.drain();
    // The start 89 days on, within the 90; the end fifteen days after that, 104 days past the one promised.
    // A network would hold the business to the first end and count the booking unclosed nine days after it.
    const moved = start + 89 * DAY;
    const e = await fail(
      transitionItem(s.db, owner, {
        itemId: id,
        event: "propose_change",
        input: { startTime: iso(moved), endTime: iso(moved + 15 * DAY) },
      }),
    );
    expect(e.details).toMatchObject({ guard: "changes_left", reason: "shift" });
    // Within both, it goes.
    await transitionItem(s.db, owner, {
      itemId: id,
      event: "propose_change",
      input: { startTime: iso(moved), endTime: iso(moved + 12 * HOUR) },
    });
    await transitionItem(s.db, anon(r.accessToken as string), { itemId: id, event: "accept_change" });
    await s.drain();
    expect((await receiptsOf(s.db, id)).filter((x) => x.kind === "amended")).toHaveLength(1);
    await withinNetworkLimits(s.db, id);
  });
});

describe("an order changed without a delivery date keeps the date it had", () => {
  it("brought forward, then switched to collection with no date: still due on the date agreed last", async () => {
    const s = await setup();
    const r = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ productId: s.chain, name: "x", quantity: 2, price: EUR(1) }], totalPrice: EUR(1) },
      contact: { name: "Rita", email: "rita@example.com", locale: "en" },
    });
    const id = r.view.item.id;
    const token = r.accessToken as string;
    await transitionItem(s.db, owner, { itemId: id, event: "accept" });
    await s.drain();
    // Delivered in 20 days, not 30.
    const soon = T0 + 20 * DAY;
    await transitionItem(s.db, owner, {
      itemId: id,
      event: "propose_change",
      input: { delivery: { method: "delivery", when: iso(soon) } },
    });
    await transitionItem(s.db, anon(token), { itemId: id, event: "accept_change" });
    await s.drain();
    // Then collected instead, with no date named.
    clock.now = T0 + HOUR;
    await transitionItem(s.db, owner, {
      itemId: id,
      event: "propose_change",
      input: { delivery: { method: "pickup" } },
    });
    await transitionItem(s.db, anon(token), { itemId: id, event: "accept_change" });
    await s.drain();
    const amended = (await receiptsOf(s.db, id)).filter((x) => x.kind === "amended");
    expect(amended.map((x) => x.claims.due)).toEqual([secs(soon), secs(soon)]);

    clock.now = T0 + 2 * DAY;
    await transitionItem(s.db, owner, { itemId: id, event: "fulfil", input: { deliveredAt: iso(clock.now) } });
    await s.drain();
    const outcome = (await receiptsOf(s.db, id)).find((x) => x.kind === "outcome");
    expect(outcome?.claims.due).toBe(secs(soon));
  });
});

describe("a promise signed after a change still says what was promised when it was made", () => {
  it("its dates and its terms are the ones agreed then; the change is the amendment's", async () => {
    const s = await setup();
    await s.networkOn();
    await s.rules(6);
    const b = await confirmedBooking(s);
    // The promise's receipt did not get signed in time (its job failed, or it waited for a first
    // contact's answer): none yet when the change is agreed.
    await s.db.client.batch([
      { sql: "DELETE FROM network_publications", method: "run" },
      { sql: "DELETE FROM receipts WHERE item_id = ?", params: [b.id], method: "run" },
    ]);
    clock.now = T0 + HOUR;
    await transitionItem(s.db, anon(b.token), {
      itemId: b.id,
      event: "propose_change",
      input: { startTime: iso(FRI_14) },
    });
    await transitionItem(s.db, owner, { itemId: b.id, event: "accept_change" });
    await s.drain();

    const all = await receiptsOf(s.db, b.id);
    const promise = all.find((x) => x.kind === "confirmed");
    const amended = all.find((x) => x.kind === "amended");
    // Signed with the time it was made, and so with what was agreed at that time.
    expect(promise?.claims.due).toBe(secs(THU_12));
    expect(promise?.claims.end).toBe(secs(THU_12 + 90 * MIN));
    expect(amended?.claims.due).toBe(secs(FRI_14));
    const { rows } = await s.db.client.query({
      sql: "SELECT id, terms_sha FROM item_offers WHERE item_id = ? AND kind <> 'change' AND status = 'accepted' ORDER BY rev DESC LIMIT 1",
      params: [b.id],
      method: "all",
    });
    expect(promise?.claims.trm).toBe(await s.trmFor(String(rows[0]?.[0]), String(rows[0]?.[1])));
    expect(promise?.claims.trm).not.toBe(amended?.claims.trm);
  });
});

describe("changes agreed in the same second", () => {
  it("the one agreed last is the latest, as a network orders them (iat, then nonce), every time", async () => {
    const s = await setup();
    // Two assistants answering each other at machine speed: two moves inside one second, on eight
    // bookings, so a coin toss between the two would show.
    for (let i = 0; i < 8; i++) {
      clock.now = T0 + i * HOUR;
      const b = await confirmedBooking(s, THU_12 + i * DAY);
      clock.now = T0 + i * HOUR + 30 * MIN;
      const first = THU_12 + i * DAY + 2 * HOUR;
      const second = THU_12 + i * DAY + 40 * DAY;
      for (const to of [first, second]) {
        await transitionItem(s.db, owner, { itemId: b.id, event: "propose_change", input: { startTime: iso(to) } });
        await transitionItem(s.db, anon(b.token), { itemId: b.id, event: "accept_change" });
      }
      await s.drain();
      const amended = (await receiptsOf(s.db, b.id)).filter((r) => r.kind === "amended");
      expect(amended.map((a) => a.claims.iat)).toEqual([amended[0]?.claims.iat, amended[0]?.claims.iat]);
      const latest = [...amended]
        .sort((a, b) => a.claims.iat - b.claims.iat || a.claims.nonce.localeCompare(b.claims.nonce))
        .at(-1);
      expect(latest?.claims.due).toBe(secs(second));
      clock.now = second + 2 * HOUR;
      await transitionItem(s.db, owner, { itemId: b.id, event: "complete" });
      await s.drain();
      expect((await receiptsOf(s.db, b.id)).find((r) => r.kind === "outcome")?.claims.due).toBe(secs(second));
    }
  });

  it("the same second, even when the earlier one's nonce leaves almost no room after it", async () => {
    const s = await setup();
    const b = await confirmedBooking(s);
    clock.now = T0 + 30 * MIN;
    await transitionItem(s.db, owner, { itemId: b.id, event: "propose_change", input: { startTime: iso(FRI_14) } });
    await transitionItem(s.db, anon(b.token), { itemId: b.id, event: "accept_change" });
    await s.drain();
    // The first amendment drew the greatest nonce but one: one value is left after it. Drawing whole
    // nonces until one lands there would miss it every time and date the later change a second on.
    await s.db.client.query({
      sql: "UPDATE receipts SET payload = json_set(payload, '$.nonce', ?) WHERE item_id = ? AND kind = 'amended'",
      params: [`${"f".repeat(31)}e`, b.id],
      method: "run",
    });
    await transitionItem(s.db, owner, {
      itemId: b.id,
      event: "propose_change",
      input: { startTime: iso(FRI_14 + 2 * HOUR) },
    });
    await transitionItem(s.db, anon(b.token), { itemId: b.id, event: "accept_change" });
    await s.drain();
    const amended = (await receiptsOf(s.db, b.id)).filter((r) => r.kind === "amended");
    // By what each moved the booking to: the later change is after the earlier, in the same second.
    expect(
      amended.map((a) => [a.claims.due, a.claims.iat, a.claims.nonce]).sort((x, y) => Number(x[0]) - Number(y[0])),
    ).toEqual([
      [secs(FRI_14), secs(clock.now), `${"f".repeat(31)}e`],
      [secs(FRI_14 + 2 * HOUR), secs(clock.now), "f".repeat(32)],
    ]);
  });
});

describe("a return whose goods came back", () => {
  it("is not the customer's to drop by a click: the business holds the goods, and owes the money by its date", async () => {
    const s = await setup();
    const o = await paidOrder(s);
    clock.now = T0 + DAY;
    await transitionItem(s.db, owner, { itemId: o.id, event: "fulfil", input: { deliveredAt: iso(T0 + DAY) } });
    clock.now = T0 + 2 * DAY;
    const ret = await transitionItem(s.db, anon(o.token), {
      itemId: o.id,
      event: "request_return",
      input: { reasonCode: "changed_mind", lines: [{ index: 0, quantity: 1 }] },
    });
    const refundId = ret.linked?.item.id as string;
    clock.now = T0 + 5 * DAY;
    await transitionItem(s.db, owner, { itemId: refundId, event: "goods_back" });
    await s.drain();
    expect((await itemOf(s.db, refundId)).state).toBe("goods_received");

    // A confused customer, or their assistant, presses "Cancel the return" once the shop has the goods.
    await fail(transitionItem(s.db, anon(o.token), { itemId: refundId, event: "cancel" }));
    expect((await itemOf(s.db, refundId)).state).toBe("goods_received");
    // What was promised stays open until it is paid.
    expect((await receiptsOf(s.db, refundId)).map((x) => x.outcome || x.kind)).toEqual(["accepted"]);
  });
});

describe("a refund that owes nothing", () => {
  it("promises nothing: an order paid on delivery comes back, and no kept refund can be minted from it", async () => {
    const s = await setup();
    // Accepted and delivered, to be paid on delivery or on account: nothing paid yet.
    const r = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ productId: s.chain, name: "x", quantity: 3, price: EUR(1) }], totalPrice: EUR(1) },
      contact: { name: "Rita", email: "rita@example.com", locale: "en" },
    });
    const id = r.view.item.id;
    await transitionItem(s.db, owner, { itemId: id, event: "accept" });
    clock.now = T0 + DAY;
    await transitionItem(s.db, owner, { itemId: id, event: "fulfil", input: { deliveredAt: iso(T0 + DAY) } });
    await s.drain();
    // One unit at a time, the business writes down a return, takes the goods back and "refunds" nothing.
    const minted: string[] = [];
    for (let i = 0; i < 3; i++) {
      clock.now = T0 + (2 + i) * DAY;
      const ret = await transitionItem(s.db, owner, {
        itemId: id,
        event: "open_return",
        input: { reasonCode: "changed_mind", lines: [{ index: 0, quantity: 1 }], note: "She rang" },
      });
      const refundId = ret.linked?.item.id as string;
      const refund = await itemOf(s.db, refundId);
      expect((refund.payload as { amount: { value: number } }).amount.value).toBe(0);
      if (refund.state === "requested") {
        await transitionItem(s.db, owner, { itemId: refundId, event: "approve", input: { goodsBack: true } });
      }
      await transitionItem(s.db, owner, { itemId: refundId, event: "goods_back" });
      await transitionItem(s.db, owner, { itemId: refundId, event: "refund", input: { paymentRef: "none" } });
      await s.drain();
      minted.push(...(await receiptsOf(s.db, refundId)).map((x) => x.outcome || x.kind));
    }
    expect(minted).toEqual([]);
  });
});
