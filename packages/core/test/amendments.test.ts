import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { linksForEmail } from "../src/customer/links";
import { openOffer } from "../src/customer/offer";
import { createDb, type Db } from "../src/db";
import type { Item } from "../src/domain/types";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { ensureLifecycleSweep, LIFECYCLE_SWEEP_KIND, lifecycleSweepHandler } from "../src/jobs/lifecycle";
import { offerRows } from "../src/negotiation/offers";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, items, jobs, outboundMail, products, services, slotClaims } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { type Caller, createItem, rowToItem, transitionItem, WriteError } from "../src/write/index";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * Changes to a promise (ADR-018 §3.1, §3.2): either side asks to change a confirmed booking or an
 * accepted order, and the other accepts it or says no. Accepted, the promise moves in one batch —
 * its terms, its places, its offers; declined, withdrawn or lapsed, it stays exactly as agreed. The
 * owner's limits bound it, and so does where the promise was reported. Emails, links and the page
 * speak as the business, in English and Portuguese. Runs on Node and in workerd.
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
const anon = (accessToken?: string): Caller => ({
  actor: { kind: "customer_agent", id: "agent:test", channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => clock.now,
  ...(accessToken ? { accessToken } : {}),
});
const EUR = (value: number) => ({ value, currency: "EUR" });
const iso = (ms: number) => new Date(ms).toISOString();

/** Thursday 24 September, 12:00 in Lisbon: the booking as first agreed. */
const THU_12 = Date.parse("2026-09-24T11:00:00Z");
/** Friday 25 September, 14:00 in Lisbon: where it moves. */
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
  const prod = ulid();
  await db.orm.insert(products).values({
    id: prod,
    sku: "CH-9",
    name: "Chain",
    price: EUR(1850),
    active: 1,
    createdAt: T0,
    updatedAt: T0,
  });
  const caps = confirming(new Capabilities(db, createSecretBox(["amendments-test-secret-0123456789abcdef"]), BASE));
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
  return { db, caps, svc, prod, drain, sweep };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** A booking the customer's assistant made for Thursday 12:00, confirmed by the owner. */
async function confirmed(s: Setup, start = THU_12, contact = { email: "rita@example.com", locale: "en" }) {
  const r = await s.caps.createBooking(anon(), {
    payload: {
      reservationFor: { serviceId: s.svc, name: "Full service" },
      startTime: iso(start),
      endTime: iso(start + 90 * MIN),
    },
    contact,
  });
  const id = r.view.item.id;
  await transitionItem(s.db, owner, { itemId: id, event: "confirm" });
  return { id, token: r.accessToken as string, start };
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

const itemOf = async (db: Db, id: string): Promise<Item> => {
  const [row] = await db.orm.select().from(items).where(eq(items.id, id));
  if (!row) throw new Error("no item");
  return rowToItem(row);
};
const claimsOf = async (db: Db, id: string) =>
  (await db.orm.select().from(slotClaims).where(eq(slotClaims.itemId, id)))
    .map((c) => [c.bucketStart, c.ordinal, c.offerId] as const)
    .sort((a, b) => a[0] - b[0] || a[2].localeCompare(b[2]));
const changes = async (db: Db, id: string) =>
  (await offerRows(db, id)).filter((o) => o.kind === "change").map((o) => [o.by, o.status, o.round] as const);
const customerMail = async (db: Db, id: string) =>
  (await db.orm.select().from(outboundMail).where(eq(outboundMail.itemId, id))).filter(
    (m) => m.recipient === "customer",
  );
const receiptJobs = async (db: Db, id: string) =>
  (await db.orm.select().from(jobs)).filter(
    (j) => j.kind === "issue_receipt" && (j.payload as { itemId?: string }).itemId === id,
  ).length;
/** The half-hour buckets a 90-minute booking from `start` claims, 30-minute granularity. */
const buckets = (start: number) => [start, start + 30 * MIN, start + 60 * MIN];

describe("a customer's change to a confirmed booking", () => {
  it("waits for us while the booking stays; accepted, the booking and its places move in one batch", async () => {
    const s = await setup();
    const b = await confirmed(s);
    const before = await itemOf(s.db, b.id);
    const claimsBefore = await claimsOf(s.db, b.id);
    expect(claimsBefore.map((c) => c[0])).toEqual(buckets(THU_12));
    const receipts = await receiptJobs(s.db, b.id);

    await transitionItem(s.db, anon(b.token), {
      itemId: b.id,
      event: "propose_change",
      input: { startTime: iso(FRI_14), note: "Thursday no longer works." },
    });
    const asked = await itemOf(s.db, b.id);
    expect(asked.state).toBe("confirmed");
    expect(asked.payload).toMatchObject({
      startTime: iso(THU_12),
      change: { by: "customer", startTime: iso(FRI_14), endTime: iso(FRI_14 + 90 * MIN), totalPrice: EUR(4500) },
    });
    expect(await claimsOf(s.db, b.id)).toEqual(claimsBefore);
    const rows = await offerRows(s.db, b.id);
    const agreed = rows.find((r) => r.status === "accepted");
    expect(rows.at(-1)).toMatchObject({
      kind: "change",
      form: "change",
      by: "customer",
      status: "open",
      parentId: agreed?.id,
      changes: ["$.endTime", "$.startTime"],
      // negotiation.counterValidHours on, the booking being later.
      validThrough: T0 + 72 * HOUR,
    });
    // The customer's view: what was agreed stands, and their change waits for us.
    const status = await s.caps.getItemStatus(anon(b.token), { item_id: b.id });
    expect(status).toMatchObject({
      offer: null,
      waiting_on: "us",
      requested_change: { terms: { startTime: iso(FRI_14) }, until: iso(T0 + 72 * HOUR) },
    });
    expect(status.human).toMatch(/You asked to move it to Fri.*until we answer, it stays as it is/);
    expect(status.next?.map((n) => n.action)).toEqual(["decline_offer", "cancel_item", "send_message"]);

    // The owner sees it to answer.
    const seen = await s.caps.getItem(owner, { item_id: b.id });
    expect(seen.transitions.map((t) => t.event)).toEqual(
      expect.arrayContaining(["accept_change", "decline_change", "propose_change"]),
    );
    expect(seen.transitions.map((t) => t.event)).not.toContain("retract_change");
    expect(seen.human).toMatch(/The customer asks to move it to/);

    const r = await transitionItem(s.db, owner, { itemId: b.id, event: "accept_change" });
    expect(r.view.item.payload).toMatchObject({ startTime: iso(FRI_14), endTime: iso(FRI_14 + 90 * MIN) });
    expect((r.view.item.payload as { change?: unknown }).change).toBeUndefined();
    expect((r.view.item.payload as { offer?: unknown }).offer).toMatchObject({
      id: rows.at(-1)?.id,
      status: "accepted",
    });
    expect((await claimsOf(s.db, b.id)).map((c) => [c[0], c[2]])).toEqual(buckets(FRI_14).map((x) => [x, ""]));
    expect(await changes(s.db, b.id)).toEqual([["customer", "accepted", 1]]);
    // A change both sides agreed is a receipt of its own (rules version 6): one job, naming the change.
    expect(await receiptJobs(s.db, b.id)).toBe(receipts + 1);
    const job = (await s.db.orm.select().from(jobs)).find(
      (j) => j.kind === "issue_receipt" && (j.payload as { kind?: string }).kind === "amended",
    );
    expect(job?.payload).toMatchObject({ itemId: b.id, kind: "amended", offerId: rows.at(-1)?.id });
    expect((before.payload as { startTime: string }).startTime).toBe(iso(THU_12));
  });

  it("declined, withdrawn or lapsed, the booking stays exactly as agreed", async () => {
    const s = await setup();
    const b = await confirmed(s);
    const before = (await itemOf(s.db, b.id)).payload;
    const claims = await claimsOf(s.db, b.id);
    const ask = () =>
      transitionItem(s.db, anon(b.token), { itemId: b.id, event: "propose_change", input: { startTime: iso(FRI_14) } });

    await ask();
    await transitionItem(s.db, owner, { itemId: b.id, event: "decline_change", input: { note: "Fully booked." } });
    expect((await itemOf(s.db, b.id)).payload).toEqual(before);
    expect(await claimsOf(s.db, b.id)).toEqual(claims);

    await ask();
    await transitionItem(s.db, anon(b.token), { itemId: b.id, event: "retract_change" });
    expect((await itemOf(s.db, b.id)).payload).toEqual(before);

    await ask();
    // Not answered: at its date the sweep lets it go, and tells the customer.
    await s.sweep(T0 + 72 * HOUR - MIN);
    expect((await itemOf(s.db, b.id)).payload).not.toEqual(before);
    await s.sweep(T0 + 72 * HOUR);
    expect((await itemOf(s.db, b.id)).payload).toEqual(before);
    expect(await claimsOf(s.db, b.id)).toEqual(claims);
    expect(await changes(s.db, b.id)).toEqual([
      ["customer", "declined", 1],
      ["customer", "retracted", 2],
      ["customer", "expired", 3],
    ]);
    const mails = await customerMail(s.db, b.id);
    const templates = mails.map((m) => m.template);
    expect(templates).toEqual(
      expect.arrayContaining([
        "booking.change.propose",
        "booking.change.decline",
        "booking.change.retract",
        "booking.change.expire",
      ]),
    );
    const weCant = mails.find((m) => m.template === "booking.change.decline");
    expect(weCant?.bodyText).toMatch(/We cannot move "Full service" to Fri.*so your booking stays for Thu/);
    const lapsed = mails.find((m) => m.template === "booking.change.expire");
    expect(lapsed?.bodyText).toMatch(/we could not answer your request to move "Full service" in time/);
    const received = mails.find((m) => m.template === "booking.change.propose");
    expect(received?.subject).toBe("We have your request: Full service");
    expect(received?.bodyText).toMatch(/Until we confirm, your booking stays for Thu/);
  });

  it("must be a time we would offer, but its own places are free to it: an overlapping move is reclaimed", async () => {
    const s = await setup();
    const b = await confirmed(s);
    const other = await confirmed(s, FRI_14);
    // Friday 14:00 is someone else's now.
    const taken = await fail(
      transitionItem(s.db, anon(b.token), { itemId: b.id, event: "propose_change", input: { startTime: iso(FRI_14) } }),
    );
    expect(taken.code).toBe("slot_taken");
    expect(other.id).not.toBe(b.id);
    // Half an hour later than now overlaps its own time, with room for one: free to it.
    const later = THU_12 + 30 * MIN;
    await transitionItem(s.db, anon(b.token), {
      itemId: b.id,
      event: "propose_change",
      input: { startTime: iso(later) },
    });
    await transitionItem(s.db, owner, { itemId: b.id, event: "accept_change" });
    expect((await claimsOf(s.db, b.id)).map((c) => c[0])).toEqual(buckets(later));
    // The same time as agreed is no change at all.
    const same = await fail(
      transitionItem(s.db, anon(b.token), { itemId: b.id, event: "propose_change", input: { startTime: iso(later) } }),
    );
    expect(same.code).toBe("invalid_input");
  });

  it("asked again and again before we answer, reaches a person after the last round", async () => {
    const s = await setup();
    const b = await confirmed(s);
    for (const h of [0, 1, 2]) {
      await transitionItem(s.db, anon(b.token), {
        itemId: b.id,
        event: "propose_change",
        input: { startTime: iso(FRI_14 + h * HOUR) },
      });
    }
    expect(await changes(s.db, b.id)).toEqual([
      ["customer", "superseded", 1],
      ["customer", "superseded", 2],
      ["customer", "open", 3],
    ]);
    const passed = await s.caps.customer.suggestTime(anon(b.token), { item_id: b.id, start_time: iso(FRI_14 - HOUR) });
    expect(passed).toMatchObject({ waiting_on: "us", appended: true });
    expect((await itemOf(s.db, b.id)).payload).toMatchObject({ change: { startTime: iso(FRI_14 + 2 * HOUR) } });
  });

  it("on a booking confirmed before offers had a table, answers what it holds, written first", async () => {
    const s = await setup();
    const b = await confirmed(s);
    await s.db.client.query({ sql: "DELETE FROM item_offers WHERE item_id = ?", params: [b.id], method: "run" });
    await transitionItem(s.db, anon(b.token), {
      itemId: b.id,
      event: "propose_change",
      input: { startTime: iso(FRI_14) },
    });
    const rows = await offerRows(s.db, b.id);
    expect(rows.map((r) => [r.rev, r.kind, r.form, r.status])).toEqual([
      [1, "offer", "time", "accepted"],
      [2, "change", "change", "open"],
    ]);
    expect(rows[1]?.parentId).toBe(rows[0]?.id);
    expect(rows[0]?.terms).toMatchObject({ startTime: iso(THU_12), totalPrice: EUR(4500) });
    await transitionItem(s.db, owner, { itemId: b.id, event: "decline_change" });
    expect((await itemOf(s.db, b.id)).payload).toMatchObject({
      startTime: iso(THU_12),
      offer: { id: rows[0]?.id, status: "accepted" },
    });
  });

  it("taken late by us, goes back to the customer as our change on the same terms", async () => {
    const s = await setup();
    const b = await confirmed(s);
    await transitionItem(s.db, anon(b.token), {
      itemId: b.id,
      event: "propose_change",
      input: { startTime: iso(FRI_14) },
    });
    clock.now = T0 + 72 * HOUR + MIN;
    const r = await transitionItem(s.db, owner, { itemId: b.id, event: "accept_change" });
    expect(r.converted).toBe("change_lapsed");
    expect(r.view.item.payload).toMatchObject({
      startTime: iso(THU_12),
      change: { by: "business", startTime: iso(FRI_14) },
    });
    expect(await changes(s.db, b.id)).toEqual([
      ["customer", "countered", 1],
      ["business", "open", 2],
    ]);
  });
});

describe("a change we ask for to a confirmed booking", () => {
  it("holds its time while the customer answers, and lets it go when they keep what was agreed", async () => {
    const s = await setup({ booking: { holdOnPropose: true } });
    const b = await confirmed(s);
    await transitionItem(s.db, owner, {
      itemId: b.id,
      event: "propose_change",
      input: { startTime: iso(FRI_14), note: "Our lift is out on Thursday." },
    });
    const item = await itemOf(s.db, b.id);
    const change = (await offerRows(s.db, b.id)).at(-1);
    expect(item.payload).toMatchObject({
      startTime: iso(THU_12),
      change: { by: "business", startTime: iso(FRI_14) },
      offer: { id: change?.id, by: "business", status: "open", held: true },
    });
    // A person's change holds until the earlier start less the minimum notice.
    expect(change?.validThrough).toBe(THU_12 - 60 * MIN);
    const held = await claimsOf(s.db, b.id);
    expect(held.filter((c) => c[2] === "").map((c) => c[0])).toEqual(buckets(THU_12));
    expect(held.filter((c) => c[2] === change?.id).map((c) => c[0])).toEqual(buckets(FRI_14));

    // The customer's door: the change to answer, then their no.
    const status = await s.caps.getItemStatus(anon(b.token), { item_id: b.id });
    // The offer's fingerprint is the one the customer is shown and confirms.
    expect(status.offer).toMatchObject({
      kind: "change",
      id: change?.id,
      terms_sha: change?.termsSha,
      obligation_to_pay: false,
      changes: ["$.endTime", "$.startTime"],
      disclosures: ["held"],
    });
    expect(change?.shown).toMatchObject({ lang: "en", disclosures: ["held"] });
    expect(status.waiting_on).toBe("you");
    expect(status.human).toMatch(
      /^We would like to move your booking "Full service" from Thu.* to Fri.*Please answer by .*accept the change, or keep your booking as it is/,
    );
    expect(status.next?.map((n) => n.label)).toEqual([
      "Accept the change",
      "Keep it as it is",
      "Change the time",
      "Cancel",
      "Write to us",
    ]);
    const kept = await s.caps.customer.declineOffer(anon(b.token), { item_id: b.id, offer_id: change?.id });
    expect(kept.view.item.state).toBe("confirmed");
    expect((await claimsOf(s.db, b.id)).map((c) => [c[0], c[2]])).toEqual(buckets(THU_12).map((x) => [x, ""]));
    expect(await changes(s.db, b.id)).toEqual([["business", "declined", 1]]);
  });

  it("accepted by the customer with the confirm step: the booking moves, the hold becomes its claim", async () => {
    const s = await setup({ booking: { holdOnPropose: true } });
    const b = await confirmed(s);
    await transitionItem(s.db, owner, { itemId: b.id, event: "propose_change", input: { startTime: iso(FRI_14) } });
    const unconfirmed = await fail(s.caps.customer.acceptOffer(anon(b.token), { item_id: b.id }));
    expect(unconfirmed.code).toBe("confirm_terms");
    const sha = (unconfirmed.details as { terms_sha: string }).terms_sha;
    const r = await s.caps.customer.acceptOffer(anon(b.token), { item_id: b.id, terms_sha: sha });
    expect(r.view.item.payload).toMatchObject({ startTime: iso(FRI_14) });
    expect((await claimsOf(s.db, b.id)).map((c) => [c[0], c[2]])).toEqual(buckets(FRI_14).map((x) => [x, ""]));
    expect(r.view.offer).toBeNull();
    expect(r.view.agreed?.terms).toMatchObject({ startTime: iso(FRI_14) });
    // Accepted once: a second yes finds nothing open.
    const again = await fail(s.caps.customer.acceptOffer(anon(b.token), { item_id: b.id, terms_sha: sha }));
    expect(again.code).toBe("no_offer");
  });

  it("with a higher price asks the customer to confirm an obligation to pay; lapsed, the booking stays", async () => {
    const s = await setup();
    const b = await confirmed(s);
    await transitionItem(s.db, owner, {
      itemId: b.id,
      event: "propose_change",
      input: { startTime: iso(FRI_14), totalPrice: EUR(5000) },
    });
    const offer = await openOffer(await itemOf(s.db, b.id));
    expect(offer).toMatchObject({ kind: "change", obligationToPay: true, terms: { totalPrice: EUR(5000) } });
    const unconfirmed = await fail(s.caps.customer.acceptOffer(anon(b.token), { item_id: b.id }));
    expect((unconfirmed.details as { summary: string }).summary).toMatch(/obligation to pay €50\.00/);
    // One minute past its date the customer's yes is refused in our words, though the sweep has not run.
    clock.now = THU_12 - 60 * MIN + MIN;
    const late = await fail(s.caps.customer.acceptOffer(anon(b.token), { item_id: b.id, terms_sha: offer?.termsSha }));
    expect(late.code).toBe("offer_expired");
    expect(late.message).toMatch(/^The change we suggested could be accepted until .*; what we agreed stands\.$/);
    await s.sweep(THU_12 - 50 * MIN);
    const item = await itemOf(s.db, b.id);
    expect(item.payload).toMatchObject({ startTime: iso(THU_12), totalPrice: EUR(4500) });
    expect((item.payload as { change?: unknown }).change).toBeUndefined();
    expect(await changes(s.db, b.id)).toEqual([["business", "expired", 1]]);
  });

  it("said yes to by phone, is recorded by a person, never by the owner's AI, with how they agreed kept to us", async () => {
    const s = await setup();
    const b = await confirmed(s);
    await transitionItem(s.db, owner, { itemId: b.id, event: "propose_change", input: { startTime: iso(FRI_14) } });
    const seen = await s.caps.getItem(owner, { item_id: b.id });
    expect(seen.transitions.find((t) => t.event === "accept_change")?.label).toBe("Customer accepted the change");
    const byAi = await fail(transitionItem(s.db, ai, { itemId: b.id, event: "accept_change" }));
    expect(byAi.code).toBe("not_allowed");
    await transitionItem(s.db, owner, {
      itemId: b.id,
      event: "accept_change",
      input: { note: "Rita said yes on the phone." },
    });
    expect((await itemOf(s.db, b.id)).payload).toMatchObject({ startTime: iso(FRI_14) });
    const notes = await s.db.client.query({
      sql: "SELECT direction FROM thread_entries WHERE item_id = ? AND body_text = ?",
      params: [b.id, "Rita said yes on the phone."],
      method: "all",
    });
    expect(notes.rows.map((r) => r[0])).toEqual(["note"]);
  });

  it("binds us: we withdraw it only when we said it was subject to our confirmation", async () => {
    const s = await setup();
    const b = await confirmed(s);
    await transitionItem(s.db, owner, { itemId: b.id, event: "propose_change", input: { startTime: iso(FRI_14) } });
    const bound = await fail(transitionItem(s.db, owner, { itemId: b.id, event: "retract_change" }));
    expect((bound.details as { guard?: string }).guard).toBe("offer_non_binding");
    await s.caps.updateSettings(owner, { doc: { negotiation: { binding: false } } });
    await transitionItem(s.db, owner, {
      itemId: b.id,
      event: "propose_change",
      input: { startTime: iso(FRI_14 + HOUR) },
    });
    await transitionItem(s.db, owner, { itemId: b.id, event: "retract_change" });
    expect(await changes(s.db, b.id)).toEqual([
      ["business", "superseded", 1],
      ["business", "retracted", 1],
    ]);
  });

  it("ends with the promise when it ends another way: cancelled, its change is declined and its hold let go", async () => {
    const s = await setup({ booking: { holdOnPropose: true } });
    const b = await confirmed(s);
    await transitionItem(s.db, owner, { itemId: b.id, event: "propose_change", input: { startTime: iso(FRI_14) } });
    await transitionItem(s.db, anon(b.token), { itemId: b.id, event: "cancel" });
    const item = await itemOf(s.db, b.id);
    expect(item.state).toBe("cancelled_by_customer");
    expect((item.payload as { change?: unknown }).change).toBeUndefined();
    expect(await claimsOf(s.db, b.id)).toEqual([]);
    expect(await changes(s.db, b.id)).toEqual([["business", "declined", 1]]);
  });

  it("completed by the sweep with a customer's change still open, lets the change lapse with it", async () => {
    const s = await setup();
    const b = await confirmed(s, T0 + 2 * DAY);
    await transitionItem(s.db, anon(b.token), {
      itemId: b.id,
      event: "propose_change",
      input: { startTime: iso(FRI_14) },
    });
    // Its date is the booking's start, but the owner took no step: the booking happened as agreed.
    await s.db.client.query({
      sql: "UPDATE item_offers SET valid_through = ? WHERE item_id = ? AND status = 'open'",
      params: [T0 + 30 * DAY, b.id],
      method: "run",
    });
    await s.sweep(T0 + 2 * DAY + 90 * MIN + 49 * HOUR);
    const item = await itemOf(s.db, b.id);
    expect(item.state).toBe("completed");
    expect((item.payload as { change?: unknown }).change).toBeUndefined();
    expect(await changes(s.db, b.id)).toEqual([["customer", "expired", 1]]);
  });
});

describe("the owner's limits on changes", () => {
  it("at most the changes the owner allows, and never more than 90 days from what was first agreed", async () => {
    const s = await setup({ negotiation: { changes: { maxPerItem: 1 } } });
    const b = await confirmed(s);
    await transitionItem(s.db, anon(b.token), {
      itemId: b.id,
      event: "propose_change",
      input: { startTime: iso(FRI_14) },
    });
    await transitionItem(s.db, owner, { itemId: b.id, event: "accept_change" });
    const customer = await fail(
      transitionItem(s.db, anon(b.token), {
        itemId: b.id,
        event: "propose_change",
        input: { startTime: iso(FRI_14 + HOUR) },
      }),
    );
    expect(customer.details).toMatchObject({ guard: "changes_left", reason: "count" });
    const ours = await fail(
      transitionItem(s.db, owner, { itemId: b.id, event: "propose_change", input: { startTime: iso(FRI_14 + HOUR) } }),
    );
    expect(ours.details).toMatchObject({ guard: "changes_left", reason: "count" });
    expect(ours.message).toMatch(/record the customer's cancellation/);
    // Through the assistant's door it goes to a person as their message: never refused.
    const passed = await s.caps.customer.makeOffer(anon(b.token), {
      item_id: b.id,
      terms: { start_time: iso(FRI_14 + HOUR) },
    });
    expect(passed).toMatchObject({ waiting_on: "us", appended: true });
    expect((passed as { passed_on: string }).passed_on).toMatch(
      /^We have passed your request on to a person on our team, who will reply soon\. Your booking stays as agreed, for Fri/,
    );

    const s2 = await setup();
    const far = await confirmed(s2);
    // Thursday 24 December, 12:00 in Lisbon: 91 days after what was agreed.
    const christmasEve = Date.parse("2026-12-24T12:00:00Z");
    const shifted = await fail(
      transitionItem(s2.db, anon(far.token), {
        itemId: far.id,
        event: "propose_change",
        input: { startTime: iso(christmasEve) },
      }),
    );
    expect(shifted.details).toMatchObject({ guard: "changes_left", reason: "shift" });
  });

  it("the owner's AI: never asks unless allowed, never at another price; takes a customer's only before the cutoff", async () => {
    const s = await setup();
    const b = await confirmed(s, T0 + 3 * DAY + HOUR);
    // Outside the owner's limits a change the AI asks for is a draft for the owner, never sent.
    const asked = await transitionItem(s.db, ai, {
      itemId: b.id,
      event: "propose_change",
      input: { startTime: iso(FRI_14) },
    });
    expect(asked.drafted?.breaches).toEqual(["change_not_allowed"]);
    await s.caps.updateSettings(owner, { doc: { negotiation: { ai: { mayProposeChanges: true } } } });
    const priced = await transitionItem(s.db, ai, {
      itemId: b.id,
      event: "propose_change",
      input: { startTime: iso(FRI_14), totalPrice: EUR(4000) },
    });
    expect(priced.drafted?.breaches).toEqual(["below_floor"]);
    expect((await itemOf(s.db, b.id)).payload).not.toHaveProperty("change");
    await transitionItem(s.db, ai, { itemId: b.id, event: "propose_change", input: { startTime: iso(FRI_14) } });
    // What the AI asks holds at most negotiation.offerValidHours.
    expect((await offerRows(s.db, b.id)).at(-1)?.validThrough).toBe(T0 + 48 * HOUR);

    // A customer's change, a day before the booking: inside the cancellation window, a person takes it.
    const soon = await confirmed(s, T0 + 20 * HOUR);
    await transitionItem(s.db, anon(soon.token), {
      itemId: soon.id,
      event: "propose_change",
      input: { startTime: iso(FRI_14 + 2 * HOUR) },
    });
    const late = await fail(transitionItem(s.db, ai, { itemId: soon.id, event: "accept_change" }));
    expect(late.details).toMatchObject({ guard: "change_allowed", draft_for_owner: true });
    await transitionItem(s.db, owner, { itemId: soon.id, event: "accept_change" });

    const early = await confirmed(s, Date.parse("2026-09-28T09:00:00Z"));
    await transitionItem(s.db, anon(early.token), {
      itemId: early.id,
      event: "propose_change",
      input: { startTime: iso(Date.parse("2026-09-29T09:00:00Z")) },
    });
    await transitionItem(s.db, ai, { itemId: early.id, event: "accept_change" });
    expect((await itemOf(s.db, early.id)).payload).toMatchObject({ startTime: "2026-09-29T09:00:00.000Z" });

    await s.caps.updateSettings(owner, { doc: { negotiation: { ai: { mayAcceptChanges: false } } } });
    await transitionItem(s.db, anon(early.token), {
      itemId: early.id,
      event: "propose_change",
      input: { startTime: iso(Date.parse("2026-09-30T09:00:00Z")) },
    });
    const off = await fail(transitionItem(s.db, ai, { itemId: early.id, event: "accept_change" }));
    expect(off.details).toMatchObject({ guard: "change_allowed" });
  });

  it("where a network on rules before version 6 holds the promise, a change is not recorded: the customer's goes to a person", async () => {
    const s = await setup();
    const b = await confirmed(s);
    // The business made this one itself: its promise names no date to any network.
    const mine = await createItem(s.db, owner, {
      type: "booking",
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: iso(Date.parse("2026-09-28T09:00:00Z")),
        endTime: iso(Date.parse("2026-09-28T10:30:00Z")),
      },
      contact: { name: "Rui" },
    });
    await transitionItem(s.db, owner, { itemId: mine.view.item.id, event: "confirm" });
    await s.caps.updateSettings(owner, { doc: { networks: { [NET]: { enabled: true } } } });

    const customer = await fail(
      transitionItem(s.db, anon(b.token), { itemId: b.id, event: "propose_change", input: { startTime: iso(FRI_14) } }),
    );
    expect(customer.details).toMatchObject({ guard: "amendments_live" });
    const ours = await fail(
      transitionItem(s.db, owner, { itemId: b.id, event: "propose_change", input: { startTime: iso(FRI_14) } }),
    );
    expect(ours.details).toMatchObject({ guard: "amendments_live" });
    expect(ours.message).toMatch(/record their cancellation \(Customer cancelled\) and take a new booking/);
    const passed = await s.caps.customer.suggestTime(anon(b.token), { item_id: b.id, start_time: iso(FRI_14) });
    expect(passed).toMatchObject({ waiting_on: "us", appended: true });

    await transitionItem(s.db, owner, {
      itemId: mine.view.item.id,
      event: "propose_change",
      input: { startTime: iso(Date.parse("2026-09-29T09:00:00Z")) },
    });
  });
});

describe("a change to an accepted order", () => {
  async function accepted(s: Setup) {
    const r = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 3, price: EUR(1850) }], totalPrice: EUR(5550) },
      contact: { email: "rita@example.com", locale: "pt" },
    });
    const id = r.view.item.id;
    await transitionItem(s.db, owner, { itemId: id, event: "accept" });
    return { id, token: r.accessToken as string };
  }

  it("the customer's quantities, accepted: the order and its total change; after payment is asked, a person", async () => {
    const s = await setup();
    const o = await accepted(s);
    await s.caps.customer.makeOffer(anon(o.token), { item_id: o.id, terms: { lines: [{ index: 0, quantity: 2 }] } });
    expect((await itemOf(s.db, o.id)).payload).toMatchObject({
      totalPrice: EUR(5550),
      change: { by: "customer", totalPrice: EUR(3700), orderedItem: [{ quantity: 2 }] },
    });
    await transitionItem(s.db, owner, { itemId: o.id, event: "accept_change" });
    expect((await itemOf(s.db, o.id)).payload).toMatchObject({
      totalPrice: EUR(3700),
      orderedItem: [{ sku: "CH-9", quantity: 2, price: EUR(1850) }],
    });

    await transitionItem(s.db, owner, { itemId: o.id, event: "request_payment" });
    // Payment is asked for at its total: a change that moves it goes to a person as their message.
    const passed = await s.caps.customer.makeOffer(anon(o.token), {
      item_id: o.id,
      terms: { lines: [{ index: 0, quantity: 1 }] },
    });
    expect(passed).toMatchObject({ waiting_on: "us", appended: true });
    expect((passed as { passed_on: string }).passed_on).toMatch(/^Passámos o seu pedido a uma pessoa/);
    const ours = await fail(
      transitionItem(s.db, owner, {
        itemId: o.id,
        event: "propose_change",
        input: { orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 1, price: EUR(1850) }] },
      }),
    );
    expect(ours.details).toMatchObject({ guard: "total_fixed" });
    // Another delivery date keeps the total, and goes through.
    const when = iso(T0 + 5 * DAY);
    await s.caps.customer.makeOffer(anon(o.token), { item_id: o.id, terms: { delivery_when: when } });
    await transitionItem(s.db, owner, { itemId: o.id, event: "accept_change" });
    expect((await itemOf(s.db, o.id)).payload).toMatchObject({
      delivery: { method: "delivery", when },
      totalPrice: EUR(3700),
    });
    expect((await itemOf(s.db, o.id)).state).toBe("awaiting_payment");
    expect(await changes(s.db, o.id)).toEqual([
      ["customer", "accepted", 1],
      ["customer", "accepted", 1],
    ]);
  });

  it("ours, in the customer's language, with links to accept it or keep the order as it is", async () => {
    const s = await setup();
    const o = await accepted(s);
    await transitionItem(s.db, owner, {
      itemId: o.id,
      event: "propose_change",
      input: { delivery: { method: "delivery", when: iso(T0 + 6 * DAY) }, note: "O estafeta só vem no domingo." },
    });
    await s.drain();
    const mail = (await customerMail(s.db, o.id)).find((m) => m.template === "order.change.propose");
    expect(mail?.subject).toBe("Uma alteração à sua encomenda 3 × Chain");
    expect(mail?.bodyText).toMatch(/Queremos alterar a sua encomenda "3 × Chain" como se segue/);
    expect(mail?.bodyText).toMatch(/Aceitar a alteração: https:\/\/inbox\.example\/c\//);
    expect(mail?.bodyText).toMatch(/Manter como está: https:\/\/inbox\.example\/c\//);
    expect(mail?.bodyText).not.toMatch(/\boffer\b|network|rede/i);
  });
});

describe("links and the page for a change", () => {
  it("accept the change, or keep it as it is; the confirmation carries a link to change the time", async () => {
    const s = await setup();
    const b = await confirmed(s);
    await transitionItem(s.db, owner, { itemId: b.id, event: "propose_change", input: { startTime: iso(FRI_14) } });
    const item = await itemOf(s.db, b.id);
    const links = await linksForEmail(s.db, s.caps.secrets, item, {
      mailKey: "test:change",
      lang: "en",
      base: BASE,
      now: clock.now,
      minNoticeMin: 60,
    });
    expect([...(links?.keys() ?? [])]).toEqual(["accept_change", "keep_as_is"]);
    const token = (action: string) => String(links?.get(action as never)).split("/c/")[1] as string;

    const keep = await s.caps.customer.linkView(token("keep_as_is"), { now: clock.now });
    expect(keep.heading).toBe("Keep it as it is?");
    const page = await s.caps.customer.linkView(token("accept_change"), { now: clock.now });
    expect(page).toMatchObject({ status: 200, heading: "Accept this change?" });
    expect(page.rows?.map((r) => r.label)).toEqual(["Now", "Instead", "Price", "Please answer by"]);
    expect(page.form?.button).toBe("Confirm the change");
    expect(page.links?.items.map((l) => l.label)).toEqual(["Keep it as it is"]);
    const done = await s.caps.customer.linkAct(token("accept_change"), page.form?.hidden ?? {}, { now: clock.now });
    expect(done).toEqual({ redirect: `/c/${token("accept_change")}` });
    const after = await s.caps.customer.linkView(token("accept_change"), { now: clock.now });
    expect(after.heading).toMatch(/^Done: your booking "Full service" is now for Fri/);
    // The other link of the same email can no longer act.
    const stale = await s.caps.customer.linkView(token("keep_as_is"), { now: clock.now });
    expect(stale.status).toBe(409);

    // The confirmation of the move carries the link to ask for another time.
    const moved = await itemOf(s.db, b.id);
    const next = await linksForEmail(s.db, s.caps.secrets, moved, {
      mailKey: "test:moved",
      lang: "pt",
      base: BASE,
      now: clock.now,
      minNoticeMin: 60,
    });
    expect([...(next?.keys() ?? [])]).toEqual(["change_time"]);
    const pick = String(next?.get("change_time")).split("/c/")[1] as string;
    const picker = await s.caps.customer.linkView(pick, { now: clock.now });
    expect(picker.heading).toBe("Mudar a hora");
    expect(picker.paragraphs?.[0]).toMatch(/a sua marcação mantém-se para sex/);
    const field = picker.form?.fields.find((f) => f.kind === "times");
    const times = field?.kind === "times" ? field.days.flatMap((d) => d.times.map((t) => t.value)) : [];
    expect(times).not.toContain(iso(FRI_14));
    const chosen = times.find((t) => Date.parse(t) === FRI_14 + 30 * MIN) ?? times[0];
    const asked = await s.caps.customer.linkAct(pick, { ...picker.form?.hidden, start: chosen }, { now: clock.now });
    expect(asked).toEqual({ redirect: `/c/${pick}` });
    expect((await itemOf(s.db, b.id)).payload).toMatchObject({ change: { by: "customer", startTime: chosen } });
    const thanks = await s.caps.customer.linkView(pick, { now: clock.now });
    expect(thanks.heading).toMatch(/^Recebemos o seu pedido para mudar "Full service" para /);
  });
});
