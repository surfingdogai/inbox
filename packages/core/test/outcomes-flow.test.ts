import { logMailOut, runMigrations } from "@surfingdog/platform";
import type { ReceiptPayloadV2 } from "@surfingdog/spec";
import { receiptPayloadV2Schema } from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { ensureLifecycleSweep, LIFECYCLE_SWEEP_KIND, lifecycleSweepHandler } from "../src/jobs/lifecycle";
import type { ReceiptView } from "../src/receipts/capabilities";
import {
  ACK_TYP,
  ALG,
  b64u,
  generateKeyPair,
  newNonce,
  receiptSha,
  signReceipt,
  verifyReceipt,
} from "../src/receipts/sign";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { itemEvents, itemPresentations, jobs, services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import type { Caller } from "../src/write/caller";
import { createItem } from "../src/write/create";
import { setFlags } from "../src/write/flags";
import { transitionItem } from "../src/write/transition";
import { makeClient, resetTables } from "./harness";

/**
 * Outcomes end to end (ADR-017 §3): every way a booking or an order closes its promise, as the
 * owner, the customer and the lifecycle sweep reach it, and the receipt each one issues — claims
 * v2 with `ver`, `due`, `end`, `out`, `ref`, `aut` and `per`, dated by the event that caused it.
 */
const T0 = Date.parse("2026-09-22T09:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEY = "outcome-test-instance-key-0123456789";
const ISS = "https://inbox.oficinamare.pt";

const caller = (
  kind: Caller["actor"]["kind"],
  t: number,
  channel: Caller["actor"]["channel"] = "owner_ui",
): Caller => ({
  actor: { kind, id: kind === "customer_human" ? "form" : `${kind}_1`, channel },
  tier: kind === "customer_human" ? "anonymous" : "verified_principal",
  sandbox: false,
  now: () => t,
});
const owner = (t: number) => caller("owner", t);
const customer = (t: number) => caller("customer_human", t, "form");
const connector = (t: number) => caller("connector", t, "connector");

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Surf lesson",
    durationMin: 90,
    capacity: 5,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  const caps = new Capabilities(db, createSecretBox([KEY]), ISS, 0);
  const runner = createRunner({ mailOut: logMailOut(), receipts: caps.receipts });
  /** Runs every job due at `t`, including the ones those jobs queue. */
  const drain = async (t: number) => {
    for (let i = 0; i < 30; i++) {
      const r = await runner.runDue(db, { now: t, limit: 100 });
      expect(r.failed + r.dead, "a job failed").toBe(0);
      if (r.claimed === 0) return;
    }
  };
  /** The sweep that would run at `t`, and everything it causes. */
  const sweep = async (t: number) => {
    await ensureLifecycleSweep(db, t);
    await drain(t);
  };
  return { db, caps, runner, svc, drain, sweep };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** A customer's booking starting `startIn` after T0, 90 minutes long. */
async function book(s: Setup, startIn = DAY, as: Caller = customer(T0)) {
  const start = T0 + startIn;
  const r = await s.caps.createBooking(as, {
    payload: {
      reservationFor: { serviceId: s.svc, name: "Surf lesson" },
      startTime: new Date(start).toISOString(),
      endTime: new Date(start + 90 * MIN).toISOString(),
      totalPrice: { value: 4500, currency: "EUR" },
    },
    contact: { name: "Rita Amaral", email: "rita@example.com" },
  });
  return { id: r.view.item.id, token: r.accessToken, start, end: start + 90 * MIN };
}

async function order(s: Setup, as: Caller = customer(T0)) {
  const r = await s.caps.createOrder(as, {
    payload: {
      orderedItem: [{ name: "Wax", quantity: 2, price: { value: 800, currency: "EUR" } }],
      totalPrice: { value: 1600, currency: "EUR" },
    },
    contact: { email: "rita@example.com" },
  });
  return { id: r.view.item.id, token: r.accessToken };
}

const fire = (s: Setup, who: Caller, itemId: string, event: string, input?: Record<string, unknown>) =>
  s.caps.transitionItem(who, { item_id: itemId, event, ...(input ? { input } : {}) });

const claims = (r: ReceiptView | undefined) => r?.payload as ReceiptPayloadV2;
const outcomes = async (s: Setup, itemId: string) =>
  (await s.caps.receipts.forItem(itemId)).filter((r) => r.kind === "outcome");
const secs = (ms: number) => Math.floor(ms / 1000);

async function jobNotes(db: Db, kind: string) {
  const rows = await db.orm.select({ kind: jobs.kind, status: jobs.status, note: jobs.lastError }).from(jobs);
  return rows.filter((r) => r.kind === kind).map((r) => r.note ?? "");
}

describe("a booking", () => {
  it("that happened closes with booking.completed, referring to its promise and dated by the event", async () => {
    const s = await setup();
    const b = await book(s);
    await fire(s, owner(T0 + MIN), b.id, "confirm");
    await s.drain(T0 + 2 * MIN);
    await fire(s, owner(b.end + 10 * MIN), b.id, "complete");
    await s.drain(b.end + 11 * MIN);

    const [promise, outcome, ...rest] = await s.caps.receipts.forItem(b.id);
    expect(rest).toEqual([]);
    expect(promise).toMatchObject({ kind: "confirmed", outcome: null });
    expect(outcome).toMatchObject({ kind: "outcome", outcome: "booking.completed" });
    const { keys } = await s.caps.receipts.jwks();
    expect(await verifyReceipt(outcome?.jws ?? "", keys)).toEqual(outcome?.payload);
    expect(receiptPayloadV2Schema.safeParse(outcome?.payload).success).toBe(true);
    expect(claims(outcome)).toEqual({
      iss: ISS,
      sub: claims(promise).sub,
      itm: b.id,
      typ: "booking",
      knd: "outcome",
      iat: secs(b.end + 10 * MIN),
      nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
      ver: 2,
      out: "booking.completed",
      ref: claims(promise).nonce,
      due: secs(b.start),
      end: secs(b.end),
    });
    expect(claims(promise)).toMatchObject({ ver: 2, iat: secs(T0 + MIN), due: secs(b.start), end: secs(b.end) });
    // Each receipt knows the name a network gives it.
    const { rows } = await s.db.client.query({
      sql: "SELECT jws, sha FROM receipts WHERE item_id = ?",
      params: [b.id],
      method: "all",
    });
    for (const r of rows) expect(String(r[1])).toBe(await receiptSha(String(r[0])));
  });

  it("is completed by the system two days after it ended, unless it was a no-show", async () => {
    const s = await setup();
    const happened = await book(s);
    const missed = await book(s, DAY + 2 * HOUR);
    for (const b of [happened, missed]) await fire(s, owner(T0 + MIN), b.id, "confirm");
    await fire(s, owner(missed.end + 30 * MIN), missed.id, "no_show");
    await s.drain(missed.end + 31 * MIN);

    // 47 hours after the end: still the owner's to mark.
    await s.sweep(happened.end + 47 * HOUR);
    expect((await s.caps.getItem(owner(T0), { item_id: happened.id })).item.state).toBe("confirmed");

    const at = happened.end + 48 * HOUR + 1_000;
    await s.sweep(at);
    const detail = await s.caps.getItem(owner(at), { item_id: happened.id });
    expect(detail.item.state).toBe("completed");
    expect(detail.events.at(-1)).toMatchObject({ event: "complete", by: { kind: "system" } });
    const [done] = await outcomes(s, happened.id);
    expect(done).toMatchObject({ outcome: "booking.completed" });
    expect(claims(done)).toMatchObject({ aut: 1, iat: secs(at) });

    // The no-show stays one; the sweep does not overrule the owner.
    await s.sweep(missed.end + 49 * HOUR);
    expect((await s.caps.getItem(owner(T0), { item_id: missed.id })).item.state).toBe("no_show");
    expect((await outcomes(s, missed.id)).map((r) => r.outcome)).toEqual(["booking.no_show_customer"]);
    expect(await jobNotes(s.db, LIFECYCLE_SWEEP_KIND)).toContain("1 completed, 0 lapsed, 0 receipt sha(s)");
  });

  it("marked a no-show by mistake is corrected once, until the window closes", async () => {
    const s = await setup();
    const b = await book(s);
    await fire(s, owner(T0 + MIN), b.id, "confirm");
    await fire(s, owner(b.end + HOUR), b.id, "no_show");
    await s.drain(b.end + HOUR);
    const view = await s.caps.getItem(owner(b.end + HOUR), { item_id: b.id });
    expect(view.transitions.map((t) => [t.event, t.label])).toContainEqual(["complete", "Correct: it happened"]);

    await fire(s, owner(b.end + 2 * HOUR), b.id, "complete");
    await s.drain(b.end + 2 * HOUR);
    const [noShow, completed] = await outcomes(s, b.id);
    expect([noShow?.outcome, completed?.outcome]).toEqual(["booking.no_show_customer", "booking.completed"]);
    // The later one is the one that stands on the customer's side: greatest iat (§3.3).
    expect(claims(completed).iat).toBeGreaterThan(claims(noShow).iat);
    expect(claims(completed).ref).toBe(claims(noShow).ref);

    await expect(fire(s, owner(b.end + 3 * HOUR), b.id, "no_show")).rejects.toMatchObject({
      code: "guard_failed",
      details: { guard: "within_correction_window" },
    });

    // Another: completed, then corrected to a no-show — but not once 48 hours have passed.
    const late = await book(s, DAY + 3 * HOUR);
    await fire(s, owner(T0 + MIN), late.id, "confirm");
    await fire(s, owner(late.end + 5 * MIN), late.id, "complete");
    await expect(fire(s, owner(late.end + 49 * HOUR), late.id, "no_show")).rejects.toMatchObject({
      code: "guard_failed",
    });
    await fire(s, owner(late.end + 47 * HOUR), late.id, "no_show");
    await s.drain(late.end + 47 * HOUR);
    expect((await outcomes(s, late.id)).map((r) => r.outcome)).toEqual([
      "booking.completed",
      "booking.no_show_customer",
    ]);
  });

  it("offers a one-time correction only while it can still be made, wherever actions are listed", async () => {
    const s = await setup();
    const events = (v: { transitions: readonly { event: string }[] }) => v.transitions.map((t) => t.event);
    const b = await book(s);
    await fire(s, owner(T0 + MIN), b.id, "confirm");
    const closed = await fire(s, owner(b.end + HOUR), b.id, "complete");
    // Just completed, inside the window: the correction is offered, on the answer and on a read.
    expect(events(closed.view)).toContain("no_show");
    // A flag changed on the completed booking is not a correction: it is still offered.
    await setFlags(s.db, owner(b.end + 2 * HOUR), { itemId: b.id, flags: { priority: 2 } });
    expect(events(await s.caps.getItem(owner(b.end + 2 * HOUR), { item_id: b.id }))).toContain("no_show");
    // Past the window (48 hours after the end) it is dead: not listed, not on the list, refused.
    const after = b.end + 49 * HOUR;
    expect(events(await s.caps.getItem(owner(after), { item_id: b.id }))).not.toContain("no_show");
    const listed = (await s.caps.listItems(owner(after), { limit: 50, open_only: false, sandbox: false })).items.find(
      (v) => v.item.id === b.id,
    );
    expect(listed && events(listed)).not.toContain("no_show");
    // Nor on the answer to a flag change or to a note.
    expect(events(await setFlags(s.db, owner(after), { itemId: b.id, flags: { priority: 1 } }))).not.toContain(
      "no_show",
    );
    const noted = await s.caps.reply(owner(after), { item_id: b.id, body: "Checked the logbook.", internal: true });
    expect("transitions" in noted && events(noted)).not.toContain("no_show");
    await expect(fire(s, owner(after), b.id, "no_show")).rejects.toMatchObject({ code: "guard_failed" });

    // Once made, the correction back is dead at once, though the window is still open.
    const c = await book(s, DAY + 3 * HOUR);
    await fire(s, owner(T0 + MIN), c.id, "confirm");
    await fire(s, owner(c.end + HOUR), c.id, "no_show");
    const corrected = await fire(s, owner(c.end + 2 * HOUR), c.id, "complete");
    expect(events(corrected.view)).not.toContain("no_show");
    expect(events(await s.caps.getItem(owner(c.end + 3 * HOUR), { item_id: c.id }))).not.toContain("no_show");

    // A charge-back on a completed order is recorded once, and then no longer offered.
    const o = await order(s);
    await fire(s, owner(T0 + MIN), o.id, "accept");
    await fire(s, owner(T0 + 2 * MIN), o.id, "fulfil");
    await fire(s, owner(T0 + 3 * MIN), o.id, "complete");
    expect(events(await s.caps.getItem(owner(T0 + 4 * MIN), { item_id: o.id }))).toContain("record_charge_back");
    const charged = await fire(s, owner(T0 + 5 * MIN), o.id, "record_charge_back");
    expect(events(charged.view)).not.toContain("record_charge_back");
    expect(events(await s.caps.getItem(owner(T0 + 6 * MIN), { item_id: o.id }))).not.toContain("record_charge_back");
  });

  it("cancelled by the business closes a promise only once there is one", async () => {
    const s = await setup();
    const asked = await book(s);
    await fire(s, owner(T0 + MIN), asked.id, "cancel_by_business");
    const promised = await book(s, DAY + 2 * HOUR);
    await fire(s, owner(T0 + MIN), promised.id, "confirm");
    await fire(s, owner(promised.start - 2 * HOUR), promised.id, "cancel_by_business", { note: "storm" });
    await s.drain(promised.start - 2 * HOUR);
    expect(await s.caps.receipts.forItem(asked.id)).toEqual([]);
    const [cancelled] = await outcomes(s, promised.id);
    // Notice is the network's call, from the dates: 2 hours before the start is under 24.
    expect(claims(cancelled)).toMatchObject({
      out: "booking.cancelled_by_business",
      iat: secs(promised.start - 2 * HOUR),
      due: secs(promised.start),
    });
  });

  it("cancelled by the customer: in time is a neutral close, late is recorded, or refused", async () => {
    const s = await setup();
    const inTime = await book(s, 3 * DAY);
    const late = await book(s, 3 * DAY + 2 * HOUR);
    for (const b of [inTime, late]) await fire(s, owner(T0 + MIN), b.id, "confirm");
    await s.drain(T0 + MIN);

    // The customer sees one way to cancel; the inbox picks which it is.
    const status = await s.caps.getItemStatus(customer(T0), { item_id: late.id, access_token: late.token });
    expect(status.transitions.map((t) => t.event)).toEqual(["cancel"]);

    await s.caps.cancelItem(customer(T0 + HOUR), { item_id: inTime.id, access_token: inTime.token });
    const lateCancel = await s.caps.cancelItem(customer(late.start - 3 * HOUR), {
      item_id: late.id,
      access_token: late.token,
      reason: "flight delayed",
      idempotency_key: "cancel-1",
    });
    expect(lateCancel.view.item.state).toBe("cancelled_by_customer");
    // A retry of the same request replays it, whichever event it turned out to be.
    const again = await s.caps.cancelItem(customer(late.start - 3 * HOUR + 5_000), {
      item_id: late.id,
      access_token: late.token,
      reason: "flight delayed",
      idempotency_key: "cancel-1",
    });
    expect(again.replayed).toBe(true);
    await s.drain(late.start - 3 * HOUR);
    expect((await outcomes(s, inTime.id)).map((r) => r.outcome)).toEqual(["booking.cancelled_by_customer"]);
    expect((await outcomes(s, late.id)).map((r) => r.outcome)).toEqual(["booking.cancelled_late_by_customer"]);
    const events = await s.db.orm.select({ event: itemEvents.event }).from(itemEvents);
    expect(events.map((e) => e.event)).toContain("cancel_late");

    // Where the owner refuses late cancellations, the answer is what it always was.
    await s.caps.updateSettings(owner(T0), { doc: { booking: { lateCancellation: "refuse" } } });
    const refused = await book(s, 3 * DAY + 4 * HOUR);
    await fire(s, owner(T0 + MIN), refused.id, "confirm");
    await expect(
      s.caps.cancelItem(customer(refused.start - HOUR), { item_id: refused.id, access_token: refused.token }),
    ).rejects.toMatchObject({ code: "guard_failed", details: { guard: "within_cancellation_window" } });
    // And `cancel_late` cannot be fired past the policy either.
    await expect(
      transitionItem(
        s.db,
        { ...customer(refused.start - HOUR), accessToken: refused.token as string },
        { itemId: refused.id, event: "cancel_late" },
      ),
    ).rejects.toMatchObject({ code: "guard_failed", details: { guard: "outside_cancellation_window" } });
  });

  it("made by the business itself keeps its v1 promise and records no outcome", async () => {
    const s = await setup();
    const b = await book(s, DAY, owner(T0));
    await fire(s, owner(T0 + MIN), b.id, "confirm");
    await fire(s, owner(b.end + MIN), b.id, "complete");
    await s.drain(b.end + MIN);
    const receipts = await s.caps.receipts.forItem(b.id);
    expect(receipts.map((r) => r.kind)).toEqual(["confirmed"]);
    expect(receipts[0]?.payload).not.toHaveProperty("ver");
    expect(await jobNotes(s.db, "issue_receipt")).toContain(
      "the business made this booking itself, so it records no booking.completed receipt (ADR-017 §3.1)",
    );
  });

  it("whose promise was never issued gets it first, dated by the confirmation", async () => {
    const s = await setup();
    const b = await book(s);
    await fire(s, owner(T0 + MIN), b.id, "confirm");
    // The promise's job is lost; the outcome's job makes up for it.
    await s.db.client.query({ sql: "DELETE FROM jobs WHERE kind = 'issue_receipt'", params: [], method: "run" });
    await fire(s, owner(b.end), b.id, "complete");
    await s.drain(b.end + MIN);
    const [promise, outcome] = await s.caps.receipts.forItem(b.id);
    expect(promise?.kind).toBe("confirmed");
    expect(claims(promise).iat).toBe(secs(T0 + MIN));
    expect(claims(outcome).ref).toBe(claims(promise).nonce);
  });

  it("promised under v1 claims is closed by a v2 outcome that refers to it, dated from the item", async () => {
    const s = await setup();
    const b = await book(s);
    await fire(s, owner(T0 + MIN), b.id, "confirm");
    await s.db.client.query({ sql: "DELETE FROM jobs WHERE kind = 'issue_receipt'", params: [], method: "run" });
    // What the previous release issued: v1 claims, and no sha yet.
    const key = await s.caps.receipts.keys.active();
    const legacy = {
      iss: ISS,
      sub: "0wWorHT-zGDpWTirCnd5ixnX05zWga0OGKCyrQ6VfB0",
      itm: b.id,
      typ: "booking" as const,
      knd: "confirmed" as const,
      iat: secs(T0 + MIN),
      nonce: newNonce(),
    };
    const jws = await signReceipt(legacy, key);
    await s.db.client.query({
      sql: "INSERT INTO receipts (id, item_id, kind, jws, payload, kid, subject_hash, issued_at) VALUES (?, ?, 'confirmed', ?, ?, ?, ?, ?)",
      params: [ulid(T0), b.id, jws, JSON.stringify(legacy), key.kid, legacy.sub, T0 + MIN],
      method: "run",
    });
    await fire(s, owner(b.end), b.id, "complete");
    await s.drain(b.end + MIN);
    const [, outcome] = await s.caps.receipts.forItem(b.id);
    expect(claims(outcome)).toMatchObject({ ref: legacy.nonce, due: secs(b.start), end: secs(b.end) });

    // The sweep names the old receipt as a network would.
    await s.sweep(b.end + 20 * MIN);
    const { rows } = await s.db.client.query({
      sql: "SELECT sha FROM receipts WHERE jws = ?",
      params: [jws],
      method: "all",
    });
    expect(rows[0]?.[0]).toBe(await receiptSha(jws));
  });

  it("names each network's presentation of its customer as per", async () => {
    const s = await setup();
    const b = await book(s);
    const p = "AAAAAAAAAAAAAAAAAAAAAA";
    await s.db.orm.insert(itemPresentations).values([
      { itemId: b.id, network: "https://network.example.com", presentationId: p, createdAt: T0 },
      { itemId: b.id, network: "https://second.example.net", presentationId: `${p.slice(0, 21)}B`, createdAt: T0 },
    ]);
    await fire(s, owner(T0 + MIN), b.id, "confirm");
    await s.drain(T0 + MIN);
    const [promise] = await s.caps.receipts.forItem(b.id);
    expect(claims(promise).per).toEqual([
      { n: "network.example.com", p },
      { n: "second.example.net", p: `${p.slice(0, 21)}B` },
    ]);
  });
});

describe("a quote accepted as an order", () => {
  it("hands the order its customer's presentations, so the order's promise names them", async () => {
    const s = await setup();
    const q = await s.caps.requestQuote(customer(T0), {
      payload: { itemOffered: { name: "Custom wheel" }, description: "A 29er rear wheel" },
      contact: { email: "rita@example.com" },
    });
    const qid = q.view.item.id;
    const p = "QQQQQQQQQQQQQQQQQQQQQQ";
    await s.db.orm
      .insert(itemPresentations)
      .values({ itemId: qid, network: "https://network.example.com", presentationId: p, createdAt: T0 });
    await fire(s, owner(T0 + MIN), qid, "quote", {
      totalPrice: { value: 18000, currency: "EUR" },
      validThrough: new Date(T0 + 7 * DAY).toISOString(),
    });
    const accepted = await transitionItem(
      s.db,
      { ...customer(T0 + HOUR), accessToken: q.accessToken as string },
      { itemId: qid, event: "accept" },
    );
    const orderId = accepted.linked?.item.id as string;
    await fire(s, owner(T0 + 2 * HOUR), orderId, "accept");
    await s.drain(T0 + 2 * HOUR);
    const [promise] = await s.caps.receipts.forItem(orderId);
    expect(promise?.kind).toBe("accepted");
    expect(claims(promise).per).toEqual([{ n: "network.example.com", p }]);
  });
});

describe("an order", () => {
  it("promises on acceptance and records a failed payment, the fulfilment and a charge-back", async () => {
    const s = await setup();
    const o = await order(s);
    await fire(s, owner(T0 + MIN), o.id, "accept");
    await fire(s, owner(T0 + 2 * MIN), o.id, "request_payment");
    await fire(s, connector(T0 + HOUR), o.id, "payment_failed", { note: "card declined" });
    await fire(s, connector(T0 + 2 * HOUR), o.id, "record_payment", { paymentRef: "pi_2" });
    await fire(s, owner(T0 + DAY), o.id, "fulfil");
    await fire(s, owner(T0 + 2 * DAY), o.id, "complete");
    await fire(s, connector(T0 + 20 * DAY), o.id, "record_charge_back", { note: "disputed" });
    await s.drain(T0 + 20 * DAY);
    await expect(fire(s, connector(T0 + 21 * DAY), o.id, "record_charge_back")).rejects.toMatchObject({
      code: "guard_failed",
      details: { guard: "not_charged_back" },
    });

    // In the order they happened: every receipt is dated by its own event, whenever it was signed.
    const all = (await s.caps.receipts.forItem(o.id)).sort((a, b) => claims(a).iat - claims(b).iat);
    expect(all.map((r) => r.outcome ?? r.kind)).toEqual([
      "accepted",
      "order.payment_failed",
      "paid",
      "order.fulfilled",
      "order.charged_back",
    ]);
    const accepted = all[0];
    // Due 30 days after the promise, since the order names no delivery time; every receipt agrees.
    for (const r of all) expect(claims(r).due).toBe(secs(T0 + MIN) + 30 * 86_400);
    for (const r of all.filter((x) => x.kind === "outcome")) expect(claims(r).ref).toBe(claims(accepted).nonce);
    expect((await s.caps.getItem(owner(T0), { item_id: o.id })).item.state).toBe("completed");
  });

  it("cancelled after acceptance is the business's broken promise, or the customer's neutral close", async () => {
    const s = await setup();
    const byOwner = await order(s);
    const byCustomer = await order(s);
    const early = await order(s);
    for (const o of [byOwner, byCustomer]) await fire(s, owner(T0 + MIN), o.id, "accept");
    await fire(s, owner(T0 + HOUR), byOwner.id, "cancel", { note: "out of stock" });
    await s.caps.cancelItem(customer(T0 + HOUR), { item_id: byCustomer.id, access_token: byCustomer.token });
    await s.caps.cancelItem(customer(T0 + HOUR), { item_id: early.id, access_token: early.token });
    await s.drain(T0 + HOUR);
    expect((await outcomes(s, byOwner.id)).map((r) => r.outcome)).toEqual(["order.not_fulfilled"]);
    expect((await outcomes(s, byCustomer.id)).map((r) => r.outcome)).toEqual(["order.cancelled_by_customer"]);
    expect(await s.caps.receipts.forItem(early.id)).toEqual([]);
  });

  it("charged back after payment ends there", async () => {
    const s = await setup();
    const o = await order(s);
    await fire(s, owner(T0 + MIN), o.id, "accept");
    await fire(s, owner(T0 + 2 * MIN), o.id, "record_payment", { paymentRef: "pi_1" });
    const r = await fire(s, connector(T0 + 5 * DAY), o.id, "charge_back");
    expect(r.view.item.state).toBe("charged_back");
    expect(r.view.item.closedAt).not.toBeNull();
    await s.drain(T0 + 5 * DAY);
    expect((await outcomes(s, o.id)).map((x) => x.outcome)).toEqual(["order.charged_back"]);
  });

  it("left unpaid lapses after payDays, once, and can still be paid", async () => {
    const s = await setup();
    const o = await order(s);
    await fire(s, owner(T0 + MIN), o.id, "accept");
    await fire(s, owner(T0 + HOUR), o.id, "request_payment");
    await s.sweep(T0 + HOUR + 13 * DAY);
    expect(await outcomes(s, o.id)).toEqual([]);

    const at = T0 + HOUR + 14 * DAY + 1_000;
    await s.sweep(at);
    const detail = await s.caps.getItem(owner(at), { item_id: o.id });
    expect(detail.item.state).toBe("awaiting_payment");
    expect(detail.events.at(-1)).toMatchObject({ event: "lapse", from: "awaiting_payment", to: "awaiting_payment" });
    const [lapsed] = await outcomes(s, o.id);
    expect(claims(lapsed)).toMatchObject({ out: "order.lapsed", aut: 1, iat: secs(at) });

    await s.sweep(at + DAY);
    expect(detail.item.version).toBe((await s.caps.getItem(owner(at), { item_id: o.id })).item.version);
    await expect(
      s.caps.transitionItem(caller("system", at + DAY), { item_id: o.id, event: "lapse" }),
    ).rejects.toMatchObject({ code: "guard_failed", details: { guard: "payment_overdue" } });
    await fire(s, owner(at + 2 * DAY), o.id, "record_payment", { paymentRef: "pi_late" });
    expect((await s.caps.getItem(owner(at), { item_id: o.id })).item.state).toBe("paid");
  });

  it("refunded records no outcome, and the fulfilment stands", async () => {
    const s = await setup();
    const o = await order(s);
    await fire(s, owner(T0 + MIN), o.id, "accept");
    await fire(s, owner(T0 + 2 * MIN), o.id, "fulfil");
    const refund = await createItem(s.db, customer(T0 + DAY), {
      type: "refund",
      payload: { orderItemId: o.id, amount: { value: 1600, currency: "EUR" }, reason: "not what I wanted" },
      contact: { email: "rita@example.com" },
    });
    await fire(s, owner(T0 + DAY), refund.view.item.id, "approve");
    await fire(s, owner(T0 + DAY), refund.view.item.id, "refund", { paymentRef: "re_1" });
    await s.drain(T0 + DAY);
    expect(await s.caps.receipts.forItem(refund.view.item.id)).toEqual([]);
    expect((await outcomes(s, o.id)).map((r) => r.outcome)).toEqual(["order.fulfilled"]);
  });
});

describe("developer events", () => {
  it("name every new transition, and each outcome receipt, like any other", async () => {
    const s = await setup();
    // The fanout's handler lives in the adapters; here it is enough that the jobs are queued.
    s.runner.register("webhook_fanout", async () => undefined);
    await s.caps.webhooks.createWebhook(owner(T0), {
      url: "https://hooks.example.com/inbox",
      events: ["*"],
      payload_style: "thin",
    });
    const o = await order(s);
    await fire(s, owner(T0 + MIN), o.id, "accept");
    await fire(s, owner(T0 + 2 * MIN), o.id, "request_payment");
    await fire(s, connector(T0 + 3 * MIN), o.id, "payment_failed");
    await fire(s, connector(T0 + 4 * MIN), o.id, "record_payment", { paymentRef: "pi_9" });
    await fire(s, owner(T0 + 5 * MIN), o.id, "fulfil");
    await fire(s, owner(T0 + 6 * MIN), o.id, "complete");
    await fire(s, connector(T0 + 7 * MIN), o.id, "record_charge_back");
    // The event stream reads up to the real clock, so everything here happened on 22 September.
    const b = await book(s, 2 * HOUR);
    await fire(s, owner(T0 + MIN), b.id, "confirm");
    await fire(s, owner(b.end + MIN), b.id, "no_show");
    await s.drain(b.end + MIN);

    const page = await s.caps.webhooks.listEvents(owner(b.end + HOUR), { limit: 100 });
    const types = page.events.map((e) => e.type);
    for (const t of ["order.payment_failed", "order.record_charge_back", "booking.no_show"]) expect(types).toContain(t);
    // A receipt for each promise and each outcome: accepted, paid, and three outcomes; confirmed and one.
    expect(types.filter((t) => t === "order.receipt_issued")).toHaveLength(5);
    expect(types.filter((t) => t === "booking.receipt_issued")).toHaveLength(2);
    const failed = page.events.find((e) => e.type === "order.payment_failed");
    expect(failed?.data).toMatchObject({ state: "payment_failed", actor: { kind: "connector" } });
    const fanouts = (await s.db.orm.select({ kind: jobs.kind, key: jobs.dedupeKey }).from(jobs)).filter(
      (j) => j.kind === "webhook_fanout",
    );
    expect(fanouts.map((j) => j.key)).toContain(`fanout:${failed?.id}`);
  });
});

describe("the lifecycle sweep", () => {
  it("takes a batch at a time and comes straight back for the rest", async () => {
    const s = await setup();
    const runner = createRunner({ mailOut: logMailOut(), receipts: s.caps.receipts }).register(
      LIFECYCLE_SWEEP_KIND,
      lifecycleSweepHandler({ batch: 2 }),
    );
    const bs = [await book(s), await book(s), await book(s)];
    for (const b of bs) await fire(s, owner(T0 + MIN), b.id, "confirm");
    const at = (bs[0]?.end ?? 0) + 49 * HOUR;
    await ensureLifecycleSweep(s.db, at);
    for (let i = 0; i < 20; i++) if ((await runner.runDue(s.db, { now: at, limit: 100 })).claimed === 0) break;
    for (const b of bs) expect((await s.caps.getItem(owner(at), { item_id: b.id })).item.state).toBe("completed");
    const notes = await jobNotes(s.db, LIFECYCLE_SWEEP_KIND);
    expect(notes).toContain("2 completed, 0 lapsed, 0 receipt sha(s), more to do");
    expect(notes).toContain("1 completed, 0 lapsed, 0 receipt sha(s)");
    // And it has queued the next quarter hour's.
    const { rows } = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM jobs WHERE kind = ? AND status = 'queued' AND run_at > ?",
      params: [LIFECYCLE_SWEEP_KIND, at],
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBe(1);
  });
});

describe("an acknowledgement", () => {
  async function ack(receipt: ReceiptView, iat: number, pas?: string) {
    const agent = await generateKeyPair();
    const header = { alg: ALG, typ: ACK_TYP, jwk: agent.publicJwk };
    const body = { rcp: receipt.id, sha: await receiptSha(receipt.jws), iat, ...(pas ? { pas } : {}) };
    const enc = new TextEncoder();
    const input = `${b64u(enc.encode(JSON.stringify(header)))}.${b64u(enc.encode(JSON.stringify(body)))}`;
    const key = await crypto.subtle.importKey(
      "jwk",
      { ...agent.privateJwk, key_ops: ["sign"], ext: true },
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(input) as BufferSource);
    return `${input}.${b64u(new Uint8Array(sig))}`;
  }

  it("of an outcome may name the person's pass by reference, never the pass itself", async () => {
    const s = await setup();
    const b = await book(s);
    await fire(s, owner(T0 + MIN), b.id, "confirm");
    await fire(s, owner(b.end + MIN), b.id, "complete");
    await s.drain(b.end + MIN);
    const [outcome] = await outcomes(s, b.id);
    if (!outcome) throw new Error("no outcome");
    const now = b.end + 10 * MIN;
    const id = "abcdefghijklmnop";
    await expect(
      s.caps.acknowledgeReceipt(customer(now), {
        item_id: b.id,
        access_token: b.token,
        counter_signature: await ack(outcome, secs(now), `sdpass1_network.example.com_${id}_${"a".repeat(32)}`),
      }),
    ).rejects.toMatchObject({ code: "invalid_input", details: { reason: "bad_payload" } });
    const kept = await s.caps.acknowledgeReceipt(customer(now), {
      item_id: b.id,
      access_token: b.token,
      counter_signature: await ack(outcome, secs(now), `sdpass1_network.example.com_${id}`),
    });
    expect(kept.acknowledged_at).toBe(new Date(now).toISOString());
  });
});

describe("the settings for outcomes", () => {
  it("default to the ADR's numbers and refuse anything else, naming the field", async () => {
    const s = await setup();
    const view = await s.caps.getSettings(owner(T0));
    expect(view.doc.booking).toMatchObject({ lateCancellation: "record", autoCompleteHours: 48 });
    expect(view.doc.orders).toMatchObject({ payDays: 14, dueDays: 30 });
    for (const [doc, path] of [
      [{ booking: { lateCancellation: "sometimes" } }, "doc.booking.lateCancellation"],
      [{ booking: { autoCompleteHours: 0 } }, "doc.booking.autoCompleteHours"],
      [{ booking: { autoCompleteHours: 200 } }, "doc.booking.autoCompleteHours"],
      [{ orders: { payDays: 91 } }, "doc.orders.payDays"],
      [{ orders: { dueDays: 1.5 } }, "doc.orders.dueDays"],
    ] as const) {
      await expect(s.caps.updateSettings(owner(T0), { doc })).rejects.toMatchObject({
        code: "invalid_input",
        fields: [expect.objectContaining({ path })],
      });
    }
    // A change to one merges into what is there.
    await s.caps.updateSettings(owner(T0), { doc: { booking: { cancellationWindowMin: 120 } } });
    await s.caps.updateSettings(owner(T0), { doc: { booking: { autoCompleteHours: 24 }, orders: { payDays: 7 } } });
    const after = (await s.caps.getSettings(owner(T0))).doc;
    expect(after.booking).toMatchObject({
      cancellationWindowMin: 120,
      autoCompleteHours: 24,
      lateCancellation: "record",
    });
    expect(after.orders).toMatchObject({ payDays: 7, dueDays: 30, maxValueWithoutApprovalMinor: 0 });
  });
});
