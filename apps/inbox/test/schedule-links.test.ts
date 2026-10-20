import { createApiKey } from "@surfingdog/adapters";
import {
  type Db,
  registerScheduleSource,
  type ScheduledItem,
  type ScheduledPayment,
  type WantedLink,
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { MOLLIE_LIVE_KEY, STRIPE_LIVE_KEY } from "../../../packages/adapters/test/fixtures/payments";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";
import { molliePlatform, stripePlatform } from "./pay-platforms";

/**
 * Pay links on a payment schedule (ADR-032), through the payments side an order uses: an item type
 * whose price is paid in parts says which entries want a link now (`ScheduleSource`), and gets one live
 * link per entry, for its amount and window, on the business's own account; the platform's word, read
 * back, is handed to the item's source; a link whose window closes is switched off on the platform; a
 * payment that lands after that is the source's to take or to leave for the owner to refund. A card
 * held for a booking is a page in `mode=setup`, made when it is opened, switched on by the owner only
 * once the key has what it needs. Orders are untouched by all of it (`payments.test.ts`).
 */
const BASE = "https://inbox.example.com";
const SECRET_KEY = "schedule-links-secret-0123456789abcdef";
const HOUR = 3_600_000;

/** What the test's item type wants, entry by entry, and what it was told. */
const wanted = new Map<string, WantedLink[]>();
const paid: ScheduledPayment[] = [];
const closed: { itemId: string; scheduleId: string; why: string }[] = [];
const opened: { itemId: string; scheduleId: string; url: string }[] = [];
/** Items whose payments come too late: the source does not take them. */
const lapsed = new Set<string>();

registerScheduleSource("booking", {
  async wanted(_db, itemId): Promise<ScheduledItem | null> {
    const links = wanted.get(itemId);
    if (!links) return null;
    const done = new Set(paid.filter((p) => p.itemId === itemId).map((p) => p.scheduleId));
    return {
      id: itemId,
      type: "booking",
      sandbox: false,
      locale: "en",
      reference: itemId.slice(-6).toUpperCase(),
      links: links.filter((l) => !done.has(l.scheduleId)),
    };
  },
  async paid(_db, payment) {
    paid.push(payment);
    return lapsed.has(payment.itemId)
      ? { applied: false, note: "the booking had lapsed and its nights were taken" }
      : { applied: true, note: `${payment.purpose} paid` };
  },
  async opened(_db, link) {
    opened.push(link);
  },
  async closed(_db, link) {
    closed.push(link);
  },
});

async function setup(platform: "stripe" | "mollie" = "stripe") {
  const db = await freshDb();
  const stripe = stripePlatform(STRIPE_LIVE_KEY, BASE);
  const mollie = molliePlatform(MOLLIE_LIVE_KEY);
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    mailOut: logMailOut(),
    secretKey: SECRET_KEY,
    baseUrl: BASE,
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).host === "api.mollie.com"
        ? mollie.fetch(input, init)
        : stripe.fetch(input, init)) as typeof fetch,
  });
  const owner = { authorization: `Bearer ${(await createApiKey(db, { kind: "owner", name: "cli" })).key}` };
  const call = (method: string, path: string, body?: unknown) =>
    inbox.app.request(
      new Request(`${BASE}${path}`, {
        method,
        headers: { ...owner, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  expect(
    (
      await call("PUT", "/v1/owner/settings", {
        doc: {
          business: { name: "Ryokan Hoshi", currency: "JPY", timezone: "Asia/Tokyo" },
          email: { fromAddress: "stay@ryokan-hoshi.example" },
          notifications: { ownerEmail: "okami@ryokan-hoshi.example", appUrl: BASE },
        },
      })
    ).status,
  ).toBe(200);
  const values = platform === "stripe" ? { api_key: STRIPE_LIVE_KEY } : { api_key: MOLLIE_LIVE_KEY };
  const connected = await call("POST", "/v1/owner/integrations", { kind: platform, values });
  expect(connected.status, await connected.clone().text()).toBe(201);
  const conn = ((await connected.json()) as { id: string }).id;
  return { db, inbox, call, stripe, mollie, pending, conn };
}
type S = Awaited<ReturnType<typeof setup>>;

let seq = 0;
/** A confirmed booking, written as the inbox keeps one: the item a stay or a deposit would be. */
async function booking(db: Db): Promise<string> {
  const n = ++seq;
  const id = `01JDBOOKING0000000000000${String(n).padStart(3, "0")}`;
  const party = `01JDPARTY00000000000000${String(n).padStart(3, "0")}`;
  const now = Date.now();
  await db.client.batch([
    {
      sql: "INSERT INTO parties (id, kind, display_name, locale, contact, created_at, updated_at) VALUES (?, 'person', 'Maria A.', 'en', ?, ?, ?)",
      params: [party, JSON.stringify({ name: "Maria A.", email: "maria@example.com", locale: "en" }), now, now],
      method: "run",
    },
    {
      sql: `INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at)
            VALUES (?, 'booking', 'confirmed', 1, ?, 'rest', ?, '{}', ?, ?)`,
      params: [
        id,
        party,
        JSON.stringify({
          reservationFor: { serviceId: "svc", name: "Japanese room" },
          startTime: new Date(now + 30 * 24 * HOUR).toISOString(),
          endTime: new Date(now + 33 * 24 * HOUR).toISOString(),
          totalPrice: { value: 90_540, currency: "JPY" },
        }),
        now,
        now,
      ],
      method: "run",
    },
  ]);
  return id;
}

async function rows(s: S, itemId: string) {
  const { rows } = await s.db.client.query({
    sql: "SELECT schedule_id, purpose, state, amount, currency, expires_at, url FROM connector_payments WHERE item_id = ? ORDER BY created_at, rowid",
    params: [itemId],
    method: "all",
  });
  return rows.map((r) => ({
    scheduleId: String(r[0]),
    purpose: String(r[1]),
    state: String(r[2]),
    amount: Number(r[3]),
    currency: String(r[4]),
    expiresAt: r[5] === null ? null : Number(r[5]),
    url: r[6] === null ? null : String(r[6]),
  }));
}

async function ensure(s: S, itemId: string, now = Date.now()) {
  return s.inbox.caps.connectors.payments.ensure(itemId, now);
}

describe("links on a payment schedule", () => {
  it("makes one link per entry, a deposit and a balance at once, each for its amount in yen", async () => {
    const s = await setup();
    const id = await booking(s.db);
    const window = Date.now() + 24 * HOUR;
    wanted.set(id, [
      {
        scheduleId: "deposit",
        purpose: "deposit",
        amount: { value: 25_800, currency: "JPY" },
        expiresAt: window,
        title: "Ryokan Hoshi · 3 nights from 12 Dec · deposit",
      },
      {
        scheduleId: "balance",
        purpose: "balance",
        amount: { value: 64_740, currency: "JPY" },
        expiresAt: null,
        title: "Ryokan Hoshi · 3 nights from 12 Dec · balance",
      },
    ]);
    await ensure(s, id);
    // Asked again (another event, a retry): nothing new.
    await ensure(s, id);
    expect(await rows(s, id)).toMatchObject([
      { scheduleId: "deposit", purpose: "deposit", state: "open", amount: 25_800, currency: "JPY", expiresAt: window },
      { scheduleId: "balance", purpose: "balance", state: "open", amount: 64_740, currency: "JPY", expiresAt: null },
    ]);
    const links = [...s.stripe.links.values()];
    expect(links.map((l) => [l.amount, l.currency, l.submit, l.name])).toEqual([
      [25_800, "jpy", "book", "Ryokan Hoshi · 3 nights from 12 Dec · deposit"],
      [64_740, "jpy", "book", "Ryokan Hoshi · 3 nights from 12 Dec · balance"],
    ]);
    expect(opened.filter((o) => o.itemId === id).map((o) => o.scheduleId)).toEqual(["deposit", "balance"]);
  });

  it("hands what was paid, read back from Stripe, to the item's source; the paid entry wants no link again", async () => {
    const s = await setup();
    const id = await booking(s.db);
    wanted.set(id, [
      {
        scheduleId: "deposit",
        purpose: "deposit",
        amount: { value: 25_800, currency: "JPY" },
        expiresAt: Date.now() + 24 * HOUR,
        title: "Ryokan Hoshi · deposit",
      },
    ]);
    await ensure(s, id);
    const [link] = [...s.stripe.links.values()];
    const hook = await s.inbox.app.request(await s.stripe.pay(link?.id ?? ""));
    expect(hook.status).toBe(200);
    expect(paid.filter((p) => p.itemId === id)).toMatchObject([
      { scheduleId: "deposit", purpose: "deposit", amount: { value: 25_800, currency: "JPY" } },
    ]);
    expect((await rows(s, id))[0]?.state).toBe("paid");
    await ensure(s, id);
    expect(await rows(s, id)).toHaveLength(1);
  });

  it("closes a link when its window closes, on Stripe too, and tells the source", async () => {
    const s = await setup();
    const id = await booking(s.db);
    const window = Date.now() + HOUR;
    wanted.set(id, [
      {
        scheduleId: "deposit",
        purpose: "deposit",
        amount: { value: 25_800, currency: "JPY" },
        expiresAt: window,
        title: "Ryokan Hoshi · deposit",
      },
    ]);
    await ensure(s, id);
    const [link] = [...s.stripe.links.values()];
    await s.inbox.caps.connectors.run(s.conn, window + 5 * 60_000, "sync");
    expect((await rows(s, id))[0]?.state).toBe("closed");
    expect(link?.active).toBe(false);
    expect(closed.filter((c) => c.itemId === id)).toEqual([
      expect.objectContaining({ scheduleId: "deposit", why: "expired" }),
    ]);
    // Past its window, no new link is made for it.
    await ensure(s, id, window + 10 * 60_000);
    expect(await rows(s, id)).toHaveLength(1);
  });

  it("leaves a payment that lands too late for the owner to refund, and says so on the link", async () => {
    const s = await setup();
    const id = await booking(s.db);
    lapsed.add(id);
    wanted.set(id, [
      {
        scheduleId: "deposit",
        purpose: "deposit",
        amount: { value: 25_800, currency: "JPY" },
        expiresAt: Date.now() + HOUR,
        title: "Ryokan Hoshi · deposit",
      },
    ]);
    await ensure(s, id);
    const [link] = [...s.stripe.links.values()];
    const hook = await s.inbox.app.request(await s.stripe.pay(link?.id ?? ""));
    expect(hook.status).toBe(200);
    const { rows: noted } = await s.db.client.query({
      sql: "SELECT note FROM connector_payments WHERE item_id = ?",
      params: [id],
      method: "all",
    });
    expect(String(noted[0]?.[0])).toContain("refund it in Stripe");
    const { rows: notices } = await s.db.client.query({
      sql: "SELECT count(*) FROM jobs WHERE kind = 'pay_notice' AND payload LIKE '%paid_after%'",
      method: "all",
    });
    expect(Number(notices[0]?.[0])).toBe(1);
  });

  it("closes a live link whose entry changed, and makes the one it is now", async () => {
    const s = await setup();
    const id = await booking(s.db);
    const entry = (value: number): WantedLink => ({
      scheduleId: "difference-1",
      purpose: "difference",
      amount: { value, currency: "JPY" },
      expiresAt: null,
      title: "Ryokan Hoshi · new dates · difference",
    });
    wanted.set(id, [entry(5_660)]);
    await ensure(s, id);
    wanted.set(id, [entry(7_200)]);
    await ensure(s, id);
    expect((await rows(s, id)).map((r) => [r.state, r.amount])).toEqual([
      ["closed", 5_660],
      ["open", 7_200],
    ]);
    wanted.set(id, []);
    await ensure(s, id);
    expect((await rows(s, id)).map((r) => r.state)).toEqual(["closed", "closed"]);
  });

  it("refuses a currency Mollie has no test for, with its reason, and asks Mollie to close a deposit with its window", async () => {
    const s = await setup("mollie");
    const id = await booking(s.db);
    wanted.set(id, [
      {
        scheduleId: "deposit",
        purpose: "deposit",
        amount: { value: 2_000_000, currency: "KES" },
        expiresAt: Date.now() + 6 * HOUR,
        title: "Kijani House · deposit",
      },
    ]);
    await ensure(s, id);
    expect(await rows(s, id)).toMatchObject([{ state: "error" }]);
    const second = await booking(s.db);
    const window = Date.parse("2026-12-01T09:00:00Z");
    wanted.set(second, [
      {
        scheduleId: "deposit",
        purpose: "deposit",
        amount: { value: 25_800, currency: "JPY" },
        expiresAt: window,
        title: "Ryokan Hoshi · deposit",
      },
    ]);
    await ensure(s, second, window - 6 * HOUR);
    const [link] = [...s.mollie.links.values()];
    expect(link).toMatchObject({ amount: { value: "25800", currency: "JPY" }, expiresAt: "2026-12-01T09:00:00+00:00" });
  });
});

describe("a card to hold a booking", () => {
  it("is switched on only once the key may make the page, and the missing permissions are named", async () => {
    const s = await setup();
    s.stripe.holds.allowed = false;
    const refused = await s.inbox.caps.connectors.payments.setGuarantees(s.conn, true, Date.now());
    expect(refused).toEqual({ on: false, missing: ["Checkout Sessions: Write", "Customers: Write"] });
    s.stripe.holds.allowed = true;
    expect(await s.inbox.caps.connectors.payments.setGuarantees(s.conn, true, Date.now())).toEqual({
      on: true,
      missing: [],
    });
  });

  it("makes a page in setup mode when the guest opens it, saves nothing until Stripe says so, then holds", async () => {
    const s = await setup();
    const id = await booking(s.db);
    const payments = s.inbox.caps.connectors.payments;
    const request = {
      itemId: id,
      sandbox: false,
      currency: "JPY",
      reference: "4F2K9Q",
      language: "en",
      returnUrl: `${BASE}/c/tok/card/done`,
      cancelUrl: `${BASE}/c/tok`,
      ttlMs: 2 * HOUR,
    };
    expect(await payments.openGuarantee(request, Date.now())).toEqual({
      refused: "Card holds are not switched on for this business.",
    });
    await payments.setGuarantees(s.conn, true, Date.now());
    const now = Date.now();
    const page = await payments.openGuarantee(request, now);
    expect(page).toMatchObject({ url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//) });
    const [session] = [...s.stripe.sessions.values()] as unknown as Record<string, unknown>[];
    expect(session).toMatchObject({ mode: "setup", currency: "jpy", customer_creation: "always", submit_type: null });
    expect(Number(session?.expires_at) * 1000).toBeLessThanOrEqual(now + 2 * HOUR + 1000);
    // Opened again while it lasts: the same page.
    expect(await payments.openGuarantee(request, now + 60_000)).toEqual(page);
    expect(await payments.checkGuarantee(id, now + 120_000)).toBe(false);
    s.stripe.saveCard(String(session?.id));
    expect(await payments.checkGuarantee(id, now + 180_000)).toBe(true);
    expect(paid.filter((p) => p.itemId === id)).toMatchObject([
      { scheduleId: "guarantee", purpose: "guarantee", amount: { value: 0, currency: "JPY" } },
    ]);
  });
});
