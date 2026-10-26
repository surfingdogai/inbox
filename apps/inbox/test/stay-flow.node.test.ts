import { addLocalDays, type Caller, dateIn, transitionItem, writesFirst } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { API_KEY, genericPropertySystem } from "../../../packages/adapters/test/fakes/property/generic";
import { STRIPE_LIVE_KEY } from "../../../packages/adapters/test/fixtures/payments";
import { at, GUEST, HOUR, OWNER, ok, setup } from "./stay-harness";

/**
 * Three places to stay, end to end through the inbox's own doors (ADR-037 §14): Kijani House in
 * Nairobi takes requests and is paid at the property (KES); Ryokan Hoshi in Kyoto writes every stay to
 * its own system first and takes a first-night deposit by Stripe (JPY); Maple Hollow B&B in Nova Scotia
 * keeps a room for direct guests, which confirms at once (CAD). Every figure is the example property's.
 */
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
    expect(quoteMail?.text).toContain("You book directly with Kijani House.");
    // Customers never read our words: not in the email, links aside (they are the property's own address).
    expect(quoteMail?.text.replace(/https:\/\/\S+/g, "")).not.toMatch(/Surfing Dog|network|receipt|inbox|reputation/i);
    // The page behind its link says the terms once: the policy in the heading, not again under it.
    const acceptUrl = quoteMail?.text.match(/https:\/\/\S+\/c\/\S+/)?.[0] ?? "";
    const page = await (await s.inbox.app.request(new Request(acceptUrl, { headers: { accept: "text/html" } }))).text();
    expect(page.match(/Free cancellation until/g)?.length).toBe(1);
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
    // After check-out the sweep completes it, 24 hours after 11:00 on the check-out day at the property.
    // The clock is set to just past that, never moved a count of days on from now: 34 days on from a
    // time before 08:00 UTC fell short of it, and the test failed at night.
    s.clock.now = Date.parse(`${checkOut}T11:00:00+03:00`) + 25 * HOUR;
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
    // Paid: the system's booking is written again as confirmed, with its guest, never left provisional.
    await s.drain();
    expect([...system.bookings.values()][0]).toMatchObject({
      reference: `sd-${id}`,
      status: "confirmed",
      guest: { name: "Maria A.", email: "maria@example.org" },
    });

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
    await ok(s.owner("POST", "/v1/owner/integrations", { kind: "stripe", values: { api_key: STRIPE_LIVE_KEY } }), 201);
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
    // Everything paid now, by the property's own Stripe.
    const booked = await ok<{ view: { item: { state: string } } }>(
      s.guest("POST", "/v1/stays/book", { item_id: id, terms_sha: held.terms_sha, access_token: token }),
    );
    expect(booked.view.item.state).toBe("awaiting_payment");
    await s.drain();
    const [link] = [...s.stripe.links.values()];
    await s.inbox.app.request(await s.stripe.pay(link?.id ?? ""));
    expect((await ok<{ item: { state: string } }>(s.owner("GET", `/v1/owner/items/${id}`))).item.state).toBe(
      "confirmed",
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

describe("Ryokan Hoshi, Kyoto: a change written to its own system first (JPY)", () => {
  /** The ryokan connected to its own system (one Japanese room), and a guest's stay quoted and accepted. */
  async function property() {
    const system = genericPropertySystem({
      name: "Ryokan Hoshi",
      currency: "JPY",
      timezone: "Asia/Tokyo",
      rooms: [{ id: "R1", name: "Japanese room", units: 1, prices: { FLEX: 25_800 } }],
    });
    const s = await setup({ name: "Ryokan Hoshi", timezone: "Asia/Tokyo", currency: "JPY", property: system });
    const conn = await ok<{ id: string }>(
      s.owner("POST", "/v1/owner/integrations", { kind: "fake_property", values: { api_key: API_KEY } }),
      201,
    );
    const mapped = await ok<{ property_id: string }>(
      s.owner("POST", "/v1/owner/property/system", {
        connector_id: conn.id,
        external_property_id: "P1",
        rooms: [{ external_id: "R1", room_type_id: "new" }],
      }),
    );
    const view = await ok<{ setup: { rooms: { id: string }[] } }>(s.owner("GET", "/v1/owner/property"));
    const room = view.setup.rooms[0]?.id as string;
    const plan = await ok<{ id: string }>(
      s.owner("POST", "/v1/owner/property/rate-plans", {
        name: "Flexible",
        external_id: "FLEX",
        policy: { preset: "free_until", days: 3, after: "first_night", no_show: "full" },
        deposit: { kind: "none" },
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
    await ok(s.owner("PUT", "/v1/owner/property", { id: mapped.property_id, mode: "connected" }));
    const checkIn = addLocalDays(dateIn(s.clock.now, "Asia/Tokyo"), 40);
    const checkOut = addLocalDays(checkIn, 2);
    const accept = async () => {
      const made = await ok<ItemBody>(
        s.guest("POST", "/v1/stays", {
          check_in: checkIn,
          check_out: checkOut,
          rooms: [{ room_type_id: room, adults: 2 }],
          contact: { name: "Wanjiru K.", email: "wanjiru@example.org", locale: "en" },
          consent: true,
        }),
        201,
      );
      const id = made.view.item.id;
      const token = made.accessToken as string;
      await ok(s.owner("POST", `/v1/owner/items/${id}/transitions`, { event: "quote", input: { from: "rates" } }));
      const asked = await s.guest("POST", `/v1/items/${id}/accept`, { access_token: token });
      const sha = ((await asked.json()) as { details: { terms_sha: string } }).details.terms_sha;
      const r = await ok<{ view: { item: { state: string } } }>(
        s.guest("POST", `/v1/items/${id}/accept`, { access_token: token, terms_sha: sha }),
      );
      expect(r.view.item.state).toBe("booking");
      return { id, token };
    };
    const state = async (id: string) =>
      (await ok<{ item: { state: string } }>(s.owner("GET", `/v1/owner/items/${id}`))).item.state;
    return { s, system, conn: conn.id, mapped: mapped.property_id, room, checkIn, checkOut, accept, state };
  }

  async function connected() {
    const c = await property();
    const { s, system, checkIn, checkOut } = c;
    const { id, token } = await c.accept();
    await s.drain();
    const booking = [...system.bookings.values()][0];
    expect(booking).toMatchObject({ status: "confirmed", checkIn, checkOut });
    // The guest asks for one more night, priced from the rates, and the owner says yes.
    const ask = async () => {
      const body = { check_in: checkIn, check_out: addLocalDays(checkOut, 1), access_token: token };
      const first = await s.guest("POST", `/v1/stays/${id}/change`, body);
      const terms = ((await first.json()) as { details: { terms_sha: string } }).details.terms_sha;
      await ok(s.guest("POST", `/v1/stays/${id}/change`, { ...body, terms_sha: terms }));
      const accepted = await ok<{ view: { item: { payload: { checkOut: string; change?: { writing?: string } } } } }>(
        s.owner("POST", `/v1/owner/items/${id}/transitions`, { event: "accept_change" }),
      );
      // Not moved yet: written to the system first.
      expect(accepted.view.item.payload.checkOut).toBe(checkOut);
      expect(accepted.view.item.payload.change?.writing).toBeTruthy();
      await s.drain();
      return ok<{ item: { state: string; payload: { checkOut: string; change?: unknown } } }>(
        s.owner("GET", `/v1/owner/items/${id}`),
      );
    };
    return { ...c, id, booking, ask };
  }

  it("keeps the stay as it was when the system has no room for the new night, and never cancels it", async () => {
    const c = await connected();
    // The night after was sold on another channel.
    c.system.sold.set(`R1|${c.checkOut}`, 1);
    const after = await c.ask();
    expect(after.item.state).toBe("confirmed");
    expect(after.item.payload.checkOut).toBe(c.checkOut);
    expect(after.item.payload.change).toBeUndefined();
    expect(c.booking).toMatchObject({ status: "confirmed", checkIn: c.checkIn, checkOut: c.checkOut });
    const mail = c.s.mail.sent.filter((m) => m.to.includes("wanjiru@example.org")).map((m) => m.subject);
    expect(mail.some((m) => /could not be changed/i.test(m))).toBe(true);
  });

  it("puts the old dates back when the system takes the new night only to show it oversold", async () => {
    const c = await connected();
    c.system.sold.set(`R1|${c.checkOut}`, 1);
    c.system.mode.guard = "oversell";
    const after = await c.ask();
    expect(after.item.payload.checkOut).toBe(c.checkOut);
    // Put back as it was, by the system's own booking: still confirmed, never cancelled.
    expect(c.booking).toMatchObject({ status: "confirmed", checkIn: c.checkIn, checkOut: c.checkOut });
    const notes = await c.s.db.client.query({
      sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND direction = 'note'",
      params: [c.id],
      method: "all",
    });
    expect(notes.rows.map((r) => String(r[0])).join("\n")).toMatch(/oversold, so they were put back/);
  });

  it("tells the owner when the dates it put back are oversold too, sold elsewhere meanwhile", async () => {
    const c = await connected();
    c.system.sold.set(`R1|${c.checkOut}`, 1);
    // Another channel sold the stay's own first night as well: put back, the stay is oversold there.
    c.system.sold.set(`R1|${c.checkIn}`, 1);
    c.system.mode.guard = "oversell";
    const after = await c.ask();
    expect(after.item.payload.checkOut).toBe(c.checkOut);
    expect(c.booking).toMatchObject({ status: "confirmed", checkIn: c.checkIn, checkOut: c.checkOut });
    const notes = await c.s.db.client.query({
      sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND direction = 'note'",
      params: [c.id],
      method: "all",
    });
    expect(notes.rows.map((r) => String(r[0])).join("\n")).toMatch(
      /put back on its own dates\. Another booking took some of those nights meanwhile, so they are oversold now/,
    );
  });

  it("tells the owner when the old dates could not be put back: the system and the inbox now differ", async () => {
    const c = await connected();
    c.system.sold.set(`R1|${c.checkOut}`, 1);
    c.system.mode.guard = "oversell";
    // The system takes the new night (oversold), then refuses to take it back.
    c.system.mode.patchesLeft = 1;
    const after = await c.ask();
    expect(after.item.payload.checkOut).toBe(c.checkOut);
    expect(c.booking?.checkOut).toBe(addLocalDays(c.checkOut, 1));
    const notes = await c.s.db.client.query({
      sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND direction = 'note'",
      params: [c.id],
      method: "all",
    });
    const text = notes.rows.map((r) => String(r[0])).join("\n");
    expect(text).toMatch(/could not put the old ones back/);
    expect(text).not.toMatch(/keeps its dates, here and there/);
  });

  it("tells the owner, and only the owner, when the system prices the stay otherwise than the guest agreed", async () => {
    const c = await property();
    // The system's own rate and its taxes: more than the guest agreed.
    c.system.mode.total = 56_760;
    const { id } = await c.accept();
    await c.s.drain();
    expect(await c.state(id)).toBe("confirmed");
    const notes = await c.s.db.client.query({
      sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND direction = 'note'",
      params: [id],
      method: "all",
    });
    expect(notes.rows.map((r) => String(r[0])).join("\n")).toMatch(
      /Your system has stay \S+ at JP¥56,760; the guest agreed JP¥51,600 here\. Check the stay's folio/,
    );
    const guestMail = c.s.mail.sent.filter((m) => m.to.includes("wanjiru@example.org"));
    expect(guestMail.some((m) => /56,760|folio/.test(`${m.subject}\n${m.text ?? ""}`))).toBe(false);
  });

  it("moves the stay once the system took the new night", async () => {
    const c = await connected();
    const after = await c.ask();
    expect(after.item.payload.checkOut).toBe(addLocalDays(c.checkOut, 1));
    expect(c.booking).toMatchObject({ status: "confirmed", checkOut: addLocalDays(c.checkOut, 1) });
  });

  it("promises nothing while the system's read-back cannot be made, and confirms once it can", async () => {
    const c = await property();
    c.system.mode.guard = "oversell";
    c.system.mode.readBack = "fails";
    const { id } = await c.accept();
    await c.s.drain();
    // Written, but not known to be sound: still booking, nothing promised.
    expect(await c.state(id)).toBe("booking");
    c.system.mode.readBack = "ok";
    c.s.clock.now += 31_000;
    await c.s.drain();
    expect(await c.state(id)).toBe("confirmed");
  });

  it("takes its write back when it can never be read back", async () => {
    const c = await property();
    c.system.mode.guard = "oversell";
    c.system.mode.readBack = "fails";
    const { id } = await c.accept();
    await c.s.drain();
    for (let i = 0; i < 12; i++) {
      c.s.clock.now += 31_000;
      await c.s.drain();
    }
    expect(await c.state(id)).toBe("expired");
    expect([...c.system.bookings.values()][0]?.status).toBe("cancelled");
  });

  it("cancels a booking that landed after the inbox stopped looking for it", async () => {
    const c = await property();
    c.system.mode.write = "unreachable";
    const { id } = await c.accept();
    await c.s.drain();
    expect(await c.state(id)).toBe("booking");
    // It landed after all, and the system's index of references lags: the last look misses it.
    c.system.bookings.set("B9", {
      id: "B9",
      reference: `sd-${id}`,
      roomIds: ["R1"],
      checkIn: c.checkIn,
      checkOut: c.checkOut,
      status: "confirmed",
      price: 51_600,
    });
    c.system.mode.findMisses = 1;
    c.s.clock.now += 6 * 60_000;
    await c.s.drain();
    expect(await c.state(id)).toBe("expired");
    expect(c.system.bookings.get("B9")?.status).toBe("cancelled");
  });

  it("refuses to take a system's property in another currency or zone than its own", async () => {
    const c = await property();
    const other = await c.s.owner("POST", "/v1/owner/property/system", {
      connector_id: c.conn,
      external_property_id: "P1",
      property_id: c.mapped,
      rooms: [],
    });
    expect(other.status).toBe(200);
    // The property here is now priced in another currency: the system's prices would be read as it.
    await ok(c.s.owner("PUT", "/v1/owner/property", { id: c.mapped, currency: "USD" }));
    const refused = await c.s.owner("POST", "/v1/owner/property/system", {
      connector_id: c.conn,
      external_property_id: "P1",
      property_id: c.mapped,
      rooms: [],
    });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { detail?: string; message?: string }).detail ?? "").toMatch(/JPY/);
  });

  it("lets the nights after a no-show's first go on the system, and keeps its booking there", async () => {
    const c = await connected();
    c.s.clock.now = Date.parse(`${addLocalDays(c.checkIn, 1)}T03:00:00Z`);
    await transitionItem(c.s.db, at(c.s, OWNER), { itemId: c.id, event: "no_show" });
    await c.s.drain();
    expect(c.booking).toMatchObject({ status: "confirmed", checkIn: c.checkIn, checkOut: addLocalDays(c.checkIn, 1) });
  });
});

describe("Riad Zitoun, Marrakesh: matched to its own system, each stay written there first (MAD)", () => {
  async function matched() {
    const system = genericPropertySystem({
      name: "Riad Zitoun",
      currency: "MAD",
      timezone: "Africa/Casablanca",
      rooms: [
        { id: "R1", name: "Chambre patio", units: 3, prices: { BB: 98_000 }, charges: ["cleaning", "tax"] },
        { id: "R2", name: "Suite terrasse", units: 1, prices: { BB: 164_050 } },
      ],
    });
    const s = await setup({ name: "Riad Zitoun", timezone: "Africa/Casablanca", currency: "MAD", property: system });
    // The owner set the riad up here first, with a room of their own the system does not have.
    const prop = await ok<{ id: string }>(
      s.owner("PUT", "/v1/owner/property", {
        name: "Riad Zitoun",
        kind: "guesthouse",
        currency: "MAD",
        timezone: "Africa/Casablanca",
      }),
    );
    const patio = await ok<{ id: string }>(
      s.owner("POST", "/v1/owner/property/rooms", {
        property_id: prop.id,
        name: "Rooftop room",
        units: 1,
        capacity: { adults: 2, children: 0, total: 2 },
        beds: [],
        amenities: [],
        accessible: false,
        photos: [],
        offered: true,
      }),
    );
    const conn = await ok<{ id: string }>(
      s.owner("POST", "/v1/owner/integrations", { kind: "fake_property", values: { api_key: API_KEY } }),
      201,
    );
    const map = (extra: Record<string, unknown> = {}) =>
      ok<{ property_id: string; rooms: number }>(
        s.owner("POST", "/v1/owner/property/system", {
          connector_id: conn.id,
          external_property_id: "P1",
          property_id: prop.id,
          rooms: [
            { external_id: "R1", room_type_id: "new" },
            { external_id: "R2", room_type_id: "new" },
          ],
          ...extra,
        }),
      );
    const view = () =>
      ok<{
        setup: {
          property: { mode: string; instant: boolean; connectorId: string | null };
          rooms: { id: string; name: string; offered: boolean; externalId: string | null }[];
          system: { title: string; prices_at: string | null } | null;
        };
      }>(s.owner("GET", "/v1/owner/property"));
    return { s, prop, patio, conn, map, view };
  }

  it("writes each stay to the system first from the moment its rooms are matched, confirming at once still off", async () => {
    const c = await matched();
    const before = await c.view();
    expect(before.setup.property.mode).toBe("request");
    await c.map({ stop_offering: [c.patio.id] });
    const after = await c.view();
    expect(after.setup.property).toMatchObject({ mode: "connected", instant: false, connectorId: c.conn.id });
    expect(writesFirst(after.setup as never)).toBe(true);
    expect(after.setup.system?.title).toBeTruthy();
    // The owner's own room, which the system does not have, is no longer offered: no stay of it could go there.
    expect(after.setup.rooms.find((r) => r.id === c.patio.id)?.offered).toBe(false);
    expect(after.setup.rooms.filter((r) => r.externalId).map((r) => r.name)).toEqual([
      "Chambre patio",
      "Suite terrasse",
    ]);
  });

  it("keeps how it confirms as the owner left it when its rooms are matched again", async () => {
    const c = await matched();
    const first = await c.map();
    await ok(c.s.owner("PUT", "/v1/owner/property", { id: first.property_id, mode: "request" }));
    await c.map();
    expect((await c.view()).setup.property.mode).toBe("request");
  });

  it("asks the owner to cover the system's cleaning fee and tax before stays confirm at once", async () => {
    const c = await matched();
    const { property_id } = await c.map();
    const refused = await c.s.owner("PUT", "/v1/owner/property", { id: property_id, instant: true });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { detail?: string; details?: { reason?: string; rooms?: string[] } };
    expect(body.details).toMatchObject({ reason: "system_charges", rooms: ["Chambre patio"] });
    expect(body.detail).toMatch(
      /adds a cleaning fee and tax to Chambre patio on its other channels\. Add them in Taxes & fees/,
    );
    // Their word given: what is left is the usual wait for a first stay written and read back.
    const locked = await c.s.owner("PUT", "/v1/owner/property", {
      id: property_id,
      instant: true,
      charges_covered: true,
    });
    expect(locked.status).toBe(409);
    expect(((await locked.json()) as { details?: { reason?: string } }).details?.reason).toBe("instant_locked");
  });
});
