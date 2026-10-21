import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { FILE_WORDS } from "../src/attachments/index";
import type { CustomerResult } from "../src/capabilities/customer";
import { Capabilities } from "../src/capabilities/service";
import type { RequestQuoteInput } from "../src/capabilities/types";
import { linkComing } from "../src/connectors/pay-queue";
import { createDb, type Db } from "../src/db";
import { customerCopyProblems } from "../src/i18n/customer-words";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { JOB_WORDS, workAttributes } from "../src/trades/job";
import { tradeQuoteWords } from "../src/trades/quote";
import { type Caller, transitionItem } from "../src/write/index";
import { confirming, makeClient, openWeekdays, resetTables } from "./harness";
import { base64, contains, heic, pdf, phoneJpeg, SECRET_PLACE, textPng } from "./trades-files";

/**
 * A trade's requests (ADR-034), end to end on the capabilities: a request for a price with its job and
 * its photos, checked against the area and the emergency door; files the business alone sees, through
 * its own links, gone with the customer; a quote in stages that adds up, said to the customer in the
 * business's words, and an order from it that asks for no whole-total link; a site visit tied to its
 * request. Fixtures (plan §4.6): Fundi Flow Plumbing (Nairobi, KES), Elektro Brandt (Leipzig, EUR),
 * Southern Cross Renovations (Perth, AUD), a roofer in Santiago (CLP, no minor unit).
 */

const T0 = Date.parse("2026-11-04T07:30:00Z"); // a Wednesday, 10:30 in Nairobi
const HOUR = 3_600_000;
const BASE = "https://fundiflow.example";
const NAIROBI = { lat: -1.2864, lng: 36.8172 };

const owner = (t = T0): Caller => ({
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
  principal: { via: "session", id: "s1", name: "owner", scopes: ["*"], userId: "u1" },
});
const anon = (t = T0, extra: Partial<Caller> = {}): Caller => ({
  actor: { kind: "customer_agent", id: `anon:${ulid()}`, channel: "mcp_public" },
  tier: "anonymous",
  sandbox: false,
  now: () => t,
  ...extra,
});

async function setup(o: { name: string; currency: string; timezone: string; settings?: Record<string, unknown> }) {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const caps = confirming(new Capabilities(db, createSecretBox(["trades-test-instance-key-0123456789abcdef"]), BASE));
  await caps.updateSettings(owner(), {
    doc: {
      business: { name: o.name, currency: o.currency, timezone: o.timezone, languages: ["en"] },
      doors: { quoteRequest: true },
      ...(o.settings ?? {}),
    },
  });
  await db.client.query({
    sql: "INSERT OR REPLACE INTO business (id, name, timezone, currency, created_at, updated_at) VALUES ('self', ?, ?, ?, ?, ?)",
    params: [o.name, o.timezone, o.currency, T0, T0],
    method: "run",
  });
  return { db, caps };
}

const fundi = (work: Record<string, unknown> = {}, area: Record<string, unknown> = {}) =>
  setup({
    name: "Fundi Flow Plumbing",
    currency: "KES",
    timezone: "Africa/Nairobi",
    settings: {
      area: { mode: "radius", radiusKm: 25, base: { from: "device", point: NAIROBI }, outside: "on_request", ...area },
      work: { emergency: "always", ...work },
    },
  });

const leak = (job: Record<string, unknown> = {}): RequestQuoteInput =>
  ({
    payload: {
      itemOffered: { name: "Leaking kitchen tap" },
      description: "The tap under the sink drips all night.",
      job: {
        urgency: "this_week",
        visit: "needed",
        site: {
          address: {
            streetAddress: "14 Mpaka Road",
            addressLocality: "Nairobi",
            postalCode: "00800",
            addressCountry: "KE",
          },
          geo: { latitude: -1.2676, longitude: 36.8108 },
          accessNotes: "Blue gate, ask for the caretaker.",
          propertyType: "home",
        },
        windows: [{ from: "2026-11-06T06:00:00Z", to: "2026-11-06T10:00:00Z" }],
        ...job,
      },
    },
    contact: { name: "Wanjiru Kamau", email: "wanjiru@example.com" },
  }) as RequestQuoteInput;

async function flagsOf(db: Db, id: string): Promise<{ needsHuman?: boolean; priority?: number }> {
  const { rows } = await db.client.query({ sql: "SELECT flags FROM items WHERE id = ?", params: [id], method: "all" });
  const raw = rows[0]?.[0];
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as { needsHuman?: boolean; priority?: number };
}

async function count(db: Db, sql: string, params: (string | number)[] = []): Promise<number> {
  const { rows } = await db.client.query({ sql, params, method: "all" });
  return Number(rows[0]?.[0] ?? 0);
}

describe("a request for a price with its job and photos", () => {
  it("is taken with the area's band, the photos cleaned and handed to it, in one batch", async () => {
    const s = await fundi();
    const r = await s.caps.requestQuote(anon(), {
      ...leak(),
      attachments: [
        { data_base64: base64(phoneJpeg().bytes), name: "sink.jpg" },
        { data_base64: base64(pdf()), name: "plan" },
      ],
      idempotency_key: "leak-1",
    });
    const item = r.view.item;
    expect(item.type).toBe("quote_request");
    const payload = item.payload as {
      job?: { areaCheck?: unknown; urgency?: string };
      attachments?: { id: string; name: string }[];
    };
    expect(payload.job?.areaCheck).toEqual({ status: "inside", by: "radius", within_km: 10 });
    expect(payload.attachments?.map((a) => a.name)).toEqual(["sink.jpg", "plan.pdf"]);
    expect(await count(s.db, "SELECT COUNT(*) FROM blobs WHERE item_id = ?", [item.id])).toBe(2);
    // Nothing the customer sent says where the photo was taken any more.
    const files = await s.caps.trades.files(owner(), item.id);
    // In the order they were sent.
    expect(files.files.map((f) => f.name)).toEqual(["sink.jpg", "plan.pdf"]);
    const link = new URL(files.files[0]?.url ?? "", BASE);
    const served = await s.caps.trades.serveFile(
      link.pathname.split("/").pop() ?? "",
      link.searchParams.get("e"),
      link.searchParams.get("s"),
      T0 + 60_000,
    );
    expect(served?.headers["Content-Type"]).toBe("image/jpeg");
    expect(contains(served?.bytes ?? new Uint8Array(), SECRET_PLACE)).toBe(false);
    // A link tampered with, or out of time, serves nothing.
    expect(
      await s.caps.trades.serveFile(
        link.pathname.split("/").pop() ?? "",
        link.searchParams.get("e"),
        "x".repeat(43),
        T0,
      ),
    ).toBeNull();
    expect(
      await s.caps.trades.serveFile(
        link.pathname.split("/").pop() ?? "",
        link.searchParams.get("e"),
        link.searchParams.get("s"),
        T0 + 11 * 60_000,
      ),
    ).toBeNull();
    // Only the business sees them.
    await expect(s.caps.trades.files(anon(), item.id)).rejects.toMatchObject({ code: "not_allowed" });
  });

  it("answers a retry with the request it made, and keeps no second copy of its files", async () => {
    const s = await fundi();
    const input = { ...leak(), attachments: [{ data_base64: base64(textPng()) }], idempotency_key: "leak-2" };
    const agent = anon();
    const first = await s.caps.requestQuote(agent, input);
    const again = await s.caps.requestQuote(agent, input);
    expect(again.view.item.id).toBe(first.view.item.id);
    expect(again.replayed).toBe(true);
    expect(await count(s.db, "SELECT COUNT(*) FROM blobs")).toBe(1);
  });

  it("refuses a HEIC photo before anything is written, with what to send instead", async () => {
    const s = await fundi();
    await expect(
      s.caps.requestQuote(anon(), { ...leak(), attachments: [{ data_base64: base64(heic()) }] }),
    ).rejects.toMatchObject({ code: "invalid_input", message: FILE_WORDS.heic });
    expect(await count(s.db, "SELECT COUNT(*) FROM items")).toBe(0);
  });

  it("is on request from outside, and declined from outside where the business says so", async () => {
    const away = { geo: { latitude: -1.0333, longitude: 37.0693 } }; // Thika
    const decides = await fundi();
    const r = await decides.caps.requestQuote(anon(), leak({ site: away }));
    expect((r.view.item.payload as { job: { areaCheck: unknown } }).job.areaCheck).toEqual({
      status: "outside",
      by: "radius",
    });
    expect((await flagsOf(decides.db, r.view.item.id)).needsHuman).toBe(true);
    const declines = await fundi({}, { outside: "decline" });
    await expect(declines.caps.requestQuote(anon(), leak({ site: away }))).rejects.toMatchObject({
      code: "not_allowed",
      message: JOB_WORDS.outside("Fundi Flow Plumbing"),
      details: { reason: "outside_area" },
    });
  });

  it("takes an emergency only through the door the business opened: never, or while open", async () => {
    const shut = await fundi({ emergency: "off" });
    await expect(shut.caps.requestQuote(anon(), leak({ urgency: "emergency" }))).rejects.toMatchObject({
      message: JOB_WORDS.emergencyOff("Fundi Flow Plumbing"),
      fields: [{ path: "payload.job.urgency" }],
    });
    const whileOpen = await fundi({ emergency: "opening_hours" });
    await openWeekdays(whileOpen.db);
    // 06:00 UTC on a Sunday is not open.
    const sunday = Date.parse("2026-11-08T06:00:00Z");
    await expect(whileOpen.caps.requestQuote(anon(sunday), leak({ urgency: "emergency" }))).rejects.toMatchObject({
      message: JOB_WORDS.emergencyClosed("Fundi Flow Plumbing"),
    });
    const always = await fundi({ emergency: "always" });
    const taken = await always.caps.requestQuote(anon(), leak({ urgency: "emergency" }));
    expect(await flagsOf(always.db, taken.view.item.id)).toMatchObject({ needsHuman: true, priority: 3 });
    // A refusal gives the business's phone when it has one.
    await shut.caps.updateSettings(owner(), { doc: { commerce: { legal: { phone: "+254 20 765 4321" } } } });
    await expect(shut.caps.requestQuote(anon(), leak({ urgency: "emergency" }))).rejects.toMatchObject({
      message:
        "Fundi Flow Plumbing does not take emergency jobs online. Call Fundi Flow Plumbing on +254 20 765 4321, or send it with urgency within_24h.",
    });
  });

  it("takes an emergency whose site a radius cannot place first, for a person: a postal code is not geocoded", async () => {
    const s = await fundi({ emergency: "always" });
    const r = await s.caps.requestQuote(
      anon(),
      leak({ urgency: "emergency", site: { address: { postalCode: "00100", addressCountry: "KE" } } }),
    );
    expect((r.view.item.payload as { job: { areaCheck: unknown } }).job.areaCheck).toEqual({
      status: "unknown",
      by: "radius",
    });
    expect(await flagsOf(s.db, r.view.item.id)).toMatchObject({ needsHuman: true, priority: 3 });
  });

  it("takes its files' bytes away with the customer when they are erased", async () => {
    const s = await fundi();
    const r = await s.caps.requestQuote(anon(), { ...leak(), attachments: [{ data_base64: base64(textPng()) }] });
    const { rows } = await s.db.client.query({
      sql: "SELECT party_id FROM items WHERE id = ?",
      params: [r.view.item.id],
    });
    const party = String(rows[0]?.[0]);
    expect(await count(s.db, "SELECT COUNT(*) FROM attachment_chunks")).toBeGreaterThan(0);
    const asked = await s.caps.customers
      .erase(owner(), { party_id: party })
      .catch((e: { details?: { confirm?: string } }) => e);
    await s.caps.customers.erase(owner(), {
      party_id: party,
      confirm: (asked as { details: { confirm: string } }).details.confirm,
    });
    expect(await count(s.db, "SELECT COUNT(*) FROM attachment_chunks")).toBe(0);
    expect(await count(s.db, "SELECT COUNT(*) FROM blobs WHERE deleted_at IS NULL")).toBe(0);
  });
});

describe("where the business works, as agents are told it", () => {
  it("answers check_area by postal code in Perth, and publishes no base", async () => {
    const s = await setup({
      name: "Southern Cross Renovations",
      currency: "AUD",
      timezone: "Australia/Perth",
      settings: {
        area: {
          mode: "postal",
          postal: [
            { country: "AU", prefix: "60" },
            { country: "AU", prefix: "61" },
          ],
          outside: "decline",
        },
        work: {
          callOutFee: { amount: { value: 9_900, currency: "AUD" }, creditedIfAccepted: true },
          freeEstimates: true,
        },
      },
    });
    expect(await s.caps.trades.checkArea({ postal_code: "6000", country: "AU" })).toMatchObject({ answer: "inside" });
    expect(await s.caps.trades.checkArea({ postal_code: "2000", country: "AU" })).toMatchObject({ answer: "outside" });
    expect(await s.caps.trades.checkArea({ postal_code: "60", country: "AU" })).toMatchObject({ answer: "on_request" });
    expect(await s.caps.trades.checkArea({ lat: -31.95, lng: 115.86 })).toMatchObject({ answer: "on_request" });
    const profile = await s.caps.getBusinessProfile();
    expect(profile.work).toEqual({
      area: {
        mode: "postal",
        postal: [
          { country: "AU", prefix: "60" },
          { country: "AU", prefix: "61" },
        ],
        outside: "decline",
      },
      emergency: "off",
      call_out_fee: { amount: { value: 9_900, currency: "AUD" }, credited_if_accepted: true },
      free_estimates: true,
      visits: "on_request",
    });
    const settings = await (await import("../src/settings/schema")).readSettings(s.db);
    expect(workAttributes(settings)).toEqual({ free_estimates: true });
  });

  it("keeps the base out of every answer, and Area and Work out of the owner's AI's hands", async () => {
    const s = await fundi();
    const profile = await s.caps.getBusinessProfile();
    expect(JSON.stringify(profile)).not.toContain("36.81");
    const check = await s.caps.trades.checkArea({ lat: -1.3195, lng: 36.7076 });
    expect(JSON.stringify(check)).not.toContain("36.81");
    const ai: Caller = {
      actor: { kind: "owner_ai", id: "app_1", channel: "mcp_owner" },
      actsAs: "owner",
      tier: "verified_principal",
      sandbox: false,
      now: () => T0,
      principal: { via: "oauth", id: "app_1", name: "An assistant", scopes: ["*"], userId: "u1" },
    };
    await expect(s.caps.updateSettings(ai, { doc: { area: { mode: "anywhere" } } })).rejects.toMatchObject({
      code: "not_allowed",
    });
    await expect(s.caps.updateSettings(ai, { doc: { work: { jobTool: "every" } } })).rejects.toMatchObject({
      code: "not_allowed",
    });
  });
});

describe("a quote in stages", () => {
  const brandt = () =>
    setup({
      name: "Elektro Brandt",
      currency: "EUR",
      timezone: "Europe/Berlin",
      settings: { area: { mode: "postal", postal: [{ country: "DE", prefix: "04" }] } },
    });
  const rewire: RequestQuoteInput = {
    payload: {
      itemOffered: { name: "Rewiring a flat" },
      description: "Two rooms and the kitchen.",
      job: { urgency: "flexible", visit: "needed", site: { address: { postalCode: "04109", addressCountry: "DE" } } },
    },
    contact: { name: "Jonas Weber", email: "jonas@example.com", locale: "en" },
  } as RequestQuoteInput;

  it("adds up to the total, or is not sent, naming the field", async () => {
    const s = await brandt();
    const q = await s.caps.requestQuote(anon(), rewire);
    await expect(
      transitionItem(s.db, owner(), {
        itemId: q.view.item.id,
        event: "quote",
        input: {
          totalPrice: { value: 480_000, currency: "EUR" },
          kind: "fixed",
          stages: [
            { id: "deposit", type: "immediate", amount: { value: 100_000, currency: "EUR" }, label: "Deposit" },
            { id: "balance", type: "at_property", amount: { value: 300_000, currency: "EUR" }, label: "Balance" },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input", fields: [expect.objectContaining({ path: "input.stages" })] });
    await expect(
      transitionItem(s.db, owner(), {
        itemId: q.view.item.id,
        event: "quote",
        input: {
          totalPrice: { value: 480_000, currency: "EUR" },
          stages: [{ id: "later", type: "deferred", amount: { value: 480_000, currency: "EUR" } }],
        },
      }),
    ).rejects.toMatchObject({ fields: [expect.objectContaining({ path: "input.stages.0.due_at" })] });
  });

  it("is said to the customer whole, and the order it becomes asks for no link for the total", async () => {
    const s = await brandt();
    const q = await s.caps.requestQuote(anon(), rewire);
    const token = q.accessToken as string;
    await transitionItem(s.db, owner(), {
      itemId: q.view.item.id,
      event: "quote",
      input: {
        totalPrice: { value: 480_000, currency: "EUR" },
        kind: "estimate",
        stages: [
          { id: "deposit", type: "immediate", amount: { value: 100_000, currency: "EUR" }, label: "Deposit" },
          { id: "balance", type: "at_property", amount: { value: 380_000, currency: "EUR" }, label: "Balance" },
        ],
        callOutFee: { amount: { value: 6_500, currency: "EUR" }, creditedIfAccepted: true },
        tax: { included: true },
      },
    });
    const status = await s.caps.getItemStatus(anon(T0, { accessToken: token }), {
      item_id: q.view.item.id,
      access_token: token,
    });
    const summary = String((status as { offer?: { human?: string } }).offer?.human ?? "");
    expect(summary).toContain("This is an estimate");
    expect(summary).toContain("It is paid in stages: Deposit");
    expect(summary).toContain("The call-out fee of €65.00 is already taken off the total.");
    expect(summary).toContain("Balance €3,800.00 on site");
    expect(summary).toContain("Prices include tax.");
    const accepted = (await s.caps.customer.acceptOffer(anon(T0, { accessToken: token }), {
      item_id: q.view.item.id,
      access_token: token,
      terms_sha: (status as { offer?: { terms_sha?: string } }).offer?.terms_sha as string,
    })) as CustomerResult;
    const order = accepted.linked?.item;
    if (!order) throw new Error("no order");
    expect(order.type).toBe("order");
    expect((order.payload as { schedule?: unknown[] }).schedule).toHaveLength(2);
    expect(await linkComing(s.db, { id: order.id, payload: order.payload as never, sandbox: false }, T0)).toBe(false);
  });

  it("names the tax on prices before tax, and the customer agrees to the total with it, which the order holds", async () => {
    const s = await setup({ name: "Southern Cross Renovations", currency: "AUD", timezone: "Australia/Perth" });
    const q = await s.caps.requestQuote(anon(), {
      payload: { itemOffered: { name: "A new deck" }, description: "Hardwood, about 20 square metres." },
      contact: { name: "Mia Nguyen", email: "mia@example.com", locale: "en" },
    } as RequestQuoteInput);
    const token = q.accessToken as string;
    // Before tax with no tax named: refused, so nobody says yes to a total that leaves the tax out.
    await expect(
      transitionItem(s.db, owner(), {
        itemId: q.view.item.id,
        event: "quote",
        input: { totalPrice: { value: 440_000, currency: "AUD" }, tax: { included: false } },
      }),
    ).rejects.toMatchObject({ fields: [expect.objectContaining({ path: "input.tax.lines" })] });
    // The lines are before tax; with the GST they make the total.
    await expect(
      transitionItem(s.db, owner(), {
        itemId: q.view.item.id,
        event: "quote",
        input: {
          totalPrice: { value: 400_000, currency: "AUD" },
          lines: [{ name: "Deck", quantity: 1, price: { value: 400_000, currency: "AUD" } }],
          tax: { included: false, lines: [{ name: "GST", amount: { value: 40_000, currency: "AUD" } }] },
        },
      }),
    ).rejects.toMatchObject({ fields: [expect.objectContaining({ path: "input.totalPrice.value" })] });
    await transitionItem(s.db, owner(), {
      itemId: q.view.item.id,
      event: "quote",
      input: {
        totalPrice: { value: 440_000, currency: "AUD" },
        lines: [{ name: "Deck", quantity: 1, price: { value: 400_000, currency: "AUD" } }],
        stages: [
          { id: "deposit", type: "immediate", amount: { value: 100_000, currency: "AUD" }, label: "Deposit" },
          { id: "balance", type: "at_property", amount: { value: 340_000, currency: "AUD" }, label: "Balance" },
        ],
        tax: { included: false, lines: [{ name: "GST", amount: { value: 40_000, currency: "AUD" } }] },
      },
    });
    const status = await s.caps.getItemStatus(anon(T0, { accessToken: token }), {
      item_id: q.view.item.id,
      access_token: token,
    });
    const offer = (status as { offer?: { human?: string; terms_sha?: string } }).offer;
    const summary = String(offer?.human ?? "");
    expect(summary).toMatch(/Prices are before tax: A\$4,000\.00 \+ GST A\$400\.00 = A\$4,400\.00\./);
    expect(summary).toMatch(/A\$4,400\.00/);
    expect(summary).not.toMatch(/pay A\$4,000\.00/);
    const accepted = (await s.caps.customer.acceptOffer(anon(T0, { accessToken: token }), {
      item_id: q.view.item.id,
      access_token: token,
      terms_sha: offer?.terms_sha as string,
    })) as CustomerResult;
    const order = accepted.linked?.item;
    expect((order?.payload as { totalPrice?: unknown } | undefined)?.totalPrice).toEqual({
      value: 440_000,
      currency: "AUD",
    });
  });

  it("counts a currency with no minor unit as it is: a roofer in Santiago", () => {
    const words = tradeQuoteWords(
      {
        totalPrice: { value: 1_500_000, currency: "CLP" },
        kind: "fixed",
        stages: [
          { id: "a", type: "immediate", amount: { value: 500_000, currency: "CLP" }, label: "Anticipo" },
          { id: "b", type: "deferred", amount: { value: 1_000_000, currency: "CLP" }, due_at: "2026-12-15T15:00:00Z" },
        ],
      },
      "en",
      (iso) => iso.slice(0, 10),
    );
    expect(words).toContain("This is a fixed price.");
    expect(words).toMatch(/Anticipo CLP\s?500,000 now/);
    expect(words).toContain("by 2026-12-15");
  });
});

describe("a site visit", () => {
  it("is booked beside the request it is for, and each names the other", async () => {
    const s = await fundi();
    await openWeekdays(s.db);
    const visit = ulid();
    await s.db.orm.insert(services).values({
      id: visit,
      name: "Site visit",
      durationMin: 60,
      capacity: 1,
      granularityMin: 30,
      price: { model: "fixed", value: 150_000, currency: "KES" },
      createdAt: T0,
      updatedAt: T0,
    } as never);
    await s.caps.updateSettings(owner(), { doc: { work: { visitServiceId: visit } } });
    const q = await s.caps.requestQuote(anon(), leak());
    const token = q.accessToken as string;
    const b = await s.caps.createBooking(anon(T0, { accessToken: token }), {
      payload: {
        reservationFor: { serviceId: visit, name: "Site visit" },
        startTime: "2026-11-06T07:00:00Z",
        endTime: "2026-11-06T08:00:00Z",
      },
      contact: { name: "Wanjiru Kamau", email: "wanjiru@example.com" },
      visit_for: { item_id: q.view.item.id, access_token: token },
    });
    const { rows } = await s.db.client.query({
      sql: "SELECT linked_item_id FROM items WHERE id = ?",
      params: [b.view.item.id],
    });
    expect(rows[0]?.[0]).toBe(q.view.item.id);
    const { rows: req } = await s.db.client.query({
      sql: "SELECT json_extract(payload, '$.job.visitBookingId') FROM items WHERE id = ?",
      params: [q.view.item.id],
    });
    expect(req[0]?.[0]).toBe(b.view.item.id);
    // Someone else's request is not theirs to book a visit for.
    await expect(
      s.caps.createBooking(anon(), {
        payload: {
          reservationFor: { serviceId: visit, name: "Site visit" },
          startTime: "2026-11-06T09:00:00Z",
          endTime: "2026-11-06T10:00:00Z",
        },
        contact: { name: "Someone", email: "someone@example.com" },
        visit_for: { item_id: q.view.item.id },
      }),
    ).rejects.toMatchObject({ code: "not_allowed" });
  });
});

describe("what customers read", () => {
  it("never names the software, in what the business tells them of the area, the job, files or a quote", () => {
    const b = "Fundi Flow Plumbing";
    const texts = {
      ...Object.fromEntries(Object.entries(JOB_WORDS).map(([k, f]) => [k, f(b)])),
      ...FILE_WORDS,
      quote: tradeQuoteWords(
        {
          totalPrice: { value: 1_200_000, currency: "KES" },
          kind: "estimate",
          stages: [
            { id: "a", type: "immediate", amount: { value: 200_000, currency: "KES" } },
            { id: "b", type: "at_property", amount: { value: 1_000_000, currency: "KES" } },
          ],
          callOutFee: { amount: { value: 150_000, currency: "KES" }, creditedIfAccepted: false },
          tax: { included: false, lines: [{ name: "VAT 16%", amount: { value: 192_000, currency: "KES" } }] },
        },
        "en",
        (iso) => iso,
      ),
    };
    expect(customerCopyProblems(texts as Record<string, string>)).toEqual([]);
    const pt = tradeQuoteWords(
      { totalPrice: { value: 100, currency: "EUR" }, kind: "estimate", tax: { included: true } },
      "pt",
      (iso) => iso,
    );
    expect(customerCopyProblems({ pt }, "pt")).toEqual([]);
  });
});

void HOUR;
