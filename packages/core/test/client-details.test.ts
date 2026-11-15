import { logMailOut, runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import type { Contact } from "../src/domain/types";
import type { IdentityPort } from "../src/identity/types";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import {
  type Caller,
  clientEmail,
  clientName,
  clientPhone,
  createItem,
  transitionItem,
  WriteError,
} from "../src/write/index";
import { aProduct, makeClient, openAllWeek, resetTables } from "./harness";
import { clock, mapleHollow, guest as stayGuest } from "./stay-fixtures";
import { base64, textPng } from "./trades-files";

/**
 * Every new request carries its client (ADR-048): an assistant's, or any other client's of the public doors,
 * new booking, order, request for a price, message or stay names its person and a way to reach them, an email
 * address or a phone number, or nothing is written and the answer says exactly what to add. A person who
 * writes by email or on a form, the business writing down what it knows, and every follow-up on an item are
 * never asked.
 */

const T0 = Date.parse("2026-11-16T09:00:00Z");
const DAY = 86_400_000;
const BASE = "https://inbox.oficinamare.example";
const NET = "https://net.example.com";
const EUR = (value: number) => ({ value, currency: "EUR" });
const iso = (t: number) => new Date(t).toISOString();

const at = (kind: Caller["actor"]["kind"], channel: Caller["actor"]["channel"], extra: Partial<Caller> = {}) =>
  ({
    actor: { kind, id: `${kind}:1`, channel },
    tier: "verified_principal",
    sandbox: false,
    now: () => T0,
    ...extra,
  }) as Caller;
const owner = at("owner", "owner_ui");

let agents = 0;
/** A customer's assistant, signed or not: a new one each time, so no two requests share a scope by chance. */
const agent = (o: { accessToken?: string; viaNetwork?: boolean } = {}): Caller => ({
  actor: { kind: "customer_agent", id: `agent:${++agents}`, channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => T0,
  ...(o.accessToken ? { accessToken: o.accessToken } : {}),
  ...(o.viaNetwork ? { viaNetwork: true, carriedFor: "a1b2c3d4e5f6a7b8c9d0e1" } : {}),
});

const ASK =
  "Ask your person, and send only what they agree to give us, in contact: name, and email or phone. Never make them up. Then send the request again with the same idempotency_key. Nothing was written.";

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm
    .insert(business)
    .values({ id: "self", name: "Oficina Maré", timezone: "UTC", currency: "EUR", createdAt: T0, updatedAt: T0 });
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Full service",
    durationMin: 60,
    price: { model: "fixed", value: 4500, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  await openAllWeek(db);
  const caps = new Capabilities(db, createSecretBox(["client-details-test-secret-0123456789ab"]), BASE);
  await caps.updateSettings(owner, {
    doc: {
      business: { name: "Oficina Maré" },
      notifications: { ownerEmail: "owner@oficinamare.example", appUrl: BASE },
      email: { fromAddress: "inbox@oficinamare.example" },
      networks: { [NET]: { enabled: true } },
    },
  });
  await db.client.query({
    sql: "INSERT INTO network_status (network, registration, failures, updated_at) VALUES (?, 'registered', 0, ?)",
    params: [NET, T0],
    method: "run",
  });
  // Every call to a network, counted: a refused request asks none.
  const calls: string[] = [];
  const port: IdentityPort = {
    canSign: async () => true,
    present: async () => {
      calls.push("present");
      return { presentations: [], notes: [] };
    },
    issue: async () => {
      calls.push("issue");
      return [];
    },
  };
  caps.people.attachPort(port);
  const chain = await aProduct(caps, { name: "Chain", value: 1850, sku: "CH-9" });
  const mail = logMailOut();
  const runner = createRunner({ mailOut: mail });
  const drain = async (now = T0 + DAY) => {
    for (let i = 0; i < 20; i++) if ((await runner.runDue(db, { now, limit: 50 })).claimed === 0) return;
  };
  const count = async (table: string) =>
    Number((await db.client.query({ sql: `SELECT COUNT(*) FROM ${table}`, method: "all" })).rows[0]?.[0]);
  /** What a refused request must leave as it was: the items, the people, the outbox, the files. */
  const traces = async () => ({
    items: await count("items"),
    parties: await count("parties"),
    jobs: await count("jobs"),
    mail: await count("outbound_mail"),
    files: await count("blobs"),
  });
  return { db, caps, svc, chain, calls, mail, drain, traces };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function refused(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected a WriteError");
}

const booking = (s: Setup, start = T0 + 3 * DAY) => ({
  reservationFor: { serviceId: s.svc, name: "Full service" },
  startTime: iso(start),
  endTime: iso(start + 60 * 60_000),
});

/** Every create an assistant makes, each with the details given. */
const creates = (s: Setup) =>
  ({
    quote_request: (contact?: Contact) =>
      s.caps.requestQuote(agent(), {
        payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel, 28 spokes" },
        attachments: [{ data_base64: base64(textPng()) }],
        ...(contact ? { contact } : {}),
      }),
    booking: (contact?: Contact) =>
      s.caps.createBooking(agent(), { payload: booking(s), ...(contact ? { contact } : {}) } as never),
    order: (contact?: Contact) =>
      s.caps.createOrder(agent(), {
        payload: { orderedItem: [{ productId: s.chain, quantity: 1 }] },
        ...(contact ? { contact } : {}),
      } as never),
    message: (contact?: Contact) =>
      s.caps.sendMessage(agent(), { body: "Do you true wheels?", ...(contact ? { contact } : {}) }),
  }) as const;

/** The details an assistant may bring, and what the refusal says of each. */
const CASES: readonly {
  readonly sent: Contact | undefined;
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
  readonly fields: readonly { path: string; problem: string; message: string }[];
  readonly first: (what: string) => string;
}[] = [
  {
    sent: undefined,
    missing: ["name", "email_or_phone"],
    invalid: [],
    fields: [
      { path: "contact.name", problem: "missing", message: "your person's name, as they give it" },
      { path: "contact.email", problem: "missing", message: "an email address, or a phone number in contact.phone" },
    ],
    first: (what) =>
      `To take ${what} we need your person's name, and an email address or a phone number to answer them.`,
  },
  {
    sent: {},
    missing: ["name", "email_or_phone"],
    invalid: [],
    fields: [
      { path: "contact.name", problem: "missing", message: "your person's name, as they give it" },
      { path: "contact.email", problem: "missing", message: "an email address, or a phone number in contact.phone" },
    ],
    first: (what) =>
      `To take ${what} we need your person's name, and an email address or a phone number to answer them.`,
  },
  {
    sent: { name: "Rita" },
    missing: ["email_or_phone"],
    invalid: [],
    fields: [
      { path: "contact.email", problem: "missing", message: "an email address, or a phone number in contact.phone" },
    ],
    first: (what) => `To take ${what} we need an email address or a phone number to answer your person.`,
  },
  {
    sent: { email: "rita@example.com" },
    missing: ["name"],
    invalid: [],
    fields: [{ path: "contact.name", problem: "missing", message: "your person's name, as they give it" }],
    first: (what) => `To take ${what} we need your person's name.`,
  },
  {
    sent: { name: "1234", email: "rita@example.com" },
    missing: [],
    invalid: ["name"],
    fields: [{ path: "contact.name", problem: "invalid", message: "a name, with a letter in it and no email address" }],
    first: (what) => `To take ${what} we need your person's details as they give them. contact.name is not a name.`,
  },
  {
    sent: { name: "Rita", phone: "call me" },
    missing: [],
    invalid: ["phone"],
    fields: [{ path: "contact.phone", problem: "invalid", message: "a phone number with 6 to 20 digits" }],
    first: (what) =>
      `To take ${what} we need your person's details as they give them. contact.phone is not a phone number.`,
  },
];

const WHAT = {
  quote_request: "this request for a price",
  booking: "this booking",
  order: "this order",
  message: "this message",
  stay: "this stay",
} as const;

describe("what counts as a client's details", () => {
  it("is a name with a letter and no address, an address a business can write to, a number with 6 to 20 digits", () => {
    for (const name of ["Rita Silva", "R", "María López", "  Rita  "]) expect(clientName(name), name).toBe(name.trim());
    for (const name of ["", "   ", "1234", "rita@example.com", "x".repeat(201), 42, undefined]) {
      expect(clientName(name), String(name)).toBeNull();
    }
    expect(clientEmail("rita@example.com")).toBe("rita@example.com");
    expect(clientEmail(" rita@example.com ")).toBe("rita@example.com");
    for (const email of ["", "rita@localhost", "Ana <ana@example.com>", "rita", "@example.com", 7]) {
      expect(clientEmail(email), String(email)).toBeNull();
    }
    for (const phone of ["+351 912 345 678", "514-555-0199", "(02) 9374 4000"]) expect(clientPhone(phone)).toBe(phone);
    for (const phone of ["", "call me", "+1 902", "12345", "+351 912 345 678 ext 5", "1".repeat(21)]) {
      expect(clientPhone(phone), phone).toBeNull();
    }
  });
});

describe("an assistant's new request without its client", () => {
  it("is refused on every create, saying exactly what to add, before anything is kept, shown or asked", async () => {
    const s = await setup();
    const before = await s.traces();
    for (const [type, create] of Object.entries(creates(s)) as [
      keyof typeof WHAT,
      (c?: Contact) => Promise<unknown>,
    ][]) {
      for (const c of CASES) {
        const e = await refused(create(c.sent));
        const label = `${type} ${JSON.stringify(c.sent)}`;
        expect(e.code, label).toBe("invalid_input");
        expect(e.status, label).toBe(422);
        expect(e.message, label).toBe(`${c.first(WHAT[type])} ${ASK}`);
        expect(e.details, label).toEqual({
          reason: "client_details",
          item_type: type,
          missing: c.missing,
          invalid: c.invalid,
        });
        expect(e.fields, label).toEqual(c.fields);
      }
    }
    // The priced booking was refused, never shown its summary to confirm; the request's photo was not kept;
    // no network was asked; nothing was written or queued.
    expect(await s.traces()).toEqual(before);
    expect(s.calls).toEqual([]);
  });

  it("answers the order that came with no one's details as the business would, word for word", async () => {
    const s = await setup();
    // As it arrived: a product the business does not sell, at a price and in a currency the sender chose.
    const e = await refused(
      s.caps.createOrder(agent(), {
        payload: {
          orderedItem: [{ name: "audit-fixturex", quantity: 1, price: { value: 1, currency: "AUD" } }],
          totalPrice: { value: 1, currency: "AUD" },
        },
      } as never),
    );
    expect(e.message).toBe(
      "To take this order we need your person's name, and an email address or a phone number to answer them. Ask your person, and send only what they agree to give us, in contact: name, and email or phone. Never make them up. Then send the request again with the same idempotency_key. Nothing was written.",
    );
    expect(e.fields?.map((f) => `${f.path} (${f.problem})`)).toEqual([
      "contact.name (missing)",
      "contact.email (missing)",
    ]);
  });

  it("is refused for a stay, held or asked for, before the property's system is asked", async () => {
    clock.now = Date.parse("2026-11-02T13:00:00Z");
    const m = await mapleHollow();
    const ask = {
      check_in: "2026-12-04",
      check_out: "2026-12-06",
      rooms: [{ room_type_id: m.rooms.harbour, adults: 2 }],
      consent: true as const,
    };
    const items = async () =>
      Number((await m.db.client.query({ sql: "SELECT COUNT(*) FROM items", method: "all" })).rows[0]?.[0]);
    for (const c of CASES) {
      for (const door of [m.caps.stays.request.bind(m.caps.stays), m.caps.stays.hold.bind(m.caps.stays)]) {
        const e = await refused(door(stayGuest(), { ...ask, ...(c.sent ? { contact: c.sent } : {}) }));
        expect(e.message).toBe(`${c.first("this stay")} ${ASK}`);
        expect(e.details).toEqual({
          reason: "client_details",
          item_type: "stay",
          missing: c.missing,
          invalid: c.invalid,
        });
      }
    }
    expect(await items()).toBe(0);
    // With a name and a number, the room is held.
    const held = await m.caps.stays.hold(stayGuest(), { ...ask, contact: { name: "Amara", phone: "+1 902 555 0147" } });
    expect(held.view.item.state).toBe("held");
  });

  it("is refused when a network says it carried it: the header grants nothing", async () => {
    const s = await setup();
    const e = await refused(
      s.caps.sendMessage(agent({ viaNetwork: true }), {
        body: "Are you open on Saturday?",
        contact: { email: "ana@example.com" },
      }),
    );
    expect(e.details).toMatchObject({ reason: "client_details", missing: ["name"] });
    expect(await s.traces()).toMatchObject({ items: 0 });
  });

  it("is refused for a table too big to book, and for a site visit, as for any booking", async () => {
    const s = await setup();
    // A site visit for a request this customer made: the visit is a booking like any other.
    const q = await s.caps.requestQuote(agent(), {
      payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel" },
      contact: { name: "Rita", email: "rita@example.com" },
    });
    const visit = await refused(
      s.caps.createBooking(agent({ accessToken: q.accessToken as string }), {
        payload: booking(s),
        visit_for: { item_id: q.view.item.id, access_token: q.accessToken },
      } as never),
    );
    expect(visit.details).toMatchObject({ reason: "client_details", item_type: "booking" });
    // A table for more than the business books online becomes a request for a price: asked the same.
    const tables = ulid();
    await s.db.orm.insert(services).values({
      id: tables,
      name: "Table",
      durationMin: 90,
      capacity: 40,
      capacityUnit: "people",
      createdAt: T0,
      updatedAt: T0,
    });
    const party = {
      reservationFor: { serviceId: tables, name: "Table" },
      startTime: iso(T0 + 3 * DAY),
      endTime: iso(T0 + 3 * DAY + 90 * 60_000),
      partySize: 40,
    };
    const table = await refused(s.caps.createBooking(agent(), { payload: party } as never));
    expect(table.details).toMatchObject({ reason: "client_details", item_type: "booking" });
    expect(await s.traces()).toMatchObject({ items: 1 });
    // With its person's details, it is the request for a price it always was.
    const asked = await s.caps.createBooking(agent(), {
      payload: party,
      contact: { name: "Rita", email: "rita@example.com" },
    } as never);
    expect(asked.view.item.type).toBe("quote_request");
  });
});

describe("an assistant's new request with its client", () => {
  it("is taken with a name and a phone alone: no email goes out to the person, and no network is asked", async () => {
    const s = await setup();
    const contact = { name: "Rita", phone: "+351 912 345 678" };
    const made = [
      await s.caps.requestQuote(agent(), {
        payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel" },
        contact,
      }),
      await s.caps.sendMessage(agent(), { body: "Do you true wheels?", contact }),
    ];
    const asked = await refused(s.caps.createBooking(agent(), { payload: booking(s), contact } as never));
    expect(asked.code).toBe("confirm_terms");
    const booked = await s.caps.createBooking(agent(), {
      payload: booking(s),
      contact,
      terms_sha: (asked.details as { terms_sha: string }).terms_sha,
    } as never);
    expect(booked.view.item.state).toBe("requested");
    for (const m of made) expect("view" in m && m.view.item.id).toBeTruthy();
    await s.drain();
    expect(s.calls).toEqual([]);
    expect(s.mail.sent.filter((m) => !m.to.includes("owner@oficinamare.example"))).toEqual([]);
  });

  it("answers a retry of a request stored before, without its client, as it was", async () => {
    const s = await setup();
    const scoped = agent();
    const key = "retry-1";
    const stored = await createItem(
      s.db,
      { ...scoped, idempotency: { scope: `customer_agent:${scoped.actor.id}:rest`, key } },
      {
        type: "message",
        payload: { text: "Do you true wheels?", subject: undefined },
        contact: undefined,
        message: "Do you true wheels?",
        messageId: undefined,
      },
    );
    const again = await s.caps.sendMessage(scoped, { body: "Do you true wheels?", idempotency_key: key });
    expect("replayed" in again && again.replayed).toBe(true);
    expect("view" in again && again.view.item.id).toBe(stored.view.item.id);
  });
});

describe("who is never asked", () => {
  it("the business, writing down what it knows: the owner, staff, its AI, its keys, a connector, a rule, the system", async () => {
    const s = await setup();
    const integration = at("integration", "rest", {
      principal: { via: "api_key", id: "key_1", name: "Till", scopes: ["*"], userId: null, keyKind: "integration" },
    });
    const callers = [
      owner,
      at("staff", "owner_ui"),
      at("owner_ai", "mcp_owner", { actsAs: "owner" }),
      integration,
      at("connector", "connector"),
      at("rule", "system"),
      at("system", "system"),
    ];
    let start = T0 + 3 * DAY;
    for (const caller of callers) {
      const kind = caller.actor.kind;
      start += 2 * 60 * 60_000;
      const b = await s.caps.createBooking(caller, { payload: booking(s, start) } as never);
      expect(b.view.item.type, kind).toBe("booking");
      const o = await s.caps.createOrder(caller, {
        payload: { orderedItem: [{ name: "Fitting", quantity: 1, price: EUR(1000) }], totalPrice: EUR(1000) },
      } as never);
      expect(o.view.item.type, kind).toBe("order");
      const q = await s.caps.requestQuote(caller, {
        payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel" },
      });
      expect(q.view.item.type, kind).toBe("quote_request");
    }
  });

  it("a person who writes by email or on a form, with no name", async () => {
    const s = await setup();
    const byEmail = at("customer_human", "email", { tier: "anonymous" });
    const byForm = at("customer_human", "form", { tier: "anonymous" });
    const mail = await s.caps.sendMessage(byEmail, { body: "Hello", contact: { email: "rita@example.com" } });
    const form = await s.caps.sendMessage(byForm, { body: "Hello" });
    expect("view" in mail && mail.view.item.type).toBe("message");
    expect("view" in form && form.view.item.type).toBe("message");
  });

  it("a follow-up on an item that has its client: a reply, details, a quote taken, a withdrawal, a return, a cancellation", async () => {
    const s = await setup();
    const contact = { name: "Rita", email: "rita@example.com" };
    // A reply on a conversation.
    const started = (await s.caps.sendMessage(agent(), { body: "Do you true wheels?", contact })) as {
      view: { item: { id: string } };
      accessToken: string;
    };
    const reply = await s.caps.sendMessage(agent({ accessToken: started.accessToken }), {
      item_id: started.view.item.id,
      body: "And spokes?",
      access_token: started.accessToken,
    });
    expect(reply).toBeTruthy();
    // Details the business asked for.
    const q = await s.caps.requestQuote(agent(), {
      payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel" },
      contact,
    });
    const token = q.accessToken as string;
    await transitionItem(s.db, owner, { itemId: q.view.item.id, event: "request_info", input: { note: "How many?" } });
    const details = await s.caps.customer.provideDetails(agent({ accessToken: token }), {
      item_id: q.view.item.id,
      details: "Twenty-eight",
      access_token: token,
    });
    expect(details.view.item.state).not.toBe("needs_info");
    // A quote taken: the order it becomes copies the request's client.
    await transitionItem(s.db, owner, {
      itemId: q.view.item.id,
      event: "quote",
      input: { totalPrice: EUR(31_000), lines: [{ name: "Build", quantity: 1, price: EUR(31_000) }] },
    });
    const asked = await refused(
      s.caps.customer.acceptOffer(agent({ accessToken: token }), { item_id: q.view.item.id, access_token: token }),
    );
    const taken = await s.caps.customer.acceptOffer(agent({ accessToken: token }), {
      item_id: q.view.item.id,
      access_token: token,
      terms_sha: (asked.details as { terms_sha: string }).terms_sha,
    });
    expect("linked" in taken && taken.linked?.item.type).toBe("order");
    // A paid order withdrawn from, another returned once delivered, a booking cancelled.
    const paid = async () => {
      const made = await refused(
        s.caps.createOrder(agent(), {
          payload: { orderedItem: [{ productId: s.chain, quantity: 1 }] },
          contact,
        } as never),
      );
      const o = await s.caps.createOrder(agent(), {
        payload: { orderedItem: [{ productId: s.chain, quantity: 1 }] },
        contact,
        terms_sha: (made.details as { terms_sha: string }).terms_sha,
      } as never);
      await transitionItem(s.db, owner, { itemId: o.view.item.id, event: "accept" });
      await transitionItem(s.db, owner, {
        itemId: o.view.item.id,
        event: "record_payment",
        input: { paymentRef: "pi_1", amount: EUR(1850) },
      });
      return { id: o.view.item.id, token: o.accessToken as string };
    };
    const one = await paid();
    const withdrawn = await s.caps.customer.withdraw(agent({ accessToken: one.token }), {
      item_id: one.id,
      access_token: one.token,
      confirm_withdrawal: true,
    });
    expect(withdrawn).toBeTruthy();
    const two = await paid();
    await transitionItem(s.db, owner, { itemId: two.id, event: "fulfil", input: { deliveredAt: iso(T0) } });
    const back = await s.caps.customer.requestReturn(agent({ accessToken: two.token }), {
      item_id: two.id,
      access_token: two.token,
      reason: "faulty",
    });
    expect(back.linked?.item.type).toBe("refund");
    const sure = await refused(s.caps.createBooking(agent(), { payload: booking(s), contact } as never));
    const b = await s.caps.createBooking(agent(), {
      payload: booking(s),
      contact,
      terms_sha: (sure.details as { terms_sha: string }).terms_sha,
    } as never);
    const cancelled = await s.caps.cancelItem(agent({ accessToken: b.accessToken as string }), {
      item_id: b.view.item.id,
      access_token: b.accessToken as string,
    });
    expect(cancelled.view.item.state).toBe("cancelled_by_customer");
  });
});
