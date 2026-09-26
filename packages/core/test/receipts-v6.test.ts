import { logMailOut, runMigrations } from "@surfingdog/platform";
import { parseReceiptClaims, receiptPayloadV2Schema } from "@surfingdog/spec";
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
import { type Caller, createItem, rowToItem, transitionItem, WriteError } from "../src/write/index";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * Rules version 6's receipts as the inbox issues them (ADR-017 Amendment 3, ADR-018 §8): a change
 * both sides agreed is an `amended` receipt, and the outcome reads its dates; a refund has its own
 * promise and outcome, following the order it refunds; a promise carries `trm` only where every
 * network it goes to takes version 6; and a promise a network holds moves only once every such
 * network applies version 6. Nothing here is ever a row against a customer.
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
/** Monday 28 September, 10:00 in Lisbon. */
const MON_10 = Date.parse("2026-09-28T09:00:00Z");

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

async function acceptedChanges(db: Db, itemId: string) {
  const { rows } = await db.client.query({
    sql: "SELECT id, terms_sha, by FROM item_offers WHERE item_id = ? AND kind = 'change' AND status = 'accepted' ORDER BY rev",
    params: [itemId],
    method: "all",
  });
  return rows.map((r) => ({ id: String(r[0]), termsSha: String(r[1]), by: String(r[2]) }));
}

async function eventTime(db: Db, itemId: string, event: string): Promise<number> {
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

describe("a change both sides agreed", () => {
  it("is an amended receipt with the new dates, the terms' fingerprint and who said yes; the outcome reads the latest", async () => {
    const s = await setup();
    const b = await confirmedBooking(s);
    const [promise] = await receiptsOf(s.db, b.id);
    expect(promise?.kind).toBe("confirmed");

    // The customer asks to move it to Friday, and we say yes.
    clock.now = T0 + HOUR;
    await transitionItem(s.db, anon(b.token), {
      itemId: b.id,
      event: "propose_change",
      input: { startTime: iso(FRI_14) },
    });
    await transitionItem(s.db, owner, { itemId: b.id, event: "accept_change" });
    await s.drain();
    // Then we ask to move it to Monday, and the customer says yes.
    clock.now = T0 + 2 * HOUR;
    await transitionItem(s.db, owner, { itemId: b.id, event: "propose_change", input: { startTime: iso(MON_10) } });
    await transitionItem(s.db, anon(b.token), { itemId: b.id, event: "accept_change" });
    await s.drain();

    const changes = await acceptedChanges(s.db, b.id);
    expect(changes.map((c) => c.by)).toEqual(["customer", "business"]);
    const amended = (await receiptsOf(s.db, b.id)).filter((r) => r.kind === "amended");
    expect(amended.map((r) => r.offerId)).toEqual(changes.map((c) => c.id));
    const [first, second] = amended as [(typeof amended)[number], (typeof amended)[number]];
    expect(first.claims).toMatchObject({
      typ: "booking",
      knd: "amended",
      ver: 2,
      ref: promise?.claims.nonce,
      due: secs(FRI_14),
      end: secs(FRI_14 + 90 * MIN),
      trm: await s.trmFor(changes[0]?.id as string, changes[0]?.termsSha as string),
      acc: "business",
      iat: secs(T0 + HOUR),
    });
    expect(second.claims).toMatchObject({
      ref: promise?.claims.nonce,
      due: secs(MON_10),
      end: secs(MON_10 + 90 * MIN),
      trm: await s.trmFor(changes[1]?.id as string, changes[1]?.termsSha as string),
      acc: "customer",
      iat: secs(await eventTime(s.db, b.id, "accept_change")),
    });
    for (const r of amended) {
      expect(receiptPayloadV2Schema.safeParse(r.claims).success).toBe(true);
      // Bound under the offer's own key: never the bare fingerprint anyone could test guesses against.
      expect(changes.map((c) => c.termsSha)).not.toContain(r.claims.trm);
      // About the business's promise, not the person: no presentation.
      expect(r.claims.per).toBeUndefined();
      // A network on rules 5 refuses it: it is sent only to one on rules 6.
      expect(parseReceiptClaims(r.claims, { rules: 5 })).toBeNull();
    }
    // The promise keeps the date first agreed: an amendment moves it, the receipt stays as signed.
    expect(promise?.claims.due).toBe(secs(THU_12));

    // Completed at its new time: the outcome closes the earliest promise, at the latest agreed dates.
    await transitionItem(s.db, owner, { itemId: b.id, event: "complete" });
    await s.drain();
    const outcome = (await receiptsOf(s.db, b.id)).find((r) => r.kind === "outcome");
    expect(outcome?.claims).toMatchObject({
      out: "booking.completed",
      ref: promise?.claims.nonce,
      due: secs(MON_10),
      end: secs(MON_10 + 90 * MIN),
    });
  });

  it("a change to an order's delivery date moves its due; one to its quantities keeps the date first agreed", async () => {
    const s = await setup();
    const r = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ productId: s.chain, name: "x", quantity: 2, price: EUR(1) }], totalPrice: EUR(1) },
      contact: { name: "Rita", email: "rita@example.com", locale: "en" },
    });
    const id = r.view.item.id;
    await transitionItem(s.db, owner, { itemId: id, event: "accept" });
    await s.drain();
    const [promise] = await receiptsOf(s.db, id);
    // Three chains instead of two: nothing about when.
    await transitionItem(s.db, anon(r.accessToken as string), {
      itemId: id,
      event: "propose_change",
      input: { lines: [{ index: 0, quantity: 3 }] },
    });
    await transitionItem(s.db, owner, { itemId: id, event: "accept_change" });
    await s.drain();
    // Then a date: delivered on the 2nd of October.
    const when = Date.parse("2026-10-02T10:00:00Z");
    await transitionItem(s.db, owner, {
      itemId: id,
      event: "propose_change",
      input: { delivery: { method: "delivery", when: iso(when) } },
    });
    await transitionItem(s.db, anon(r.accessToken as string), { itemId: id, event: "accept_change" });
    await s.drain();
    const amended = (await receiptsOf(s.db, id)).filter((x) => x.kind === "amended");
    expect(amended.map((x) => x.claims.due)).toEqual([promise?.claims.due, secs(when)]);
    expect(amended.map((x) => x.claims.acc)).toEqual(["business", "customer"]);
    for (const a of amended) expect(a.claims.end).toBeUndefined();
  });

  it("a booking the business wrote down itself records no change: its promise names no date to anyone", async () => {
    const s = await setup();
    const mine = await createItem(s.db, owner, {
      type: "booking",
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: iso(THU_12),
        endTime: iso(THU_12 + 90 * MIN),
      },
      contact: { name: "Rui" },
    });
    const id = mine.view.item.id;
    await transitionItem(s.db, owner, { itemId: id, event: "confirm" });
    await transitionItem(s.db, owner, { itemId: id, event: "propose_change", input: { startTime: iso(FRI_14) } });
    await transitionItem(s.db, owner, { itemId: id, event: "accept_change", input: { note: "Rui said yes" } });
    await s.drain();
    expect((await receiptsOf(s.db, id)).map((r) => r.kind)).toEqual(["confirmed"]);
  });
});

describe("where a network holds the promise", () => {
  it("a change waits for every network to apply rules version 6: announced is not enough", async () => {
    const s = await setup();
    const b = await confirmedBooking(s);
    await s.networkOn();
    // Version 6 announced, not in force: the network takes amendments, and still holds the old date.
    await s.rules(5, 6);
    const ours = await fail(
      transitionItem(s.db, owner, { itemId: b.id, event: "propose_change", input: { startTime: iso(FRI_14) } }),
    );
    expect(ours.details).toMatchObject({ guard: "amendments_live" });
    const theirs = await fail(
      transitionItem(s.db, anon(b.token), { itemId: b.id, event: "propose_change", input: { startTime: iso(FRI_14) } }),
    );
    expect(theirs.details).toMatchObject({ guard: "amendments_live" });

    // In force: the change is recorded, and its receipt queued for the network.
    await s.rules(6);
    await transitionItem(s.db, anon(b.token), {
      itemId: b.id,
      event: "propose_change",
      input: { startTime: iso(FRI_14) },
    });
    await transitionItem(s.db, owner, { itemId: b.id, event: "accept_change" });
    await s.drain();
    const { rows } = await s.db.client.query({
      sql: `SELECT r.kind, p.network, p.state FROM network_publications p JOIN receipts r ON r.id = p.receipt_id
             WHERE r.item_id = ? ORDER BY r.id`,
      params: [b.id],
      method: "all",
    });
    // The amendment is queued at once; the promise it moves, issued before the network was on, goes
    // with the network's backfill, ahead of it.
    expect(rows.map((r) => r.map(String))).toEqual([["amended", NET, "queued"]]);
  });

  it("a network that took the promise and was switched off still holds it: its rules decide", async () => {
    const s = await setup();
    const b = await confirmedBooking(s);
    await s.networkOn();
    await s.rules(5);
    const [promise] = (
      await s.db.client.query({ sql: "SELECT id FROM receipts WHERE item_id = ?", params: [b.id], method: "all" })
    ).rows;
    await s.db.client.query({
      sql: "INSERT INTO network_publications (receipt_id, network, stage, state, attempts, updated_at) VALUES (?, ?, 'issued', 'published', 1, ?)",
      params: [String(promise?.[0]), NET, clock.now],
      method: "run",
    });
    await s.caps.updateSettings(owner, { doc: { networks: { [NET]: { enabled: false } } } });
    const off = await fail(
      transitionItem(s.db, owner, { itemId: b.id, event: "propose_change", input: { startTime: iso(FRI_14) } }),
    );
    expect(off.details).toMatchObject({ guard: "amendments_live" });
    await s.rules(6);
    await transitionItem(s.db, owner, { itemId: b.id, event: "propose_change", input: { startTime: iso(FRI_14) } });
  });
});

describe("the terms both sides agreed, on a promise", () => {
  const trmOf = async (s: Setup, id: string) =>
    (await receiptsOf(s.db, id)).find((r) => r.kind === "confirmed")?.claims.trm;
  const agreed = async (s: Setup, id: string) => {
    const { rows } = await s.db.client.query({
      sql: "SELECT id, terms_sha FROM item_offers WHERE item_id = ? AND status = 'accepted' ORDER BY rev DESC LIMIT 1",
      params: [id],
      method: "all",
    });
    return { id: String(rows[0]?.[0]), termsSha: String(rows[0]?.[1]) };
  };

  it("go only where every network the promise goes to takes rules version 6", async () => {
    const s = await setup();
    // No network: nothing reads them, and a network switched on later might not.
    const alone = await confirmedBooking(s);
    expect(await trmOf(s, alone.id)).toBeUndefined();
    // A network on rules 5 with nothing announced ignores them: none sent.
    await s.networkOn();
    await s.rules(5);
    clock.now = T0 + 10 * MIN;
    const four = await confirmedBooking(s, MON_10);
    expect(await trmOf(s, four.id)).toBeUndefined();
    // Version 6 announced: the promise carries the fingerprint of the terms agreed.
    await s.rules(5, 6);
    clock.now = T0 + 3 * HOUR;
    const r = await s.caps.createBooking(anon(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: iso(FRI_14),
        endTime: iso(FRI_14 + 90 * MIN),
      },
      contact: { name: "Ana", email: "ana@example.com", locale: "en" },
    });
    await transitionItem(s.db, owner, { itemId: r.view.item.id, event: "confirm" });
    await s.drain();
    const trm = await trmOf(s, r.view.item.id);
    const offer = await agreed(s, r.view.item.id);
    expect(trm).toBe(await s.trmFor(offer.id, offer.termsSha));
    // Not the bare fingerprint: a network holding the receipt cannot test which service, or how many, by guessing.
    expect(trm).not.toBe(offer.termsSha);
    // A reader on rules 5 keeps the promise and drops what it does not know.
    const claims = (await receiptsOf(s.db, r.view.item.id))[0]?.claims as Claims;
    expect(parseReceiptClaims(claims, { rules: 5 })?.claims).not.toHaveProperty("trm");
  });
});

describe("a refund's receipts", () => {
  it("a paid order we cancel owes a refund at once: promised then, kept when paid by its date", async () => {
    const s = await setup();
    const o = await paidOrder(s);
    clock.now = T0 + HOUR;
    const r = await transitionItem(s.db, owner, { itemId: o.id, event: "cancel", input: { note: "Out of stock" } });
    const refundId = r.linked?.item.id as string;
    await s.drain();
    const refund = await itemOf(s.db, refundId);
    const due = Date.parse((refund.payload as { refundDue: string }).refundDue);
    const [promise] = await receiptsOf(s.db, refundId);
    expect(promise?.kind).toBe("accepted");
    expect(promise?.claims).toMatchObject({
      typ: "refund",
      knd: "accepted",
      ver: 2,
      itm: refundId,
      due: secs(due),
      amt: EUR(3700),
      iat: secs(T0 + HOUR),
    });
    expect(promise?.claims.trm).toBeUndefined();
    // The same person as the order's receipts: one pseudonym.
    const [orderPromise] = await receiptsOf(s.db, o.id);
    expect(promise?.claims.sub).toBe(orderPromise?.claims.sub);
    expect(parseReceiptClaims(promise?.claims, { rules: 5 })).toBeNull();

    clock.now = due - DAY;
    await transitionItem(s.db, shop, { itemId: refundId, event: "refund", input: { paymentRef: "re_1" } });
    await s.drain();
    const outcome = (await receiptsOf(s.db, refundId)).find((x) => x.kind === "outcome");
    expect(outcome?.claims).toMatchObject({
      typ: "refund",
      out: "refund.honoured",
      ref: promise?.claims.nonce,
      due: secs(due),
    });
    expect(outcome?.claims.aut).toBeUndefined();
    // The order's own outcome stands as it was: the business did not fulfil it.
    expect((await receiptsOf(s.db, o.id)).find((x) => x.kind === "outcome")?.outcome).toBe("order.not_fulfilled");
  });

  it("paid after its date, the refund is late", async () => {
    const s = await setup();
    const o = await paidOrder(s);
    const r = await transitionItem(s.db, owner, { itemId: o.id, event: "cancel" });
    const refundId = r.linked?.item.id as string;
    const due = Date.parse(((await itemOf(s.db, refundId)).payload as { refundDue: string }).refundDue);
    clock.now = due + 2 * DAY;
    await transitionItem(s.db, owner, { itemId: refundId, event: "refund", input: { paymentRef: "re_2" } });
    await s.drain();
    expect((await receiptsOf(s.db, refundId)).map((x) => x.outcome || x.kind)).toEqual(["accepted", "refund.late"]);
  });

  it("goods to come back: no promise until they do; dropped before, nothing; after, neutral", async () => {
    const s = await setup();
    const o = await paidOrder(s);
    clock.now = T0 + DAY;
    await transitionItem(s.db, owner, { itemId: o.id, event: "fulfil", input: { deliveredAt: iso(T0 + DAY) } });
    // The customer withdraws within the period: agreed at once, the goods to come back first.
    clock.now = T0 + 3 * DAY;
    const first = await transitionItem(s.db, anon(o.token), {
      itemId: o.id,
      event: "request_return",
      input: { reasonCode: "changed_mind", lines: [{ index: 0, quantity: 1 }] },
    });
    const firstId = first.linked?.item.id as string;
    expect((await itemOf(s.db, firstId)).state).toBe("approved");
    await s.drain();
    expect(await receiptsOf(s.db, firstId)).toEqual([]);
    // They keep it after all: nothing was promised, so nothing closes.
    await transitionItem(s.db, anon(o.token), { itemId: firstId, event: "cancel" });
    await s.drain();
    expect(await receiptsOf(s.db, firstId)).toEqual([]);

    // Another return: the goods arrive, and the date is fixed, and promised.
    clock.now = T0 + 4 * DAY;
    const second = await transitionItem(s.db, anon(o.token), {
      itemId: o.id,
      event: "request_return",
      input: { reasonCode: "changed_mind", lines: [{ index: 0, quantity: 1 }] },
    });
    const secondId = second.linked?.item.id as string;
    clock.now = T0 + 6 * DAY;
    await transitionItem(s.db, owner, { itemId: secondId, event: "goods_back" });
    await s.drain();
    const [promise] = await receiptsOf(s.db, secondId);
    const due = Date.parse(((await itemOf(s.db, secondId)).payload as { refundDue: string }).refundDue);
    expect(promise?.claims).toMatchObject({ typ: "refund", knd: "accepted", due: secs(due), iat: secs(T0 + 6 * DAY) });
    // The customer tells a person they will keep it after all.
    await transitionItem(s.db, owner, { itemId: secondId, event: "record_cancel", input: { note: "She kept it" } });
    await s.drain();
    expect((await receiptsOf(s.db, secondId)).map((x) => x.outcome || x.kind)).toEqual([
      "accepted",
      "refund.cancelled_by_customer",
    ]);
    // The order was kept, and stays kept.
    expect((await receiptsOf(s.db, o.id)).filter((x) => x.kind === "outcome").map((x) => x.outcome)).toEqual([
      "order.fulfilled",
    ]);
  });

  it("follows the order it refunds: one the business wrote down itself has no refund receipts", async () => {
    const s = await setup();
    const mine = await createItem(s.db, owner, {
      type: "order",
      payload: {
        orderedItem: [{ productId: s.chain, name: "Chain", quantity: 1, price: EUR(1850) }],
        totalPrice: EUR(1850),
      },
      contact: { name: "Rui" },
    });
    const id = mine.view.item.id;
    await transitionItem(s.db, owner, { itemId: id, event: "accept" });
    await transitionItem(s.db, owner, {
      itemId: id,
      event: "record_payment",
      input: { paymentRef: "cash", amount: EUR(1850) },
    });
    const r = await transitionItem(s.db, owner, { itemId: id, event: "cancel" });
    const refundId = r.linked?.item.id as string;
    await transitionItem(s.db, owner, { itemId: refundId, event: "refund", input: { paymentRef: "cash" } });
    await s.drain();
    expect(await receiptsOf(s.db, refundId)).toEqual([]);
  });

  it("paid before any date was fixed: promised and kept at once", async () => {
    const s = await setup();
    const o = await paidOrder(s);
    clock.now = T0 + DAY;
    await transitionItem(s.db, owner, { itemId: o.id, event: "fulfil", input: { deliveredAt: iso(T0 + DAY) } });
    clock.now = T0 + 2 * DAY;
    const ret = await transitionItem(s.db, anon(o.token), {
      itemId: o.id,
      event: "request_return",
      input: { reasonCode: "changed_mind" },
    });
    const refundId = ret.linked?.item.id as string;
    // The shop refunds before the goods are back.
    clock.now = T0 + 3 * DAY;
    await transitionItem(s.db, shop, { itemId: refundId, event: "refund", input: { paymentRef: "re_3" } });
    await s.drain();
    const rs = await receiptsOf(s.db, refundId);
    expect(rs.map((x) => x.outcome || x.kind)).toEqual(["accepted", "refund.honoured"]);
    expect(rs[0]?.claims).toMatchObject({ due: secs(T0 + 3 * DAY), iat: secs(T0 + 3 * DAY) });
  });
});
