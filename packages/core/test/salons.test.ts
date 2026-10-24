import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Capabilities } from "../src/capabilities/service";
import { serviceInput } from "../src/capabilities/setup-types";
import type { ConnectorDefinition, ConnectorHttp, OutboundBooking } from "../src/connectors/sdk";
import { withdrawalCopy } from "../src/customer/copy";
import { createDb, type Db } from "../src/db";
import { customerCopyProblems } from "../src/i18n/customer-words";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { policySentence } from "../src/policy/words";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, items, parties } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { bookingSchedules, cancelFeeOf, cleanPhoto, staffWords, stripJpegMetadata } from "../src/staff/index";
import { type Caller, transitionItem, WriteError } from "../src/write/index";
import { customerItem, rowToItem } from "../src/write/views";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * Salons, barbers and beauty (ADR-035), against the inbox itself on Node and in workerd: staff who give
 * services at their own lengths and prices, with their own hours and their own calendars; bookings for
 * anyone go to whoever is free; add-ons make a booking longer; what must come first is checked against
 * this business's own bookings, and never shows anyone else's; a deposit on the business's own payment
 * platform in its own currency's minor unit; and the fee for cancelling said before anything is
 * cancelled. Fixtures rotate the world: Maple & Fade (Toronto, CAD, en/fr), Ìfẹ́ Beauty Studio (Lagos,
 * NGN) and a barber in Seoul (KRW, no minor unit).
 */

// Tuesday 3 November 2026, 07:00 in Toronto (UTC-5 since 1 November).
const T0 = Date.parse("2026-11-03T12:00:00Z");
const DAY = 86_400_000;
const at = (local: string, offset = "-05:00") => `2026-11-03T${local}:00${offset}`;
const KEY = "salons-core-instance-key-0123456789abcdef";

const owner: Caller = {
  actor: { kind: "owner", id: "owner_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const agent = (partyId?: string): Caller => ({
  actor: { kind: "customer_agent", id: "agent:test", channel: "rest", ...(partyId ? { partyId } : {}) },
  tier: "anonymous",
  sandbox: false,
  now: () => T0,
});

const noHttp: ConnectorHttp = {
  request: () => Promise.reject(new Error("no network in this test")),
};

async function salon(opts: {
  readonly name: string;
  readonly zone: string;
  readonly currency: string;
  readonly languages: string[];
}): Promise<{ db: Db; caps: Capabilities }> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm.insert(business).values({
    id: "self",
    name: opts.name,
    timezone: opts.zone,
    currency: opts.currency,
    languages: opts.languages,
    createdAt: T0,
    updatedAt: T0,
  });
  const caps = confirming(new Capabilities(db, createSecretBox([KEY]), "https://inbox.example.com", 0));
  await caps.updateSettings(owner, {
    doc: { business: { name: opts.name, timezone: opts.zone, currency: opts.currency }, booking: { minNoticeMin: 60 } },
  });
  const day: [string, string][] = [["09:00", "19:00"]];
  await caps.setup.setWeekly(owner, { weekly: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day } });
  return { db, caps };
}

async function mapleAndFade() {
  const s = await salon({ name: "Maple & Fade", zone: "America/Toronto", currency: "CAD", languages: ["en", "fr"] });
  const fade = await s.caps.setup.createService(
    owner,
    serviceInput.parse({
      name: "Skin fade",
      duration_min: 30,
      granularity_min: 15,
      price: { model: "fixed", value: 4500, currency: "CAD" },
      add_ons: [{ name: "Hot towel", duration_min: 15, price: { value: 1000, currency: "CAD" } }],
    }),
  );
  const beard = await s.caps.setup.createService(
    owner,
    serviceInput.parse({
      name: "Beard trim",
      duration_min: 15,
      granularity_min: 15,
      price: { model: "fixed", value: 2000, currency: "CAD" },
    }),
  );
  const tue = [["12:00", "19:00"]] as [string, string][];
  const mei = await s.caps.staff.create(owner, {
    name: "Mei Chen",
    sort: 0,
    services: [{ service_id: fade.id, duration_override_min: 45 }],
    hours: { tue },
  });
  const ravi = await s.caps.staff.create(owner, {
    name: "Ravi Sandhu",
    sort: 1,
    services: [{ service_id: fade.id, price_override: 5500 }, { service_id: beard.id }],
  });
  return { ...s, fade, beard, mei, ravi };
}

const booking = (serviceId: string, name: string, start: string, end: string) => ({
  reservationFor: { serviceId, name },
  startTime: start,
  endTime: end,
});

/** A booking as the inbox keeps it: who a request for anyone went to is the business's to read. */
async function stored(db: Db, id: string): Promise<Record<string, unknown>> {
  const [row] = await db.orm.select().from(items).where(eq(items.id, id));
  return (row?.payload ?? {}) as Record<string, unknown>;
}

describe("staff", () => {
  it("are listed to customers by first name only, with the services each gives", async () => {
    const { caps, fade, beard, mei, ravi } = await mapleAndFade();
    expect(await caps.listsStaff()).toBe(true);
    const listed = await caps.listStaff({});
    expect(listed.items).toEqual([
      { id: mei.id, name: "Mei", service_ids: [fade.id] },
      { id: ravi.id, name: "Ravi", service_ids: [fade.id, beard.id] },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/Chen|Sandhu|12:00|price/);
    expect((await caps.listStaff({ service_id: beard.id })).items.map((s) => s.name)).toEqual(["Ravi"]);
    // What must come first and where a service came from are the business's own.
    const page = await caps.listServices({ limit: 10 });
    expect(page.items[0]).not.toHaveProperty("requires");
    expect(page.items[0]).not.toHaveProperty("source");
  });

  it("are shown by the name the owner chose, whole, else the first word of their own", async () => {
    const s = await salon({ name: "Ìfẹ́ Beauty Studio", zone: "Africa/Lagos", currency: "NGN", languages: ["en"] });
    const thu = await s.caps.staff.create(owner, { name: "Nguyễn Thu Hà", public_name: "Thu Hà" });
    const maria = await s.caps.staff.create(owner, { name: "María José Ruiz" });
    expect([thu.publicName, maria.publicName]).toEqual(["Thu Hà", "María"]);
    const named = await s.caps.staff.update(owner, { staff_id: maria.id, public_name: "María José" });
    expect(named.publicName).toBe("María José");
    // Emptied: the first word again.
    const plain = await s.caps.staff.update(owner, { staff_id: thu.id, public_name: null });
    expect(plain.publicName).toBe("Nguyễn");
  });

  it("each have their own hours and length, and anyone means whoever is free", async () => {
    const { caps, fade, mei, ravi } = await mapleAndFade();
    const any = await caps.checkAvailability(
      { service_id: fade.id, from: at("09:00"), to: at("13:00") },
      { now: T0, caller: agent() },
    );
    const nine = any.slots.find((s) => Date.parse(s.startTime) === Date.parse(at("09:00")));
    const noon = any.slots.find((s) => Date.parse(s.startTime) === Date.parse(at("12:00")));
    // At nine only Ravi works (Mei's own hours start at noon); at noon both, Mei for 45 minutes.
    expect((nine as { staff?: { id: string }[] } | undefined)?.staff?.map((s) => s.id)).toEqual([ravi.id]);
    expect((noon as { staff?: { id: string; endTime: string }[] } | undefined)?.staff).toEqual([
      { id: mei.id, name: "Mei", endTime: new Date(Date.parse(at("12:45"))).toISOString() },
      { id: ravi.id, name: "Ravi", endTime: new Date(Date.parse(at("12:30"))).toISOString() },
    ]);
    const onlyMei = await caps.checkAvailability(
      { service_id: fade.id, from: at("09:00"), to: at("13:00"), staff_id: mei.id },
      { now: T0, caller: agent() },
    );
    expect(Date.parse(onlyMei.slots[0]?.startTime ?? "")).toBe(Date.parse(at("12:00")));
    // An add-on makes it longer.
    const towel = (await caps.setup.listServices(owner)).find((s) => s.id === fade.id)?.addOns?.[0];
    const longer = await caps.checkAvailability(
      { service_id: fade.id, from: at("12:00"), to: at("13:00"), staff_id: ravi.id, add_ons: [towel?.id ?? ""] },
      { now: T0, caller: agent() },
    );
    expect(longer.slots[0]?.endTime).toBe(new Date(Date.parse(at("12:45"))).toISOString());
    // Nobody here by that id, or not for this service.
    await expect(
      caps.checkAvailability(
        { service_id: fade.id, from: at("12:00"), to: at("13:00"), staff_id: "nobody" },
        { now: T0, caller: agent() },
      ),
    ).rejects.toMatchObject({ code: "invalid_input", details: { reason: "unknown_staff" } });
  });

  it("books anyone with the first free, at their own length and price, and names nobody before it binds", async () => {
    const { db, caps, fade, mei, ravi } = await mapleAndFade();
    let summary = "";
    let terms: unknown;
    const first = await caps.createBooking(agent(), {
      payload: booking(fade.id, "Skin fade", at("12:00"), at("12:30")),
      contact: { name: "Aiyana", email: "aiyana@example.com" },
      idempotency_key: "maple-1",
    });
    // The customer's view names nobody while it is a request: whoever it went to may change at confirm.
    expect(first.view.item.payload).not.toHaveProperty("resourceId");
    expect(first.view.item.payload).not.toHaveProperty("staffName");
    const p1 = await stored(db, first.view.item.id);
    expect(p1.resourceId).toBe(mei.id);
    expect(p1.staffName).toBe("Mei");
    // Mei's own length for a skin fade: the end follows it, whatever the request said.
    expect(Date.parse(String(p1.endTime))).toBe(Date.parse(at("12:45")));
    expect(p1.totalPrice).toEqual({ value: 4500, currency: "CAD" });
    await transitionItem(db, owner, { itemId: first.view.item.id, event: "confirm" });
    // The next for anyone at noon goes to Ravi, at his own price: the customer confirms that price, and
    // whoever is free, since it may go to anyone free on the same terms once it is confirmed.
    try {
      await new Capabilities(db).createBooking(agent(), {
        payload: booking(fade.id, "Skin fade", at("12:00"), at("12:30")),
        contact: { name: "Jean-Luc", email: "jl@example.com", locale: "fr-CA" },
        idempotency_key: "maple-2",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(WriteError);
      summary = String((error as WriteError).details?.summary ?? "");
      terms = (error as WriteError).details?.terms;
    }
    expect(summary).toContain("With whoever is free.");
    expect(summary).not.toContain("Ravi");
    expect(summary).toContain("CA$55.00");
    expect(terms).not.toHaveProperty("staff");
    const second = await caps.createBooking(agent(), {
      payload: booking(fade.id, "Skin fade", at("12:00"), at("12:30")),
      contact: { name: "Jean-Luc", email: "jl@example.com", locale: "fr-CA" },
      idempotency_key: "maple-2",
    });
    const p2 = await stored(db, second.view.item.id);
    expect([p2.resourceId, p2.totalPrice]).toEqual([ravi.id, { value: 5500, currency: "CAD" }]);
    // Sent again a minute later, the same request is answered as it was, not made twice.
    const again = await caps.createBooking(agent(), {
      payload: booking(fade.id, "Skin fade", at("12:00"), at("12:30")),
      contact: { name: "Jean-Luc", email: "jl@example.com", locale: "fr-CA" },
      idempotency_key: "maple-2",
    });
    expect(again.replayed).toBe(true);
    expect(again.view.item.id).toBe(second.view.item.id);
    // Asked for by name: Mei, who is not free at noon any more, is still the one asked for; a person answers.
    const asked = await caps.createBooking(agent(), {
      payload: booking(fade.id, "Skin fade", at("12:00"), at("12:30")),
      staff_id: mei.id,
      contact: { name: "Noor", email: "noor@example.com" },
      idempotency_key: "maple-3",
    });
    expect((asked.view.item.payload as { resourceId?: string }).resourceId).toBe(mei.id);
    expect(asked.view.item.state).toBe("requested");
  });

  it("for anyone, skip whoever already has a request then, and pick again when it is confirmed", async () => {
    const s = await salon({ name: "Hearth & Shear", zone: "America/Toronto", currency: "CAD", languages: ["en"] });
    const trim = await s.caps.setup.createService(
      owner,
      serviceInput.parse({
        name: "Trim",
        duration_min: 30,
        granularity_min: 30,
        price: { model: "fixed", value: 3000, currency: "CAD" },
      }),
    );
    const ana = await s.caps.staff.create(owner, { name: "Ana", sort: 0, services: [{ service_id: trim.id }] });
    const bo = await s.caps.staff.create(owner, { name: "Bo", sort: 1, services: [{ service_id: trim.id }] });
    const any = (idem: string, start = "14:00", end = "14:30") =>
      s.caps.createBooking(agent(), {
        payload: booking(trim.id, "Trim", at(start), at(end)),
        contact: { name: idem },
        idempotency_key: idem,
      });
    const first = await any("any-1");
    const second = await any("any-2");
    const who = async (r: { view: { item: { id: string } } }) => (await stored(s.db, r.view.item.id)).resourceId;
    // Ana has a request at two already: the next for anyone goes to Bo.
    expect([await who(first), await who(second)]).toEqual([ana.id, bo.id]);
    // Ana is booked by name and confirmed since: the first for anyone is confirmed with whoever is free.
    await transitionItem(s.db, owner, { itemId: second.view.item.id, event: "decline" });
    const named = await s.caps.createBooking(agent(), {
      payload: booking(trim.id, "Trim", at("14:00"), at("14:30")),
      staff_id: ana.id,
      contact: { name: "named" },
      idempotency_key: "named",
    });
    await transitionItem(s.db, owner, { itemId: named.view.item.id, event: "confirm" });
    const done = await transitionItem(s.db, owner, { itemId: first.view.item.id, event: "confirm" });
    expect([await who(done), (done.view.item.payload as { staffName?: string }).staffName]).toEqual([bo.id, "Bo"]);
    // Nobody free at all: nobody is named before it binds.
    await transitionItem(s.db, owner, {
      itemId: (await any("any-3", "15:00", "15:30")).view.item.id,
      event: "confirm",
    });
    await transitionItem(s.db, owner, {
      itemId: (await any("any-4", "15:00", "15:30")).view.item.id,
      event: "confirm",
    });
    let summary = "";
    try {
      await new Capabilities(s.db).createBooking(agent(), {
        payload: booking(trim.id, "Trim", at("15:00"), at("15:30")),
        contact: { name: "late" },
        idempotency_key: "any-5",
      });
    } catch (error) {
      summary = String((error as WriteError).details?.summary ?? "");
    }
    expect(summary).toContain("With whoever is free.");
    expect(summary).not.toMatch(/With (Ana|Bo)\./);
  });

  it("for anyone, with nobody who gives it free, is a person's to answer: never confirmed with nobody", async () => {
    const s = await salon({ name: "Hearth & Shear", zone: "America/Toronto", currency: "CAD", languages: ["en"] });
    const service = (name: string, value: number) =>
      s.caps.setup.createService(
        owner,
        serviceInput.parse({
          name,
          duration_min: 30,
          granularity_min: 30,
          price: { model: "fixed", value, currency: "CAD" },
        }),
      );
    const trim = await service("Trim", 3000);
    const colour = await service("Colour", 9000);
    const both = [{ service_id: trim.id }, { service_id: colour.id }];
    const ana = await s.caps.staff.create(owner, { name: "Ana", sort: 0, services: both });
    const bo = await s.caps.staff.create(owner, { name: "Bo", sort: 1, services: both });
    // Both busy at two with a colour: nobody gives a trim then.
    for (const staff of [ana, bo]) {
      const r = await s.caps.createBooking(agent(), {
        payload: booking(colour.id, "Colour", at("14:00"), at("14:30")),
        staff_id: staff.id,
        contact: { name: `colour-${staff.name}` },
        idempotency_key: `colour-${staff.id}`,
      });
      await transitionItem(s.db, owner, { itemId: r.view.item.id, event: "confirm" });
    }
    const late = await s.caps.createBooking(agent(), {
      payload: booking(trim.id, "Trim", at("14:00"), at("14:30")),
      contact: { name: "late" },
      idempotency_key: "trim-late",
    });
    expect(await stored(s.db, late.view.item.id)).not.toHaveProperty("resourceId");
    // Rules read the time as taken, and nobody confirms it: not the owner, nor the owner's AI.
    const test = await s.caps.setup.testRule(owner, {
      item_id: late.view.item.id,
      definition: {
        on: ["item.created"],
        if: { all: [{ fn: "slot_is_free" }] },
        actions: [{ action: "transition", event: "confirm" }],
        stop: false,
        maxRunsPerItem: 1,
      },
    });
    expect(test.facts).toMatchObject({ slotIsFree: false });
    const ai: Caller = { ...owner, actor: { kind: "owner_ai", id: "owner_ai:test", channel: "mcp_owner" } };
    for (const who of [owner, ai]) {
      await expect(transitionItem(s.db, who, { itemId: late.view.item.id, event: "confirm" })).rejects.toMatchObject({
        code: "slot_taken",
      });
    }
    const { rows } = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM slot_claims WHERE item_id = ?",
      params: [late.view.item.id],
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBe(0);
    // Bo is free again: it is confirmed with him.
    const bos = await s.db.orm.select().from(items).where(eq(items.type, "booking"));
    const boColour = bos.find((b) => (b.payload as { resourceId?: string }).resourceId === bo.id);
    await transitionItem(s.db, owner, { itemId: String(boColour?.id), event: "cancel_by_business" });
    const done = await transitionItem(s.db, owner, { itemId: late.view.item.id, event: "confirm" });
    expect((done.view.item.payload as { resourceId?: string }).resourceId).toBe(bo.id);
  });

  /** Two barbers in Bogotá (UTC-5 all year, as Toronto is in November), both giving a cut, and named bookings. */
  async function twoBarbers() {
    const s = await salon({
      name: "Barbería La Candelaria",
      zone: "America/Bogota",
      currency: "COP",
      languages: ["es"],
    });
    const cut = await s.caps.setup.createService(
      owner,
      serviceInput.parse({
        name: "Corte",
        duration_min: 30,
        granularity_min: 30,
        price: { model: "fixed", value: 3_500_000, currency: "COP" },
      }),
    );
    const ana = await s.caps.staff.create(owner, { name: "Ana Ruiz", sort: 0, services: [{ service_id: cut.id }] });
    const bo = await s.caps.staff.create(owner, { name: "Bo Kim", sort: 1, services: [{ service_id: cut.id }] });
    const named = async (staffId: string, start: string, end: string, idem: string) => {
      const r = await s.caps.createBooking(agent(), {
        payload: booking(cut.id, "Corte", at(start), at(end)),
        staff_id: staffId,
        contact: { name: idem },
        idempotency_key: idem,
      });
      return r;
    };
    const confirmed = async (staffId: string, start: string, end: string, idem: string) => {
      const r = await named(staffId, start, end, idem);
      await transitionItem(s.db, owner, { itemId: r.view.item.id, event: "confirm" });
      return r;
    };
    /** At two both are busy: a request for anyone then goes to nobody. */
    const late = async () => {
      await confirmed(ana.id, "14:00", "14:30", "ana-14");
      await confirmed(bo.id, "14:00", "14:30", "bo-14");
      const r = await s.caps.createBooking(agent(), {
        payload: booking(cut.id, "Corte", at("14:00"), at("14:30")),
        contact: { name: "Valentina" },
        idempotency_key: "any-14",
      });
      expect(await stored(s.db, r.view.item.id)).toMatchObject({ anyStaff: true });
      expect(await stored(s.db, r.view.item.id)).not.toHaveProperty("resourceId");
      return r;
    };
    return { ...s, cut, ana, bo, named, confirmed, late };
  }

  it("for anyone with nobody free, can be offered a time one of them is free, and the customer's own other time too", async () => {
    const s = await twoBarbers();
    const any = await s.late();
    // At three Ana is busy and Bo is not; at four Bo is busy and Ana is not.
    await s.confirmed(s.ana.id, "15:00", "15:30", "ana-15");
    await s.confirmed(s.bo.id, "16:00", "16:30", "bo-16");
    const free = await s.caps.checkAvailability(
      { service_id: s.cut.id, from: at("15:00"), to: at("15:30") },
      { now: T0, caller: agent() },
    );
    expect(free.slots).toMatchObject([{ startTime: new Date(at("15:00")).toISOString(), staff: [{ id: s.bo.id }] }]);
    // Proposed at three: free with Bo, as the free times say it is, whoever else is busy then.
    const proposed = await transitionItem(s.db, owner, {
      itemId: any.view.item.id,
      event: "propose",
      input: { startTime: at("15:00"), endTime: at("15:30") },
    });
    expect(proposed.view.item.state).toBe("proposed");
    // Their own other time, four, is free with Ana: taken back to us as theirs.
    const theirs: Caller = { ...agent(), accessToken: any.accessToken ?? "" };
    const countered = await transitionItem(s.db, theirs, {
      itemId: any.view.item.id,
      event: "counter",
      input: { startTime: at("16:00") },
    });
    expect(countered.view.item.state).toBe("requested");
    // Confirmed with whoever is free then.
    const done = await transitionItem(s.db, owner, { itemId: any.view.item.id, event: "confirm" });
    expect(done.view.item.state).toBe("confirmed");
    expect(await stored(s.db, any.view.item.id)).toMatchObject({ resourceId: s.ana.id, staffName: "Ana" });
    // A time nobody who gives it is free is still refused, as nobody's.
    const other = await s.caps.createBooking(agent(), {
      payload: booking(s.cut.id, "Corte", at("14:00"), at("14:30")),
      contact: { name: "Mateo" },
      idempotency_key: "any-14-b",
    });
    await expect(
      transitionItem(s.db, owner, {
        itemId: other.view.item.id,
        event: "propose",
        input: { startTime: at("14:00"), endTime: at("14:30") },
      }),
    ).rejects.toMatchObject({ code: "slot_taken", details: { staff: "nobody_free" } });
  });

  it("for anyone, a time held while the customer answers holds one barber, never every one who gives it", async () => {
    const s = await twoBarbers();
    await s.caps.updateSettings(owner, { doc: { booking: { holdOnPropose: true } } });
    const any = await s.late();
    await transitionItem(s.db, owner, {
      itemId: any.view.item.id,
      event: "propose",
      input: { startTime: at("17:00"), endTime: at("17:30") },
    });
    const { rows } = await s.db.client.query({
      sql: "SELECT DISTINCT resource_key FROM slot_claims WHERE item_id = ?",
      params: [any.view.item.id],
      method: "all",
    });
    expect(rows.map((r) => r[0])).toEqual([`resource:${s.ana.id}`]);
    // Ana is held for it; Bo is not, and is booked by name then.
    const ana = await s.named(s.ana.id, "17:00", "17:30", "ana-17");
    await expect(transitionItem(s.db, owner, { itemId: ana.view.item.id, event: "confirm" })).rejects.toMatchObject({
      code: "slot_taken",
    });
    const bo = await s.named(s.bo.id, "17:00", "17:30", "bo-17");
    const done = await transitionItem(s.db, owner, { itemId: bo.view.item.id, event: "confirm" });
    expect(done.view.item.state).toBe("confirmed");
  });

  it("for anyone with nobody free, where each gives it on their own terms, is offered a time with theirs for the customer to confirm", async () => {
    const s = await mapleAndFade();
    const confirmedWith = async (staffId: string, from: string, to: string, idem: string) => {
      const r = await s.caps.createBooking(agent(), {
        payload: booking(s.fade.id, "Skin fade", at(from), at(to)),
        staff_id: staffId,
        contact: { name: idem },
        idempotency_key: idem,
      });
      await transitionItem(s.db, owner, { itemId: r.view.item.id, event: "confirm" });
      return r;
    };
    // Both busy at two (Mei for 45 minutes, Ravi at CA$55.00): a request for anyone then goes to nobody,
    // at the service's own CA$45.00 and half an hour, on which neither gives it.
    await confirmedWith(s.mei.id, "14:00", "14:45", "mei-14");
    const ravi14 = await confirmedWith(s.ravi.id, "14:00", "14:30", "ravi-14");
    const any = await s.caps.createBooking(agent(), {
      payload: booking(s.fade.id, "Skin fade", at("14:00"), at("14:30")),
      contact: { name: "Valentina", email: "valentina@example.com" },
      idempotency_key: "any-14",
    });
    expect(await stored(s.db, any.view.item.id)).not.toHaveProperty("resourceId");
    expect(any.view.item.payload).toMatchObject({ totalPrice: { value: 4500, currency: "CAD" } });
    // At four Mei is busy too: only Ravi is free then, as the free times say.
    await confirmedWith(s.mei.id, "16:00", "16:45", "mei-16");
    const free = await s.caps.checkAvailability(
      { service_id: s.fade.id, from: at("16:00"), to: at("16:30") },
      { now: T0, caller: agent() },
    );
    expect(free.slots).toMatchObject([{ startTime: new Date(at("16:00")).toISOString(), staff: [{ id: s.ravi.id }] }]);
    // Proposed at four, the time goes with Ravi and his price, held for him.
    const proposed = await transitionItem(s.db, owner, {
      itemId: any.view.item.id,
      event: "propose",
      input: { startTime: at("16:00"), endTime: at("16:30") },
    });
    expect(proposed.view.item.state).toBe("proposed");
    expect(await stored(s.db, any.view.item.id)).toMatchObject({
      proposed: { totalPrice: { value: 5500, currency: "CAD" }, resourceId: s.ravi.id, staffName: "Ravi" },
    });
    // The customer reads the time and its price, never who, and confirms them.
    const [row] = await s.db.orm.select().from(items).where(eq(items.id, any.view.item.id));
    expect(JSON.stringify(customerItem(rowToItem(row as never)).payload)).not.toContain(s.ravi.id);
    const as: Caller = { ...agent(), accessToken: any.accessToken ?? "" };
    const asked = await s.caps.customer
      .acceptOffer(as, { item_id: any.view.item.id, idempotency_key: "acc-1" })
      .catch((e: WriteError) => e);
    expect(asked).toMatchObject({
      code: "confirm_terms",
      details: { offer: { terms: { totalPrice: { value: 5500, currency: "CAD" } } } },
    });
    expect(JSON.stringify((asked as WriteError).details)).not.toContain("Ravi");
    await s.caps.customer.acceptOffer(as, {
      item_id: any.view.item.id,
      terms_sha: String((asked as WriteError).details?.terms_sha),
      idempotency_key: "acc-2",
    });
    expect(await stored(s.db, any.view.item.id)).toMatchObject({
      resourceId: s.ravi.id,
      staffName: "Ravi",
      startTime: at("16:00"),
      endTime: new Date(at("16:30")).toISOString(),
      totalPrice: { value: 5500, currency: "CAD" },
    });
    // Another at two, once Ravi's two o'clock is off: free only with him, on his own terms. The owner is
    // told so, never that nobody is free, and proposing that very time carries his.
    const again = await s.caps.createBooking(agent(), {
      payload: booking(s.fade.id, "Skin fade", at("14:00"), at("14:30")),
      contact: { name: "Mateo", email: "mateo@example.com" },
      idempotency_key: "any-14-b",
    });
    await transitionItem(s.db, owner, { itemId: ravi14.view.item.id, event: "cancel_by_business" });
    const refused = await transitionItem(s.db, owner, { itemId: again.view.item.id, event: "confirm" }).catch(
      (e: unknown) => e,
    );
    expect(refused).toMatchObject({ code: "slot_taken", details: { staff: "other_terms" } });
    expect((refused as WriteError).message).toContain("Ravi Sandhu is, at their own (CA$55.00, 30 min)");
    expect((refused as WriteError).message).not.toContain("nobody who gives this service is free");
    const same = await transitionItem(s.db, owner, {
      itemId: again.view.item.id,
      event: "propose",
      input: { startTime: at("14:00"), endTime: at("14:30") },
    });
    expect(same.view.item.payload).toMatchObject({ proposed: { totalPrice: { value: 5500, currency: "CAD" } } });
  });

  it("for anyone, take the customer's own other time when only someone on other terms is free, for us to propose with theirs", async () => {
    const s = await salon({
      name: "Adùn Braiding Studio",
      zone: "Africa/Lagos",
      currency: "NGN",
      languages: ["en", "yo"],
    });
    const lagosAt = (hhmm: string) => at(hhmm, "+01:00");
    const braids = await s.caps.setup.createService(
      owner,
      serviceInput.parse({
        name: "Knotless braids",
        duration_min: 60,
        granularity_min: 30,
        price: { model: "fixed", value: 3_000_000, currency: "NGN" },
      }),
    );
    const adaeze = await s.caps.staff.create(owner, {
      name: "Adaeze Okafor",
      sort: 0,
      services: [{ service_id: braids.id }],
    });
    const tunde = await s.caps.staff.create(owner, {
      name: "Tunde Bello",
      sort: 1,
      services: [{ service_id: braids.id, duration_override_min: 90 }],
    });
    const confirmedWith = async (staffId: string, from: string, to: string, idem: string) => {
      const r = await s.caps.createBooking(agent(), {
        payload: booking(braids.id, "Knotless braids", lagosAt(from), lagosAt(to)),
        staff_id: staffId,
        contact: { name: idem },
        idempotency_key: idem,
      });
      await transitionItem(s.db, owner, { itemId: r.view.item.id, event: "confirm" });
    };
    await confirmedWith(adaeze.id, "14:00", "15:00", "a-14");
    await confirmedWith(tunde.id, "14:00", "15:30", "t-14");
    await confirmedWith(adaeze.id, "17:00", "18:00", "a-17");
    const any = await s.caps.createBooking(agent(), {
      payload: booking(braids.id, "Knotless braids", lagosAt("14:00"), lagosAt("15:00")),
      contact: { name: "Chiamaka", email: "chiamaka@example.com" },
      idempotency_key: "any-14",
    });
    await transitionItem(s.db, owner, {
      itemId: any.view.item.id,
      event: "propose",
      input: { startTime: lagosAt("16:00"), endTime: lagosAt("17:00") },
    });
    // At five only Tunde is free, for his hour and a half, as the free times say: their time is taken.
    const free = await s.caps.checkAvailability(
      { service_id: braids.id, from: lagosAt("17:00"), to: lagosAt("18:30") },
      { now: T0, caller: agent() },
    );
    expect(free.slots[0]).toMatchObject({
      startTime: new Date(lagosAt("17:00")).toISOString(),
      staff: [{ id: tunde.id }],
    });
    const theirs: Caller = { ...agent(), accessToken: any.accessToken ?? "" };
    const countered = await transitionItem(s.db, theirs, {
      itemId: any.view.item.id,
      event: "counter",
      input: { startTime: lagosAt("17:00") },
    });
    expect(countered.view.item.state).toBe("requested");
    // On the terms they asked on, an hour: never confirmed with Tunde as it is, and the owner told why.
    expect(await stored(s.db, any.view.item.id)).toMatchObject({ endTime: new Date(lagosAt("18:00")).toISOString() });
    const refused = await transitionItem(s.db, owner, { itemId: any.view.item.id, event: "confirm" }).catch(
      (e: unknown) => e,
    );
    expect(refused).toMatchObject({ code: "slot_taken", details: { staff: "other_terms" } });
    expect((refused as WriteError).message).toContain("Tunde Bello is, at their own (NGN");
    expect((refused as WriteError).message).toContain("90 min");
    // Proposed at five, it carries his hour and a half, which the customer confirms when they accept.
    const proposed = await transitionItem(s.db, owner, {
      itemId: any.view.item.id,
      event: "propose",
      input: { startTime: lagosAt("17:00"), endTime: lagosAt("18:00") },
    });
    expect(proposed.view.item.payload).toMatchObject({
      proposed: {
        endTime: new Date(lagosAt("18:30")).toISOString(),
        totalPrice: { value: 3_000_000, currency: "NGN" },
      },
    });
    const asked = await s.caps.customer
      .acceptOffer(theirs, { item_id: any.view.item.id, idempotency_key: "acc-1" })
      .catch((e: WriteError) => e);
    await s.caps.customer.acceptOffer(theirs, {
      item_id: any.view.item.id,
      terms_sha: String((asked as WriteError).details?.terms_sha),
      idempotency_key: "acc-2",
    });
    expect(await stored(s.db, any.view.item.id)).toMatchObject({
      resourceId: tunde.id,
      endTime: new Date(lagosAt("18:30")).toISOString(),
    });
  });

  it("book whoever a time we propose goes with for their own length, whatever end was typed", async () => {
    const s = await mapleAndFade();
    const ai: Caller = { ...owner, actor: { kind: "owner_ai", id: "owner_ai:test", channel: "mcp_owner" } };
    const confirmedWith = async (staffId: string, from: string, to: string, idem: string) => {
      const r = await s.caps.createBooking(agent(), {
        payload: booking(s.fade.id, "Skin fade", at(from), at(to)),
        staff_id: staffId,
        contact: { name: idem },
        idempotency_key: idem,
      });
      await transitionItem(s.db, owner, { itemId: r.view.item.id, event: "confirm" });
      return r;
    };
    // Ravi busy at two: a request for anyone then goes to Mei, for her 45 minutes.
    await confirmedWith(s.ravi.id, "14:00", "14:30", "ravi-14");
    const any = await s.caps.createBooking(agent(), {
      payload: booking(s.fade.id, "Skin fade", at("14:00"), at("14:30")),
      contact: { name: "Valentina", email: "valentina@example.com" },
      idempotency_key: "any-14",
    });
    expect(await stored(s.db, any.view.item.id)).toMatchObject({ resourceId: s.mei.id });
    // The owner's AI proposes four, typing the catalogue's half hour: it goes with Mei, for her 45 minutes,
    // and is sent as it is, since it is a time the catalogue covers.
    const sent = await transitionItem(s.db, ai, {
      itemId: any.view.item.id,
      event: "propose",
      input: { startTime: at("16:00"), endTime: at("16:30") },
    });
    expect(sent.drafted).toBeUndefined();
    expect(sent.view.item.state).toBe("proposed");
    expect((await stored(s.db, any.view.item.id)).proposed).toMatchObject({
      startTime: at("16:00"),
      endTime: new Date(at("16:45")).toISOString(),
    });
    const as: Caller = { ...agent(), accessToken: any.accessToken ?? "" };
    const asked = await s.caps.customer
      .acceptOffer(as, { item_id: any.view.item.id, idempotency_key: "acc-1" })
      .catch((e: WriteError) => e);
    await s.caps.customer.acceptOffer(as, {
      item_id: any.view.item.id,
      terms_sha: String((asked as WriteError).details?.terms_sha),
      idempotency_key: "acc-2",
    });
    expect(await stored(s.db, any.view.item.id)).toMatchObject({
      resourceId: s.mei.id,
      endTime: new Date(at("16:45")).toISOString(),
    });
    // Mei is not free at half past four, so nobody is booked with her twice.
    const free = await s.caps.checkAvailability(
      { service_id: s.fade.id, from: at("16:30"), to: at("17:15") },
      { now: T0, caller: agent() },
    );
    expect(free.slots.filter((x) => x.startTime === new Date(at("16:30")).toISOString())).toMatchObject([
      { staff: [{ id: s.ravi.id }] },
    ]);
    const second = await s.caps.createBooking(agent(), {
      payload: booking(s.fade.id, "Skin fade", at("16:30"), at("17:15")),
      staff_id: s.mei.id,
      contact: { name: "Second", email: "second@example.com" },
      idempotency_key: "second",
    });
    await expect(transitionItem(s.db, owner, { itemId: second.view.item.id, event: "confirm" })).rejects.toMatchObject({
      code: "slot_taken",
    });
    // Asked with Mei by name, the time we propose is hers for her own length too.
    const named = await s.caps.createBooking(agent(), {
      payload: booking(s.fade.id, "Skin fade", at("12:00"), at("12:45")),
      staff_id: s.mei.id,
      contact: { name: "Named", email: "named@example.com" },
      idempotency_key: "named",
    });
    await transitionItem(s.db, owner, {
      itemId: named.view.item.id,
      event: "propose",
      input: { startTime: at("17:30"), endTime: at("18:00") },
    });
    expect((await stored(s.db, named.view.item.id)).proposed).toMatchObject({
      endTime: new Date(at("18:15")).toISOString(),
    });
    // A service nobody is tied to, proposed shorter than it lasts by the owner's AI: a person sets that.
    const kids = await s.caps.setup.createService(
      owner,
      serviceInput.parse({
        name: "Kids cut",
        duration_min: 30,
        granularity_min: 15,
        price: { model: "fixed", value: 2500, currency: "CAD" },
      }),
    );
    const child = await s.caps.createBooking(agent(), {
      payload: booking(kids.id, "Kids cut", at("10:00"), at("10:30")),
      contact: { name: "Parent", email: "parent@example.com" },
      idempotency_key: "kids",
    });
    const short = await transitionItem(s.db, ai, {
      itemId: child.view.item.id,
      event: "propose",
      input: { startTime: at("11:00"), endTime: at("11:15") },
    });
    expect(short.drafted).toBeDefined();
    expect(short.view.item.state).toBe("requested");
  });

  it("judge a time the owner's AI proposes for anyone on the terms of whoever it goes with", async () => {
    const s = await mapleAndFade();
    const ai: Caller = { ...owner, actor: { kind: "owner_ai", id: "owner_ai:test", channel: "mcp_owner" } };
    const ravi14 = await s.caps.createBooking(agent(), {
      payload: booking(s.fade.id, "Skin fade", at("14:00"), at("14:30")),
      staff_id: s.ravi.id,
      contact: { name: "ravi-14" },
      idempotency_key: "ravi-14",
    });
    await transitionItem(s.db, owner, { itemId: ravi14.view.item.id, event: "confirm" });
    const any = await s.caps.createBooking(agent(), {
      payload: booking(s.fade.id, "Skin fade", at("14:00"), at("14:30")),
      contact: { name: "Valentina", email: "valentina@example.com" },
      idempotency_key: "any-14",
    });
    expect(await stored(s.db, any.view.item.id)).toMatchObject({ resourceId: s.mei.id });
    // At ten Mei does not work yet: only Ravi is free, at his own CA$55.00 for half an hour. Judged at his
    // price and length, the CA$45.00 they asked at is below his: a person decides, nothing is sent.
    const dearer = await transitionItem(s.db, ai, {
      itemId: any.view.item.id,
      event: "propose",
      input: { startTime: at("10:00"), endTime: at("10:45") },
    });
    expect(dearer.drafted?.breaches).toEqual(["counter_priced"]);
    expect(dearer.view.item.state).toBe("requested");
    // A price the owner names is theirs to give: kept, with his length.
    await transitionItem(s.db, owner, {
      itemId: any.view.item.id,
      event: "propose",
      input: { startTime: at("10:00"), endTime: at("10:45"), totalPrice: { value: 4500, currency: "CAD" } },
    });
    expect((await stored(s.db, any.view.item.id)).proposed).toMatchObject({
      endTime: new Date(at("10:30")).toISOString(),
      totalPrice: { value: 4500, currency: "CAD" },
      resourceId: s.ravi.id,
    });
    // Ravi at the service's own price, on his own half hour: judged on his length, the AI's offer is the
    // catalogue's, and sent.
    await s.db.client.query({
      sql: "UPDATE service_resources SET price_override = NULL WHERE service_id = ? AND resource_id = ?",
      params: [s.fade.id, s.ravi.id],
      method: "run",
    });
    const again = await s.caps.createBooking(agent(), {
      payload: booking(s.fade.id, "Skin fade", at("14:00"), at("14:30")),
      contact: { name: "Mateo", email: "mateo@example.com" },
      idempotency_key: "any-14-b",
    });
    expect(await stored(s.db, again.view.item.id)).toMatchObject({ resourceId: s.mei.id });
    const sent = await transitionItem(s.db, ai, {
      itemId: again.view.item.id,
      event: "propose",
      input: { startTime: at("11:00"), endTime: at("11:45") },
    });
    expect(sent.drafted).toBeUndefined();
    expect((await stored(s.db, again.view.item.id)).proposed).toMatchObject({
      endTime: new Date(at("11:30")).toISOString(),
      totalPrice: { value: 4500, currency: "CAD" },
      resourceId: s.ravi.id,
    });
  });

  it("are never confirmed with someone who has left: asked by name, a person answers; for anyone, someone else", async () => {
    const s = await twoBarbers();
    // Asked of Bo by name at three, and for anyone at ten, which went to Bo: Ana works afternoons only.
    await s.caps.staff.update(owner, { staff_id: s.ana.id, hours: { tue: [["12:00", "19:00"]] } });
    const byName = await s.named(s.bo.id, "15:00", "15:30", "bo-name");
    const any = await s.caps.createBooking(agent(), {
      payload: booking(s.cut.id, "Corte", at("10:00"), at("10:30")),
      contact: { name: "Camila" },
      idempotency_key: "any-10",
    });
    expect(await stored(s.db, any.view.item.id)).toMatchObject({ resourceId: s.bo.id });
    await s.caps.staff.archive(owner, s.bo.id);
    // By name: no rule reads the time as free, nobody confirms it, and a person is asked to answer it.
    const test = await s.caps.setup.testRule(owner, {
      item_id: byName.view.item.id,
      definition: {
        on: ["item.created"],
        if: { all: [{ fn: "slot_is_free" }] },
        actions: [{ action: "transition", event: "confirm" }],
        stop: false,
        maxRunsPerItem: 1,
      },
    });
    expect(test.facts).toMatchObject({ slotIsFree: false });
    await expect(transitionItem(s.db, owner, { itemId: byName.view.item.id, event: "confirm" })).rejects.toMatchObject({
      code: "slot_taken",
      details: { staff: "not_here" },
    });
    const [flagged] = await s.db.orm.select().from(items).where(eq(items.id, byName.view.item.id));
    expect((flagged?.flags as { needsHuman?: boolean } | undefined)?.needsHuman).toBe(true);
    // For anyone, at ten nobody else works: taken, never with Bo.
    await expect(transitionItem(s.db, owner, { itemId: any.view.item.id, event: "confirm" })).rejects.toMatchObject({
      code: "slot_taken",
      details: { staff: "nobody_free" },
    });
    expect(await stored(s.db, any.view.item.id)).toMatchObject({ resourceId: s.bo.id });
    // Ana works at ten after all: it is confirmed with her.
    await s.caps.staff.update(owner, { staff_id: s.ana.id, hours: null });
    const done = await transitionItem(s.db, owner, { itemId: any.view.item.id, event: "confirm" });
    expect(await stored(s.db, done.view.item.id)).toMatchObject({ resourceId: s.ana.id, staffName: "Ana" });
  });

  it("take their own calendar's busy times off their own times only, and only their bookings go to it", async () => {
    const { db, caps, fade, mei, ravi } = await mapleAndFade();
    const written: { who: string; booking: OutboundBooking }[] = [];
    const busyFor: Record<string, { start: number; end: number }[]> = {
      mei: [{ start: Date.parse(at("12:00")), end: Date.parse(at("13:00")) }],
      salon: [{ start: Date.parse(at("15:00")), end: Date.parse(at("16:00")) }],
    };
    const staffCal: ConnectorDefinition = {
      kind: "staffcal",
      title: "Staff calendar",
      group: "calendars",
      perResource: true,
      capabilities: ["busy_times", "write_bookings"],
      auth: "form",
      form: z.object({ who: z.string() }),
      async connect(_ctx, input) {
        return {
          account: input.who ?? "",
          externalId: input.who ?? "",
          secret: { token: "t" },
          extra: { who: input.who },
          calendars: [{ id: "c", name: "Calendar", writable: true }],
          destinations: [{ id: "c", name: "Calendar", writable: true }],
          defaults: { busy: ["c"], destination: "c" },
        };
      },
      async busy(ctx) {
        return busyFor[String(ctx.extra.who)] ?? [];
      },
      bookings: {
        async put(ctx, b) {
          written.push({ who: String(ctx.extra.who), booking: b });
          return { externalId: `e-${b.itemId}`, etag: null, calendar: "c" };
        },
        async remove() {},
      },
    };
    caps.connectors.attach({ definitions: [staffCal], http: noHttp });
    const meis = await caps.connectors.connect(owner, { kind: "staffcal", values: { who: "mei" } });
    const salonCal = await caps.connectors.connect(owner, { kind: "staffcal", values: { who: "salon" } });
    const tied = await caps.connectors.update(owner, meis.id, { resource_id: mei.id });
    expect(tied.resource_id).toBe(mei.id);
    // Only the owner, in person, ties a calendar to someone; never to someone who is not staff.
    await expect(caps.connectors.update(owner, salonCal.id, { resource_id: fade.id })).rejects.toMatchObject({
      code: "invalid_input",
    });
    // A booking each, confirmed.
    const forMei = await caps.createBooking(agent(), {
      payload: booking(fade.id, "Skin fade", at("13:00"), at("13:45")),
      staff_id: mei.id,
      contact: { name: "Aiyana" },
      idempotency_key: "busy-1",
    });
    const forRavi = await caps.createBooking(agent(), {
      payload: booking(fade.id, "Skin fade", at("13:00"), at("13:30")),
      staff_id: ravi.id,
      contact: { name: "Tomás" },
      idempotency_key: "busy-2",
    });
    for (const r of [forMei, forRavi]) await transitionItem(db, owner, { itemId: r.view.item.id, event: "confirm" });
    await caps.connectors.run(meis.id, T0, "sync");
    await caps.connectors.run(salonCal.id, T0, "sync");
    const slots = async (staff: string) =>
      (
        await caps.checkAvailability(
          { service_id: fade.id, from: at("12:00"), to: at("17:00"), staff_id: staff },
          { now: T0, caller: agent() },
        )
      ).slots.map((s) => new Date(s.startTime).toISOString().slice(11, 16));
    const meiFree = await slots(mei.id);
    const raviFree = await slots(ravi.id);
    // Mei's own calendar is busy 12:00–13:00 Toronto (17:00–18:00Z): hers only. The salon's own calendar,
    // tied to nobody, is busy 15:00–16:00 for everyone.
    expect(meiFree).not.toContain("17:00");
    expect(raviFree).toContain("17:00");
    expect(meiFree).not.toContain("20:00");
    expect(raviFree).not.toContain("20:00");
    // Mei's calendar was given Mei's booking alone; the salon's, both.
    expect(written.filter((w) => w.who === "mei").map((w) => w.booking.itemId)).toEqual([forMei.view.item.id]);
    expect(
      written
        .filter((w) => w.who === "salon")
        .map((w) => w.booking.itemId)
        .sort(),
    ).toEqual([forMei.view.item.id, forRavi.view.item.id].sort());
    // A calendar is never told who the customer is beyond its title.
    expect(written.every((w) => w.booking.customer === undefined)).toBe(true);
  });

  it("are never picked by a customer for a service nobody gives: its own places decide", async () => {
    const { db, caps, mei } = await mapleAndFade();
    const kids = await caps.setup.createService(
      owner,
      serviceInput.parse({
        name: "Kids cut",
        duration_min: 30,
        granularity_min: 15,
        price: { model: "fixed", value: 2500, currency: "CAD" },
      }),
    );
    const first = await caps.createBooking(agent(), {
      payload: booking(kids.id, "Kids cut", at("13:00"), at("13:30")),
      contact: { name: "Tomás" },
      idempotency_key: "kids-1",
    });
    await transitionItem(db, owner, { itemId: first.view.item.id, event: "confirm" });
    // Mei's id, from list_staff, on a service she does not give: it is not the customer's to choose.
    const second = await caps.createBooking(agent(), {
      payload: { ...booking(kids.id, "Kids cut", at("13:00"), at("13:30")), resourceId: mei.id } as never,
      contact: { name: "Wren" },
      idempotency_key: "kids-2",
    });
    expect((second.view.item.payload as { resourceId?: string }).resourceId).toBeUndefined();
    await expect(transitionItem(db, owner, { itemId: second.view.item.id, event: "confirm" })).rejects.toMatchObject({
      code: "slot_taken",
    });
  });

  it("never double-book what was confirmed before anyone was tied to the service, nor after they were untied", async () => {
    const s = await salon({ name: "Hearth & Shear", zone: "America/Toronto", currency: "CAD", languages: ["en"] });
    const trim = await s.caps.setup.createService(
      owner,
      serviceInput.parse({
        name: "Trim",
        duration_min: 30,
        granularity_min: 30,
        price: { model: "fixed", value: 3000, currency: "CAD" },
      }),
    );
    const colour = await s.caps.setup.createService(
      owner,
      serviceInput.parse({
        name: "Colour",
        duration_min: 30,
        granularity_min: 30,
        price: { model: "fixed", value: 9000, currency: "CAD" },
      }),
    );
    // Booked for weeks before anyone gave it: held under the service's own places.
    const before = await s.caps.createBooking(agent(), {
      payload: booking(trim.id, "Trim", at("14:00"), at("14:30")),
      contact: { name: "Odette" },
      idempotency_key: "legacy-1",
    });
    await transitionItem(s.db, owner, { itemId: before.view.item.id, event: "confirm" });
    const ana = await s.caps.staff.create(owner, {
      name: "Ana Kowalski",
      services: [{ service_id: trim.id }, { service_id: colour.id }],
    });
    const free = async (staffId?: string, serviceId = trim.id) =>
      (
        await s.caps.checkAvailability(
          { service_id: serviceId, from: at("13:00"), to: at("16:00"), ...(staffId ? { staff_id: staffId } : {}) },
          { now: T0, caller: agent() },
        )
      ).slots.map((x) => Date.parse(x.startTime));
    expect(await free(ana.id)).not.toContain(Date.parse(at("14:00")));
    expect(await free()).not.toContain(Date.parse(at("14:00")));
    // She is one person across what she gives: the trim takes her for a colour too.
    expect(await free(ana.id, colour.id)).not.toContain(Date.parse(at("14:00")));
    const colourWithAna = await s.caps.createBooking(agent(), {
      payload: booking(colour.id, "Colour", at("14:00"), at("14:30")),
      staff_id: ana.id,
      contact: { name: "Mirela" },
      idempotency_key: "legacy-colour",
    });
    await expect(
      transitionItem(s.db, owner, { itemId: colourWithAna.view.item.id, event: "confirm" }),
    ).rejects.toMatchObject({ code: "slot_taken" });
    // Booked with Ana since, then nobody gives it again: her booking still holds its time.
    const withAna = await s.caps.createBooking(agent(), {
      payload: booking(trim.id, "Trim", at("15:00"), at("15:30")),
      staff_id: ana.id,
      contact: { name: "Priya" },
      idempotency_key: "legacy-2",
    });
    await transitionItem(s.db, owner, { itemId: withAna.view.item.id, event: "confirm" });
    await s.caps.staff.update(owner, { staff_id: ana.id, services: [] });
    expect(await free()).not.toContain(Date.parse(at("15:00")));
    const again = await s.caps.createBooking(agent(), {
      payload: booking(trim.id, "Trim", at("15:00"), at("15:30")),
      contact: { name: "Lars" },
      idempotency_key: "legacy-3",
    });
    await expect(transitionItem(s.db, owner, { itemId: again.view.item.id, event: "confirm" })).rejects.toMatchObject({
      code: "slot_taken",
    });
  });

  it("keep a business calendar chosen for a service blocking it once staff give it", async () => {
    const { caps, fade, mei } = await mapleAndFade();
    const shared: ConnectorDefinition = {
      kind: "sharedcal",
      title: "Shared calendar",
      group: "calendars",
      perResource: true,
      capabilities: ["busy_times"],
      auth: "form",
      form: z.object({ who: z.string() }),
      async connect() {
        return {
          account: "front desk",
          externalId: "desk",
          secret: { token: "t" },
          extra: {},
          calendars: [{ id: "c", name: "Calendar", writable: false }],
          destinations: [],
          defaults: { busy: ["c"], destination: null },
        };
      },
      async busy() {
        return [{ start: Date.parse(at("16:00")), end: Date.parse(at("17:00")) }];
      },
    };
    caps.connectors.attach({ definitions: [shared], http: noHttp });
    const cal = await caps.connectors.connect(owner, { kind: "sharedcal", values: { who: "desk" } });
    await caps.connectors.update(owner, cal.id, { services: [fade.id] });
    await caps.connectors.run(cal.id, T0, "sync");
    const slots = await caps.checkAvailability(
      { service_id: fade.id, from: at("15:00"), to: at("18:00"), staff_id: mei.id },
      { now: T0, caller: agent() },
    );
    expect(slots.slots.map((x) => Date.parse(x.startTime))).not.toContain(Date.parse(at("16:00")));
  });

  it("keep their photo without what the camera wrote into it", () => {
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x00, 0xff, 0xe1, 0x00, 0x0e, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53, 0x2d, 0x34, 0x35, 0xff, 0xfe,
      0x00, 0x06, 0x68, 0x69, 0x21, 0x21, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00, 0x11,
      0x22, 0x33, 0xff, 0xd9,
    ]);
    const clean = stripJpegMetadata(jpeg);
    const text = new TextDecoder("latin1").decode(clean ?? new Uint8Array());
    expect(text).toContain("JFIF");
    expect(text).not.toContain("Exif");
    expect(text).not.toContain("GPS");
    expect(text).not.toContain("hi!!");
    // A JFIF header carrying a thumbnail of the uncropped picture, and a JFXX one: neither is kept whole.
    const thumb = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
    const withThumbs = Uint8Array.from([
      0xff,
      0xd8,
      // JFIF, 1×2 thumbnail (6 bytes of RGB).
      0xff,
      0xe0,
      0x00,
      0x16,
      0x4a,
      0x46,
      0x49,
      0x46,
      0x00,
      0x01,
      0x02,
      0x00,
      0x00,
      0x48,
      0x00,
      0x48,
      0x01,
      0x02,
      ...thumb,
      // JFXX extension with its own thumbnail.
      0xff,
      0xe0,
      0x00,
      0x0e,
      0x4a,
      0x46,
      0x58,
      0x58,
      0x00,
      0x13,
      ...thumb,
      0xff,
      0xdb,
      0x00,
      0x04,
      0x00,
      0x00,
      0xff,
      0xda,
      0x00,
      0x04,
      0x00,
      0x00,
      0x77,
      0xff,
      0xd9,
    ]);
    const stripped = stripJpegMetadata(withThumbs) ?? new Uint8Array();
    const hex = Array.from(stripped, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).not.toContain("112233445566");
    expect(hex).not.toContain("4a46585800");
    // The JFIF header itself stays, with no thumbnail.
    expect(hex.startsWith("ffd8ffe000104a46494600010200004800480000")).toBe(true);
    const b64 = btoa(String.fromCharCode(...jpeg));
    const kept = cleanPhoto(`data:image/jpeg;base64,${b64}`);
    expect("photo" in kept && atob(kept.photo.split(",")[1] ?? "")).not.toContain("GPS");
    expect(cleanPhoto("data:image/png;base64,iVBORw0KGgo=")).toEqual({ problem: "not_jpeg" });
    expect(cleanPhoto(`data:image/jpeg;base64,${btoa("not a jpeg at all")}`)).toEqual({ problem: "not_jpeg" });
  });

  it("charge their own price as the service's is: each person, on a service priced per person", async () => {
    const s = await salon({ name: "Glow Room", zone: "America/Toronto", currency: "CAD", languages: ["en"] });
    const bridal = await s.caps.setup.createService(
      owner,
      serviceInput.parse({
        name: "Bridal makeup",
        duration_min: 60,
        granularity_min: 30,
        price: { model: "fixed", value: 8000, currency: "CAD", per: "person" },
      }),
    );
    const lena = await s.caps.staff.create(owner, {
      name: "Lena",
      services: [{ service_id: bridal.id, price_override: 20000 }],
    });
    const r = await s.caps.createBooking(agent(), {
      payload: { ...booking(bridal.id, "Bridal makeup", at("14:00"), at("15:00")), partySize: 3 },
      staff_id: lena.id,
      contact: { name: "Ananya" },
      idempotency_key: "bridal-3",
    });
    expect((await stored(s.db, r.view.item.id)).totalPrice).toEqual({ value: 60000, currency: "CAD" });
  });

  it("are the owner's: the owner's AI may tie them to services, never set their price", async () => {
    const { caps, fade, beard, ravi } = await mapleAndFade();
    const ai: Caller = { ...owner, actor: { kind: "owner_ai", id: "ai", channel: "mcp_owner" } };
    await expect(
      caps.staff.update(ai, { staff_id: ravi.id, services: [{ service_id: fade.id, price_override: 3000 }] }),
    ).rejects.toMatchObject({ code: "not_allowed", details: { reason: "owner_money" } });
    const kept = await caps.staff.update(ai, { staff_id: ravi.id, services: [{ service_id: fade.id }] });
    expect(kept.services).toEqual([{ serviceId: fade.id, priceOverride: 5500, durationOverrideMin: null }]);
    // Nor by untying them from it, to tie them again at the service's own price.
    await expect(
      caps.staff.update(ai, { staff_id: ravi.id, services: [{ service_id: beard.id }] }),
    ).rejects.toMatchObject({ code: "not_allowed", details: { reason: "owner_money" } });
    const still = await caps.staff.list(owner);
    expect(still.find((x) => x.id === ravi.id)?.services.map((x) => [x.serviceId, x.priceOverride])).toEqual([
      [fade.id, 5500],
    ]);
    // The owner may: it is their price.
    const untied = await caps.staff.update(owner, { staff_id: ravi.id, services: [{ service_id: beard.id }] });
    expect(untied.services.map((x) => x.serviceId)).toEqual([beard.id]);
    await expect(
      caps.setup.updateService(ai, { service_id: fade.id, deposit: { kind: "percent", value: 20 } }),
    ).rejects.toMatchObject({ code: "not_allowed" });
  });

  it("keep an add-on's price as the owner set it: the owner's AI cannot swap it for one that costs nothing", async () => {
    const { caps, fade } = await mapleAndFade();
    const ai: Caller = { ...owner, actor: { kind: "owner_ai", id: "ai", channel: "mcp_owner" } };
    const towel = fade.addOns?.[0];
    expect(towel).toMatchObject({ name: "Hot towel", price: { value: 1000, currency: "CAD" } });
    // Sent again without its id or its price: refused, and still priced.
    await expect(
      caps.setup.updateService(ai, { service_id: fade.id, add_ons: [{ name: "Hot towel", duration_min: 15 }] }),
    ).rejects.toMatchObject({ code: "not_allowed" });
    // Dropped altogether: refused too.
    await expect(caps.setup.updateService(ai, { service_id: fade.id, add_ons: [] })).rejects.toMatchObject({
      code: "not_allowed",
    });
    // Named and timed again by its id, at its price: the AI's to do; an unpriced one beside it, too.
    const renamed = await caps.setup.updateService(ai, {
      service_id: fade.id,
      add_ons: [
        { id: towel?.id, name: "Hot towel & balm", duration_min: 20, price: { value: 1000, currency: "CAD" } },
        { name: "Eyebrow tidy", duration_min: 5 },
      ],
    });
    expect(renamed.addOns?.map((a) => [a.id === towel?.id, a.name, a.durationMin, a.price?.value ?? null])).toEqual([
      [true, "Hot towel & balm", 20, 1000],
      [false, "Eyebrow tidy", 5, null],
    ]);
    // The owner may take it off.
    const none = await caps.setup.updateService(owner, { service_id: fade.id, add_ons: [] });
    expect(none.addOns).toEqual([]);
  });
});

async function ifeBeauty() {
  const s = await salon({ name: "Ìfẹ́ Beauty Studio", zone: "Africa/Lagos", currency: "NGN", languages: ["en", "yo"] });
  const patch = await s.caps.setup.createService(
    owner,
    serviceInput.parse({
      name: "Patch test",
      duration_min: 15,
      price: { model: "fixed", value: 0, currency: "NGN" },
    }),
  );
  const colour = await s.caps.setup.createService(
    owner,
    serviceInput.parse({
      name: "Gele & colour",
      duration_min: 90,
      granularity_min: 30,
      price: { model: "fixed", value: 3_500_000, currency: "NGN" },
      requires: { service_id: patch.id, within_days: 180 },
    }),
  );
  return { ...s, patch, colour };
}

async function party(db: Db, name: string, email: string): Promise<string> {
  const id = ulid(T0);
  await db.orm.insert(parties).values({
    id,
    kind: "person",
    displayName: name,
    contact: { name, email },
    createdAt: T0,
    updatedAt: T0,
  });
  return id;
}

async function pastBooking(db: Db, partyId: string, serviceId: string, startMs: number, state = "completed") {
  await db.orm.insert(items).values({
    id: ulid(T0),
    type: "booking",
    state,
    version: 1,
    partyId,
    channel: "rest",
    payload: {
      reservationFor: { serviceId, name: "Patch test" },
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(startMs + 15 * 60_000).toISOString(),
    },
    flags: {},
    createdAt: T0,
    updatedAt: T0,
  });
}

async function needsHuman(db: Db, id: string): Promise<boolean> {
  const [row] = await db.orm.select().from(items).where(eq(items.id, id));
  return (row?.flags as { needsHuman?: boolean } | undefined)?.needsHuman === true;
}

// 14:00 in Lagos (UTC+1), a week from T0.
const lagos = new Date(T0 + 7 * DAY).toISOString().slice(0, 10);
const inLagos = (hhmm: string) => `${lagos}T${hhmm}:00+01:00`;

describe("what must come first", () => {
  it("is met by this customer's own patch test here, within the days", async () => {
    const { db, caps, patch, colour } = await ifeBeauty();
    const ada = await party(db, "Adaeze Okafor", "adaeze@example.com");
    await pastBooking(db, ada, patch.id, T0 - 20 * DAY);
    const r = await caps.createBooking(agent(ada), {
      payload: booking(colour.id, "Gele & colour", inLagos("14:00"), inLagos("15:30")),
      idempotency_key: "ife-1",
    });
    expect(await needsHuman(db, r.view.item.id)).toBe(false);
  });

  it("asks a customer the inbox knows, who has not had it, to book it first", async () => {
    const { db, caps, patch, colour } = await ifeBeauty();
    const bola = await party(db, "Bọ́lá Adé", "bola@example.com");
    // One too long ago does not count.
    await pastBooking(db, bola, patch.id, T0 - 400 * DAY);
    const error = await caps
      .createBooking(agent(bola), {
        payload: booking(colour.id, "Gele & colour", inLagos("14:00"), inLagos("15:30")),
        idempotency_key: "ife-2",
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input", details: { reason: "requires_first", service_id: patch.id } });
    expect((error as WriteError).message).toContain("Please book Patch test first");
  });

  it("is not met by one too close before: a patch test is read two days later", async () => {
    const { db, caps, patch, colour } = await ifeBeauty();
    const chi = await party(db, "Chiamaka Eze", "chiamaka@example.com");
    // Ten minutes before the colour, the same day: too soon to read.
    await pastBooking(db, chi, patch.id, Date.parse(inLagos("13:45")), "confirmed");
    const error = await caps
      .createBooking(agent(chi), {
        payload: booking(colour.id, "Gele & colour", inLagos("14:00"), inLagos("15:30")),
        idempotency_key: "ife-close",
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input", details: { reason: "requires_first", at_least_hours: 48 } });
    expect((error as WriteError).message).toContain("48 hours");
  });

  it("is a person's to check while their patch test is still a request, and no automation moves it on", async () => {
    const { db, caps, patch, colour } = await ifeBeauty();
    const tunde = await party(db, "Túndé Bakare", "tunde@example.com");
    await pastBooking(db, tunde, patch.id, T0 + 3 * DAY, "requested");
    const r = await caps.createBooking(agent(tunde), {
      payload: booking(colour.id, "Gele & colour", inLagos("14:00"), inLagos("15:30")),
      idempotency_key: "ife-asked",
    });
    expect(r.view.item.state).toBe("requested");
    expect(await needsHuman(db, r.view.item.id)).toBe(true);
    // The owner's AI may not propose another time on it either: the customer's yes would confirm it.
    const ai: Caller = { ...owner, actor: { kind: "owner_ai", id: "ai", channel: "mcp_owner" } };
    await expect(
      transitionItem(db, ai, {
        itemId: r.view.item.id,
        event: "propose",
        input: { startTime: inLagos("16:00"), endTime: inLagos("17:30") },
      }),
    ).rejects.toMatchObject({ details: { guard: "check_first" } });
  });

  it("is checked by a person for a customer the inbox cannot know, and nobody's bookings are shown", async () => {
    const { db, caps, patch, colour } = await ifeBeauty();
    // Someone else had a patch test; a stranger giving their address learns nothing of it.
    const ada = await party(db, "Adaeze Okafor", "adaeze@example.com");
    await pastBooking(db, ada, patch.id, T0 - 20 * DAY);
    const answers: unknown[] = [];
    for (const email of ["adaeze@example.com", "nobody@example.com"]) {
      const r = await caps.createBooking(agent(), {
        payload: booking(colour.id, "Gele & colour", inLagos("14:00"), inLagos("15:30")),
        contact: { name: "Someone", email },
        idempotency_key: `ife-${email}`,
      });
      expect(await needsHuman(db, r.view.item.id)).toBe(true);
      expect(r.view.item.state).toBe("requested");
      // The same answer either way, its reference aside.
      answers.push({
        state: r.view.item.state,
        human: r.view.human.replace(/Reference \w+\./, ""),
        payload: Object.keys(r.view.item.payload),
      });
      // No rule, no AI confirms it: a person checks first.
      await expect(
        transitionItem(
          db,
          { ...owner, actor: { kind: "rule", id: "rule", channel: "system" } },
          { itemId: r.view.item.id, event: "confirm" },
        ),
      ).rejects.toMatchObject({ details: { guard: "check_first" } });
    }
    expect(answers[0]).toEqual(answers[1]);
  });
});

describe("a deposit", () => {
  it("is asked in won, which has no minor unit, on the business's own platform, once confirmed", async () => {
    const s = await salon({ name: "Mapo Barber Lab", zone: "Asia/Seoul", currency: "KRW", languages: ["ko", "en"] });
    const cut = await s.caps.setup.createService(
      owner,
      serviceInput.parse({
        name: "투블럭 컷",
        duration_min: 40,
        granularity_min: 20,
        price: { model: "fixed", value: 35_000, currency: "KRW" },
        deposit: { kind: "percent", value: 30 },
      }),
    );
    const start = "2026-11-05T11:00:00+09:00";
    const r = await s.caps.createBooking(agent(), {
      payload: booking(cut.id, "투블럭 컷", start, "2026-11-05T11:40:00+09:00"),
      contact: { name: "Ji-woo", email: "jiwoo@example.com", locale: "ko" },
      idempotency_key: "mapo-1",
    });
    const p = r.view.item.payload as { deposit?: { amount: unknown; dueBy?: string; refundable: boolean } };
    // 30 % of ₩35,000 is ₩10,500: whole won, never hundredths.
    expect(p.deposit?.amount).toEqual({ value: 10_500, currency: "KRW" });
    expect(p.deposit?.refundable).toBe(true);
    // Nothing is asked of a request, nor dated: the window opens when it is confirmed.
    expect(p.deposit?.dueBy).toBeUndefined();
    expect((await bookingSchedules.wanted(s.db, r.view.item.id, T0))?.links).toEqual([]);
    await payments(s.db);
    // Confirmed a day and a half later: the customer still has a day from then.
    const later = T0 + 36 * 3_600_000;
    await transitionItem(s.db, { ...owner, now: () => later }, { itemId: r.view.item.id, event: "confirm" });
    const wanted = await bookingSchedules.wanted(s.db, r.view.item.id, later);
    expect(wanted?.links).toEqual([
      {
        scheduleId: "deposit",
        purpose: "deposit",
        amount: { value: 10_500, currency: "KRW" },
        expiresAt: Math.min(later + DAY, Date.parse(start)),
        title: `투블럭 컷 (${r.view.item.id.slice(-6).toUpperCase()})`,
      },
    ]);
    // Paid at the desk and recorded with a reference and no amount: the deposit still to pay, so nothing
    // more is asked for.
    await transitionItem(
      s.db,
      { ...owner, now: () => later },
      { itemId: r.view.item.id, event: "record_payment", input: { paymentRef: "desk-3" } },
    );
    expect((await bookingSchedules.wanted(s.db, r.view.item.id, later))?.links).toEqual([]);
  });

  it("is given no time to pay while a time we proposed waits for the customer, and a day once they accept it", async () => {
    const s = await salon({ name: "Seongsu Hair Atelier", zone: "Asia/Seoul", currency: "KRW", languages: ["ko"] });
    const perm = await s.caps.setup.createService(
      owner,
      serviceInput.parse({
        name: "Down perm",
        duration_min: 60,
        granularity_min: 30,
        price: { model: "fixed", value: 48_000, currency: "KRW" },
        deposit: { kind: "amount", value: 10_000 },
      }),
    );
    await payments(s.db);
    const r = await s.caps.createBooking(agent(), {
      payload: booking(perm.id, "Down perm", "2026-11-06T10:00:00+09:00", "2026-11-06T11:00:00+09:00"),
      contact: { name: "Seo-yeon", email: "seoyeon@example.com", locale: "ko" },
      idempotency_key: "seongsu-1",
    });
    await transitionItem(s.db, owner, {
      itemId: r.view.item.id,
      event: "propose",
      input: { startTime: "2026-11-06T14:00:00+09:00", endTime: "2026-11-06T15:00:00+09:00" },
    });
    const waiting = (await stored(s.db, r.view.item.id)) as {
      deposit?: { dueBy?: string };
      proposed?: { deposit?: { dueBy?: string } };
    };
    expect(waiting.deposit).toBeDefined();
    expect(waiting.deposit?.dueBy).toBeUndefined();
    expect(waiting.proposed?.deposit).toBeDefined();
    expect(waiting.proposed?.deposit).not.toHaveProperty("dueBy");
    expect((await bookingSchedules.wanted(s.db, r.view.item.id, T0))?.links).toEqual([]);
    const as: Caller = { ...agent(), accessToken: r.accessToken ?? "" };
    const asked = await s.caps.customer
      .acceptOffer(as, { item_id: r.view.item.id, idempotency_key: "seongsu-acc-1" })
      .catch((e: WriteError) => e);
    const done = await s.caps.customer.acceptOffer(as, {
      item_id: r.view.item.id,
      terms_sha: String((asked as WriteError).details?.terms_sha),
      idempotency_key: "seongsu-acc-2",
    });
    expect(done.view.item.state).toBe("confirmed");
    expect((await stored(s.db, r.view.item.id)).deposit).toMatchObject({
      amount: { value: 10_000, currency: "KRW" },
      dueBy: new Date(T0 + DAY).toISOString(),
    });
  });

  it("is never given a time to pay by where no payment platform takes it", async () => {
    const s = await salon({ name: "Salón Frida", zone: "America/Mexico_City", currency: "MXN", languages: ["es"] });
    const nails = await s.caps.setup.createService(
      owner,
      serviceInput.parse({
        name: "Uñas acrílicas",
        duration_min: 60,
        price: { model: "fixed", value: 65_000, currency: "MXN" },
        deposit: { kind: "amount", value: 20_000 },
      }),
    );
    let summary = "";
    const input = {
      payload: booking(nails.id, "Uñas acrílicas", "2026-11-06T12:00:00-06:00", "2026-11-06T13:00:00-06:00"),
      contact: { name: "Sofía", email: "sofia@example.com", locale: "es-MX" },
      idempotency_key: "frida-1",
    };
    try {
      await new Capabilities(s.db).createBooking(agent(), input);
    } catch (error) {
      summary = String((error as WriteError).details?.summary ?? "");
    }
    // The customer reads that a deposit holds it, never a time to pay that nothing will ask for.
    expect(summary).toMatch(/deposit|depósito/);
    expect(summary).not.toMatch(/pay it by|págalo/);
    const r = await s.caps.createBooking(agent(), input);
    await transitionItem(s.db, owner, { itemId: r.view.item.id, event: "confirm" });
    const [row] = await s.db.orm.select().from(items).where(eq(items.id, r.view.item.id));
    expect((row?.payload as { deposit?: { dueBy?: string } } | undefined)?.deposit?.dueBy).toBeUndefined();
  });
});

/** A payment platform connected that makes links (ADR-023), as Stripe or Mollie would be. */
async function payments(db: Db): Promise<void> {
  await db.client.query({
    sql: `INSERT INTO connectors (id, kind, name, status, config_public, created_at, updated_at)
          VALUES ('pay1', 'stripe', 'Stripe', 'active', ?, ?, ?)`,
    params: [JSON.stringify({ payOn: true }), T0, T0],
    method: "run",
  });
}

describe("cancelling", () => {
  async function policySalon() {
    const s = await mapleAndFade();
    await s.caps.setup.updateService(owner, {
      service_id: s.fade.id,
      policy: {
        steps: [{ before: { hours: 24 }, fee: { kind: "none" } }],
        after: { kind: "percent", value: 50 },
        noShow: { kind: "full" },
      },
    });
    return s;
  }

  it("says the fee first, and cancels with it only once the customer said yes", async () => {
    const { db, caps, fade, ravi } = await policySalon();
    const start = at("16:00");
    const r = await caps.createBooking(agent(), {
      payload: booking(fade.id, "Skin fade", start, at("16:30")),
      staff_id: ravi.id,
      contact: { name: "Aiyana", email: "aiyana@example.com" },
      idempotency_key: "cancel-1",
    });
    const token = r.accessToken ?? "";
    expect((r.view.item.payload as { policy?: unknown }).policy).toBeDefined();
    await transitionItem(db, owner, { itemId: r.view.item.id, event: "confirm" });
    // Nine hours before: inside the free day, so half of Ravi's CA$55.00.
    const asked = await caps
      .cancelItem(agent(), { item_id: r.view.item.id, access_token: token, idempotency_key: "c-1" })
      .catch((e: unknown) => e);
    expect(asked).toMatchObject({ code: "confirm_terms", details: { fee: { value: 2750, currency: "CAD" } } });
    const sha = String((asked as WriteError).details?.fee_sha);
    expect((asked as WriteError).message).toContain("Cancelling now costs CA$27.50");
    // Still confirmed: nothing was cancelled.
    expect(String((await db.orm.select().from(items)).find((i) => i.id === r.view.item.id)?.state)).toBe("confirmed");
    // A fingerprint for another fee is no yes.
    await expect(
      caps.cancelItem(agent(), {
        item_id: r.view.item.id,
        access_token: token,
        fee_sha: "x".repeat(43),
        idempotency_key: "c-2",
      }),
    ).rejects.toMatchObject({ code: "confirm_terms", details: { changed: true } });
    const done = await caps.cancelItem(agent(), {
      item_id: r.view.item.id,
      access_token: token,
      fee_sha: sha,
      idempotency_key: "c-3",
    });
    expect(done.view.item.state).toBe("cancelled_by_customer");
  });

  it("is dated again when the booking moves, to another time we proposed or a change both agreed", async () => {
    const { db, caps, fade, ravi } = await policySalon();
    const day = (n: number) => new Date(T0 + n * DAY).toISOString().slice(0, 10);
    const r = await caps.createBooking(agent(), {
      payload: booking(fade.id, "Skin fade", `${day(3)}T16:00:00-05:00`, `${day(3)}T16:30:00-05:00`),
      staff_id: ravi.id,
      contact: { name: "Aiyana", email: "aiyana@example.com" },
      idempotency_key: "move-1",
    });
    const as: Caller = { ...agent(), accessToken: r.accessToken ?? "" };
    /** When cancelling stops being free under the terms the customer confirms for what is offered. */
    let offeredFreeUntil = Number.NaN;
    const accept = async () => {
      const asked = await caps.customer
        .acceptOffer(as, { item_id: r.view.item.id, idempotency_key: `a-${Math.random()}` })
        .catch((e: WriteError) => e.details as { terms_sha?: string; offer?: { terms?: Record<string, unknown> } });
      const policy = (asked as { offer?: { terms?: { policy?: { steps: { until: string }[] } } } }).offer?.terms
        ?.policy;
      offeredFreeUntil = Date.parse(String(policy?.steps[0]?.until));
      return caps.customer.acceptOffer(as, {
        item_id: r.view.item.id,
        terms_sha: String((asked as { terms_sha?: string }).terms_sha),
        idempotency_key: `b-${Math.random()}`,
      });
    };
    // Another time we proposed, a week on: the policy is dated for it.
    await transitionItem(db, owner, {
      itemId: r.view.item.id,
      event: "propose",
      input: { startTime: `${day(10)}T16:00:00-05:00`, endTime: `${day(10)}T16:30:00-05:00` },
    });
    await accept();
    // What the customer confirmed for that time already carried the policy dated for it.
    expect(offeredFreeUntil).toBe(Date.parse(`${day(9)}T16:00:00-05:00`));
    const freeUntil = async () => {
      const [row] = await db.orm.select().from(items).where(eq(items.id, r.view.item.id));
      const p = row?.payload as { policy?: { steps: { until: string }[] } } | undefined;
      return Date.parse(String(p?.policy?.steps[0]?.until));
    };
    expect(await freeUntil()).toBe(Date.parse(`${day(9)}T16:00:00-05:00`));
    // Moved again by a change both agreed, to day 20: cancelling on day 15 is free, as the policy says.
    await transitionItem(db, owner, {
      itemId: r.view.item.id,
      event: "propose_change",
      input: { startTime: `${day(20)}T16:00:00-05:00` },
    });
    await accept();
    expect(offeredFreeUntil).toBe(Date.parse(`${day(19)}T16:00:00-05:00`));
    expect(await freeUntil()).toBe(Date.parse(`${day(19)}T16:00:00-05:00`));
    const [row] = await db.orm.select().from(items).where(eq(items.id, r.view.item.id));
    const moved = { id: r.view.item.id, payload: row?.payload as never };
    expect((await cancelFeeOf(moved, T0 + 15 * DAY, "en"))?.fee.value).toBe(0);
    expect((await cancelFeeOf(moved, T0 + 20 * DAY - 3_600_000, "en"))?.fee.value).toBe(2750);
  });

  it("costs what its terms say before anything is paid, as the customer was told when they booked", async () => {
    const { db, caps, fade, ravi } = await policySalon();
    const day = new Date(T0 + 3 * DAY).toISOString().slice(0, 10);
    const input = {
      payload: booking(fade.id, "Skin fade", `${day}T16:00:00-05:00`, `${day}T16:30:00-05:00`),
      staff_id: ravi.id,
      contact: { name: "Aiyana", email: "aiyana@example.com" },
      idempotency_key: "unpaid-1",
    };
    const summary = await new Capabilities(db)
      .createBooking(agent(), input)
      .catch((e: WriteError) => String(e.details?.summary ?? ""));
    // The right of withdrawal wins only once paid; until then the cancellation terms apply, and it says so.
    const words = withdrawalCopy("en", "eu");
    expect(summary).toContain(words.paidBack);
    expect(summary).toContain(words.unpaidTerms);
    expect(summary).toContain("Once you have paid");
    const r = await caps.createBooking(agent(), input);
    await transitionItem(db, owner, { itemId: r.view.item.id, event: "confirm" });
    // Twelve hours before, three days after booking, nothing paid: the terms' fee, as they read.
    const start = Date.parse(`${day}T16:00:00-05:00`);
    const late: Caller = { ...agent(), now: () => start - 12 * 3_600_000 };
    const asked = await caps
      .cancelItem(late, { item_id: r.view.item.id, access_token: r.accessToken ?? "", idempotency_key: "unpaid-c" })
      .catch((e: unknown) => e);
    expect(asked).toMatchObject({ code: "confirm_terms", details: { fee: { value: 2750, currency: "CAD" } } });
    expect((asked as WriteError).details).not.toHaveProperty("refund_owed");
  });

  it("is free while the policy says so, with nothing to confirm", async () => {
    const { db, caps, fade, ravi } = await policySalon();
    const tomorrow = new Date(T0 + 2 * DAY).toISOString().slice(0, 10);
    const r = await caps.createBooking(agent(), {
      payload: booking(fade.id, "Skin fade", `${tomorrow}T16:00:00-05:00`, `${tomorrow}T16:30:00-05:00`),
      staff_id: ravi.id,
      contact: { name: "Aiyana" },
      idempotency_key: "cancel-free",
    });
    await transitionItem(db, owner, { itemId: r.view.item.id, event: "confirm" });
    const done = await caps.cancelItem(agent(), {
      item_id: r.view.item.id,
      access_token: r.accessToken ?? "",
      idempotency_key: "cf-1",
    });
    expect(done.view.item.state).toBe("cancelled_by_customer");
  });

  it("costs nothing on a request nobody confirmed, by their own door or by phone", async () => {
    const { db, caps, fade, ravi } = await policySalon();
    const notes = async (id: string) =>
      (
        await db.client.query({
          sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND actor_kind = 'system'",
          params: [id],
          method: "all",
        })
      ).rows.map((n) => String(n[0]));
    // Nine hours before: half of Ravi's CA$55.00 once it is confirmed, but these are still requests.
    const asked = async (idem: string) =>
      caps.createBooking(agent(), {
        payload: booking(fade.id, "Skin fade", at("16:00"), at("16:30")),
        staff_id: ravi.id,
        contact: { name: "Aiyana", email: "aiyana@example.com" },
        idempotency_key: idem,
      });
    const byPhone = await asked("req-phone");
    expect((byPhone.view.item.payload as { policy?: unknown }).policy).toBeDefined();
    const recorded = await caps.transitionItem(owner, {
      item_id: byPhone.view.item.id,
      event: "record_cancel",
      input: { note: "phoned: never mind" },
    });
    expect(recorded.view.item.state).toBe("cancelled_by_customer");
    expect(await notes(byPhone.view.item.id)).toEqual([]);
    const own = await asked("req-own");
    await caps.cancelItem(agent(), {
      item_id: own.view.item.id,
      access_token: own.accessToken ?? "",
      idempotency_key: "req-own-c",
    });
    expect(await notes(own.view.item.id)).toEqual([]);
  });
});

describe("a deposit the policy keeps", () => {
  it("comes back while cancelling is free, and is kept after, as the customer is told", async () => {
    const { db, caps, fade, ravi } = await mapleAndFade();
    await caps.setup.updateService(owner, {
      service_id: fade.id,
      deposit: { kind: "amount", value: 2000 },
      policy: {
        steps: [{ before: { hours: 24 }, fee: { kind: "none" } }],
        after: { kind: "none" },
        noShow: { kind: "full" },
        deposit: { refundable: false },
      },
    });
    const day = new Date(T0 + 3 * DAY).toISOString().slice(0, 10);
    let summary = "";
    const input = {
      payload: booking(fade.id, "Skin fade", `${day}T16:00:00-05:00`, `${day}T16:30:00-05:00`),
      staff_id: ravi.id,
      contact: { name: "Aiyana", email: "aiyana@example.com" },
      idempotency_key: "keep-1",
    };
    try {
      await new Capabilities(db).createBooking(agent(), input);
    } catch (error) {
      summary = String((error as WriteError).details?.summary ?? "");
    }
    expect(summary).toContain("Free cancellation until");
    expect(summary).toContain("After that, the deposit is not refunded.");
    expect(summary).not.toContain("After that: nothing.");
    // Booked once the free day had passed: said without an "after that" of nothing.
    const soon = await new Capabilities(db)
      .createBooking(agent(), {
        ...input,
        payload: booking(fade.id, "Skin fade", at("18:00"), at("18:30")),
        idempotency_key: "keep-soon",
      })
      .catch((e: WriteError) => String(e.details?.summary ?? ""));
    expect(soon).toContain("If you cancel, the deposit is not refunded.");
    expect(soon).not.toContain("After that");
    const r = await caps.createBooking(agent(), input);
    await transitionItem(db, owner, { itemId: r.view.item.id, event: "confirm" });
    await transitionItem(
      db,
      {
        actor: { kind: "connector", id: "connector:pay", channel: "connector" },
        tier: "verified_principal",
        sandbox: false,
        now: () => T0,
      },
      {
        itemId: r.view.item.id,
        event: "record_payment",
        input: { paymentRef: "pi_1", amount: { value: 2000, currency: "CAD" } },
      },
    );
    const [row] = await db.orm.select().from(items).where(eq(items.id, r.view.item.id));
    const paid = { id: r.view.item.id, payload: row?.payload as never };
    // Two days ahead it is free, the deposit back; inside the day it is kept.
    const early = await cancelFeeOf(paid, Date.parse(`${day}T16:00:00-05:00`) - 48 * 3_600_000, "en");
    expect([early?.fee.value, early?.refund?.value]).toEqual([0, 2000]);
    const late = await cancelFeeOf(paid, Date.parse(`${day}T16:00:00-05:00`) - 12 * 3_600_000, "en");
    expect([late?.fee.value, late?.refund?.value]).toEqual([2000, 0]);
  });

  /** The keep preset with a CA$20 deposit, a booking `days` ahead confirmed now and its deposit paid. */
  async function keptAndPaid(days: number, idem: string) {
    const s = await mapleAndFade();
    await s.caps.setup.updateService(owner, {
      service_id: s.fade.id,
      deposit: { kind: "amount", value: 2000 },
      policy: {
        steps: [{ before: { hours: 24 }, fee: { kind: "none" } }],
        after: { kind: "none" },
        noShow: { kind: "full" },
        deposit: { refundable: false },
      },
    });
    const day = new Date(T0 + days * DAY).toISOString().slice(0, 10);
    const input = {
      payload: booking(s.fade.id, "Skin fade", `${day}T16:00:00-05:00`, `${day}T16:30:00-05:00`),
      staff_id: s.ravi.id,
      contact: { name: "Aiyana", email: "aiyana@example.com" },
      idempotency_key: idem,
    };
    const summary = await new Capabilities(s.db)
      .createBooking(agent(), input)
      .catch((e: WriteError) => String(e.details?.summary ?? ""));
    const r = await s.caps.createBooking(agent(), input);
    await transitionItem(s.db, owner, { itemId: r.view.item.id, event: "confirm" });
    await transitionItem(
      s.db,
      {
        actor: { kind: "connector", id: "connector:pay", channel: "connector" },
        tier: "verified_principal",
        sandbox: false,
        now: () => T0,
      },
      {
        itemId: r.view.item.id,
        event: "record_payment",
        input: { paymentRef: `pi_${idem}`, amount: { value: 2000, currency: "CAD" } },
      },
    );
    const start = Date.parse(`${day}T16:00:00-05:00`);
    const refunds = async () =>
      (await s.db.orm.select().from(items))
        .filter((i) => i.type === "refund")
        .map((i) => (i.payload as { amount?: unknown; kind?: unknown }) ?? {})
        .map((x) => [x.amount, x.kind]);
    return { ...s, r, start, summary, refunds };
  }

  it("gives way to the right of withdrawal: paid and cancelled in that time, it all comes back, as the customer was told", async () => {
    const { db, caps, r, start, summary, refunds } = await keptAndPaid(3, "keep-w");
    // The customer read both, and which one wins.
    expect(summary).toContain("After that, the deposit is not refunded.");
    expect(summary).toContain(withdrawalCopy("en", "eu").paidBack);
    // Twelve hours before, three days after booking: their withdrawal, with nothing to confirm first.
    const late: Caller = { ...agent(), now: () => start - 12 * 3_600_000 };
    const done = await caps.cancelItem(late, {
      item_id: r.view.item.id,
      access_token: r.accessToken ?? "",
      idempotency_key: "keep-w-c",
    });
    expect(done.view.item.state).toBe("cancelled_by_customer");
    const { rows } = await db.client.query({
      sql: "SELECT event FROM item_events WHERE item_id = ? ORDER BY seq",
      params: [r.view.item.id],
      method: "all",
    });
    expect(rows.map((x) => x[0])).toContain("withdraw");
    expect(await refunds()).toEqual([[{ value: 2000, currency: "CAD" }, "withdrawal"]]);
  });

  it("is kept once the right of withdrawal has run out and cancelling is no longer free", async () => {
    const { caps, r, start, refunds } = await keptAndPaid(20, "keep-k");
    const late: Caller = { ...agent(), now: () => start - 12 * 3_600_000 };
    const asked = await caps
      .cancelItem(late, { item_id: r.view.item.id, access_token: r.accessToken ?? "", idempotency_key: "keep-k-1" })
      .catch((e: unknown) => e);
    expect(asked).toMatchObject({
      code: "confirm_terms",
      details: { fee: { value: 2000, currency: "CAD" }, refund_owed: { value: 0, currency: "CAD" } },
    });
    const done = await caps.cancelItem(late, {
      item_id: r.view.item.id,
      access_token: r.accessToken ?? "",
      fee_sha: String((asked as WriteError).details?.fee_sha),
      idempotency_key: "keep-k-2",
    });
    expect(done.view.item.state).toBe("cancelled_by_customer");
    expect(await refunds()).toEqual([]);
  });

  it("is said with every fee after the free time, when it may be more than that fee", async () => {
    const { db, caps, fade, ravi } = await mapleAndFade();
    await caps.setup.updateService(owner, {
      service_id: fade.id,
      deposit: { kind: "percent", value: 50 },
      policy: {
        steps: [
          { before: { hours: 48 }, fee: { kind: "none" } },
          { before: { hours: 24 }, fee: { kind: "percent", value: 20 } },
        ],
        after: { kind: "percent", value: 20 },
        noShow: { kind: "full" },
        deposit: { refundable: false },
      },
    });
    const day = new Date(T0 + 4 * DAY).toISOString().slice(0, 10);
    const input = {
      payload: booking(fade.id, "Skin fade", `${day}T16:00:00-05:00`, `${day}T16:30:00-05:00`),
      staff_id: ravi.id,
      contact: { name: "Aiyana", email: "aiyana@example.com" },
      idempotency_key: "keep-steps",
    };
    const summary = await new Capabilities(db)
      .createBooking(agent(), input)
      .catch((e: WriteError) => String(e.details?.summary ?? ""));
    expect(summary).toContain("cancelling costs CA$11.00, or the deposit paid if that is more.");
    expect(summary).toContain("After that: CA$11.00, or the deposit paid if that is more.");
    const r = await caps.createBooking(agent(), input);
    await transitionItem(db, owner, { itemId: r.view.item.id, event: "confirm" });
    await transitionItem(
      db,
      {
        actor: { kind: "connector", id: "connector:pay", channel: "connector" },
        tier: "verified_principal",
        sandbox: false,
        now: () => T0,
      },
      {
        itemId: r.view.item.id,
        event: "record_payment",
        input: { paymentRef: "pi_steps", amount: { value: 2750, currency: "CAD" } },
      },
    );
    const [row] = await db.orm.select().from(items).where(eq(items.id, r.view.item.id));
    const paid = { id: r.view.item.id, payload: row?.payload as never };
    // A day and a half before: the step's CA$11.00 is less than the deposit paid, which is what is kept.
    const quote = await cancelFeeOf(paid, Date.parse(`${day}T16:00:00-05:00`) - 36 * 3_600_000, "en");
    expect(quote?.fee.value).toBe(2750);
    expect(quote?.sentence).toContain("CA$11.00, or the deposit paid if that is more.");
  });
});

describe("a paid deposit, once the right of withdrawal has run out", () => {
  /** A CA$20 deposit that comes back, a booking twenty days ahead confirmed now, its deposit paid. */
  async function paidDeposit(idem: string, policy = true) {
    const s = await mapleAndFade();
    await s.caps.setup.updateService(owner, {
      service_id: s.fade.id,
      deposit: { kind: "amount", value: 2000 },
      ...(policy
        ? {
            policy: {
              steps: [{ before: { hours: 24 }, fee: { kind: "none" as const } }],
              after: { kind: "percent" as const, value: 10 },
              noShow: { kind: "full" as const },
            },
          }
        : {}),
    });
    const day = new Date(T0 + 20 * DAY).toISOString().slice(0, 10);
    const r = await s.caps.createBooking(agent(), {
      payload: booking(s.fade.id, "Skin fade", `${day}T16:00:00-05:00`, `${day}T16:30:00-05:00`),
      staff_id: s.ravi.id,
      contact: { name: "Aiyana", email: "aiyana@example.com" },
      idempotency_key: idem,
    });
    await transitionItem(s.db, owner, { itemId: r.view.item.id, event: "confirm" });
    await transitionItem(
      s.db,
      {
        actor: { kind: "connector", id: "connector:pay", channel: "connector" },
        tier: "verified_principal",
        sandbox: false,
        now: () => T0,
      },
      {
        itemId: r.view.item.id,
        event: "record_payment",
        input: { paymentRef: `pi_${idem}`, amount: { value: 2000, currency: "CAD" } },
      },
    );
    const start = Date.parse(`${day}T16:00:00-05:00`);
    const after = async () => {
      const all = await s.db.orm.select().from(items);
      const refunds = all
        .filter((i) => i.type === "refund")
        .map((i) => ({ state: i.state, ...(i.payload as { amount?: unknown; kind?: unknown; refundDue?: string }) }));
      const notes = await s.db.client.query({
        sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND actor_kind = 'system' ORDER BY rowid",
        params: [r.view.item.id],
        method: "all",
      });
      const row = all.find((i) => i.id === r.view.item.id);
      return {
        state: row?.state,
        needsHuman: (row?.flags as { needsHuman?: boolean } | undefined)?.needsHuman === true,
        refunds,
        notes: notes.rows.map((n) => String(n[0])).join(" "),
      };
    };
    return { ...s, r, start, after };
  }

  it("comes back whole on a free cancel: a refund is opened for it, and the owner told", async () => {
    const { caps, r, start, after } = await paidDeposit("dep-free");
    const early: Caller = { ...agent(), now: () => start - 5 * DAY };
    const done = await caps.cancelItem(early, {
      item_id: r.view.item.id,
      access_token: r.accessToken ?? "",
      idempotency_key: "dep-free-c",
    });
    expect(done.view.item.state).toBe("cancelled_by_customer");
    const then = await after();
    expect(then.refunds).toMatchObject([
      { state: "approved", kind: "cancellation", amount: { value: 2000, currency: "CAD" } },
    ]);
    expect(Date.parse(String(then.refunds[0]?.refundDue))).toBeGreaterThan(start - 5 * DAY);
    expect(then.notes).toContain("all they paid, CA$20.00, is owed back to them by");
    expect(then.needsHuman).toBe(false);
  });

  it("comes back less the fee on a late cancel, as the customer was told", async () => {
    const { caps, r, start, after } = await paidDeposit("dep-late");
    const late: Caller = { ...agent(), now: () => start - 10 * 3_600_000 };
    const asked = await caps
      .cancelItem(late, { item_id: r.view.item.id, access_token: r.accessToken ?? "", idempotency_key: "dep-late-1" })
      .catch((e: unknown) => e);
    expect(asked).toMatchObject({
      code: "confirm_terms",
      details: { fee: { value: 550, currency: "CAD" }, refund_owed: { value: 1450, currency: "CAD" } },
    });
    expect((asked as WriteError).message).toContain("CA$14.50 comes back to you");
    await caps.cancelItem(late, {
      item_id: r.view.item.id,
      access_token: r.accessToken ?? "",
      fee_sha: String((asked as WriteError).details?.fee_sha),
      idempotency_key: "dep-late-2",
    });
    const then = await after();
    expect(then.state).toBe("cancelled_by_customer");
    expect(then.refunds).toMatchObject([
      { state: "approved", kind: "cancellation", amount: { value: 1450, currency: "CAD" } },
    ]);
    expect(then.notes).toContain("Cancelled with a fee of CA$5.50 under its policy");
    expect(then.notes).toContain("CA$14.50 is owed back to them by");
  });

  it("comes back whole on a free cancel with a deposit and no policy", async () => {
    const { caps, r, start, after } = await paidDeposit("np-free", false);
    const early: Caller = { ...agent(), now: () => start - 5 * DAY };
    await caps.cancelItem(early, {
      item_id: r.view.item.id,
      access_token: r.accessToken ?? "",
      idempotency_key: "np-c",
    });
    const then = await after();
    expect(then.refunds).toMatchObject([
      { state: "approved", kind: "cancellation", amount: { value: 2000, currency: "CAD" } },
    ]);
    expect(then.notes).toContain("all they paid, CA$20.00, is owed back to them");
  });

  it("comes back as on the customer's own door when the owner records their cancel by phone, dated in the salon's zone", async () => {
    const { caps, r, start, after } = await paidDeposit("rec-free");
    // Asked at half past nine in the evening in Toronto: already the next day in UTC.
    const evening: Caller = { ...owner, now: () => start - 5 * DAY + 5.5 * 3_600_000 };
    const done = await caps.transitionItem(evening, {
      item_id: r.view.item.id,
      event: "record_cancel",
      input: { note: "phoned" },
    });
    expect(done.view.item.state).toBe("cancelled_by_customer");
    const then = await after();
    expect(then.refunds).toMatchObject([
      { state: "approved", kind: "cancellation", amount: { value: 2000, currency: "CAD" } },
    ]);
    const due = String(then.refunds[0]?.refundDue);
    const local = new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "America/Toronto",
    }).format(new Date(due));
    expect(then.notes).toContain(`all they paid, CA$20.00, is owed back to them by ${local}.`);
    expect(then.notes).not.toContain(due.slice(0, 10));
    // Paid in, and no payment platform takes payments here: given back by hand.
    expect(then.notes).toContain("Pay it back to them yourself; nothing was refunded here.");
    expect(then.needsHuman).toBe(false);
  });

  it("is judged by the booking's own policy when the owner records a cancel, not the business-wide window", async () => {
    const s = await paidDeposit("rec-policy");
    await payments(s.db);
    // Late by the business-wide two days, free by the booking's own 24 hours: free, all of it back.
    await s.caps.updateSettings(owner, {
      doc: { booking: { cancellationWindowMin: 2880, lateCancellation: "record" } },
    });
    const asked = new Date(s.start - 30 * 3_600_000).toISOString();
    // Written down an hour after they asked.
    await s.caps.transitionItem(
      { ...owner, now: () => s.start - 29 * 3_600_000 },
      {
        item_id: s.r.view.item.id,
        event: "record_cancel",
        input: { note: "at the desk", askedAt: asked },
      },
    );
    const { rows } = await s.db.client.query({
      sql: "SELECT event FROM item_events WHERE item_id = ? ORDER BY seq",
      params: [s.r.view.item.id],
      method: "all",
    });
    expect(rows.map((x) => x[0])).toContain("record_cancel");
    expect(rows.map((x) => x[0])).not.toContain("record_cancel_late");
    const then = await s.after();
    // Owed back by the refund days from when they asked, not from when it was written down.
    expect(then.refunds).toMatchObject([
      {
        amount: { value: 2000, currency: "CAD" },
        noticeAt: asked,
        refundDue: new Date(Date.parse(asked) + 14 * DAY).toISOString(),
      },
    ]);
    // Paid through the platform that takes payments here: refunded there.
    expect(then.notes).toContain("Refund it through your payment platform; nothing was refunded here.");
  });

  it("keeps the policy's fee when the owner records a late cancel by phone, and owes back the rest", async () => {
    const { caps, r, start, after } = await paidDeposit("rec-late");
    const late: Caller = { ...owner, now: () => start - 10 * 3_600_000 };
    await caps.transitionItem(late, { item_id: r.view.item.id, event: "record_cancel", input: { note: "phoned" } });
    const then = await after();
    expect(then.state).toBe("cancelled_by_customer");
    expect(then.refunds).toMatchObject([
      { state: "approved", kind: "cancellation", amount: { value: 1450, currency: "CAD" } },
    ]);
    // Said by phone: the inbox showed them no fee, so it never says they saw one.
    expect(then.notes).toContain("Cancelled late by phone or at the desk, with a fee of CA$5.50 under its policy.");
    expect(then.notes).not.toContain("as the customer saw it");
    expect(then.notes).toContain("CA$14.50 is owed back to them by");
  });

  it("is a person's to settle when it is cancelled late and nothing says what is kept", async () => {
    const { db, caps, r, start, after } = await paidDeposit("dep-none", false);
    await caps.updateSettings(owner, { doc: { booking: { lateCancellation: "record" } } });
    const late: Caller = { ...agent(), now: () => start - 10 * 3_600_000 };
    const done = await caps.cancelItem(late, {
      item_id: r.view.item.id,
      access_token: r.accessToken ?? "",
      idempotency_key: "dep-none-c",
    });
    expect(done.view.item.state).toBe("cancelled_by_customer");
    const { rows } = await db.client.query({
      sql: "SELECT event FROM item_events WHERE item_id = ? ORDER BY seq",
      params: [r.view.item.id],
      method: "all",
    });
    expect(rows.map((x) => x[0])).toContain("cancel_late");
    const then = await after();
    expect(then.refunds).toEqual([]);
    expect(then.needsHuman).toBe(true);
    expect(then.notes).toContain("They paid CA$20.00");
  });

  it("is said to the owner with English money and days, whatever the business's first language", async () => {
    const s = await salon({
      name: "Estudio Xóchitl",
      zone: "America/Mexico_City",
      currency: "MXN",
      languages: ["es", "en"],
    });
    const balayage = await s.caps.setup.createService(
      owner,
      serviceInput.parse({
        name: "Balayage",
        duration_min: 120,
        granularity_min: 30,
        price: { model: "fixed", value: 570_000, currency: "MXN" },
      }),
    );
    await s.caps.setup.updateService(owner, { service_id: balayage.id, deposit: { kind: "amount", value: 114_000 } });
    const lupita = await s.caps.staff.create(owner, {
      name: "María Guadalupe Hernández",
      sort: 0,
      services: [{ service_id: balayage.id }],
    });
    const day = new Date(T0 + 20 * DAY).toISOString().slice(0, 10);
    const start = `${day}T11:00:00-06:00`;
    const r = await s.caps.createBooking(agent(), {
      payload: booking(balayage.id, "Balayage", start, `${day}T13:00:00-06:00`),
      staff_id: lupita.id,
      contact: { name: "Renata", email: "renata@example.com" },
      idempotency_key: "mx-1",
    });
    await transitionItem(s.db, owner, { itemId: r.view.item.id, event: "confirm" });
    await transitionItem(
      s.db,
      {
        actor: { kind: "connector", id: "connector:pay", channel: "connector" },
        tier: "verified_principal",
        sandbox: false,
        now: () => T0,
      },
      {
        itemId: r.view.item.id,
        event: "record_payment",
        input: { paymentRef: "pi_mx", amount: { value: 114_000, currency: "MXN" } },
      },
    );
    const asked = Date.parse(start) - 5 * DAY;
    await s.caps.transitionItem(
      { ...owner, now: () => asked },
      { item_id: r.view.item.id, event: "record_cancel", input: { note: "llamó para cancelar" } },
    );
    const { rows } = await s.db.client.query({
      sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND actor_kind = 'system'",
      params: [r.view.item.id],
      method: "all",
    });
    const note = rows.map((n) => String(n[0])).join(" ");
    const by = new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "America/Mexico_City",
    }).format(new Date(asked + 14 * DAY));
    expect(note).toContain(`all they paid, MX$1,140.00, is owed back to them by ${by}.`);
    expect(note).not.toContain("1140,00");
  });

  it("is a person's to settle when the owner records a late cancel by phone where late cancels are refused", async () => {
    const { db, caps, r, start, after } = await paidDeposit("dep-refuse", false);
    await caps.updateSettings(owner, { doc: { booking: { lateCancellation: "refuse" } } });
    // Their own door refuses it two hours before: it is late.
    const own = await caps
      .cancelItem(
        { ...agent(), now: () => start - 2 * 3_600_000 },
        {
          item_id: r.view.item.id,
          access_token: r.accessToken ?? "",
          idempotency_key: "dep-refuse-own",
        },
      )
      .catch((e: unknown) => e);
    expect(own).toMatchObject({ code: "guard_failed" });
    // Recorded by phone then, it is still late: nothing is opened as owed, and a person decides.
    const done = await caps.transitionItem(
      { ...owner, now: () => start - 2 * 3_600_000 },
      { item_id: r.view.item.id, event: "record_cancel", input: { note: "phoned, running late" } },
    );
    expect(done.view.item.state).toBe("cancelled_by_customer");
    expect(done.linked).toBeUndefined();
    const then = await after();
    expect(then.refunds).toEqual([]);
    expect(then.needsHuman).toBe(true);
    expect(then.notes).toContain("They paid CA$20.00, and its terms do not say what of it comes back now.");
    expect(then.notes).not.toContain("It was free under its terms");
    const { rows } = await db.client.query({
      sql: "SELECT event FROM item_events WHERE item_id = ? ORDER BY seq",
      params: [r.view.item.id],
      method: "all",
    });
    expect(rows.map((x) => x[0])).toContain("record_cancel");
  });

  it("is dated by the customer's own message when the owner's AI records their cancel, never by a time it types", async () => {
    // A deposit the policy keeps once cancelling is no longer free: 24 hours before.
    const keep = {
      steps: [{ before: { hours: 24 }, fee: { kind: "none" as const } }],
      after: { kind: "none" as const },
      noShow: { kind: "full" as const },
      deposit: { refundable: false },
    };
    const ai = (now: number): Caller => ({
      ...owner,
      actor: { kind: "owner_ai", id: "owner_ai:test", channel: "mcp_owner" },
      now: () => now,
    });
    const s = await paidDeposit("ai-typed");
    await s.caps.setup.updateService(owner, { service_id: s.fade.id, policy: keep });
    // Booked again on these terms: Ravi's CA$55.00, its CA$20.00 deposit paid and kept once it is late.
    const fresh = async (idem: string) => {
      const day = new Date(T0 + 20 * DAY).toISOString().slice(0, 10);
      const b = await s.caps.createBooking(agent(), {
        payload: booking(s.fade.id, "Skin fade", `${day}T17:00:00-05:00`, `${day}T17:30:00-05:00`),
        staff_id: s.ravi.id,
        contact: { name: `Min-jun ${idem}`, email: `${idem}@example.com` },
        idempotency_key: idem,
      });
      await transitionItem(s.db, owner, { itemId: b.view.item.id, event: "confirm" });
      await transitionItem(
        s.db,
        {
          actor: { kind: "connector", id: "connector:pay", channel: "connector" },
          tier: "verified_principal",
          sandbox: false,
          now: () => T0,
        },
        {
          itemId: b.view.item.id,
          event: "record_payment",
          input: { paymentRef: `pi_${idem}`, amount: { value: 2000, currency: "CAD" } },
        },
      );
      return { b, start: Date.parse(`${day}T17:00:00-05:00`) };
    };
    const refundsOf = async (id: string) =>
      (await s.db.orm.select().from(items))
        .filter((i) => i.type === "refund" && (i.payload as { orderItemId?: string }).orderItemId === id)
        .map((i) => (i.payload as { amount: unknown }).amount);
    // Ten hours before, the owner's AI says they phoned last week: a time it types is not taken.
    const typed = await fresh("ai-typed-1");
    const backdated = await s.caps
      .transitionItem(ai(typed.start - 10 * 3_600_000), {
        item_id: typed.b.view.item.id,
        event: "record_cancel",
        input: {
          note: "Customer says they phoned last week to cancel",
          askedAt: new Date(typed.start - 5 * DAY).toISOString(),
        },
      })
      .catch((e: unknown) => e);
    expect(backdated).toMatchObject({ code: "invalid_input", fields: [{ path: "input.askedAt" }] });
    expect(await refundsOf(typed.b.view.item.id)).toEqual([]);
    // Without one it is dated now: late, so the deposit is kept and nothing is owed back.
    await s.caps.transitionItem(ai(typed.start - 10 * 3_600_000), {
      item_id: typed.b.view.item.id,
      event: "record_cancel",
      input: { note: "Customer wrote to cancel" },
    });
    expect(await refundsOf(typed.b.view.item.id)).toEqual([]);
    // Their own message five days before dates it: free then, so all of the deposit comes back.
    const wrote = await fresh("ai-typed-2");
    await s.caps.sendMessage(
      { ...agent(), now: () => wrote.start - 5 * DAY },
      { item_id: wrote.b.view.item.id, access_token: wrote.b.accessToken ?? "", body: "Please cancel my fade." },
    );
    const [entry] = await s.db.client
      .query({
        sql: "SELECT id FROM thread_entries WHERE item_id = ? AND direction = 'in' ORDER BY rowid DESC LIMIT 1",
        params: [wrote.b.view.item.id],
        method: "all",
      })
      .then((q) => q.rows);
    const dated = await s.caps.transitionItem(ai(wrote.start - 10 * 3_600_000), {
      item_id: wrote.b.view.item.id,
      event: "record_cancel",
      input: { note: "Customer wrote to cancel", entryId: String(entry?.[0]) },
    });
    expect(dated.linked?.item.payload).toMatchObject({
      amount: { value: 2000, currency: "CAD" },
      noticeAt: new Date(wrote.start - 5 * DAY).toISOString(),
    });
    // The owner reads which message it rests on, and when, and checks it: dated now, the deposit is kept.
    const [row] = await s.db.orm.select().from(items).where(eq(items.id, wrote.b.view.item.id));
    expect((row?.flags as { needsHuman?: boolean } | undefined)?.needsHuman).toBe(true);
    const notes = (
      await s.db.client.query({
        sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND actor_kind = 'system'",
        params: [wrote.b.view.item.id],
        method: "all",
      })
    ).rows.map((n) => String(n[0]));
    expect(notes.join(" ")).toContain("Cancelled by the customer in their message of Wed, 18 Nov 2026, 17:00");
    expect(notes.join(" ")).toContain("(“Please cancel my fade.”)");
    expect(notes.join(" ")).toContain("dated now, the fee would be CA$20.00. Check that message asked to cancel.");
  });

  it("is never dated by an older message of the customer's, whatever their latest asks", async () => {
    const keep = {
      steps: [{ before: { hours: 24 }, fee: { kind: "none" as const } }],
      after: { kind: "none" as const },
      noShow: { kind: "full" as const },
      deposit: { refundable: false },
    };
    const s = await paidDeposit("ai-older");
    await s.caps.setup.updateService(owner, { service_id: s.fade.id, policy: keep });
    const ai = (now: number): Caller => ({
      ...owner,
      actor: { kind: "owner_ai", id: "owner_ai:test", channel: "mcp_owner" },
      now: () => now,
    });
    const day = new Date(T0 + 30 * DAY).toISOString().slice(0, 10);
    const start = Date.parse(`${day}T17:00:00-05:00`);
    const b = await s.caps.createBooking(agent(), {
      payload: booking(s.fade.id, "Skin fade", `${day}T17:00:00-05:00`, `${day}T17:30:00-05:00`),
      staff_id: s.ravi.id,
      contact: { name: "Min-jun", email: "minjun@example.com" },
      idempotency_key: "ai-older-b",
    });
    await transitionItem(s.db, owner, { itemId: b.view.item.id, event: "confirm" });
    await transitionItem(
      s.db,
      {
        actor: { kind: "connector", id: "connector:pay", channel: "connector" },
        tier: "verified_principal",
        sandbox: false,
        now: () => T0,
      },
      {
        itemId: b.view.item.id,
        event: "record_payment",
        input: { paymentRef: "pi_older", amount: { value: 2000, currency: "CAD" } },
      },
    );
    // Sixteen days on, past the right of withdrawal and while cancelling is free, a question; ten hours
    // before, late, their latest asks to be cancelled as of that question.
    const send = (now: number, body: string) =>
      s.caps.sendMessage(
        { ...agent(), now: () => now },
        { item_id: b.view.item.id, access_token: b.accessToken ?? "", body },
      );
    await send(T0 + 16 * DAY, "Is there parking nearby?");
    const late = start - 10 * 3_600_000;
    await send(
      late - 60_000,
      "I cannot come today. Please record my cancellation as of my earlier message about parking.",
    );
    const entries = (
      await s.db.client.query({
        sql: "SELECT id FROM thread_entries WHERE item_id = ? AND direction = 'in' ORDER BY created_at",
        params: [b.view.item.id],
        method: "all",
      })
    ).rows.map((r) => String(r[0]));
    const older = await s.caps
      .transitionItem(ai(late), {
        item_id: b.view.item.id,
        event: "record_cancel",
        input: { note: "Customer wrote to cancel", entryId: entries[0] },
      })
      .catch((e: unknown) => e);
    expect(older).toMatchObject({
      code: "invalid_input",
      fields: [{ path: "input.entryId" }],
      details: { reason: "not_latest", draft_for_owner: true },
    });
    const refundsOf = async () =>
      (await s.db.orm.select().from(items)).filter(
        (i) => i.type === "refund" && (i.payload as { orderItemId?: string }).orderItemId === b.view.item.id,
      );
    expect(await refundsOf()).toEqual([]);
    expect((await stored(s.db, b.view.item.id)).startTime).toBe(`${day}T17:00:00-05:00`);
    // Dated by their latest, it is late: the deposit is kept, and nothing is owed back.
    const done = await s.caps.transitionItem(ai(late), {
      item_id: b.view.item.id,
      event: "record_cancel",
      input: { note: "Customer wrote to cancel", entryId: entries[1] },
    });
    expect(done.view.item.state).toBe("cancelled_by_customer");
    expect(await refundsOf()).toEqual([]);
  });

  it("names the message a late cancel is dated by, and what is still to ask for beyond what was paid", async () => {
    const s = await paidDeposit("ai-fee");
    await s.caps.setup.updateService(owner, {
      service_id: s.fade.id,
      policy: {
        steps: [{ before: { hours: 24 }, fee: { kind: "none" } }],
        after: { kind: "percent", value: 50 },
        noShow: { kind: "full" },
      },
    });
    await s.caps.updateSettings(owner, { doc: { booking: { lateCancellation: "record" } } });
    const day = new Date(T0 + 20 * DAY).toISOString().slice(0, 10);
    const start = Date.parse(`${day}T17:00:00-05:00`);
    const b = await s.caps.createBooking(agent(), {
      payload: booking(s.fade.id, "Skin fade", `${day}T17:00:00-05:00`, `${day}T17:30:00-05:00`),
      staff_id: s.ravi.id,
      contact: { name: "Min-jun", email: "minjun@example.com" },
      idempotency_key: "ai-fee-b",
    });
    await transitionItem(s.db, owner, { itemId: b.view.item.id, event: "confirm" });
    await transitionItem(
      s.db,
      {
        actor: { kind: "connector", id: "connector:pay", channel: "connector" },
        tier: "verified_principal",
        sandbox: false,
        now: () => T0,
      },
      {
        itemId: b.view.item.id,
        event: "record_payment",
        input: { paymentRef: "pi_fee", amount: { value: 2000, currency: "CAD" } },
      },
    );
    const late = start - 10 * 3_600_000;
    await s.caps.sendMessage(
      { ...agent(), now: () => late },
      { item_id: b.view.item.id, access_token: b.accessToken ?? "", body: "Sorry, I need to cancel today." },
    );
    const [entry] = (
      await s.db.client.query({
        sql: "SELECT id FROM thread_entries WHERE item_id = ? AND direction = 'in' ORDER BY rowid DESC LIMIT 1",
        params: [b.view.item.id],
        method: "all",
      })
    ).rows;
    await s.caps.transitionItem(
      { ...owner, actor: { kind: "owner_ai", id: "owner_ai:test", channel: "mcp_owner" }, now: () => late + 60_000 },
      {
        item_id: b.view.item.id,
        event: "record_cancel",
        input: { note: "Customer wrote to cancel", entryId: String(entry?.[0]) },
      },
    );
    const notes = (
      await s.db.client.query({
        sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND actor_kind = 'system'",
        params: [b.view.item.id],
        method: "all",
      })
    ).rows.map((n) => String(n[0]));
    // Half of Ravi's CA$55.00 is CA$27.50; the CA$20.00 paid goes towards it, and CA$7.50 is still to ask.
    expect(notes).toEqual([
      "Cancelled late by the customer in their message of Mon, 23 Nov 2026, 07:00 (“Sorry, I need to cancel today.”), with a fee of CA$27.50 under its policy. They paid CA$20.00, which goes towards it: ask them for the rest, CA$7.50; nothing was charged here.",
    ]);
    expect(notes.join(" ")).not.toMatch(/phone|desk|covers it/);
  });
});

describe("a payment recorded with a reference and no amount", () => {
  /** Ravi's skin fade (CA$55.00) twenty days ahead, confirmed, paid at the desk with no amount said. */
  async function paidAtDesk(idem: string, terms: Parameters<Capabilities["setup"]["updateService"]>[1]) {
    const s = await mapleAndFade();
    await s.caps.setup.updateService(owner, { ...terms, service_id: s.fade.id });
    const day = new Date(T0 + 20 * DAY).toISOString().slice(0, 10);
    const r = await s.caps.createBooking(agent(), {
      payload: booking(s.fade.id, "Skin fade", `${day}T16:00:00-05:00`, `${day}T16:30:00-05:00`),
      staff_id: s.ravi.id,
      contact: { name: "Aiyana", email: "aiyana@example.com" },
      idempotency_key: idem,
    });
    await transitionItem(s.db, owner, { itemId: r.view.item.id, event: "confirm" });
    await transitionItem(s.db, owner, {
      itemId: r.view.item.id,
      event: "record_payment",
      input: { paymentRef: `desk-${idem}` },
    });
    const start = Date.parse(`${day}T16:00:00-05:00`);
    const refunds = async () =>
      (await s.db.orm.select().from(items))
        .filter((i) => i.type === "refund")
        .map((i) => i.payload as { amount: unknown });
    return { ...s, r, start, refunds };
  }
  const fee10 = {
    service_id: "",
    policy: {
      steps: [{ before: { hours: 24 }, fee: { kind: "none" as const } }],
      after: { kind: "percent" as const, value: 10 },
      noShow: { kind: "full" as const },
    },
  };

  it("is the deposit while one is still to pay, on a free cancel and a late one, as the booking screen says", async () => {
    const terms = {
      service_id: "",
      deposit: { kind: "amount" as const, value: 2000 },
      policy: {
        steps: [{ before: { hours: 24 }, fee: { kind: "none" as const } }],
        after: { kind: "percent" as const, value: 50 },
        noShow: { kind: "full" as const },
      },
    };
    // The CA$20.00 deposit taken at the desk, with no amount said: paid, and no more than that.
    const free = await paidAtDesk("desk-free", terms);
    expect(await stored(free.db, free.r.view.item.id)).toMatchObject({ paidAmount: { value: 2000, currency: "CAD" } });
    // A payment platform takes payments here, but the owner took this one: they give it back by hand.
    await payments(free.db);
    const early: Caller = { ...agent(), now: () => free.start - 5 * DAY };
    const done = await free.caps.cancelItem(early, {
      item_id: free.r.view.item.id,
      access_token: free.r.accessToken ?? "",
      idempotency_key: "desk-free-c",
    });
    expect(done.linked?.item.payload).toMatchObject({ amount: { value: 2000, currency: "CAD" } });
    expect(await free.refunds()).toMatchObject([{ amount: { value: 2000, currency: "CAD" } }]);
    const [note] = (
      await free.db.client.query({
        sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND actor_kind = 'system'",
        params: [free.r.view.item.id],
        method: "all",
      })
    ).rows.map((n) => String(n[0]));
    expect(note).toContain("all they paid, CA$20.00, is owed back to them");
    expect(note).toContain("Pay it back to them yourself");
    expect(note).not.toContain("payment platform");
    // Late, half the CA$55.00 is more than the CA$20.00 paid: it is all kept, and nothing is said to come back.
    const late = await paidAtDesk("desk-late", terms);
    const when: Caller = { ...agent(), now: () => late.start - 10 * 3_600_000 };
    const asked = await late.caps
      .cancelItem(when, {
        item_id: late.r.view.item.id,
        access_token: late.r.accessToken ?? "",
        idempotency_key: "dl-1",
      })
      .catch((e: unknown) => e);
    expect(asked).toMatchObject({
      code: "confirm_terms",
      details: { fee: { value: 2750, currency: "CAD" }, refund_owed: { value: 0, currency: "CAD" } },
    });
    expect((asked as WriteError).message).not.toContain("comes back to you");
  });

  it("is the rest of the price once the deposit is paid: the deposit a policy keeps is kept, and the rest comes back", async () => {
    const s = await paidAtDesk("keep", {
      service_id: "",
      deposit: { kind: "percent", value: 20 },
      policy: {
        steps: [{ before: { hours: 24 }, fee: { kind: "none" } }],
        after: { kind: "none" },
        noShow: { kind: "full" },
        deposit: { refundable: false },
      },
    });
    // The CA$11.00 deposit at the desk first, then the rest, again with no amount said.
    expect(await stored(s.db, s.r.view.item.id)).toMatchObject({ paidAmount: { value: 1100, currency: "CAD" } });
    await transitionItem(s.db, owner, {
      itemId: s.r.view.item.id,
      event: "record_payment",
      input: { paymentRef: "desk-keep-rest" },
    });
    expect(await stored(s.db, s.r.view.item.id)).not.toHaveProperty("paidAmount");
    const late: Caller = { ...agent(), now: () => s.start - 10 * 3_600_000 };
    const asked = await s.caps
      .cancelItem(late, { item_id: s.r.view.item.id, access_token: s.r.accessToken ?? "", idempotency_key: "keep-1" })
      .catch((e: unknown) => e);
    // The CA$11.00 deposit is kept, never taken as free; CA$44.00 of the CA$55.00 comes back.
    expect(asked).toMatchObject({
      code: "confirm_terms",
      details: { fee: { value: 1100, currency: "CAD" }, refund_owed: { value: 4400, currency: "CAD" } },
    });
    await s.caps.cancelItem(late, {
      item_id: s.r.view.item.id,
      access_token: s.r.accessToken ?? "",
      fee_sha: String((asked as WriteError).details?.fee_sha),
      idempotency_key: "keep-2",
    });
    expect(await s.refunds()).toMatchObject([{ amount: { value: 4400, currency: "CAD" }, kind: "cancellation" }]);
  });

  it("is what the customer is told comes back, and what is opened", async () => {
    const s = await paidAtDesk("fee", fee10);
    const late: Caller = { ...agent(), now: () => s.start - 10 * 3_600_000 };
    const asked = await s.caps
      .cancelItem(late, { item_id: s.r.view.item.id, access_token: s.r.accessToken ?? "", idempotency_key: "fee-1" })
      .catch((e: unknown) => e);
    expect(asked).toMatchObject({
      code: "confirm_terms",
      details: { fee: { value: 550, currency: "CAD" }, refund_owed: { value: 4950, currency: "CAD" } },
    });
    expect((asked as WriteError).message).toContain("CA$49.50 comes back to you");
    await s.caps.cancelItem(late, {
      item_id: s.r.view.item.id,
      access_token: s.r.accessToken ?? "",
      fee_sha: String((asked as WriteError).details?.fee_sha),
      idempotency_key: "fee-2",
    });
    expect(await s.refunds()).toMatchObject([{ amount: { value: 4950, currency: "CAD" } }]);
  });

  it("takes what it came to once told under the same reference, never as the same payment told twice", async () => {
    const s = await paidAtDesk("told", { service_id: "", deposit: { kind: "amount", value: 2000 } });
    expect(await stored(s.db, s.r.view.item.id)).toMatchObject({ paidAmount: { value: 2000, currency: "CAD" } });
    // The owner then says what desk-told came to: all of Ravi's CA$55.00, which is what was paid.
    const told = { paymentRef: "desk-told", amount: { value: 5500, currency: "CAD" } };
    await transitionItem(s.db, owner, { itemId: s.r.view.item.id, event: "record_payment", input: told });
    expect(await stored(s.db, s.r.view.item.id)).toMatchObject({ paidAmount: { value: 5500, currency: "CAD" } });
    // Told again, it is the same payment: nothing more was paid.
    await transitionItem(s.db, owner, { itemId: s.r.view.item.id, event: "record_payment", input: told });
    expect(await stored(s.db, s.r.view.item.id)).toMatchObject({ paidAmount: { value: 5500, currency: "CAD" } });
    // Withdrawn while the right runs, all of it comes back.
    const w = await s.caps.transitionItem(owner, {
      item_id: s.r.view.item.id,
      event: "record_withdrawal",
      input: { note: "Phoned to withdraw" },
    });
    expect(w.linked?.item.payload).toMatchObject({ kind: "withdrawal", amount: { value: 5500, currency: "CAD" } });

    // The deposit at the desk with no amount, then the rest with none, then told what the rest came to:
    // the deposit and that.
    const parts = await paidAtDesk("parts", { service_id: "", deposit: { kind: "amount", value: 2000 } });
    const id = parts.r.view.item.id;
    await transitionItem(parts.db, owner, { itemId: id, event: "record_payment", input: { paymentRef: "desk-rest" } });
    expect(await stored(parts.db, id)).not.toHaveProperty("paidAmount");
    await transitionItem(parts.db, owner, {
      itemId: id,
      event: "record_payment",
      input: { paymentRef: "desk-rest", amount: { value: 3500, currency: "CAD" } },
    });
    expect(await stored(parts.db, id)).toMatchObject({ paidAmount: { value: 5500, currency: "CAD" } });
  });
});

describe("another customer's booking", () => {
  it("says nothing of its fee, its terms or what was paid to anyone who does not hold it", async () => {
    const s = await mapleAndFade();
    await s.caps.setup.updateService(owner, {
      service_id: s.fade.id,
      deposit: { kind: "amount", value: 2000 },
      policy: {
        steps: [{ before: { hours: 24 }, fee: { kind: "none" } }],
        after: { kind: "percent", value: 10 },
        noShow: { kind: "full" },
      },
    });
    const day = new Date(T0 + 20 * DAY).toISOString().slice(0, 10);
    const make = async (name: string, at16: string, idem: string) => {
      const r = await s.caps.createBooking(agent(), {
        payload: booking(s.fade.id, "Skin fade", `${day}T${at16}:00-05:00`, `${day}T${at16.slice(0, 3)}30:00-05:00`),
        staff_id: s.ravi.id,
        contact: { name, email: `${idem}@example.com` },
        idempotency_key: idem,
      });
      await transitionItem(s.db, owner, { itemId: r.view.item.id, event: "confirm" });
      return r;
    };
    const victim = await make("Aiyana", "16:00", "victim");
    const other = await make("Mateus", "17:00", "other");
    await transitionItem(s.db, owner, {
      itemId: victim.view.item.id,
      event: "record_payment",
      input: { paymentRef: "desk-v", amount: { value: 2000, currency: "CAD" } },
    });
    const late: Caller = { ...agent(), now: () => Date.parse(`${day}T16:00:00-05:00`) - 10 * 3_600_000 };
    for (const token of [undefined, other.accessToken ?? ""]) {
      const tried = await s.caps
        .cancelItem(late, {
          item_id: victim.view.item.id,
          ...(token ? { access_token: token } : {}),
          idempotency_key: `peek-${token ? "t" : "n"}`,
        })
        .catch((e: unknown) => e);
      expect(tried).toMatchObject({ code: "not_allowed" });
      expect(JSON.stringify((tried as WriteError).details ?? {})).not.toMatch(/fee|policy|refund/);
    }
    const [row] = await s.db.orm.select().from(items).where(eq(items.id, victim.view.item.id));
    expect(row?.state).toBe("confirmed");
  });
});

describe("the day by staff", () => {
  it("holds every booking of a busy day, however many", async () => {
    const { db, caps, fade, mei } = await mapleAndFade();
    const partyId = await party(db, "Walk-in", "walkin@example.com");
    const rows = Array.from({ length: 520 }, (_, n) => {
      const start = Date.parse(at("09:00")) + (n % 600) * 60_000;
      return {
        id: `day${String(n).padStart(6, "0")}`,
        type: "booking",
        state: "requested",
        version: 1,
        partyId,
        channel: "rest",
        payload: {
          reservationFor: { serviceId: fade.id, name: "Skin fade" },
          startTime: new Date(start).toISOString(),
          endTime: new Date(start + 30 * 60_000).toISOString(),
          resourceId: mei.id,
        },
        flags: {},
        createdAt: T0,
        updatedAt: T0,
      };
    });
    // A few rows at a time: D1 binds at most 100 values a statement.
    for (let i = 0; i < rows.length; i += 8) await db.orm.insert(items).values(rows.slice(i, i + 8) as never);
    const day = await caps.staffDay(owner, "2026-11-03");
    expect(day.columns.find((c) => c.staff?.id === mei.id)?.bookings.length).toBe(520);
  });

  it("places a time we proposed where it would be: at that time, with whoever it goes with", async () => {
    const s = await mapleAndFade();
    const ravi14 = await s.caps.createBooking(agent(), {
      payload: booking(s.fade.id, "Skin fade", at("14:00"), at("14:30")),
      staff_id: s.ravi.id,
      contact: { name: "ravi-14" },
      idempotency_key: "ravi-14",
    });
    await transitionItem(s.db, owner, { itemId: ravi14.view.item.id, event: "confirm" });
    const any = await s.caps.createBooking(agent(), {
      payload: booking(s.fade.id, "Skin fade", at("14:00"), at("14:30")),
      contact: { name: "Valentina", email: "valentina@example.com" },
      idempotency_key: "any-14",
    });
    // With Mei as asked; proposed at ten, when only Ravi works, it goes with him.
    await transitionItem(s.db, owner, {
      itemId: any.view.item.id,
      event: "propose",
      input: { startTime: at("10:00"), endTime: at("10:30") },
    });
    const day = await s.caps.staffDay(owner, "2026-11-03");
    const lane = (id: string) => day.columns.find((c) => c.staff?.id === id)?.bookings ?? [];
    expect(lane(s.mei.id).map((b) => b.id)).not.toContain(any.view.item.id);
    expect(lane(s.ravi.id).find((b) => b.id === any.view.item.id)).toMatchObject({
      start: at("10:00"),
      end: new Date(at("10:30")).toISOString(),
      state: "proposed",
    });
    // Proposed for another day, it is on that day.
    await transitionItem(s.db, owner, {
      itemId: any.view.item.id,
      event: "propose",
      input: { startTime: "2026-11-04T10:00:00-05:00", endTime: "2026-11-04T10:30:00-05:00" },
    });
    const today = await s.caps.staffDay(owner, "2026-11-03");
    expect(today.columns.flatMap((c) => c.bookings).map((b) => b.id)).not.toContain(any.view.item.id);
    const tomorrow = await s.caps.staffDay(owner, "2026-11-04");
    expect(tomorrow.columns.flatMap((c) => c.bookings).map((b) => b.id)).toContain(any.view.item.id);
  });
});

describe("emails", () => {
  it("tell the customer who it is with, what was added and the deposit, and the owner when and what to check", async () => {
    const { db, caps, fade, ravi } = await mapleAndFade();
    await caps.updateSettings(owner, {
      doc: {
        email: { fromAddress: "hello@mapleandfade.example" },
        notifications: { ownerEmail: "desk@mapleandfade.example" },
      },
    });
    await caps.setup.updateService(owner, {
      service_id: fade.id,
      deposit: { kind: "amount", value: 1500 },
      policy: {
        steps: [{ before: { hours: 24 }, fee: { kind: "none" } }],
        after: { kind: "none" },
        noShow: { kind: "full" },
        deposit: { refundable: false },
      },
    });
    const towel = (await caps.setup.listServices(owner)).find((s) => s.id === fade.id)?.addOns?.[0];
    const day = new Date(T0 + 3 * DAY).toISOString().slice(0, 10);
    const r = await caps.createBooking(agent(), {
      payload: booking(fade.id, "Skin fade", `${day}T16:00:00-05:00`, `${day}T16:30:00-05:00`),
      staff_id: ravi.id,
      add_ons: [towel?.id ?? ""],
      contact: { name: "Aiyana", email: "aiyana@example.com" },
      idempotency_key: "mail-1",
    });
    const runner = createRunner({ mailOut: logMailOut() });
    const drain = async () => {
      for (let i = 0; i < 10; i++)
        if ((await runner.runDue(db, { now: T0 + 3_600_000, limit: 100 })).claimed === 0) return;
    };
    await drain();
    await transitionItem(db, owner, { itemId: r.view.item.id, event: "confirm" });
    await drain();
    const mails = await db.client.query({
      sql: "SELECT recipient, template, body_text FROM outbound_mail WHERE item_id = ? ORDER BY created_at, id",
      params: [r.view.item.id],
      method: "all",
    });
    const body = (template: string) => String(mails.rows.find((m) => m[1] === template)?.[2] ?? "");
    for (const t of ["ack.booking", "booking.confirmed"]) {
      expect(body(t), t).toContain("With Ravi.");
      expect(body(t), t).toContain("Added: Hot towel.");
      expect(body(t), t).toContain("A deposit of CA$15.00 holds your booking.");
      expect(body(t), t).toContain("After that, the deposit is not refunded.");
    }
    // Paid: its confirmation says the right of withdrawal wins over those terms while it runs.
    await transitionItem(
      db,
      {
        actor: { kind: "connector", id: "connector:pay", channel: "connector" },
        tier: "verified_principal",
        sandbox: false,
        now: () => T0 + 3_600_000,
      },
      {
        itemId: r.view.item.id,
        event: "record_payment",
        input: { paymentRef: "pi_mail", amount: { value: 1500, currency: "CAD" } },
      },
    );
    await drain();
    const paidMails = await db.client.query({
      sql: "SELECT template, body_text FROM outbound_mail WHERE item_id = ? ORDER BY created_at, id",
      params: [r.view.item.id],
      method: "all",
    });
    const paidBody = paidMails.rows.map((m) => `${m[0]}: ${m[1]}`).join("\n");
    expect(paidBody).toContain(withdrawalCopy("en", "eu").paidBack);
    const ownerMail = body("owner.create");
    expect(ownerMail).toContain("With: Ravi");
    expect(ownerMail).toContain("16:00 (Toronto time)");
    expect(ownerMail).not.toContain("UTC");
    // For anyone: nobody named in the request, and whoever it went to once it is confirmed.
    const anyone = await caps.createBooking(agent(), {
      payload: booking(fade.id, "Skin fade", `${day}T17:00:00-05:00`, `${day}T17:30:00-05:00`),
      contact: { name: "Kwame", email: "kwame@example.com" },
      idempotency_key: "mail-any",
    });
    await drain();
    await transitionItem(db, owner, { itemId: anyone.view.item.id, event: "confirm" });
    await drain();
    const sent = await db.client.query({
      sql: "SELECT template, body_text FROM outbound_mail WHERE item_id = ? ORDER BY created_at, id",
      params: [anyone.view.item.id],
      method: "all",
    });
    const of = (template: string) => String(sent.rows.find((m) => m[0] === template)?.[1] ?? "");
    expect(of("ack.booking")).toContain("With whoever is free.");
    expect(of("ack.booking")).not.toContain("Ravi");
    expect(of("booking.confirmed")).toContain("With Ravi.");
  });

  it("tell the owner what to check first", async () => {
    const { db, caps, patch, colour } = await ifeBeauty();
    await caps.updateSettings(owner, {
      doc: { email: { fromAddress: "hello@ife.example" }, notifications: { ownerEmail: "desk@ife.example" } },
    });
    const r = await caps.createBooking(agent(), {
      payload: booking(colour.id, "Gele & colour", inLagos("14:00"), inLagos("15:30")),
      contact: { name: "Someone", email: "someone@example.com" },
      idempotency_key: "mail-check",
    });
    const runner = createRunner({ mailOut: logMailOut() });
    for (let i = 0; i < 10; i++) if ((await runner.runDue(db, { now: T0 + 60_000, limit: 100 })).claimed === 0) break;
    const { rows } = await db.client.query({
      sql: "SELECT body_text FROM outbound_mail WHERE item_id = ? AND recipient = 'owner'",
      params: [r.view.item.id],
      method: "all",
    });
    expect(String(rows[0]?.[0])).toContain(`Check first: ${patch.name}`);
    // And the booking says it beside its confirm.
    expect((await caps.getItem(owner, { item_id: r.view.item.id })).check_first).toMatch(
      /^Patch test, between 180 days.*then confirm\.$/,
    );
    // Once a person confirmed it, what to check before the visit, and nothing more to confirm.
    await transitionItem(db, owner, { itemId: r.view.item.id, event: "confirm" });
    const after = (await caps.getItem(owner, { item_id: r.view.item.id })).check_first;
    expect(after).toMatch(/^Patch test, between 180 days and 48 hours before: check this client has had it\.$/);
    expect(after).not.toContain("confirm");
  });
});

describe("what customers read", () => {
  it("never names the software, a network, receipts or anyone's records, in any language", () => {
    for (const lang of ["en", "es", "fr", "de", "it", "pt"]) {
      const w = staffWords(lang);
      const lines = [
        w.withStaff("Mei"),
        w.withAnyone,
        w.addOns("Blow-dry"),
        w.deposit("CA$20.00", "4 Nov, 18:00"),
        w.depositNow("₩10,500"),
        w.first("Colour", "Patch test", 180, 48),
        w.check("Colour", "Patch test", 180, 48),
        w.first("Treatment", "Consultation", 30, 0),
        w.cancelFee("₦5,000"),
        w.cancelFeeBack("₦5,000", "₦10,000"),
        w.cancelFree,
        w.anyone,
        // A deposit the policy keeps beside a fee, and the right of withdrawal over both.
        policySentence(
          {
            zone: "America/Toronto",
            steps: [
              { until: "2026-11-05T21:00:00.000Z", fee: { value: 0, currency: "CAD" } },
              { until: "2026-11-06T21:00:00.000Z", fee: { value: 1100, currency: "CAD" } },
            ],
            after: { value: 1100, currency: "CAD" },
            noShow: { value: 5500, currency: "CAD" },
          },
          {
            lang,
            total: { value: 5500, currency: "CAD" },
            depositKept: true,
            deposit: { value: 2750, currency: "CAD" },
          },
        ),
      ];
      expect(customerCopyProblems(lines, lang), lang).toEqual([]);
    }
    for (const lang of ["en", "pt"] as const) {
      expect(customerCopyProblems([withdrawalCopy(lang, "eu").paidBack], lang), lang).toEqual([]);
    }
    expect(customerCopyProblems([withdrawalCopy("en", "uk").paidBack], "en")).toEqual([]);
  });
});
