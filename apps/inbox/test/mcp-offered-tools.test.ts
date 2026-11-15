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
  return { db, app, ownerCall, server, service };
}

const ORDER_TOOLS = ["create_order", "quote_shipping"];
const BOOKING_TOOLS = ["check_availability", "create_booking"];
const STAY_TOOLS = ["get_property", "check_stay_availability", "quote_stay", "request_stay", "hold_stay", "book_stay"];
/** What asks for a stay: listed only while the place takes stays here. */
const STAY_CREATES = ["request_stay", "hold_stay"];
/** What reads, and what follows a stay already made: listed for any place to stay. */
const STAY_READS = ["get_property", "check_stay_availability", "quote_stay", "book_stay", "change_stay"];
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

  it("names no tool it does not list: with requests for a price off, nothing sends the assistant to request_quote", async () => {
    const s = await setup();
    await aProduct(s.db, { name: "Chain", value: 1850 });
    expect((await s.ownerCall("PUT", "/v1/owner/settings", { doc: { doors: { quoteRequest: false } } })).status).toBe(
      200,
    );
    const { names, tools, instructions } = await s.server();
    expect(names).not.toContain("request_quote");
    expect(names).toContain("create_order");
    expect(instructions).not.toContain("request_quote");
    for (const t of tools) expect(t.description ?? "", t.name).not.toContain("request_quote");
    expect(tools.find((t) => t.name === "create_order")?.description).toContain(
      "is not ordered here: ask about it with send_message",
    );
    // The key every new request is sent with is said whatever the business takes, bookings or not.
    expect(instructions).toContain("never one made from the request itself");
  });

  it("keeps send_message for replies once the owner switches new messages off", async () => {
    const s = await setup();
    expect((await s.ownerCall("PUT", "/v1/owner/settings", { doc: { doors: { message: false } } })).status).toBe(200);
    const { tools } = await s.server();
    const message = tools.find((t) => t.name === "send_message");
    expect(message?.description).toBe(
      "Reply on an item you made (item_id). This business takes no new conversations here.",
    );
    // Its item_id says the same, never "omit to start a new conversation".
    const itemId = (message?.inputSchema as unknown as { properties: { item_id: { description?: string } } }).properties
      .item_id;
    expect(itemId.description).toBe("The item you made, to reply on: this business takes no new conversations here.");
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

  it("lists the stay tools that read for a place to stay, and those that ask for a stay once it has a room to offer", async () => {
    const s = await setup();
    for (const t of [...STAY_TOOLS, "change_stay"]) expect((await s.server()).names).not.toContain(t);
    const put = await s.ownerCall("PUT", "/v1/owner/property", {
      name: "Casa Lua",
      kind: "guesthouse",
      currency: "EUR",
    });
    expect(put.ok, await put.clone().text()).toBe(true);
    let { names, instructions } = await s.server();
    for (const t of STAY_READS) expect(names).toContain(t);
    for (const t of STAY_CREATES) expect(names).not.toContain(t);
    expect(instructions).toContain("This is a place to stay that takes no stays here.");
    const room = await s.ownerCall("POST", "/v1/owner/property/rooms", {
      name: "Garden room",
      units: 1,
      capacity: { adults: 2, children: 0, total: 2 },
      beds: [{ type: "queen", count: 1 }],
    });
    expect(room.ok, await room.clone().text()).toBe(true);
    ({ names, instructions } = await s.server());
    for (const t of STAY_TOOLS) expect(names).toContain(t);
    expect(instructions).toContain("hold_stay holds it");
  });

  it("keeps what is free when stays are taken at the property's own booking engine, with its page for the dates", async () => {
    const s = await setup();
    await s.ownerCall("PUT", "/v1/owner/property", { name: "Casa Lua", kind: "guesthouse", currency: "EUR" });
    const room = await s.ownerCall("POST", "/v1/owner/property/rooms", {
      name: "Garden room",
      units: 1,
      capacity: { adults: 2, children: 0, total: 2 },
      beds: [{ type: "queen", count: 1 }],
    });
    expect(room.ok, await room.clone().text()).toBe(true);
    const engine = "https://engine.example.net/lua";
    const set = await s.ownerCall("PUT", "/v1/owner/settings", {
      doc: {
        doorsElsewhere: [
          { itemType: "stay", url: engine, urlTemplate: `${engine}?in={check_in}&out={check_out}&adults={adults}` },
        ],
      },
    });
    expect(set.status, await set.clone().text()).toBe(200);
    const { names, instructions } = await s.server();
    for (const t of STAY_READS) expect(names).toContain(t);
    for (const t of STAY_CREATES) expect(names).not.toContain(t);
    expect(instructions).toContain("takes its stays on its own booking page, not here");
    // What is free names the page with the dates filled in, in the text an assistant reads.
    const client = new Client({ name: "some-assistant", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        fetch: async (input: string | URL, init?: RequestInit) => s.app.request(String(input), init),
      }),
    );
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const r = (await client.callTool({
      name: "check_stay_availability",
      arguments: { check_in: day(30), check_out: day(32), adults: 2 },
    })) as { isError?: boolean; content: { text: string }[]; structuredContent: { elsewhere?: string } };
    await client.close();
    const page = `${engine}?in=${day(30)}&out=${day(32)}&adults=2`;
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    expect(r.structuredContent.elsewhere).toBe(page);
    expect(r.content[0]?.text).toContain(`This property takes stays on its own booking page, not here: ${page}`);
  });
});
