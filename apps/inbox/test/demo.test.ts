import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { consume, createApiKey, DEMO_LIMITS, DEMO_SHARED, EVERYONE } from "@surfingdog/adapters";
import { type Caller, type Db, schema } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInbox, type Inbox } from "../src/app";
import {
  DEMO_KEEP,
  DEMO_NIGHTLY_KIND,
  ensureDemo,
  nextNightly,
  ownerOnlyMailOut,
  shopTime,
  summaryText,
  wipeDemo,
} from "../src/demo";
import { localTime, seedSurfingDog } from "../src/seed";
import { freshDb } from "./harness";

/**
 * The public demo shop (INBOX_DEMO=1, src/demo.ts). Anyone's AI can book there and type anyone's
 * email address, so these hold the lines that matter: no customer is ever emailed, no network is ever
 * called, the live view shows nothing about anyone, and none of it exists when demo mode is off.
 * Runs on Node and in workerd.
 */
const BASE = "https://demo.test";
const OWNER = "owner@example.com";
const TZ = "Europe/Lisbon";

/** Things a tester might type that must never leave the instance or show in the live view. */
const PII = {
  name: "Zeferino Quaresma",
  email: "zeferino.quaresma@example.net",
  phone: "+351 912 000 111",
  message: "SECRET-NOTE-42 please ring the bell twice",
  bookingName: "CUSTOM-BOOKING-NAME",
  lineName: "LINE-NAME-LEAK",
  unknownLine: "UNKNOWN-LINE-LEAK",
  quoteName: "QUOTE-NAME-LEAK",
  quoteText: "QUOTE-DESCRIPTION-LEAK",
};

/** The next Saturday at 09:00 in Lisbon, at least a day away: the demo's promised booking. */
function nextSaturdayMorning(now = Date.now()): { start: string; end: string } {
  for (let d = 1; d <= 8; d++) {
    const t = localTime(now, TZ, d, 9, 0);
    const day = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date(t));
    if (day === "Sat") return { start: new Date(t).toISOString(), end: new Date(t + 90 * 60_000).toISOString() };
  }
  throw new Error("no Saturday within eight days");
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.50", ...headers },
    body: JSON.stringify(body),
  });

async function drain(inbox: Inbox, db: Db, now = Date.now()): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const r = await inbox.runner.runDue(db, { now, limit: 50, workerId: "test" });
    if (r.claimed === 0) return;
  }
}

async function demoInbox(opts: { fetchImpl?: typeof fetch } = {}) {
  const db = await freshDb();
  const mail = logMailOut();
  const inbox = createInbox({
    db,
    mailOut: mail,
    baseUrl: BASE,
    secretKey: "demo-test-secret-key-0123456789abcdef",
    ownerEmails: [OWNER],
    background: () => {},
    fetchImpl: opts.fetchImpl,
    demo: { ownerEmails: [OWNER], from: { address: "demo@demo.test", name: "Demo" } },
  });
  await inbox.prepare();
  const services = await db.orm.select({ id: schema.services.id, name: schema.services.name }).from(schema.services);
  const full = services.find((s) => s.name === "Full service")?.id;
  if (!full) throw new Error("the demo shop has no Full service");
  return { db, mail, inbox, app: inbox.app, full };
}

/** A tester's visit: a booking, an order through MCP, a quote request and a message, all full of personal data. */
async function visit(s: Awaited<ReturnType<typeof demoInbox>>) {
  const slot = nextSaturdayMorning();
  const contact = { name: PII.name, email: PII.email, phone: PII.phone };
  const booking = await s.app.request(
    post("/v1/bookings", {
      payload: {
        reservationFor: { serviceId: s.full, name: PII.bookingName },
        startTime: slot.start,
        endTime: slot.end,
        notes: PII.message,
      },
      contact,
      message: PII.message,
      idempotency_key: "demo-booking-1",
    }),
  );
  expect(booking.status).toBe(201);
  const bookingId = ((await booking.json()) as { view: { item: { id: string } } }).view.item.id;

  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: async (input: string | URL, init?: RequestInit): Promise<Response> => s.app.request(String(input), init),
  });
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(transport);
  const order = await client.callTool({
    name: "create_order",
    arguments: {
      payload: {
        orderedItem: [
          { sku: "CH-9", name: PII.lineName, quantity: 2, price: { value: 1, currency: "EUR" } },
          { sku: "NOPE-1", name: PII.unknownLine, quantity: 1, price: { value: 500, currency: "EUR" } },
        ],
        totalPrice: { value: 501, currency: "EUR" },
        notes: PII.message,
      },
      contact,
      idempotency_key: "demo-order-1",
    },
  });
  expect(order.isError ?? false).toBe(false);
  const smallOrder = await client.callTool({
    name: "create_order",
    arguments: {
      payload: {
        orderedItem: [{ sku: "BP-SH-RES", name: PII.lineName, quantity: 1, price: { value: 1290, currency: "EUR" } }],
        totalPrice: { value: 1290, currency: "EUR" },
      },
      contact,
      idempotency_key: "demo-order-2",
    },
  });
  const orderId = (smallOrder.structuredContent as { view: { item: { id: string } } }).view.item.id;
  await client.close();

  const quote = await s.app.request(
    post("/v1/quotes", {
      payload: { itemOffered: { name: PII.quoteName }, description: PII.quoteText },
      contact,
    }),
  );
  expect(quote.status).toBe(201);
  // A seeded customer's address and words that ask for a one-time code: the code must not be emailed.
  const known = await s.app.request(
    post("/v1/messages", {
      body: `Please cancel my earlier booking. ${PII.message}`,
      contact: { name: PII.name, email: "helena.duarte@example.com" },
    }),
  );
  expect(known.status).toBe(201);
  const knownBody = (await known.json()) as { view: { item: { id: string } }; accessToken: string };
  await drain(s.inbox, s.db);
  const verify = await s.app.request(
    post("/v1/customers/verify", { item_id: knownBody.view.item.id, access_token: knownBody.accessToken }),
  );
  expect([202, 409]).toContain(verify.status);
  await drain(s.inbox, s.db);
  return { bookingId, orderId };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Each test seeds a week of the shop through the real write path, and the nightly one seeds it twice:
// more than the default five seconds on a busy machine, in workerd most of all.
describe("demo mode", { timeout: 30_000 }, () => {
  it("seeds the shop, confirms the booking and accepts the order, and emails no customer, ever", async () => {
    const outbound: string[] = [];
    const s = await demoInbox({
      fetchImpl: (async (input: RequestInfo | URL) => {
        outbound.push(String(input));
        return new Response("no", { status: 500 });
      }) as typeof fetch,
    });
    const t = Date.now();
    const { bookingId, orderId } = await visit(s);

    const state = async (id: string) =>
      (await s.db.orm.select({ state: schema.items.state }).from(schema.items).where(eq(schema.items.id, id)))[0]
        ?.state;
    expect(await state(bookingId)).toBe("confirmed");
    expect(await state(orderId)).toBe("accepted");

    // Nothing at all left: not to the tester, not to the seeded customer whose address they typed,
    // not to the owner per item. The mail log says why for each email a live shop would have sent.
    expect(s.mail.sent).toEqual([]);
    const logged = await s.db.client.query({
      sql: "SELECT recipient, status, skip_reason FROM outbound_mail WHERE created_at >= ?",
      params: [t],
      method: "all",
    });
    expect(logged.rows.length).toBeGreaterThan(0);
    for (const [recipient, status, reason] of logged.rows) {
      expect(`${recipient}:${status}:${reason}`).toMatch(/:skipped:/);
    }

    // The owner's sign-in link is the one email a demo sends at a person's request, and only to the owner.
    const ask = (email: string) =>
      s.app.request(post("/auth/magic-link", { email }, { "cf-connecting-ip": "198.51.100.1" }));
    expect((await ask(PII.email)).status).toBe(200);
    expect((await ask("hello@oficinamare.pt")).status).toBe(200);
    expect(s.mail.sent).toEqual([]);
    expect((await ask(OWNER)).status).toBe(200);
    expect(s.mail.sent.map((m) => m.to)).toEqual([[OWNER]]);
    expect(outbound).toEqual([]);
  });

  it("calls no network, even with one switched on and a key to sign with", async () => {
    const outbound: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      outbound.push(String(input));
      return new Response("no", { status: 500 });
    });
    const s = await demoInbox();
    const owner: Caller = {
      actor: { kind: "owner", id: "owner", channel: "owner_ui" },
      tier: "verified_principal",
      sandbox: false,
      now: () => Date.now(),
    };
    await s.inbox.caps.updateSettings(owner, {
      doc: { networks: { "https://network.example.com": { enabled: true } } },
    });
    await visit(s);
    // The hourly tick and whatever it queues, an hour on.
    const later = Date.now() + 2 * 3_600_000;
    await drain(s.inbox, s.db, later);
    await drain(s.inbox, s.db, later);
    expect(outbound).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const { rows } = await s.db.client.query({
      sql: "SELECT kind, last_error FROM jobs WHERE kind LIKE 'network%' OR kind = 'identity_issue'",
      method: "all",
    });
    for (const [kind, note] of rows) expect(`${kind}: ${note}`).not.toMatch(/could not connect|reporting to/);
  });

  it("shows the live view with nothing about anyone in it", async () => {
    const s = await demoInbox();
    const t = Date.now();
    const { bookingId } = await visit(s);

    const json = await s.app.request(`${BASE}/demo/live.json`);
    expect(json.status).toBe(200);
    expect(json.headers.get("access-control-allow-origin")).toBe("*");
    expect(json.headers.get("cache-control")).toBe("no-store");
    const text = await json.text();
    const feed = JSON.parse(text) as {
      business: string;
      items: Record<string, unknown>[];
      next_reset: number;
    };
    expect(feed.business).toBe("Oficina Maré");
    expect(feed.items.length).toBeGreaterThanOrEqual(5);
    expect(feed.items.length).toBeLessThanOrEqual(20);
    for (const item of feed.items) {
      expect(Object.keys(item).sort()).toEqual(
        ["at", "changed_at", "key", "state", "state_label", "test", "tone", "type", "via", "what", "when"].sort(),
      );
    }
    const booking = feed.items.find((i) => i.type === "booking" && i.via === "REST");
    expect(booking).toMatchObject({ what: "Full service", state: "confirmed", tone: "good" });
    expect(String(booking?.when)).toMatch(/^Sat \d{1,2} [A-Z][a-z]{2}, 09:00$/);
    const orders = feed.items.filter((i) => i.type === "order" && Number(i.at) >= t);
    expect(orders.every((o) => o.via === "MCP")).toBe(true);
    expect(orders.map((o) => o.what).sort()).toEqual([
      "1 × Brake pads, Shimano resin",
      "2 × Chain, 9-speed, 1 item not in the catalogue",
    ]);
    expect(feed.items.find((i) => i.type === "quote_request" && i.via === "REST")?.what).toBe(
      "something made to order",
    );

    const page = await s.app.request(`${BASE}/demo/live`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain("Full service");
    expect(html).toContain('<script src="/demo/live.js" defer></script>');
    const js = await s.app.request(`${BASE}/demo/live.js`);
    expect(js.headers.get("content-type")).toContain("javascript");

    // Nothing anyone typed, nobody's name, address or phone, and no item's id.
    const people = await s.db.client.query({
      sql: `SELECT display_name, json_extract(contact, '$.name'), json_extract(contact, '$.email'),
                   json_extract(contact, '$.phone') FROM parties
            UNION ALL SELECT value, NULL, NULL, NULL FROM party_contacts`,
      method: "all",
    });
    const bodies = await s.db.client.query({
      sql: "SELECT body_text FROM thread_entries WHERE direction = 'in' AND created_at >= ?",
      params: [t],
      method: "all",
    });
    const ids = await s.db.client.query({ sql: "SELECT id FROM items", method: "all" });
    const secrets = [...Object.values(PII), ...people.rows.flat(), ...bodies.rows.flat(), ...ids.rows.flat(), bookingId]
      .filter((v): v is string => typeof v === "string" && v.trim().length >= 4)
      .map((v) => v.trim());
    for (const body of [text, html]) {
      for (const secret of secrets) expect(body, secret).not.toContain(secret);
      expect(body).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    }
  });

  it("sends the owner one summary a night, then wipes and seeds the shop again", async () => {
    const s = await demoInbox();
    const key = await createApiKey(s.db, { kind: "owner", name: "keeps" });
    const { bookingId } = await visit(s);
    const [nightly] = (
      await s.db.client.query({
        sql: "SELECT run_at FROM jobs WHERE kind = ? AND status = 'queued'",
        params: [DEMO_NIGHTLY_KIND],
        method: "all",
      })
    ).rows;
    const runAt = Number(nightly?.[0]);
    expect(runAt).toBe(nextNightly(Date.now()));
    const before = Number((await s.db.client.query({ sql: "SELECT COUNT(*) FROM items", method: "all" })).rows[0]?.[0]);

    await drain(s.inbox, s.db, runAt);

    const summaries = s.mail.sent.filter((m) => m.subject.includes("demo"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.to).toEqual([OWNER]);
    expect(summaries[0]?.from.address).toBe("demo@demo.test");
    expect(summaries[0]?.subject).toBe("Oficina Maré demo: 5 new requests since the last reset");
    const body = summaries[0]?.text ?? "";
    expect(body).toContain("1 booking: 1 confirmed");
    expect(body).toContain("2 orders");
    expect(body).toContain("through MCP");
    expect(body).toContain(`${BASE}/demo/live`);
    for (const secret of Object.values(PII)) expect(body).not.toContain(secret);
    expect(body).not.toContain("helena");
    expect(s.mail.sent.every((m) => m.to.every((to) => to === OWNER))).toBe(true);

    // The tester's items are gone, the week of history is back, and the owner's key still works.
    const gone = await s.db.orm
      .select({ id: schema.items.id })
      .from(schema.items)
      .where(eq(schema.items.id, bookingId));
    expect(gone).toEqual([]);
    const after = Number((await s.db.client.query({ sql: "SELECT COUNT(*) FROM items", method: "all" })).rows[0]?.[0]);
    expect(after).toBe(before - 5);
    const owned = await s.app.request(`${BASE}/v1/owner/items`, { headers: { authorization: `Bearer ${key.key}` } });
    expect(owned.status).toBe(200);
    // Tomorrow's run is queued, and the housekeeping the wipe took is back.
    const kinds = (
      await s.db.client.query({ sql: "SELECT kind, run_at FROM jobs WHERE status = 'queued'", method: "all" })
    ).rows.map((r) => String(r[0]));
    expect(kinds).toContain(DEMO_NIGHTLY_KIND);
    expect(kinds).toContain("lifecycle_sweep");
    expect(kinds).toContain("network_ping");
    const next = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM jobs WHERE kind = ? AND status = 'queued' AND run_at = ?",
      params: [DEMO_NIGHTLY_KIND, runAt + 86_400_000],
      method: "all",
    });
    expect(Number(next.rows[0]?.[0])).toBe(1);
  });

  it("wipes every table but the owner's access, the keys, the limits and the nightly chain", async () => {
    const s = await demoInbox();
    await visit(s);
    const emptied = await wipeDemo(s.db);
    expect(emptied).toContain("items");
    expect(emptied).toContain("parties");
    expect(emptied).toContain("outbound_mail");
    for (const kept of DEMO_KEEP) expect(emptied).not.toContain(kept);
    for (const table of emptied) {
      const n = await s.db.client.query({ sql: `SELECT COUNT(*) FROM "${table}"`, method: "all" });
      expect(Number(n.rows[0]?.[0]), table).toBe(0);
    }
    const jobs = await s.db.client.query({ sql: "SELECT DISTINCT kind FROM jobs", method: "all" });
    expect(jobs.rows.map((r) => String(r[0]))).toEqual([DEMO_NIGHTLY_KIND]);
  });

  it("never wipes an instance that holds another business", async () => {
    const db = await freshDb();
    await seedSurfingDog(db, Date.now());
    const r = await ensureDemo(db, Date.now());
    expect(r).toEqual({ seeded: false, active: false });
    const queued = await db.client.query({
      sql: "SELECT COUNT(*) FROM jobs WHERE kind = ?",
      params: [DEMO_NIGHTLY_KIND],
      method: "all",
    });
    expect(Number(queued.rows[0]?.[0])).toBe(0);
    const [biz] = await db.orm.select({ name: schema.business.name }).from(schema.business);
    expect(biz?.name).toBe("Surfing Dog");
  });

  it("holds each address to the demo's limit, and everyone to a shared one", async () => {
    const s = await demoInbox();
    const message = (ip: string) => s.app.request(post("/v1/messages", { body: "Hello" }, { "cf-connecting-ip": ip }));
    const cap = DEMO_LIMITS.create?.capacity ?? 0;
    for (let i = 0; i < cap; i++) expect((await message("192.0.2.10")).status, `message ${i + 1}`).toBe(201);
    expect((await message("192.0.2.10")).status).toBe(429);
    expect((await message("192.0.2.11")).status).toBe(201);
    // The shared bucket, drained directly: then nobody gets a new item through.
    const shared = DEMO_SHARED.create;
    if (!shared) throw new Error("no shared create limit");
    const now = Date.now();
    for (let i = 0; i < shared.capacity; i++) await consume(s.db, "create", EVERYONE, now, shared);
    expect((await message("192.0.2.12")).status).toBe(429);
  });
});

describe("demo mode off", () => {
  it("has no live view, seeds nothing and changes nothing", async () => {
    const db = await freshDb();
    const inbox = createInbox({ db, background: () => {} });
    await inbox.prepare();
    for (const path of ["/demo/live", "/demo/live.json", "/demo/live.js"]) {
      expect((await inbox.app.request(`${BASE}${path}`)).status, path).toBe(404);
    }
    expect(await db.orm.select({ id: schema.business.id }).from(schema.business)).toEqual([]);
    const jobs = await db.client.query({
      sql: "SELECT COUNT(*) FROM jobs WHERE kind = ?",
      params: [DEMO_NIGHTLY_KIND],
      method: "all",
    });
    expect(Number(jobs.rows[0]?.[0])).toBe(0);
  });
});

describe("demo pieces", () => {
  it("lets mail through to the owner only", async () => {
    const inner = logMailOut();
    const lines: string[] = [];
    const guard = ownerOnlyMailOut(inner, [" Owner@Example.com "], (l) => lines.push(l));
    const base = { from: { address: "a@b.test" }, subject: "s", text: "t" };
    await guard.send({ ...base, to: ["someone@example.com"] });
    await guard.send({ ...base, to: [OWNER, "someone@example.com"] });
    await guard.send({ ...base, to: [OWNER], headers: { Bcc: "someone@example.com" } });
    await guard.send({ ...base, to: [] });
    expect(inner.sent).toEqual([]);
    expect(lines.join("\n")).not.toContain("someone");
    await guard.send({ ...base, to: ["OWNER@example.com"] });
    expect(inner.sent).toHaveLength(1);
  });

  it("tells the time in the shop's zone and counts without names", () => {
    expect(shopTime("2026-09-26T08:00:00Z", TZ)).toBe("Sat 26 Sep, 09:00");
    expect(shopTime("not a time", TZ)).toBeNull();
    expect(nextNightly(Date.parse("2026-09-24T02:59:00Z"))).toBe(Date.parse("2026-09-24T03:00:00Z"));
    expect(nextNightly(Date.parse("2026-09-24T03:00:00Z"))).toBe(Date.parse("2026-09-25T03:00:00Z"));
    const { subject, text } = summaryText(
      "Oficina Maré",
      [
        { type: "booking", state: "confirmed", channel: "mcp_public", n: 3 },
        { type: "booking", state: "requested", channel: "rest", n: 1 },
        { type: "order", state: "accepted", channel: "mcp_public", n: 1 },
      ],
      "https://demo.test/demo/live",
    );
    expect(subject).toBe("Oficina Maré demo: 5 new requests since the last reset");
    expect(text).toContain("4 bookings: 3 confirmed, 1 waiting for the shop");
    expect(text).toContain("1 order: 1 accepted");
    expect(text).toContain("How they arrived: 4 through MCP, 1 through REST.");
  });
});
