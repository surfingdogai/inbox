import { type Caller, Capabilities, createSecretBox, gallery, schema, transitionItem } from "@surfingdog/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  builtInConnectors,
  MINDBODY_READY,
  mindbodyConnector,
  PHOREST_READY,
  phorestConnector,
  phorestUsername,
  weeklyFromRoster,
} from "../src/index";
import { freshDb } from "./db";
import { type FakePhorest, fakePhorest } from "./fakes/phorest";
import { BOOKING_ID, BUSINESS, PASSWORD, PHOREST_US, SERVICE_FADE, STAFF_MEI, STAFF_RAVI } from "./fixtures/phorest";

/**
 * Phorest (ADR-035), a salon's own booking system, against a fake answering in its reference's shapes
 * (fakes/phorest.ts, fixtures/phorest.ts), through the inbox's own connector client: start from its
 * services, staff and rosters; offer its free times; write each booking there first and confirm it here
 * only once Phorest took it; look for one whose answer was lost before deciding anything; cancel it there
 * when it is cancelled here. Off until the company switches it on, and Mindbody off altogether. Nothing
 * here reaches a real host. Runs on Node and in workerd.
 */

const T0 = Date.parse("2026-11-03T12:00:00Z");
const KEY = "phorest-adapters-instance-key-0123456789";
const owner: Caller = {
  actor: { kind: "owner", id: "owner_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const agent: Caller = {
  actor: { kind: "customer_agent", id: "agent:test", channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => T0,
};

async function salon(ph: FakePhorest, ready = true) {
  const { db } = await freshDb();
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Maple & Fade",
    timezone: "America/Toronto",
    currency: "CAD",
    languages: ["en", "fr"],
    createdAt: T0,
    updatedAt: T0,
  });
  const caps = new Capabilities(db, createSecretBox([KEY]), "https://inbox.example.com", 0);
  await caps.updateSettings(owner, {
    doc: { business: { name: "Maple & Fade", timezone: "America/Toronto", currency: "CAD" } },
  });
  const day: [string, string][] = [["09:00", "19:00"]];
  await caps.setup.setWeekly(owner, { weekly: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day } });
  caps.connectors.attach({ definitions: builtInConnectors({ phorestReady: ready }), http: ph.platform.http });
  return { db, caps };
}

async function connected() {
  const ph = fakePhorest();
  const s = await salon(ph);
  const conn = await s.caps.connectors.connect(owner, {
    kind: "phorest",
    preset: "us",
    values: { business_id: BUSINESS, username: "desk@mapleandfade.example", password: PASSWORD },
  });
  return { ...s, ph, conn };
}

/** Phorest's services and staff kept, as the owner presses "keep" on what it read. */
async function imported() {
  const s = await connected();
  const snapshot = await s.caps.connectors.setupSnapshot(owner, s.conn.id);
  await s.caps.staff.importSetup(owner, snapshot, {
    source: "phorest",
    services: snapshot.services?.map((x) => x.externalId) ?? [],
    staff: snapshot.staff?.map((x) => x.externalId) ?? [],
    hours: true,
  });
  const services = await s.caps.setup.listServices(owner);
  const fade = services.find((x) => x.externalId === SERVICE_FADE);
  const staff = await s.caps.staff.list(owner);
  const mei = staff.find((x) => x.externalId === STAFF_MEI);
  const ravi = staff.find((x) => x.externalId === STAFF_RAVI);
  if (!fade || !mei || !ravi) throw new Error("import did not keep what it read");
  return { ...s, snapshot, fade, mei, ravi };
}

const at = (iso: string) => ({
  reservationFor: { serviceId: "", name: "Skin fade" },
  startTime: iso,
  endTime: iso,
});

/** A booking request, confirmed by the customer at the confirm step as their assistant would. */
async function book(caps: Capabilities, input: Parameters<Capabilities["createBooking"]>[1]) {
  try {
    return await caps.createBooking(agent, input);
  } catch (error) {
    const sha = (error as { details?: { terms_sha?: unknown } }).details?.terms_sha;
    if (typeof sha !== "string") throw error;
    return caps.createBooking(agent, { ...input, terms_sha: sha });
  }
}

async function stateOf(db: Awaited<ReturnType<typeof freshDb>>["db"], id: string) {
  const [row] = await db.orm.select().from(schema.items).where(eq(schema.items.id, id));
  const flags = (row?.flags ?? {}) as { needsHuman?: boolean };
  return { state: row?.state, needsHuman: flags.needsHuman === true };
}

describe("Phorest, switched off", () => {
  it("is off until the company switches it on: the card says what it needs, and nothing connects", async () => {
    expect(PHOREST_READY).toBe(false);
    const defs = new Map(builtInConnectors({}).map((d) => [d.kind, d]));
    expect(defs.get("phorest")?.ready?.()).not.toBe(true);
    const card = gallery(defs).find((c) => c.id === "phorest");
    expect(card?.group).toBe("booking");
    expect(card?.ways.map((w) => [w.label, w.status, w.hint])).toEqual([
      ["Phorest (Europe)", "setup", "Needs setup: ask Phorest for API access for your salon"],
      ["Phorest (Americas, Australia)", "setup", "Needs setup: ask Phorest for API access for your salon"],
    ]);
    // No form, no button that goes nowhere.
    expect(card?.ways.every((w) => w.form.length === 0)).toBe(true);
    const ph = fakePhorest();
    const { caps } = await salon(ph, false);
    await expect(
      caps.connectors.connect(owner, {
        kind: "phorest",
        preset: "us",
        values: { business_id: BUSINESS, username: "desk@mapleandfade.example", password: PASSWORD },
      }),
    ).rejects.toMatchObject({ code: "not_allowed", details: { reason: "not_ready" } });
    expect(ph.platform.seen).toEqual([]);
  });

  it("Mindbody is off altogether, with no way to connect and nothing it would call", () => {
    expect(MINDBODY_READY).toBe(false);
    const mb = mindbodyConnector();
    expect(mb.ready?.()).toMatch(/developer account/);
    expect(mb.connect).toBeUndefined();
    expect(mb.bookings).toBeUndefined();
    const card = gallery(new Map([[mb.kind, mb]])).find((c) => c.id === "mindbody");
    expect(card?.ways.map((w) => [w.status, w.hint])).toEqual([
      ["setup", "Needs setup: our Mindbody developer account, and Mindbody's review"],
    ]);
  });
});

describe("Phorest, connected", () => {
  it("signs in with the salon's own credentials on the server it chose, and lets the owner choose the branch", async () => {
    const { conn, ph } = await connected();
    expect(phorestUsername("desk@mapleandfade.example")).toBe("global/desk@mapleandfade.example");
    expect(conn.account).toBe("Maple & Fade, Queen West");
    expect(conn.choices).toEqual([
      {
        key: "branch",
        label: "Branch",
        options: [{ id: "X9QpRsZ3bSvhJAaakg9TXQ", name: "Maple & Fade, Queen West" }],
        value: "X9QpRsZ3bSvhJAaakg9TXQ",
      },
    ]);
    const first = ph.platform.seen[0];
    expect(first?.url.origin).toBe("https://api-gateway-us.phorest.com");
    expect(first?.headers.get("authorization")).toBe(`Basic ${btoa(`global/desk@mapleandfade.example:${PASSWORD}`)}`);
    // The password is sealed: no view says it.
    expect(JSON.stringify(conn)).not.toContain(PASSWORD);
  });

  it("refuses credentials Phorest does not take, in the owner's words", async () => {
    const ph = fakePhorest();
    const { caps } = await salon(ph);
    await expect(
      caps.connectors.connect(owner, {
        kind: "phorest",
        preset: "us",
        values: { business_id: BUSINESS, username: "desk@mapleandfade.example", password: "wrong" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("reads its services, staff and rosters to start from, each member's own price and length kept", async () => {
    const { snapshot } = await imported();
    expect(snapshot.source.kind).toBe("phorest");
    // The add-on-only service and the archived one are not services to book.
    expect(snapshot.services?.map((s) => [s.name, s.durationMin, s.price])).toEqual([
      ["Skin fade", 30, { value: 4500, currency: "CAD" }],
      ["Straight razor shave", 20, { value: 3250, currency: "CAD" }],
    ]);
    const fade = snapshot.services?.[0];
    expect(fade?.staff).toEqual([STAFF_MEI, STAFF_RAVI]);
    expect(fade?.overrides).toEqual([
      { staff: STAFF_MEI, durationMin: 45 },
      { staff: STAFF_RAVI, price: { value: 5500, currency: "CAD" } },
    ]);
    // Ravi does not shave with a straight razor; the front desk is hidden from online booking.
    expect(snapshot.services?.[1]?.staff).toEqual([STAFF_MEI]);
    expect(snapshot.staff?.map((s) => s.name)).toEqual(["Mei Chen", "Ravi Sandhu"]);
    expect(snapshot.staff?.[0]?.hours).toEqual({
      wed: [["12:00", "19:00"]],
      thu: [
        ["10:00", "13:00"],
        ["14:00", "18:00"],
      ],
    });
  });

  it("keeps what the owner chose, once, and a second import updates it in place", async () => {
    const s = await imported();
    expect(s.mei.publicName).toBe("Mei");
    expect(s.ravi.services.find((x) => x.serviceId === s.fade.id)?.priceOverride).toBe(5500);
    expect(s.mei.services.find((x) => x.serviceId === s.fade.id)?.durationOverrideMin).toBe(45);
    expect(s.mei.hours).toEqual({
      wed: [["12:00", "19:00"]],
      thu: [
        ["10:00", "13:00"],
        ["14:00", "18:00"],
      ],
    });
    await s.caps.staff.importSetup(owner, s.snapshot, {
      source: "phorest",
      services: [SERVICE_FADE],
      staff: [STAFF_MEI, STAFF_RAVI],
    });
    expect((await s.caps.setup.listServices(owner)).length).toBe(2);
    expect((await s.caps.staff.list(owner)).length).toBe(2);
    // Only the owner, in person, keeps prices from another system.
    await expect(
      s.caps.staff.importSetup({ ...owner, actor: { kind: "owner_ai", id: "ai", channel: "mcp_owner" } }, s.snapshot, {
        source: "phorest",
        services: [SERVICE_FADE],
      }),
    ).rejects.toMatchObject({ code: "not_allowed" });
  });

  it("offers Phorest's own free times, with who is free, and the inbox's own when Phorest cannot say", async () => {
    const { caps, fade, mei, ravi, ph } = await imported();
    const r = await caps.checkAvailability(
      { service_id: fade.id, from: "2026-11-04T12:00:00Z", to: "2026-11-04T23:00:00Z" },
      { now: T0, caller: agent },
    );
    expect(r.slots.map((s) => [s.startTime, (s as { staff?: { id: string }[] }).staff?.map((x) => x.id)])).toEqual([
      ["2026-11-04T17:00:00.000Z", [mei.id, ravi.id]],
      ["2026-11-04T18:00:00.000Z", [mei.id]],
    ]);
    const body = JSON.parse(
      ph.platform.requests("POST", `${PHOREST_US}/api/business/${BUSINESS}/branch`).at(-1)?.body ?? "{}",
    );
    expect(body.clientServiceSelections[0].serviceSelections).toEqual([{ serviceId: SERVICE_FADE }]);
    // Phorest asks the inbox to slow down: the inbox's own times are offered, and the write still decides.
    ph.platform.fail("POST", `${PHOREST_US}/api/business/${BUSINESS}/branch/:b/appointments/availability`, 429);
    const own = await caps.checkAvailability(
      { service_id: fade.id, from: "2026-11-04T17:00:00Z", to: "2026-11-04T19:00:00Z" },
      { now: T0, caller: agent },
    );
    expect(own.slots.length).toBeGreaterThan(0);
  });

  it("writes the booking to Phorest first, as the salon's own client, and only then confirms it", async () => {
    const { db, caps, fade, mei, ph } = await imported();
    const r = await book(caps, {
      payload: { ...at("2026-11-04T17:00:00Z"), reservationFor: { serviceId: fade.id, name: "Skin fade" } },
      contact: { name: "Aiyana Whitehorse", email: "aiyana@example.com", phone: "+14165550134" },
      staff_id: mei.id,
      idempotency_key: "ph-1",
    });
    expect(r.view.item.state).toBe("confirmed");
    const order = ph.platform.seen.map((x) => `${x.method} ${x.url.pathname.replace(/^.*\/business\/[^/]+/, "")}`);
    expect(order.slice(-3)).toEqual(["GET /client", "POST /client", "POST /branch/X9QpRsZ3bSvhJAaakg9TXQ/booking"]);
    const client = JSON.parse(
      ph.platform.requests("POST", `${PHOREST_US}/api/business/${BUSINESS}/client`)[0]?.body ?? "{}",
    );
    expect(client).toMatchObject({ firstName: "Aiyana", lastName: "Whitehorse", email: "aiyana@example.com" });
    expect(String(client.externalId)).toMatch(/^sd-/);
    const written = ph.bookings.get(BOOKING_ID);
    expect(written).toMatchObject({
      serviceId: SERVICE_FADE,
      staffId: STAFF_MEI,
      start: "2026-11-04T17:00:00.000Z",
      end: "2026-11-04T17:45:00.000Z",
      status: "ACTIVE",
    });
    // Journalled under its key, and nothing that pays went to Phorest.
    const { rows } = await db.client.query({
      sql: "SELECT op, outcome, external_id, idem_key FROM connector_writes",
      method: "all",
    });
    expect(rows).toEqual([["reserve", "written", BOOKING_ID, `sd-${r.view.item.id}`]]);
    expect(ph.cardFields()).toEqual([]);

    // Cancelled here, it is cancelled in Phorest too.
    await transitionItem(db, owner, { itemId: r.view.item.id, event: "cancel_by_business", reason: "Mei is ill" });
    await caps.connectors.run(String((await caps.connectors.list(owner))[0]?.id), T0, "push");
    expect(ph.bookings.get(BOOKING_ID)?.status).toBe("CANCELED");
  });

  it("keeps a booking Phorest would not take as a request for a person, with nothing promised", async () => {
    const { db, caps, fade, mei, ph } = await imported();
    ph.refuseNext();
    const r = await book(caps, {
      payload: { ...at("2026-11-04T18:00:00Z"), reservationFor: { serviceId: fade.id, name: "Skin fade" } },
      contact: { name: "Kofi", email: "kofi@example.com" },
      staff_id: mei.id,
      idempotency_key: "ph-2",
    });
    expect(await stateOf(db, r.view.item.id)).toEqual({ state: "requested", needsHuman: true });
    const notes = await db.orm
      .select()
      .from(schema.threadEntries)
      .where(eq(schema.threadEntries.itemId, r.view.item.id));
    expect(notes.map((n) => n.bodyText).join(" ")).toContain("Phorest would not take this booking");
    expect(ph.bookings.size).toBe(0);
  });

  it("looks for a booking whose answer never came before deciding, and confirms it once found", async () => {
    const { caps, fade, mei, ph } = await imported();
    ph.loseNextAnswer();
    const r = await book(caps, {
      payload: { ...at("2026-11-04T17:00:00Z"), reservationFor: { serviceId: fade.id, name: "Skin fade" } },
      contact: { name: "Aiyana Whitehorse", email: "aiyana@example.com" },
      staff_id: mei.id,
      idempotency_key: "ph-3",
    });
    // Phorest took it, its answer was lost; found among the client's appointments that day, it is the one.
    expect(r.view.item.state).toBe("confirmed");
    expect(ph.bookings.size).toBe(1);
    const looked = ph.platform.seen.filter((x) => x.url.pathname.endsWith("/appointment"));
    expect(looked.length).toBe(1);
    expect(looked[0]?.url.searchParams.get("from_date")).toBe("2026-11-04");
  });
});

describe("Phorest, the pieces", () => {
  it("reads a roster as weekly hours, its time off cut out, days off left out", () => {
    const t = (hourOfDay: number, minuteOfHour = 0) => ({ hourOfDay, minuteOfHour });
    expect(
      weeklyFromRoster([
        { date: "2026-11-09", type: "WORKING", startTime: t(9, 30), endTime: t(17) },
        { date: "2026-11-10", type: "NON_WORKING" },
        {
          date: "2026-11-11",
          type: "WORKING",
          startTime: t(10),
          endTime: t(18),
          timeOffStartTime: t(12),
          timeOffEndTime: t(12, 30),
        },
      ]),
    ).toEqual({
      mon: [["09:30", "17:00"]],
      wed: [
        ["10:00", "12:00"],
        ["12:30", "18:00"],
      ],
    });
  });

  it("says a 429 as Phorest's own limit, to be tried again", async () => {
    const ph = fakePhorest();
    ph.platform.fail("GET", `${PHOREST_US}/api/business/${BUSINESS}/branch`, 429);
    const def = phorestConnector({ ready: true });
    await expect(
      def.connect?.(
        {
          http: ph.platform.http,
          now: T0,
          inbox: {
            id: "i",
            origin: "https://inbox.example.com",
            host: "inbox.example.com",
            name: "Maple & Fade",
            timezone: "America/Toronto",
            language: "en",
          },
        },
        { region: "us", business_id: BUSINESS, username: "desk@mapleandfade.example", password: PASSWORD },
      ),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });
});
