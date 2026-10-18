import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Capabilities } from "../src/capabilities/service";
import { safeReturnPath } from "../src/connectors/capability";
import {
  type ConnectorDefinition,
  ConnectorError,
  describeForm,
  field,
  type Interval,
  mergeIntervals,
  secretField,
  secretKeys,
  subtractIntervals,
} from "../src/connectors/sdk";
import { claimLink, writeBusy } from "../src/connectors/store";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import type { Caller } from "../src/write/index";
import { makeClient, openWeekdays, resetTables } from "./harness";

/**
 * The connector SDK and what the inbox does around it (ADR-020): the form from the schema, secrets
 * sealed, busy times that only ever remove times, and bookings written once however many runs meet.
 * A connector made here, in memory, stands in for a platform; the real ones have contract tests of
 * their own in @surfingdog/adapters.
 */
const T0 = Date.parse("2026-11-02T08:00:00Z"); // a Monday
const KEY = "connector-test-instance-key-0123456789";
const DAY = "2026-11-03"; // the Tuesday after

const owner = (t = T0): Caller => ({
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
});
const ownerAi = (t = T0): Caller => ({
  actor: { kind: "owner_ai", id: "owner-app", channel: "mcp_owner" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
});
const customer = (t = T0, sandbox = false): Caller => ({
  actor: { kind: "customer_human", id: "form", channel: "form" },
  tier: "anonymous",
  sandbox,
  now: () => t,
});

interface Memory {
  busy: Interval[];
  events: Map<string, { start: number; end: number; title: string }>;
  calls: string[];
  delayMs: number;
  failNext: string | null;
}

/** A platform in memory: what it is told to do, it does, slowly when asked, and remembers. */
function memoryConnector(mem: Memory): ConnectorDefinition {
  return {
    kind: "memcal",
    title: "Memory calendar",
    group: "calendars",
    capabilities: ["busy_times", "write_bookings"],
    auth: "form",
    form: z.object({
      email: field(z.string().min(3), { label: "Email", input: "email" }),
      token: secretField(z.string().min(3), { label: "App password" }),
      server: field(z.string().optional(), { label: "Server", advanced: true }),
    }),
    presets: [
      { id: "plain", label: "Plain", values: { server: "https://cal.example.com" } },
      { id: "needs", label: "Needs a server", values: {}, fields: { server: { required: true, label: "Address" } } },
    ],
    async connect(_ctx, input) {
      if (input.token !== "good-token")
        throw new ConnectorError("auth", "That password was not taken.", { field: "token" });
      return {
        account: input.email ?? "",
        externalId: `acct:${input.email}`,
        secret: { token: input.token ?? "" },
        calendars: [
          { id: "home", name: "Home", writable: true },
          { id: "work", name: "Work", writable: true },
        ],
        destinations: [
          { id: "home", name: "Home", writable: true },
          { id: "work", name: "Work", writable: true },
        ],
        defaults: { busy: ["home", "work"], destination: "home" },
      };
    },
    async busy(ctx, window) {
      mem.calls.push("busy");
      return mergeIntervals(subtractIntervals(mem.busy, ctx.own.spans), window);
    },
    bookings: {
      async put(ctx, b, link) {
        mem.calls.push(`put:${b.itemId}:${link ? "update" : "create"}`);
        if (mem.delayMs) await new Promise((r) => setTimeout(r, mem.delayMs));
        if (mem.failNext) {
          const message = mem.failNext;
          mem.failNext = null;
          throw new ConnectorError("refused", message);
        }
        mem.events.set(b.itemId, { start: b.start, end: b.end, title: b.title });
        return { externalId: `ev-${b.itemId}`, etag: null, calendar: ctx.destination ?? "home" };
      },
      async remove(_ctx, link) {
        mem.calls.push(`remove:${link.externalId}`);
        mem.events.delete(String(link.externalId).replace(/^ev-/, ""));
      },
    },
  };
}

const noHttp = {
  async request(): Promise<never> {
    throw new Error("no network in this test");
  },
};

async function setup(opts: { key?: string | null; capacity?: number } = {}) {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await openWeekdays(db);
  const svc = ulid(T0);
  await db.orm.insert(services).values({
    id: svc,
    name: "Haircut",
    durationMin: 60,
    capacity: opts.capacity ?? 1,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  const box = opts.key === null ? null : createSecretBox([opts.key ?? KEY]);
  const caps = new Capabilities(db, box, "https://inbox.salon.example", 0);
  const mem: Memory = { busy: [], events: new Map(), calls: [], delayMs: 0, failNext: null };
  caps.connectors.attach({ definitions: [memoryConnector(mem)], http: noHttp });
  return { db, caps, svc, mem };
}

const at = (hhmm: string, day = DAY) => Date.parse(`${day}T${hhmm}:00Z`);

async function connect(caps: Capabilities, t = T0) {
  return caps.connectors.connect(owner(t), {
    kind: "memcal",
    preset: "plain",
    values: { email: "ana@example.com", token: "good-token" },
  });
}

async function book(caps: Capabilities, svc: string, start: number, opts: { sandbox?: boolean; name?: string } = {}) {
  const r = await caps.createBooking(customer(T0, opts.sandbox ?? false), {
    payload: {
      reservationFor: { serviceId: svc, name: "Haircut" },
      startTime: new Date(start).toISOString(),
      endTime: new Date(start + 3_600_000).toISOString(),
    },
    contact: { name: opts.name ?? "Rita Amaral", email: "rita@example.com" },
  });
  return r.view.item.id;
}

async function slotsOn(caps: Capabilities, svc: string, day = DAY): Promise<string[]> {
  const r = await caps.checkAvailability(
    { service_id: svc, from: `${day}T00:00:00Z`, to: `${day}T23:59:00Z` },
    { now: T0 },
  );
  return r.slots.map((s) => s.startTime.slice(11, 16));
}

describe("the form a connector's schema draws", () => {
  const form = z.object({
    email: field(z.string(), { label: "Email", input: "email" }),
    password: secretField(z.string(), { label: "App password", help: "Not your usual one." }),
    server: field(z.string().optional(), { label: "Server", advanced: true }),
  });

  it("asks for every field, marks secrets, and knows what is optional", () => {
    const fields = describeForm(form);
    expect(fields.map((f) => [f.key, f.required, f.secret, f.input, f.advanced])).toEqual([
      ["email", true, false, "email", false],
      ["password", true, true, "password", false],
      ["server", false, false, "text", true],
    ]);
    expect(secretKeys(form)).toEqual(["password"]);
  });

  it("leaves out what a preset fills in and speaks in the preset's words", () => {
    const fields = describeForm(form, {
      id: "icloud",
      label: "iCloud",
      values: { server: "https://caldav.icloud.com" },
      fields: { password: { label: "App-specific password", link: { href: "https://x.example", text: "Make one" } } },
    });
    expect(fields.map((f) => f.key)).toEqual(["email", "password"]);
    expect(fields[1]).toMatchObject({ label: "App-specific password", secret: true, link: { text: "Make one" } });
  });
});

describe("intervals", () => {
  it("merges what overlaps and clips to the window", () => {
    expect(
      mergeIntervals(
        [
          { start: 50, end: 70 },
          { start: 10, end: 20 },
          { start: 15, end: 30 },
          { start: 30, end: 40 },
          { start: 90, end: 90 },
        ],
        { start: 0, end: 60 },
      ),
    ).toEqual([
      { start: 10, end: 40 },
      { start: 50, end: 60 },
    ]);
  });

  it("takes the inbox's own bookings out of busy times by their spans", () => {
    expect(
      subtractIntervals(
        [{ start: 0, end: 100 }],
        [
          { start: 20, end: 40 },
          { start: 90, end: 120 },
        ],
      ),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 40, end: 90 },
    ]);
    expect(subtractIntervals([{ start: 0, end: 10 }], [{ start: 0, end: 10 }])).toEqual([]);
  });
});

describe("connecting", () => {
  it("checks the credentials, seals the secret, and never shows it again", async () => {
    const { db, caps } = await setup();
    const view = await connect(caps);
    expect(view).toMatchObject({
      kind: "memcal",
      preset: "plain",
      title: "Plain",
      account: "ana@example.com",
      status: "configured",
      busy_calendars: ["home", "work"],
      destination: "home",
      busy_on: true,
      bookings_on: true,
    });
    const everything = JSON.stringify(await caps.connectors.integrations(owner()));
    expect(everything).not.toContain("good-token");
    const { rows } = await db.client.query({ sql: "SELECT config_enc, config_public FROM connectors", method: "all" });
    expect(String(rows[0]?.[0])).toMatch(/^v1\./);
    expect(String(rows[0]?.[0])).not.toContain("good-token");
    expect(String(rows[0]?.[1])).not.toContain("good-token");
    // The first sync is queued at once.
    const jobs = await db.client.query({ sql: "SELECT kind FROM jobs WHERE kind = 'connector_sync'", method: "all" });
    expect(jobs.rows.length).toBe(1);
  });

  it("says which field is wrong when the platform refuses, and keeps nothing", async () => {
    const { db, caps } = await setup();
    await expect(
      caps.connectors.connect(owner(), { kind: "memcal", values: { email: "ana@example.com", token: "nope" } }),
    ).rejects.toMatchObject({ code: "invalid_input", fields: [{ path: "values.token" }] });
    const { rows } = await db.client.query({ sql: "SELECT COUNT(*) FROM connectors", method: "all" });
    expect(Number(rows[0]?.[0])).toBe(0);
  });

  it("asks for what a preset needs by name", async () => {
    const { caps } = await setup();
    await expect(
      caps.connectors.connect(owner(), {
        kind: "memcal",
        preset: "needs",
        values: { email: "ana@example.com", token: "good-token" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input", fields: [{ path: "values.server", problem: "missing" }] });
  });

  it("refuses without INBOX_SECRET_KEY, from the owner's AI, and the same account twice", async () => {
    const none = await setup({ key: null });
    await expect(connect(none.caps)).rejects.toMatchObject({ code: "not_allowed" });
    const { caps } = await setup();
    await expect(
      caps.connectors.connect(ownerAi(), { kind: "memcal", values: { email: "a@example.com", token: "good-token" } }),
    ).rejects.toMatchObject({ code: "not_allowed", details: { reason: "owner_credentials" } });
    await connect(caps);
    await expect(connect(caps)).rejects.toMatchObject({ code: "wrong_state" });
    await expect(
      caps.connectors.connect(customer(), { kind: "memcal", values: { email: "a@example.com", token: "good-token" } }),
    ).rejects.toMatchObject({ code: "not_allowed" });
  });

  it("keeps no hash of a secret for a retry", async () => {
    const { caps } = await setup();
    const kept = caps.connectors.withoutSecrets({
      kind: "memcal",
      values: { email: "ana@example.com", token: "good-token" },
    });
    expect(JSON.stringify(kept)).not.toContain("good-token");
    expect(kept.values).toEqual({ email: "ana@example.com" });
  });

  it("says which ways are ready and which are soon, with nothing to press for those", async () => {
    const { caps } = await setup();
    const { cards } = await caps.connectors.integrations(owner());
    const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
    expect(byId.stripe).toMatchObject({ status: "soon", ways: [{ status: "soon", form: [] }] });
    expect(byId.shopify?.status).toBe("soon");
    // This test registers no Cal.com, CalDAV or Google: every card says soon.
    expect(cards.every((c) => c.status === "soon")).toBe(true);
  });
});

describe("busy times only remove times", () => {
  it("takes a busy hour off the free times, and back when it is gone", async () => {
    const { caps, svc, mem } = await setup();
    const view = await connect(caps);
    expect(await slotsOn(caps, svc)).toContain("10:00");
    mem.busy = [{ start: at("10:00"), end: at("11:00") }];
    await caps.connectors.run(view.id, T0, "sync");
    const free = await slotsOn(caps, svc);
    // A 60-minute service on a 30-minute grid: 09:30 and 10:30 would overlap the busy hour too.
    expect(free).not.toContain("09:30");
    expect(free).not.toContain("10:00");
    expect(free).not.toContain("10:30");
    expect(free).toContain("09:00");
    expect(free).toContain("11:00");
    mem.busy = [];
    await caps.connectors.run(view.id, T0 + 60_000, "sync");
    expect(await slotsOn(caps, svc)).toContain("10:00");
  });

  it("refuses to confirm a time a calendar says is busy, and says why", async () => {
    const { caps, svc, mem } = await setup();
    const view = await connect(caps);
    const item = await book(caps, svc, at("14:00"));
    mem.busy = [{ start: at("14:15"), end: at("14:45") }];
    await caps.connectors.run(view.id, T0, "sync");
    await expect(caps.transitionItem(owner(), { item_id: item, event: "confirm" })).rejects.toMatchObject({
      code: "slot_taken",
      message: "that time is busy in a calendar you connected",
    });
  });

  it("never moves or cancels a booking already confirmed", async () => {
    const { db, caps, svc, mem } = await setup();
    const view = await connect(caps);
    const item = await book(caps, svc, at("15:00"));
    await caps.transitionItem(owner(), { item_id: item, event: "confirm" });
    mem.busy = [{ start: at("15:00"), end: at("16:00") }];
    await caps.connectors.run(view.id, T0, "sync");
    const { rows } = await db.client.query({
      sql: "SELECT state FROM items WHERE id = ?",
      params: [item],
      method: "all",
    });
    expect(rows[0]?.[0]).toBe("confirmed");
  });

  it("blocks every place of a service with room for several", async () => {
    const { caps, svc, mem } = await setup({ capacity: 3 });
    const view = await connect(caps);
    mem.busy = [{ start: at("12:00"), end: at("13:00") }];
    await caps.connectors.run(view.id, T0, "sync");
    expect(await slotsOn(caps, svc)).not.toContain("12:00");
  });

  it("applies only to the services the owner chose, and not at all once paused or switched off", async () => {
    const { db, caps, svc, mem } = await setup();
    const other = ulid(T0 + 1);
    await db.orm.insert(services).values({
      id: other,
      name: "Colour",
      durationMin: 60,
      capacity: 1,
      granularityMin: 30,
      createdAt: T0,
      updatedAt: T0,
    });
    const view = await connect(caps);
    mem.busy = [{ start: at("10:00"), end: at("11:00") }];
    await caps.connectors.run(view.id, T0, "sync");
    await caps.connectors.update(owner(), view.id, { services: [other] });
    expect(await slotsOn(caps, svc)).toContain("10:00");
    expect(await slotsOn(caps, other)).not.toContain("10:00");
    await caps.connectors.update(owner(), view.id, { services: null, paused: true });
    expect(await slotsOn(caps, svc)).toContain("10:00");
    await caps.connectors.update(owner(), view.id, { paused: false });
    await caps.connectors.run(view.id, T0 + 1000, "sync");
    expect(await slotsOn(caps, svc)).not.toContain("10:00");
    await caps.connectors.update(owner(), view.id, { busy_on: false });
    expect(await slotsOn(caps, svc)).toContain("10:00");
  });

  it("keeps the newer read when two syncs finish out of order", async () => {
    const { db, caps } = await setup();
    const view = await connect(caps);
    const newer = await writeBusy(db, view.id, [{ start: at("09:00"), end: at("10:00") }], T0 + 10_000);
    const older = await writeBusy(db, view.id, [{ start: at("16:00"), end: at("17:00") }], T0);
    expect(newer.current).toBe(true);
    expect(older.current).toBe(false);
    const { rows } = await db.client.query({
      sql: "SELECT start_ms FROM connector_busy WHERE connector_id = ?",
      params: [view.id],
      method: "all",
    });
    expect(rows.map((r) => Number(r[0]))).toEqual([at("09:00")]);
  });

  it("stops at once on disconnect, and leaves what it wrote in the calendar", async () => {
    const { db, caps, svc, mem } = await setup();
    const view = await connect(caps);
    const item = await book(caps, svc, at("11:00"));
    await caps.transitionItem(owner(), { item_id: item, event: "confirm" });
    mem.busy = [{ start: at("16:00"), end: at("17:00") }];
    await caps.connectors.run(view.id, T0, "sync");
    expect(mem.events.size).toBe(1);
    await expect(caps.connectors.remove(ownerAi(), view.id)).rejects.toMatchObject({ code: "not_allowed" });
    await expect(caps.connectors.update(ownerAi(), view.id, { paused: true })).rejects.toMatchObject({
      code: "not_allowed",
    });
    expect(await caps.connectors.syncNow(ownerAi(), view.id)).toMatchObject({ queued: true });
    const r = await caps.connectors.remove(owner(), view.id);
    expect(r).toEqual({ removed: true, left_in_calendar: 1 });
    expect(mem.events.size).toBe(1);
    expect(await slotsOn(caps, svc)).toContain("16:00");
    for (const t of ["connectors", "connector_busy", "connector_links"]) {
      const { rows } = await db.client.query({ sql: `SELECT COUNT(*) FROM ${t}`, method: "all" });
      expect(Number(rows[0]?.[0]), t).toBe(0);
    }
  });
});

describe("bookings kept in step", () => {
  it("writes a confirmed booking once, moves it, and takes it off when it is cancelled", async () => {
    const { db, caps, svc, mem } = await setup();
    const view = await connect(caps);
    const item = await book(caps, svc, at("09:00"));
    await caps.connectors.run(view.id, T0, "push");
    expect(mem.calls.filter((c) => c.startsWith("put"))).toEqual([]);
    await caps.transitionItem(owner(), { item_id: item, event: "confirm" });
    await caps.connectors.run(view.id, T0 + 1_000, "push");
    expect(mem.events.get(item)).toEqual({ start: at("09:00"), end: at("10:00"), title: "Haircut · Rita Amaral" });
    // Nothing changed: no call.
    await caps.connectors.run(view.id, T0 + 2_000, "push");
    expect(mem.calls.filter((c) => c.startsWith("put"))).toEqual([`put:${item}:create`]);
    // Moved, by whichever door: written again.
    await db.client.query({
      sql: `UPDATE items SET payload = json_set(payload, '$.startTime', ?, '$.endTime', ?), version = version + 1, updated_at = ? WHERE id = ?`,
      params: [new Date(at("13:00")).toISOString(), new Date(at("14:00")).toISOString(), T0 + 3_000, item],
      method: "run",
    });
    await caps.connectors.run(view.id, T0 + 4_000, "push");
    expect(mem.events.get(item)?.start).toBe(at("13:00"));
    expect(mem.calls.filter((c) => c.startsWith("put"))).toEqual([`put:${item}:create`, `put:${item}:update`]);
    await caps.transitionItem(owner(T0 + 5_000), { item_id: item, event: "cancel_by_business" });
    await caps.connectors.run(view.id, T0 + 6_000, "push");
    expect(mem.events.has(item)).toBe(false);
    expect(mem.calls).toContain(`remove:ev-${item}`);
    const v = await caps.connectors.get(owner(), view.id);
    expect(v.bookings_written).toBe(0);
  });

  it("writes it once when two runs meet", async () => {
    const { caps, svc, mem } = await setup();
    const view = await connect(caps);
    const item = await book(caps, svc, at("09:00"));
    await caps.transitionItem(owner(), { item_id: item, event: "confirm" });
    mem.delayMs = 30;
    await Promise.all([
      caps.connectors.run(view.id, T0 + 1_000, "push"),
      caps.connectors.run(view.id, T0 + 1_000, "sync"),
      caps.connectors.run(view.id, T0 + 1_001, "push"),
    ]);
    expect(mem.calls.filter((c) => c.startsWith("put"))).toEqual([`put:${item}:create`]);
    expect(mem.events.size).toBe(1);
  });

  it("lets only one job hold a booking at a time", async () => {
    const { db, caps, svc } = await setup();
    const view = await connect(caps);
    const item = await book(caps, svc, at("09:00"));
    const [a, b] = await Promise.all([claimLink(db, view.id, item, T0), claimLink(db, view.id, item, T0)]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect(await claimLink(db, view.id, item, T0 + 10_000)).toBeNull();
    // A claim that lapsed (its job stopped) is taken by the next.
    expect(await claimLink(db, view.id, item, T0 + 120_000)).not.toBeNull();
  });

  it("never writes a test booking, and leaves the customer's name out once they are erased", async () => {
    const { db, caps, svc, mem } = await setup();
    const view = await connect(caps);
    const test = await book(caps, svc, at("09:00"), { sandbox: true });
    await caps.transitionItem({ ...owner(), sandbox: true }, { item_id: test, event: "confirm" });
    const real = await book(caps, svc, at("11:00"), { name: "Joana Reis" });
    await caps.transitionItem(owner(), { item_id: real, event: "confirm" });
    await caps.connectors.run(view.id, T0 + 1_000, "push");
    expect(mem.events.has(test)).toBe(false);
    expect(mem.events.get(real)?.title).toBe("Haircut · Joana Reis");
    await db.client.query({
      sql: "UPDATE parties SET erased_at = ?, updated_at = ? WHERE id = (SELECT party_id FROM items WHERE id = ?)",
      params: [T0 + 2_000, T0 + 2_000, real],
      method: "run",
    });
    await caps.connectors.run(view.id, T0 + 3_000, "push");
    expect(mem.events.get(real)?.title).toBe("Haircut");
  });

  it("writes the bookings already confirmed when a calendar is first connected", async () => {
    const { caps, svc, mem } = await setup();
    const item = await book(caps, svc, at("09:00"));
    await caps.transitionItem(owner(), { item_id: item, event: "confirm" });
    const view = await connect(caps);
    await caps.connectors.run(view.id, T0 + 1_000, "sync");
    expect(mem.events.has(item)).toBe(true);
  });

  it("says what failed, tries again later, and leaves the owner's own events out of busy times", async () => {
    const { caps, svc, mem } = await setup({ capacity: 2 });
    const view = await connect(caps);
    const item = await book(caps, svc, at("09:00"));
    await caps.transitionItem(owner(), { item_id: item, event: "confirm" });
    mem.failNext = "That calendar is read-only.";
    await caps.connectors.run(view.id, T0 + 1_000, "push");
    let v = await caps.connectors.get(owner(), view.id);
    expect(v).toMatchObject({ bookings_failing: 1, booking_error: "That calendar is read-only." });
    // Not before its retry is due.
    await caps.connectors.run(view.id, T0 + 2_000, "push");
    expect(mem.events.has(item)).toBe(false);
    await caps.connectors.run(view.id, T0 + 5 * 60_000, "sync");
    v = await caps.connectors.get(owner(), view.id);
    expect(v).toMatchObject({ bookings_failing: 0, bookings_written: 1, booking_error: null, status: "active" });
    // The platform now says 09:00-10:00 is busy: it is this booking, so the second place stays free.
    mem.busy = [{ start: at("09:00"), end: at("10:00") }];
    await caps.connectors.run(view.id, T0 + 6 * 60_000, "sync");
    expect(await slotsOn(caps, svc)).toContain("09:00");
  });

  it("says the platform's own words when a sync fails, and keeps the last busy times", async () => {
    const { caps, svc, mem } = await setup();
    const def = memoryConnector(mem);
    caps.connectors.attach({
      definitions: [
        {
          ...def,
          async busy() {
            throw new ConnectorError("auth", "The calendar stopped taking that password. Connect it again.");
          },
        },
      ],
      http: noHttp,
    });
    const view = await connect(caps);
    await caps.connectors.run(view.id, T0, "sync");
    const v = await caps.connectors.get(owner(), view.id);
    expect(v).toMatchObject({
      status: "error",
      last_error: "The calendar stopped taking that password. Connect it again.",
    });
    expect(await slotsOn(caps, svc)).toContain("10:00");
  });
});

describe("signing in on a platform", () => {
  it("only comes back to a path in the owner app", () => {
    expect(safeReturnPath("/settings/integrations")).toBe("/settings/integrations");
    expect(safeReturnPath("//evil.example/x")).toBe("/settings/integrations");
    expect(safeReturnPath("https://evil.example")).toBe("/settings/integrations");
    expect(safeReturnPath("/\\evil")).toBe("/settings/integrations");
    expect(safeReturnPath(undefined)).toBe("/settings/integrations");
  });

  it("uses a state once, within ten minutes, for the platform it was made for", async () => {
    const { caps, mem } = await setup();
    const exchanged: string[] = [];
    caps.connectors.attach({
      definitions: [
        {
          ...memoryConnector(mem),
          kind: "oauthcal",
          auth: "oauth",
          form: undefined,
          oauth: {
            authorizeUrl: ({ redirectUri, state, challenge }) =>
              `https://accounts.example.com/auth?${new URLSearchParams({ redirect_uri: redirectUri, state, code_challenge: challenge })}`,
            async exchange(_ctx, p) {
              exchanged.push(`${p.code}:${p.verifier.length}:${p.redirectUri}`);
              return {
                account: "ana@example.com",
                externalId: "ana@example.com",
                secret: { refresh_token: "rt" },
                calendars: [{ id: "primary", name: "ana@example.com", writable: true }],
                destinations: [{ id: "primary", name: "ana@example.com", writable: true }],
                defaults: { busy: ["primary"], destination: "primary" },
              };
            },
          },
        },
      ],
      http: noHttp,
    });
    const { authorize_url } = await caps.connectors.authorize(
      owner(),
      { kind: "oauthcal", return_to: "/settings/integrations" },
      "https://inbox.salon.example",
    );
    const url = new URL(authorize_url);
    const state = url.searchParams.get("state") ?? "";
    expect(url.searchParams.get("redirect_uri")).toBe("https://inbox.salon.example/oauth/connect/oauthcal/callback");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const wrong = await caps.connectors.finishAuthorization({ kind: "memcal", state, code: "c", now: T0 + 1 });
    expect(wrong.ok).toBe(false);
    const ok = await caps.connectors.finishAuthorization({ kind: "oauthcal", state, code: "c1", now: T0 + 2 });
    expect(ok).toMatchObject({ ok: true, returnTo: "/settings/integrations" });
    expect(exchanged).toEqual(["c1:64:https://inbox.salon.example/oauth/connect/oauthcal/callback"]);
    const again = await caps.connectors.finishAuthorization({ kind: "oauthcal", state, code: "c1", now: T0 + 3 });
    expect(again.ok).toBe(false);

    const late = await caps.connectors.authorize(owner(), { kind: "oauthcal" }, "https://inbox.salon.example");
    const lateState = new URL(late.authorize_url).searchParams.get("state") ?? "";
    const lapsed = await caps.connectors.finishAuthorization({
      kind: "oauthcal",
      state: lateState,
      code: "c2",
      now: T0 + 11 * 60_000,
    });
    expect(lapsed).toMatchObject({ ok: false, message: "That sign-in had expired or was used already. Try again." });

    const denied = await caps.connectors.authorize(owner(), { kind: "oauthcal" }, "https://inbox.salon.example");
    const deniedState = new URL(denied.authorize_url).searchParams.get("state") ?? "";
    const no = await caps.connectors.finishAuthorization({
      kind: "oauthcal",
      state: deniedState,
      error: "access_denied",
      now: T0 + 5,
    });
    expect(no).toMatchObject({ ok: false, message: "Nothing was connected: access was not allowed." });
    expect(exchanged).toHaveLength(1);
    await expect(caps.connectors.authorize(ownerAi(), { kind: "oauthcal" }, "https://x.example")).rejects.toMatchObject(
      {
        code: "not_allowed",
      },
    );
  });

  it("names the inbox in the state when every inbox shares one redirect address", async () => {
    const { caps, mem } = await setup();
    caps.connectors.attach({
      definitions: [
        {
          ...memoryConnector(mem),
          kind: "oauthcal",
          auth: "oauth",
          form: undefined,
          oauth: {
            authorizeUrl: ({ redirectUri, state }) =>
              `https://accounts.example.com/auth?${new URLSearchParams({ redirect_uri: redirectUri, state })}`,
            exchange: async () => {
              throw new ConnectorError("refused", "no");
            },
          },
        },
      ],
      http: noHttp,
      redirectUri: () => "https://connect.example.net/oauth/google/callback",
    });
    const { authorize_url } = await caps.connectors.authorize(
      owner(),
      { kind: "oauthcal" },
      "https://inbox.salon.example",
    );
    const url = new URL(authorize_url);
    expect(url.searchParams.get("redirect_uri")).toBe("https://connect.example.net/oauth/google/callback");
    const [origin] = (url.searchParams.get("state") ?? "").split(".");
    expect(atob((origin ?? "").replaceAll("-", "+").replaceAll("_", "/"))).toBe("https://inbox.salon.example");
  });
});
