import { createApiKey } from "@surfingdog/adapters";
import { createDb, type Db, ensureJob, schema } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createInbox, type Inbox } from "../src/app";
import { DEMO_NIGHTLY_KIND, liveFeed, nextNightly } from "../src/demo";
import { localTime, seedShowcase, seedSurfingDog } from "../src/seed";
import { freshDb } from "./harness";

/**
 * The public demo, attacked (src/demo.ts). Each test is a way a stranger, or an operator's slip,
 * could make a demo send someone's details out, show them in public, or wipe data it did not make.
 * Runs on Node and in workerd.
 */
const BASE = "https://demo.test";
const OWNER = "owner@example.com";
const PII = { name: "Zeferino Quaresma", email: "zeferino.quaresma@example.net", phone: "+351 912 000 111" };

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.60", ...headers },
    body: JSON.stringify(body),
  });

async function drain(inbox: Inbox, db: Db, now = Date.now()): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const r = await inbox.runner.runDue(db, { now, limit: 50, workerId: "test" });
    if (r.claimed === 0) return;
  }
}

function demoOn(db: Db, fetchImpl?: typeof fetch) {
  return createInbox({
    db,
    mailOut: logMailOut(),
    baseUrl: BASE,
    secretKey: "demo-attack-secret-key-0123456789abcdef",
    ownerEmails: [OWNER],
    background: () => {},
    fetchImpl,
    demo: { ownerEmails: [OWNER] },
  });
}

const count = async (db: Db, table: string) =>
  Number((await db.client.query({ sql: `SELECT COUNT(*) FROM "${table}"`, method: "all" })).rows[0]?.[0]);

/** Runs the nightly job now, as the cron would at 03:00, whether or not the demo queued one. */
async function runNightly(inbox: Inbox, db: Db): Promise<void> {
  const at = nextNightly(Date.now());
  await ensureJob(db, DEMO_NIGHTLY_KIND, `${DEMO_NIGHTLY_KIND}:${at}`, { runAt: at, payload: {} });
  await drain(inbox, db, at);
}

describe("the demo, attacked", { timeout: 30_000 }, () => {
  it("sends nothing about a tester to a webhook, even one the owner set up", async () => {
    const outbound: string[] = [];
    const db = await freshDb();
    const inbox = demoOn(db, (async (input: RequestInfo | URL) => {
      outbound.push(String(input instanceof Request ? input.url : input));
      return new Response("ok", { status: 200 });
    }) as typeof fetch);
    await inbox.prepare();
    const { key } = await createApiKey(db, { kind: "owner", name: "hooks" });
    const hook = await inbox.app.request(
      post(
        "/v1/owner/webhooks",
        { url: "https://hooks.example.com/in", payload_style: "full" },
        { authorization: `Bearer ${key}` },
      ),
    );
    expect(hook.status).toBe(201);
    const made = await inbox.app.request(post("/v1/messages", { body: "Hello there", contact: PII }));
    expect(made.status).toBe(201);
    await drain(inbox, db);
    await drain(inbox, db, Date.now() + 3_600_000);
    expect(outbound).toEqual([]);
  });

  it("has no live view on an instance that holds a real business", async () => {
    const db = await freshDb();
    await seedSurfingDog(db, Date.now());
    const inbox = demoOn(db);
    await expect(inbox.prepare()).rejects.toThrow(/empty database/);
    const made = await inbox.app.request(post("/v1/messages", { body: "Hello there", contact: PII }));
    expect(made.status).toBe(201);
    for (const path of ["/demo/live", "/demo/live.json", "/demo/live.js"]) {
      const res = await inbox.app.request(`${BASE}${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toContain("application/json");
    }
  });

  it("never takes over, or wipes, an instance that took requests before demo mode was on", async () => {
    const db = await freshDb();
    // An instance with no business profile that has been taking requests anyway.
    const plain = createInbox({ db, background: () => {} });
    const made = await plain.app.request(post("/v1/messages", { body: "A real request", contact: PII }));
    expect(made.status).toBe(201);
    const items = await count(db, "items");

    const inbox = demoOn(db);
    await expect(inbox.prepare()).rejects.toThrow(/empty database/);
    expect(await db.orm.select({ id: schema.business.id }).from(schema.business)).toEqual([]);
    const queued = await db.client.query({
      sql: "SELECT COUNT(*) FROM jobs WHERE kind = ?",
      params: [DEMO_NIGHTLY_KIND],
      method: "all",
    });
    expect(Number(queued.rows[0]?.[0])).toBe(0);
    await runNightly(inbox, db);
    expect(await count(db, "items")).toBe(items);
    expect((await inbox.app.request(`${BASE}/demo/live.json`)).status).toBe(404);
  });

  it("never wipes the showcase someone seeded by hand and then kept", async () => {
    const db = await freshDb();
    await seedShowcase(db, Date.now());
    // The owner kept using it: a real request arrives before anyone sets INBOX_DEMO.
    const plain = createInbox({ db, background: () => {} });
    const made = await plain.app.request(post("/v1/messages", { body: "A real request", contact: PII }));
    expect(made.status).toBe(201);
    const id = ((await made.json()) as { view: { item: { id: string } } }).view.item.id;
    const inbox = demoOn(db);
    await expect(inbox.prepare()).rejects.toThrow(/empty database/);
    await runNightly(inbox, db);
    const kept = await db.client.query({ sql: "SELECT id FROM items WHERE id = ?", params: [id], method: "all" });
    expect(kept.rows.map((r) => String(r[0]))).toEqual([id]);
    expect((await inbox.app.request(`${BASE}/demo/live.json`)).status).toBe(404);
  });

  it("puts no number a tester chose on the live view", async () => {
    const db = await freshDb();
    const inbox = demoOn(db);
    await inbox.prepare();
    // A phone number, typed as the quantity of a real product.
    const made = await inbox.app.request(
      post("/v1/orders", {
        payload: {
          orderedItem: [
            { sku: "CH-9", name: "Chain", quantity: 351912000111, price: { value: 1850, currency: "EUR" } },
          ],
          totalPrice: { value: 1850, currency: "EUR" },
        },
        contact: { name: "x" },
      }),
    );
    expect(made.status).toBe(201);
    const feed = await liveFeed(db, Date.now());
    const order = feed.items.find((i) => i.type === "order" && i.via === "REST");
    expect(order?.what).toMatch(/Chain, 9-speed/);
    expect(JSON.stringify(feed)).not.toMatch(/\d{4,}\s×/);
    const html = await (await inbox.app.request(`${BASE}/demo/live`)).text();
    expect(html).not.toContain("351912000111");
  });

  it("confirms a crowd who all ask for the same Saturday morning", async () => {
    const db = await freshDb();
    const inbox = demoOn(db);
    await inbox.prepare();
    const [full] = await db.orm
      .select({ id: schema.services.id })
      .from(schema.services)
      .where(eq(schema.services.name, "Full service"));
    let start = 0;
    for (let d = 1; d <= 8 && !start; d++) {
      const t = localTime(Date.now(), "Europe/Lisbon", d, 10, 0);
      if (new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Lisbon", weekday: "short" }).format(t) === "Sat")
        start = t;
    }
    // Forty testers, each through their own AI and address, all at ten on Saturday: the twelve the
    // shop had room for were gone after twelve, and the rest heard "that time is taken".
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await inbox.app.request(
        post(
          "/v1/bookings",
          {
            payload: {
              reservationFor: { serviceId: full?.id, name: "Full service" },
              startTime: new Date(start).toISOString(),
              endTime: new Date(start + 90 * 60_000).toISOString(),
            },
            contact: { name: `Tester ${i}` },
          },
          { "cf-connecting-ip": `198.51.100.${i + 1}` },
        ),
      );
      expect(res.status, `booking ${i + 1}`).toBe(201);
      ids.push(((await res.json()) as { view: { item: { id: string } } }).view.item.id);
    }
    await drain(inbox, db);
    const states = await db.client.query({
      sql: `SELECT state, COUNT(*) FROM items WHERE id IN (${ids.map(() => "?").join(",")}) GROUP BY state`,
      params: ids,
      method: "all",
    });
    expect(states.rows.map((r) => `${r[0]}:${r[1]}`)).toEqual(["confirmed:40"]);
  });

  it("sends the owner no more than a few sign-in links an hour, however many addresses ask", async () => {
    const db = await freshDb();
    const mail = logMailOut();
    const inbox = createInbox({
      db,
      mailOut: mail,
      baseUrl: BASE,
      ownerEmails: [OWNER],
      background: () => {},
      demo: { ownerEmails: [OWNER] },
    });
    await inbox.prepare();
    let refused = 0;
    for (let i = 0; i < 40; i++) {
      const res = await inbox.app.request(
        post("/auth/magic-link", { email: OWNER }, { "cf-connecting-ip": `2001:db8::${(i + 1).toString(16)}` }),
      );
      if (res.status === 429) refused++;
    }
    expect(mail.sent.length).toBeLessThanOrEqual(10);
    expect(refused).toBeGreaterThanOrEqual(30);
  });

  it("reads no request body bigger than a booking could need", async () => {
    const db = await freshDb();
    const inbox = demoOn(db);
    await inbox.prepare();
    const before = await count(db, "items");
    const big = await inbox.app.request(post("/v1/messages", { body: "x".repeat(200_000), contact: { name: "x" } }));
    expect(big.status).toBe(413);
    const viaMcp = await inbox.app.request(
      post(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "send_message", arguments: { body: "x".repeat(200_000) } },
        },
        { accept: "application/json, text/event-stream" },
      ),
    );
    expect(viaMcp.status).toBe(413);
    expect(await count(db, "items")).toBe(before);
    const small = await inbox.app.request(post("/v1/messages", { body: "A normal message", contact: { name: "x" } }));
    expect(small.status).toBe(201);
  });

  it("answers a crowd polling the live view from one reading of the database", async () => {
    const base = await freshDb();
    let reads = 0;
    const counted = createDb({
      ...base.client,
      query: (q) => {
        if (/from "?items"?/i.test(q.sql) && /order by/i.test(q.sql)) reads++;
        return base.client.query(q);
      },
      batch: (qs) => base.client.batch(qs),
    });
    const inbox = demoOn(counted);
    await inbox.prepare();
    const poll = async (): Promise<number> => (await inbox.app.request(`${BASE}/demo/live.json`)).status;
    const all: number[] = await Promise.all(Array.from({ length: 25 }, poll));
    for (let i = 0; i < 25; i++) all.push(await poll());
    expect(all.every((status) => status === 200)).toBe(true);
    expect(reads).toBeLessThanOrEqual(2);
  });

  it("sends the owner's sign-in link from MAIL_FROM, which a real mail service takes", async () => {
    const db = await freshDb();
    const mail = logMailOut();
    const inbox = createInbox({
      db,
      mailOut: mail,
      baseUrl: BASE,
      ownerEmails: [OWNER],
      background: () => {},
      demo: { ownerEmails: [OWNER], from: { address: "demo@shop.test", name: "Demo shop" } },
    });
    await inbox.prepare();
    expect((await inbox.app.request(post("/auth/magic-link", { email: OWNER }))).status).toBe(200);
    expect(mail.sent.map((m) => m.from.address)).toEqual(["demo@shop.test"]);
    expect(mail.sent[0]?.to).toEqual([OWNER]);
  });
});
