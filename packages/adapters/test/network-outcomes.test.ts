import {
  ACK_TYP,
  ALG,
  b64u,
  Capabilities,
  createRunner,
  createSecretBox,
  generateKeyPair,
  type JobRunner,
  NETWORK_PING_KIND,
  NETWORK_PUBLISH_KIND,
  NETWORK_RECEIPT_KIND,
  networkLane,
  pingDedupeKey,
  publishKey,
  type ReceiptView,
  receiptSha,
  schema,
  ulid,
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { networkPingHandler, networkPublishHandler, networkReceiptHandler } from "../src/network";
import { freshDb } from "./db";

/**
 * Outcomes on their way to the networks (ADR-017 §2.5, §3.2): claims v2 go only to a network whose
 * `/v1/ranking` is version 3 or later, in force or announced; one on older rules gets v1 promises
 * and its acceptances and outcomes wait for it; an outcome goes after its promise and is retried on
 * `unknown_ref`; with receipts switched off, a network still gets the outcomes of promises it holds.
 */
const T0 = Date.parse("2026-09-22T09:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEY = "outcomes-publish-instance-key-0123456789";
const ISS = "https://inbox.example.com";
const A = "https://network.example.com";
const B = "https://older.example.net";

const owner = (t: number) => ({
  actor: { kind: "owner" as const, id: "u1", channel: "owner_ui" as const },
  tier: "verified_principal" as const,
  sandbox: false,
  now: () => t,
});
const customer = (t: number) => ({
  actor: { kind: "customer_human" as const, id: "form", channel: "form" as const },
  tier: "anonymous" as const,
  sandbox: false,
  now: () => t,
});

type Body = { receipt: string; ack?: string };
type Claims = { knd: string; out?: string; itm: string; nonce: string };
const claimsOf = (jws: string) =>
  JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob((jws.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
    ),
  ) as Claims;

/** Rules as `/v1/ranking` reports them: the live network's on 23 September 2026 by default. */
const ranking = (version: number, next: number | null) => ({
  version,
  status: "in_force",
  next: next
    ? { version: next, effective_at: "2026-10-09T00:00:00Z", url: "https://x.example/v1/ranking?version=3" }
    : null,
});

/** Fake networks: each has its rules and answers receipts with `reply`, by default taking them. */
function fakeNetworks(opts: {
  rules: Record<string, unknown>;
  reply?: Record<string, (body: Body, n: number) => Response | undefined>;
}) {
  const calls: { network: string; path: string; body: Body | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : null;
    calls.push({ network: url.origin, path: url.pathname, body });
    if (url.pathname === "/v1/ranking") return Response.json(opts.rules[url.origin] ?? {});
    if (url.pathname === "/v1/receipts" && body) {
      const n = calls.filter((c) => c.network === url.origin && c.path === "/v1/receipts").length;
      const custom = opts.reply?.[url.origin]?.(body, n);
      if (custom) return custom;
      return Response.json(
        { ok: true, state: body.ack ? "acknowledged" : "issued", duplicate: false },
        { status: 201 },
      );
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const posted = (network: string) =>
    calls
      .filter((c) => c.network === network && c.path === "/v1/receipts" && c.body)
      .map((c) => {
        const k = claimsOf(c.body?.receipt ?? "");
        return k.out ?? k.knd;
      });
  return { calls, fetchImpl, posted, rules: opts.rules };
}

async function setup(networks: Record<string, unknown>, fetchImpl: typeof fetch) {
  const { db } = await freshDb();
  const caps = new Capabilities(db, createSecretBox([KEY]), ISS, 0);
  await caps.updateSettings(owner(T0), { doc: { networks } });
  await db.client.query({ sql: "DELETE FROM jobs", params: [], method: "run" });
  const svc = ulid();
  await db.orm.insert(schema.services).values({
    id: svc,
    name: "Surf lesson",
    durationMin: 90,
    capacity: 5,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  const deps = { version: "0.0.0", fetchImpl, timeoutMs: 200 };
  const runner: JobRunner = createRunner({ mailOut: logMailOut(), receipts: caps.receipts })
    .register(NETWORK_RECEIPT_KIND, networkReceiptHandler(deps), { lane: networkLane })
    .register(NETWORK_PUBLISH_KIND, networkPublishHandler(deps), { lane: networkLane })
    .register(NETWORK_PING_KIND, networkPingHandler(deps))
    .register("network_ping_one", async () => undefined)
    .register("webhook_fanout", async () => undefined);
  const drain = async (t: number) => {
    for (let i = 0; i < 30; i++) if ((await runner.runDue(db, { now: t, limit: 100 })).claimed === 0) return;
  };
  const book = async (at: number) => {
    const r = await caps.createBooking(customer(at), {
      payload: {
        reservationFor: { serviceId: svc, name: "Surf lesson" },
        startTime: new Date(at + DAY).toISOString(),
        endTime: new Date(at + DAY + 90 * MIN).toISOString(),
      },
      contact: { email: "rita@example.com" },
    });
    return { id: r.view.item.id, token: r.accessToken, end: at + DAY + 90 * MIN };
  };
  const fire = (t: number, itemId: string, event: string) => caps.transitionItem(owner(t), { item_id: itemId, event });
  return { db, caps, drain, book, fire };
}

const publications = async (db: Awaited<ReturnType<typeof freshDb>>["db"], network: string) =>
  (
    await db.client.query({
      sql: `SELECT r.kind, r.outcome, p.stage, p.state, p.attempts FROM network_publications p JOIN receipts r ON r.id = p.receipt_id
             WHERE p.network = ? ORDER BY r.kind = 'outcome', r.id, p.stage`,
      params: [network],
      method: "all",
    })
  ).rows.map((r) => ({
    receipt: String(r[1]) || String(r[0]),
    stage: String(r[2]),
    state: String(r[3]),
    attempts: Number(r[4]),
  }));

describe("outcomes to the networks", () => {
  it("go to a network on rules 3, in force or announced; one on older rules gets promises and waits", async () => {
    const net = fakeNetworks({ rules: { [A]: ranking(2, 3), [B]: ranking(2, null) } });
    const s = await setup({ [A]: { enabled: true }, [B]: { enabled: true } }, net.fetchImpl);
    const b = await s.book(T0);
    await s.fire(T0 + MIN, b.id, "confirm");
    await s.fire(b.end + MIN, b.id, "complete");
    await s.drain(b.end + 2 * MIN);

    expect(net.posted(A)).toEqual(["confirmed", "booking.completed"]);
    expect(net.posted(B)).toEqual(["confirmed"]);
    expect(await publications(s.db, B)).toEqual([
      { receipt: "confirmed", stage: "issued", state: "published", attempts: 1 },
      { receipt: "booking.completed", stage: "issued", state: "queued", attempts: 0 },
    ]);
    const views = (await s.caps.getNetworks(owner(b.end))).networks;
    expect(views.find((n) => n.origin === A)?.rules).toMatchObject({ version: 2, next: 3, v2: true });
    expect(views.find((n) => n.origin === B)).toMatchObject({
      rules: { version: 2, next: null, v2: false },
      receipts: { published: 1, queued: 1, refused: 0, held: 1 },
    });
    // The rules were read once each, not once per receipt.
    expect(
      net.calls
        .filter((c) => c.path === "/v1/ranking")
        .map((c) => c.network)
        .sort(),
    ).toEqual([A, B].sort());

    // A day later B announces version 3: its next publisher reads that and sends what waited.
    net.rules[B] = ranking(2, 3);
    const later = b.end + DAY + HOUR;
    const hour = Math.floor(later / HOUR);
    await s.db.client.query({
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
    await s.drain(later);
    expect(net.posted(B)).toEqual(["confirmed", "booking.completed"]);
    expect((await s.caps.getNetworks(owner(later))).networks.find((n) => n.origin === B)?.receipts.held).toBe(0);
  });

  it("goes after its promise, and is retried when the network does not know the promise yet", async () => {
    const net = fakeNetworks({
      rules: { [A]: ranking(3, null) },
      reply: {
        // The first post of the promise meets an outage; the first post of the outcome, a network
        // that has not stored the promise yet.
        [A]: (body, n) => {
          const k = claimsOf(body.receipt);
          if (n === 1) return new Response(null, { status: 503 });
          if (k.knd === "outcome" && net.posted(A).filter((x) => x === "booking.completed").length === 1) {
            return Response.json(
              { type: "about:blank", title: "unknown ref", status: 422, code: "unknown_ref" },
              { status: 422 },
            );
          }
          return undefined;
        },
      },
    });
    const s = await setup({ [A]: { enabled: true } }, net.fetchImpl);
    const b = await s.book(T0);
    await s.fire(T0 + MIN, b.id, "confirm");
    await s.drain(T0 + MIN);
    expect(await publications(s.db, A)).toEqual([
      { receipt: "confirmed", stage: "issued", state: "queued", attempts: 1 },
    ]);
    // Its job gives up; only the row says the network is owed the promise.
    await s.db.client.query({
      sql: "UPDATE jobs SET status = 'dead' WHERE kind = ?",
      params: [NETWORK_RECEIPT_KIND],
      method: "run",
    });

    // The outage is over by the time the booking completes: the promise goes first, then its outcome.
    await s.fire(b.end + MIN, b.id, "complete");
    await s.drain(b.end + 2 * MIN);
    expect(net.posted(A)).toEqual(["confirmed", "confirmed", "booking.completed"]);
    expect(await publications(s.db, A)).toEqual([
      { receipt: "confirmed", stage: "issued", state: "published", attempts: 2 },
      { receipt: "booking.completed", stage: "issued", state: "queued", attempts: 1 },
    ]);
    // unknown_ref is the network's state, not a verdict: the next try goes through.
    await s.db.client.query({
      sql: "UPDATE jobs SET run_at = ? WHERE status = 'queued'",
      params: [b.end + HOUR],
      method: "run",
    });
    await s.drain(b.end + HOUR);
    expect(net.posted(A)).toEqual(["confirmed", "confirmed", "booking.completed", "booking.completed"]);
    expect((await publications(s.db, A)).every((p) => p.state === "published")).toBe(true);
  });

  it("still reach a network that stopped taking receipts, for the promises it holds, and nothing else", async () => {
    const net = fakeNetworks({ rules: { [A]: ranking(3, null) } });
    const s = await setup({ [A]: { enabled: true } }, net.fetchImpl);
    const held = await s.book(T0);
    await s.fire(T0 + MIN, held.id, "confirm");
    await s.drain(T0 + MIN);
    await s.caps.updateSettings(owner(T0 + HOUR), { doc: { networks: { [A]: { share: { receipts: false } } } } });
    const unsent = await s.book(T0 + HOUR);
    await s.fire(T0 + HOUR + MIN, unsent.id, "confirm");
    for (const b of [held, unsent]) await s.fire(b.end + MIN, b.id, "complete");
    await s.drain(unsent.end + 2 * MIN);

    expect(net.posted(A)).toEqual(["confirmed", "booking.completed"]);
    const sent = net.calls.filter((c) => c.path === "/v1/receipts").map((c) => claimsOf(c.body?.receipt ?? "").itm);
    expect(new Set(sent)).toEqual(new Set([held.id]));

    // The hourly tick queues its publisher only while it is owed something.
    const tick = unsent.end + HOUR;
    await s.db.client.query({
      sql: "INSERT OR IGNORE INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at) VALUES (?, ?, '{}', ?, 'queued', 0, 8, ?, ?)",
      params: [ulid(), NETWORK_PING_KIND, tick, pingDedupeKey(tick), tick],
      method: "run",
    });
    await s.drain(tick);
    const { rows } = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM jobs WHERE kind = ? AND created_at >= ?",
      params: [NETWORK_PUBLISH_KIND, tick],
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBe(0);
  });

  it("carry an acknowledgement as the agent signed it, pass reference included", async () => {
    const net = fakeNetworks({ rules: { [A]: ranking(3, null) } });
    const s = await setup({ [A]: { enabled: true } }, net.fetchImpl);
    const b = await s.book(T0);
    await s.fire(T0 + MIN, b.id, "confirm");
    await s.fire(b.end + MIN, b.id, "complete");
    await s.drain(b.end + MIN);
    const outcome = (await s.caps.receipts.forItem(b.id)).find((r) => r.kind === "outcome") as ReceiptView;
    const now = b.end + 10 * MIN;
    const ack = await counterSign(outcome, Math.floor(now / 1000), "sdpass1_network.example.com_abcdefghijklmnop");
    await s.caps.acknowledgeReceipt(customer(now), {
      item_id: b.id,
      counter_signature: ack,
      access_token: b.token as string,
    });
    await s.drain(now);
    const last = net.calls.filter((c) => c.path === "/v1/receipts").at(-1);
    expect(last?.body).toEqual({ receipt: outcome.jws, ack });
    expect(claimsOf(ack)).toMatchObject({ pas: "sdpass1_network.example.com_abcdefghijklmnop" });
  });
});

async function counterSign(receipt: ReceiptView, iat: number, pas: string) {
  const agent = await generateKeyPair();
  const enc = new TextEncoder();
  const header = { alg: ALG, typ: ACK_TYP, jwk: agent.publicJwk };
  const body = { rcp: receipt.id, sha: await receiptSha(receipt.jws), iat, pas };
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
