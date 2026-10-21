import { createApiKey } from "@surfingdog/adapters";
import { addLocalDays, dateIn, pruneIdempotencyKeys } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  CANCELLATION,
  checkUcpBooking,
  type UcpBooking,
  type UcpMessage,
  type UcpSchedule,
} from "../../../packages/adapters/src/ucp-lodging";
import { STRIPE_LIVE_KEY } from "../../../packages/adapters/test/fixtures/payments";
import { BASE, ok, type Setup, setup } from "./stay-harness";

/**
 * UCP Lodging's booking sessions in the whole app (ADR-035), switched on as INBOX_UCP_LODGING does:
 * nothing answers without the switch; a room kept for direct guests is priced, held once the lead is
 * named, and booked, or handed to the property's own page when a deposit or a card is due; the hold
 * stands while only names and ways to reach the lead are added, and a change of dates is priced before
 * the old hold goes; a session answers from its own row for as long as its stay lives, and goes when
 * the guest is erased; Idempotency-Key is kept as UCP says, and a session's id never reaches another
 * caller; a property that answers each stay itself is not served; and the guests' ids the platform
 * sends are kept only sealed. Maple Hollow B&B (Nova Scotia, CAD), Kijani House (Nairobi, KES, paid at
 * the property) and Ryokan Hoshi (Kyoto, JPY, on request).
 */

const SESSIONS = "/v1/ucp/lodging/booking-sessions";
const AGENT = 'profile="https://platform.example/profile"';
const DAY = 86_400_000;

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

const mapleSetup = () =>
  setup({ name: "Maple Hollow B&B", timezone: "America/Halifax", currency: "CAD", ucpLodging: true });

const kijani = (s: Setup) =>
  place(s, {
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

/** The property's stays, as the owner sees them: their states, sorted. */
async function states(s: Setup): Promise<string[]> {
  return (
    await ok<{ items: { item: { state: string } }[] }>(s.owner("GET", "/v1/owner/items?type=stay&open_only=false"))
  ).items
    .map((i) => i.item.state)
    .sort();
}

const codes = (b: Body) => (b.messages ?? []).map((m) => m.code);

describe("UCP Lodging, switched off", () => {
  it("answers nothing without INBOX_UCP_LODGING, even at a place that confirms at once", async () => {
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
    const s = await mapleSetup();
    const p = await maple(s);
    const profile = await ok<{ ucp: { services: Record<string, { endpoint: string }[]>; payment_handlers: object } }>(
      ucp(s, "GET", "/.well-known/ucp"),
    );
    expect(profile.ucp.services["dev.ucp.lodging"]?.[0]?.endpoint).toBe(`${BASE}/v1/ucp/lodging`);
    expect(profile.ucp.payment_handlers).toEqual({});
    const when = dates(s, "America/Halifax", 10, 2);
    const fr = { context: { language: "fr" } };

    // Create: priced at once, nothing held until the lead is named; the policy shown, since cancelling can cost.
    const created = await ok<Body>(ucp(s, "POST", SESSIONS, session(p, when, fr)), 201);
    expect(created.status).toBe("incomplete");
    expect(created.id).toMatch(/^bks_[A-Za-z0-9_-]{43}$/);
    expect(codes(created)).toEqual(["lead_guest_required", CANCELLATION]);
    expect(created.continue_url).toBeUndefined();
    expect(created.totals.map((t) => [t.type, t.amount])).toEqual([
      ["subtotal", 37_800],
      ["tax", 5_670],
      ["total", 43_470],
    ]);
    expect(created.payment?.terms[0]?.schedules.map((x) => [x.type, x.amount])).toEqual([["immediate", 43_470]]);
    expect(created.payment?.terms[0]?.schedules[0]?.description.plain).toContain("à régler à la réservation");
    expect(checkUcpBooking(created as never)).toEqual([]);
    expect(await states(s)).toEqual([]);

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
    expect(ready.continue_url).toBeUndefined();
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
    expect(await states(s)).toEqual(["held"]);
    const stays = await ok<{ items: { item: { id: string } }[] }>(
      s.owner("GET", "/v1/owner/items?type=stay&open_only=false"),
    );
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
    const due = handed.messages?.find((m) => m.code === "payment_required");
    expect(due).toMatchObject({ severity: "requires_buyer_input" });
    // The deadline says whose time it is: the property's.
    expect(due?.content).toMatch(/, heure de \S+/);
    expect(checkUcpBooking(handed as never)).toEqual([]);
    expect(await everything(s)).not.toContain("tok_never_read_8841");
    expect(s.stripe.calls.join(" ")).not.toContain("tok_never_read");

    // Paid on the property's own Stripe: booked.
    await s.inbox.app.request(await s.stripe.pay(link?.id ?? ""));
    const done = await ok<Body>(ucp(s, "GET", `${SESSIONS}/${created.id}`));
    expect(done.status).toBe("completed");
    expect(done.confirmation).toEqual({ id: stayId, label: stayId.slice(-6).toUpperCase() });
    expect(done.continue_url).toBeUndefined();
    expect(done.booker).toEqual(BOOKER);
    expect(done.guests?.map((g) => g.id)).toEqual(["gst_01", "gst_02"]);
    expect(checkUcpBooking(done as never)).toEqual([]);
    // Booked is booked: no change, no cancel through the session.
    const update = await ok<Body>(
      ucp(s, "PUT", `${SESSIONS}/${created.id}`, session(p, dates(s, "America/Halifax", 11, 2))),
    );
    expect(codes(update)).toContain("not_modifiable");
    expect(update.status).toBe("completed");
    const cancel = await ok<Body>(ucp(s, "POST", `${SESSIONS}/${created.id}/cancel`, {}));
    expect(cancel.status).toBe("completed");
    expect(codes(cancel)).toContain("not_cancelable");

    // The guests' ids were echoed and kept only sealed: the property keeps names and the lead's address.
    const kept = await everything(s);
    expect(kept).not.toContain("gst_01");
    expect(kept).not.toContain("gst_02");
    expect(kept).toContain("Marc Doucet");
  });

  it("asks for a card on the property's own page when the plan holds stays with one", async () => {
    const s = await mapleSetup();
    const p = await maple(s, { deposit: { kind: "none" }, guarantee: "card" });
    const when = dates(s, "America/Halifax", 20, 3);
    const created = await ok<Body>(ucp(s, "POST", SESSIONS, session(p, when, { booker: BOOKER })), 201);
    expect(created.status).toBe("ready_for_complete");
    const done = await ok<Body>(ucp(s, "POST", `${SESSIONS}/${created.id}/complete`, { payment: {} }));
    expect(done.status).toBe("requires_escalation");
    expect(done.continue_url).toMatch(new RegExp(`^${BASE}/c/[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{22}$`));
    const words = done.messages?.find((m) => m.code === "payment_required")?.content;
    expect(words).toContain("Nothing is charged now");
    expect(words).toContain("Halifax time");
    const page = await s.inbox.app.request(new Request(done.continue_url as string));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Maple Hollow B&amp;B");
  });

  it("prices new dates before the old hold goes, says the totals moved, and keeps a cancel", async () => {
    const s = await mapleSetup();
    const p = await maple(s);
    const two = dates(s, "America/Halifax", 10, 2);
    const three = { start_date: two.start_date, end_date: addLocalDays(two.start_date, 3) };
    const lead = { booker: BOOKER };
    const created = await ok<Body>(ucp(s, "POST", SESSIONS, session(p, two, lead)), 201);
    expect(created.status).toBe("ready_for_complete");
    // A night more: the one room kept is this session's, so it is let go and held again for three nights.
    const longer = await ok<Body>(ucp(s, "PUT", `${SESSIONS}/${created.id}`, session(p, three, lead)));
    expect(longer.status).toBe("ready_for_complete");
    expect(longer.stays[0]?.stay_dates).toEqual(three);
    expect(longer.messages?.find((m) => m.code === "totals_changed")).toMatchObject({
      path: "$.totals",
      presentation: "disclosure",
    });
    expect(await states(s)).toEqual(["expired", "held"]);
    // A change that does not fit lets nothing go: the session answers as it stands, with why.
    const crowd = session(p, two, lead);
    (crowd.stays[0] as { occupancy: unknown }).occupancy = { adults: 3, total: 3 };
    const refused = await ok<Body>(ucp(s, "PUT", `${SESSIONS}/${created.id}`, crowd));
    expect(refused.status).toBe("ready_for_complete");
    expect(refused.stays[0]?.stay_dates).toEqual(three);
    expect(codes(refused)).toContain("occupancy_exceeded_capacity");
    expect(await states(s)).toEqual(["expired", "held"]);
    // The one room kept is held by this session: another finds none to book at once.
    const other = await ok<Body>(ucp(s, "POST", SESSIONS, session(p, three)));
    expect(other.ucp.status).toBe("error");
    expect(other.messages?.[0]?.code).toBe("inventory_exhausted");
    // Cancelled: let go, said again on every read, and the other session can have it.
    const cancelled = await ok<Body>(ucp(s, "POST", `${SESSIONS}/${created.id}/cancel`, {}));
    expect(cancelled.status).toBe("canceled");
    expect(cancelled.continue_url).toBeUndefined();
    expect((await ok<Body>(ucp(s, "GET", `${SESSIONS}/${created.id}`))).status).toBe("canceled");
    expect(await states(s)).toEqual(["expired", "expired"]);
    const now = await ok<Body>(ucp(s, "POST", SESSIONS, session(p, three)), 201);
    expect(now.status).toBe("incomplete");
  });

  it("keeps the hold while names and ways to reach the lead are added, and echoes what was sent", async () => {
    const s = await mapleSetup();
    const p = await maple(s);
    const when = dates(s, "America/Halifax", 12, 2);
    const booker = { first_name: "Mary Ann", last_name: "Otieno", email: "mary.ann@example.org" };
    const created = await ok<Body>(ucp(s, "POST", SESSIONS, session(p, when, { booker })), 201);
    expect(created.status).toBe("ready_for_complete");
    const held = (
      await ok<{ items: { item: { id: string } }[] }>(s.owner("GET", "/v1/owner/items?type=stay&open_only=false"))
    ).items[0]?.item.id;
    // Progressive: a phone, then the guests and who is the primary one, and why they travel.
    const enriched = session(p, when, {
      booker: { ...booker, phone_number: "+1 902 555 0144" },
      guests: [
        { id: "g-a", first_name: "Joseph", last_name: "Otieno" },
        { id: "g-b", first_name: "Mary Ann", last_name: "Otieno" },
      ],
      assign: [
        { guest_id: "g-a", role: "primary" },
        { guest_id: "g-b", role: "accompanying" },
      ],
      travel_purpose: "leisure",
    });
    const more = await ok<Body>(ucp(s, "PUT", `${SESSIONS}/${created.id}`, enriched));
    expect(more.status).toBe("ready_for_complete");
    expect(await states(s)).toEqual(["held"]);
    // A read gives back what was sent: the booker as written, every guest's id and role, the purpose.
    const read = await ok<Body>(ucp(s, "GET", `${SESSIONS}/${created.id}`));
    expect(read.booker).toEqual({ ...booker, phone_number: "+1 902 555 0144" });
    expect(read.guests?.map((g) => g.id)).toEqual(["g-a", "g-b"]);
    expect(read.stays[0]?.guest_assignments).toEqual([
      { guest_id: "g-a", role: "primary" },
      { guest_id: "g-b", role: "accompanying" },
    ]);
    expect(read.travel_purpose).toBe("leisure");
    // The held stay carries the primary guest's name now, and the companion's.
    const stay = await ok<{ item: { id: string; payload: { guests?: unknown } } }>(
      s.owner("GET", `/v1/owner/items/${held}`),
    );
    expect(stay.item.payload.guests).toEqual({
      lead: { name: "Joseph Otieno" },
      others: [{ name: "Mary Ann Otieno" }],
    });
    // A platform that reads and sends the whole session back changes nothing.
    const { ucp: _envelope, id: _id, status: _status, ...whole } = read as unknown as Record<string, unknown>;
    const same = await ok<Body>(ucp(s, "PUT", `${SESSIONS}/${created.id}`, whole));
    expect(same.status).toBe("ready_for_complete");
    expect(await states(s)).toEqual(["held"]);
    // Another person to book for, at another address: a hold for them, the first let go.
    const other = await ok<Body>(
      ucp(
        s,
        "PUT",
        `${SESSIONS}/${created.id}`,
        session(p, when, { booker: { first_name: "Kofi", last_name: "Asante", email: "kofi@example.org" } }),
      ),
    );
    expect(other.status).toBe("ready_for_complete");
    expect(await states(s)).toEqual(["expired", "held"]);
    expect((await ok<{ item: { state: string } }>(s.owner("GET", `/v1/owner/items/${held}`))).item.state).toBe(
      "expired",
    );
  });

  it("remembers what a session holding nothing was last told, and that it was cancelled", async () => {
    const s = await mapleSetup();
    const p = await maple(s);
    const first = dates(s, "America/Halifax", 10, 2);
    const later = dates(s, "America/Halifax", 20, 2);
    const created = await ok<Body>(ucp(s, "POST", SESSIONS, session(p, first)), 201);
    await ok<Body>(ucp(s, "PUT", `${SESSIONS}/${created.id}`, session(p, later)));
    const read = await ok<Body>(ucp(s, "GET", `${SESSIONS}/${created.id}`));
    expect(read.status).toBe("incomplete");
    expect(read.stays[0]?.stay_dates).toEqual(later);
    const cancelled = await ok<Body>(ucp(s, "POST", `${SESSIONS}/${created.id}/cancel`, {}));
    expect(cancelled.status).toBe("canceled");
    expect((await ok<Body>(ucp(s, "GET", `${SESSIONS}/${created.id}`))).status).toBe("canceled");
    const after = await ok<Body>(ucp(s, "PUT", `${SESSIONS}/${created.id}`, session(p, later, { booker: BOOKER })));
    expect(codes(after)).toContain("not_modifiable");
    expect(await states(s)).toEqual([]);
  });

  it("reads a hold whose time ran out as over, swept or not, and books nothing on it", async () => {
    const s = await mapleSetup();
    const p = await maple(s);
    const created = await ok<Body>(
      ucp(s, "POST", SESSIONS, session(p, dates(s, "America/Halifax", 10, 2), { booker: BOOKER })),
      201,
    );
    expect(created.status).toBe("ready_for_complete");
    s.clock.now = Date.parse(created.expires_at as string) + 1_000;
    const late = await ok<Body>(ucp(s, "POST", `${SESSIONS}/${created.id}/complete`, {}));
    expect(late.status).toBe("canceled");
    expect(late.messages ?? []).toEqual([]);
    expect(await states(s)).not.toContain("confirmed");
  });

  it("gives two rooms alike two stays, each with its own id", async () => {
    const s = await mapleSetup();
    const p = await maple(s, { kept: 2 });
    const body = session(p, dates(s, "America/Halifax", 15, 2), { booker: BOOKER });
    body.stays = [body.stays[0] as (typeof body.stays)[number], body.stays[0] as (typeof body.stays)[number]];
    const created = await ok<Body>(ucp(s, "POST", SESSIONS, body), 201);
    expect(created.status).toBe("ready_for_complete");
    expect(created.stays.map((x) => x.id)).toEqual([`${p.room}__${p.plan}`, `${p.room}__${p.plan}__2`]);
    expect(checkUcpBooking(created as never)).toEqual([]);
  });

  it("says when the guests do not fit the room, and finds no session it did not make", async () => {
    const s = await mapleSetup();
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

  it("spends what a hold spends: twenty sessions an hour from one address", async () => {
    const s = await mapleSetup();
    const p = await maple(s);
    const when = dates(s, "America/Halifax", 10, 2);
    for (let i = 0; i < 20; i++) expect((await ucp(s, "POST", SESSIONS, session(p, when))).status).toBe(201);
    expect((await ucp(s, "POST", SESSIONS, session(p, when))).status).toBe(429);
  });

  it("keeps Idempotency-Key as UCP says, and gives a session's id back only to the key that made it", async () => {
    const s = await mapleSetup();
    const p = await maple(s, { kept: 2 });
    const platform = (await createApiKey(s.db, { kind: "agent", name: "Platform A" })).key;
    const as = (key: string, idem: string) => ({ authorization: `Bearer ${key}`, "idempotency-key": idem });
    const body = session(p, dates(s, "America/Halifax", 10, 2), { booker: BOOKER });

    // The same Create again is the same session, and nothing is held twice.
    const created = await ucp(s, "POST", SESSIONS, body, as(platform, "c-1"));
    expect(created.status).toBe(201);
    const first = (await created.json()) as Body;
    const replay = await ucp(s, "POST", SESSIONS, body, as(platform, "c-1"));
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(((await replay.json()) as Body).id).toBe(first.id);
    expect(await states(s)).toEqual(["held"]);
    // Another body under that key is a conflict.
    const other = await ucp(s, "POST", SESSIONS, session(p, dates(s, "America/Halifax", 30, 2)), as(platform, "c-1"));
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ code: "idempotency_conflict" });

    // Booked, and the Create replayed: its first answer, never a second hold beside the stay.
    await ok<Body>(ucp(s, "POST", `${SESSIONS}/${first.id}/complete`, {}, { "idempotency-key": "done-1" }));
    const late = await ucp(s, "POST", SESSIONS, body, as(platform, "c-1"));
    expect(late.status).toBe(201);
    expect(((await late.json()) as Body).id).toBe(first.id);
    expect(await states(s)).toEqual(["awaiting_payment"]);
    // Complete, Update and Cancel keep their keys too, within the session.
    const completeAgain = await ucp(s, "POST", `${SESSIONS}/${first.id}/complete`, {}, { "idempotency-key": "done-1" });
    expect(completeAgain.headers.get("idempotent-replayed")).toBe("true");
    const mismatch = await ucp(
      s,
      "POST",
      `${SESSIONS}/${first.id}/complete`,
      { payment: {} },
      {
        "idempotency-key": "done-1",
      },
    );
    expect(mismatch.status).toBe(409);

    // Unsigned, from one address: whoever sends the key again gets no session's id, whatever the body.
    const victim = session(p, dates(s, "America/Halifax", 40, 2), {
      booker: { first_name: "Wanjiru", last_name: "Kamau", email: "wanjiru@example.org" },
    });
    const made = await ucp(s, "POST", SESSIONS, victim, { "idempotency-key": "v-1" });
    expect(made.status).toBe(201);
    const theirs = (await made.json()) as Body;
    for (const tried of [victim, session(p, dates(s, "America/Halifax", 40, 2))]) {
      const copy = await ucp(s, "POST", SESSIONS, tried, { "idempotency-key": "v-1" });
      expect(copy.status).toBe(409);
      expect(JSON.stringify(await copy.json())).not.toContain(theirs.id);
    }
    const still = await ok<Body>(ucp(s, "GET", `${SESSIONS}/${theirs.id}`));
    expect(still.status).toBe("ready_for_complete");
    expect(still.booker).toMatchObject({ email: "wanjiru@example.org" });
  });
});

describe("Kijani House, Nairobi: paid at the property, a levy it collects itself (KES)", () => {
  it("holds when the lead comes with the first request, discloses the levy, and books at once", async () => {
    const s = await setup({ name: "Kijani House", timezone: "Africa/Nairobi", currency: "KES", ucpLodging: true });
    const p = await kijani(s);
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
    expect(local?.content).toBe(
      "Paid to Kijani House at the property, not with the booking: Tourism levy 2% (at most 7 nights).",
    );
    expect(created.stays[0]?.accommodation_type.capacity.child_age_ranges).toEqual([
      { ages: { min: 0, max: 4 }, limit: 0 },
      { ages: { min: 5, max: 17 } },
    ]);
    expect(checkUcpBooking(created as never)).toEqual([]);
    // Nothing is due now: booked.
    const done = await ok<Body>(ucp(s, "POST", `${SESSIONS}/${created.id}/complete`, { payment: {} }));
    expect(done.status).toBe("completed");
    expect(done.booker).toMatchObject({ first_name: "Wanjiru", last_name: "Kamau", phone_number: "+254700000123" });
    expect(checkUcpBooking(done as never)).toEqual([]);
    const stay = await ok<{ item: { state: string } }>(s.owner("GET", `/v1/owner/items/${done.confirmation?.id}`));
    expect(stay.item.state).toBe("confirmed");
  });

  it("answers for as long as the stay lives, never calls a booked stay cancelled, and goes when the guest is erased", async () => {
    const s = await setup({ name: "Kijani House", timezone: "Africa/Nairobi", currency: "KES", ucpLodging: true });
    const p = await kijani(s);
    const body = session(p, dates(s, "Africa/Nairobi", 60, 2), {
      booker: { first_name: "Amani", last_name: "Otieno", email: "amani@example.org" },
    });
    const created = await ok<Body>(ucp(s, "POST", SESSIONS, body, { "idempotency-key": "k-60" }), 201);
    const done = await ok<Body>(ucp(s, "POST", `${SESSIONS}/${created.id}/complete`, {}));
    expect(done.status).toBe("completed");
    // A month and a day later, the retry records long pruned: still booked, and a cancel says so.
    s.clock.now += 31 * DAY;
    await pruneIdempotencyKeys(s.db, s.clock.now);
    expect((await ok<Body>(ucp(s, "GET", `${SESSIONS}/${created.id}`))).status).toBe("completed");
    const cancel = await ok<Body>(ucp(s, "POST", `${SESSIONS}/${created.id}/cancel`, {}));
    expect(cancel.status).toBe("completed");
    expect(codes(cancel)).toContain("not_cancelable");
    expect(await states(s)).toEqual(["confirmed"]);
    // Erased: the session goes whole with them, and its id finds nothing.
    const party = String(
      (
        await s.db.client.query({
          sql: "SELECT party_id FROM items WHERE id = ?",
          params: [done.confirmation?.id ?? ""],
          method: "all",
        })
      ).rows[0]?.[0],
    );
    const asked = await s.owner("POST", `/v1/owner/customers/${party}/erase`, {});
    const confirm = ((await asked.json()) as { details: { confirm: string } }).details.confirm;
    await ok(s.owner("POST", `/v1/owner/customers/${party}/erase`, { confirm }));
    expect((await ucp(s, "GET", `${SESSIONS}/${created.id}`)).status).toBe(404);
    const left = await s.db.client.query({ sql: "SELECT COUNT(*) FROM ucp_sessions", method: "all" });
    expect(Number(left.rows[0]?.[0])).toBe(0);
  });

  it("sends a platform to the property's own engine with the dates filled in, when that is where it books", async () => {
    const s = await setup({ name: "Kijani House", timezone: "Africa/Nairobi", currency: "KES", ucpLodging: true });
    const p = await kijani(s);
    await ok(
      s.owner("PUT", "/v1/owner/settings", {
        doc: {
          doorsElsewhere: [
            {
              itemType: "stay",
              url: "https://engine.example.net/kijani",
              urlTemplate: "https://engine.example.net/kijani?in={check_in}&out={check_out}&adults={adults}",
            },
          ],
        },
      }),
    );
    const when = dates(s, "Africa/Nairobi", 14, 3);
    const refused = await ok<Body>(ucp(s, "POST", SESSIONS, session(p, when)));
    expect(refused.ucp.status).toBe("error");
    expect(refused.messages?.[0]?.content).toBe("This property takes bookings on its own website: continue there.");
    expect(refused.continue_url).toBe(
      `https://engine.example.net/kijani?in=${when.start_date}&out=${when.end_date}&adults=2`,
    );
  });
});

describe("Ryokan Hoshi, Kyoto: every stay answered by the ryokan itself (JPY)", () => {
  it("is not served: no profile, and a session is refused in plain words", async () => {
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
    expect(refused.messages?.[0]?.content).toMatch(/^Ryokan Hoshi confirms each stay itself, within \d+ hours/);
    expect(refused.continue_url).toBeUndefined();
    expect(await states(s)).toEqual([]);
  });
});
