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
  await db.orm.insert(schema.services).values({
    id: ulid(T0),
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
  return { get, settings, manifest, open };
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
  });

  it("says nothing of doors elsewhere once they are cleared", async () => {
    const s = await setup("shop");
    await s.settings({ doorsElsewhere: [{ itemType: "order", url: CHECKOUT }] });
    await s.settings({ doorsElsewhere: null });
    expect(await s.manifest()).not.toHaveProperty("doors_elsewhere");
  });
});
