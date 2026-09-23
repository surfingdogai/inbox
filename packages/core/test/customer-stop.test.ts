import { logMailOut, runMigrations, type SqlInput } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { identityContext } from "../src/identity/context";
import type { IdentityPort, Presentation } from "../src/identity/types";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { secretHash } from "../src/protocol/credentials";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { availabilityRules, services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { readSettings } from "../src/settings/schema";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * A real stop (Tiago, 23 September 2026): the page the code email links to lets the customer switch
 * the booking network off for themselves, and from then on nothing more about them reaches any
 * network — no first contact, no presentation, no receipt, no code — and no network's standing is
 * read. Their bookings and emails go on as before; the owner sees it, and what each network already
 * had. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NET = "https://net.example.com";
const BASE = "https://inbox.example.com";
const PASS = `sdpass1_net.example.com_${"p".repeat(16)}_${"q".repeat(32)}`;
const KEY = `sdkey1_net.example.com_${"k".repeat(16)}_${"m".repeat(32)}`;

const owner = (t = T0): Caller => ({
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
});
const customer = (t = T0): Caller => ({
  actor: { kind: "customer_agent", id: `anon:${ulid()}`, channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => t,
});

/** A network that issues Rita a key and a pass, and presents her pass; every call is counted. */
async function fakeNetwork() {
  const calls: string[] = [];
  const person: Presentation = {
    network: NET,
    presentationId: "presentation-rita-00001",
    ppid: "ppid-rita",
    person: {
      tier: "trusted",
      score: 0.9,
      kept: 9,
      broken: 0,
      businesses: 4,
      email_proven: true,
      since: "2026-01-01T00:00:00Z",
      unusual_use: false,
      rules: 3,
    } as unknown as Presentation["person"],
    passHash: await secretHash(PASS),
    via: "issuance",
  };
  const port: IdentityPort = {
    canSign: async () => true,
    present: async () => {
      calls.push("present");
      return { presentations: [{ ...person, via: "pass" }], notes: [] };
    },
    issue: async (input) => {
      calls.push("issue");
      return input.networks.map((network) => ({
        network,
        outcome: "issued" as const,
        key: KEY,
        pass: PASS,
        presentation: person,
      }));
    },
  };
  return { port, calls };
}

async function setup() {
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
  const caps = new Capabilities(db, createSecretBox(["stop-test-instance-key-0123456789abcdef"]), BASE);
  await caps.updateSettings(owner(), {
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
  const mail = logMailOut();
  const net = await fakeNetwork();
  caps.people.attachPort(net.port);
  caps.attachMail(mail);
  const runner = createRunner({ mailOut: mail, secrets: caps.secrets, baseUrl: BASE, receipts: caps.receipts });
  const drain = async (t: number) => {
    for (let i = 0; i < 12; i++) if ((await runner.runDue(db, { now: t, limit: 100 })).claimed === 0) return;
  };
  const sweep = async (t: number) => {
    await db.client.query({
      sql: "INSERT INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at) VALUES (?, 'lifecycle_sweep', '{}', ?, 'queued', 0, 8, ?, ?)",
      params: [ulid(), t, `sweep-${t}`, T0],
      method: "run",
    });
    await drain(t);
  };
  let slot = 0;
  const book = (caller: Caller, extra: Record<string, unknown> = {}) => {
    const start = T0 + 3 * DAY + ++slot * 90 * MIN;
    return caps.createBooking(caller, {
      payload: {
        reservationFor: { serviceId: svc, name: "Massage" },
        startTime: new Date(start).toISOString(),
        endTime: new Date(start + 60 * MIN).toISOString(),
      },
      contact: { name: "Rita", email: "Rita@Example.com" },
      ...extra,
    });
  };
  return { db, caps, mail, net, drain, sweep, book };
}

const rows = async (db: Db, sql: string, params: SqlInput[] = []) =>
  (await db.client.query({ sql, params, method: "all" })).rows.map((r) => [...r]);
const counts = async (db: Db) =>
  Object.fromEntries(
    await Promise.all(
      ["item_events", "thread_entries", "jobs", "network_stops", "action_links WHERE used_at IS NOT NULL"].map(
        async (t) => [t, (await rows(db, `SELECT COUNT(*) FROM ${t}`))[0]?.[0]] as const,
      ),
    ),
  );

/** Rita's first booking, confirmed, its promise queued for the network, and her code email sent with its link. */
async function ritaWithCode() {
  const s = await setup();
  const first = await s.book(customer());
  const id = first.view.item.id;
  expect(s.net.calls).toEqual(["issue"]);
  await s.caps.transitionItem(owner(T0 + MIN), { item_id: id, event: "confirm" });
  await s.drain(T0 + 20 * MIN);
  expect(await rows(s.db, "SELECT state FROM network_publications")).toEqual([["queued"]]);
  await s.sweep(T0 + DAY + MIN);
  const code = s.mail.sent.find((m) => m.subject === "For next time");
  expect(code?.text).toContain(KEY);
  const token = /\/c\/([A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22})/.exec(code?.text ?? "")?.[1] as string;
  expect(token).toBeDefined();
  return { ...s, id, token, accessToken: first.accessToken as string };
}

describe("a customer who stops the booking network for themselves", () => {
  it("opens a page from the code email that only shows, and stops it with its button", async () => {
    const s = await ritaWithCode();
    const before = await counts(s.db);
    const page = await s.caps.customer.linkView(s.token, { now: T0 + DAY + 2 * MIN });
    expect(page.status).toBe(200);
    expect(page.business).toBe("Oficina Maré");
    expect(page.form).toMatchObject({ hidden: { terms: "networks", stop: "1" }, button: "Stop using it for me" });
    expect(JSON.stringify(page)).toContain(
      "If you stop, from then on we tell no booking network anything more about you",
    );
    expect(JSON.stringify(page)).toContain("we cannot yet ask it to erase it");
    // Showing it wrote nothing, and a POST that did not come from its form does nothing either.
    expect(await counts(s.db)).toEqual(before);
    const scanner = await s.caps.customer.linkAct(s.token, {}, { now: T0 + DAY + 3 * MIN });
    expect("page" in scanner && scanner.page.status).toBe(422);
    expect(await rows(s.db, "SELECT COUNT(*) FROM parties WHERE networks_off_at IS NOT NULL")).toEqual([[0]]);

    const done = await s.caps.customer.linkAct(s.token, { terms: "networks", stop: "1" }, { now: T0 + DAY + 4 * MIN });
    expect(done).toEqual({ redirect: `/c/${s.token}` });
    const at = T0 + DAY + 4 * MIN;
    expect(await rows(s.db, "SELECT networks_off_at FROM parties")).toEqual([[at]]);
    // Her email, her party: fingerprints only, never the address.
    const stops = await rows(s.db, "SELECT hash, via FROM network_stops");
    expect(stops.length).toBeGreaterThanOrEqual(2);
    expect(stops.every((r) => r[1] === "customer" && /^[0-9a-f]{64}$/.test(String(r[0])))).toBe(true);
    expect(JSON.stringify(stops)).not.toContain("example.com");
    // Nothing a network said is kept for her item, and what was waiting for the network never goes.
    expect(await rows(s.db, "SELECT COUNT(*) FROM item_presentations")).toEqual([[0]]);
    expect(await rows(s.db, "SELECT COUNT(*) FROM pending_identity")).toEqual([[0]]);
    expect(await rows(s.db, "SELECT person FROM person_links")).toEqual([[null]]);
    expect(await rows(s.db, "SELECT state FROM network_publications")).toEqual([["withheld"]]);
    expect(
      await rows(s.db, "SELECT direction, actor_kind FROM thread_entries WHERE item_id = ? AND body_text LIKE ?", [
        s.id,
        "The customer asked us%",
      ]),
    ).toEqual([["note", "system"]]);
    // The page now says since when; stopping again changes nothing.
    const after = await s.caps.customer.linkView(s.token, { now: T0 + DAY + 5 * MIN });
    expect(JSON.stringify(after)).toContain("Done. Since 22 September 2026 we tell no booking network anything more");
    expect(after.form).toBeUndefined();
    await s.caps.customer.linkAct(s.token, { terms: "networks", stop: "1" }, { now: T0 + DAY + 6 * MIN });
    expect(await rows(s.db, "SELECT networks_off_at FROM parties")).toEqual([[at]]);
    expect(
      await rows(s.db, "SELECT COUNT(*) FROM thread_entries WHERE item_id = ? AND body_text LIKE ?", [
        s.id,
        "The customer asked us%",
      ]),
    ).toEqual([[1]]);
  });

  it("is never asked about again: her next booking asks no network and presents nothing, and its receipts go nowhere", async () => {
    const s = await ritaWithCode();
    await s.caps.customer.linkAct(s.token, { terms: "networks", stop: "1" }, { now: T0 + DAY + 4 * MIN });
    const calls = s.net.calls.length;
    const sentBefore = s.mail.sent.length;
    // A new request with her address: a new party, stopped from the start, and nothing asked of a network.
    const next = await s.book(customer(T0 + DAY + 10 * MIN));
    const nextId = next.view.item.id;
    expect(s.net.calls).toHaveLength(calls);
    expect(next.identity?.networks).toEqual([]);
    expect(next.identity?.passes).toEqual([]);
    const [party] = await rows(
      s.db,
      "SELECT p.networks_off_at IS NOT NULL FROM items i JOIN parties p ON p.id = i.party_id WHERE i.id = ?",
      [nextId],
    );
    expect(party).toEqual([1]);
    // She carries her pass on another request: not presented to anyone.
    await s.book(customer(T0 + DAY + 11 * MIN), { pass: PASS, contact: { name: "Rita" } });
    expect(s.net.calls).toHaveLength(calls);
    // Her bookings are confirmed and she is emailed as ever; the promise is signed for her, and sent nowhere.
    await s.caps.transitionItem(owner(T0 + DAY + 12 * MIN), { item_id: nextId, event: "confirm" });
    await s.drain(T0 + DAY + 40 * MIN);
    expect(
      s.mail.sent.slice(sentBefore).some((m) => m.to.includes("Rita@Example.com") && m.subject.startsWith("Confirmed")),
    ).toBe(true);
    expect(await rows(s.db, "SELECT kind FROM receipts WHERE item_id = ?", [nextId])).toEqual([["confirmed"]]);
    expect(
      await rows(
        s.db,
        "SELECT COUNT(*) FROM network_publications p JOIN receipts r ON r.id = p.receipt_id WHERE r.item_id = ? AND p.state <> 'withheld'",
        [nextId],
      ),
    ).toEqual([[0]]);
    // No second code, ever.
    await s.sweep(T0 + 3 * DAY);
    expect(s.mail.sent.filter((m) => m.subject === "For next time")).toHaveLength(1);
    // The rules read no standing for her: as for anyone no network knows.
    const settings = await readSettings(s.db);
    const who = await identityContext(
      s.db,
      { id: s.id, partyId: String((await rows(s.db, "SELECT party_id FROM items WHERE id = ?", [s.id]))[0]?.[0]) },
      settings,
    );
    expect(who.person).toEqual({ present: false, tier: "new", score: 0, networks: [], limit_minor: 0 });
  });

  it("keeps her assistant's access by the pass it holds, with no network call, and passes no acknowledgement on", async () => {
    const s = await ritaWithCode();
    await s.caps.customer.linkAct(s.token, { terms: "networks", stop: "1" }, { now: T0 + DAY + 4 * MIN });
    const calls = s.net.calls.length;
    const status = await s.caps.getItemStatus(customer(T0 + DAY + 5 * MIN), { item_id: s.id, pass: PASS });
    expect(status.item.id).toBe(s.id);
    expect(s.net.calls).toHaveLength(calls);
    const [receipt] = await rows(s.db, "SELECT id FROM receipts WHERE item_id = ?", [s.id]);
    await expect(
      s.caps.acknowledgeReceipt(customer(T0 + DAY + 6 * MIN), {
        item_id: s.id,
        access_token: s.accessToken,
        receipt_id: String(receipt?.[0]),
      }),
    ).rejects.toMatchObject({ code: "not_allowed", details: { reason: "networks_off" } });
  });

  it("shows the owner that she stopped it, and what the network already had", async () => {
    const s = await ritaWithCode();
    // The network took her promise before she stopped it: it holds it open.
    await s.db.client.query({ sql: "UPDATE network_publications SET state = 'published'", method: "run" });
    await s.caps.customer.linkAct(s.token, { terms: "networks", stop: "1" }, { now: T0 + DAY + 4 * MIN });
    const detail = await s.caps.getItem(owner(T0 + DAY + 5 * MIN), { item_id: s.id });
    expect(detail.customer?.networks_off).toEqual({
      since: new Date(T0 + DAY + 4 * MIN).toISOString(),
      via: "customer",
      networks: [{ network: NET, receipts: 1, open_promises: 1, person: true }],
    });
    expect(detail.customer?.persons).toEqual([]);
    const networks = (await s.caps.getNetworks(owner())).networks;
    expect(networks.find((n) => n.origin === NET)?.receipts).toMatchObject({ published: 1, queued: 0 });
  });

  it("can be switched off by the owner, for every party that is the customer", async () => {
    const s = await setup();
    const a = await s.book(customer());
    const b = await s.book(customer(T0 + MIN), { contact: { name: "Rita", email: "rita@example.com" } });
    const partyOf = async (id: string) =>
      String((await rows(s.db, "SELECT party_id FROM items WHERE id = ?", [id]))[0]?.[0]);
    expect(await partyOf(a.view.item.id)).not.toBe(await partyOf(b.view.item.id));
    const summary = await s.caps.customers.stopNetworks(owner(T0 + 2 * MIN), {
      party_id: await partyOf(a.view.item.id),
      item_id: a.view.item.id,
    });
    expect(summary.parties).toHaveLength(2);
    expect(summary.networks_off).toMatchObject({ via: "owner", since: new Date(T0 + 2 * MIN).toISOString() });
    expect(await rows(s.db, "SELECT COUNT(*) FROM parties WHERE networks_off_at IS NULL")).toEqual([[0]]);
    // A customer's party refuses to be stopped by a customer's door: it is the owner's.
    await expect(
      s.caps.customers.stopNetworks(customer(), { party_id: await partyOf(a.view.item.id) }),
    ).rejects.toMatchObject({ code: "not_allowed" });
  });
});
