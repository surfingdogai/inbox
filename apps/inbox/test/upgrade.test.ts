import { createApiKey } from "@surfingdog/adapters";
import {
  MANIFEST_PATH,
  NETWORK_PING_KIND,
  NETWORK_PING_ONE_KIND,
  NETWORK_PUBLISH_KIND,
  NETWORK_RECEIPT_KIND,
  pingDedupeKey,
  readSettings,
  type Settings,
  schema,
  ulid,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { toSettingsForm } from "../client/src/lib/settings";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * The upgrade from one network to several, as the live instance meets it: a settings document the
 * previous version stored (the whole parsed document, with the legacy `network: {url, join}`
 * pair), receipt jobs queued under the old dedupe key, and clients that still speak the old shape.
 * Nothing here is done by the owner: it must keep reporting and publishing to the same network,
 * and no write from an older client may reset anything. Runs on Node and inside workerd.
 */
const INBOX = "https://inbox.surfingdog.ai";
const NET = "https://network.surfingdog.ai";
const B = "https://directory.example.com";
const T0 = Date.parse("2026-09-23T09:00:00Z");
const HOUR = 3_600_000;

/** Exactly what the previous version stored after `seed-surfingdog` and the owner's own edits. */
const LIVE_DOC = {
  schemaVersion: 1,
  business: { name: "Surfing Dog", timezone: "Europe/Lisbon", currency: "EUR", languages: ["en", "pt"] },
  booking: { cancellationWindowMin: 60, holdOnPropose: false, autoExpireHours: 72 },
  orders: { maxValueWithoutApprovalMinor: 0 },
  notifications: { ownerEmail: "hello@surfingdog.ai", appUrl: INBOX },
  email: {},
  integrations: {
    webhooks: {
      enabled: true,
      timeoutMs: 10_000,
      maxAttempts: 8,
      disableAfterDays: 5,
      retainDeliveryDays: 30,
      allowPrivateTargets: false,
    },
    feeds: { enabled: true, refreshHours: 6, maxProducts: 5_000, deactivateMissing: true },
    connectors: { enabled: true, syncMinutes: 15, retainEventDays: 30 },
  },
  network: { url: NET, join: true },
  testMode: false,
};
const LIVE_VERSION = 7;

/**
 * The network: knows the live instance, answers a ping with 204, and a receipt it has already
 * stored with `duplicate: true`, like the real one does. Every call is recorded.
 */
type Body = { receipt?: string; ack?: string };

function fakeNetwork() {
  const stored = new Set<string>();
  const calls: { url: string; body: Body | null }[] = [];
  const net = {
    calls,
    stored,
    /** Overrides the answer to one receipt; `undefined` answers as the network normally does. */
    answer: (_body: Body): Response | undefined => undefined,
    receiptPosts: () => calls.filter((c) => c.url === `${NET}/v1/receipts`),
    fetchImpl: undefined as unknown as typeof fetch,
  };
  net.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : null;
    calls.push({ url, body });
    if (!url.startsWith(`${NET}/`)) return new Response("not a network", { status: 500 });
    if (url === `${NET}/v1/instances/inbox.surfingdog.ai/ping`) return new Response(null, { status: 204 });
    const special = body ? net.answer(body) : undefined;
    if (special) return special;
    if (url === `${NET}/v1/receipts` && body?.receipt) {
      const duplicate = stored.has(body.receipt);
      stored.add(body.receipt);
      return Response.json(
        { ok: true, state: body.ack ? "acknowledged" : "issued", duplicate },
        { status: duplicate ? 200 : 201 },
      );
    }
    return new Response(JSON.stringify({ code: "unexpected" }), { status: 400 });
  }) as typeof fetch;
  return net;
}

async function liveInstance(net = fakeNetwork()) {
  const db = await freshDb();
  const svc = ulid();
  await db.orm.insert(schema.services).values({
    id: svc,
    name: "Surf lesson",
    durationMin: 90,
    capacity: 1,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Surfing Dog",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    createdAt: T0,
    updatedAt: T0,
  });
  await db.client.query({
    sql: "INSERT INTO settings (id, schema_version, doc, version, updated_at) VALUES ('singleton', 1, ?, ?, ?)",
    params: [JSON.stringify(LIVE_DOC), LIVE_VERSION, T0],
    method: "run",
  });
  const owner = await createApiKey(db, { kind: "owner", name: "test" });
  const inbox = createInbox({
    db,
    secretKey: "upgrade-test-instance-key-0123456789",
    baseUrl: INBOX,
    fetchImpl: net.fetchImpl,
    background: () => {},
  });
  const auth = { authorization: `Bearer ${owner.key}` };
  const put = (doc: unknown, expected_version?: number) =>
    inbox.app.request(`${INBOX}/v1/owner/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ doc, ...(expected_version ? { expected_version } : {}) }),
    });
  const get = async <T>(path: string) =>
    (await (await inbox.app.request(`${INBOX}${path}`, { headers: auth })).json()) as T;
  return { db, svc, inbox, net, put, get, auth };
}

type Live = Awaited<ReturnType<typeof liveInstance>>;

/** A confirmed booking `day` days from now, and the receipt the runner signs for it. */
async function confirmedReceipt(s: Live, day: number) {
  const startTime = new Date((Math.floor(Date.now() / HOUR) + day * 24) * HOUR).toISOString();
  const created = await s.inbox.app.request(`${INBOX}/v1/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      payload: {
        reservationFor: { serviceId: s.svc, name: "Surf lesson" },
        startTime,
        endTime: new Date(Date.parse(startTime) + 90 * 60_000).toISOString(),
      },
      contact: { name: "Rita", email: "rita@example.com" },
    }),
  });
  expect(created.status).toBe(201);
  const itemId = ((await created.json()) as { view: { item: { id: string } } }).view.item.id;
  const confirmed = await s.inbox.app.request(`${INBOX}/v1/owner/items/${itemId}/transitions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...s.auth },
    body: JSON.stringify({ event: "confirm" }),
  });
  expect(confirmed.status).toBe(200);
  // A request starts a run of its own; one already in flight is shared, so run until it is signed.
  for (let i = 0; i < 10; i++) {
    await s.inbox.runner.runDue(s.db, { workerId: "test" });
    const receipt = (await s.db.orm.select().from(schema.receipts)).find((r) => r.itemId === itemId);
    if (receipt) return receipt;
  }
  throw new Error("no receipt was issued");
}

/** A job exactly as the previous version queued it: its kind, payload and dedupe key. */
async function oldJob(s: Live, kind: string, key: string, payload: unknown, status: string, runAt: number) {
  await s.db.client.query({
    sql: `INSERT INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at, done_at)
          VALUES (?, ?, ?, ?, ?, ?, 8, ?, ?, ?)`,
    params: [
      ulid(),
      kind,
      JSON.stringify(payload),
      runAt,
      status,
      status === "dead" ? 8 : status === "done" ? 1 : 0,
      key,
      runAt,
      status === "done" ? runAt : null,
    ],
    method: "run",
  });
}

/** Runs until a run claims nothing; a run a request started is shared, so it is waited for too. */
async function drain(s: Live, now?: number) {
  for (let i = 0; i < 30; i++) {
    if ((await s.inbox.runner.runDue(s.db, { workerId: "test", ...(now ? { now } : {}) })).claimed === 0) return;
  }
}

const NETWORK_KINDS = [NETWORK_PING_KIND, NETWORK_PING_ONE_KIND, NETWORK_PUBLISH_KIND, NETWORK_RECEIPT_KIND];

/**
 * `count` receipts as the previous version left them: signed and stored, with none of what this
 * version writes beside them (publication rows, network jobs, network status), and a network that
 * has heard nothing yet.
 */
async function receiptsFromBefore(s: Live, count: number) {
  const receipts = [];
  for (let day = 1; day <= count; day++) receipts.push(await confirmedReceipt(s, day));
  await drain(s);
  await s.db.client.query({ sql: "DELETE FROM network_publications", params: [], method: "run" });
  await s.db.client.query({ sql: "DELETE FROM network_status", params: [], method: "run" });
  await s.db.client.query({
    sql: `DELETE FROM jobs WHERE kind IN (${NETWORK_KINDS.map(() => "?").join(", ")})`,
    params: NETWORK_KINDS,
    method: "run",
  });
  s.net.calls.length = 0;
  s.net.stored.clear();
  return receipts;
}

const publicationStates = async (s: Live) =>
  new Map(
    (
      await s.db.client.query({
        sql: "SELECT receipt_id, state, last_error FROM network_publications WHERE stage = 'issued'",
        params: [],
        method: "all",
      })
    ).rows.map((r) => [String(r[0]), `${String(r[1])}${r[2] === null ? "" : `: ${String(r[2])}`}`]),
  );

describe("upgrading the live instance to several networks", () => {
  it("keeps pinging and publishing to the same network, with nothing for the owner to do", async () => {
    const s = await liveInstance();
    // Three receipts from before the upgrade. The previous version published the first (its job is
    // done and the network has it), was still retrying the second when the deploy landed, and gave
    // up on the third after eight attempts.
    const [r1, r2, r3] = await receiptsFromBefore(s, 3);
    if (!r1 || !r2 || !r3) throw new Error("three receipts");
    s.net.stored.add(r1.jws);
    const now = Date.now() + 1_000;
    await oldJob(
      s,
      NETWORK_RECEIPT_KIND,
      `network_receipt:${r1.id}:issued`,
      { receiptId: r1.id, stage: "issued" },
      "done",
      T0,
    );
    await oldJob(
      s,
      NETWORK_RECEIPT_KIND,
      `network_receipt:${r2.id}:issued`,
      { receiptId: r2.id, stage: "issued" },
      "queued",
      now,
    );
    await oldJob(
      s,
      NETWORK_RECEIPT_KIND,
      `network_receipt:${r3.id}:issued`,
      { receiptId: r3.id, stage: "issued" },
      "dead",
      T0,
    );
    // And the hourly tick, queued by the previous version under the key it has always had.
    await oldJob(s, NETWORK_PING_KIND, pingDedupeKey(now), {}, "queued", now);

    await drain(s, now);

    // The same ping to the same network, as the same domain.
    expect(s.net.calls.filter((c) => c.url.includes("/v1/instances"))).toEqual([
      {
        url: `${NET}/v1/instances/inbox.surfingdog.ai/ping`,
        body: expect.objectContaining({ version: expect.any(String) }),
      },
    ]);
    // The receipt that was pending and the one that was lost both reach the network, once each;
    // the one it already had is at most sent again, and it says so.
    const posted = s.net.receiptPosts().map((c) => c.body?.receipt);
    expect(posted.filter((j) => j === r2.jws)).toHaveLength(1);
    expect(posted.filter((j) => j === r3.jws)).toHaveLength(1);
    expect(posted.filter((j) => j === r1.jws).length).toBeLessThanOrEqual(1);
    expect(posted.every((j) => j === r1.jws || j === r2.jws || j === r3.jws)).toBe(true);

    // Nothing is stuck: no network job is left due, running or dead, but the dead one we put there.
    const { rows } = await s.db.client.query({
      sql: `SELECT kind, dedupe_key, status FROM jobs WHERE kind IN (${NETWORK_KINDS.map(() => "?").join(", ")})
              AND (status IN ('running', 'dead') OR (status = 'queued' AND run_at <= ?))`,
      params: [...NETWORK_KINDS, now],
      method: "all",
    });
    expect(rows.map((r) => String(r[1]))).toEqual([`network_receipt:${r3.id}:issued`]);

    // The owner sees the network on, verified, and every receipt published.
    const { networks } = await s.get<{
      networks: { origin: string; enabled: boolean; registration: string; receipts: unknown }[];
    }>("/v1/owner/networks");
    expect(networks).toEqual([
      expect.objectContaining({
        origin: NET,
        enabled: true,
        registration: "registered",
        receipts: { published: 3, queued: 0, refused: 0 },
      }),
    ]);
    // The manifest still names the network, spelled as before.
    const manifest = await s.get<{ review_services: string[] }>(MANIFEST_PATH);
    expect(manifest.review_services).toEqual([NET]);
    expect(manifest.review_services).toEqual([LIVE_DOC.network.url]);
  });

  it("sends the rest of the backfill around a receipt the network will not take yet", async () => {
    const s = await liveInstance();
    const [r1, r2, r3] = await receiptsFromBefore(s, 3);
    if (!r1 || !r2 || !r3) throw new Error("three receipts");
    // The oldest was signed under an address the network has no verified instance for (the inbox
    // moved, say). The network answers the way it does for an issuer it does not know yet, which
    // is its own state rather than a verdict, so that receipt is kept and tried again. It must not
    // stand in front of every receipt after it, hour after hour.
    s.net.answer = (body) =>
      body.receipt === r1.jws
        ? Response.json({ code: "unknown_issuer", detail: "not a verified instance" }, { status: 404 })
        : undefined;
    const now = Date.now() + 1_000;
    await oldJob(s, NETWORK_PING_KIND, pingDedupeKey(now), {}, "queued", now);
    // The first run, and the publisher's own retries within the hour.
    for (const t of [now, now + 5 * 60_000, now + 20 * 60_000]) await drain(s, t);

    const states = await publicationStates(s);
    expect(states.get(r2.id)).toBe("published");
    expect(states.get(r3.id)).toBe("published");
    expect(states.get(r1.id)).toBe("queued: HTTP 404 unknown_issuer: not a verified instance");
  });

  it("keeps the stored legacy pair truthful, so a rollback never starts sending again", async () => {
    const s = await liveInstance();
    const legacy = async () => {
      const { rows } = await s.db.client.query({ sql: "SELECT doc FROM settings", params: [], method: "all" });
      return (JSON.parse(String(rows[0]?.[0])) as { network?: unknown }).network;
    };
    // The previous version reads only `network`; after the owner switches the network off here,
    // it must read "off" too.
    expect((await s.put({ networks: { [NET]: { enabled: false } } })).status).toBe(200);
    expect(await legacy()).toEqual({ url: NET, join: false });
    expect((await s.put({ networks: { [NET]: { enabled: true, share: { receipts: false } } } })).status).toBe(200);
    expect(await legacy()).toEqual({ url: NET, join: false });
    expect((await s.put({ networks: { [NET]: { share: { receipts: true } }, [B]: { enabled: true } } })).status).toBe(
      200,
    );
    expect(await legacy()).toEqual({ url: NET, join: true });
  });

  it("loads the stored document in the owner app, as it was, with the network on", async () => {
    const s = await liveInstance();
    const { doc, version } = await s.get<{ doc: Settings; version: number }>("/v1/owner/settings");
    expect(version).toBe(LIVE_VERSION);
    expect(doc.networks).toEqual({
      [NET]: { enabled: true, issue: true, share: { listing: true, counts: true, receipts: true } },
    });
    expect(doc.booking.cancellationWindowMin).toBe(60);
    expect(doc.business.languages).toEqual(["en", "pt"]);
    // The General form reads it without a field it does not know about.
    expect(toSettingsForm(doc)).toMatchObject({ cancellationWindowMin: "60", appUrl: INBOX });
    // Reading changes nothing: what is stored is what the previous version wrote.
    const { rows } = await s.db.client.query({ sql: "SELECT doc FROM settings", params: [], method: "all" });
    expect(JSON.parse(String(rows[0]?.[0]))).toEqual(LIVE_DOC);
  });

  it("never lets a write from an older client reset the networks or anything else", async () => {
    const s = await liveInstance();
    const on = async () =>
      Object.entries((await readSettings(s.db)).networks)
        .filter(([, n]) => n.enabled)
        .map(([origin]) => origin)
        .sort();

    // An owner app tab opened before the deploy saves the whole document it loaded then, with the
    // legacy pair in it, the way the previous owner app built it.
    const oldTab = {
      ...LIVE_DOC,
      booking: { ...LIVE_DOC.booking, cancellationWindowMin: 90 },
      notifications: { ownerEmail: LIVE_DOC.notifications.ownerEmail, appUrl: LIVE_DOC.notifications.appUrl },
      email: {},
      network: { url: LIVE_DOC.network.url, join: true },
    };
    expect((await s.put(oldTab, LIVE_VERSION)).status).toBe(200);
    let settings = await readSettings(s.db);
    expect(await on()).toEqual([NET]);
    expect(settings.booking.cancellationWindowMin).toBe(90);
    expect(settings.notifications).toEqual({ ownerEmail: "hello@surfingdog.ai", appUrl: INBOX });
    expect(settings.integrations).toEqual(LIVE_DOC.integrations);
    expect(settings.business).toEqual(LIVE_DOC.business);

    // An assistant that learned the previous API changes one section, or re-joins.
    expect((await s.put({ business: { name: "Surfing Dog Lda" } })).status).toBe(200);
    expect((await s.put({ network: { join: true } })).status).toBe(200);
    expect((await s.put({ network: { url: NET, join: true } })).status).toBe(200);
    settings = await readSettings(s.db);
    expect(await on()).toEqual([NET]);
    expect(settings.business).toEqual({ ...LIVE_DOC.business, name: "Surfing Dog Lda" });
    expect(settings.booking.cancellationWindowMin).toBe(90);

    // The owner adds a second network in the new app; older partial writes leave both alone.
    expect((await s.put({ networks: { [B]: { enabled: true } } })).status).toBe(200);
    expect((await s.put({ booking: { cancellationWindowMin: 30 } })).status).toBe(200);
    expect((await s.put({ network: { join: true } })).status).toBe(200);
    expect(await on()).toEqual([B, NET].sort());
    expect((await readSettings(s.db)).booking).toEqual({ ...LIVE_DOC.booking, cancellationWindowMin: 30 });

    // The tab from before the deploy cannot overwrite any of it: its version is long gone.
    const stale = await s.put(oldTab, LIVE_VERSION);
    expect(stale.status).toBe(409);
    expect(await on()).toEqual([B, NET].sort());

    // "Leave the network", the only way the previous API had to say it, leaves every network:
    // the older client cannot say which of the two it means, and neither may keep hearing from us.
    expect((await s.put({ network: { join: false } })).status).toBe(200);
    expect(await on()).toEqual([]);
    expect((await s.get<{ review_services: string[] }>(MANIFEST_PATH)).review_services).toEqual([]);
    // Both stay listed, switched off, for the owner to switch on again.
    expect(Object.keys((await readSettings(s.db)).networks).sort()).toEqual([B, NET].sort());
  });
});
