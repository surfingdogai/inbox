import {
  ACK_TYP,
  ALG,
  b64u,
  Capabilities,
  createSecretBox,
  generateKeyPair,
  JobRunner,
  NETWORK_PUBLISH_KIND,
  NETWORK_RECEIPT_KIND,
  networkLane,
  publishKey,
  receiptSha,
  schema,
  ulid,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { type NetworkDeps, networkPublishHandler, networkReceiptHandler } from "../src/network";
import { freshDb } from "./db";

/**
 * Publishing receipts to every network that is on (ADR-016, ADR-017 §3.3 and §8.1): one row per
 * receipt, network and stage in `network_publications`, one job per network the moment a receipt
 * is issued or acknowledged, and an hourly publisher per network that sends whatever is still
 * queued — the backfill when a network is switched on and the catch-up after an outage. The
 * networks are fakes here; their real verification is covered on their side against the vectors.
 */
const T0 = Date.parse("2026-09-22T09:00:00Z");
const HOUR = 3_600_000;
const KEY = "publish-test-instance-key-0123456789";
const ISS = "https://inbox.example.com";
const A = "https://network.example.com";
const B = "https://second.example.net";

const owner = (t = T0) => ({
  actor: { kind: "owner" as const, id: "u1", channel: "owner_ui" as const },
  tier: "verified_principal" as const,
  sandbox: false,
  now: () => t,
});
const customer = (t = T0) => ({
  actor: { kind: "customer_human" as const, id: "form", channel: "form" as const },
  tier: "anonymous" as const,
  sandbox: false,
  now: () => t,
});

type Body = { receipt: string; ack?: string };
type Answer = Response | "hang";

/** Fake networks by origin; each answers receipts with `reply`, and anything else with 204. */
function fakeNetworks(reply: Record<string, (body: Body) => Answer>) {
  const calls: { network: string; url: string; body: Body }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/v1/receipts")) return new Response(null, { status: 204 });
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    const network = new URL(url).origin;
    calls.push({ network, url, body });
    const answer = reply[network]?.(body) ?? json(500, {});
    if (answer === "hang") {
      return await new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    }
    return answer;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const accepted = (body: Body) =>
  json(body.ack ? 200 : 201, { ok: true, state: body.ack ? "acknowledged" : "issued", duplicate: false });

/** A runner that knows the publishing jobs and lets everything else a booking causes pass quietly. */
function runnerWith(fetchImpl: typeof fetch, extra: Partial<NetworkDeps> = {}): JobRunner {
  const deps = { version: "0.0.0", fetchImpl, timeoutMs: 100, ...extra };
  const runner = new JobRunner()
    .register(NETWORK_RECEIPT_KIND, networkReceiptHandler(deps), { lane: networkLane })
    .register(NETWORK_PUBLISH_KIND, networkPublishHandler(deps), { lane: networkLane });
  for (const kind of ["notify", "rules", "issue_receipt", "webhook_fanout", "network_ping", "network_ping_one"]) {
    runner.register(kind, async () => undefined);
  }
  return runner;
}

type Db = Awaited<ReturnType<typeof freshDb>>["db"];

async function drain(runner: JobRunner, db: Db, now: number) {
  for (let i = 0; i < 50; i++) {
    if ((await runner.runDue(db, { now })).claimed === 0) return;
  }
}

async function setup(networks: Record<string, unknown>) {
  const { db } = await freshDb();
  const caps = new Capabilities(db, createSecretBox([KEY]), ISS, 0);
  if (Object.keys(networks).length) await caps.updateSettings(owner(), { doc: { networks } });
  // Only the receipt jobs matter here; the ping and the publisher the switch-on queued would
  // otherwise run first and take the receipt out from under them.
  await db.client.query({ sql: "DELETE FROM jobs", params: [], method: "run" });
  const svc = ulid();
  await db.orm.insert(schema.services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    capacity: 1,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  const created = await caps.createBooking(customer(), {
    payload: {
      reservationFor: { serviceId: svc, name: "Full service" },
      startTime: "2026-09-23T08:00:00Z",
      endTime: "2026-09-23T09:30:00Z",
    },
    contact: { name: "Rita", email: "rita@example.com" },
  });
  const itemId = created.view.item.id;
  await caps.transitionItem(owner(T0 + 1), { item_id: itemId, event: "confirm" });
  const issued = await caps.receipts.issue(itemId, "confirmed", T0 + 2);
  if (issued.outcome !== "issued") throw new Error(issued.outcome);
  return { db, caps, itemId, token: created.accessToken, receipt: issued.receipt };
}

const receiptJobs = async (db: Db) =>
  (
    await db.client.query({
      sql: "SELECT dedupe_key, status, last_error, payload FROM jobs WHERE kind = ? ORDER BY dedupe_key",
      params: [NETWORK_RECEIPT_KIND],
      method: "all",
    })
  ).rows.map((r) => ({
    key: String(r[0]),
    status: String(r[1]),
    note: r[2] === null ? null : String(r[2]),
    payload: JSON.parse(String(r[3])) as unknown,
  }));

const publications = async (db: Db) =>
  (
    await db.client.query({
      sql: "SELECT network, stage, state, attempts, last_error FROM network_publications ORDER BY network, stage",
      params: [],
      method: "all",
    })
  ).rows.map((r) => ({
    network: String(r[0]),
    stage: String(r[1]),
    state: String(r[2]),
    attempts: Number(r[3]),
    error: r[4] === null ? null : String(r[4]),
  }));

const dueNow = (db: Db, t: number) =>
  db.client.query({ sql: "UPDATE jobs SET run_at = ? WHERE status = 'queued'", params: [t], method: "run" });

async function counterSign(receiptId: string, receiptJws: string, iatSec: number) {
  const agent = await generateKeyPair();
  const enc = new TextEncoder();
  const header = { alg: ALG, typ: ACK_TYP, jwk: agent.publicJwk };
  const body = { rcp: receiptId, sha: await receiptSha(receiptJws), iat: iatSec };
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

describe("publishing receipts to the networks", () => {
  it("queues nothing while no network is on", async () => {
    const { db } = await setup({});
    expect(await receiptJobs(db)).toEqual([]);
    expect(await publications(db)).toEqual([]);
  });

  it("queues one row and one job per network that takes receipts, keyed by its origin", async () => {
    const { db, receipt } = await setup({
      [A]: { enabled: true },
      [B]: { enabled: true },
      "https://quiet.example.com": { enabled: true, share: { receipts: false } },
      "https://off.example.com": { enabled: false },
    });
    expect((await receiptJobs(db)).map((j) => [j.key, j.payload])).toEqual([
      [`${NETWORK_RECEIPT_KIND}:${A}:${receipt.id}:issued`, { receiptId: receipt.id, stage: "issued", network: A }],
      [`${NETWORK_RECEIPT_KIND}:${B}:${receipt.id}:issued`, { receiptId: receipt.id, stage: "issued", network: B }],
    ]);
    expect(await publications(db)).toEqual([
      { network: A, stage: "issued", state: "queued", attempts: 0, error: null },
      { network: B, stage: "issued", state: "queued", attempts: 0, error: null },
    ]);
  });

  it("posts the receipt once issued and again with the acknowledgement", async () => {
    const { db, caps, itemId, token, receipt } = await setup({ [A]: { enabled: true } });
    const net = fakeNetworks({ [A]: accepted });
    const runner = runnerWith(net.fetchImpl);
    await runner.runDue(db, { now: T0 + 3 });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]).toMatchObject({ url: `${A}/v1/receipts`, body: { receipt: receipt.jws } });
    expect(net.calls[0]?.body.ack).toBeUndefined();
    expect((await receiptJobs(db))[0]).toMatchObject({
      status: "done",
      note: expect.stringMatching(/^published issued receipt/),
    });

    const now = T0 + 60_000;
    await caps.acknowledgeReceipt(customer(now), {
      item_id: itemId,
      counter_signature: await counterSign(receipt.id, receipt.jws, Math.floor(now / 1000)),
      ...(token ? { access_token: token } : {}),
    });
    await runner.runDue(db, { now: now + 1 });
    expect(net.calls).toHaveLength(2);
    expect(net.calls[1]?.body.receipt).toBe(receipt.jws);
    expect(net.calls[1]?.body.ack).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect((await publications(db)).map((p) => `${p.stage}:${p.state}`)).toEqual([
      "acknowledged:published",
      "issued:published",
    ]);
    const view = (await caps.getNetworks(owner())).networks.find((n) => n.origin === A);
    expect(view?.receipts).toEqual({ published: 2, queued: 0, refused: 0 });
    // Nothing about Rita in either body.
    for (const c of net.calls) expect(JSON.stringify(c.body)).not.toMatch(/rita/i);
  });

  it("publishes to one network while the other is down, and catches the other up later", async () => {
    const { db, caps, receipt } = await setup({ [A]: { enabled: true }, [B]: { enabled: true } });
    const net = fakeNetworks({ [A]: accepted, [B]: () => "hang" });
    await runnerWith(net.fetchImpl).runDue(db, { now: T0 + 3 });
    expect(await publications(db)).toEqual([
      { network: A, stage: "issued", state: "published", attempts: 1, error: null },
      { network: B, stage: "issued", state: "queued", attempts: 1, error: "no answer within 100 ms" },
    ]);
    const jobs = await receiptJobs(db);
    expect(jobs.find((j) => j.key.includes(A))?.status).toBe("done");
    expect(jobs.find((j) => j.key.includes(B))).toMatchObject({
      status: "queued",
      note: expect.stringContaining("no answer"),
    });
    const views = (await caps.getNetworks(owner())).networks;
    expect(views.find((n) => n.origin === A)?.failing_since).toBeNull();
    expect(views.find((n) => n.origin === B)?.failing_since).toBe(new Date(T0 + 3).toISOString());

    // B's job gives out long before B comes back; the hourly publisher still owes it the receipt.
    await db.client.query({
      sql: "UPDATE jobs SET status = 'dead' WHERE kind = ? AND dedupe_key LIKE ?",
      params: [NETWORK_RECEIPT_KIND, `%${B}%`],
      method: "run",
    });
    const back = fakeNetworks({ [A]: accepted, [B]: accepted });
    const later = T0 + 5 * HOUR;
    const hour = Math.floor(later / HOUR);
    await db.client.query({
      sql: "INSERT INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at) VALUES (?, ?, ?, ?, 'queued', 0, 8, ?, ?)",
      params: [
        ulid(),
        NETWORK_PUBLISH_KIND,
        JSON.stringify({ network: B, hour, link: 0 }),
        later,
        publishKey(B, hour),
        later,
      ],
      method: "run",
    });
    await drain(runnerWith(back.fetchImpl), db, later);
    expect(back.calls.map((c) => [c.network, c.body.receipt])).toEqual([[B, receipt.jws]]);
    expect((await publications(db)).every((p) => p.state === "published")).toBe(true);
    expect((await caps.getNetworks(owner())).networks.find((n) => n.origin === B)?.failing_since).toBeNull();
  });

  it("retries on the network's own state, by problem code, and records a verdict once", async () => {
    const { db } = await setup({ [A]: { enabled: true } });
    const state = async () => (await publications(db))[0];

    const unknown = fakeNetworks({ [A]: () => json(404, { code: "unknown_issuer", detail: "register first" }) });
    await runnerWith(unknown.fetchImpl).runDue(db, { now: T0 + 3 });
    expect(await state()).toMatchObject({ state: "queued", error: "HTTP 404 unknown_issuer: register first" });
    expect((await receiptJobs(db))[0]).toMatchObject({ status: "queued" });

    // A stale key on the network's side is theirs to refresh: retry, matched on `code`.
    const stale = fakeNetworks({
      [A]: () => json(422, { code: "unknown_key", detail: "no published key with kid x" }),
    });
    await dueNow(db, T0 + 4);
    await runnerWith(stale.fetchImpl).runDue(db, { now: T0 + 4 });
    expect(await state()).toMatchObject({ state: "queued", attempts: 2 });

    // A redirect is not an answer about the receipt either.
    const moved = fakeNetworks({
      [A]: () => new Response(null, { status: 308, headers: { location: "https://x.example.com" } }),
    });
    await dueNow(db, T0 + 5);
    await runnerWith(moved.fetchImpl).runDue(db, { now: T0 + 5 });
    expect(await state()).toMatchObject({ state: "queued", attempts: 3 });

    // The words "unknown_key" in a detail are not the code: this is a verdict, and it is final.
    const forged = fakeNetworks({
      [A]: () => json(422, { code: "bad_signature", detail: "unknown_key was not the problem" }),
    });
    await dueNow(db, T0 + 6);
    await runnerWith(forged.fetchImpl).runDue(db, { now: T0 + 6 });
    expect(await state()).toMatchObject({
      state: "refused",
      attempts: 4,
      error: "HTTP 422 bad_signature: unknown_key was not the problem",
    });
    expect((await receiptJobs(db))[0]).toMatchObject({
      status: "done",
      note: expect.stringMatching(/refused receipt .*: HTTP 422 bad_signature/),
    });
    // And the publisher never sends a refused receipt again.
    const again = fakeNetworks({ [A]: accepted });
    await db.client.query({
      sql: "INSERT INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at) VALUES (?, ?, ?, ?, 'queued', 0, 8, ?, ?)",
      params: [
        ulid(),
        NETWORK_PUBLISH_KIND,
        JSON.stringify({ network: A, hour: 1, link: 0 }),
        T0 + 7,
        publishKey(A, 1),
        T0 + 7,
      ],
      method: "run",
    });
    await runnerWith(again.fetchImpl).runDue(db, { now: T0 + 7 });
    expect(again.calls).toEqual([]);
  });

  it("stops calling a network that has not answered three times in a row, for a while", async () => {
    const { db, caps, itemId } = await setup({ [A]: { enabled: true } });
    // A second receipt on the same item, so there are two jobs to fail, twice each.
    await caps.receipts.issue(itemId, "paid", T0 + 2);
    const down = fakeNetworks({ [A]: () => json(503, {}) });
    await runnerWith(down.fetchImpl).runDue(db, { now: T0 + 3 });
    expect(down.calls).toHaveLength(2);
    await dueNow(db, T0 + 4);
    await runnerWith(down.fetchImpl).runDue(db, { now: T0 + 4 });
    // The third failure opened the breaker: the fourth job does not call.
    expect(down.calls).toHaveLength(3);
    expect((await receiptJobs(db)).map((j) => j.note).sort()).toEqual([
      "deferred: network.example.com is not answering; the hourly publisher will send it",
      "publish to network.example.com: HTTP 503",
    ]);
  });

  it("leaves receipts queued while a network is off, and sends them once it is back on", async () => {
    const { db, caps, receipt } = await setup({ [A]: { enabled: true } });
    await caps.updateSettings(owner(T0 + 1), { doc: { networks: { [A]: { enabled: false } } } });
    const net = fakeNetworks({ [A]: accepted });
    await drain(runnerWith(net.fetchImpl), db, T0 + 3);
    expect(net.calls).toEqual([]);
    expect((await receiptJobs(db))[0]).toMatchObject({
      status: "done",
      note: `${A} is switched off; the receipt stays queued for it`,
    });
    expect((await publications(db))[0]).toMatchObject({ state: "queued" });

    // Switching it on queues its publisher at once, and that sends what was left.
    const later = T0 + 3 * HOUR;
    await caps.updateSettings(owner(later), { doc: { networks: { [A]: { enabled: true } } } });
    await drain(runnerWith(net.fetchImpl), db, later);
    expect(net.calls.map((c) => c.body.receipt)).toEqual([receipt.jws]);
    expect((await publications(db))[0]).toMatchObject({ state: "published" });
  });

  it("backfills every receipt already issued when a network is switched on, at most the hour's share", async () => {
    const { db, caps, receipt } = await setup({});
    // Five more receipts, issued while no network was on.
    for (let i = 0; i < 5; i++) {
      const sent = await caps.sendMessage(customer(T0 + 10 + i), {
        body: `hello ${i}`,
        contact: { email: `c${i}@example.com` },
      });
      const id = "view" in sent ? sent.view.item.id : "item" in sent ? sent.item.id : "";
      const r = await caps.receipts.issue(id, "confirmed", T0 + 20 + i);
      expect(r.outcome).toBe("issued");
    }
    expect(await publications(db)).toEqual([]);
    const net = fakeNetworks({ [A]: accepted });
    const deps = { publishBatch: 2, publishPerHour: 4 };
    const on = T0 + HOUR;
    await caps.updateSettings(owner(on), { doc: { networks: { [A]: { enabled: true } } } });
    await drain(runnerWith(net.fetchImpl, deps), db, on);
    // Four this hour, oldest first, in runs of two.
    expect(net.calls.map((c) => c.body.receipt)[0]).toBe(receipt.jws);
    expect(net.calls).toHaveLength(4);
    expect((await publications(db)).filter((p) => p.state === "published")).toHaveLength(4);
    expect((await publications(db)).filter((p) => p.state === "queued")).toHaveLength(0);

    // The rest the next hour.
    const next = on + HOUR;
    const hour = Math.floor(next / HOUR);
    await db.client.query({
      sql: "INSERT INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at) VALUES (?, ?, ?, ?, 'queued', 0, 8, ?, ?)",
      params: [
        ulid(),
        NETWORK_PUBLISH_KIND,
        JSON.stringify({ network: A, hour, link: 0 }),
        next,
        publishKey(A, hour),
        next,
      ],
      method: "run",
    });
    await drain(runnerWith(net.fetchImpl, deps), db, next);
    expect(net.calls).toHaveLength(6);
    expect((await publications(db)).every((p) => p.state === "published")).toBe(true);
    expect(new Set(net.calls.map((c) => c.body.receipt)).size).toBe(6);
  });

  it("hands a job queued before there were several networks to every network that takes receipts", async () => {
    const { db, receipt } = await setup({ [A]: { enabled: true }, [B]: { enabled: true } });
    await db.client.query({ sql: "DELETE FROM jobs", params: [], method: "run" });
    await db.client.query({ sql: "DELETE FROM network_publications", params: [], method: "run" });
    await db.client.query({
      sql: "INSERT INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at) VALUES (?, ?, ?, ?, 'queued', 0, 8, ?, ?)",
      params: [
        ulid(),
        NETWORK_RECEIPT_KIND,
        JSON.stringify({ receiptId: receipt.id, stage: "issued" }),
        T0 + 3,
        `${NETWORK_RECEIPT_KIND}:${receipt.id}:issued`,
        T0 + 3,
      ],
      method: "run",
    });
    const net = fakeNetworks({ [A]: accepted, [B]: accepted });
    await drain(runnerWith(net.fetchImpl), db, T0 + 3);
    expect(net.calls.map((c) => c.network).sort()).toEqual([A, B].sort());
    expect((await publications(db)).map((p) => `${p.network} ${p.state}`)).toEqual([
      `${A} published`,
      `${B} published`,
    ]);
  });
});
