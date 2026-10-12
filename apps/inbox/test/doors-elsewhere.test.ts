import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import { MANIFEST_PATH, manifestSchema, readDoorsElsewhere, schema, ulid } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * A business that takes some kinds of request somewhere else, through the whole app: a salon whose
 * bookings are at a booking platform, a shop whose orders stay in its own checkout. The manifest
 * names where to go and leaves that kind out of `item_types`, the business's own page links there,
 * and the profile agents read says so. Messages and quotes stay in the inbox. Node and workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const BASE = "https://inbox.example.com";
const BOOKING = "https://booking.example.com/ana-salon";
const CHECKOUT = "https://shop.example.com/";

async function setup(kind: "salon" | "shop") {
  const db = await freshDb();
  await db.orm.insert(schema.business).values({
    id: "self",
    name: kind === "salon" ? "Ana's Salon" : "Maré Surf Shop",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    languages: ["en", "pt"],
    createdAt: T0,
    updatedAt: T0,
  });
  const service = ulid(T0);
  await db.orm.insert(schema.services).values({
    id: service,
    name: kind === "salon" ? "Cut and colour" : "Board repair",
    durationMin: 60,
    capacity: 1,
    granularityMin: 30,
    price: { model: "fixed", value: 4500, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  const ownerKey = (await createApiKey(db, { kind: "owner", name: "cli" })).key;
  const inbox = createInbox({ db, baseUrl: BASE, background: () => {} });
  const get = (path: string, headers: Record<string, string> = {}) =>
    inbox.app.request(new Request(`${BASE}${path}`, { headers }));
  const settings = (doc: unknown) =>
    inbox.app.request(
      new Request(`${BASE}/v1/owner/settings`, {
        method: "PUT",
        headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
        body: JSON.stringify({ doc }),
      }),
    );
  const manifest = async () => manifestSchema.parse(await (await get(MANIFEST_PATH)).json());
  const open = () =>
    inbox.app.request(
      new Request(`${BASE}/v1/owner/availability`, {
        method: "PUT",
        headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
        body: JSON.stringify({ weekly: { mon: [["09:00", "18:00"]], tue: [["09:00", "18:00"]] } }),
      }),
    );
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    inbox.app.request(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const mcp = async () => {
    const client = new Client({ name: "an-agent", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        fetch: (input: string | URL | Request, init?: RequestInit) => inbox.app.request(String(input), init),
      }),
    );
    return client;
  };
  return { get, post, settings, manifest, open, mcp, ownerKey, service };
}

describe("a salon whose bookings are at a booking platform", () => {
  it("lists message and quote_request, and names booking at the platform in its manifest", async () => {
    const s = await setup("salon");
    // Hours and a priced service: on its own, the inbox would take bookings itself.
    const opened = await s.open();
    expect(opened.status, await opened.clone().text()).toBe(200);
    expect((await s.manifest()).item_types).toEqual(["message", "quote_request", "booking", "refund"]);
    const set = await s.settings({ doorsElsewhere: [{ itemType: "booking", url: BOOKING }] });
    expect(set.status, await set.clone().text()).toBe(200);
    const m = await s.manifest();
    expect(m.item_types).toEqual(["message", "quote_request"]);
    expect(m.doors_elsewhere).toEqual([{ item_type: "booking", url: BOOKING }]);
    expect(readDoorsElsewhere(m)).toEqual(m.doors_elsewhere);
  });

  it("says Book at the platform on its own page, and keeps quotes and messages there", async () => {
    const s = await setup("salon");
    await s.settings({ doorsElsewhere: [{ itemType: "booking", url: BOOKING }] });
    const html = await (await s.get("/", { "accept-language": "en" })).text();
    expect(html).toContain(`<a href="${BOOKING}" rel="noopener noreferrer">Book at booking.example.com</a>`);
    expect(html).not.toContain("/p/book?service=");
    expect(html).toContain('href="/p/quote"');
    expect(html).toContain('href="/p/message"');
  });

  it("tells an agent reading the profile where bookings are taken", async () => {
    const s = await setup("salon");
    await s.settings({ doorsElsewhere: [{ itemType: "booking", url: BOOKING }] });
    const profile = (await (await s.get("/v1/business")).json()) as {
      item_types: string[];
      doors_elsewhere: unknown;
    };
    expect(profile.item_types).not.toContain("booking");
    expect(profile.doors_elsewhere).toEqual([{ item_type: "booking", url: BOOKING }]);
  });
});

// The manifest leaves bookings out, but an agent need not read it: the doors themselves send a
// customer to the platform, or a time the platform's calendar never sees could be booked twice.
describe("a booking door the business keeps at a booking platform", () => {
  const DAY = "2026-09-22";
  const booking = {
    payload: {
      reservationFor: { serviceId: "", name: "Cut and colour" },
      startTime: `${DAY}T09:00:00Z`,
      endTime: `${DAY}T10:00:00Z`,
    },
    contact: { name: "Rita", email: "rita@example.com" },
  };

  it("refuses a customer's booking and the free times, naming the platform, by REST, MCP and the page", async () => {
    const s = await setup("salon");
    await s.open();
    await s.settings({ doorsElsewhere: [{ itemType: "booking", url: BOOKING }] });
    const asked = {
      ...booking,
      payload: { ...booking.payload, reservationFor: { serviceId: s.service, name: "Cut and colour" } },
    };

    const refused = await s.post("/v1/bookings", asked);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      details: { reason: "taken_elsewhere", item_type: "booking", url: BOOKING },
    });
    const times = await s.get(`/v1/availability?service_id=${s.service}&from=${DAY}T00:00:00Z&to=${DAY}T23:59:00Z`);
    expect(times.status).toBe(403);
    expect(await times.json()).toMatchObject({ details: { url: BOOKING } });

    const agent = await s.mcp();
    for (const [name, args] of [
      ["create_booking", asked],
      ["check_availability", { service_id: s.service, from: `${DAY}T00:00:00Z`, to: `${DAY}T23:59:00Z` }],
    ] as const) {
      const r = await agent.callTool({ name, arguments: args });
      expect(r.isError, name).toBe(true);
      expect(JSON.stringify(r.content), name).toContain(BOOKING);
    }
    await agent.close();

    // The page sends a visitor on, whether they open the booking form or send it.
    for (const res of [
      await s.get(`/p/book?service=${s.service}`),
      await s.post("/p/book", {}, { "content-type": "application/x-www-form-urlencoded" }),
    ]) {
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(BOOKING);
    }
    // Quotes and messages still come here.
    const quote = await s.post("/v1/quotes", {
      payload: { itemOffered: { name: "Cut and colour" }, description: "A colour for a wedding" },
      contact: booking.contact,
    });
    expect(quote.status, await quote.clone().text()).toBe(201);
  });

  it("still lets the business add a booking itself", async () => {
    const s = await setup("salon");
    await s.open();
    await s.settings({ doorsElsewhere: [{ itemType: "booking", url: BOOKING }] });
    const res = await s.post(
      "/v1/bookings",
      { ...booking, payload: { ...booking.payload, reservationFor: { serviceId: s.service, name: "Cut and colour" } } },
      { authorization: `Bearer ${s.ownerKey}` },
    );
    expect(res.status, await res.clone().text()).not.toBe(403);
  });
});

describe("a shop whose orders stay in its own checkout", () => {
  it("lists message and quote_request, names its checkout for orders, and links it on its page", async () => {
    const s = await setup("shop");
    const set = await s.settings({ doorsElsewhere: [{ itemType: "order", url: CHECKOUT }] });
    expect(set.status, await set.clone().text()).toBe(200);
    const m = await s.manifest();
    expect(m.item_types).toEqual(["message", "quote_request"]);
    expect(m.doors_elsewhere).toEqual([{ item_type: "order", url: CHECKOUT }]);
    const html = await (await s.get("/", { "accept-language": "pt" })).text();
    expect(html).toContain(`<a href="${CHECKOUT}" rel="noopener noreferrer">Encomendar em shop.example.com</a>`);
    // An agent that orders anyway is sent to the checkout, and nothing is written.
    const ordered = await s.post("/v1/orders", {
      payload: {
        orderedItem: [{ name: "Wax", quantity: 1, price: { value: 900, currency: "EUR" } }],
        totalPrice: { value: 900, currency: "EUR" },
      },
      contact: { name: "Rita", email: "rita@example.com" },
    });
    expect(ordered.status).toBe(403);
    expect(await ordered.json()).toMatchObject({
      details: { reason: "taken_elsewhere", item_type: "order", url: CHECKOUT },
    });
  });

  it("says nothing of doors elsewhere once they are cleared", async () => {
    const s = await setup("shop");
    await s.settings({ doorsElsewhere: [{ itemType: "order", url: CHECKOUT }] });
    await s.settings({ doorsElsewhere: null });
    expect(await s.manifest()).not.toHaveProperty("doors_elsewhere");
  });
});
