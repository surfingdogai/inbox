import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Capabilities } from "../src/capabilities/service";
import { serviceInput } from "../src/capabilities/setup-types";
import type { ConnectorDefinition, ConnectorHttp, OutboundBooking } from "../src/connectors/sdk";
import { createDb, type Db } from "../src/db";
import { customerCopyProblems } from "../src/i18n/customer-words";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, items, parties } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { bookingSchedules, cancelFeeOf, cleanPhoto, staffWords, stripJpegMetadata } from "../src/staff/index";
import { type Caller, transitionItem, WriteError } from "../src/write/index";
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

  it("books anyone with the first free, at their own length and price, and says who before it binds", async () => {
    const { db, caps, fade, mei, ravi } = await mapleAndFade();
    let summary = "";
    const first = await caps.createBooking(agent(), {
      payload: booking(fade.id, "Skin fade", at("12:00"), at("12:30")),
      contact: { name: "Aiyana", email: "aiyana@example.com" },
      idempotency_key: "maple-1",
    });
    const p1 = first.view.item.payload as Record<string, unknown>;
    expect(p1.resourceId).toBe(mei.id);
    expect(p1.staffName).toBe("Mei");
    // Mei's own length for a skin fade: the end follows it, whatever the request said.
    expect(Date.parse(String(p1.endTime))).toBe(Date.parse(at("12:45")));
    expect(p1.totalPrice).toEqual({ value: 4500, currency: "CAD" });
    await transitionItem(db, owner, { itemId: first.view.item.id, event: "confirm" });
    // The next for anyone at noon goes to Ravi, at his own price; the summary says so first.
    try {
      await new Capabilities(db).createBooking(agent(), {
        payload: booking(fade.id, "Skin fade", at("12:00"), at("12:30")),
        contact: { name: "Jean-Luc", email: "jl@example.com", locale: "fr-CA" },
        idempotency_key: "maple-2",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(WriteError);
      summary = String((error as WriteError).details?.summary ?? "");
    }
    // Who it is with is part of what the customer confirms, in the business's words.
    expect(summary).toContain("With Ravi.");
    const second = await caps.createBooking(agent(), {
      payload: booking(fade.id, "Skin fade", at("12:00"), at("12:30")),
      contact: { name: "Jean-Luc", email: "jl@example.com", locale: "fr-CA" },
      idempotency_key: "maple-2",
    });
    const p2 = second.view.item.payload as Record<string, unknown>;
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
    const who = (r: Awaited<ReturnType<typeof any>>) => (r.view.item.payload as { resourceId?: string }).resourceId;
    // Ana has a request at two already: the next for anyone goes to Bo.
    expect([who(first), who(second)]).toEqual([ana.id, bo.id]);
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
    expect([who(done as never), (done.view.item.payload as { staffName?: string }).staffName]).toEqual([bo.id, "Bo"]);
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
    // Booked for weeks before anyone gave it: held under the service's own places.
    const before = await s.caps.createBooking(agent(), {
      payload: booking(trim.id, "Trim", at("14:00"), at("14:30")),
      contact: { name: "Odette" },
      idempotency_key: "legacy-1",
    });
    await transitionItem(s.db, owner, { itemId: before.view.item.id, event: "confirm" });
    const ana = await s.caps.staff.create(owner, { name: "Ana Kowalski", services: [{ service_id: trim.id }] });
    const free = async (staffId?: string) =>
      (
        await s.caps.checkAvailability(
          { service_id: trim.id, from: at("13:00"), to: at("16:00"), ...(staffId ? { staff_id: staffId } : {}) },
          { now: T0, caller: agent() },
        )
      ).slots.map((x) => Date.parse(x.startTime));
    expect(await free(ana.id)).not.toContain(Date.parse(at("14:00")));
    expect(await free()).not.toContain(Date.parse(at("14:00")));
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
    const b64 = btoa(String.fromCharCode(...jpeg));
    const kept = cleanPhoto(`data:image/jpeg;base64,${b64}`);
    expect("photo" in kept && atob(kept.photo.split(",")[1] ?? "")).not.toContain("GPS");
    expect(cleanPhoto("data:image/png;base64,iVBORw0KGgo=")).toEqual({ problem: "not_jpeg" });
    expect(cleanPhoto(`data:image/jpeg;base64,${btoa("not a jpeg at all")}`)).toEqual({ problem: "not_jpeg" });
  });

  it("are the owner's: the owner's AI may tie them to services, never set their price", async () => {
    const { caps, fade, ravi } = await mapleAndFade();
    const ai: Caller = { ...owner, actor: { kind: "owner_ai", id: "ai", channel: "mcp_owner" } };
    await expect(
      caps.staff.update(ai, { staff_id: ravi.id, services: [{ service_id: fade.id, price_override: 3000 }] }),
    ).rejects.toMatchObject({ code: "not_allowed", details: { reason: "owner_money" } });
    const kept = await caps.staff.update(ai, { staff_id: ravi.id, services: [{ service_id: fade.id }] });
    expect(kept.services).toEqual([{ serviceId: fade.id, priceOverride: 5500, durationOverrideMin: null }]);
    await expect(
      caps.setup.updateService(ai, { service_id: fade.id, deposit: { kind: "percent", value: 20 } }),
    ).rejects.toMatchObject({ code: "not_allowed" });
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
    const accept = async () => {
      const sha = await caps.customer
        .acceptOffer(as, { item_id: r.view.item.id, idempotency_key: `a-${Math.random()}` })
        .catch((e: WriteError) => String(e.details?.terms_sha ?? ""));
      return caps.customer.acceptOffer(as, {
        item_id: r.view.item.id,
        terms_sha: String(sha),
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
    expect(await freeUntil()).toBe(Date.parse(`${day(19)}T16:00:00-05:00`));
    const [row] = await db.orm.select().from(items).where(eq(items.id, r.view.item.id));
    const moved = { id: r.view.item.id, payload: row?.payload as never };
    expect((await cancelFeeOf(moved, T0 + 15 * DAY, "en"))?.fee.value).toBe(0);
    expect((await cancelFeeOf(moved, T0 + 20 * DAY - 3_600_000, "en"))?.fee.value).toBe(2750);
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
    const ownerMail = body("owner.create");
    expect(ownerMail).toContain("With: Ravi");
    expect(ownerMail).toContain("16:00 (Toronto time)");
    expect(ownerMail).not.toContain("UTC");
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
      ];
      expect(customerCopyProblems(lines, lang), lang).toEqual([]);
    }
  });
});
