import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { BASE, ok, type Setup, setup } from "./stay-harness";

/**
 * A place to stay's doors in the whole app (ADR-037 §6): its tools listed to guests' assistants once
 * it has a room to offer, and never before; the business's own page carrying the place as schema.org
 * reads it, in a data block nothing runs; and the owner told of each stay's moments in their words.
 */
async function connect(s: Setup, path: string) {
  const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> =>
    s.inbox.app.request(String(input), init);
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}${path}`), { fetch: fetchLike });
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(transport);
  return client;
}

const STAY_TOOLS = [
  "get_property",
  "check_stay_availability",
  "quote_stay",
  "request_stay",
  "hold_stay",
  "book_stay",
  "change_stay",
];

async function casaLua(s: Setup, name = "Casa Lua") {
  await ok(s.owner("PUT", "/v1/owner/property", { name, kind: "guesthouse", currency: "MXN" }));
  const room = await ok<{ id: string }>(
    s.owner("POST", "/v1/owner/property/rooms", {
      name: "Cuarto del jardín",
      units: 2,
      capacity: { adults: 2, children: 1, total: 3 },
      beds: [{ type: "queen", count: 1 }],
    }),
  );
  const plan = await ok<{ id: string }>(s.owner("POST", "/v1/owner/property/rate-plans", { name: "Flexible" }));
  await ok(
    s.owner("PUT", "/v1/owner/property/rates", {
      rate_plan_id: plan.id,
      room_type_id: room.id,
      nightly: 145_000,
      base_guests: 2,
    }),
  );
  return { room: room.id, plan: plan.id };
}

describe("a place to stay's doors", () => {
  it("lists the stays tools once there is a room to offer, and not before", async () => {
    const s = await setup({ name: "Casa Lua", timezone: "America/Mexico_City", currency: "MXN" });
    const before = (await (await connect(s, "/mcp")).listTools()).tools.map((t) => t.name);
    for (const t of STAY_TOOLS) expect(before).not.toContain(t);
    await casaLua(s);
    const after = (await (await connect(s, "/mcp")).listTools()).tools.map((t) => t.name);
    for (const t of STAY_TOOLS) expect(after).toContain(t);
    const property = await (await connect(s, "/mcp")).callTool({ name: "get_property", arguments: {} });
    expect(JSON.stringify(property.structuredContent ?? property.content)).toContain("Cuarto del jardín");
  });

  it("puts the place on its own page as schema.org reads it, in one data block, escaped", async () => {
    const s = await setup({ name: "Casa Lua", timezone: "America/Mexico_City", currency: "MXN" });
    await casaLua(s, "Casa </script><b>Lua");
    const r = await s.inbox.app.request(new Request(`${BASE}/`, { headers: { accept: "text/html" } }));
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toContain("</script><b>");
    const block = html.match(/<script type="application\/ld\+json">([^<]*)<\/script>/)?.[1] ?? "";
    const ld = JSON.parse(block) as Record<string, unknown>;
    expect(ld).toMatchObject({
      "@context": "https://schema.org",
      "@type": "LodgingBusiness",
      name: "Casa </script><b>Lua",
      containsPlace: [{ "@type": "HotelRoom", name: "Cuarto del jardín", occupancy: { maxValue: 3 } }],
    });
    // On request: the price is the property's answer, so there is no offer to take.
    expect(ld).not.toHaveProperty("makesOffer");
  });

  it("speaks the business's own language and keeps its zone, as its profile gives them", async () => {
    const s = await setup({ name: "Casa Lua", timezone: "UTC", currency: "MXN" });
    await ok(
      s.owner("PUT", "/v1/owner/profile", {
        name: "Casa Lua",
        timezone: "America/Mexico_City",
        currency: "MXN",
        languages: ["es", "en"],
      }),
    );
    const { room } = await casaLua(s);
    const { rows } = await s.db.client.query({ sql: "SELECT timezone FROM locations", params: [], method: "all" });
    expect(rows.map((r) => String(r[0]))).toEqual(["America/Mexico_City"]);
    const day = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    const out = new Date(Date.now() + 43 * 86_400_000).toISOString().slice(0, 10);
    const made = await ok<{ view: { item: { id: string } } }>(
      s.guest("POST", "/v1/stays", {
        check_in: day,
        check_out: out,
        rooms: [{ room_type_id: room, adults: 2 }],
        contact: { name: "Itzel M.", email: "itzel@example.org" },
        consent: true,
      }),
      201,
    );
    const quoted = await ok<{ view: { item: { payload: { quote: { lines: { label: string }[] } } } } }>(
      s.owner("POST", `/v1/owner/items/${made.view.item.id}/transitions`, { event: "quote", input: { from: "rates" } }),
    );
    expect(quoted.view.item.payload.quote.lines[0]?.label).toMatch(/3 noches/);
    // Its email, and the page behind the email's link, speak Spanish too.
    await s.drain();
    const mail = s.mail.sent.find((m) => m.to.includes("itzel@example.org"));
    const link = mail?.text.match(/https:\/\/\S+\/c\/\S+/)?.[0] ?? "";
    const page = await (await s.inbox.app.request(new Request(link, { headers: { accept: "text/html" } }))).text();
    expect(page).toContain('lang="es"');
    expect(page).toContain("Reservar con obligación de pago");
  });

  it("tells the owner of a stay's moments in their words", async () => {
    const s = await setup({ name: "Casa Lua", timezone: "America/Mexico_City", currency: "MXN" });
    await ok(s.owner("PUT", "/v1/owner/settings", { doc: { notifications: { ownerEmail: "host@example.net" } } }));
    const { room } = await casaLua(s);
    const day = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    const out = new Date(Date.now() + 42 * 86_400_000).toISOString().slice(0, 10);
    const made = await ok<{ view: { item: { id: string } }; accessToken: string }>(
      s.guest("POST", "/v1/stays", {
        check_in: day,
        check_out: out,
        rooms: [{ room_type_id: room, adults: 2 }],
        contact: { name: "Lucía R.", email: "lucia@example.org" },
        requests: "Vegetarian breakfast, please; we land at 19:00.",
        consent: true,
      }),
      201,
    );
    const id = made.view.item.id;
    await s.drain();
    const { rows: first } = await s.db.client.query({
      sql: "SELECT subject, body_text FROM outbound_mail WHERE recipient = 'owner' AND item_id = ? ORDER BY rowid",
      params: [id],
      method: "all",
    });
    // In the owner's words: who, when, how many, which room, what they wrote, by when you answer, and the
    // guest's own short reference; never "the business".
    const body = String(first[0]?.[1] ?? "");
    expect(String(first[0]?.[0])).toMatch(/^Stay request: Lucía R\., .+, 2 nights$/);
    expect(body).toMatch(/^Lucía R\. asks for .+ \(2 nights\), 2 adults, /);
    expect(body).toContain("They wrote: “Vegetarian breakfast, please; we land at 19:00.”");
    expect(body).toMatch(/You answer within \d+ hours?\. Reference [0-9A-Z]{6}\./);
    // The link to open it names the item; the words name only the guest's short reference.
    expect(body.split("\nOpen:")[0]).not.toMatch(/the business|\b[0-9A-HJKMNP-TV-Z]{26}\b/);
    await ok(s.owner("POST", `/v1/owner/items/${id}/transitions`, { event: "quote", input: { from: "rates" } }));
    const asked = await s.guest("POST", `/v1/items/${id}/accept`, { access_token: made.accessToken });
    const sha = ((await asked.json()) as { details: { terms_sha: string } }).details.terms_sha;
    await ok(s.guest("POST", `/v1/items/${id}/accept`, { access_token: made.accessToken, terms_sha: sha }));
    await s.drain();
    const { rows } = await s.db.client.query({
      sql: "SELECT template, subject FROM outbound_mail WHERE recipient = 'owner' AND item_id = ? ORDER BY rowid",
      params: [id],
      method: "all",
    });
    const subjects = rows.map((r) => [String(r[0]), String(r[1])]);
    expect(subjects[0]?.[1]).toMatch(/^Stay request: Lucía R\./);
    expect(subjects.find(([t]) => t?.startsWith("owner.accept"))?.[1]).toMatch(/^Lucía R\. accepted your quote/);
  });
});
