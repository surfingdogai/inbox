import { logMailOut, runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { ACK_TYP, ALG, b64u, generateKeyPair, receiptSha, verifyReceipt } from "../src/receipts/sign";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { jobs, receipts, services, signingKeys } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * Receipts end to end (ADR-016): a transition enqueues the job, the job signs, the customer
 * reads the receipt on their item, an agent counter-signs it, and the JWKS verifies all of it.
 */
const T0 = Date.parse("2026-09-22T09:00:00Z");
const KEY = "receipt-test-instance-key-0123456789";
const ISS = "https://inbox.oficinamare.pt";

const owner = (t = T0): Caller => ({
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
});
const customer = (t = T0, sandbox = false): Caller => ({
  actor: { kind: "customer_human", id: "form", channel: "form" },
  tier: "anonymous",
  sandbox,
  now: () => t,
});

async function setup(opts: { secret?: string | null; baseUrl?: string | null } = {}) {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    capacity: 1,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  const secret = opts.secret === undefined ? KEY : opts.secret;
  const baseUrl = opts.baseUrl === undefined ? ISS : opts.baseUrl;
  const caps = new Capabilities(db, secret ? createSecretBox([secret]) : null, baseUrl ?? undefined, 0);
  const runner = createRunner({ mailOut: logMailOut(), receipts: caps.receipts });
  return { db, caps, runner, svc };
}

async function book(caps: Capabilities, svc: string, email: string, sandbox = false, t = T0) {
  const r = await caps.createBooking(customer(t, sandbox), {
    payload: {
      reservationFor: { serviceId: svc, name: "Full service" },
      startTime: new Date(t + 24 * 3_600_000).toISOString(),
      endTime: new Date(t + 24 * 3_600_000 + 90 * 60_000).toISOString(),
      totalPrice: { value: 4500, currency: "EUR" },
    },
    contact: { name: "Rita Amaral", email },
  });
  return { item: r.view.item, token: r.accessToken };
}

/** An agent's counter-signature, built the way the docs tell an agent to build one. */
async function counterSign(receiptId: string, receiptJws: string, iatSec: number, typ: string | undefined = ACK_TYP) {
  const agent = await generateKeyPair();
  const header: Record<string, unknown> = { alg: ALG, jwk: agent.publicJwk };
  if (typ !== undefined) header.typ = typ;
  const enc = new TextEncoder();
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

async function jobNotes(db: Db, kind: string) {
  const rows = await db.orm.select({ kind: jobs.kind, status: jobs.status, lastError: jobs.lastError }).from(jobs);
  return rows.filter((r) => r.kind === kind);
}

describe("a confirmed booking", () => {
  it("earns a receipt the customer can read and the JWKS verifies", async () => {
    const { db, caps, runner, svc } = await setup();
    const v = await book(caps, svc, "rita@example.com");
    // Nothing yet: a request is not a transaction.
    expect((await caps.getItemStatus(customer(), { item_id: v.item.id, access_token: v.token })).receipts).toEqual([]);

    await caps.transitionItem(owner(T0 + 60_000), { item_id: v.item.id, event: "confirm" });
    const run = await runner.runDue(db, { now: T0 + 61_000 });
    expect(run.failed + run.dead).toBe(0);
    // The runner keeps a done job's note in `last_error`; for a receipt it names what was issued.
    expect(await jobNotes(db, "issue_receipt")).toEqual([
      { kind: "issue_receipt", status: "done", lastError: expect.stringMatching(/^issued confirmed receipt /) },
    ]);

    const status = await caps.getItemStatus(customer(), { item_id: v.item.id, access_token: v.token });
    expect(status.receipts).toHaveLength(1);
    const rcp = status.receipts?.[0];
    if (!rcp) throw new Error("no receipt");
    expect(rcp.kind).toBe("confirmed");
    expect(rcp.acknowledged_at).toBeNull();
    expect(rcp.issued_at).toBe(new Date(T0 + 61_000).toISOString());

    // Verifiable against what the instance publishes, and it says what it should.
    const { keys } = await caps.receipts.jwks();
    expect(keys).toHaveLength(1);
    const claims = await verifyReceipt(rcp.jws, keys);
    // A customer's booking carries claims v2 (ADR-017 §3.2): dated by the confirmation itself,
    // due at the start and ending at the end.
    expect(claims).toMatchObject({
      iss: ISS,
      itm: v.item.id,
      typ: "booking",
      knd: "confirmed",
      iat: Math.floor((T0 + 60_000) / 1000),
      amt: { value: 4500, currency: "EUR" },
      ver: 2,
      due: Math.floor((T0 + 24 * 3_600_000) / 1000),
      end: Math.floor((T0 + 24 * 3_600_000 + 90 * 60_000) / 1000),
    });
    expect(rcp.outcome).toBeNull();
    expect(claims.sub).not.toContain("rita");
    expect(claims.pay).toBeUndefined();
    // The manifest field and the JWKS are the same keys.
    expect(keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", kid: rcp.payload ? expect.any(String) : undefined });
    expect(Object.keys(keys[0] ?? {})).not.toContain("d");

    // The owner sees it on the item too.
    const detail = await caps.getItem(owner(), { item_id: v.item.id });
    expect(detail.receipts?.map((r) => r.id)).toEqual([rcp.id]);
  });

  it("is issued exactly once, however many times the job runs", async () => {
    const { db, caps, runner, svc } = await setup();
    const v = await book(caps, svc, "rita@example.com");
    await caps.transitionItem(owner(T0 + 1), { item_id: v.item.id, event: "confirm" });
    await runner.runDue(db, { now: T0 + 2 });
    const again = await caps.receipts.issue(v.item.id, "confirmed", T0 + 3);
    expect(again.outcome).toBe("already");
    expect(await db.orm.select({ id: receipts.id }).from(receipts)).toHaveLength(1);
  });

  it("gives one customer one subject across their items, and different customers different ones", async () => {
    const { db, caps, runner, svc } = await setup();
    const a1 = await book(caps, svc, "rita@example.com", false, T0);
    const a2 = await book(caps, svc, "Rita@Example.com ", false, T0 + 3 * 3_600_000);
    const b = await book(caps, svc, "rui@example.com", false, T0 + 6 * 3_600_000);
    for (const v of [a1, a2, b]) await caps.transitionItem(owner(T0 + 10), { item_id: v.item.id, event: "confirm" });
    await runner.runDue(db, { now: T0 + 11 });
    const subs = new Map<string, string>();
    for (const v of [a1, a2, b]) {
      const [r] = await caps.receipts.forItem(v.item.id);
      subs.set(v.item.id, r?.payload.sub ?? "");
    }
    expect(subs.get(a1.item.id)).toBe(subs.get(a2.item.id));
    expect(subs.get(a1.item.id)).not.toBe(subs.get(b.item.id));
    expect(subs.get(a1.item.id)).toHaveLength(43);
  });

  it("gets nothing when it is a sandbox item, and the job says so", async () => {
    const { db, caps, runner, svc } = await setup();
    const v = await book(caps, svc, "rita@example.com", true);
    await caps.transitionItem({ ...owner(T0 + 1), sandbox: true }, { item_id: v.item.id, event: "confirm" });
    await runner.runDue(db, { now: T0 + 2 });
    expect(await caps.receipts.forItem(v.item.id)).toEqual([]);
    expect((await jobNotes(db, "issue_receipt"))[0]?.status).toBe("done");
    expect(await db.orm.select({ kid: signingKeys.kid }).from(signingKeys)).toHaveLength(0);
  });
});

describe("a paid order", () => {
  it("earns a paid receipt carrying the amount actually paid and how", async () => {
    const { db, caps, runner } = await setup();
    const created = await caps.createOrder(customer(), {
      payload: {
        orderedItem: [{ name: "Chain", quantity: 2, price: { value: 1500, currency: "EUR" } }],
        totalPrice: { value: 3000, currency: "EUR" },
        paymentMethod: "card",
      },
      contact: { email: "rita@example.com" },
    });
    const id = created.view.item.id;
    await caps.transitionItem(owner(T0 + 1), { item_id: id, event: "accept" });
    await caps.transitionItem(owner(T0 + 2), {
      item_id: id,
      event: "record_payment",
      input: { paymentRef: "pi_123", amount: { value: 2990, currency: "EUR" } },
    });
    const run = await runner.runDue(db, { now: T0 + 3 });
    expect(run.failed + run.dead).toBe(0);
    // Accepting it was the promise (ADR-017 §3.1); the payment is a second one, due when the first is.
    const [accepted, rcp] = await caps.receipts.forItem(id);
    expect(accepted?.kind).toBe("accepted");
    expect(rcp?.kind).toBe("paid");
    const { keys } = await caps.receipts.jwks();
    const claims = await verifyReceipt(rcp?.jws ?? "", keys);
    expect(claims).toMatchObject({ typ: "order", knd: "paid", amt: { value: 2990, currency: "EUR" }, pay: "card" });
    expect(claims).toMatchObject({ ver: 2, due: Math.floor((T0 + 1) / 1000) + 30 * 86_400 });
    expect(accepted?.payload).toMatchObject({ ver: 2, knd: "accepted", amt: { value: 3000, currency: "EUR" } });
  });
});

describe("an instance that cannot sign", () => {
  it("issues nothing without INBOX_SECRET_KEY, records why, and does not retry", async () => {
    const { db, caps, runner, svc } = await setup({ secret: null });
    const v = await book(caps, svc, "rita@example.com");
    await caps.transitionItem(owner(T0 + 1), { item_id: v.item.id, event: "confirm" });
    const run = await runner.runDue(db, { now: T0 + 2 });
    expect(run.failed + run.dead).toBe(0);
    expect(await caps.receipts.forItem(v.item.id)).toEqual([]);
    expect(caps.receipts.readiness()).toMatchObject({ ok: false, reason: expect.stringContaining("INBOX_SECRET_KEY") });
    expect((await caps.receipts.jwks()).keys).toEqual([]);
  });

  it("issues nothing without INBOX_PUBLIC_URL either", async () => {
    const { db, caps, runner, svc } = await setup({ baseUrl: null });
    const v = await book(caps, svc, "rita@example.com");
    await caps.transitionItem(owner(T0 + 1), { item_id: v.item.id, event: "confirm" });
    await runner.runDue(db, { now: T0 + 2 });
    expect(await caps.receipts.forItem(v.item.id)).toEqual([]);
    expect(caps.receipts.readiness()).toMatchObject({ ok: false, reason: expect.stringContaining("INBOX_PUBLIC_URL") });
  });
});

describe("the acknowledgement", () => {
  async function issued() {
    const s = await setup();
    const v = await book(s.caps, s.svc, "rita@example.com");
    await s.caps.transitionItem(owner(T0 + 1), { item_id: v.item.id, event: "confirm" });
    await s.runner.runDue(s.db, { now: T0 + 2 });
    const [rcp] = await s.caps.receipts.forItem(v.item.id);
    if (!rcp) throw new Error("no receipt");
    return { ...s, v, rcp };
  }

  it("is kept when the agent signs the right receipt with the key it carries", async () => {
    const { caps, v, rcp } = await issued();
    const now = T0 + 120_000;
    const ack = await counterSign(rcp.id, rcp.jws, Math.floor(now / 1000));
    const out = await caps.acknowledgeReceipt(customer(now), {
      item_id: v.item.id,
      counter_signature: ack,
      receipt: rcp.jws,
      access_token: v.token,
    });
    expect(out.id).toBe(rcp.id);
    expect(out.acknowledged_at).toBe(new Date(now).toISOString());
    const status = await caps.getItemStatus(customer(now), { item_id: v.item.id, access_token: v.token });
    expect(status.receipts?.[0]?.acknowledged_at).toBe(new Date(now).toISOString());

    // A second acknowledgement keeps the first.
    const later = await counterSign(rcp.id, rcp.jws, Math.floor(now / 1000) + 10);
    const again = await caps.acknowledgeReceipt(customer(now + 10_000), {
      item_id: v.item.id,
      counter_signature: later,
      access_token: v.token,
    });
    expect(again.acknowledged_at).toBe(new Date(now).toISOString());
  });

  it("is refused when it names another item's receipt, is stale, or is not the caller's item", async () => {
    const s = await issued();
    const other = await book(s.caps, s.svc, "rui@example.com", false, T0 + 3 * 3_600_000);
    await s.caps.transitionItem(owner(T0 + 5), { item_id: other.item.id, event: "confirm" });
    await s.runner.runDue(s.db, { now: T0 + 6 });
    const [otherRcp] = await s.caps.receipts.forItem(other.item.id);
    const now = T0 + 120_000;

    // Right key, wrong item: the receipt is not on the item being acknowledged.
    await expect(
      s.caps.acknowledgeReceipt(customer(now), {
        item_id: s.v.item.id,
        counter_signature: await counterSign(otherRcp?.id ?? "x", otherRcp?.jws ?? "x.y.z", Math.floor(now / 1000)),
        access_token: s.v.token,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    // Stale.
    await expect(
      s.caps.acknowledgeReceipt(customer(now), {
        item_id: s.v.item.id,
        counter_signature: await counterSign(s.rcp.id, s.rcp.jws, Math.floor(now / 1000) - 7200),
        access_token: s.v.token,
      }),
    ).rejects.toMatchObject({ code: "invalid_input", details: { reason: "expired" } });

    // Not a JWS at all.
    await expect(
      s.caps.acknowledgeReceipt(customer(now), {
        item_id: s.v.item.id,
        counter_signature: "nope",
        access_token: s.v.token,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    // The wrong `receipt` echoed back.
    await expect(
      s.caps.acknowledgeReceipt(customer(now), {
        item_id: s.v.item.id,
        counter_signature: await counterSign(s.rcp.id, s.rcp.jws, Math.floor(now / 1000)),
        receipt: otherRcp?.jws,
        access_token: s.v.token,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    // Someone else's item: no token, no party.
    await expect(
      s.caps.acknowledgeReceipt(customer(now), {
        item_id: s.v.item.id,
        counter_signature: await counterSign(s.rcp.id, s.rcp.jws, Math.floor(now / 1000)),
      }),
    ).rejects.toMatchObject({ code: "not_allowed" });

    // Nothing was kept.
    expect((await s.caps.receipts.forItem(s.v.item.id))[0]?.acknowledged_at).toBeNull();
  });
});

describe("the signing key", () => {
  it("is sealed at rest and named by its own thumbprint", async () => {
    const { db, caps } = await setup();
    const key = await caps.receipts.keys.active();
    const [row] = await db.orm.select().from(signingKeys);
    expect(row?.kid).toBe(key.kid);
    expect(row?.privateJwkEnc.startsWith("v1.")).toBe(true);
    expect(row?.privateJwkEnc).not.toContain(key.privateJwk.d);
    expect(JSON.stringify(row?.publicJwk)).not.toContain('"d"');
    // The same key comes back, not a new one.
    expect((await caps.receipts.keys.active()).kid).toBe(key.kid);
    const fresh = new Capabilities(db, createSecretBox([KEY]), ISS);
    expect((await fresh.receipts.keys.active()).kid).toBe(key.kid);
  });

  it("cannot be opened under a different INBOX_SECRET_KEY", async () => {
    const { db, caps } = await setup();
    await caps.receipts.keys.active();
    const wrong = new Capabilities(db, createSecretBox(["not-the-key-at-all-0123456789"]), ISS);
    await expect(wrong.receipts.keys.active()).rejects.toThrow(/could not open/);
  });
});

describe("as developer events", () => {
  it("shows up in the event stream and fans out to webhooks, issued and acknowledged", async () => {
    const { db, caps, runner, svc } = await setup();
    // An endpoint that listens to everything: this is what makes the fanout row worth writing.
    await caps.webhooks.createWebhook(owner(), {
      url: "https://hooks.example.com/inbox",
      events: ["*"],
      payload_style: "thin",
    });
    const v = await book(caps, svc, "rita@example.com");
    await caps.transitionItem(owner(T0 + 1), { item_id: v.item.id, event: "confirm" });
    await runner.runDue(db, { now: T0 + 2 });
    const [rcp] = await caps.receipts.forItem(v.item.id);
    if (!rcp) throw new Error("no receipt");

    const issued = await caps.webhooks.listEvents(owner(T0 + 3), { limit: 50, types: ["booking.receipt_issued"] });
    expect(issued.events.map((e) => [e.id, e.type, e.data.id])).toEqual([
      [rcp.id, "booking.receipt_issued", v.item.id],
    ]);

    const now = T0 + 60_000;
    await caps.acknowledgeReceipt(customer(now), {
      item_id: v.item.id,
      counter_signature: await counterSign(rcp.id, rcp.jws, Math.floor(now / 1000)),
      access_token: v.token,
    });
    // A pattern's `*` stands for a whole segment, so the two are named in full.
    const acked = await caps.webhooks.listEvents(owner(now + 1), {
      limit: 50,
      types: ["booking.receipt_issued", "booking.receipt_acknowledged"],
    });
    expect(acked.events.map((e) => [e.id, e.type])).toEqual([
      [rcp.id, "booking.receipt_issued"],
      [`${rcp.id}:ack`, "booking.receipt_acknowledged"],
    ]);

    // Both were handed to the webhook fanout, once each, under the event's own id.
    const fanouts = await db.orm.select({ kind: jobs.kind, dedupeKey: jobs.dedupeKey }).from(jobs);
    const keys = fanouts.filter((j) => j.kind === "webhook_fanout").map((j) => j.dedupeKey);
    expect(keys).toContain(`fanout:${rcp.id}`);
    expect(keys).toContain(`fanout:${rcp.id}:ack`);
  });

  it("writes no fanout row when nobody is listening", async () => {
    const { db, caps, runner, svc } = await setup();
    const v = await book(caps, svc, "rita@example.com");
    await caps.transitionItem(owner(T0 + 1), { item_id: v.item.id, event: "confirm" });
    await runner.runDue(db, { now: T0 + 2 });
    const kinds = (await db.orm.select({ kind: jobs.kind }).from(jobs)).map((j) => j.kind);
    expect(kinds).not.toContain("webhook_fanout");
    expect(await caps.receipts.forItem(v.item.id)).toHaveLength(1);
  });
});
