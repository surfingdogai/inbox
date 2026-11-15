import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import { schema, ulid } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { aProduct, freshDb, openWeekdays } from "./harness";

/**
 * The public MCP lists the tools for the kinds the business takes here, and no others (ADR-048): an assistant
 * is never offered a door that refuses it. send_message is always listed, since it carries the replies on
 * items already made; the server's instructions say what to bring before anything new, and where the business
 * takes a kind instead.
 */
const BASE = "https://inbox.test";
const BOOKING_PAGE = "https://booking.example.com/oficina-mare";

async function setup() {
  const db = await freshDb();
  const app = createApp({ db });
  const owner = { authorization: `Bearer ${(await createApiKey(db, { kind: "owner", name: "cli" })).key}` };
  const ownerCall = (method: string, path: string, body: unknown) =>
    app.request(`${BASE}${path}`, {
      method,
      headers: { ...owner, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const server = async () => {
    const client = new Client({ name: "some-assistant", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        fetch: async (input: string | URL, init?: RequestInit) => app.request(String(input), init),
      }),
    );
    const tools = (await client.listTools()).tools;
    const instructions = client.getInstructions() ?? "";
    await client.close();
    return { names: tools.map((t) => t.name), tools, instructions };
  };
  const service = async (price?: { model: string; value?: number; currency?: string }) => {
    const now = Date.now();
    await db.orm.insert(schema.services).values({
      id: ulid(),
      name: "Full service",
      durationMin: 60,
      ...(price ? { price: price as never } : {}),
      createdAt: now,
      updatedAt: now,
    });
  };
  return { db, ownerCall, server, service };
}

const ORDER_TOOLS = ["create_order", "quote_shipping"];
const BOOKING_TOOLS = ["check_availability", "create_booking"];
const STAY_TOOLS = ["get_property", "check_stay_availability", "quote_stay", "request_stay", "hold_stay", "book_stay"];
const CONTACT_SENTENCE =
  "Before you send anything new here, ask your person for their name and an email address or a phone number, and send only what they agree to give this business, in contact (name, and email or phone). Never make them up or send your own: without them nothing is written.";

describe("the public MCP's tools", () => {
  it("on a fresh inbox: only messages, so no create tool but send_message, and the instructions say what to bring", async () => {
    const s = await setup();
    const { names, instructions } = await s.server();
    for (const t of [...BOOKING_TOOLS, ...ORDER_TOOLS, "request_quote", ...STAY_TOOLS]) expect(names).not.toContain(t);
    expect(names).toContain("send_message");
    expect(names).toContain("get_item_status");
    expect(instructions).toContain(CONTACT_SENTENCE);
    expect(instructions).toContain(
      "This business takes only what get_business_profile lists in item_types; there are no tools here for anything else.",
    );
    // Nothing to confirm before anything binds: no booking or order is taken here.
    expect(instructions).not.toContain("terms_sha answer");
  });

  it("adds the tools of each kind as the business comes to take it", async () => {
    const s = await setup();
    // A service with opening hours: bookings, and requests for a price about it.
    await s.service({ model: "fixed", value: 4500, currency: "EUR" });
    await openWeekdays(s.db);
    let { names, instructions } = await s.server();
    for (const t of [...BOOKING_TOOLS, "request_quote"]) expect(names).toContain(t);
    for (const t of ORDER_TOOLS) expect(names).not.toContain(t);
    expect(instructions).toContain("For a booking: check_availability, then create_booking");
    expect(instructions).toContain("A booking that carries a price binds your person only once they confirmed it");
    // A product at a fixed price: orders.
    await aProduct(s.db, { name: "Chain", value: 1850 });
    ({ names, instructions } = await s.server());
    for (const t of ORDER_TOOLS) expect(names).toContain(t);
    expect(instructions).toContain("For an order, each line names a product from list_products by productId");
    expect(instructions).toContain("A booking or an order that carries a price binds your person");
  });

  it("asks about a catalogue priced on request, and takes no order of it", async () => {
    const s = await setup();
    const now = Date.now();
    await s.db.orm.insert(schema.products).values({
      id: ulid(),
      name: "Wedding cake",
      price: { value: 0, currency: "EUR" },
      priceModel: "quote",
      createdAt: now,
      updatedAt: now,
    });
    const { names } = await s.server();
    expect(names).toContain("request_quote");
    for (const t of ORDER_TOOLS) expect(names).not.toContain(t);
  });

  it("keeps send_message for replies once the owner switches new messages off", async () => {
    const s = await setup();
    expect((await s.ownerCall("PUT", "/v1/owner/settings", { doc: { doors: { message: false } } })).status).toBe(200);
    const { tools } = await s.server();
    expect(tools.find((t) => t.name === "send_message")?.description).toBe(
      "Reply on an item you made (item_id). This business takes no new conversations here.",
    );
  });

  it("hides the booking tools while bookings are taken elsewhere, and names where in the instructions", async () => {
    const s = await setup();
    await s.service({ model: "fixed", value: 4500, currency: "EUR" });
    await openWeekdays(s.db);
    const set = await s.ownerCall("PUT", "/v1/owner/settings", {
      doc: { doorsElsewhere: [{ itemType: "booking", url: BOOKING_PAGE }] },
    });
    expect(set.status, await set.clone().text()).toBe(200);
    const { names, instructions } = await s.server();
    for (const t of BOOKING_TOOLS) expect(names).not.toContain(t);
    expect(names).toContain("request_quote");
    expect(instructions).toContain(
      `This business takes bookings at ${BOOKING_PAGE}, not here: send your person there.`,
    );
  });

  it("lists the stay tools only once the place has a room to offer", async () => {
    const s = await setup();
    const put = await s.ownerCall("PUT", "/v1/owner/property", {
      name: "Casa Lua",
      kind: "guesthouse",
      currency: "EUR",
    });
    expect(put.ok, await put.clone().text()).toBe(true);
    for (const t of STAY_TOOLS) expect((await s.server()).names).not.toContain(t);
    const room = await s.ownerCall("POST", "/v1/owner/property/rooms", {
      name: "Garden room",
      units: 1,
      capacity: { adults: 2, children: 0, total: 2 },
      beds: [{ type: "queen", count: 1 }],
    });
    expect(room.ok, await room.clone().text()).toBe(true);
    const { names } = await s.server();
    for (const t of STAY_TOOLS) expect(names).toContain(t);
  });
});
