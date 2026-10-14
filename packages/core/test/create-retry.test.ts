import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import type { AgentSeen, IdentityPort, Presentation } from "../src/identity/types";
import { ulid } from "../src/ids";
import { secretHash } from "../src/protocol/credentials";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { availabilityRules, services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import type { Caller } from "../src/write/index";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * Who a retry of a customer's create is answered to (security review, 14 October 2026). A caller
 * without an account is known by a fingerprint of its address and user agent, which many people
 * share, so the item's access token and its first passes go back on a retry only to the agent's own
 * key that made it: never to a second copy that arrived while the first was still being written,
 * and never to a platform's key, which signs for every user of the platform. Runs on Node and in
 * workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NET = "https://net.example.com";
const BASE = "https://inbox.example.com";
const PASS = `sdpass1_net.example.com_${"p".repeat(16)}_${"q".repeat(32)}`;
const OTHER_PASS = `sdpass1_net.example.com_${"r".repeat(16)}_${"s".repeat(32)}`;
const KEY = `sdkey1_net.example.com_${"k".repeat(16)}_${"m".repeat(32)}`;

const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
/** One address and one user agent: everyone behind it has this one fingerprint. */
const shared = (agent?: AgentSeen): Caller => ({
  actor: { kind: "customer_agent", id: "anon:0123456789abcdef", channel: "mcp_public" },
  tier: "anonymous",
  sandbox: false,
  now: () => T0,
  ...(agent ? { agent } : {}),
});

async function setup(onPresent?: () => Promise<void>) {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Massage",
    durationMin: 60,
    capacity: 3,
    granularityMin: 30,
    price: { model: "fixed", value: 4_500, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  const week = Object.fromEntries(
    ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [["08:00", "20:00"]]]),
  );
  await db.orm.insert(availabilityRules).values({ id: ulid(), kind: "open", weekly: week, createdAt: T0 });
  const caps = confirming(new Capabilities(db, createSecretBox(["retry-test-instance-key-0123456789abcdef"]), BASE));
  await caps.updateSettings(owner, {
    doc: {
      business: { name: "Oficina Maré" },
      notifications: { ownerEmail: "hello@oficinamare.pt", appUrl: BASE },
      email: { fromAddress: "inbox@oficinamare.pt" },
      networks: { [NET]: { enabled: true } },
    },
  });
  await db.client.query({
    sql: "INSERT INTO network_status (network, registration, failures, updated_at) VALUES (?, 'registered', 0, ?)",
    params: [NET, T0],
    method: "run",
  });
  const person: Presentation = {
    network: NET,
    presentationId: "presentation-rita-00001",
    ppid: "ppid-rita",
    person: { tier: "new" } as unknown as Presentation["person"],
    passHash: await secretHash(PASS),
    via: "issuance",
  };
  const port: IdentityPort = {
    canSign: async () => true,
    present: async () => {
      await onPresent?.();
      return { presentations: [{ ...person, passHash: await secretHash(OTHER_PASS), via: "pass" }], notes: [] };
    },
    issue: async (input) =>
      input.networks.map((network) => ({
        network,
        outcome: "issued" as const,
        key: KEY,
        pass: PASS,
        presentation: person,
      })),
  };
  caps.people.attachPort(port);
  const start = T0 + 3 * DAY;
  const input = {
    payload: {
      reservationFor: { serviceId: svc, name: "Massage" },
      startTime: new Date(start).toISOString(),
      endTime: new Date(start + 60 * MIN).toISOString(),
    },
    contact: { name: "Rita", email: "rita@example.com" },
    idempotency_key: "booking-1",
  };
  return { caps, input };
}

describe("a retry of a customer's create", () => {
  it("gives a copy that arrived while the first was still presenting neither the token nor the passes", async () => {
    // The second copy is sent while the first waits on the network: it misses the idempotency key
    // the first will write, presents what it carries, and finds the key only when it writes.
    let first: Awaited<ReturnType<Capabilities["createBooking"]>> | undefined;
    const holder: { caps?: Capabilities; input?: Record<string, unknown> } = {};
    const s = await setup(async () => {
      if (first || !holder.caps || !holder.input) return;
      first = await holder.caps.createBooking(shared(), holder.input as never);
    });
    holder.caps = s.caps;
    holder.input = s.input;
    const second = await s.caps.createBooking(shared(), { ...s.input, pass: OTHER_PASS });

    expect(first?.replayed).toBe(false);
    expect(first?.accessToken).toBeTruthy();
    expect(first?.identity?.passes).toEqual([{ network: NET, pass: PASS }]);
    // The same item, found by its key inside the write: a retry like any other.
    expect(second.replayed).toBe(true);
    expect(second.view.item.id).toBe(first?.view.item.id);
    expect(second.accessToken).toBeUndefined();
    expect(second.accessTokenWithheld).toBe(true);
    expect(second.identity?.passes).toEqual([]);
    expect(JSON.stringify(second)).not.toContain(PASS);
    expect(JSON.stringify(second)).not.toContain(first?.accessToken as string);
  });

  it("answers the agent's own key with the token again, and a platform's key without it", async () => {
    // The agent's own key: the retry is the same agent, and gets what it was given.
    const own: AgentSeen = { level: "self", thumbprint: "own-key-thumbprint-000000000000000000000" };
    let s = await setup();
    const made = await s.caps.createBooking(shared(own), s.input);
    expect(made.accessToken).toBeTruthy();
    const again = await s.caps.createBooking(shared(own), s.input);
    expect(again.replayed).toBe(true);
    expect(again.accessToken).toBe(made.accessToken);
    expect(again.accessTokenWithheld).toBeUndefined();
    expect(again.identity?.passes).toEqual(made.identity?.passes);

    // A platform's key signs for every user of the platform, who share its addresses and its user
    // agent too: the same key, idempotency key and body tell none of them apart.
    for (const level of ["vouched", "self"] as const) {
      const platform: AgentSeen = {
        level,
        thumbprint: "platform-key-thumbprint-0000000000000000",
        platform: "https://assistant.example",
      };
      s = await setup();
      const first = await s.caps.createBooking(shared(platform), s.input);
      expect(first.accessToken).toBeTruthy();
      const retry = await s.caps.createBooking(shared(platform), s.input);
      expect(retry.replayed).toBe(true);
      expect(retry.view.item.id).toBe(first.view.item.id);
      expect(retry.accessToken).toBeUndefined();
      expect(retry.accessTokenWithheld).toBe(true);
      expect(retry.identity?.passes).toEqual([]);
    }
  });
});
