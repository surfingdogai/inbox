import { addLocalDays, dateIn } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  checkUcpBooking,
  type UcpBooking,
  type UcpMessage,
  type UcpSchedule,
} from "../../../packages/adapters/src/ucp-lodging";
import { STRIPE_LIVE_KEY } from "../../../packages/adapters/test/fixtures/payments";
import { BASE, ok, type Setup, setup } from "./stay-harness";

/**
 * UCP Lodging's booking sessions in the whole app (ADR-033 §6.5), switched on as INBOX_UCP_LODGING=on
 * does: nothing answers without the switch; a room kept for direct guests is priced, held once the lead
 * is named, and booked, or handed to the property's own page when a deposit or a card is due; a change
 * lets the old hold go; a cancel lets it go; a property that answers each stay itself is not served; and
 * the guests' ids the platform sends are never kept. Maple Hollow B&B (Nova Scotia, CAD), Kijani House
 * (Nairobi, KES, paid at the property) and Ryokan Hoshi (Kyoto, JPY, on request).
 */

const SESSIONS = "/v1/ucp/lodging/booking-sessions";
const AGENT = 'profile="https://platform.example/profile"';

type Body = UcpBooking & { ucp: { status?: string }; messages?: UcpMessage[] };

function ucp(s: Setup, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return s.inbox.app.request(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        "ucp-agent": AGENT,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

interface Place {
  readonly id: string;
  readonly room: string;
  readonly plan: string;
  readonly conn?: string;
}

async function place(
  s: Setup,
  o: {
    name: string;
    kind: string;
    currency: string;
    timezone: string;
    room: string;
    capacity: { adults: number; children: number; total: number };
    nightly: number;
    mode?: "request" | "allotment";
    kept?: number;
    stripe?: boolean;
    deposit?: unknown;
    guarantee?: "card";
    children?: unknown;
    fees?: unknown[];
  },
): Promise<Place> {
  const conn = o.stripe
    ? await ok<{ id: string }>(
        s.owner("POST", "/v1/owner/integrations", { kind: "stripe", values: { api_key: STRIPE_LIVE_KEY } }),
        201,
      )
    : undefined;
  const prop = await ok<{ id: string }>(
    s.owner("PUT", "/v1/owner/property", {
      name: o.name,
      kind: o.kind,
      currency: o.currency,
      check_in_from: "15:00",
      check_out_until: "11:00",
      mode: o.mode ?? "allotment",
      ...(o.children ? { children: o.children } : {}),
    }),
  );
  const room = await ok<{ id: string }>(
    s.owner("POST", "/v1/owner/property/rooms", { name: o.room, units: 3, capacity: o.capacity }),
  );
  if (o.guarantee && conn) await s.inbox.caps.connectors.payments.setGuarantees(conn.id, true, Date.now());
  const plan = await ok<{ id: string }>(
    s.owner("POST", "/v1/owner/property/rate-plans", {
      name: "Flexible",
      meal: "breakfast",
      policy: { preset: "free_until", days: 3, after: "first_night", no_show: "full" },
      deposit: o.deposit ?? { kind: "none" },
      ...(o.guarantee ? { guarantee: o.guarantee } : {}),
    }),
  );
  await ok(
    s.owner("PUT", "/v1/owner/property/rates", {
      rate_plan_id: plan.id,
      room_type_id: room.id,
      nightly: o.nightly,
      base_guests: 2,
    }),
  );
  if (o.fees) await ok(s.owner("PUT", "/v1/owner/property/fees", { fees: o.fees }));
  if ((o.mode ?? "allotment") === "allotment") {
    const today = dateIn(s.clock.now, o.timezone);
    await ok(
      s.owner("PUT", "/v1/owner/property/allotments", {
        room_type_id: room.id,
        from_date: today,
        to_date: addLocalDays(today, 120),
        units: o.kept ?? 1,
        closed_elsewhere: true,
      }),
    );
  }
  return { id: prop.id, room: room.id, plan: plan.id, ...(conn ? { conn: conn.id } : {}) };
}

const dates = (s: Setup, zone: string, inDays: number, nights: number) => {
  const checkIn = addLocalDays(dateIn(s.clock.now, zone), inDays);
  return { start_date: checkIn, end_date: addLocalDays(checkIn, nights) };
};

const session = (
  p: Place,
  stayDates: { start_date: string; end_date: string },
  more: Record<string, unknown> = {},
) => ({
  property: { id: p.id },
  stays: [
    {
      accommodation_type: { id: p.room },
      rate_plan: { id: p.plan },
      occupancy: { adults: 2, total: 2 },
      stay_dates: stayDates,
      ...(more.assign ? { guest_assignments: more.assign } : {}),
    },
  ],
  ...Object.fromEntries(Object.entries(more).filter(([k]) => k !== "assign")),
});

const maple = (s: Setup, extra: Partial<Parameters<typeof place>[1]> = {}) =>
  place(s, {
    name: "Maple Hollow B&B",
    kind: "bnb",
    currency: "CAD",
    timezone: "America/Halifax",
    room: "Harbour room",
    capacity: { adults: 2, children: 0, total: 2 },
    nightly: 18_900,
    stripe: true,
    deposit: { kind: "full" },
    fees: [{ name: "HST", kind: "tax", basis: "percent_of_room", rate_bp: 1500, collected: "with_booking" }],
    ...extra,
  });

const BOOKER = { first_name: "Élise", last_name: "Doucet", email: "elise.doucet@example.org" };
const GUESTS = [
  { id: "gst_01", first_name: "Élise", last_name: "Doucet" },
  { id: "gst_02", first_name: "Marc", last_name: "Doucet" },
];
const ASSIGN = [
  { guest_id: "gst_01", role: "primary" },
  { guest_id: "gst_02", role: "accompanying" },
];

/** Every row of every table, as text: what the inbox keeps. */
async function everything(s: Setup): Promise<string> {
  const { rows } = await s.db.client.query({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
  });
  let all = "";
  for (const [name] of rows) {
    const t = await s.db.client.query({ sql: `SELECT * FROM "${String(name)}"`, method: "all" });
    all += JSON.stringify(t.rows);
  }
  return all;
}

describe("UCP Lodging, switched off", () => {
  it("answers nothing without INBOX_UCP_LODGING=on, even at a place that confirms at once", async () => {
    const s = await setup({ name: "Maple Hollow B&B", timezone: "America/Halifax", currency: "CAD" });
    const p = await maple(s);
    expect((await ucp(s, "GET", "/.well-known/ucp")).status).toBe(404);
    const created = await ucp(s, "POST", SESSIONS, session(p, dates(s, "America/Halifax", 10, 2)));
    expect(created.status).toBe(404);
    expect((await ucp(s, "GET", `${SESSIONS}/bks_anything`)).status).toBe(404);
    expect(await everything(s)).not.toContain("ucp-lodging:");
  });
});

describe("Maple Hollow B&B, Nova Scotia: a room kept for direct guests, the deposit on its own Stripe (CAD)", () => {
  it("prices, holds once the lead is named, and hands the guest to the property's payment page; paid, it is booked", async () => {
    const s = await setup({ name: "Maple Hollow B&B", timezone: "America/Halifax", currency: "CAD", ucpLodging: true });
    const p = await maple(s);
    const profile = await ok<{ ucp: { services: Record<string, { endpoint: string }[]>; payment_handlers: object } }>(
      ucp(s, "GET", "/.well-known/ucp"),
    );
    expect(profile.ucp.services["dev.ucp.lodging"]?.[0]?.endpoint).toBe(`${BASE}/v1/ucp/lodging`);
    expect(profile.ucp.payment_handlers).toEqual({});
    const when = dates(s, "America/Halifax", 10, 2);
    const fr = { context: { language: "fr" } };

    // Create: priced at once, nothing held until the lead is named.
    const created = await ok<Body>(ucp(s, "POST", SESSIONS, session(p, when, fr)), 201);
    expect(created.status).toBe("incomplete");
    expect(created.id).toMatch(/^bks_/);
    expect(created.messages?.map((m) => m.code)).toEqual(["lead_guest_required"]);
    expect(created.totals.map((t) => [t.type, t.amount])).toEqual([
      ["subtotal", 37_800],
      ["tax", 5_670],
      ["total", 43_470],
    ]);
    expect(created.payment?.terms[0]?.schedules.map((x) => [x.type, x.amount])).toEqual([["immediate", 43_470]]);
    expect(created.payment?.terms[0]?.schedules[0]?.description.plain).toContain("à régler à la réservation");
    expect(checkUcpBooking(created as never)).toEqual([]);
    expect(await everything(s)).not.toContain("ucp-lodging:");

    // Update with the lead: held, ready to complete; the guests' ids come back as they were sent.
    const ready = await ok<Body>(
      ucp(
        s,
        "PUT",
        `${SESSIONS}/${created.id}`,
        session(p, when, { ...fr, booker: BOOKER, guests: GUESTS, assign: ASSIGN }),
      ),
    );
    expect(ready.status).toBe("ready_for_complete");
    expect(ready.id).toBe(created.id);
    expect(ready.guests?.map((g) => g.id)).toEqual(["gst_01", "gst_02"]);
    expect(ready.stays[0]?.guest_assignments).toEqual(ASSIGN);
    expect(ready.expires_at).toBeTruthy();
    expect(checkUcpBooking(ready as never)).toEqual([]);
    // The same again is the same hold.
    const again = await ok<Body>(
      ucp(
        s,
        "PUT",
        `${SESSIONS}/${created.id}`,
        session(p, when, { ...fr, booker: BOOKER, guests: GUESTS, assign: ASSIGN }),
      ),
    );
    expect(again.status).toBe("ready_for_complete");
    const stays = await ok<{ items: { item: { id: string; state: string } }[] }>(
      s.owner("GET", "/v1/owner/items?type=stay&open_only=false"),
    );
    expect(stays.items.map((i) => i.item.state)).toEqual(["held"]);
    const stayId = stays.items[0]?.item.id as string;

    // Complete: the deposit is the property's, so the guest goes to its page; a card sent is never read.
    const completing = await ok<Body>(
      ucp(s, "POST", `${SESSIONS}/${created.id}/complete`, {
        payment: {
          instruments: [
            {
              id: "pi_1",
              handler_id: "h1",
              type: "card",
              credential: { type: "PAYMENT_GATEWAY", token: "tok_never_read_8841" },
            },
          ],
        },
      }),
    );
    expect(["complete_in_progress", "requires_escalation"]).toContain(completing.status);
    await s.drain();
    const handed = await ok<Body>(ucp(s, "GET", `${SESSIONS}/${created.id}`));
    expect(handed.status).toBe("requires_escalation");
    const [link] = [...s.stripe.links.values()];
    expect(handed.continue_url).toBe(link?.url);
    expect(handed.messages?.find((m) => m.code === "payment_required")).toMatchObject({
      severity: "requires_buyer_input",
    });
    expect(checkUcpBooking(handed as never)).toEqual([]);
    expect(await everything(s)).not.toContain("tok_never_read_8841");
    expect(s.stripe.calls.join(" ")).not.toContain("tok_never_read");

    // Paid on the property's own Stripe: booked.
    await s.inbox.app.request(await s.stripe.pay(link?.id ?? ""));
    const done = await ok<Body>(ucp(s, "GET", `${SESSIONS}/${created.id}`));
    expect(done.status).toBe("completed");
    expect(done.confirmation).toEqual({ id: stayId, label: stayId.slice(-6).toUpperCase() });
    expect(done.continue_url).toBeUndefined();
    expect(done.booker).toMatchObject({ first_name: "Élise", last_name: "Doucet", email: BOOKER.email });
    expect(checkUcpBooking(done as never)).toEqual([]);
    // Booked is booked: no change, no cancel through the session.
    const update = await ok<Body>(
      ucp(s, "PUT", `${SESSIONS}/${created.id}`, session(p, dates(s, "America/Halifax", 11, 2))),
    );
    expect(update.messages?.map((m) => m.code)).toContain("not_modifiable");
    const cancel = await ok<Body>(ucp(s, "POST", `${SESSIONS}/${created.id}/cancel`, {}));
    expect(cancel.status).toBe("completed");
    expect(cancel.messages?.map((m) => m.code)).toContain("not_cancelable");

    // The guests' ids were echoed and never kept: the property keeps names and the lead's address.
    const kept = await everything(s);
    expect(kept).not.toContain("gst_01");
    expect(kept).not.toContain("gst_02");
    expect(kept).toContain("Marc Doucet");
  });

  it("asks for a card on the property's own page when the plan holds stays with one", async () => {
    const s = await setup({ name: "Maple Hollow B&B", timezone: "America/Halifax", currency: "CAD", ucpLodging: true });
    const p = await maple(s, { deposit: { kind: "none" }, guarantee: "card" });
    const when = dates(s, "America/Halifax", 20, 3);
    const created = await ok<Body>(ucp(s, "POST", SESSIONS, session(p, when, { booker: BOOKER })), 201);
    expect(created.status).toBe("ready_for_complete");
    const done = await ok<Body>(ucp(s, "POST", `${SESSIONS}/${created.id}/complete`, { payment: {} }));
    expect(done.status).toBe("requires_escalation");
    expect(done.continue_url).toMatch(new RegExp(`^${BASE}/c/[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{22}$`));
    expect(done.messages?.find((m) => m.code === "payment_required")?.content).toContain("nothing is charged now");
    const page = await s.inbox.app.request(new Request(done.continue_url as string));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Maple Hollow B&amp;B");
  });

  it("lets the old hold go when the dates change, says the totals moved, and lets go on cancel", async () => {
    const s = await setup({ name: "Maple Hollow B&B", timezone: "America/Halifax", currency: "CAD", ucpLodging: true });
    const p = await maple(s);
    const two = dates(s, "America/Halifax", 10, 2);
    const three = { start_date: two.start_date, end_date: addLocalDays(two.start_date, 3) };
    const lead = { booker: BOOKER };
    const created = await ok<Body>(ucp(s, "POST", SESSIONS, session(p, two, lead)), 201);
    expect(created.status).toBe("ready_for_complete");
    // A night more: the hold for two nights goes, one for three is made, and the price moved.
    const longer = await ok<Body>(ucp(s, "PUT", `${SESSIONS}/${created.id}`, session(p, three, lead)));
    expect(longer.status).toBe("ready_for_complete");
    expect(longer.stays[0]?.stay_dates).toEqual(three);
    expect(longer.messages?.find((m) => m.code === "totals_changed")).toMatchObject({
      path: "$.totals",
      presentation: "disclosure",
    });
    const states = async () =>
      (
        await ok<{ items: { item: { state: string } }[] }>(s.owner("GET", "/v1/owner/items?type=stay&open_only=false"))
      ).items
        .map((i) => i.item.state)
        .sort();
    expect(await states()).toEqual(["expired", "held"]);
    // The one room kept is held by this session: another session finds it gone.
    const other = await ok<Body>(ucp(s, "POST", SESSIONS, session(p, three)));
    expect(other.ucp.status).toBe("error");
    expect(other.messages?.[0]?.code).toBe("inventory_exhausted");
    // Cancelled: let go, and the other session can have it.
    const cancelled = await ok<Body>(ucp(s, "POST", `${SESSIONS}/${created.id}/cancel`, {}));
    expect(cancelled.status).toBe("canceled");
    expect(cancelled.continue_url).toBeUndefined();
    expect(await states()).toEqual(["expired", "expired"]);
    const now = await ok<Body>(ucp(s, "POST", SESSIONS, session(p, three)), 201);
    expect(now.status).toBe("incomplete");
  });

  it("says when the guests do not fit the room, and finds no session it did not make", async () => {
    const s = await setup({ name: "Maple Hollow B&B", timezone: "America/Halifax", currency: "CAD", ucpLodging: true });
    const p = await maple(s);
    const when = dates(s, "America/Halifax", 10, 2);
    const crowd = session(p, when);
    (crowd.stays[0] as { occupancy: unknown }).occupancy = { adults: 3, total: 3 };
    const full = await ok<Body>(ucp(s, "POST", SESSIONS, crowd));
    expect(full.ucp.status).toBe("error");
    expect(full.messages?.[0]).toMatchObject({
      code: "occupancy_exceeded_capacity",
      path: "$.stays[0]",
      severity: "recoverable",
    });
    const malformed = await ucp(s, "POST", SESSIONS, { property: { id: p.id } });
    expect(malformed.status).toBe(400);
    const created = await ok<Body>(ucp(s, "POST", SESSIONS, session(p, when)), 201);
    const forged = `${created.id.slice(0, -6)}AAAAAA`;
    expect((await ucp(s, "GET", `${SESSIONS}/${forged}`)).status).toBe(404);
    expect((await ucp(s, "GET", `${SESSIONS}/booking_123`)).status).toBe(404);
    // The owner's own key is not a guest's platform.
    expect((await s.owner("POST", SESSIONS, session(p, when))).status).toBe(403);
  });
});

describe("Kijani House, Nairobi: paid at the property, a levy it collects itself (KES)", () => {
  it("holds when the lead comes with the first request, discloses the levy, and books at once", async () => {
    const s = await setup({ name: "Kijani House", timezone: "Africa/Nairobi", currency: "KES", ucpLodging: true });
    const p = await place(s, {
      name: "Kijani House",
      kind: "guesthouse",
      currency: "KES",
      timezone: "Africa/Nairobi",
      room: "Garden double",
      capacity: { adults: 2, children: 1, total: 3 },
      nightly: 650_000,
      children: { welcome: true, from_age: 5 },
      fees: [
        {
          name: "Tourism levy",
          kind: "fee",
          basis: "percent_of_room",
          rate_bp: 200,
          collected: "at_property",
          max_nights: 7,
        },
      ],
    });
    const when = dates(s, "Africa/Nairobi", 14, 3);
    const body = session(p, when, {
      booker: { first_name: "Wanjiru", last_name: "Kamau", phone_number: "+254700000123" },
    });
    (body.stays[0] as { occupancy: unknown }).occupancy = { adults: 2, children: 1, child_ages: [7], total: 3 };
    const created = await ok<Body>(ucp(s, "POST", SESSIONS, body), 201);
    expect(created.status).toBe("ready_for_complete");
    expect(created.totals.map((t) => [t.type, t.amount])).toEqual([
      ["subtotal", 1_950_000],
      ["fee", 39_000],
      ["total", 1_989_000],
    ]);
    const local = created.messages?.find((m) => m.code === "local_tax");
    expect(local).toMatchObject({ presentation: "disclosure", path: "$.payment.terms[0].schedules[0]" });
    const schedule = created.payment?.terms[0]?.schedules[0] as UcpSchedule;
    expect(schedule).toMatchObject({ type: "at_property", amount: 1_989_000 });
    expect(local?.content).toContain("Tourism levy");
    expect(local?.content).toContain("for at most 7 nights");
    expect(created.stays[0]?.accommodation_type.capacity.child_age_ranges).toEqual([
      { ages: { min: 0, max: 4 }, limit: 0 },
      { ages: { min: 5, max: 17 } },
    ]);
    expect(checkUcpBooking(created as never)).toEqual([]);
    // Nothing is due now: booked, the levy still disclosed until then.
    const done = await ok<Body>(ucp(s, "POST", `${SESSIONS}/${created.id}/complete`, { payment: {} }));
    expect(done.status).toBe("completed");
    expect(done.booker).toMatchObject({ first_name: "Wanjiru", last_name: "Kamau", phone_number: "+254700000123" });
    expect(checkUcpBooking(done as never)).toEqual([]);
    const stay = await ok<{ item: { state: string } }>(s.owner("GET", `/v1/owner/items/${done.confirmation?.id}`));
    expect(stay.item.state).toBe("confirmed");
  });
});

describe("Ryokan Hoshi, Kyoto: every stay answered by the ryokan itself (JPY)", () => {
  it("is not served: no profile, and a session is refused with where to go instead", async () => {
    const s = await setup({ name: "Ryokan Hoshi", timezone: "Asia/Tokyo", currency: "JPY", ucpLodging: true });
    const p = await place(s, {
      name: "Ryokan Hoshi",
      kind: "ryokan",
      currency: "JPY",
      timezone: "Asia/Tokyo",
      room: "Japanese room",
      capacity: { adults: 2, children: 1, total: 3 },
      nightly: 25_800,
      mode: "request",
    });
    expect((await ucp(s, "GET", "/.well-known/ucp")).status).toBe(404);
    const refused = await ok<Body>(ucp(s, "POST", SESSIONS, session(p, dates(s, "Asia/Tokyo", 30, 3))));
    expect(refused.ucp.status).toBe("error");
    expect(refused.messages?.[0]).toMatchObject({ code: "on_request", severity: "unrecoverable" });
    expect((refused as unknown as { continue_url: string }).continue_url).toBe(`${BASE}/`);
    const stays = await ok<{ items: unknown[] }>(s.owner("GET", "/v1/owner/items?type=stay&open_only=false"));
    expect(stays.items).toEqual([]);
  });
});
