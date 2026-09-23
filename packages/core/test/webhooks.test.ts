import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it, vi } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import {
  matchesEvent,
  signWebhook,
  usableSecrets,
  WEBHOOK_DELIVERY_KIND,
  WebhookCapabilities,
  webhookSignature,
} from "../src/capabilities/webhooks";
import { createDb, type Db } from "../src/db";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { createSecretBox } from "../src/secrets/box";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * Outbound webhooks and the developer cursor (ADR-015 §3–§6). Runs on Node and inside workerd: the
 * signing is WebCrypto and the cursor is one index range scan over a view, so both must agree.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const KEY = "2f8c1d0a6b4e37925c8f01ad6e3b47f0";

const owner: Caller = {
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const customer: Caller = {
  actor: { kind: "customer_agent", id: "agent:claude", channel: "mcp_public" },
  tier: "signed_agent",
  sandbox: false,
  now: () => T0,
};

async function setup(opts: { key?: string | null } = {}): Promise<{ db: Db; caps: Capabilities }> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const box = opts.key === null ? null : createSecretBox([opts.key ?? KEY]);
  return { db, caps: new Capabilities(db, box) };
}

describe("webhook endpoints", () => {
  it("returns the secret once at creation and never lists it again", async () => {
    const { db, caps } = await setup();
    const created = await caps.webhooks.createWebhook(owner, {
      url: "https://hooks.example.com/inbox",
      events: ["booking.*", "order.*"],
      payload_style: "thin",
    });
    expect(created.secret.startsWith("whsec_")).toBe(true);
    expect(created.events).toEqual(["booking.*", "order.*"]);
    expect(created.active).toBe(true);
    expect(created.deliveries).toEqual({ pending: 0, delivered: 0, failed: 0, last_delivery_at: null });

    const listed = await caps.webhooks.listWebhooks(owner);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
    expect(JSON.stringify(listed)).not.toContain("whsec_");
    expect(listed[0]).not.toHaveProperty("secret");

    // Nor is it in the clear in the row it came from.
    const { rows } = await db.client.query({ sql: "SELECT secret_enc FROM webhooks", method: "all" });
    expect(String(rows[0]?.[0])).not.toContain(created.secret);
    expect(String(rows[0]?.[0]).startsWith("v1.")).toBe(true);
  });

  it("refuses a non-https or private URL, and allows one only when the owner opts in", async () => {
    const { caps } = await setup();
    for (const url of [
      "http://hooks.example.com/inbox",
      "https://localhost/inbox",
      "https://127.0.0.1/inbox",
      "https://inbox.internal/hook",
      "https://box/hook",
    ]) {
      await expect(
        caps.webhooks.createWebhook(owner, { url, events: ["*"], payload_style: "thin" }),
      ).rejects.toMatchObject({ code: "invalid_input", fields: [{ path: "url" }] });
    }
    await caps.updateSettings(owner, {
      doc: { integrations: { webhooks: { allowPrivateTargets: true } } },
    });
    const w = await caps.webhooks.createWebhook(owner, {
      url: "http://127.0.0.1:8787/hook",
      events: ["*"],
      payload_style: "thin",
    });
    expect(w.url).toBe("http://127.0.0.1:8787/hook");

    // `allowPrivateTargets` relaxes the host and the plain-http rule. It is not a licence to store
    // a scheme that is not a web address at all, under any setting.
    for (const url of ["file:///etc/passwd", "ftp://hooks.example.com/inbox", "javascript:alert(1)"]) {
      await expect(
        caps.webhooks.createWebhook(owner, { url, events: ["*"], payload_style: "thin" }),
      ).rejects.toMatchObject({ code: "invalid_input", fields: [{ path: "url" }] });
    }
  });

  it("refuses to store a secret at all when the instance has no INBOX_SECRET_KEY", async () => {
    const { caps } = await setup({ key: null });
    await expect(
      caps.webhooks.createWebhook(owner, { url: "https://hooks.example.com/x", events: ["*"], payload_style: "thin" }),
    ).rejects.toMatchObject({ code: "not_allowed", details: { variable: "INBOX_SECRET_KEY" } });
    expect(await caps.webhooks.listWebhooks(owner)).toEqual([]);
  });

  it("rotates to a new secret and keeps the old one signing for the grace day", async () => {
    const { caps } = await setup();
    const created = await caps.webhooks.createWebhook(owner, {
      url: "https://hooks.example.com/inbox",
      events: ["*"],
      payload_style: "thin",
    });
    const rotated = await caps.webhooks.rotateWebhookSecret(owner, { webhook_id: created.id });
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.secret.startsWith("whsec_")).toBe(true);
    expect(rotated.previous_secret_until).toBe(new Date(T0 + 24 * 3_600_000).toISOString());

    // Both signatures travel while the grace lasts, so a receiver still on the old one verifies.
    const secrets = { current: rotated.secret, previous: created.secret, previousUntil: T0 + 24 * 3_600_000 };
    const header = await webhookSignature(secrets, "msg_1", 1_774_000_000, '{"a":1}', T0 + 3_600_000);
    const parts = header.split(" ");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(`v1,${await signWebhook(rotated.secret, "msg_1", 1_774_000_000, '{"a":1}')}`);
    expect(parts[1]).toBe(`v1,${await signWebhook(created.secret, "msg_1", 1_774_000_000, '{"a":1}')}`);

    // A day later only the new one is signed with.
    const after = await webhookSignature(secrets, "msg_1", 1_774_000_000, '{"a":1}', T0 + 25 * 3_600_000);
    expect(after.split(" ")).toHaveLength(1);
    expect(usableSecrets(secrets, T0 + 25 * 3_600_000)).toEqual([rotated.secret]);

    expect(JSON.stringify(await caps.webhooks.listWebhooks(owner))).not.toContain("whsec_");
  });

  it("updates, wakes and deletes an endpoint", async () => {
    const { db, caps } = await setup();
    const created = await caps.webhooks.createWebhook(owner, {
      url: "https://hooks.example.com/inbox",
      events: ["*"],
      payload_style: "thin",
    });
    await db.client.query({
      sql: "UPDATE webhooks SET active = 0, failing_since = ?, disabled_at = ?, last_error = 'HTTP 500' WHERE id = ?",
      params: [T0 - 1_000, T0, created.id],
      method: "run",
    });
    const woken = await caps.webhooks.updateWebhook(owner, {
      webhook_id: created.id,
      active: true,
      url: "https://hooks.example.com/fixed",
      events: ["booking.confirm"],
      payload_style: "full",
    });
    expect(woken).toMatchObject({
      active: true,
      url: "https://hooks.example.com/fixed",
      events: ["booking.confirm"],
      payload_style: "full",
      failing_since: null,
      disabled_at: null,
      last_error: null,
    });
    await expect(caps.webhooks.updateWebhook(owner, { webhook_id: "nope", active: false })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(await caps.webhooks.deleteWebhook(owner, { webhook_id: created.id })).toEqual({ deleted: true });
    expect(await caps.webhooks.listWebhooks(owner)).toEqual([]);
  });

  it("sends a real, marked, signed test event and reports the status it got", async () => {
    const db = createDb(await makeClient());
    await runMigrations(db.client, MIGRATIONS);
    await resetTables(db.client);
    const box = createSecretBox([KEY]);
    const seen: { url: string; headers: Headers; body: string }[] = [];
    const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
      return new Response("ok", { status: 202 });
    }) as unknown as typeof fetch;
    const hooks = new WebhookCapabilities(db, box, fake);
    const created = await hooks.createWebhook(owner, {
      url: "https://hooks.example.com/inbox",
      events: ["*"],
      payload_style: "thin",
    });

    const result = await hooks.sendTestEvent(owner, { webhook_id: created.id });
    expect(result).toMatchObject({ delivered: true, status: 202, error: null });
    expect(result.event.type).toBe("inbox.test");
    expect(result.event.test).toBe(true);
    expect(result.event.message).toMatch(/test event/i);

    const call = seen[0];
    if (!call) throw new Error("nothing was sent");
    expect(call.url).toBe("https://hooks.example.com/inbox");
    expect(call.headers.get("webhook-id")).toBe(result.event.id);
    expect(call.headers.get("webhook-timestamp")).toBe(String(Math.floor(T0 / 1000)));
    const expected = await signWebhook(created.secret, result.event.id, Math.floor(T0 / 1000), call.body);
    expect(call.headers.get("webhook-signature")).toBe(`v1,${expected}`);

    // The test shows up in the delivery log like any other delivery.
    const page = await hooks.listDeliveries(owner, { limit: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ event_type: "inbox.test", status: "delivered", attempts: 1 });

    const failing = new WebhookCapabilities(db, box, (async () => new Response("no", { status: 500 })) as typeof fetch);
    const bad = await failing.sendTestEvent(owner, { webhook_id: created.id });
    expect(bad).toMatchObject({ delivered: false, status: 500 });
    expect(bad.error).toContain("500");
    expect((await failing.listWebhooks(owner))[0]?.deliveries).toMatchObject({ delivered: 1, failed: 1 });
  });

  it("re-queues a delivery in place, never as a second row", async () => {
    const { db, caps } = await setup();
    const created = await caps.webhooks.createWebhook(owner, {
      url: "https://hooks.example.com/inbox",
      events: ["*"],
      payload_style: "thin",
    });
    await db.client.query({
      sql: "INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, status, attempts, last_status, last_error, created_at) VALUES ('01JD0000000000000000000001', ?, 'ev_1', 'booking.create', 'failed', 8, 500, 'HTTP 500', ?)",
      params: [created.id, T0],
      method: "run",
    });
    const replayed = await caps.webhooks.replayDelivery(owner, { delivery_id: "01JD0000000000000000000001" });
    expect(replayed).toMatchObject({ status: "pending", attempts: 0, last_error: null });
    expect(replayed.next_attempt_at).toBe(new Date(T0).toISOString());
    const { rows } = await db.client.query({ sql: "SELECT COUNT(*) FROM webhook_deliveries", method: "all" });
    expect(Number(rows[0]?.[0])).toBe(1);
    const jobs = await db.client.query({
      sql: "SELECT kind, payload FROM jobs WHERE kind = ?",
      params: [WEBHOOK_DELIVERY_KIND],
      method: "all",
    });
    expect(jobs.rows).toHaveLength(1);
    expect(String(jobs.rows[0]?.[1])).toContain("01JD0000000000000000000001");

    await expect(caps.webhooks.replayDelivery(owner, { delivery_id: "nope" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

describe("the developer event cursor", () => {
  async function withEvents(): Promise<{ db: Db; caps: Capabilities; itemId: string }> {
    const { db, caps } = await setup();
    const itemId = "01JD0000000000000000ITEM01";
    await db.batch([
      {
        sql: "INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('party_1', 'person', ?, ?)",
        params: [T0, T0],
        method: "run",
      },
      {
        sql: "INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at) VALUES (?, 'booking', 'confirmed', 2, 'party_1', 'rest', '{}', '{\"sandbox\":0}', ?, ?)",
        params: [itemId, T0, T0],
        method: "run",
      },
    ]);
    // Interleaved on purpose: two item events and one inbound message, so the ids alternate across
    // the two arms of the view and only a total order over the ids reads them correctly.
    await db.batch([
      {
        sql: "INSERT INTO item_events (id, item_id, seq, event, from_state, to_state, actor_kind, actor_id, depth, created_at) VALUES ('01JD00000000000000000000A1', ?, 1, 'create', NULL, 'requested', 'customer_agent', 'agent:claude', 0, ?)",
        params: [itemId, T0],
        method: "run",
      },
      {
        sql: "INSERT INTO thread_entries (id, item_id, direction, channel, actor_kind, actor_id, body_text, body_format, created_at) VALUES ('01JD00000000000000000000A2', ?, 'in', 'email', 'customer_human', 'rita', 'any news?', 'text', ?)",
        params: [itemId, T0 + 1_000],
        method: "run",
      },
      {
        sql: "INSERT INTO item_events (id, item_id, seq, event, from_state, to_state, actor_kind, actor_id, depth, created_at) VALUES ('01JD00000000000000000000A3', ?, 2, 'confirm', 'requested', 'confirmed', 'owner', 'user_1', 0, ?)",
        params: [itemId, T0 + 2_000],
        method: "run",
      },
      {
        sql: "INSERT INTO thread_entries (id, item_id, direction, channel, actor_kind, actor_id, body_text, body_format, created_at) VALUES ('01JD00000000000000000000A4', ?, 'out', 'email', 'owner', 'user_1', 'confirmed!', 'text', ?)",
        params: [itemId, T0 + 3_000],
        method: "run",
      },
    ]);
    return { db, caps, itemId };
  }

  it("walks both arms of the view in one stable order and never repeats an event", async () => {
    const { caps, itemId } = await withEvents();
    const first = await caps.webhooks.listEvents(owner, { cursor: "", limit: 2 });
    expect(first.events.map((e) => e.id)).toEqual(["01JD00000000000000000000A1", "01JD00000000000000000000A2"]);
    expect(first.events.map((e) => e.type)).toEqual(["booking.create", "booking.message"]);
    expect(first.next_cursor).toBe("01JD00000000000000000000A2");

    const second = await caps.webhooks.listEvents(owner, { cursor: first.next_cursor as string, limit: 2 });
    expect(second.events.map((e) => e.id)).toEqual(["01JD00000000000000000000A3"]);
    expect(second.next_cursor).toBe("01JD00000000000000000000A3");

    const third = await caps.webhooks.listEvents(owner, { cursor: second.next_cursor as string, limit: 2 });
    expect(third.events).toEqual([]);
    expect(third.next_cursor).toBeNull();

    // No id appears twice over the whole walk, and an outbound reply is not an event.
    const all = [...first.events, ...second.events, ...third.events].map((e) => e.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain("01JD00000000000000000000A4");

    expect(first.events[0]).toEqual({
      id: "01JD00000000000000000000A1",
      type: "booking.create",
      timestamp: new Date(T0).toISOString(),
      data: {
        id: itemId,
        type: "booking",
        state: "requested",
        version: 1,
        url: `/v1/owner/items/${itemId}`,
        // A customer's id is a fingerprint and is not given out; the door falls back to the item's.
        actor: { kind: "customer_agent", id: null },
        channel: "rest",
        sandbox: false,
      },
    });
    // The business side is named: this is what a two-way sync compares with its own key.
    expect(second.events[0]?.data.actor).toEqual({ kind: "owner", id: "user_1" });
    // An inbound message says which door it came through.
    expect(first.events[1]?.data.channel).toBe("email");
  });

  it("filters by type pattern and by since, and puts the app URL on the pointer", async () => {
    const { caps, itemId } = await withEvents();
    await caps.updateSettings(owner, { doc: { notifications: { appUrl: "https://inbox.example.com/" } } });
    const confirms = await caps.webhooks.listEvents(owner, { limit: 50, types: ["booking.confirm"] });
    expect(confirms.events.map((e) => e.id)).toEqual(["01JD00000000000000000000A3"]);
    expect(confirms.events[0]?.data.url).toBe(`https://inbox.example.com/v1/owner/items/${itemId}`);

    const wildcards = await caps.webhooks.listEvents(owner, { limit: 50, types: ["booking.*"] });
    expect(wildcards.events).toHaveLength(3);
    const messages = await caps.webhooks.listEvents(owner, { limit: 50, types: ["*.message"] });
    expect(messages.events.map((e) => e.id)).toEqual(["01JD00000000000000000000A2"]);
    const since = await caps.webhooks.listEvents(owner, {
      limit: 50,
      since: new Date(T0 + 2_000).toISOString(),
    });
    expect(since.events.map((e) => e.id)).toEqual(["01JD00000000000000000000A3"]);
  });

  /**
   * `*` beside another pattern means everything, and it has to mean that from either end of the
   * list. The clause list and the parameter list are built together, so a `*` found after a
   * pattern had already pushed a parameter would leave that parameter with nothing to bind to and
   * the driver would refuse the statement outright.
   */
  it("treats `*` anywhere in a type list as every type, whichever end it is at", async () => {
    const { caps } = await withEvents();
    const all = ["01JD00000000000000000000A1", "01JD00000000000000000000A2", "01JD00000000000000000000A3"];
    for (const types of [["booking.*", "*"], ["*", "booking.*"], ["*"], ["*.message", "*", "booking.confirm"]]) {
      const page = await caps.webhooks.listEvents(owner, { limit: 50, types });
      expect(
        page.events.map((e) => e.id),
        types.join("|"),
      ).toEqual(all);
    }
  });

  /**
   * An event's id is minted before its batch commits, and `ulid()` is monotonic only inside one
   * process, so a row with a lower id can land after a poller has passed it — and `id > ?` would
   * never show it again. The cursor therefore holds the newest few seconds back.
   */
  it("holds the newest events back, so a late commit can never fall below the cursor", async () => {
    const { db, caps } = await withEvents();
    const fresh = "01JD0000000000000000000ZZ9";
    await db.client.query({
      sql: "INSERT INTO item_events (id, item_id, seq, event, from_state, to_state, actor_kind, actor_id, depth, created_at) VALUES (?, '01JD0000000000000000ITEM01', 3, 'cancel', 'confirmed', 'cancelled', 'owner', 'user_1', 0, ?)",
      params: [fresh, Date.now()],
      method: "run",
    });
    const settled = await caps.webhooks.listEvents(owner, { limit: 50 });
    expect(settled.events.map((e) => e.id)).not.toContain(fresh);
    expect(settled.next_cursor).toBe("01JD00000000000000000000A3");

    // With the horizon switched off — which only a test ever does — it is there.
    const live = new WebhookCapabilities(db, null, undefined, undefined, 0);
    expect((await live.listEvents(owner, { limit: 50 })).events.map((e) => e.id)).toContain(fresh);
  });

  it("replays exactly what an endpoint missed, and leaves what it already had alone", async () => {
    const { db, caps } = await withEvents();
    const hook = await caps.webhooks.createWebhook(owner, {
      url: "https://hooks.example.com/inbox",
      events: ["booking.create", "booking.confirm"],
      payload_style: "thin",
    });
    await db.client.query({
      sql: "INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, status, attempts, created_at, delivered_at) VALUES ('01JD0000000000000000000009', ?, '01JD00000000000000000000A1', 'booking.create', 'delivered', 1, ?, ?)",
      params: [hook.id, T0, T0],
      method: "run",
    });
    const report = await caps.webhooks.replayMissing(owner, {
      webhook_id: hook.id,
      since: new Date(T0 - 60_000).toISOString(),
    });
    expect(report).toMatchObject({ webhook_id: hook.id, matched: 2, queued: 1, truncated: false });

    const page = await caps.webhooks.listDeliveries(owner, { webhook_id: hook.id, limit: 50 });
    expect(page.items).toHaveLength(2);
    expect(page.items.find((d) => d.event_id === "01JD00000000000000000000A1")?.status).toBe("delivered");
    expect(page.items.find((d) => d.event_id === "01JD00000000000000000000A3")?.status).toBe("pending");
    // The message event was not subscribed to, so no row was made for it.
    expect(page.items.some((d) => d.event_id === "01JD00000000000000000000A2")).toBe(false);

    // Running it again re-queues without making a second row for the same event.
    const again = await caps.webhooks.replayMissing(owner, {
      webhook_id: hook.id,
      since: new Date(T0 - 60_000).toISOString(),
    });
    expect(again.queued).toBe(1);
    expect(again.next_after).toBeNull();
    expect((await caps.webhooks.listDeliveries(owner, { webhook_id: hook.id, limit: 50 })).items).toHaveLength(2);

    // `after` is the resume point, so a second window starts where the first one stopped: A1 is
    // behind the cursor now and only A3 is left to match.
    const paged = await caps.webhooks.replayMissing(owner, {
      webhook_id: hook.id,
      since: new Date(T0 - 60_000).toISOString(),
      after: "01JD00000000000000000000A1",
    });
    expect(paged.matched).toBe(1);
  });
});

describe("only the business side may touch any of it", () => {
  it("refuses a customer-side caller on every operation", async () => {
    const { db, caps } = await setup();
    const hook = await caps.webhooks.createWebhook(owner, {
      url: "https://hooks.example.com/inbox",
      events: ["*"],
      payload_style: "thin",
    });
    await db.client.query({
      sql: "INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, status, attempts, created_at) VALUES ('01JD0000000000000000000002', ?, 'ev_1', 'booking.create', 'failed', 1, ?)",
      params: [hook.id, T0],
      method: "run",
    });
    const refusals = [
      () => caps.webhooks.listWebhooks(customer),
      () =>
        caps.webhooks.createWebhook(customer, { url: "https://x.example.com/h", events: ["*"], payload_style: "thin" }),
      () => caps.webhooks.updateWebhook(customer, { webhook_id: hook.id, active: false }),
      () => caps.webhooks.rotateWebhookSecret(customer, { webhook_id: hook.id }),
      () => caps.webhooks.deleteWebhook(customer, { webhook_id: hook.id }),
      () => caps.webhooks.listDeliveries(customer, { limit: 50 }),
      () => caps.webhooks.replayDelivery(customer, { delivery_id: "01JD0000000000000000000002" }),
      () => caps.webhooks.replayMissing(customer, { webhook_id: hook.id, since: new Date(T0).toISOString() }),
      () => caps.webhooks.sendTestEvent(customer, { webhook_id: hook.id }),
      () => caps.webhooks.listEvents(customer, { limit: 50 }),
    ];
    for (const refusal of refusals) {
      await expect(refusal()).rejects.toMatchObject({ code: "not_allowed" });
    }
    // Nothing was changed by any of them.
    expect((await caps.webhooks.listWebhooks(owner)).map((w) => w.id)).toEqual([hook.id]);
    expect((await caps.webhooks.listDeliveries(owner, { limit: 50 })).items[0]?.status).toBe("failed");
  });
});

describe("subscription patterns", () => {
  it("matches a whole segment, never half of one", () => {
    expect(matchesEvent(["*"], "booking.confirm")).toBe(true);
    expect(matchesEvent(["booking.*"], "booking.confirm")).toBe(true);
    expect(matchesEvent(["booking.*"], "order.confirm")).toBe(false);
    expect(matchesEvent(["*.create"], "order.create")).toBe(true);
    expect(matchesEvent(["booking.confirm"], "booking.confirm")).toBe(true);
    expect(matchesEvent(["booking.confirm"], "booking.confirmed")).toBe(false);
    expect(matchesEvent(["booking"], "booking.confirm")).toBe(false);
    expect(matchesEvent(["order.*", "quote_request.quote"], "quote_request.quote")).toBe(true);
  });
});
