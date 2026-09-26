import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { ensureLifecycleSweep, LIFECYCLE_SWEEP_KIND, lifecycleSweepHandler } from "../src/jobs/lifecycle";
import { offerRows } from "../src/negotiation/offers";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, items, outboundMail, products, services, slotClaims } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { type Caller, rowToItem, transitionItem, WriteError } from "../src/write/index";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * Deadlines (ADR-018 §1, §11): a request nobody answered lapses at its clock, what we proposed at its
 * validity, and either is refused in the write that would take it once its date has passed, whether
 * or not the sweep has come by. The customer is told in the business's words; a request from before
 * the clock existed never lapses on its own. Runs on Node and in workerd.
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
const anon = (accessToken?: string): Caller => ({
  actor: { kind: "customer_agent", id: "agent:test", channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => clock.now,
  ...(accessToken ? { accessToken } : {}),
});
const EUR = (value: number) => ({ value, currency: "EUR" });
const iso = (ms: number) => new Date(ms).toISOString();

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
    new Capabilities(db, createSecretBox(["expiry-test-secret-0123456789abcdef"]), "https://inbox.example"),
  );
  const runner = createRunner({ mailOut: logMailOut(), receipts: caps.receipts }).register(
    LIFECYCLE_SWEEP_KIND,
    lifecycleSweepHandler(),
  );
  const drain = async () => {
    for (let i = 0; i < 30; i++) if ((await runner.runDue(db, { now: clock.now, limit: 100 })).claimed === 0) return;
  };
  /** The sweep that runs at `t`, and everything it causes. */
  const sweep = async (t: number) => {
    clock.now = t;
    await ensureLifecycleSweep(db, t);
    await drain();
  };
  return { db, caps, svc, prod, drain, sweep };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function booking(s: Setup, startIn = 5 * DAY + 2 * HOUR) {
  const start = T0 + startIn;
  const r = await s.caps.createBooking(anon(), {
    payload: {
      reservationFor: { serviceId: s.svc, name: "Full service" },
      startTime: iso(start),
      endTime: iso(start + 90 * MIN),
    },
    contact: { email: "rita@example.com", locale: "en" },
  });
  return { id: r.view.item.id, token: r.accessToken as string, start };
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

const stateOf = async (db: Db, id: string) =>
  (await db.orm.select({ state: items.state }).from(items).where(eq(items.id, id)))[0]?.state;
const customerMail = async (db: Db, id: string) =>
  (await db.orm.select().from(outboundMail).where(eq(outboundMail.itemId, id))).filter(
    (m) => m.recipient === "customer",
  );

describe("a request nobody answered", () => {
  it("lapses at its clock, and the customer hears we could not answer in time", async () => {
    const s = await setup();
    const b = await booking(s);
    await s.sweep(T0 + 72 * HOUR - MIN);
    expect(await stateOf(s.db, b.id)).toBe("requested");
    await s.sweep(T0 + 72 * HOUR);
    expect(await stateOf(s.db, b.id)).toBe("expired");
    expect((await offerRows(s.db, b.id))[0]?.status).toBe("expired");
    const mail = (await customerMail(s.db, b.id)).find((m) => m.template === "booking.expired");
    expect(mail?.bodyText).toContain("We are sorry: we could not answer in time, so we have closed your request");
  });

  it("before the clock existed, never lapses on its own", async () => {
    const s = await setup();
    const b = await booking(s);
    await s.db.client.query({
      sql: "UPDATE items SET request_expires_at = NULL WHERE id = ?",
      params: [b.id],
      method: "run",
    });
    await s.sweep(T0 + 30 * DAY);
    expect(await stateOf(s.db, b.id)).toBe("requested");
  });

  it("waiting on the customer's details, lapses too, and says we did not hear back", async () => {
    const s = await setup();
    const o = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 1, price: EUR(1850) }], totalPrice: EUR(1850) },
      contact: { email: "rita@example.com", locale: "en" },
    });
    const id = o.view.item.id;
    clock.now = T0 + DAY;
    await transitionItem(s.db, owner, { itemId: id, event: "request_info", input: { note: "Which bike?" } });
    // The clock was wound again for their answer: 72 hours from the question.
    await s.sweep(T0 + DAY + 72 * HOUR - MIN);
    expect(await stateOf(s.db, id)).toBe("needs_info");
    await s.sweep(T0 + DAY + 72 * HOUR);
    expect(await stateOf(s.db, id)).toBe("expired");
    const mail = (await customerMail(s.db, id)).find((m) => m.template === "order.expired");
    expect(mail?.bodyText).toContain("We did not hear back from you about");
  });

  it("taken by us after it lapsed, goes back to the customer as our offer on the same terms: late, never refused", async () => {
    const s = await setup();
    const b = await booking(s);
    clock.now = T0 + 80 * HOUR; // lapsed, and the sweep has not come by
    const r = await transitionItem(s.db, owner, { itemId: b.id, event: "confirm" });
    expect(r.converted).toBe("request_lapsed");
    expect(r.view.item.state).toBe("proposed");
    expect(r.view.item.payload).toMatchObject({ proposed: { startTime: iso(b.start), totalPrice: EUR(4500) } });
    const status = await s.caps.getItemStatus(anon(b.token), { item_id: b.id });
    const accepted = await s.caps.customer.acceptOffer(anon(b.token), {
      item_id: b.id,
      terms_sha: status.offer?.terms_sha as string,
    });
    expect(accepted.view.item.state).toBe("confirmed");
    expect(accepted.view.item.payload).toMatchObject({ startTime: iso(b.start) });
  });
});

describe("what we proposed", () => {
  it("lapses at its validity: the sweep closes it, lets its place go, and tells the customer until when it held", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { booking: { holdOnPropose: true } } });
    const b = await booking(s);
    const wed = Date.parse("2026-09-23T13:00:00Z");
    // The owner's AI proposes: its offer holds at most negotiation.offerValidHours (48).
    await transitionItem(s.db, ai, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(wed), endTime: iso(wed + 90 * MIN) },
    });
    expect(await s.db.orm.select().from(slotClaims).where(eq(slotClaims.itemId, b.id))).not.toHaveLength(0);
    await s.sweep(T0 + 48 * HOUR);
    expect(await stateOf(s.db, b.id)).toBe("expired");
    expect((await offerRows(s.db, b.id)).at(-1)?.status).toBe("expired");
    expect(await s.db.orm.select().from(slotClaims).where(eq(slotClaims.itemId, b.id))).toHaveLength(0);
    const mail = (await customerMail(s.db, b.id)).find((m) => m.template === "booking.expired");
    expect(mail?.bodyText).toMatch(
      /The time we suggested for "Full service" has lapsed: it could be accepted until Wednesday/,
    );
  });

  it("is refused a millisecond after its date, in the write, before the sweep comes by", async () => {
    const s = await setup();
    const b = await booking(s);
    const wed = Date.parse("2026-09-23T13:00:00Z");
    await transitionItem(s.db, ai, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(wed), endTime: iso(wed + 90 * MIN) },
    });
    const status = await s.caps.getItemStatus(anon(b.token), { item_id: b.id });
    expect(status.offer?.deadline).toBe(iso(T0 + 48 * HOUR));
    expect(status.offer?.expired).toBe(false);
    clock.now = T0 + 48 * HOUR + 1;
    // The customer's view says so before the sweep has come by: nothing to accept any more.
    const lapsed = await s.caps.getItemStatus(anon(b.token), { item_id: b.id });
    expect(lapsed.offer?.expired).toBe(true);
    expect(lapsed.next?.map((n) => n.action)).toEqual(["decline_offer", "suggest_time"]);
    const e = await fail(
      s.caps.customer.acceptOffer(anon(b.token), { item_id: b.id, terms_sha: status.offer?.terms_sha as string }),
    );
    expect(e.code).toBe("offer_expired");
    expect(e.status).toBe(410);
    expect(e.message).toMatch(
      /^The time we suggested could be accepted until .*\. Pick another time, or write to us\.$/,
    );
    // …and in the write itself, whatever door.
    const w = await fail(transitionItem(s.db, anon(b.token), { itemId: b.id, event: "accept" }));
    expect(w.code).toBe("offer_expired");
    expect(await stateOf(s.db, b.id)).toBe("proposed");
  });

  it("a quote lapses at its date; one found long after, closes without an email", async () => {
    const s = await setup();
    const ask = async () => {
      const q = await s.caps.requestQuote(anon(), {
        payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel" },
        contact: { email: "rita@example.com", locale: "en" },
      });
      return q.view.item.id;
    };
    const quote = (id: string, until: number) =>
      transitionItem(s.db, owner, {
        itemId: id,
        event: "quote",
        input: { totalPrice: EUR(31000), validThrough: iso(until), lines: [] },
      });
    const fresh = await ask();
    await quote(fresh, T0 + 2 * DAY);
    await s.sweep(T0 + 2 * DAY + MIN);
    expect(await stateOf(s.db, fresh)).toBe("expired");
    const mail = (await customerMail(s.db, fresh)).find((m) => m.template === "quote.expired");
    expect(mail?.bodyText).toMatch(/Our quote for "Wheel rebuild" expired on Wednesday, 23 September 2026/);

    const old = await ask();
    await quote(old, T0 + 3 * DAY);
    clock.now += 2 * MIN;
    await s.drain();
    await s.sweep(T0 + 11 * DAY);
    expect(await stateOf(s.db, old)).toBe("expired");
    // The quote was emailed; its lapse, found eight days late, is news too old to send.
    expect((await customerMail(s.db, old)).map((m) => m.template)).toEqual(["quote.quoted"]);
  });

  it("changes to an order lapse too, and the order closes", async () => {
    const s = await setup();
    const o = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 3, price: EUR(1850) }], totalPrice: EUR(5550) },
      contact: { email: "rita@example.com", locale: "en" },
    });
    const id = o.view.item.id;
    await transitionItem(s.db, owner, {
      itemId: id,
      event: "propose",
      input: {
        orderedItem: [{ productId: s.prod, name: "Chain", quantity: 2, price: EUR(1850) }],
        validThrough: iso(T0 + 6 * HOUR),
      },
    });
    await s.sweep(T0 + 6 * HOUR);
    expect(await stateOf(s.db, id)).toBe("expired");
    const mail = (await customerMail(s.db, id)).find((m) => m.template === "order.expired");
    expect(mail?.bodyText).toContain("The changes we suggested to your order");
  });
});

describe("an item from before offers had a table", () => {
  it("proposed, gets its offer from the sweep, and lapses when its email said", async () => {
    const s = await setup();
    const b = await booking(s);
    const wed = Date.parse("2026-09-23T13:00:00Z");
    await transitionItem(s.db, owner, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(wed), endTime: iso(wed + 90 * MIN) },
    });
    await s.db.client.batch([
      { sql: "DELETE FROM item_offers WHERE item_id = ?", params: [b.id], method: "run" },
      { sql: "UPDATE items SET payload = json_remove(payload, '$.offer') WHERE id = ?", params: [b.id], method: "run" },
    ]);
    await s.sweep(T0 + HOUR);
    const [legacy] = await offerRows(s.db, b.id);
    expect(legacy).toMatchObject({ rev: 1, by: "business", status: "open", validThrough: wed - 60 * MIN });
    const [row] = await s.db.orm.select().from(items).where(eq(items.id, b.id));
    expect(row && rowToItem(row).state).toBe("proposed");
    await s.sweep(wed - 60 * MIN);
    expect(await stateOf(s.db, b.id)).toBe("expired");
  });
});
