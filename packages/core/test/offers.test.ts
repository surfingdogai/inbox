import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { CustomerResult } from "../src/capabilities/customer";
import { Capabilities } from "../src/capabilities/service";
import { linksForEmail } from "../src/customer/links";
import { openOffer } from "../src/customer/offer";
import { createDb, type Db } from "../src/db";
import type { Item } from "../src/domain/types";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { legacyOfferId, offerRows } from "../src/negotiation/offers";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import {
  business,
  items,
  jobs,
  outboundMail,
  products,
  services,
  slotClaims,
  threadEntries,
} from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { type Caller, rowToItem, transitionItem, WriteError } from "../src/write/index";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * Offers (ADR-018 §1, §2): the customer's request as the first offer, and each verb — offer, counter,
 * accept, decline, retract, expire — writing exactly the offers it should, in its transition's batch;
 * one open offer per item; holds; rounds; and an item from before offers had a table. Runs on Node
 * and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z"); // a Monday
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const clock = { now: T0 };
const at = (kind: Caller["actor"]["kind"], channel: Caller["actor"]["channel"]): Caller => ({
  actor: { kind, id: `${kind}_1`, channel },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock.now,
});
const owner = at("owner", "owner_ui");
const ai = at("owner_ai", "mcp_owner");
const anon = (accessToken?: string, key?: string): Caller => ({
  actor: { kind: "customer_agent", id: "agent:test", channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => clock.now,
  ...(accessToken ? { accessToken } : {}),
  ...(key ? { idempotency: { scope: "agent:test", key } } : {}),
});
const EUR = (value: number) => ({ value, currency: "EUR" });
const iso = (ms: number) => new Date(ms).toISOString();

async function setup(doc?: Record<string, unknown>) {
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
  const caps = confirming(
    new Capabilities(db, createSecretBox(["offers-test-secret-0123456789abcdef"]), "https://inbox.example"),
  );
  if (doc) await caps.updateSettings(owner, { doc });
  const runner = createRunner({
    mailOut: logMailOut(),
    receipts: caps.receipts,
    baseUrl: "https://inbox.example",
    secrets: caps.secrets,
  });
  const drain = async () => {
    for (let i = 0; i < 20; i++) if ((await runner.runDue(db, { now: clock.now, limit: 100 })).claimed === 0) return;
  };
  return { db, caps, svc, prod, drain };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** A request for Thursday 12:00 Lisbon, by default: later than the request's own clock. */
async function booking(s: Setup, startIn = 3 * DAY + HOUR, contact = { email: "rita@example.com", locale: "en" }) {
  const start = T0 + startIn;
  const r = await s.caps.createBooking(anon(), {
    payload: {
      reservationFor: { serviceId: s.svc, name: "Full service" },
      startTime: iso(start),
      endTime: iso(start + 90 * MIN),
    },
    contact,
  });
  return { id: r.view.item.id, token: r.accessToken as string, start };
}

/** Wednesday 14:00 Lisbon, which the default hours offer. */
const WED_14 = Date.parse("2026-09-23T13:00:00Z");

async function propose(s: Setup, id: string, start = WED_14, as: Caller = owner) {
  return transitionItem(s.db, as, {
    itemId: id,
    event: "propose",
    input: { startTime: iso(start), endTime: iso(start + 90 * MIN) },
  });
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
const statuses = async (db: Db, id: string) =>
  (await offerRows(db, id)).map((o) => [o.rev, o.by, o.status, o.round] as const);
const mailOf = async (db: Db, id: string) =>
  (await db.orm.select().from(outboundMail).where(eq(outboundMail.itemId, id))).filter(
    (m) => m.recipient === "customer",
  );

describe("the customer's request is the first offer", () => {
  it("is written with the booking: the time asked, open for us, lapsing at the request's clock", async () => {
    const s = await setup();
    const b = await booking(s, 5 * DAY);
    const [row] = await offerRows(s.db, b.id);
    expect(row).toMatchObject({
      rev: 1,
      by: "customer",
      form: "time",
      status: "open",
      round: 1,
      // The customer confirmed its summary first (the confirm step): their request binds them.
      binding: true,
      authored: "person",
      terms: { startTime: iso(T0 + 5 * DAY), endTime: iso(T0 + 5 * DAY + 90 * MIN), totalPrice: EUR(4500) },
      // booking.autoExpireHours: 72 hours on, the start being later.
      validThrough: T0 + 72 * HOUR,
    });
    const item = await itemOf(s.db, b.id);
    expect((item.payload as { offer?: unknown }).offer).toEqual({
      id: row?.id,
      rev: 1,
      by: "customer",
      round: 1,
      status: "open",
      validThrough: iso(T0 + 72 * HOUR),
    });
    const [raw] = await s.db.orm.select({ at: items.requestExpiresAt }).from(items).where(eq(items.id, b.id));
    expect(raw?.at).toBe(T0 + 72 * HOUR);
  });

  it("lapses at the booking's start when that comes first, and is written for orders and quote requests too", async () => {
    const s = await setup();
    const soon = await booking(s, 10 * HOUR);
    expect((await offerRows(s.db, soon.id))[0]?.validThrough).toBe(T0 + 10 * HOUR);
    const o = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 2, price: EUR(1) }], totalPrice: EUR(2) },
    });
    const [or] = await offerRows(s.db, o.view.item.id);
    expect(or).toMatchObject({
      form: "order",
      by: "customer",
      // The business's price, never the one the request stated.
      terms: { lines: [{ sku: "CH-9", name: "Chain", quantity: 2, price: EUR(1850) }], totalPrice: EUR(3700) },
      validThrough: T0 + 72 * HOUR,
    });
    const q = await s.caps.requestQuote(anon(), {
      payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel", quantity: 2 },
    });
    expect((await offerRows(s.db, q.view.item.id))[0]).toMatchObject({
      form: "request",
      terms: { itemOffered: { name: "Wheel rebuild" }, quantity: 2 },
    });
  });
});

describe("a time we propose", () => {
  it("answers the request: theirs is countered, ours open in the next round, fingerprinted as its links", async () => {
    const s = await setup();
    const b = await booking(s);
    await propose(s, b.id);
    expect(await statuses(s.db, b.id)).toEqual([
      [1, "customer", "countered", 1],
      [2, "business", "open", 2],
    ]);
    const item = await itemOf(s.db, b.id);
    const ours = (await offerRows(s.db, b.id))[1];
    expect(ours?.termsSha).toBe((await openOffer(item, { minNoticeMin: 60 }))?.termsSha);
    expect(ours?.changes).toEqual(["$.endTime", "$.startTime"]);
    // A time a person proposes holds until its start less the minimum notice.
    expect(ours?.validThrough).toBe(WED_14 - 60 * MIN);
    expect(ours?.shown).toMatchObject({ lang: "en", disclosures: ["unheld"] });
    expect(ours?.shown?.human).toMatch(/^We suggest another time for your booking "Full service"/);
    const status = await s.caps.getItemStatus(anon(b.token), { item_id: b.id });
    expect(status.offer).toMatchObject({
      id: ours?.id,
      kind: "time",
      terms_sha: ours?.termsSha,
      changes: ["$.endTime", "$.startTime"],
      warnings: [],
      disclosures: ["unheld"],
    });
  });

  it("replaces our own when proposed again, in the same round, and says so in the email", async () => {
    const s = await setup();
    const b = await booking(s);
    await propose(s, b.id);
    await propose(s, b.id, WED_14 + HOUR);
    expect(await statuses(s.db, b.id)).toEqual([
      [1, "customer", "countered", 1],
      [2, "business", "superseded", 2],
      [3, "business", "open", 2],
    ]);
    await s.drain();
    const mails = await mailOf(s.db, b.id);
    expect(mails.some((m) => /We have changed the time we suggested/.test(m.bodyText))).toBe(true);
  });

  it("from the owner's AI holds at most negotiation.offerValidHours", async () => {
    const s = await setup();
    // Friday, within the opening hours: automation offers only a time we would offer.
    const b = await booking(s, 4 * DAY);
    await propose(s, b.id, T0 + 4 * DAY + 2 * HOUR, ai);
    expect((await offerRows(s.db, b.id)).at(-1)?.validThrough).toBe(T0 + 48 * HOUR);
  });

  it("accepted, is what both agreed; the status door says so, and nothing is accepted twice", async () => {
    const s = await setup();
    const b = await booking(s);
    await propose(s, b.id);
    const status = await s.caps.getItemStatus(anon(b.token), { item_id: b.id });
    const r = await s.caps.customer.acceptOffer(anon(b.token, "k1"), {
      item_id: b.id,
      offer_id: status.offer?.id as string,
      terms_sha: status.offer?.terms_sha as string,
    });
    expect(r.view.item.state).toBe("confirmed");
    expect(await statuses(s.db, b.id)).toEqual([
      [1, "customer", "countered", 1],
      [2, "business", "accepted", 2],
    ]);
    expect((r.view.item.payload as { offer?: unknown }).offer).toMatchObject({ rev: 2, status: "accepted" });
    expect(r.view.agreed).toEqual({ terms: status.offer?.terms, terms_sha: status.offer?.terms_sha });
    const again = await fail(
      s.caps.customer.acceptOffer(anon(b.token, "k2"), { item_id: b.id, terms_sha: status.offer?.terms_sha }),
    );
    expect(again.code).toBe("no_offer");
  });

  it("refuses an answer naming an offer we have replaced since, with the current one", async () => {
    const s = await setup();
    const b = await booking(s);
    await propose(s, b.id);
    const first = await s.caps.getItemStatus(anon(b.token), { item_id: b.id });
    await propose(s, b.id, WED_14 + HOUR);
    const now = await s.caps.getItemStatus(anon(b.token), { item_id: b.id });
    const e = await fail(
      s.caps.customer.acceptOffer(anon(b.token), {
        item_id: b.id,
        offer_id: first.offer?.id as string,
        terms_sha: now.offer?.terms_sha as string,
      }),
    );
    expect(e.code).toBe("offer_changed");
    expect((e.details as { offer: { id: string } }).offer.id).toBe(now.offer?.id);
    const declined = await fail(
      s.caps.customer.declineOffer(anon(b.token), { item_id: b.id, offer_id: first.offer?.id as string }),
    );
    expect(declined.code).toBe("offer_changed");
    expect((await itemOf(s.db, b.id)).state).toBe("proposed");
  });

  it("countered by the customer: theirs opens in the next round, with their reason", async () => {
    const s = await setup();
    const b = await booking(s);
    await propose(s, b.id);
    const r = await s.caps.customer.makeOffer(anon(b.token), {
      item_id: b.id,
      terms: { start_time: "2026-09-24T09:00:00Z" },
      reason_code: "timing_deferred",
    });
    expect(r.view.item.state).toBe("requested");
    const rows = await offerRows(s.db, b.id);
    expect(rows.map((o) => [o.by, o.status, o.round])).toEqual([
      ["customer", "countered", 1],
      ["business", "countered", 2],
      ["customer", "open", 3],
    ]);
    expect(rows[2]).toMatchObject({
      reasonCode: "timing_deferred",
      terms: { startTime: "2026-09-24T09:00:00.000Z" },
      // Its clock: 72 hours on, or its start when that comes first.
      validThrough: Date.parse("2026-09-24T09:00:00Z"),
    });
  });

  it("declined by the customer, is declined with their reason", async () => {
    const s = await setup();
    const b = await booking(s);
    await propose(s, b.id);
    await s.caps.customer.declineOffer(anon(b.token), {
      item_id: b.id,
      reason: "Too late in the day",
      reason_code: "timing_deferred",
    });
    const rows = await offerRows(s.db, b.id);
    expect(rows[1]).toMatchObject({ status: "declined", reasonCode: "timing_deferred" });
    expect((await itemOf(s.db, b.id)).payload).not.toHaveProperty("offer");
  });

  it("withdrawn by a question: the customer's request stands again, and waits for their answer", async () => {
    const s = await setup();
    const b = await booking(s);
    await propose(s, b.id);
    clock.now = T0 + HOUR;
    await transitionItem(s.db, owner, { itemId: b.id, event: "request_info", input: { note: "Which bike?" } });
    expect(await statuses(s.db, b.id)).toEqual([
      [1, "customer", "countered", 1],
      [2, "business", "retracted", 2],
      [3, "customer", "open", 1],
    ]);
    const [raw] = await s.db.orm.select({ at: items.requestExpiresAt }).from(items).where(eq(items.id, b.id));
    // Wound again for their answer, and never past the start they asked for.
    expect(raw?.at).toBe(Math.min(T0 + HOUR + 72 * HOUR, b.start));
    // The owner has what they need, however it came: confirm takes the customer's request.
    await transitionItem(s.db, owner, { itemId: b.id, event: "confirm" });
    expect((await offerRows(s.db, b.id)).at(-1)).toMatchObject({ by: "customer", status: "accepted" });
  });

  it("is withdrawn only when it said it was subject to our confirmation", async () => {
    const s = await setup();
    const b = await booking(s);
    await propose(s, b.id);
    const refused = await fail(transitionItem(s.db, owner, { itemId: b.id, event: "retract" }));
    expect(refused.details).toMatchObject({ guard: "offer_non_binding" });

    const t = await setup({ negotiation: { binding: false } });
    const c = await booking(t);
    await propose(t, c.id);
    const status = await t.caps.getItemStatus(anon(c.token), { item_id: c.id });
    expect(status.offer?.disclosures).toEqual(["unheld", "withdrawable"]);
    expect(status.offer?.human).toContain("Until you accept, we may still withdraw what we proposed.");
    await transitionItem(t.db, owner, { itemId: c.id, event: "retract" });
    expect((await itemOf(t.db, c.id)).state).toBe("requested");
    expect(await statuses(t.db, c.id)).toEqual([
      [1, "customer", "countered", 1],
      [2, "business", "retracted", 2],
      [3, "customer", "open", 1],
    ]);
    await t.drain();
    expect((await mailOf(t.db, c.id)).map((m) => m.template)).toContain("booking.retracted");
  });

  it("keeps one open offer per item when two people propose at once", async () => {
    const s = await setup();
    const b = await booking(s);
    const v = (await itemOf(s.db, b.id)).version;
    const results = await Promise.allSettled([
      transitionItem(s.db, owner, {
        itemId: b.id,
        event: "propose",
        expectedVersion: v,
        input: { startTime: iso(WED_14), endTime: iso(WED_14 + 90 * MIN) },
      }),
      transitionItem(s.db, at("staff", "owner_ui"), {
        itemId: b.id,
        event: "propose",
        expectedVersion: v,
        input: { startTime: iso(WED_14 + HOUR), endTime: iso(WED_14 + HOUR + 90 * MIN) },
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((refused.reason as WriteError).code).toBe("version_conflict");
    expect((await offerRows(s.db, b.id)).filter((o) => o.status === "open")).toHaveLength(1);
  });
});

describe("changes to an order", () => {
  async function ordered(s: Setup) {
    const r = await s.caps.createOrder(anon(), {
      payload: {
        orderedItem: [
          { sku: "CH-9", name: "Chain", quantity: 3, price: EUR(1850) },
          { name: "Fitting", quantity: 1, price: EUR(1000) },
        ],
        totalPrice: EUR(6550),
        delivery: { method: "pickup" },
      },
      contact: { email: "rita@example.com", locale: "en" },
    });
    return { id: r.view.item.id, token: r.accessToken as string };
  }
  const changes = (prod: string) => ({
    orderedItem: [
      { productId: prod, name: "Chain", quantity: 2, price: EUR(1850) },
      { name: "Fitting", quantity: 1, price: EUR(800) },
    ],
    delivery: { method: "pickup", when: "2026-09-25T15:00:00Z" },
    note: "We have two in stock.",
  });

  it("proposed by a person, accepted by the customer: the order is accepted on them", async () => {
    const s = await setup();
    const o = await ordered(s);
    await transitionItem(s.db, owner, { itemId: o.id, event: "propose", input: changes(s.prod) });
    const item = await itemOf(s.db, o.id);
    expect(item.state).toBe("proposed");
    expect(item.payload).toMatchObject({ proposed: { totalPrice: EUR(4500) } });
    const ours = (await offerRows(s.db, o.id))[1];
    expect(ours).toMatchObject({
      form: "order",
      by: "business",
      status: "open",
      round: 2,
      validThrough: T0 + 48 * HOUR,
    });
    const status = await s.caps.getItemStatus(anon(o.token), { item_id: o.id });
    expect(status.offer).toMatchObject({
      kind: "order",
      obligation_to_pay: true,
      terms: { totalPrice: EUR(4500), delivery: { when: "2026-09-25T15:00:00Z" } },
      warnings: [{ type: "warning", code: "price_changed", severity: "requires_buyer_review" }],
    });
    expect(status.human).toMatch(
      /^We suggest some changes to your order .*: 2 × Chain — €37\.00; 1 × Fitting — €8\.00\. Total €45\.00\./,
    );
    expect(status.next?.map((n) => n.action)).toEqual(["accept_offer", "decline_offer", "make_offer"]);
    const r = await s.caps.customer.acceptOffer(anon(o.token), {
      item_id: o.id,
      terms_sha: status.offer?.terms_sha as string,
    });
    expect(r.view.item.state).toBe("accepted");
    expect(r.view.item.payload).toMatchObject({
      orderedItem: [{ quantity: 2 }, { quantity: 1, price: EUR(800) }],
      totalPrice: EUR(4500),
      delivery: { when: "2026-09-25T15:00:00Z" },
    });
    expect(r.view.item.payload).not.toHaveProperty("proposed");
    expect((await offerRows(s.db, o.id))[1]?.status).toBe("accepted");
    const receipt = (await s.db.orm.select().from(jobs)).find((j) => j.kind === "issue_receipt");
    expect(receipt?.payload).toMatchObject({ itemId: o.id, kind: "accepted" });
  });

  it("answered with other quantities, comes back to us as the customer's order; a price of theirs goes to a person", async () => {
    const s = await setup();
    const o = await ordered(s);
    await transitionItem(s.db, owner, { itemId: o.id, event: "propose", input: changes(s.prod) });
    const priced = await s.caps.customer.makeOffer(anon(o.token), {
      item_id: o.id,
      terms: { total_price: EUR(4000) },
      note: "Would you do it for forty?",
    });
    expect(priced).toMatchObject({ waiting_on: "us", appended: true });
    expect("passed_on" in priced && priced.passed_on).toMatch(/^We have passed this on to a person on our team/);
    expect((await itemOf(s.db, o.id)).state).toBe("proposed");
    const said = await s.db.orm.select().from(threadEntries).where(eq(threadEntries.itemId, o.id));
    expect(said.at(-1)?.bodyText).toMatch(/^I would like: total €40\.00\.\n\nWould you do it for forty\?$/);
    const r = await s.caps.customer.makeOffer(anon(o.token), {
      item_id: o.id,
      terms: { lines: [{ index: 0, quantity: 1 }] },
    });
    expect(r.view.item.state).toBe("received");
    expect(r.view.item.payload).toMatchObject({
      orderedItem: [{ quantity: 1 }, { quantity: 1 }],
      totalPrice: EUR(2650),
    });
    expect(await statuses(s.db, o.id)).toEqual([
      [1, "customer", "countered", 1],
      [2, "business", "countered", 2],
      [3, "customer", "open", 3],
    ]);
    await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
    expect((await offerRows(s.db, o.id))[2]?.status).toBe("accepted");
  });

  it("from the owner's AI or a rule: other quantities and delivery, never a price", async () => {
    const s = await setup();
    const o = await ordered(s);
    // A line of its own is a price: a draft for the owner, never sent (ADR-018 §4).
    const drafted = await transitionItem(s.db, ai, { itemId: o.id, event: "propose", input: changes(s.prod) });
    expect(drafted.drafted?.breaches).toContain("custom_line");
    expect((await itemOf(s.db, o.id)).state).toBe("received");
    await transitionItem(s.db, ai, {
      itemId: o.id,
      event: "propose",
      input: { orderedItem: [{ productId: s.prod, name: "Chain", quantity: 2, price: EUR(1850) }] },
    });
    expect((await itemOf(s.db, o.id)).payload).toMatchObject({ proposed: { totalPrice: EUR(3700) } });
  });

  it("reaches the customer by email with its links; declined, it closes the order as they chose", async () => {
    const s = await setup();
    const o = await ordered(s);
    await transitionItem(s.db, owner, { itemId: o.id, event: "propose", input: changes(s.prod) });
    await s.drain();
    const mail = (await mailOf(s.db, o.id)).find((m) => m.template === "order.proposed");
    expect(mail?.bodyText).toContain("We can do your order");
    expect(mail?.bodyText).toContain("2 × Chain — €37.00");
    expect(mail?.bodyText).toMatch(/Please answer by .*\. If the changes do not suit you, decline them/);
    expect(mail?.bodyText).toMatch(/Accept: https:\/\/inbox\.example\/c\//);
    expect(mail?.bodyText).toMatch(/Decline: https:\/\/inbox\.example\/c\//);
    const r = await s.caps.customer.declineOffer(anon(o.token), { item_id: o.id, reason_code: "price_sensitivity" });
    expect(r.view.item.state).toBe("cancelled");
    expect((await offerRows(s.db, o.id))[1]).toMatchObject({ status: "declined", reasonCode: "price_sensitivity" });
  });

  it("is accepted from the link's page, whose button says the customer will pay", async () => {
    const s = await setup();
    const o = await ordered(s);
    await transitionItem(s.db, owner, { itemId: o.id, event: "propose", input: changes(s.prod) });
    const item = await itemOf(s.db, o.id);
    const links = await linksForEmail(s.db, s.caps.secrets, item, {
      mailKey: "test-mail",
      lang: "en",
      base: "https://inbox.example",
      now: clock.now,
    });
    expect([...(links?.keys() ?? [])]).toEqual(["accept_order", "decline_order"]);
    const token = (links?.get("accept_order") ?? "").split("/c/")[1] as string;
    const page = await s.caps.customer.linkView(token, { now: clock.now });
    expect(page).toMatchObject({ status: 200, heading: "Accept our changes?" });
    expect(page.form?.button).toBe("Order with obligation to pay");
    expect(page.rows?.map((r) => r.label)).toEqual([
      "2 × Chain",
      "1 × Fitting",
      "Total",
      "Delivery",
      "Please answer by",
    ]);
    const acted = await s.caps.customer.linkAct(
      token,
      { terms: page.form?.hidden.terms, v: page.form?.hidden.v },
      {
        now: clock.now,
      },
    );
    expect(acted).toEqual({ redirect: `/c/${token}` });
    expect((await itemOf(s.db, o.id)).state).toBe("accepted");
    expect((await s.caps.customer.linkView(token, { now: clock.now })).heading).toMatch(
      /^Thank you: your order .* is confirmed\. Total €45\.00\./,
    );
  });
});

describe("quotes", () => {
  async function asked(s: Setup) {
    const q = await s.caps.requestQuote(anon(), {
      payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel, 28 spokes", quantity: 1 },
      contact: { email: "rita@example.com", locale: "en" },
    });
    return { id: q.view.item.id, token: q.accessToken as string };
  }
  const quote = (value: number) => ({
    totalPrice: EUR(value),
    lines: [{ name: "Build", quantity: 1, price: EUR(value) }],
  });

  it("without a date holds negotiation.offerValidHours; a new one replaces it; the customer may ask again", async () => {
    const s = await setup();
    const q = await asked(s);
    await transitionItem(s.db, owner, { itemId: q.id, event: "quote", input: quote(31000) });
    expect((await itemOf(s.db, q.id)).payload).toMatchObject({ quote: { validThrough: iso(T0 + 48 * HOUR) } });
    await transitionItem(s.db, owner, { itemId: q.id, event: "quote", input: quote(29000) });
    expect(await statuses(s.db, q.id)).toEqual([
      [1, "customer", "countered", 1],
      [2, "business", "superseded", 2],
      [3, "business", "open", 2],
    ]);
    const r = await s.caps.customer.makeOffer(anon(q.token), { item_id: q.id, terms: { quantity: 2 } });
    expect(r.view.item.state).toBe("received");
    expect(r.view.item.payload).toMatchObject({ quantity: 2 });
    expect(r.view.item.payload).not.toHaveProperty("quote");
    expect((await offerRows(s.db, q.id)).at(-1)).toMatchObject({ by: "customer", form: "request", round: 3 });
    await transitionItem(s.db, owner, { itemId: q.id, event: "quote", input: quote(58000) });
    expect((await offerRows(s.db, q.id)).map((o) => o.status)).toEqual([
      "countered",
      "superseded",
      "countered",
      "countered",
      "open",
    ]);
  });

  it("accepted, becomes the promise's own agreed offer, answering the quote", async () => {
    const s = await setup();
    const q = await asked(s);
    await transitionItem(s.db, owner, { itemId: q.id, event: "quote", input: quote(31000) });
    const status = await s.caps.getItemStatus(anon(q.token), { item_id: q.id });
    const r = (await s.caps.customer.acceptOffer(anon(q.token), {
      item_id: q.id,
      terms_sha: status.offer?.terms_sha as string,
    })) as CustomerResult;
    const linked = r.linked?.item.id as string;
    const quoted = (await offerRows(s.db, q.id))[1];
    expect(quoted?.status).toBe("accepted");
    const [agreed] = await offerRows(s.db, linked);
    expect(agreed).toMatchObject({
      rev: 1,
      form: "order",
      status: "accepted",
      parentId: quoted?.id,
      terms: { totalPrice: EUR(31000) },
    });
    expect((await itemOf(s.db, linked)).payload).toMatchObject({ offer: { id: agreed?.id, status: "accepted" } });
  });
});

describe("rounds", () => {
  it("stop automation after the last one; a customer's next suggestion goes to a person, never refused", async () => {
    const s = await setup();
    const b = await booking(s);
    await propose(s, b.id); // round 2
    await s.caps.customer.suggestTime(anon(b.token), { item_id: b.id, start_time: "2026-09-24T09:00:00Z" }); // 3
    // Past the last round automation's offer waits for the owner as a draft (ADR-018 §4).
    const drafted = await propose(s, b.id, WED_14 + 2 * HOUR, ai);
    expect(drafted.drafted?.breaches).toEqual(["rounds_exhausted"]);
    expect((await itemOf(s.db, b.id)).state).toBe("requested");
    await propose(s, b.id, WED_14 + 2 * HOUR); // a person: round 4
    const r = await s.caps.customer.suggestTime(anon(b.token), {
      item_id: b.id,
      start_time: "2026-09-24T10:00:00Z",
      note: "Or Thursday morning?",
    });
    expect(r).toMatchObject({ waiting_on: "us", appended: true });
    expect((r as { passed_on: string }).passed_on).toMatch(/What we proposed still stands until/);
    expect((await itemOf(s.db, b.id)).state).toBe("proposed");
    expect((await offerRows(s.db, b.id)).filter((o) => o.status === "open")).toMatchObject([{ by: "business" }]);
  });
});

describe("holds", () => {
  it("keep the time we propose for the customer, move with it, and become the booking's claim", async () => {
    const s = await setup({ booking: { holdOnPropose: true } });
    const b = await booking(s);
    await propose(s, b.id);
    const open = (await offerRows(s.db, b.id)).find((o) => o.status === "open");
    const held = await s.db.orm.select().from(slotClaims).where(eq(slotClaims.itemId, b.id));
    expect(held.length).toBeGreaterThan(0);
    expect(new Set(held.map((c) => c.offerId))).toEqual(new Set([open?.id]));
    expect((await itemOf(s.db, b.id)).payload).toMatchObject({ offer: { held: true } });
    expect(open?.shown?.disclosures).toEqual(["held"]);
    // Nobody else books it meanwhile.
    const other = await booking(s, WED_14 - T0, { email: "ana@example.com", locale: "en" });
    expect((await fail(transitionItem(s.db, owner, { itemId: other.id, event: "confirm" }))).code).toBe("slot_taken");
    // Proposed again, the hold moves.
    await propose(s, b.id, WED_14 + 2 * HOUR);
    const moved = await s.db.orm.select().from(slotClaims).where(eq(slotClaims.itemId, b.id));
    const reopened = (await offerRows(s.db, b.id)).find((o) => o.status === "open");
    expect(new Set(moved.map((c) => c.offerId))).toEqual(new Set([reopened?.id]));
    await transitionItem(s.db, owner, { itemId: other.id, event: "confirm" });
    const status = await s.caps.getItemStatus(anon(b.token), { item_id: b.id });
    await s.caps.customer.acceptOffer(anon(b.token), { item_id: b.id, terms_sha: status.offer?.terms_sha as string });
    const claimed = await s.db.orm.select().from(slotClaims).where(eq(slotClaims.itemId, b.id));
    expect(claimed.length).toBeGreaterThan(0);
    expect(new Set(claimed.map((c) => c.offerId))).toEqual(new Set([""]));
  });

  it("let go when the customer asks for another time, and are rationed per customer", async () => {
    const s = await setup({ booking: { holdOnPropose: true, maxHolds: 1 } });
    const b = await booking(s);
    await propose(s, b.id);
    await s.caps.customer.suggestTime(anon(b.token), { item_id: b.id, start_time: "2026-09-24T09:00:00Z" });
    expect(await s.db.orm.select().from(slotClaims).where(eq(slotClaims.itemId, b.id))).toHaveLength(0);
    // The same customer (their party) asking twice: one held, the next unheld.
    await propose(s, b.id);
    const party = (await itemOf(s.db, b.id)).partyId;
    const second = await s.caps.createBooking(
      { ...anon(), actor: { ...anon().actor, partyId: party } },
      {
        payload: {
          reservationFor: { serviceId: s.svc, name: "Full service" },
          startTime: iso(WED_14 + 3 * HOUR),
          endTime: iso(WED_14 + 3 * HOUR + 90 * MIN),
        },
      },
    );
    await propose(s, second.view.item.id, WED_14 + 3 * HOUR);
    expect(await s.db.orm.select().from(slotClaims).where(eq(slotClaims.itemId, second.view.item.id))).toHaveLength(0);
    expect((await itemOf(s.db, second.view.item.id)).payload).not.toMatchObject({ offer: { held: true } });
  });
});

describe("an item from before offers had a table", () => {
  it("gets the offer it holds the first time it moves, with the fingerprint its links already carry", async () => {
    const s = await setup();
    const b = await booking(s);
    await propose(s, b.id);
    const before = await s.caps.getItemStatus(anon(b.token), { item_id: b.id });
    // As a live instance's proposal is after the upgrade: no offers, no pointer.
    await s.db.client.batch([
      { sql: "DELETE FROM item_offers WHERE item_id = ?", params: [b.id], method: "run" },
      { sql: "UPDATE items SET payload = json_remove(payload, '$.offer') WHERE id = ?", params: [b.id], method: "run" },
    ]);
    const legacy = await s.caps.getItemStatus(anon(b.token), { item_id: b.id });
    expect(legacy.offer).toMatchObject({ id: null, terms_sha: before.offer?.terms_sha });
    const r = await s.caps.customer.acceptOffer(anon(b.token), {
      item_id: b.id,
      offer_id: legacyOfferId(b.id),
      terms_sha: legacy.offer?.terms_sha as string,
    });
    expect(r.view.item.state).toBe("confirmed");
    expect(await offerRows(s.db, b.id)).toMatchObject([
      { id: legacyOfferId(b.id), rev: 1, by: "business", status: "accepted", termsSha: before.offer?.terms_sha },
    ]);
  });
});

describe("the negotiation settings", () => {
  it("bound what automation agrees to, so only the owner in person changes them", async () => {
    const s = await setup();
    const refused = await fail(s.caps.updateSettings(ai, { doc: { negotiation: { maxRounds: 9, binding: false } } }));
    expect(refused.code).toBe("not_allowed");
    // Written back as they were read, they change nothing and are accepted. (The cancellation window
    // bounds how late the AI takes a change, so it may lengthen it, never shorten it.)
    const read = await s.caps.getSettings(ai);
    await s.caps.updateSettings(ai, {
      doc: { negotiation: read.doc.negotiation, booking: { cancellationWindowMin: 2880 } },
    });
    // The AI never reads the limits it is held to, nor the rewards: withheld, and kept when written back.
    expect(read.withheld).toEqual(["negotiation.ai", "negotiation.rewards"]);
    expect(read.doc.negotiation).not.toHaveProperty("ai");
    const saved = await s.caps.updateSettings(owner, { doc: { negotiation: { maxRounds: 5 } } });
    expect(saved.withheld).toEqual([]);
    expect(saved.doc.negotiation).toEqual({
      offerValidHours: 48,
      counterValidHours: 72,
      maxRounds: 5,
      binding: true,
      priceCounters: false,
      perCustomer: { open: 3, priceCounters: 3, days: 30 },
      rewards: {},
      changes: { maxPerItem: 3, customerCutoffMin: null },
      ai: {
        maxDiscountPct: 0,
        mayPriceCustom: false,
        maxTimeShiftMin: 10_080,
        maxDelayDays: 0,
        maxRefundMinor: 0,
        mayAcceptChanges: true,
        mayProposeChanges: false,
        mayAuthorizeReturnsInPolicy: true,
      },
    });
  });
});
