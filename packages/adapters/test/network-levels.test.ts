import {
  Capabilities,
  createRunner,
  createSecretBox,
  issuingNetworks,
  type JobRunner,
  NETWORK_PING_KIND,
  NETWORK_PUBLISH_KIND,
  NETWORK_RECEIPT_KIND,
  networkLane,
  networkRulesStatement,
  readNetworkStatus,
  readSettings,
  schema,
  takesV2,
  ulid,
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { networkPingHandler, networkPublishHandler, networkReceiptHandler, networkRules } from "../src/network";
import { freshDb } from "./db";

/**
 * Network levels (protocol §10): a network says in its rules' `protocol` what it offers and which
 * receipt claims it takes. A directory-level network is never asked for a customer, and its claims
 * decide what it is sent whatever its rules version; a network that says nothing is read as before.
 */
const T0 = Date.parse("2026-09-22T09:00:00Z");
const MIN = 60_000;
const DAY = 86_400_000;
const KEY = "levels-instance-key-0123456789abcdef";
const ISS = "https://inbox.example.com";
const DIR = "https://directory.example.org";
const FULL = "https://network.example.com";

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

/** A directory network's own rules: version 1 of its rules, and what it offers, said outright. */
const directoryRules = {
  version: 1,
  status: "in_force",
  effective_at: "2026-09-01T00:00:00Z",
  summary: "Newest verified business first.",
  next: null,
  protocol: { level: "directory", claims: 2 },
};
/** A network that says nothing of its level: read as full, its claims from its version. */
const fullRules = { version: 3, status: "in_force", next: null };

function fakeNetworks(rules: Record<string, unknown>) {
  const calls: { network: string; path: string; body: { receipt?: string } | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as { receipt?: string }) : null;
    calls.push({ network: url.origin, path: url.pathname, body });
    if (url.pathname === "/v1/ranking") return Response.json(rules[url.origin] ?? {});
    if (url.pathname === "/v1/receipts")
      return Response.json({ ok: true, state: "issued", duplicate: false }, { status: 201 });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const posted = (network: string) =>
    calls
      .filter((c) => c.network === network && c.path === "/v1/receipts" && c.body?.receipt)
      .map((c) => {
        const claims = JSON.parse(
          new TextDecoder().decode(
            Uint8Array.from(atob((c.body?.receipt?.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")), (ch) =>
              ch.charCodeAt(0),
            ),
          ),
        ) as { knd: string; typ: string; out?: string };
        return claims.out ?? `${claims.typ} ${claims.knd}`;
      });
  return { calls, fetchImpl, posted };
}

async function setup(fetchImpl: typeof fetch) {
  const { db } = await freshDb();
  const caps = new Capabilities(db, createSecretBox([KEY]), ISS, 0);
  await caps.updateSettings(owner(T0), { doc: { networks: { [DIR]: { enabled: true }, [FULL]: { enabled: true } } } });
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
  return { db, caps, svc, drain, deps };
}

describe("network levels (protocol §10)", () => {
  it("reads a network's level and claims from its rules, and leaves a network that says nothing as it was", async () => {
    const net = fakeNetworks({ [DIR]: directoryRules, [FULL]: fullRules });
    const s = await setup(net.fetchImpl);
    await networkRules(s.deps, s.db, DIR, T0);
    await networkRules(s.deps, s.db, FULL, T0);
    const dir = await readNetworkStatus(s.db, DIR);
    const full = await readNetworkStatus(s.db, FULL);
    expect(dir).toMatchObject({ rulesVersion: 1, level: "directory", claims: 2 });
    expect(full).toMatchObject({ rulesVersion: 3, level: null, claims: null });
    // Version 1 of its own rules, but it said it takes claims 2: it is sent them.
    expect(takesV2(dir)).toBe(true);
    // A signed ping's answer carries the rules version, never the protocol: what was said stays.
    await s.db.client.query(networkRulesStatement(DIR, T0 + DAY, { version: 2, next: null, nextAt: null }));
    expect(await readNetworkStatus(s.db, DIR)).toMatchObject({ rulesVersion: 2, level: "directory", claims: 2 });

    const { networks } = await s.caps.getNetworks(owner(T0));
    expect(networks.find((n) => n.origin === DIR)?.level).toBe("directory");
    expect(networks.find((n) => n.origin === FULL)?.level).toBe("full");
  });

  it("never asks a directory-level network for a customer", async () => {
    const net = fakeNetworks({ [DIR]: directoryRules, [FULL]: fullRules });
    const s = await setup(net.fetchImpl);
    await networkRules(s.deps, s.db, DIR, T0);
    await networkRules(s.deps, s.db, FULL, T0);
    await s.db.client.query({
      sql: "UPDATE network_status SET registration = 'registered' WHERE network IN (?, ?)",
      params: [DIR, FULL],
      method: "run",
    });
    expect(await issuingNetworks(s.db, await readSettings(s.db))).toEqual([FULL]);
  });

  it("sends a directory network the claims it said it takes: a booking's promise and its outcome", async () => {
    const net = fakeNetworks({ [DIR]: directoryRules, [FULL]: { version: 1, status: "in_force", next: null } });
    const s = await setup(net.fetchImpl);
    const r = await s.caps.createBooking(customer(T0), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Surf lesson" },
        startTime: new Date(T0 + DAY).toISOString(),
        endTime: new Date(T0 + DAY + 90 * MIN).toISOString(),
      },
      contact: { email: "rita@example.com" },
    });
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: r.view.item.id, event: "confirm" });
    await s.drain(T0 + MIN);
    await s.caps.transitionItem(owner(T0 + DAY + 91 * MIN), { item_id: r.view.item.id, event: "complete" });
    await s.drain(T0 + DAY + 92 * MIN);
    expect(net.posted(DIR)).toEqual(["booking confirmed", "booking.completed"]);
    // The network on version 1 that says nothing gets what version 1 always got: the promise only.
    expect(net.posted(FULL)).toEqual(["booking confirmed"]);
    // And no customer was asked for at either: nothing but rules and receipts went out.
    expect(net.calls.filter((c) => c.path === "/v1/persons")).toEqual([]);
  });
});
