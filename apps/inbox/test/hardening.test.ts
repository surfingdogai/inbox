import { bucketAddress, createApiKey, DEMO_LIMITS, DEMO_SHARED, ingestEmail, LIMITS } from "@surfingdog/adapters";
import { OWNER_ALERTS_PER_HOUR, OWNER_DIGEST_KIND, readSettings } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox, MAX_BODY, securityTxt } from "../src/app";
import { freshDb } from "./harness";

/**
 * What stands between the doors and a flood: bounded bodies read only after the flood guard,
 * buckets that count an IPv6 network as one client, inbound email held per sender and per mailbox,
 * the owner's alerts capped with a digest for the rest, and where to report a problem.
 */
const INBOX = "https://inbox.example.com";
const SECRET = "inbound-secret-0123456789";

async function setup() {
  const db = await freshDb();
  const mail = logMailOut();
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    baseUrl: INBOX,
    mailOut: mail,
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
  });
  const owner = { authorization: `Bearer ${(await createApiKey(db, { kind: "owner", name: "cli" })).key}` };
  const drain = async (now?: number) => {
    await Promise.allSettled(pending.splice(0));
    for (let i = 0; i < 30; i++) {
      if ((await inbox.runner.runDue(db, { workerId: "t", limit: 100, ...(now ? { now } : {}) })).claimed === 0) break;
    }
  };
  return { db, inbox, app: inbox.app, mail, owner, drain };
}

const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${INBOX}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const emptyBucket = (db: Awaited<ReturnType<typeof freshDb>>, bucket: string) =>
  db.client.query({
    sql: "INSERT OR REPLACE INTO rate_limits (bucket, tokens, updated_at) VALUES (?, -1, ?)",
    params: [bucket, Date.now()],
    method: "run",
  });

function mime(o: { from: string; subject: string; id: string; headers?: string[]; body?: string }): string {
  return [
    `From: ${o.from}`,
    "To: shop@inbox.example.com",
    `Subject: ${o.subject}`,
    `Message-ID: <${o.id}@mail.example.com>`,
    ...(o.headers ?? []),
    "",
    o.body ?? "Hello there",
    "",
  ].join("\r\n");
}

describe("request bodies", () => {
  it("are bounded on every route before anything parses them, with room for raw email", async () => {
    const { app, owner } = await setup();
    const big = "x".repeat(MAX_BODY + 1);
    const res = await app.request(json("/v1/messages", { body: big }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "too_large", status: 413 });
    for (const path of ["/mcp", "/v1/owner/settings", "/oauth/register", "/auth/magic-link"]) {
      const r = await app.request(json(path, { pad: big }, owner));
      expect(r.status, path).toBe(413);
    }
    // Without a declared length, the bytes are counted as they arrive.
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode("y".repeat(256 * 1024));
        for (let i = 0; i < 5; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const chunked = await app.request(
      new Request(`${INBOX}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: streamed,
        duplex: "half",
      } as RequestInit),
    );
    expect(chunked.status).toBe(413);
    // Raw inbound email may be larger: two megabytes go through to the email door.
    await app.request(
      new Request(`${INBOX}/v1/owner/settings`, {
        method: "PUT",
        headers: { ...owner, "content-type": "application/json" },
        body: JSON.stringify({ doc: { email: { inboundSecret: SECRET } } }),
      }),
    );
    const raw = mime({
      from: "Ana <ana@example.com>",
      subject: "Photos",
      id: "big-1",
      body: "z".repeat(2 * 1024 * 1024),
    });
    const inbound = await app.request(
      new Request(`${INBOX}/v1/email/inbound`, {
        method: "POST",
        headers: { "x-inbox-email-secret": SECRET, "x-envelope-from": "ana@example.com" },
        body: raw,
      }),
    );
    expect(inbound.status, await inbound.clone().text()).toBe(200);
  });

  it("are not parsed for a caller the flood guard already refuses", async () => {
    const { db, app } = await setup();
    await emptyBucket(db, "public:ip:203.0.113.5");
    const res = await app.request(
      new Request(`${INBOX}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "cf-connecting-ip": "203.0.113.5",
        },
        body: "{this is not json",
      }),
    );
    // A 429, not the parse error the body would earn: the body was never read.
    expect(res.status).toBe(429);
  });
});

describe("rate-limit buckets", () => {
  it("count an IPv6 client by its /64, and an IPv4 one (mapped or not) by its address", () => {
    expect(bucketAddress("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(bucketAddress("2001:0DB8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(bucketAddress("2001:db8:1:2:ffff::9")).toBe("2001:db8:1:2::/64");
    expect(bucketAddress("[2001:db8::1]")).toBe("2001:db8:0:0::/64");
    expect(bucketAddress("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(bucketAddress("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(bucketAddress("198.51.100.7")).toBe("198.51.100.7");
    expect(bucketAddress("2001:db8::1::2")).toBe("2001:db8::1::2");
    expect(bucketAddress("not an address")).toBe("not an address");
  });

  it("hold every address in a /64 to one bucket, and no other /64", async () => {
    const { db, app } = await setup();
    await emptyBucket(db, "public:ip:2001:db8:1:2::/64");
    const from = (ip: string) => app.request(json("/v1/messages", { body: "Hello" }, { "cf-connecting-ip": ip }));
    expect((await from("2001:db8:1:2::abcd")).status).toBe(429);
    expect((await from("2001:db8:1:2:9:9:9:9")).status).toBe(429);
    expect((await from("2001:db8:1:3::1")).status).toBe(201);
  });

  it("give a demo's shared assistant addresses room on launch day, and keep the shared caps as the guard", () => {
    expect(DEMO_LIMITS.create).toEqual({ capacity: 60, perMs: 300 / 3_600_000 });
    expect(DEMO_LIMITS.public).toEqual({ capacity: 240, perMs: 4 / 1000 });
    // Wider per address than an ordinary instance, never wider than what everyone shares.
    expect(DEMO_LIMITS.create?.capacity).toBeGreaterThan(LIMITS.create.capacity);
    expect(DEMO_SHARED.create?.capacity).toBeGreaterThan(DEMO_LIMITS.create?.capacity ?? Infinity);
    expect(DEMO_SHARED.public?.capacity).toBeGreaterThan(DEMO_LIMITS.public?.capacity ?? Infinity);
  });
});

describe("inbound email", () => {
  it("is held per sender and for the whole mailbox, as a temporary failure, and keeps no address in the buckets", async () => {
    const { db, inbox, app, owner } = await setup();
    const one = (i: number, from = "ana@example.com") =>
      ingestEmail(db, inbox.caps, {
        raw: mime({ from: `Ana <${from}>`, subject: `Question ${i}`, id: `q-${from}-${i}` }),
        envelopeFrom: from,
      });
    for (let i = 0; i < LIMITS.emailSender.capacity; i++) expect((await one(i)).outcome, `email ${i}`).toBe("created");
    const held = await one(99);
    expect(held).toMatchObject({ outcome: "limited" });
    expect(held.outcome === "limited" && held.retryAfterSec).toBeGreaterThan(0);
    // Another sender is not held by Ana's bucket.
    expect((await one(1, "rui@example.com")).outcome).toBe("created");
    const { rows } = await db.client.query({ sql: "SELECT bucket FROM rate_limits", method: "all" });
    expect(JSON.stringify(rows)).not.toContain("example.com");

    // The mailbox as a whole: every sender held once it is spent, through the webhook as a 429.
    await app.request(
      new Request(`${INBOX}/v1/owner/settings`, {
        method: "PUT",
        headers: { ...owner, "content-type": "application/json" },
        body: JSON.stringify({ doc: { email: { inboundSecret: SECRET } } }),
      }),
    );
    await emptyBucket(db, "email:*");
    const res = await app.request(
      new Request(`${INBOX}/v1/email/inbound`, {
        method: "POST",
        headers: { "x-inbox-email-secret": SECRET, "x-envelope-from": "joana@example.com" },
        body: mime({ from: "Joana <joana@example.com>", subject: "Hi", id: "j-1" }),
      }),
    );
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("never turns an automatic reply or a returned email into an item", async () => {
    const { db, inbox } = await setup();
    const before = (await db.client.query({ sql: "SELECT COUNT(*) FROM items", method: "all" })).rows[0]?.[0];
    const auto = await ingestEmail(db, inbox.caps, {
      raw: mime({
        from: "Ana <ana@example.com>",
        subject: "Out of office",
        id: "ooo-1",
        headers: ["Auto-Submitted: auto-replied"],
      }),
      envelopeFrom: "ana@example.com",
    });
    const bounce = await ingestEmail(db, inbox.caps, {
      raw: mime({
        from: "Mail Delivery System <mailer-daemon@mail.example.com>",
        subject: "Undelivered",
        id: "dsn-1",
        headers: ["Content-Type: multipart/report; report-type=delivery-status; boundary=x"],
      }),
      envelopeFrom: "<>",
    });
    expect(auto.outcome).toBe("dropped");
    expect(bounce.outcome).toBe("dropped");
    const after = (await db.client.query({ sql: "SELECT COUNT(*) FROM items", method: "all" })).rows[0]?.[0];
    expect(after).toBe(before);
  });
});

describe("the owner's alerts", () => {
  it("stop at the hour's cap, and the rest arrive in one digest at the end of the hour", async () => {
    const { db, app, mail, owner, drain } = await setup();
    await app.request(
      new Request(`${INBOX}/v1/owner/settings`, {
        method: "PUT",
        headers: { ...owner, "content-type": "application/json" },
        body: JSON.stringify({ doc: { notifications: { ownerEmail: "owner@shop.example.com" } } }),
      }),
    );
    const extra = 5;
    for (let i = 0; i < OWNER_ALERTS_PER_HOUR + extra; i++) {
      const res = await app.request(
        json(
          "/v1/messages",
          { body: `Question ${i}`, subject: `Question ${i}`, contact: { name: `C${i}`, email: `c${i}@example.com` } },
          { "cf-connecting-ip": `198.51.100.${i + 1}` },
        ),
      );
      expect(res.status, `message ${i}`).toBe(201);
    }
    await drain();
    const toOwner = () => mail.sent.filter((m) => m.to.includes("owner@shop.example.com"));
    expect(toOwner()).toHaveLength(OWNER_ALERTS_PER_HOUR);
    const { rows } = await db.client.query({
      sql: "SELECT COUNT(*) FROM outbound_mail WHERE recipient = 'owner' AND skip_reason = 'alert_limit'",
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBe(extra);
    // One digest per clock hour that held any back, due at its end: one, or two if the alerts
    // happened to go out across the top of an hour.
    const jobs = await db.client.query({
      sql: "SELECT run_at FROM jobs WHERE kind = ? AND status = 'queued' ORDER BY run_at",
      params: [OWNER_DIGEST_KIND],
      method: "all",
    });
    const due = jobs.rows.map((r) => Number(r[0]));
    expect(due.length).toBeGreaterThanOrEqual(1);
    expect(due.length).toBeLessThanOrEqual(2);
    for (const at of due) expect(at % 3_600_000).toBe(0);

    const last = due.at(-1) ?? 0;
    await drain(last + 1_000);
    const digests = toOwner().slice(OWNER_ALERTS_PER_HOUR);
    expect(digests).toHaveLength(due.length);
    const counted = digests.reduce((n, d) => n + Number(/^(\d+) more new request/.exec(d.subject)?.[1] ?? 0), 0);
    expect(counted).toBe(extra);
    for (let i = OWNER_ALERTS_PER_HOUR; i < OWNER_ALERTS_PER_HOUR + extra; i++) {
      expect(digests.some((d) => d.text.includes(`Question ${i}`))).toBe(true);
    }
    // Once: a digest is not sent again.
    await drain(last + 60_000);
    expect(toOwner()).toHaveLength(OWNER_ALERTS_PER_HOUR + due.length);
  });
});

describe("security.txt and health", () => {
  it("names hello@ the inbox's host until the owner sets a contact, and expires within a year", async () => {
    const { app, owner, db } = await setup();
    const res = await app.request(`${INBOX}/.well-known/security.txt`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Contact: mailto:hello@inbox.example.com");
    expect(body).toContain(`Canonical: ${INBOX}/.well-known/security.txt`);
    const expires = Date.parse(/Expires: (\S+)/.exec(body)?.[1] ?? "");
    expect(expires).toBeGreaterThan(Date.now());
    expect(expires).toBeLessThanOrEqual(Date.now() + 366 * 86_400_000);

    const set = await app.request(
      new Request(`${INBOX}/v1/owner/settings`, {
        method: "PUT",
        headers: { ...owner, "content-type": "application/json" },
        body: JSON.stringify({ doc: { security: { contact: "https://shop.example.com/security" } } }),
      }),
    );
    expect(set.status).toBe(200);
    expect((await readSettings(db)).security.contact).toBe("https://shop.example.com/security");
    expect(await (await app.request(`${INBOX}/.well-known/security.txt`)).text()).toContain(
      "Contact: https://shop.example.com/security",
    );
    expect(securityTxt({ origin: INBOX, contact: "sec@shop.example.com", now: 0 })).toContain(
      "Contact: mailto:sec@shop.example.com",
    );
  });

  it("answers healthy only when the database does", async () => {
    const { app } = await setup();
    const res = await app.request(`${INBOX}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: "ok" });
  });
});
