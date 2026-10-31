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
import { type Caller, IDEMPOTENCY_TTL_MS, strongIdempotencyKey } from "../src/write/index";
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

/** A random UUID, as `crypto.randomUUID()` makes one: the key an assistant should send (ADR-044 §1). */
const RANDOM_KEY = "3f1c9a52-7d4e-4b8a-9c21-5e6f0a7b8d93";

describe("a retry whose idempotency key is a random secret (ADR-044 §1)", () => {
  it("gets the same access token and the passes back, and the token still works", async () => {
    const s = await setup();
    const input = { ...s.input, idempotency_key: RANDOM_KEY };
    const first = await s.caps.createBooking(shared(), input);
    expect(first.accessToken).toBeTruthy();
    expect(first.identity?.passes).toEqual([{ network: NET, pass: PASS }]);
    // The first answer was lost: the assistant sends the same request with the same key.
    const again = await s.caps.createBooking(shared(), input);
    expect(again.replayed).toBe(true);
    expect(again.view.item.id).toBe(first.view.item.id);
    expect(again.accessToken).toBe(first.accessToken);
    expect(again.accessTokenWithheld).toBeUndefined();
    expect(again.identity?.passes).toEqual(first.identity?.passes);
    // The same token, so whoever holds the first answer keeps one that works.
    const status = await s.caps.getItemStatus(
      { ...shared(), accessToken: again.accessToken as string },
      { item_id: first.view.item.id },
    );
    expect(status.item.id).toBe(first.view.item.id);
  });

  it("still withholds it for a short or patterned key", async () => {
    for (const key of ["booking-1", "00000000-0000-4000-8000-000000000000", "0123456789abcdef0123456789abcdef"]) {
      const s = await setup();
      const input = { ...s.input, idempotency_key: key };
      const first = await s.caps.createBooking(shared(), input);
      expect(first.accessToken).toBeTruthy();
      const again = await s.caps.createBooking(shared(), input);
      expect(again.replayed).toBe(true);
      expect(again.accessToken).toBeUndefined();
      expect(again.accessTokenWithheld).toBe(true);
      expect(again.identity?.passes).toEqual([]);
      expect(JSON.stringify(again)).not.toContain(first.accessToken as string);
    }
  });

  it("refuses the key with another body, as any retry", async () => {
    const s = await setup();
    const input = { ...s.input, idempotency_key: RANDOM_KEY };
    await s.caps.createBooking(shared(), input);
    await expect(
      s.caps.createBooking(shared(), { ...input, contact: { name: "Someone else", email: "x@example.com" } }),
    ).rejects.toMatchObject({ code: "idempotency_mismatch", status: 422 });
  });

  it("never gives it to another customer's scope, which makes an item of its own", async () => {
    const s = await setup();
    const input = { ...s.input, idempotency_key: RANDOM_KEY };
    const first = await s.caps.createBooking(shared(), input);
    const elsewhere: Caller = {
      ...shared(),
      actor: { kind: "customer_agent", id: "anon:fedcba9876543210", channel: "mcp_public" },
    };
    const other = await s.caps.createBooking(elsewhere, input);
    expect(other.replayed).toBe(false);
    expect(other.view.item.id).not.toBe(first.view.item.id);
    expect(other.accessToken).not.toBe(first.accessToken);
    // And the same scope on another door is another scope too.
    const rest: Caller = { ...shared(), actor: { ...shared().actor, channel: "rest" } };
    const third = await s.caps.createBooking(rest, input);
    expect(third.replayed).toBe(false);
    expect(JSON.stringify(third)).not.toContain(first.accessToken as string);
  });

  it("never gives it back for a key someone else sent too: a random one never turns up twice", async () => {
    const s = await setup();
    const input = { ...s.input, idempotency_key: RANDOM_KEY };
    const first = await s.caps.createBooking(shared(), input);
    // Another caller sends the same key: a copied one, as a model writes an example UUID from memory.
    const elsewhere: Caller = {
      ...shared(),
      actor: { kind: "customer_agent", id: "anon:fedcba9876543210", channel: "mcp_public" },
    };
    await s.caps.createBooking(elsewhere, input);
    const again = await s.caps.createBooking(shared(), input);
    expect(again.replayed).toBe(true);
    expect(again.view.item.id).toBe(first.view.item.id);
    expect(again.accessToken).toBeUndefined();
    expect(again.accessTokenWithheld).toBe(true);
    expect(JSON.stringify(again)).not.toContain(first.accessToken as string);
  });

  it("never gives it to a request a network carried, nor after the key's lifetime", async () => {
    let s = await setup();
    const input = { ...s.input, idempotency_key: RANDOM_KEY };
    const carried: Caller = { ...shared(), viaNetwork: true };
    const made = await s.caps.createBooking(carried, input);
    expect(made.accessToken).toBeTruthy();
    const again = await s.caps.createBooking(carried, input);
    expect(again.replayed).toBe(true);
    expect(again.accessTokenWithheld).toBe(true);

    s = await setup();
    const kept = { ...s.input, idempotency_key: RANDOM_KEY };
    await s.caps.createBooking(shared(), kept);
    const late: Caller = { ...shared(), now: () => T0 + IDEMPOTENCY_TTL_MS + 1 };
    const stale = await s.caps.createBooking(late, kept);
    expect(stale.replayed).toBe(true);
    expect(stale.accessToken).toBeUndefined();
    expect(stale.accessTokenWithheld).toBe(true);
  });
});

describe("what counts as a random idempotency key", () => {
  it("takes a random UUID or 32 random hex digits, anywhere in the key", () => {
    for (const key of [
      RANDOM_KEY,
      RANDOM_KEY.toUpperCase(),
      `req_${RANDOM_KEY}`,
      "9b2e41f07c3d8a65e1f40b9d27c6a3e8",
      "booking-9b2e41f07c3d8a65e1f40b9d27c6a3e8",
    ]) {
      expect(strongIdempotencyKey(key), key).toBe(true);
    }
  });

  it("refuses what is short, a counter, a date, time-based, or a pattern", () => {
    for (const key of [
      "booking-1",
      "msg-1",
      "book-rita-0922",
      "2026-10-31T03:00:00Z-rita@example.com",
      // A time-based UUID (version 1, version 7): part of it is a clock.
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "01890a5d-ac96-774b-bcce-b302099a8057",
      // Patterns that look like hex.
      "00000000-0000-4000-8000-000000000000",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0123456789abcdef0123456789abcdef",
      "deadbeefdeadbeefdeadbeefdeadbeef",
      "9b2e41f07c3d8a65e1f40b9d27c6a3e", // 31 digits
      // The examples every manual prints, and the ones the API tools put in their forms.
      "550e8400-e29b-41d4-a716-446655440000",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
      "d290f1ee-6c54-4b01-90e6-d701748f0851",
      "A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D",
      // Every other digit counting.
      "c1d2e3f4-a5b6-4c7d-8e9f-a0b1c2d3e4f5",
    ]) {
      expect(strongIdempotencyKey(key), key).toBe(false);
    }
  });
});
