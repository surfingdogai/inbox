import { logMailOut, runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Capabilities } from "../src/capabilities/service";
import { CONNECTOR_SYNC_INTERVAL_MS, safeReturnPath } from "../src/connectors/capability";
import { connectorNoticeHandler, connectorSyncHandler } from "../src/connectors/jobs";
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
import {
  BUSY_HORIZON_MS,
  busyOverlapping,
  claimLink,
  dueRetries,
  instanceId,
  readLink,
  settleLink,
  writeBusy,
} from "../src/connectors/store";
import type { Db } from "../src/db";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import type { Caller } from "../src/write/index";
import { makeClient, openWeekdays, resetTables } from "./harness";

/**
 * The connector SDK and what the inbox does around it (ADR-022): the form from the schema, secrets
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
/** A key the owner handed to another system (Zapier, n8n) that holds `integrations:write`. */
const integrationKey = (t = T0): Caller => ({
  actor: { kind: "integration", id: "key_1", channel: "rest" },
  actsAs: "owner",
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
  principal: {
    via: "api_key",
    id: "key_1",
    name: "Zapier",
    scopes: ["integrations:write"],
    userId: null,
    keyKind: "integration",
  },
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
  /** The inbox ids and markers runs were given. */
  seen: { inbox: string; marker: string }[];
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
      mem.seen.push({ inbox: ctx.inbox.id, marker: ctx.marker });
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
      // As a platform that chooses its own ids would: the event it made, found again.
      async find(_ctx, b) {
        mem.calls.push(`find:${b.itemId}`);
        return mem.events.has(b.itemId) ? { externalId: `ev-${b.itemId}`, etag: null, calendar: "home" } : null;
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
  const mem: Memory = { busy: [], events: new Map(), calls: [], delayMs: 0, failNext: null, seen: [] };
  caps.connectors.attach({ definitions: [memoryConnector(mem)], http: noHttp });
  return { db, caps, svc, mem };
}

const at = (hhmm: string, day = DAY) => Date.parse(`${day}T${hhmm}:00Z`);

async function connect(caps: Capabilities, t = T0, email = "ana@example.com") {
  return caps.connectors.connect(owner(t), {
    kind: "memcal",
    preset: "plain",
    values: { email, token: "good-token" },
  });
}

/** Copies of a confirmed booking, an hour apart from `first`: many bookings without as many requests. */
async function cloneBookings(db: Db, itemId: string, n: number, first: number): Promise<string[]> {
  const { rows } = await db.client.query({ sql: "PRAGMA table_info(items)", method: "all" });
  const cols = rows.map((r) => String(r[1]));
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = ulid(T0 + 10 + i);
    const start = first + i * 3_600_000;
    const pick = cols.map((c) =>
      c === "id"
        ? "?"
        : c === "payload"
          ? "json_set(payload, '$.startTime', ?, '$.endTime', ?)"
          : c === "start_at"
            ? "?"
            : c === "end_at"
              ? "?"
              : c === "access_token_hash"
                ? "NULL"
                : c,
    );
    const params: (string | number)[] = [];
    for (const c of cols) {
      if (c === "id") params.push(id);
      else if (c === "payload") params.push(new Date(start).toISOString(), new Date(start + 3_600_000).toISOString());
      else if (c === "start_at") params.push(Math.floor(start / 1000));
      else if (c === "end_at") params.push(Math.floor((start + 3_600_000) / 1000));
    }
    await db.client.query({
      sql: `INSERT INTO items (${cols.join(", ")}) SELECT ${pick.join(", ")} FROM items WHERE id = ?`,
      params: [...params, itemId],
      method: "run",
    });
    ids.push(id);
  }
  return ids;
}

/** A database whose final busy-times batch waits until let go: two syncs made to meet. */
function gatedDb(db: Db): { db: Db; held: Promise<void>; release: () => void } {
  let release = () => {};
  let arrived = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const held = new Promise<void>((r) => {
    arrived = r;
  });
  const wrapped: Db = {
    orm: db.orm,
    client: db.client,
    async batch(stmts) {
      if (stmts.some((st) => st.sql.includes("UPDATE connectors SET busy_gen"))) {
        arrived();
        await gate;
      }
      return db.batch(stmts);
    },
  };
  return { db: wrapped, held, release };
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
      // The calendar is named, so the owner knows where to free the time.
      message: "that time is busy in your Plain calendar",
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
    expect(await claimLink(db, view.id, item, T0 + 121_000)).not.toBeNull();
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
    expect(safeReturnPath("/settings/integrations?x=1")).toBe("/settings/integrations?x=1");
    expect(safeReturnPath("//evil.example/x")).toBe("/settings/integrations");
    // What a browser reads as another site once the dots are worked out.
    expect(safeReturnPath("/.//evil.example/x")).toBe("/settings/integrations");
    expect(safeReturnPath("/a/..//evil.example/x")).toBe("/settings/integrations");
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

describe("only the owner, in person, connects, changes or disconnects", () => {
  it("lets a key handed to another system list and sync, and nothing more", async () => {
    const { caps } = await setup();
    const view = await connect(caps);
    const key = integrationKey();
    await expect(
      caps.connectors.connect(key, { kind: "memcal", values: { email: "b@example.com", token: "good-token" } }),
    ).rejects.toMatchObject({ code: "not_allowed", details: { reason: "owner_credentials" } });
    // Switching busy times off would let customers book over the owner's day.
    await expect(caps.connectors.update(key, view.id, { busy_on: false })).rejects.toMatchObject({
      code: "not_allowed",
    });
    await expect(caps.connectors.update(key, view.id, { paused: true })).rejects.toMatchObject({ code: "not_allowed" });
    await expect(caps.connectors.remove(key, view.id)).rejects.toMatchObject({ code: "not_allowed" });
    await expect(caps.connectors.authorize(key, { kind: "memcal" }, "https://x.example")).rejects.toMatchObject({
      code: "not_allowed",
    });
    // Its refusal is not the one that asks the AI to draft for the owner.
    const refused = await caps.connectors.remove(key, view.id).catch((e: unknown) => e);
    expect((refused as { details?: Record<string, unknown> }).details?.draft_for_owner).toBeUndefined();
    expect((await caps.connectors.list(key)).map((c) => c.id)).toEqual([view.id]);
    expect(await caps.connectors.syncNow(key, view.id)).toMatchObject({ queued: true });
    expect((await caps.connectors.get(owner(), view.id)).busy_on).toBe(true);
  });
});

describe("busy times when syncs meet", () => {
  it("never loses the newer sync's times to an older one finishing while it writes", async () => {
    const { db, caps, svc } = await setup();
    const view = await connect(caps);
    // The newer sync has written its rows and waits to finalize; the older one finishes meanwhile.
    const gated = gatedDb(db);
    const newer = writeBusy(gated.db, view.id, [{ start: at("09:00"), end: at("10:00") }], T0 + 10_000);
    await gated.held;
    const older = await writeBusy(db, view.id, [{ start: at("16:00"), end: at("17:00") }], T0);
    expect(older.current).toBe(true);
    gated.release();
    expect((await newer).current).toBe(true);
    // What readers see is the newer read, whole.
    expect(await busyOverlapping(db, at("00:00"), at("23:59"), `service:${svc}`)).toEqual([
      { start: at("09:00"), end: at("10:00") },
    ]);
    const { rows } = await db.client.query({
      sql: "SELECT COUNT(DISTINCT gen) FROM connector_busy WHERE connector_id = ?",
      params: [view.id],
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBe(1);
  });

  it("never brings busy times back that the owner switched off while a sync was reading", async () => {
    const { db, caps, svc, mem } = await setup();
    const view = await connect(caps);
    const gated = gatedDb(db);
    const late = writeBusy(gated.db, view.id, [{ start: at("10:00"), end: at("11:00") }], T0 + 5_000);
    await gated.held;
    await caps.connectors.update(owner(), view.id, { busy_on: false });
    gated.release();
    expect((await late).current).toBe(false);
    expect(await slotsOn(caps, svc)).toContain("10:00");
    const { rows } = await db.client.query({
      sql: "SELECT COUNT(*) FROM connector_busy WHERE connector_id = ?",
      params: [view.id],
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBe(0);
    // And the next sync, with busy times still off, reads none.
    mem.busy = [{ start: at("10:00"), end: at("11:00") }];
    await caps.connectors.run(view.id, T0 + 60_000, "sync");
    expect(await slotsOn(caps, svc)).toContain("10:00");
    expect(mem.calls).not.toContain("busy");
  });
});

describe("how far ahead a calendar is read", () => {
  it("offers nothing past it, and blocks what it read far ahead", async () => {
    const { caps, svc, mem } = await setup();
    const inside = "2027-01-12"; // a Tuesday, 71 days out: read
    const beyond = "2027-02-16"; // a Tuesday, 106 days out: past the 92 days read
    expect(BUSY_HORIZON_MS).toBe(92 * 86_400_000);
    expect(await slotsOn(caps, svc, beyond)).toContain("10:00");
    const view = await connect(caps);
    // Connected but not read yet: nothing is known, nothing is closed on that account.
    expect(await slotsOn(caps, svc, beyond)).toContain("10:00");
    mem.busy = [{ start: at("10:00", inside), end: at("11:00", inside) }];
    await caps.connectors.run(view.id, T0, "sync");
    expect(await slotsOn(caps, svc, inside)).not.toContain("10:00");
    expect(await slotsOn(caps, svc, inside)).toContain("14:00");
    expect(await slotsOn(caps, svc, beyond)).toEqual([]);
    const v = await caps.connectors.get(owner(), view.id);
    expect(v.busy_until).toBe(T0 + BUSY_HORIZON_MS);
  });

  it("tells the owner why a time past it cannot be confirmed", async () => {
    const { caps, svc } = await setup();
    const item = await book(caps, svc, at("10:00", "2027-02-16"));
    const view = await connect(caps);
    await caps.connectors.run(view.id, T0, "sync");
    await expect(caps.transitionItem(owner(), { item_id: item, event: "confirm" })).rejects.toMatchObject({
      code: "slot_taken",
      message: "your Plain calendar is read only 92 days ahead, and that time is further",
    });
  });

  it("closes what it could not read when a calendar has more busy times than are kept", async () => {
    const { caps, svc, mem } = await setup();
    const view = await connect(caps);
    // Every half hour for three months, apart: more than the 2,000 kept.
    mem.busy = Array.from({ length: 2_400 }, (_, i) => ({
      start: T0 + i * 3_600_000,
      end: T0 + i * 3_600_000 + 1_800_000,
    }));
    const report = await caps.connectors.run(view.id, T0, "sync");
    expect(report?.note).toContain("read only part of the way ahead");
    const v = await caps.connectors.get(owner(), view.id);
    expect(v.busy_until).toBe(T0 + 2_000 * 3_600_000);
    const far = new Date(T0 + 2_100 * 3_600_000).toISOString().slice(0, 10);
    expect(await slotsOn(caps, svc, far)).toEqual([]);
  });

  it("counts the busy times still ahead, not the ones already past", async () => {
    const { caps, mem } = await setup();
    const view = await connect(caps);
    mem.busy = [
      { start: T0 - 30 * 60_000, end: T0 - 10 * 60_000 },
      { start: at("10:00"), end: at("11:00") },
    ];
    await caps.connectors.run(view.id, T0, "sync");
    expect((await caps.connectors.get(owner(), view.id)).busy_times).toBe(1);
  });
});

describe("bookings written once, whatever happens to the runs", () => {
  it("writes every booking already confirmed, however many, each once", async () => {
    const { db, caps, svc, mem } = await setup();
    const first = await book(caps, svc, at("09:00"));
    await caps.transitionItem(owner(), { item_id: first, event: "confirm" });
    await cloneBookings(db, first, 229, at("09:00", "2026-11-10"));
    const view = await connect(caps);
    let t = T0 + 1_000;
    for (let i = 0; i < 20 && mem.events.size < 230; i++) {
      await caps.connectors.run(view.id, t, "push");
      t += 1_000;
    }
    expect(mem.events.size).toBe(230);
    expect(mem.calls.filter((c) => c.startsWith("put")).length).toBe(230);
  });

  it("works through more changes than a page holds, even when they share one moment", async () => {
    const { db, caps, svc, mem } = await setup();
    const first = await book(caps, svc, at("09:00"));
    await caps.transitionItem(owner(), { item_id: first, event: "confirm" });
    const ids = [first, ...(await cloneBookings(db, first, 229, at("09:00", "2026-11-10")))];
    const view = await connect(caps);
    let t = T0 + 1_000;
    for (let i = 0; i < 20 && mem.events.size < 230; i++) {
      await caps.connectors.run(view.id, t, "push");
      t += 1_000;
    }
    // Every one moved an hour later, in one write stamped with one time.
    const moved = t + 1_000;
    await db.client.query({
      sql: `UPDATE items SET payload = json_set(payload, '$.startTime', strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(payload, '$.startTime'), '+1 hour'),
                                     '$.endTime', strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(payload, '$.endTime'), '+1 hour')),
                   updated_at = ? WHERE type = 'booking'`,
      params: [moved],
      method: "run",
    });
    t = moved + 3 * 60_000;
    for (let i = 0; i < 30; i++) {
      await caps.connectors.run(view.id, t, "push");
      t += 1_000;
    }
    const { rows } = await db.client.query({
      sql: "SELECT id, json_extract(payload, '$.startTime') FROM items WHERE type = 'booking'",
      method: "all",
    });
    const wanted = new Map(rows.map((r) => [String(r[0]), Date.parse(String(r[1]))]));
    const late = ids.filter((id) => mem.events.get(id)?.start !== wanted.get(id));
    expect(ids).toHaveLength(230);
    expect(late).toEqual([]);
  });

  it("never records over the job that took a booking whose claim ran out", async () => {
    const { db, caps, svc } = await setup();
    const view = await connect(caps);
    const item = await book(caps, svc, at("09:00"));
    const slow = await claimLink(db, view.id, item, T0);
    const next = await claimLink(db, view.id, item, T0 + 121_000);
    expect(slow && next).toBeTruthy();
    if (!slow || !next) return;
    const synced = { kind: "synced" as const, etag: null, calendar: "home", hash: "h", start: 1, end: 2 };
    expect(await settleLink(db, next, { ...synced, externalId: "uid-of-the-next" }, T0 + 122_000)).toBe(true);
    // The slow job comes back with the booking it made: it records nothing.
    expect(await settleLink(db, slow, { ...synced, externalId: "uid-of-the-slow" }, T0 + 123_000)).toBe(false);
    expect((await readLink(db, view.id, item))?.externalId).toBe("uid-of-the-next");
  });

  it("finishes a booking a run stopped writing, and never moves past one another job holds", async () => {
    const { db, caps, svc, mem } = await setup();
    const view = await connect(caps);
    await caps.connectors.run(view.id, T0, "sync");
    const item = await book(caps, svc, at("09:00"));
    await caps.transitionItem(owner(T0 + 500), { item_id: item, event: "confirm" });
    // Another job holds it (and then stops without a word), long enough after for the cursor to pass it.
    const held = T0 + 150_000;
    expect(await claimLink(db, view.id, item, held)).not.toBeNull();
    await caps.connectors.run(view.id, held + 60_000, "push");
    expect(mem.events.has(item)).toBe(false);
    const cursor = async () =>
      JSON.parse(
        String(
          (
            await db.client.query({
              sql: "SELECT cursor FROM connectors WHERE id = ?",
              params: [view.id],
              method: "all",
            })
          ).rows[0]?.[0],
        ),
      ) as { c: number };
    // The cursor stayed short of it.
    expect((await cursor()).c).toBeLessThan(T0 + 500);
    // Once the claim has run out, the next run writes it: it was not left behind.
    expect(await dueRetries(db, view.id, held + 121_000, 10)).toEqual([item]);
    await caps.connectors.run(view.id, held + 121_000, "push");
    expect(mem.events.has(item)).toBe(true);
    expect((await cursor()).c).toBeGreaterThanOrEqual(T0 + 500);
  });

  it("finds what it wrote again after the account is connected again, rather than writing it twice", async () => {
    const { caps, svc, mem } = await setup();
    const view = await connect(caps);
    const item = await book(caps, svc, at("09:00"));
    await caps.transitionItem(owner(), { item_id: item, event: "confirm" });
    await caps.connectors.run(view.id, T0 + 1_000, "push");
    await caps.connectors.remove(owner(), view.id);
    const again = await connect(caps, T0 + 2_000);
    await caps.connectors.run(again.id, T0 + 3_000, "push");
    expect(mem.calls).toContain(`find:${item}`);
    expect(mem.calls.filter((c) => c.startsWith("put"))).toEqual([`put:${item}:create`, `put:${item}:update`]);
  });

  it("stops saying a booking was not added once it is long over", async () => {
    const { db, caps, svc, mem } = await setup();
    const view = await connect(caps);
    const item = await book(caps, svc, at("09:00"));
    await caps.transitionItem(owner(), { item_id: item, event: "confirm" });
    mem.failNext = "That calendar is read-only.";
    await caps.connectors.run(view.id, T0 + 1_000, "push");
    expect((await caps.connectors.get(owner(), view.id)).bookings_failing).toBe(1);
    const later = at("09:00", "2026-11-05");
    await caps.connectors.run(view.id, later, "push");
    expect((await caps.connectors.get(owner(), view.id)).bookings_failing).toBe(0);
    expect((await readLink(db, view.id, item))?.state).toBe("removed");
    expect(mem.events.has(item)).toBe(false);
  });

  it("takes an erased customer's name off a booking that already happened", async () => {
    const { db, caps, svc, mem } = await setup();
    const view = await connect(caps);
    const item = await book(caps, svc, at("09:00"), { name: "Joana Reis" });
    await caps.transitionItem(owner(), { item_id: item, event: "confirm" });
    await caps.connectors.run(view.id, T0 + 1_000, "push");
    await caps.transitionItem(owner(at("11:00")), { item_id: item, event: "complete" });
    expect(mem.events.get(item)?.title).toBe("Haircut · Joana Reis");
    await db.client.query({
      sql: "UPDATE parties SET erased_at = ?, updated_at = ? WHERE id = (SELECT party_id FROM items WHERE id = ?)",
      params: [at("12:00"), at("12:00"), item],
      method: "run",
    });
    await caps.connectors.run(view.id, at("12:00") + 3 * 60_000, "push");
    expect(mem.events.get(item)).toMatchObject({ title: "Haircut", start: at("09:00") });
  });
});

describe("two connections, one booking", () => {
  it("never counts a booking as busy against itself, whichever connection wrote it", async () => {
    const { caps, svc, mem } = await setup({ capacity: 2 });
    const writer = await connect(caps, T0, "ana@example.com");
    const reader = await connect(caps, T0, "studio@example.com");
    await caps.connectors.update(owner(), reader.id, { bookings_on: false });
    const item = await book(caps, svc, at("09:00"));
    await caps.transitionItem(owner(), { item_id: item, event: "confirm" });
    await caps.connectors.run(writer.id, T0 + 1_000, "push");
    // The reader's calendar shows the booking the writer added (Cal.com writing into Google).
    mem.busy = [{ start: at("09:00"), end: at("10:00") }];
    await caps.connectors.run(reader.id, T0 + 2_000, "sync");
    expect(await slotsOn(caps, svc)).toContain("09:00");
  });
});

describe("a connection that fails", () => {
  function failing(caps: Capabilities, mem: Memory, error: () => ConnectorError) {
    caps.connectors.attach({
      definitions: [
        {
          ...memoryConnector(mem),
          async busy() {
            throw error();
          },
        },
      ],
      http: noHttp,
    });
  }

  it("tells the owner once, backs off, and stops after a day of refused sign-ins", async () => {
    const { db, caps, mem } = await setup();
    const view = await connect(caps);
    failing(caps, mem, () => new ConnectorError("auth", "The calendar did not take that app password."));
    expect(await caps.connectors.nextSyncDelay(view.id, T0)).toBe(CONNECTOR_SYNC_INTERVAL_MS);
    await caps.connectors.run(view.id, T0, "sync");
    await caps.connectors.run(view.id, T0 + 5 * 60_000, "sync");
    await caps.connectors.run(view.id, T0 + 15 * 60_000, "sync");
    const v = await caps.connectors.get(owner(), view.id);
    expect(v).toMatchObject({ status: "error", error_code: "auth", failing_since: T0 });
    expect(await caps.connectors.nextSyncDelay(view.id, T0 + 15 * 60_000)).toBe(4 * CONNECTOR_SYNC_INTERVAL_MS);
    const notices = await db.client.query({
      sql: "SELECT payload FROM jobs WHERE kind = 'connector_notice'",
      method: "all",
    });
    expect(notices.rows).toHaveLength(1);
    expect(await caps.connectors.failingNotice(view.id)).toEqual({
      title: "Plain calendar",
      error: "The calendar did not take that app password.",
    });
    expect(await caps.connectors.nextSyncDelay(view.id, T0 + 25 * 3_600_000)).toBeNull();

    // The chain stopped; Sync now, once it works again, starts it.
    caps.connectors.attach({ definitions: [memoryConnector(mem)], http: noHttp });
    const handler = connectorSyncHandler(caps.connectors);
    const now = T0 + 25 * 3_600_000;
    await handler(
      { id: "j1", kind: "connector_sync", payload: { connectorId: view.id }, attempts: 1, maxAttempts: 5 } as never,
      {
        db,
        now,
      } as never,
    );
    const next = await db.client.query({
      sql: "SELECT run_at FROM jobs WHERE kind = 'connector_sync' AND run_at > ?",
      params: [now],
      method: "all",
    });
    expect(next.rows.map((r) => Number(r[0]))).toEqual([now + CONNECTOR_SYNC_INTERVAL_MS]);
    expect(await caps.connectors.get(owner(), view.id)).toMatchObject({ status: "active", error_code: null });
  });

  it("tells the owner of a platform that does not answer only after two hours", async () => {
    const { db, caps, mem } = await setup();
    const view = await connect(caps);
    failing(caps, mem, () => new ConnectorError("unreachable", "cal.example.com did not answer in time."));
    await caps.connectors.run(view.id, T0, "sync");
    const count = async () =>
      (await db.client.query({ sql: "SELECT COUNT(*) FROM jobs WHERE kind = 'connector_notice'", method: "all" }))
        .rows[0]?.[0];
    expect(Number(await count())).toBe(0);
    expect(await caps.connectors.nextSyncDelay(view.id, T0)).toBe(CONNECTOR_SYNC_INTERVAL_MS);
    await caps.connectors.run(view.id, T0 + 2 * 3_600_000, "sync");
    expect(Number(await count())).toBe(1);
    await caps.connectors.run(view.id, T0 + 3 * 3_600_000, "sync");
    expect(Number(await count())).toBe(1);
    // Three failures in a row: twenty minutes; never more than half an hour for a platform that does not answer.
    expect(await caps.connectors.nextSyncDelay(view.id, T0 + 3 * 3_600_000)).toBe(20 * 60_000);
    await db.client.query({ sql: "UPDATE connectors SET failures = 9 WHERE id = ?", params: [view.id], method: "run" });
    expect(await caps.connectors.nextSyncDelay(view.id, T0 + 3 * 3_600_000)).toBe(30 * 60_000);
  });

  it("emails the owner in the inbox's words, and says nothing once it works again", async () => {
    const { db, caps, mem } = await setup();
    const view = await connect(caps);
    failing(caps, mem, () => new ConnectorError("auth", "Cal.com did not take that API key."));
    await caps.connectors.run(view.id, T0, "sync");
    // The owner signs in with this address; the inbox's mail goes out through a working service.
    await db.client.query({
      sql: "INSERT INTO users (id, email, role, created_at) VALUES ('u1', 'ana@salon.example', 'owner', ?)",
      params: [T0],
      method: "run",
    });
    const mailOut = logMailOut();
    const handler = connectorNoticeHandler(caps.connectors, mailOut, { baseUrl: "https://inbox.salon.example" });
    const job = {
      id: "notice-1",
      kind: "connector_notice",
      payload: { connectorId: view.id },
      attempts: 1,
      maxAttempts: 5,
    };
    const r = await handler(job as never, { db, now: T0 + 1_000 } as never);
    expect(r).toMatchObject({ note: "told the owner the connection stopped syncing" });
    expect(mailOut.sent).toHaveLength(1);
    expect(mailOut.sent[0]).toMatchObject({
      to: ["ana@salon.example"],
      subject: "Your Plain calendar stopped syncing",
    });
    expect(mailOut.sent[0]?.text).toBe(
      [
        "Your Plain calendar stopped syncing: Cal.com did not take that API key.",
        "",
        "Connect it again in Settings → Integrations: https://inbox.salon.example/settings/integrations",
        "",
        "Until then, what you add in that calendar does not take times off what your inbox offers.",
      ].join("\n"),
    );
    // The same job again (a retry) sends nothing more.
    await handler(job as never, { db, now: T0 + 2_000 } as never);
    expect(mailOut.sent).toHaveLength(1);
    // Working again: nothing to tell.
    caps.connectors.attach({ definitions: [memoryConnector(mem)], http: noHttp });
    await caps.connectors.run(view.id, T0 + 5 * 60_000, "sync");
    const quiet = await handler({ ...job, id: "notice-2" } as never, { db, now: T0 + 6 * 60_000 } as never);
    expect(String((quiet as { note?: string }).note)).toContain("works again");
  });
});

describe("connecting again in place", () => {
  it("takes a new password for the same account and keeps every choice", async () => {
    const { db, caps, svc, mem } = await setup();
    const view = await connect(caps);
    await caps.connectors.update(owner(), view.id, { busy_calendars: ["work"], destination: "work", services: [svc] });
    await db.client.query({
      sql: "UPDATE connectors SET status = 'error', error_code = 'auth', last_error = 'x', failures = 3, failing_since = ? WHERE id = ?",
      params: [T0, view.id],
      method: "run",
    });
    const again = await caps.connectors.connect(owner(T0 + 1_000), {
      kind: "memcal",
      connection_id: view.id,
      values: { token: "good-token" },
    });
    expect(again).toMatchObject({
      id: view.id,
      preset: "plain",
      status: "configured",
      busy_calendars: ["work"],
      destination: "work",
      services: [svc],
      error_code: null,
      last_error: null,
    });
    await expect(
      caps.connectors.connect(owner(), {
        kind: "memcal",
        connection_id: view.id,
        values: { email: "someone@else.example", token: "good-token" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mem.calls).not.toContain("busy");
  });

  it("keeps the inbox's own id the same from run to run, and gives each account its own mark", async () => {
    const { db, caps, mem } = await setup();
    const a = await connect(caps, T0, "ana@example.com");
    const b = await connect(caps, T0, "studio@example.com");
    await caps.connectors.run(a.id, T0, "sync");
    await caps.connectors.run(b.id, T0, "sync");
    await caps.connectors.run(a.id, T0 + 60_000, "sync");
    const id = await instanceId(db, T0);
    expect(id).toMatch(/^[0-9a-f]{20}$/);
    expect(mem.seen.map((x) => x.inbox)).toEqual([id, id, id]);
    expect(mem.seen[0]?.marker).toMatch(/^[0-9a-f]{32}$/);
    expect(mem.seen[0]?.marker).toBe(mem.seen[2]?.marker);
    expect(mem.seen[0]?.marker).not.toBe(mem.seen[1]?.marker);
  });
});

describe("the gallery", () => {
  it("puts the calendar first, says which it takes, and the ready ways before the rest", async () => {
    const { caps, mem } = await setup();
    caps.connectors.attach({
      definitions: [
        {
          ...memoryConnector(mem),
          kind: "caldav",
          presets: [
            { id: "icloud", label: "iCloud", values: {} },
            { id: "fastmail", label: "Fastmail", values: {} },
            { id: "nextcloud", label: "Nextcloud", values: {} },
            { id: "other", label: "Other", values: {} },
          ],
        },
        {
          ...memoryConnector(mem),
          kind: "google_calendar",
          auth: "oauth",
          ready: () => "no client",
          whenNotReady: {
            status: "setup",
            hint: "Needs a Google client on the server.",
            href: "https://surfingdog.ai/docs/calendars/#google-calendar",
          },
        },
      ],
      http: noHttp,
    });
    const { cards } = await caps.connectors.integrations(owner());
    expect(cards.map((c) => c.id)).toEqual(["calendar", "calcom", "stripe", "mollie", "shopify", "woocommerce"]);
    const calendar = cards[0];
    expect(calendar?.line).toBe("iCloud, Fastmail, Nextcloud and more");
    expect(calendar?.ways.map((w) => `${w.label}:${w.status}`)).toEqual([
      "iCloud:ready",
      "Fastmail:ready",
      "Nextcloud:ready",
      "Other:ready",
      "Google:setup",
      "Calendar link:soon",
      "Outlook:soon",
    ]);
    expect(calendar?.ways.find((w) => w.kind === "google_calendar")).toMatchObject({
      hint: "Needs a Google client on the server.",
    });
  });
});
