import {
  ACK_TYP,
  ALG,
  b64u,
  Capabilities,
  createSecretBox,
  generateKeyPair,
  JobRunner,
  NETWORK_RECEIPT_KIND,
  receiptSha,
  schema,
  ulid,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { networkReceiptHandler } from "../src/network";
import { freshDb } from "./db";

/**
 * Publishing receipts to the joined network (ADR-016): enqueued in the same batch as the receipt
 * when the owner has joined, posted as `{receipt, ack?}`, and retried or recorded according to
 * what the network answered. The network itself is a fake here; its real verification is covered
 * on its own side against the same vectors.
 */
const T0 = Date.parse("2026-09-22T09:00:00Z");
const KEY = "publish-test-instance-key-0123456789";
const ISS = "https://inbox.example.com";
const NETWORK = "https://network.example.com";

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

function fakeNetwork(reply: (body: Body) => Response) {
  const calls: { url: string; body: Body }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    calls.push({ url: String(input), body });
    return reply(body);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A runner that knows the receipt job and lets the booking's other jobs pass through quietly. */
function runnerWith(fetchImpl: typeof fetch): JobRunner {
  const runner = new JobRunner().register(NETWORK_RECEIPT_KIND, networkReceiptHandler({ version: "0.0.0", fetchImpl }));
  for (const kind of ["notify", "rules", "issue_receipt", "webhook_fanout", "network_ping"]) {
    runner.register(kind, async () => undefined);
  }
  return runner;
}

async function setup(join: boolean) {
  const { db } = await freshDb();
  const caps = new Capabilities(db, createSecretBox([KEY]), ISS, 0);
  await caps.updateSettings(owner(), { doc: { network: { url: NETWORK, join } } });
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

type Db = Awaited<ReturnType<typeof freshDb>>["db"];

const jobsOf = async (db: Db) =>
  (
    await db.client.query({
      sql: "SELECT dedupe_key, status, last_error FROM jobs WHERE kind = ? ORDER BY created_at, id",
      params: [NETWORK_RECEIPT_KIND],
      method: "all",
    })
  ).rows.map((r) => ({ key: String(r[0]), status: String(r[1]), note: r[2] === null ? null : String(r[2]) }));

const dueNow = (db: Db) =>
  db.client.query({
    sql: "UPDATE jobs SET run_at = ? WHERE kind = ?",
    params: [T0, NETWORK_RECEIPT_KIND],
    method: "run",
  });

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

describe("publishing receipts to the network", () => {
  it("enqueues nothing while the owner has not joined", async () => {
    const { db } = await setup(false);
    expect(await jobsOf(db)).toEqual([]);
  });

  it("posts the receipt once issued and again with the acknowledgement", async () => {
    const { db, caps, itemId, token, receipt } = await setup(true);
    expect(await jobsOf(db)).toMatchObject([{ key: `${NETWORK_RECEIPT_KIND}:${receipt.id}:issued`, status: "queued" }]);

    const net = fakeNetwork((body) =>
      json(body.ack ? 200 : 201, { ok: true, state: body.ack ? "acknowledged" : "issued", duplicate: false }),
    );
    const runner = runnerWith(net.fetchImpl);
    await runner.runDue(db, { now: T0 + 3 });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]).toMatchObject({ url: `${NETWORK}/v1/receipts`, body: { receipt: receipt.jws } });
    expect(net.calls[0]?.body.ack).toBeUndefined();
    expect((await jobsOf(db))[0]).toMatchObject({
      status: "done",
      note: expect.stringMatching(/^published issued receipt/),
    });

    const now = T0 + 60_000;
    await caps.acknowledgeReceipt(customer(now), {
      item_id: itemId,
      counter_signature: await counterSign(receipt.id, receipt.jws, Math.floor(now / 1000)),
      ...(token ? { access_token: token } : {}),
    });
    expect((await jobsOf(db)).map((j) => j.key)).toEqual([
      `${NETWORK_RECEIPT_KIND}:${receipt.id}:issued`,
      `${NETWORK_RECEIPT_KIND}:${receipt.id}:acknowledged`,
    ]);
    await runner.runDue(db, { now: now + 1 });
    expect(net.calls).toHaveLength(2);
    expect(net.calls[1]?.body.receipt).toBe(receipt.jws);
    expect(net.calls[1]?.body.ack).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // Nothing about Rita in either body.
    for (const c of net.calls) expect(JSON.stringify(c.body)).not.toMatch(/rita/i);
  });

  it("retries when the network does not know us yet, and records a refusal once", async () => {
    const { db, receipt } = await setup(true);
    const unknown = fakeNetwork(() => json(404, { code: "unknown_issuer", detail: "register first" }));
    await runnerWith(unknown.fetchImpl).runDue(db, { now: T0 + 3 });
    expect(unknown.calls).toHaveLength(1);
    expect((await jobsOf(db))[0]).toMatchObject({ status: "queued", note: expect.stringContaining("HTTP 404") });

    // A stale key on the network's side is theirs to refresh: retry too.
    const stale = fakeNetwork(() => json(422, { code: "unknown_key", detail: "no published key with kid x" }));
    await dueNow(db);
    await runnerWith(stale.fetchImpl).runDue(db, { now: T0 + 4 });
    expect(stale.calls).toHaveLength(1);
    expect((await jobsOf(db))[0]).toMatchObject({ status: "queued", note: expect.stringContaining("unknown_key") });

    // A verdict on the receipt itself is final.
    const forged = fakeNetwork(() => json(422, { code: "bad_signature", detail: "the signature does not match" }));
    await dueNow(db);
    await runnerWith(forged.fetchImpl).runDue(db, { now: T0 + 5 });
    expect((await jobsOf(db))[0]).toMatchObject({
      status: "done",
      note: expect.stringMatching(/refused receipt .* HTTP 422/),
    });
    expect(forged.calls[0]?.body.receipt).toBe(receipt.jws);
  });

  it("does nothing once the owner has left the network", async () => {
    const { db, caps } = await setup(true);
    await caps.updateSettings(owner(T0 + 1), { doc: { network: { url: NETWORK, join: false } } });
    const net = fakeNetwork(() => json(201, { ok: true, state: "issued", duplicate: false }));
    await runnerWith(net.fetchImpl).runDue(db, { now: T0 + 3 });
    expect(net.calls).toEqual([]);
    expect((await jobsOf(db))[0]).toMatchObject({ status: "done", note: "not joined; nothing published" });
  });
});
