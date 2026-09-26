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
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { networkPingHandler, networkPublishHandler, networkReceiptHandler } from "../src/network";
import { freshDb } from "./db";

/**
 * Rules version 6 on its way to the networks, attacked (ADR-017 Amendment 3, ADR-018 Amendment 6):
 * what waits for newer rules must be what those rules read, so nothing is held for a network that
 * will never need it, and the owner is not told a receipt waits for rules that will never send it.
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

describe("what waits for rules version 6", () => {
  it("a booking the business wrote down itself, then moved: its promise names no date, so it is not held", async () => {
    const net = fakeNetworks({ [A]: ranking(6, null), [B]: ranking(5, null) });
    const s = await setup({ [A]: { enabled: true }, [B]: { enabled: true } }, net.fetchImpl);
    const made = await s.caps.createBooking(owner(T0), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Surf lesson" },
        startTime: new Date(T0 + DAY).toISOString(),
        endTime: new Date(T0 + DAY + 90 * MIN).toISOString(),
      },
      contact: { name: "Rui" },
    });
    const id = made.view.item.id;
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: id, event: "confirm" });
    // Moved before its promise went out (the network did not answer, say).
    await s.caps.transitionItem(owner(T0 + 2 * MIN), {
      item_id: id,
      event: "propose_change",
      input: { startTime: new Date(T0 + 2 * DAY).toISOString() },
    });
    await s.caps.transitionItem(owner(T0 + 3 * MIN), {
      item_id: id,
      event: "accept_change",
      input: { note: "Rui said yes on the phone" },
    });
    await s.publisher(A, T0 + HOUR);
    await s.publisher(B, T0 + HOUR);
    // A promise the business wrote down itself (claims v1) names no date: a change moves nothing a
    // network holds, whatever rules it applies.
    expect(net.posted(A)).toEqual(["booking confirmed"]);
    expect(net.posted(B)).toEqual(["booking confirmed"]);
    for (const n of (await s.caps.getNetworks(owner(T0 + HOUR))).networks) {
      expect(n.receipts).toMatchObject({ queued: 0, held: 0 });
    }
  });
});
