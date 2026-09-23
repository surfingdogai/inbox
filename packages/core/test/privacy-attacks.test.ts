import { logMailOut, runMigrations, type SqlInput } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { networksStopped } from "../src/identity/stops";
import type { IdentityPort, Presentation } from "../src/identity/types";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { secretHash } from "../src/protocol/credentials";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { availabilityRules, services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * Attacks on the stop and the erasure (Tiago, 23 September 2026), each a case a careless owner, a
 * family sharing a phone, or a customer with two addresses would hit. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NET = "https://net.example.com";
const BASE = "https://inbox.example.com";
const PASS = `sdpass1_net.example.com_${"p".repeat(16)}_${"q".repeat(32)}`;
const KEY = `sdkey1_net.example.com_${"k".repeat(16)}_${"m".repeat(32)}`;
const PHONE = "+351 912 345 678";

const owner = (t = T0): Caller => ({
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
  principal: { via: "session", id: "s1", name: "owner", scopes: ["*"], userId: "u1" },
});
const customer = (t = T0): Caller => ({
  actor: { kind: "customer_agent", id: `anon:${ulid()}`, channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => t,
});

/** A network that issues a key and a pass to whoever asks, and presents that pass; every call is kept. */
async function fakeNetwork() {
  const calls: { kind: string; email?: string | undefined }[] = [];
  const person: Presentation = {
    network: NET,
    presentationId: "presentation-00001",
    ppid: "ppid-rita",
    person: { tier: "trusted", score: 0.9, kept: 9, broken: 0 } as unknown as Presentation["person"],
    passHash: await secretHash(PASS),
    via: "issuance",
  };
  const port: IdentityPort = {
    canSign: async () => true,
    present: async (input) => {
      calls.push({ kind: "present", email: input.email });
      const pass = input.credentials.find((c) => c.startsWith("sdpass1_")) ?? PASS;
      return { presentations: [{ ...person, passHash: await secretHash(pass), via: "pass" }], notes: [] };
    },
    issue: async (input) => {
      calls.push({ kind: "issue", email: input.email });
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
    capacity: 5,
    granularityMin: 30,
    price: { model: "fixed", value: 4_500, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  const week = Object.fromEntries(
    ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [["08:00", "20:00"]]]),
  );
  await db.orm.insert(availabilityRules).values({ id: ulid(), kind: "open", weekly: week, createdAt: T0 });
  const caps = new Capabilities(db, createSecretBox(["privacy-attack-instance-key-0123456789"]), BASE);
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
  let slot = 0;
  const book = (caller: Caller, contact: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const start = T0 + 3 * DAY + ++slot * 90 * MIN;
    return caps.createBooking(caller, {
      payload: {
        reservationFor: { serviceId: svc, name: "Massage" },
        startTime: new Date(start).toISOString(),
        endTime: new Date(start + 60 * MIN).toISOString(),
        notes: `Booked by ${String(contact.name)}`,
      },
      contact,
      ...extra,
    });
  };
  const partyOf = async (id: string) =>
    String((await rows(db, "SELECT party_id FROM items WHERE id = ?", [id]))[0]?.[0]);
  return { db, caps, mail, net, drain, book, partyOf };
}

const rows = async (db: Db, sql: string, params: SqlInput[] = []) =>
  (await db.client.query({ sql, params, method: "all" })).rows.map((r) => [...r]);

describe("a phone the family shares", () => {
  it("stops, exports and erases only the one who asked: never the husband who gave his own email", async () => {
    const s = await setup();
    // Pedro books with his own address and the family's phone; Ana, his wife, with the phone alone.
    const pedro = await s.book(customer(), { name: "Pedro Carvalho", email: "pedro@example.com", phone: PHONE });
    const ana = await s.book(customer(T0 + MIN), { name: "Ana Carvalho", phone: PHONE });
    const pedroParty = await s.partyOf(pedro.view.item.id);
    const anaParty = await s.partyOf(ana.view.item.id);
    expect(s.net.calls.filter((c) => c.kind === "issue")).toHaveLength(1);

    // Ana is not Pedro: her data is hers alone.
    const summary = await s.caps.customers.summary(owner(), { party_id: anaParty });
    expect(summary.parties).toEqual([anaParty]);
    const data = await s.caps.customers.export(owner(), { party_id: anaParty });
    expect(JSON.stringify(data)).not.toContain("Pedro");

    // Ana asks the business not to use booking networks for her: Pedro keeps his.
    await s.caps.customers.stopNetworks(owner(T0 + 2 * MIN), { party_id: anaParty });
    expect(await rows(s.db, "SELECT networks_off_at FROM parties WHERE id = ?", [pedroParty])).toEqual([[null]]);
    expect(await networksStopped(s.db, { contact: { email: "pedro@example.com", phone: PHONE } })).toBe(false);
    // His next booking, with the same phone, is his as ever: a new party, not stopped, and the network is asked.
    const again = await s.book(customer(T0 + 3 * MIN), {
      name: "Pedro Carvalho",
      email: "pedro@example.com",
      phone: PHONE,
    });
    expect(
      await rows(s.db, "SELECT networks_off_at FROM parties WHERE id = ?", [await s.partyOf(again.view.item.id)]),
    ).toEqual([[null]]);
    // Ana, phone alone, is stopped the next time too.
    const anaAgain = await s.book(customer(T0 + 4 * MIN), { name: "Ana", phone: PHONE });
    expect(
      await rows(s.db, "SELECT networks_off_at IS NOT NULL FROM parties WHERE id = ?", [
        await s.partyOf(anaAgain.view.item.id),
      ]),
    ).toEqual([[1]]);

    // Erasing Ana leaves Pedro whole.
    const asked = await s.caps.customers.erase(owner(), { party_id: anaParty }).catch((e) => e);
    expect(asked.details.summary.parties).not.toContain(pedroParty);
    await s.caps.customers.erase(owner(), { party_id: anaParty, confirm: asked.details.confirm });
    const detail = await s.caps.getItem(owner(), { item_id: pedro.view.item.id });
    expect(detail.party).toMatchObject({ name: "Pedro Carvalho", email: "pedro@example.com" });
    expect(detail.item.payload).toMatchObject({ notes: "Booked by Pedro Carvalho" });
  });
});

describe("a stopped customer's other address", () => {
  it("is stopped too once a request her pass recognised gave it: no network hears of it later", async () => {
    const s = await setup();
    const first = await s.book(customer(), { name: "Rita", email: "rita@example.com" });
    expect(s.net.calls.map((c) => c.kind)).toEqual(["issue"]);
    await s.caps.customers.stopNetworks(owner(T0 + MIN), { party_id: await s.partyOf(first.view.item.id) });
    // Her assistant books with her pass and a new address of hers: recognised here, no network asked.
    const withPass = await s.book(
      customer(T0 + 2 * MIN),
      { name: "Rita", email: "rita.new@example.com" },
      { pass: PASS },
    );
    expect(await s.partyOf(withPass.view.item.id)).toBe(await s.partyOf(first.view.item.id));
    expect(s.net.calls.map((c) => c.kind)).toEqual(["issue"]);
    // A request from that address alone, later: still her, still stopped, and no network is asked.
    await s.book(customer(T0 + 3 * MIN), { name: "Rita", email: "rita.new@example.com" });
    expect(s.net.calls.map((c) => c.kind)).toEqual(["issue"]);
  });

  it("is stopped too once a one-time code proved it is hers, and the network is never asked about it", async () => {
    const s = await setup();
    const first = await s.book(customer(), { name: "Rita", email: "rita@example.com", phone: PHONE });
    const ritaParty = await s.partyOf(first.view.item.id);
    await s.caps.customers.stopNetworks(owner(T0 + MIN), { party_id: ritaParty });
    // A request with another address and her phone: it may be her, or anyone who shares that phone.
    const other = await s.book(customer(T0 + 2 * MIN), { name: "Rita", email: "rita.work@example.com", phone: PHONE });
    const otherId = other.view.item.id;
    const created = await rows(s.db, "SELECT networks_off_at IS NOT NULL FROM parties WHERE id = ?", [
      await s.partyOf(otherId),
    ]);
    const issued = s.net.calls.filter((c) => c.email === "rita.work@example.com").length;
    // Either it is taken as hers (stopped, and no network asked) or as someone else's (asked as anyone):
    // never stopped and asked all the same.
    expect(created[0]?.[0] === 1 && issued > 0).toBe(false);
    // She proves it is hers with the code sent to the address the business knows.
    await s.caps.verifyCustomer(customer(T0 + 3 * MIN), {
      item_id: otherId,
      access_token: other.accessToken as string,
    });
    const code = /\b(\d{6})\b/.exec(s.mail.sent.at(-1)?.text ?? "")?.[1] as string;
    await s.caps.verifyCustomer(customer(T0 + 4 * MIN), {
      item_id: otherId,
      access_token: other.accessToken as string,
      code,
    });
    expect(await s.partyOf(otherId)).toBe(ritaParty);
    // Whatever that request got from a network is gone with the stop, and the address is stopped from now on.
    expect(await rows(s.db, "SELECT COUNT(*) FROM pending_identity WHERE item_id = ?", [otherId])).toEqual([[0]]);
    expect(await networksStopped(s.db, { contact: { email: "rita.work@example.com" } })).toBe(true);
    const calls = s.net.calls.length;
    await s.book(customer(T0 + 5 * MIN), { name: "Rita", email: "rita.work@example.com" });
    expect(s.net.calls).toHaveLength(calls);
  });
});

/** Every text in every table, as one string per table: what an erasure has to leave no trace in. */
async function everything(db: Db): Promise<Record<string, string>> {
  const tables = (
    await rows(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'search_fts_%'",
    )
  ).map((r) => String(r[0]));
  const out: Record<string, string> = {};
  for (const t of tables) out[t] = JSON.stringify(await rows(db, `SELECT * FROM "${t}"`));
  return out;
}

describe("erasing a customer whose emails did not go", () => {
  it("keeps no address in what the mail service or a webhook's receiver said back", async () => {
    const s = await setup();
    // A mail service that refuses her address, and quotes it, as mail services do.
    const refusing = {
      ...logMailOut(),
      send: async () => {
        throw new Error("550 5.1.1 <rita.carvalho@example.com>: Recipient address rejected");
      },
    };
    s.caps.attachMail(refusing);
    const runner = createRunner({
      mailOut: refusing,
      secrets: s.caps.secrets,
      baseUrl: BASE,
      receipts: s.caps.receipts,
    });
    const booked = await s.book(customer(), { name: "Rita Carvalho", email: "rita.carvalho@example.com" });
    const id = booked.view.item.id;
    for (let i = 0; i < 4; i++) await runner.runDue(s.db, { now: T0 + 5 * MIN, limit: 100 });
    expect(
      (await rows(s.db, "SELECT last_error FROM outbound_mail WHERE item_id = ? AND recipient = 'customer'", [id]))
        .map((r) => String(r[0]))
        .join(" "),
    ).toContain("rita.carvalho@example.com");
    // A webhook's receiver that answered her create event with her address in its error.
    const [event] = await rows(s.db, "SELECT id FROM item_events WHERE item_id = ? AND seq = 1", [id]);
    await s.db.client.batch([
      {
        sql: "INSERT INTO webhooks (id, url, secret_enc, events, payload_style, active, header_names, created_at, updated_at) VALUES ('wh1', 'https://crm.example.net/hook', 'x', '[\"*\"]', 'full', 1, '[]', ?, ?)",
        params: [T0, T0],
        method: "run",
      },
      {
        sql: "INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, status, attempts, last_status, last_error, created_at) VALUES ('d1', 'wh1', ?, 'item.created', 'failed', 3, 422, 'HTTP 422: {\"error\":\"duplicate contact rita.carvalho@example.com\"}', ?)",
        params: [String(event?.[0]), T0],
        method: "run",
      },
    ]);
    const party = await s.partyOf(id);
    const asked = await s.caps.customers.erase(owner(), { party_id: party }).catch((e) => e);
    await s.caps.customers.erase(owner(), { party_id: party, confirm: asked.details.confirm });
    for (const [table, text] of Object.entries(await everything(s.db))) {
      expect(text.toLowerCase(), `her address in ${table}`).not.toContain("rita.carvalho@example.com");
    }
    // What happened stays: the email did not go, and the delivery failed.
    expect(
      await rows(s.db, "SELECT status FROM outbound_mail WHERE item_id = ? AND recipient = 'customer'", [id]),
    ).not.toContainEqual(["sent"]);
    expect(await rows(s.db, "SELECT status, last_status FROM webhook_deliveries")).toEqual([["failed", 422]]);
  });
});

describe("the owner switching networks off", () => {
  it("writes the note on the customer's own item, never on another customer's the request named", async () => {
    const s = await setup();
    const rita = await s.book(customer(), { name: "Rita", email: "rita@example.com" });
    const tomas = await s.book(customer(T0 + MIN), { name: "Tomás", email: "tomas@example.com" });
    await expect(
      s.caps.customers.stopNetworks(owner(T0 + 2 * MIN), {
        party_id: await s.partyOf(rita.view.item.id),
        item_id: tomas.view.item.id,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(
      await rows(s.db, "SELECT COUNT(*) FROM thread_entries WHERE item_id = ? AND body_text LIKE 'Booking networks%'", [
        tomas.view.item.id,
      ]),
    ).toEqual([[0]]);
    expect(await rows(s.db, "SELECT COUNT(*) FROM parties WHERE networks_off_at IS NOT NULL")).toEqual([[0]]);
  });
});

describe("a customer who has written many times", () => {
  it("is erased and stopped whole, not just the first hundred of their requests", async () => {
    const s = await setup();
    // A regular who writes every week for two years: each request by email is a party of its own.
    const ids: string[] = [];
    for (let i = 0; i < 110; i++) {
      const m = await s.caps.sendMessage(customer(T0 + i * MIN), {
        body: `Week ${i}: see you Thursday. Rita Carvalho`,
        contact: { name: "Rita Carvalho", email: "rita.carvalho@example.com" },
      });
      ids.push((m as { view: { item: { id: string } } }).view.item.id);
    }
    const first = await s.partyOf(ids[0] as string);
    const summary = await s.caps.customers.summary(owner(), { party_id: first });
    expect(summary.items).toBe(110);
    await s.caps.customers.stopNetworks(owner(T0 + 200 * MIN), { party_id: first });
    expect(await rows(s.db, "SELECT COUNT(*) FROM parties WHERE networks_off_at IS NULL")).toEqual([[0]]);
    const asked = await s.caps.customers.erase(owner(), { party_id: first }).catch((e) => e);
    await s.caps.customers.erase(owner(), { party_id: first, confirm: asked.details.confirm });
    expect(await rows(s.db, "SELECT COUNT(*) FROM parties WHERE erased_at IS NULL")).toEqual([[0]]);
    for (const [table, text] of Object.entries(await everything(s.db))) {
      expect(text.toLowerCase(), `her address in ${table}`).not.toContain("rita.carvalho@example.com");
      expect(text.toLowerCase(), `her name in ${table}`).not.toContain("carvalho");
    }
  }, 60_000);
});

describe("a stopped customer whose assistant holds a newer pass", () => {
  it("is asked about once, to find out whose it is, and never again", async () => {
    const s = await setup();
    const first = await s.book(customer(), { name: "Rita", email: "rita@example.com" });
    const party = await s.partyOf(first.view.item.id);
    await s.caps.customers.stopNetworks(owner(T0 + MIN), { party_id: party });
    // Her network gave her assistant a new pass since: the inbox cannot tell whose it is without asking.
    const NEWER = `sdpass1_net.example.com_${"n".repeat(16)}_${"w".repeat(32)}`;
    const calls = s.net.calls.length;
    const one = await s.book(customer(T0 + 2 * MIN), { name: "Rita" }, { pass: NEWER });
    expect(await s.partyOf(one.view.item.id)).toBe(party);
    expect(s.net.calls.length).toBe(calls + 1);
    // Now it knows: her next request with that pass is hers, and no network hears of it.
    const two = await s.book(customer(T0 + 3 * MIN), { name: "Rita" }, { pass: NEWER });
    expect(await s.partyOf(two.view.item.id)).toBe(party);
    expect(s.net.calls.length).toBe(calls + 1);
    await s.caps.getItemStatus(customer(T0 + 4 * MIN), { item_id: two.view.item.id, pass: NEWER });
    expect(s.net.calls.length).toBe(calls + 1);
    // A pass it has never seen, at the status door of her item: no network is asked about her item.
    const THIRD = `sdpass1_net.example.com_${"t".repeat(16)}_${"h".repeat(32)}`;
    await expect(
      s.caps.getItemStatus(customer(T0 + 5 * MIN), { item_id: two.view.item.id, pass: THIRD }),
    ).rejects.toBeDefined();
    expect(s.net.calls.length).toBe(calls + 1);
    // And what the network said of her is not kept.
    expect(await rows(s.db, "SELECT person FROM person_links WHERE party_id = ?", [party])).toEqual([[null]]);
  });
});

describe("erasing a customer who asked for a quote in their own words", () => {
  it("rewrites what they named as well as what they described", async () => {
    const s = await setup();
    const q = await s.caps.requestQuote(customer(), {
      payload: {
        itemOffered: { name: "Wedding cake for Rita Carvalho and Pedro" },
        description: "Three tiers, lemon, for our wedding.",
        requestedFor: new Date(T0 + 30 * DAY).toISOString(),
      },
      contact: { name: "Rita Carvalho", email: "rita.carvalho@example.com" },
    });
    const party = await s.partyOf(q.view.item.id);
    const asked = await s.caps.customers.erase(owner(), { party_id: party }).catch((e) => e);
    await s.caps.customers.erase(owner(), { party_id: party, confirm: asked.details.confirm });
    for (const [table, text] of Object.entries(await everything(s.db))) {
      expect(text.toLowerCase(), `her words in ${table}`).not.toContain("carvalho");
      expect(text.toLowerCase(), `her words in ${table}`).not.toContain("wedding");
    }
    // A line of an order they typed themselves (nothing in the catalogue) is their words too; its
    // quantity and price stay.
    const o = await s.caps.createOrder(customer(T0 + MIN), {
      payload: {
        orderedItem: [
          { name: "Engraving: Rita Carvalho, wedding day", quantity: 2, price: { value: 1_500, currency: "EUR" } },
        ],
        totalPrice: { value: 3_000, currency: "EUR" },
      },
      contact: { name: "R.", email: "rita.carvalho@example.com" },
    });
    const party2 = await s.partyOf(o.view.item.id);
    const again = await s.caps.customers.erase(owner(), { party_id: party2 }).catch((e) => e);
    await s.caps.customers.erase(owner(), { party_id: party2, confirm: again.details.confirm });
    for (const [table, text] of Object.entries(await everything(s.db))) {
      expect(text.toLowerCase(), `her words in ${table}`).not.toContain("carvalho");
    }
    const order = await s.caps.getItem(owner(), { item_id: o.view.item.id });
    expect(order.item.payload).toMatchObject({
      orderedItem: [{ name: "[erased]", quantity: 2, price: { value: 1_500, currency: "EUR" } }],
      totalPrice: { value: 3_000, currency: "EUR" },
    });
    // What kind of request it was, and when for, stay.
    const detail = await s.caps.getItem(owner(), { item_id: q.view.item.id });
    expect(detail.item).toMatchObject({ type: "quote_request", payload: { requestedFor: expect.any(String) } });
  });
});
