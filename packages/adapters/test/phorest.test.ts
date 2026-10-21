import {
  type Caller,
  Capabilities,
  CONNECTOR_WRITE_RESOLVE_KIND,
  createRunner,
  createSecretBox,
  gallery,
  schema,
  transitionItem,
  ulid,
  writeResolveHandler,
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
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
import { fakePlatform, json } from "./fakes/platform";
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

async function salon(ph: FakePhorest, ready = true, times?: "instant" | "local") {
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
  caps.connectors.attach({
    definitions: builtInConnectors({ phorestReady: ready, phorestTimes: times }),
    http: ph.platform.http,
  });
  return { db, caps };
}

async function connected(times?: "instant" | "local") {
  const ph = fakePhorest({ times });
  const s = await salon(ph, true, times);
  const conn = await s.caps.connectors.connect(owner, {
    kind: "phorest",
    preset: "us",
    values: { business_id: BUSINESS, username: "desk@mapleandfade.example", password: PASSWORD },
  });
  return { ...s, ph, conn };
}

/** Phorest's services and staff kept, as the owner presses "keep" on what it read. */
async function imported(times?: "instant" | "local") {
  const s = await connected(times);
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

/** As `book`, for a customer's assistant bound to them. */
async function bookAs(caps: Capabilities, caller: Caller, input: Parameters<Capabilities["createBooking"]>[1]) {
  try {
    return await caps.createBooking(caller, input);
  } catch (error) {
    const sha = (error as { details?: { terms_sha?: unknown } }).details?.terms_sha;
    if (typeof sha !== "string") throw error;
    return caps.createBooking(caller, { ...input, terms_sha: sha });
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
    const hint = "Not available yet. When it is, you connect with the API access Phorest gives your salon.";
    expect(card?.ways.map((w) => [w.label, w.status, w.hint])).toEqual([
      ["Phorest · Europe", "setup", hint],
      ["Phorest · Americas & Australia", "setup", hint],
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
    expect(mb.ready?.()).toMatch(/Mindbody has to approve it first/);
    expect(mb.connect).toBeUndefined();
    expect(mb.bookings).toBeUndefined();
    const card = gallery(new Map([[mb.kind, mb]])).find((c) => c.id === "mindbody");
    expect(card?.ways.map((w) => [w.status, w.hint])).toEqual([
      ["setup", "Not available yet: Mindbody has to approve it first."],
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
    // Ravi's own price comes before his level's.
    expect(fade?.overrides).toEqual([
      { staff: STAFF_MEI, durationMin: 45 },
      { staff: STAFF_RAVI, price: { value: 5500, currency: "CAD" } },
    ]);
    // Ravi does not shave with a straight razor; the front desk is hidden from online booking; Mei is a
    // senior barber, whose shave is priced by her level. Colour correction, hidden online, is not offered.
    expect(snapshot.services?.[1]?.staff).toEqual([STAFF_MEI]);
    expect(snapshot.services?.[1]?.overrides).toEqual([{ staff: STAFF_MEI, price: { value: 3800, currency: "CAD" } }]);
    expect(snapshot.services?.map((s) => s.name)).not.toContain("Colour correction");
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

  it("gives a time with only its start the member of staff's own length, and asks Phorest once a minute", async () => {
    const { caps, fade, mei, ravi, ph } = await imported();
    ph.startsOnly();
    const q = { service_id: fade.id, from: "2026-11-04T12:00:00Z", to: "2026-11-04T23:00:00Z" };
    const r = await caps.checkAvailability(q, { now: T0, caller: agent });
    const five = r.slots.find((s) => s.startTime === "2026-11-04T17:00:00.000Z") as
      | { staff?: { id: string; endTime: string }[] }
      | undefined;
    expect(five?.staff).toEqual([
      { id: mei.id, name: "Mei", endTime: "2026-11-04T17:45:00.000Z" },
      { id: ravi.id, name: "Ravi", endTime: "2026-11-04T17:30:00.000Z" },
    ]);
    // The same question again, moments later: answered from what Phorest said.
    await caps.checkAvailability(q, { now: T0 + 5_000, caller: agent });
    const asked = ph.platform.requests(
      "POST",
      `${PHOREST_US}/api/business/${BUSINESS}/branch/X9QpRsZ3bSvhJAaakg9TXQ/appointments/availability`,
    );
    expect(asked.length).toBe(1);
    // Times nothing can read are not "nothing free": the inbox's own are offered.
    ph.garbleTimes();
    const own = await caps.checkAvailability(
      { service_id: fade.id, from: "2026-11-04T17:00:00Z", to: "2026-11-04T19:00:00Z" },
      { now: T0, caller: agent },
    );
    expect(own.slots.length).toBeGreaterThan(0);
  });

  it("keeps no price in another currency, or in one the branch never named", async () => {
    const { caps, snapshot } = await imported();
    const euros = {
      ...snapshot,
      services: snapshot.services?.map((s) => ({ ...s, price: s.price ? { ...s.price, currency: "EUR" } : s.price })),
    };
    await caps.staff.importSetup(owner, euros, { source: "phorest", services: [SERVICE_FADE] });
    const fade = (await caps.setup.listServices(owner)).find((x) => x.externalId === SERVICE_FADE);
    expect(fade?.price).toBeNull();
    // A branch that names no currency gives no prices at all.
    const p = fakePlatform()
      .on("GET", `${PHOREST_US}/api/business/${BUSINESS}/branch`, () =>
        json({ _embedded: { branches: [{ branchId: "b1", name: "Queen West", timeZone: "America/Toronto" }] } }),
      )
      .on("GET", `${PHOREST_US}/api/business/${BUSINESS}/branch/b1/service`, () =>
        json({ _embedded: { services: [{ serviceId: "s1", name: "Trim", duration: 30, price: 25 }] } }),
      )
      .on("GET", `${PHOREST_US}/api/business/${BUSINESS}/branch/b1/staff`, () => json({ _embedded: { staffs: [] } }));
    const def = phorestConnector({ ready: true });
    const inbox = {
      id: "i",
      origin: "https://inbox.example.com",
      host: "inbox.example.com",
      name: "Maple & Fade",
      timezone: "America/Toronto",
      language: "en",
    };
    const conn = await def.connect?.(
      { http: p.http, now: T0, inbox },
      { region: "us", business_id: BUSINESS, username: "desk@mapleandfade.example", password: PASSWORD },
    );
    const read = await def.setup?.read({
      http: p.http,
      now: T0,
      inbox,
      secret: conn?.secret ?? {},
      extra: conn?.extra ?? {},
    } as never);
    expect(read?.services?.map((s) => [s.name, s.price])).toEqual([["Trim", null]]);
  });

  it("can send Phorest the branch's own wall times, should a test branch show it reads those", async () => {
    const { caps, fade, mei, ph } = await imported("local");
    const r = await book(caps, {
      payload: { ...at("2026-11-04T17:00:00Z"), reservationFor: { serviceId: fade.id, name: "Skin fade" } },
      contact: { name: "Aiyana Whitehorse", email: "aiyana@example.com" },
      staff_id: mei.id,
      idempotency_key: "ph-local",
    });
    expect(r.view.item.state).toBe("confirmed");
    const sent = JSON.parse(
      ph.platform.requests("POST", `${PHOREST_US}/api/business/${BUSINESS}/branch/X9QpRsZ3bSvhJAaakg9TXQ/booking`)[0]
        ?.body ?? "{}",
    );
    expect(sent.clientAppointmentSchedules[0].serviceSchedules[0].startTime).toBe("2026-11-04T12:00:00");
    expect(ph.bookings.get(BOOKING_ID)?.start).toBe("2026-11-04T17:00:00.000Z");
    // Its free times, in wall time too, read as the same instants.
    const free = await caps.checkAvailability(
      { service_id: fade.id, from: "2026-11-05T12:00:00Z", to: "2026-11-05T23:00:00Z" },
      { now: T0, caller: agent },
    );
    expect(free.slots[0]?.startTime).toBe("2026-11-05T17:00:00.000Z");
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

/** A client the salon already knows: a party, with a cut here last month, and an assistant bound to them. */
async function returning(db: Awaited<ReturnType<typeof freshDb>>["db"], serviceId: string) {
  const partyId = ulid(T0);
  await db.orm.insert(schema.parties).values({
    id: partyId,
    kind: "person",
    displayName: "Aiyana Whitehorse",
    contact: { name: "Aiyana Whitehorse", email: "aiyana@example.com" },
    createdAt: T0,
    updatedAt: T0,
  });
  const start = T0 - 30 * 86_400_000;
  await db.orm.insert(schema.items).values({
    id: ulid(T0 - 1),
    type: "booking",
    state: "completed",
    version: 1,
    partyId,
    channel: "rest",
    payload: {
      reservationFor: { serviceId, name: "Skin fade" },
      startTime: new Date(start).toISOString(),
      endTime: new Date(start + 30 * 60_000).toISOString(),
    },
    flags: {},
    createdAt: start,
    updatedAt: start,
  });
  const bound: Caller = { ...agent, actor: { ...agent.actor, partyId } };
  return bound;
}

describe("Phorest, nothing else confirms first", () => {
  /** The salon's rules on, a returning client, and the jobs a running inbox does every second. */
  async function withRules() {
    const s = await imported();
    await s.caps.setup.applyPreset(owner, { preset: "salon", replace: true });
    const client = await returning(s.db, s.fade.id);
    const runner = createRunner({ mailOut: logMailOut() }).register(
      CONNECTOR_WRITE_RESOLVE_KIND,
      writeResolveHandler(),
    );
    const drain = async (now: number) => {
      for (let i = 0; i < 10; i++) if ((await runner.runDue(s.db, { now, limit: 100 })).claimed === 0) return;
    };
    const request = (idem: string, start = "2026-11-04T17:00:00Z") =>
      bookAs(s.caps, client, {
        payload: { ...at(start), reservationFor: { serviceId: s.fade.id, name: "Skin fade" } },
        contact: { name: "Aiyana Whitehorse", email: "aiyana@example.com" },
        staff_id: s.mei.id,
        idempotency_key: idem,
      });
    return { ...s, client, drain, request };
  }

  it("no rule confirms a booking Phorest would not take", async () => {
    const { db, ph, drain, request } = await withRules();
    ph.refuseNext();
    const r = await request("rules-1");
    await drain(T0 + 1_000);
    expect(await stateOf(db, r.view.item.id)).toEqual({ state: "requested", needsHuman: true });
    expect(ph.bookings.size).toBe(0);
  });

  it("no rule confirms one while Phorest's answer is on its way, nor once it was lost", async () => {
    const { db, caps, ph, drain, request } = await withRules();
    const slow = ph.holdNext();
    const pending = request("rules-2");
    await slow.reached;
    // The rules job runs while the inbox waits for Phorest: it promises nothing.
    await drain(T0 + 1_000);
    expect((await stateOf(db, (await newestBooking(db)) ?? "")).state).toBe("requested");
    slow.release();
    const r = await pending;
    expect(r.view.item.state).toBe("confirmed");
    // Lost, and not found at once: still a request until the job that looks for it finds it.
    ph.loseNextAnswer();
    ph.platform.fail("GET", `${PHOREST_US}/api/business/${BUSINESS}/branch/:b/appointment`, 500);
    const lost = await request("rules-3", "2026-11-04T18:00:00Z");
    await drain(T0 + 1_000);
    expect((await stateOf(db, lost.view.item.id)).state).toBe("requested");
    await drain(T0 + 60_000);
    expect((await stateOf(db, lost.view.item.id)).state).toBe("confirmed");
    // Found by the job, it is kept as Phorest's: the next sync does not book it there a second time.
    const before = ph.bookings.size;
    await caps.connectors.run(String((await caps.connectors.list(owner))[0]?.id), T0 + 61_000, "push");
    expect(ph.bookings.size).toBe(before);
  });

  it("the owner's confirm writes it to Phorest first, and waits while Phorest has not answered", async () => {
    const { db, caps, ph, request } = await withRules();
    ph.refuseNext();
    const r = await request("owner-1");
    expect((await stateOf(db, r.view.item.id)).state).toBe("requested");
    // Phorest takes it now: the owner's confirm made it there first.
    const done = await caps.transitionItem(owner, { item_id: r.view.item.id, event: "confirm" });
    expect(done.view.item.state).toBe("confirmed");
    expect([...ph.bookings.values()].map((b) => b.status)).toEqual(["ACTIVE"]);
    // Refused again: nothing is confirmed, and the owner reads why.
    ph.refuseNext();
    const again = await request("owner-2", "2026-11-04T18:00:00Z");
    ph.refuseNext();
    await expect(caps.transitionItem(owner, { item_id: again.view.item.id, event: "confirm" })).rejects.toMatchObject({
      code: "guard_failed",
      details: { guard: "system_first" },
    });
    expect((await stateOf(db, again.view.item.id)).state).toBe("requested");
    // The owner's AI never confirms it: it drafts for the owner.
    const ai: Caller = { ...owner, actor: { kind: "owner_ai", id: "ai", channel: "mcp_owner" } };
    await expect(caps.transitionItem(ai, { item_id: again.view.item.id, event: "confirm" })).rejects.toMatchObject({
      details: { guard: "system_first", draft_for_owner: true },
    });
  });

  it("a customer's yes to another time goes to a person, whose confirm writes that time to Phorest", async () => {
    const { db, caps, ph, client, request } = await withRules();
    ph.refuseNext();
    const r = await request("other-1");
    await caps.transitionItem(owner, {
      item_id: r.view.item.id,
      event: "propose",
      input: { startTime: "2026-11-04T18:00:00Z", endTime: "2026-11-04T18:45:00Z" },
    });
    const as: Caller = { ...client, ...(r.accessToken ? { accessToken: r.accessToken } : {}) };
    const sha = await caps.customer
      .acceptOffer(as, { item_id: r.view.item.id, idempotency_key: "yes-0" })
      .catch((e: { details?: { terms_sha?: string } }) => e.details?.terms_sha);
    const yes = await caps.customer.acceptOffer(as, {
      item_id: r.view.item.id,
      terms_sha: String(sha),
      idempotency_key: "yes-1",
    });
    // Nothing binds yet: their yes is a person's to confirm, and they are told so plainly.
    expect(yes).toMatchObject({ waiting_on: "us", appended: true });
    expect((yes as { passed_on: string }).passed_on).not.toMatch(/as agreed/);
    expect((await stateOf(db, r.view.item.id)).state).toBe("proposed");
    expect(ph.bookings.size).toBe(0);
    const done = await caps.transitionItem(owner, { item_id: r.view.item.id, event: "confirm" });
    expect(done.view.item.state).toBe("confirmed");
    expect([...ph.bookings.values()].map((b) => [b.start, b.status])).toEqual([["2026-11-04T18:00:00.000Z", "ACTIVE"]]);
  });

  it("a booking Phorest took but the inbox cannot confirm is taken back out of Phorest", async () => {
    const { db, ph, mei, request } = await withRules();
    const first = await request("back-1");
    expect(first.view.item.state).toBe("confirmed");
    // The same time with Mei again: taken here, so it is never written to Phorest at all.
    const twice = await request("back-2");
    expect(await stateOf(db, twice.view.item.id)).toEqual({ state: "requested", needsHuman: true });
    expect(ph.bookings.size).toBe(1);
    // Taken here while Phorest was answering: Phorest's booking is cancelled there, and the owner told.
    const slow = ph.holdNext();
    const late = request("back-3", "2026-11-04T18:00:00Z");
    await slow.reached;
    const bucket = Date.parse("2026-11-04T18:00:00Z");
    await db.client.query({
      sql: "INSERT INTO slot_claims (resource_key, bucket_start, ordinal, item_id, offer_id) VALUES (?, ?, 0, 'walk-in', '')",
      params: [`resource:${mei.id}`, bucket],
      method: "run",
    });
    slow.release();
    const r = await late;
    expect(await stateOf(db, r.view.item.id)).toEqual({ state: "requested", needsHuman: true });
    expect([...ph.bookings.values()].map((b) => b.status)).toEqual(["ACTIVE", "CANCELED"]);
    const { rows } = await db.client.query({
      sql: "SELECT outcome FROM connector_writes WHERE item_id = ?",
      params: [r.view.item.id],
      method: "all",
    });
    expect(rows).toEqual([["rolled_back"]]);
    const notes = await db.orm
      .select()
      .from(schema.threadEntries)
      .where(eq(schema.threadEntries.itemId, r.view.item.id));
    expect(notes.map((n) => n.bodyText).join(" ")).toContain("taken back out of Phorest");
  });
});

/** The one booking still to happen: the request the inbox is waiting on. */
async function newestBooking(db: Awaited<ReturnType<typeof freshDb>>["db"]): Promise<string | null> {
  const rows = await db.orm.select().from(schema.items).where(eq(schema.items.type, "booking"));
  return rows.find((r) => r.state !== "completed")?.id ?? null;
}

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
