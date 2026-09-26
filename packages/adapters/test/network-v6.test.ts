import {
  Capabilities,
  createRunner,
  createSecretBox,
  type JobRunner,
  NETWORK_PING_KIND,
  NETWORK_PUBLISH_KIND,
  NETWORK_RECEIPT_KIND,
  networkLane,
  publishKey,
  schema,
  ulid,
  WriteError,
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { networkPingHandler, networkPublishHandler, networkReceiptHandler } from "../src/network";
import { freshDb } from "./db";

/**
 * Rules version 6 on its way to the networks (ADR-017 Amendment 3): an `amended` receipt and a
 * refund's receipts go only to a network whose `/v1/ranking` is version 6 or later, in force or
 * announced, and wait for any other; a promise that moved goes only where version 6 is in force,
 * after its promise and with its change; the outcome after a change names the new dates.
 */
const T0 = Date.parse("2026-09-22T09:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEY = "v6-publish-instance-key-0123456789ab";
const ISS = "https://inbox.example.com";
const A = "https://network.example.com";
const B = "https://older.example.net";

const owner = (t: number) => ({
  actor: { kind: "owner" as const, id: "u1", channel: "owner_ui" as const },
  tier: "verified_principal" as const,
  sandbox: false,
  now: () => t,
});
const shop = (t: number) => ({
  actor: { kind: "connector" as const, id: "shop", channel: "connector" as const },
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
const agent = (t: number, accessToken: string) => ({
  actor: { kind: "customer_agent" as const, id: "agent:rita", channel: "rest" as const },
  tier: "anonymous" as const,
  sandbox: false,
  now: () => t,
  accessToken,
});

type Body = { receipt: string; ack?: string };
type Claims = { knd: string; typ: string; out?: string; itm: string; nonce: string; due: number; ref?: string };
const claimsOf = (jws: string) =>
  JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob((jws.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
    ),
  ) as Claims;

const ranking = (version: number, next: number | null) => ({
  version,
  status: "in_force",
  next: next
    ? { version: next, effective_at: "2026-10-12T00:00:00Z", url: "https://x.example/v1/ranking?version=6" }
    : null,
});

function fakeNetworks(rules: Record<string, unknown>) {
  const calls: { network: string; path: string; body: Body | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : null;
    calls.push({ network: url.origin, path: url.pathname, body });
    if (url.pathname === "/v1/ranking") return Response.json(rules[url.origin] ?? {});
    if (url.pathname === "/v1/receipts" && body) {
      return Response.json(
        { ok: true, state: body.ack ? "acknowledged" : "issued", duplicate: false },
        { status: 201 },
      );
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  /** What each network was sent, in order: the outcome code, else `<typ> <knd>`. */
  const posted = (network: string) =>
    calls
      .filter((c) => c.network === network && c.path === "/v1/receipts" && c.body)
      .map((c) => {
        const k = claimsOf(c.body?.receipt ?? "");
        return k.out ?? `${k.typ} ${k.knd}`;
      });
  const claims = (network: string) =>
    calls
      .filter((c) => c.network === network && c.path === "/v1/receipts" && c.body)
      .map((c) => claimsOf(c.body?.receipt ?? ""));
  return { calls, fetchImpl, posted, claims, rules };
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
  const chain = ulid();
  await db.orm.insert(schema.products).values({
    id: chain,
    sku: "CH-9",
    name: "Chain",
    price: { value: 1850, currency: "EUR" },
    active: 1,
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
  const publisher = async (network: string, t: number) => {
    const hour = Math.floor(t / HOUR);
    await db.client.query({
      sql: "INSERT INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at) VALUES (?, ?, ?, ?, 'queued', 0, 8, ?, ?)",
      params: [
        ulid(),
        NETWORK_PUBLISH_KIND,
        JSON.stringify({ network, hour, link: 0 }),
        t,
        publishKey(network, hour),
        t,
      ],
      method: "run",
    });
    await drain(t);
  };
  return { db, caps, svc, chain, drain, publisher };
}

describe("rules version 6 to the networks", () => {
  it("a booking moved by both sides: to a network applying version 6, its promise, change and outcome at the new time", async () => {
    const net = fakeNetworks({ [A]: ranking(6, null) });
    const s = await setup({ [A]: { enabled: true } }, net.fetchImpl);
    // The network's rules are read once: the booking's first receipt reads them.
    const r = await s.caps.createBooking(customer(T0), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Surf lesson" },
        startTime: new Date(T0 + DAY).toISOString(),
        endTime: new Date(T0 + DAY + 90 * MIN).toISOString(),
      },
      contact: { email: "rita@example.com" },
    });
    const id = r.view.item.id;
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: id, event: "confirm" });
    await s.drain(T0 + MIN);
    expect(net.posted(A)).toEqual(["booking confirmed"]);

    // We ask to move it a day on, and the customer's assistant says yes.
    const moved = T0 + 2 * DAY;
    await s.caps.transitionItem(owner(T0 + HOUR), {
      item_id: id,
      event: "propose_change",
      input: { startTime: new Date(moved).toISOString() },
    });
    const status = await s.caps.getItemStatus(agent(T0 + 2 * HOUR, r.accessToken as string), { item_id: id });
    await s.caps.customer.acceptOffer(agent(T0 + 2 * HOUR, r.accessToken as string), {
      item_id: id,
      terms_sha: status.offer?.terms_sha as string,
    });
    await s.drain(T0 + 2 * HOUR);
    await s.caps.transitionItem(owner(moved + 91 * MIN), { item_id: id, event: "complete" });
    await s.drain(moved + 92 * MIN);

    expect(net.posted(A)).toEqual(["booking confirmed", "booking amended", "booking.completed"]);
    const [promise, amended, outcome] = net.claims(A) as [Claims, Claims, Claims];
    expect(amended).toMatchObject({ ref: promise.nonce, due: Math.floor(moved / 1000), acc: "customer" });
    expect(outcome).toMatchObject({ ref: promise.nonce, due: Math.floor(moved / 1000) });
    expect(promise.due).toBe(Math.floor((T0 + DAY) / 1000));
  });

  it("a refund goes to a network that takes version 6, announced or in force, and waits for one that does not", async () => {
    const net = fakeNetworks({ [A]: ranking(5, 6), [B]: ranking(5, null) });
    const s = await setup({ [A]: { enabled: true }, [B]: { enabled: true } }, net.fetchImpl);
    const order = {
      payload: {
        orderedItem: [{ productId: s.chain, name: "Chain", quantity: 2, price: { value: 1850, currency: "EUR" } }],
        totalPrice: { value: 3700, currency: "EUR" },
      },
      contact: { email: "rita@example.com" },
    };
    // The customer confirms the summary first (the confirm step), as an assistant does.
    const asked = await s.caps.createOrder(customer(T0), order).catch((e: unknown) => e as WriteError);
    expect(asked).toBeInstanceOf(WriteError);
    const made = await s.caps.createOrder(customer(T0), {
      ...order,
      terms_sha: (asked as WriteError).details?.terms_sha as string,
    });
    const id = made.view.item.id;
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: id, event: "accept" });
    await s.caps.transitionItem(shop(T0 + 2 * MIN), {
      item_id: id,
      event: "record_payment",
      input: { paymentRef: "pi_1", amount: { value: 3700, currency: "EUR" } },
    });
    await s.drain(T0 + 2 * MIN);
    // We cannot fulfil it: the order is broken for us, and what was paid is owed back, promised now.
    const cancelled = await s.caps.transitionItem(owner(T0 + HOUR), { item_id: id, event: "cancel" });
    const refundId = cancelled.linked?.item.id as string;
    await s.drain(T0 + HOUR);
    // Paid back the next day, well inside its date.
    await s.caps.transitionItem(shop(T0 + DAY), { item_id: refundId, event: "refund", input: { paymentRef: "re_1" } });
    await s.drain(T0 + DAY);

    // Each item's receipts in order (two items: the order, and the refund of it).
    const sent = net.posted(A);
    expect(sent.filter((x) => !x.startsWith("refund"))).toEqual([
      "order accepted",
      "order paid",
      "order.not_fulfilled",
    ]);
    expect(sent.filter((x) => x.startsWith("refund"))).toEqual(["refund accepted", "refund.honoured"]);
    const refund = net.claims(A).filter((c) => c.typ === "refund");
    expect(refund[0]).toMatchObject({ itm: refundId, knd: "accepted" });
    expect(refund[1]).toMatchObject({ itm: refundId, ref: refund[0]?.nonce });
    // Rules 5 with nothing announced: the order's receipts go, the refund's wait.
    expect(net.posted(B)).toEqual(["order accepted", "order paid", "order.not_fulfilled"]);
    const b = (await s.caps.getNetworks(owner(T0 + DAY))).networks.find((n) => n.origin === B);
    expect(b).toMatchObject({ rules: { version: 5, v6: false }, receipts: { queued: 2, held: 2 } });

    // B announces version 6: its next hourly publisher sends what waited, the promise first.
    net.rules[B] = ranking(5, 6);
    await s.publisher(B, T0 + 2 * DAY + HOUR);
    expect(net.posted(B).slice(3)).toEqual(["refund accepted", "refund.honoured"]);
    const after = (await s.caps.getNetworks(owner(T0 + 2 * DAY + HOUR))).networks.find((n) => n.origin === B);
    expect(after?.receipts).toMatchObject({ queued: 0, held: 0 });
  });
});
