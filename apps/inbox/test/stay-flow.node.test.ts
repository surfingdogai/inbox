import { builtInConnectors, connectorHttp, createApiKey } from "@surfingdog/adapters";
import { addLocalDays, type Caller, type Db, dateIn, transitionItem } from "@surfingdog/core";
import { type LogMailOut, logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { API_KEY, genericPropertySystem } from "../../../packages/adapters/test/fakes/property/generic";
import { STRIPE_LIVE_KEY } from "../../../packages/adapters/test/fixtures/payments";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";
import { stripePlatform } from "./pay-platforms";

/**
 * Three places to stay, end to end through the inbox's own doors (ADR-033 §14): Kijani House in
 * Nairobi takes requests and is paid at the property (KES); Ryokan Hoshi in Kyoto writes every stay to
 * its own system first and takes a first-night deposit by Stripe (JPY); Maple Hollow B&B in Nova Scotia
 * keeps a room for direct guests, which confirms at once (CAD). Every figure is the example property's.
 */
const BASE = "https://inbox.example.com";
const SECRET_KEY = "stay-flow-secret-0123456789abcdef0123";
const HOUR = 3_600_000;

interface Setup {
  readonly db: Db;
  readonly inbox: ReturnType<typeof createInbox>;
  readonly mail: LogMailOut;
  readonly clock: { now: number };
  owner(method: string, path: string, body?: unknown): Response | Promise<Response>;
  guest(method: string, path: string, body?: unknown, token?: string): Response | Promise<Response>;
  drain(): Promise<void>;
}

async function setup(opts: {
  name: string;
  timezone: string;
  currency: string;
  property?: ReturnType<typeof genericPropertySystem>;
}): Promise<Setup & { stripe: ReturnType<typeof stripePlatform> }> {
  const db = await freshDb();
  const clock = { now: Date.now() };
  const mail = logMailOut();
  const stripe = stripePlatform(STRIPE_LIVE_KEY, BASE);
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const host = new URL(String(input instanceof Request ? input.url : input)).host;
    if (opts.property && host === "api.stays.example.com") return opts.property.platform.fetch(input, init);
    return stripe.fetch(input, init);
  }) as typeof fetch;
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    mailOut: mail,
    secretKey: SECRET_KEY,
    baseUrl: BASE,
    eventSettleMs: 0,
    background: (work) => void pending.push(work.catch(() => {})),
    fetchImpl,
    now: () => clock.now,
  });
  if (opts.property) {
    inbox.caps.connectors.attach({
      definitions: [...builtInConnectors({}), opts.property.definition],
      http: connectorHttp({ fetchImpl }),
    });
  }
  const key = (await createApiKey(db, { kind: "owner", name: "cli" })).key;
  const req = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    inbox.app.request(
      new Request(`${BASE}${path}`, {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const owner = (method: string, path: string, body?: unknown) =>
    req(method, path, { authorization: `Bearer ${key}` }, body);
  const guest = (method: string, path: string, body?: unknown, token?: string) =>
    req(method, path, token ? { "x-access-token": token } : {}, body);
  const drain = async () => {
    for (let i = 0; i < 30; i++) {
      // What a request started in the background first, then what is due.
      while (pending.length) await pending.shift();
      const at = Math.max(clock.now, Date.now());
      if ((await inbox.runner.runDue(db, { limit: 100, now: at, join: false })).claimed === 0 && !pending.length)
        return;
    }
  };
  const settings = await owner("PUT", "/v1/owner/settings", {
    doc: {
      business: { name: opts.name, currency: opts.currency, timezone: opts.timezone },
      email: { fromAddress: "stays@example.org" },
      notifications: { ownerEmail: "owner@example.org", appUrl: BASE },
    },
  });
  expect(settings.status, await settings.clone().text()).toBe(200);
  return { db, inbox, mail, clock, owner, guest, drain, stripe };
}

async function ok<T>(res: Promise<Response> | Response, status = 200): Promise<T> {
  const r = await res;
  const text = await r.clone().text();
  expect(r.status, text).toBe(status);
  return JSON.parse(text) as T;
}

const OWNER: Caller["actor"] = { kind: "owner", id: "user_1", channel: "owner_ui" };
const GUEST: Caller["actor"] = { kind: "customer_agent", id: "agent:test", channel: "rest" };

/** A caller on the test's clock: what the REST doors do with the real one. */
function at(s: Setup, actor: Caller["actor"]): Caller {
  return {
    actor,
    tier: actor.kind === "owner" ? "verified_principal" : "anonymous",
    sandbox: false,
    now: () => s.clock.now,
  };
}

type ItemBody = {
  view: { item: { id: string; state: string; payload: Record<string, unknown> } };
  accessToken?: string;
};

describe("Kijani House, Nairobi: request, quote, accept, stay, paid at the property (KES)", () => {
  it("goes from a request to a completed stay, with every email in the guest's words", async () => {
    const s = await setup({ name: "Kijani House", timezone: "Africa/Nairobi", currency: "KES" });
    const prop = await ok<{ id: string }>(
      s.owner("PUT", "/v1/owner/property", {
        name: "Kijani House",
        kind: "guesthouse",
        currency: "KES",
        check_in_from: "14:00",
        check_out_until: "11:00",
        answer_hours: 4,
      }),
    );
    const room = await ok<{ id: string }>(
      s.owner("POST", "/v1/owner/property/rooms", {
        name: "Garden double",
        units: 2,
        capacity: { adults: 2, children: 1, total: 3 },
        beds: [{ type: "double", count: 1 }],
      }),
    );
    const plan = await ok<{ id: string }>(
      s.owner("POST", "/v1/owner/property/rate-plans", {
        name: "Bed and breakfast",
        meal: "breakfast",
        policy: { preset: "free_until", days: 2, after: "first_night", no_show: "first_night" },
        deposit: { kind: "none" },
      }),
    );
    await ok(
      s.owner("PUT", "/v1/owner/property/rates", {
        rate_plan_id: plan.id,
        room_type_id: room.id,
        nightly: 650_000,
        base_guests: 2,
      }),
    );
    void prop;
    // The manifest says this inbox takes stays, and how.
    const manifest = await ok<{ item_types: string[]; stay?: { mode: string; secure: string[] } }>(
      s.guest("GET", "/.well-known/agent-inbox.json"),
    );
    expect(manifest.item_types).toContain("stay");
    expect(manifest.stay).toMatchObject({ mode: "request", secure: ["at_property"] });

    const checkIn = addLocalDays(dateIn(s.clock.now, "Africa/Nairobi"), 30);
    const checkOut = addLocalDays(checkIn, 3);
    const avail = await ok<{ options: { status: string; estimate?: { total: { value: number } } }[] }>(
      s.guest("GET", `/v1/stays/availability?check_in=${checkIn}&check_out=${checkOut}&adults=2`),
    );
    expect(avail.options[0]).toMatchObject({ status: "on_request", estimate: { total: { value: 1_950_000 } } });
    const made = await ok<ItemBody>(
      s.guest("POST", "/v1/stays", {
        check_in: checkIn,
        check_out: checkOut,
        rooms: [{ room_type_id: room.id, adults: 2 }],
        contact: { name: "Amara O.", email: "amara@example.org", locale: "sw" },
        consent: true,
        idempotency_key: "kijani-1",
      }),
      201,
    );
    const id = made.view.item.id;
    const token = made.accessToken as string;
    await ok(s.owner("POST", `/v1/owner/items/${id}/transitions`, { event: "quote", input: { from: "rates" } }));
    await s.drain();
    const quoteMail = s.mail.sent.find(
      (m) => m.to.includes("amara@example.org") && /Your stay at Kijani House/.test(m.subject),
    );
    expect(quoteMail?.text).toContain("Your booking is with Kijani House.");
    // Customers never read our words: not in the email, links aside (they are the property's own address).
    expect(quoteMail?.text.replace(/https:\/\/\S+/g, "")).not.toMatch(/Surfing Dog|network|receipt|inbox|reputation/i);
    // The guest's assistant accepts on the terms their person saw.
    const asked = await s.guest("POST", `/v1/items/${id}/accept`, { access_token: token });
    expect(asked.status).toBe(409);
    const sha = ((await asked.json()) as { details: { terms_sha: string } }).details.terms_sha;
    const accepted = await ok<{ view: { item: { state: string } } }>(
      s.guest("POST", `/v1/items/${id}/accept`, { access_token: token, terms_sha: sha }),
    );
    expect(accepted.view.item.state).toBe("confirmed");
    await s.drain();
    const booked = s.mail.sent.find(
      (m) => m.to.includes("amara@example.org") && /^Booked: Kijani House/.test(m.subject),
    );
    expect(booked?.text).toContain(
      "This is your booking confirmation, not an invoice. Kijani House issues your invoice.",
    );
    // The guest's status shows what is paid at the property and what cancelling costs now.
    const status = await ok<{
      stay: { payments: { status: string; amount: { value: number } }[]; cancel: { fee: { value: number } } };
    }>(s.guest("GET", `/v1/items/${id}?access_token=${token}`));
    expect(status.stay.payments).toEqual([
      expect.objectContaining({ status: "at_property", amount: { value: 1_950_000, currency: "KES" } }),
    ]);
    expect(status.stay.cancel.fee.value).toBe(0);
    // After check-out the sweep completes it.
    s.clock.now += 34 * 24 * HOUR;
    await s.drain();
    const done = await ok<{ item: { state: string } }>(s.owner("GET", `/v1/owner/items/${id}`));
    expect(done.item.state).toBe("completed");
  });
});

describe("Ryokan Hoshi, Kyoto: written to its own system first, a first-night deposit by Stripe (JPY)", () => {
  it("writes the first stay after the guest says yes, then holds and books at once from the system", async () => {
    const system = genericPropertySystem({
      name: "Ryokan Hoshi",
      currency: "JPY",
      timezone: "Asia/Tokyo",
      rooms: [{ id: "R1", name: "Japanese room", units: 2, prices: { FLEX: 25_800 } }],
    });
    const s = await setup({ name: "Ryokan Hoshi", timezone: "Asia/Tokyo", currency: "JPY", property: system });
    const stripe = await s.owner("POST", "/v1/owner/integrations", {
      kind: "stripe",
      values: { api_key: STRIPE_LIVE_KEY },
    });
    expect(stripe.status, await stripe.clone().text()).toBe(201);
    const conn = await ok<{ id: string }>(
      s.owner("POST", "/v1/owner/integrations", { kind: "fake_property", values: { api_key: API_KEY } }),
      201,
    );
    const mapped = await ok<{ property_id: string; rooms: number }>(
      s.owner("POST", "/v1/owner/property/system", {
        connector_id: conn.id,
        external_property_id: "P1",
        rooms: [{ external_id: "R1", room_type_id: "new" }],
      }),
    );
    expect(mapped.rooms).toBe(1);
    const setupView = await ok<{ setup: { rooms: { id: string }[]; property: { currency: string } } }>(
      s.owner("GET", "/v1/owner/property"),
    );
    const room = setupView.setup.rooms[0]?.id as string;
    const plan = await ok<{ id: string }>(
      s.owner("POST", "/v1/owner/property/rate-plans", {
        name: "Flexible with breakfast",
        meal: "breakfast",
        external_id: "FLEX",
        policy: { preset: "free_until", days: 3, after: "first_night", no_show: "full" },
        deposit: { kind: "first_night" },
      }),
    );
    await ok(
      s.owner("PUT", "/v1/owner/property/rates", {
        rate_plan_id: plan.id,
        room_type_id: room,
        nightly: 25_800,
        base_guests: 2,
      }),
    );
    // Confirming at once from the system waits for a first stay written and read back.
    const locked = await s.owner("PUT", "/v1/owner/property", {
      id: mapped.property_id,
      mode: "connected",
      instant: true,
    });
    expect(locked.status).toBe(409);
    await ok(s.owner("PUT", "/v1/owner/property", { id: mapped.property_id, mode: "connected" }));
    await ok(s.owner("POST", "/v1/owner/property/sync", {}));

    const checkIn = addLocalDays(dateIn(s.clock.now, "Asia/Tokyo"), 40);
    const checkOut = addLocalDays(checkIn, 3);
    const made = await ok<ItemBody>(
      s.guest("POST", "/v1/stays", {
        check_in: checkIn,
        check_out: checkOut,
        rooms: [{ room_type_id: room, adults: 2 }],
        contact: { name: "Maria A.", email: "maria@example.org", locale: "en" },
        consent: true,
        idempotency_key: "hoshi-1",
      }),
      201,
    );
    const id = made.view.item.id;
    const token = made.accessToken as string;
    await ok(s.owner("POST", `/v1/owner/items/${id}/transitions`, { event: "quote", input: { from: "rates" } }));
    const asked = await s.guest("POST", `/v1/items/${id}/accept`, { access_token: token });
    const sha = ((await asked.json()) as { details: { terms_sha: string } }).details.terms_sha;
    const booking = await ok<{ view: { item: { state: string } } }>(
      s.guest("POST", `/v1/items/${id}/accept`, { access_token: token, terms_sha: sha }),
    );
    // Nothing is promised until the system took it.
    expect(booking.view.item.state).toBe("booking");
    await s.drain();
    const written = await ok<{ item: { state: string; payload: { external?: { externalId: string } } } }>(
      s.owner("GET", `/v1/owner/items/${id}`),
    );
    expect(written.item.state).toBe("awaiting_payment");
    expect(written.item.payload.external?.externalId).toBe("B1");
    expect([...system.bookings.values()][0]).toMatchObject({ reference: `sd-${id}`, status: "provisional" });
    // The deposit's link, for the first night, in yen, titled in the property's own words.
    const [link] = [...s.stripe.links.values()];
    expect(link).toMatchObject({ amount: 25_800, currency: "jpy" });
    expect(link?.name).toMatch(/^Ryokan Hoshi · 3 nights from .+ \([0-9A-Z]{6}\) · deposit$/);
    const paid = await s.inbox.app.request(await s.stripe.pay(link?.id ?? ""));
    expect(paid.status).toBe(200);
    await s.drain();
    const confirmed = await ok<{ item: { state: string } }>(s.owner("GET", `/v1/owner/items/${id}`));
    expect(confirmed.item.state).toBe("confirmed");

    // Now the system has taken a stay this inbox wrote: confirming at once is unlocked.
    await ok(s.owner("PUT", "/v1/owner/property", { id: mapped.property_id, instant: true }));
    await ok(s.owner("POST", "/v1/owner/property/sync", {}));
    const held = await ok<ItemBody & { terms_sha: string }>(
      s.guest("POST", "/v1/stays/holds", {
        check_in: checkIn,
        check_out: checkOut,
        rooms: [{ room_type_id: room, adults: 2 }],
        contact: { name: "Kenji T.", email: "kenji@example.org", locale: "en" },
        consent: true,
        idempotency_key: "hoshi-hold-1",
      }),
      201,
    );
    expect(held.view.item.state).toBe("held");
    const booked = await ok<{ view: { item: { state: string } } }>(
      s.guest("POST", "/v1/stays/book", {
        item_id: held.view.item.id,
        terms_sha: held.terms_sha,
        access_token: held.accessToken,
      }),
    );
    expect(booked.view.item.state).toBe("booking");
    await s.drain();
    // The last room of those nights is now the system's second booking: no third.
    expect(system.free("R1", checkIn)).toBe(0);
    const third = await s.guest("POST", "/v1/stays/holds", {
      check_in: checkIn,
      check_out: checkOut,
      rooms: [{ room_type_id: room, adults: 2 }],
      contact: { name: "Third G.", email: "third@example.org" },
      consent: true,
    });
    expect(third.status).toBe(409);
    // Check in and out, on the day (the owner at the desk, on the property's clock).
    s.clock.now = Date.parse(`${checkIn}T07:00:00Z`);
    await transitionItem(s.db, at(s, OWNER), { itemId: id, event: "check_in" });
    await transitionItem(s.db, at(s, OWNER), { itemId: id, event: "check_out" });
    const after = await ok<{ item: { state: string } }>(s.owner("GET", `/v1/owner/items/${id}`));
    expect(after.item.state).toBe("completed");
  });
});

describe("Maple Hollow B&B, Nova Scotia: a room kept for direct guests (CAD)", () => {
  it("holds and books at once, changes the dates, then cancels with the fee and owes back what was paid", async () => {
    const s = await setup({ name: "Maple Hollow B&B", timezone: "America/Halifax", currency: "CAD" });
    const prop = await ok<{ id: string }>(
      s.owner("PUT", "/v1/owner/property", {
        name: "Maple Hollow B&B",
        kind: "bnb",
        currency: "CAD",
        check_in_from: "16:00",
        check_out_until: "11:00",
        mode: "allotment",
      }),
    );
    const room = await ok<{ id: string }>(
      s.owner("POST", "/v1/owner/property/rooms", {
        name: "Harbour room",
        units: 4,
        capacity: { adults: 2, children: 0, total: 2 },
        beds: [{ type: "queen", count: 1 }],
      }),
    );
    const plan = await ok<{ id: string }>(
      s.owner("POST", "/v1/owner/property/rate-plans", {
        name: "Flexible",
        meal: "breakfast",
        policy: { preset: "free_until", days: 7, after: "first_night", no_show: "full" },
        deposit: { kind: "full" },
      }),
    );
    await ok(
      s.owner("PUT", "/v1/owner/property/rates", {
        rate_plan_id: plan.id,
        room_type_id: room.id,
        nightly: 18_900,
        base_guests: 2,
      }),
    );
    const today = dateIn(s.clock.now, "America/Halifax");
    await ok(
      s.owner("PUT", "/v1/owner/property/allotments", {
        room_type_id: room.id,
        from_date: today,
        to_date: addLocalDays(today, 120),
        units: 1,
        closed_elsewhere: true,
      }),
    );
    void prop;
    const checkIn = addLocalDays(today, 10);
    const checkOut = addLocalDays(checkIn, 2);
    const held = await ok<ItemBody & { terms_sha: string }>(
      s.guest("POST", "/v1/stays/holds", {
        check_in: checkIn,
        check_out: checkOut,
        rooms: [{ room_type_id: room.id, adults: 2 }],
        contact: { name: "Jean B.", email: "jean@example.org", locale: "fr" },
        consent: true,
      }),
      201,
    );
    const token = held.accessToken as string;
    const id = held.view.item.id;
    // Everything paid now, with nobody to take it: the guest waits on a payment the owner records.
    const booked = await ok<{ view: { item: { state: string } } }>(
      s.guest("POST", "/v1/stays/book", { item_id: id, terms_sha: held.terms_sha, access_token: token }),
    );
    expect(booked.view.item.state).toBe("awaiting_payment");
    await ok(
      s.owner("POST", `/v1/owner/items/${id}/transitions`, {
        event: "record_payment",
        input: { paymentRef: "e-transfer 4411" },
      }),
    );
    // A change of dates while cancelling is free: the property says yes.
    const newIn = addLocalDays(checkIn, 1);
    const asked = await s.guest("POST", `/v1/stays/${id}/change`, {
      check_in: newIn,
      check_out: addLocalDays(newIn, 2),
      access_token: token,
    });
    expect(asked.status).toBe(409);
    const sha = ((await asked.json()) as { details: { terms_sha: string } }).details.terms_sha;
    await ok(
      s.guest("POST", `/v1/stays/${id}/change`, {
        check_in: newIn,
        check_out: addLocalDays(newIn, 2),
        terms_sha: sha,
        access_token: token,
      }),
    );
    await ok(s.owner("POST", `/v1/owner/items/${id}/transitions`, { event: "accept_change" }));
    const moved = await ok<{ item: { payload: { checkIn: string } } }>(s.owner("GET", `/v1/owner/items/${id}`));
    expect(moved.item.payload.checkIn).toBe(newIn);
    // Inside the seven days: the first night is the fee, and the rest of what was paid is owed back.
    s.clock.now = Date.parse(`${addLocalDays(newIn, -3)}T15:00:00Z`);
    const guest: Caller = { ...at(s, GUEST), accessToken: token };
    const fee = await s.inbox.caps.cancelItem(guest, { item_id: id }).catch((e: unknown) => e);
    expect((fee as { code?: string }).code).toBe("confirm_terms");
    const d = (fee as { details: { fee: { value: number }; refund: { value: number }; fee_sha: string } }).details;
    expect(d.fee.value).toBe(18_900);
    expect(d.refund.value).toBe(18_900);
    const cancelled = await s.inbox.caps.cancelItem(guest, { item_id: id, fee_sha: d.fee_sha });
    expect(cancelled.view.item.state).toBe("cancelled_by_guest");
    const refunds = await ok<{
      items: { item: { type: string; state: string; payload: { amount: { value: number } } } }[];
    }>(s.owner("GET", "/v1/owner/items?type=refund&open_only=false"));
    expect(refunds.items.map((r) => [r.item.type, r.item.state, r.item.payload.amount.value])).toEqual([
      ["refund", "approved", 18_900],
    ]);
  });
});
