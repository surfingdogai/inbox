import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import { MANIFEST_PATH, manifestSchema, readDoorsElsewhere, schema, ulid } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * Doors elsewhere that name their platform (spec 0.9.0, ADR-031), through the whole app: a hair studio in Toronto
 * whose bookings are at Fresha, and a pizzeria in São Paulo whose orders are in its own WooCommerce checkout. The
 * manifest, the profile over REST and MCP, the refusals and the business's own page all say where, by name. The
 * owner sets them with an owner key (`PUT /v1/owner/settings`) or in the owner app. Nothing calls a platform: a door
 * is a link. Node and workerd.
 */
const T0 = Date.parse("2026-10-20T14:00:00Z");
const BASE = "https://inbox.studiolumiere.ca";
const FRESHA = "https://www.fresha.com/a/studio-lumiere-toronto-queen-street-west-k3f8q2";
const DAY = "2026-10-21";

async function setup(kind: "studio" | "pizzeria") {
  const db = await freshDb();
  await db.orm.insert(schema.business).values({
    id: "self",
    name: kind === "studio" ? "Studio Lumière" : "Forno da Nonna Bia",
    domain: kind === "studio" ? "studiolumiere.ca" : "fornodanonnabia.com.br",
    timezone: kind === "studio" ? "America/Toronto" : "America/Sao_Paulo",
    currency: kind === "studio" ? "CAD" : "BRL",
    languages: kind === "studio" ? ["en", "fr"] : ["pt", "en"],
    createdAt: T0,
    updatedAt: T0,
  });
  const service = ulid(T0);
  await db.orm.insert(schema.services).values({
    id: service,
    name: kind === "studio" ? "Silk press" : "Pizza class",
    durationMin: 60,
    capacity: 1,
    granularityMin: 30,
    price: { model: "fixed", value: 8500, currency: kind === "studio" ? "CAD" : "BRL" },
    createdAt: T0,
    updatedAt: T0,
  });
  const ownerKey = (await createApiKey(db, { kind: "owner", name: "cli" })).key;
  const inbox = createInbox({ db, baseUrl: BASE, background: () => {} });
  const get = (path: string, headers: Record<string, string> = {}) =>
    inbox.app.request(new Request(`${BASE}${path}`, { headers }));
  const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    inbox.app.request(
      new Request(`${BASE}${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const settings = (doc: unknown) =>
    send("PUT", "/v1/owner/settings", { doc }, { authorization: `Bearer ${ownerKey}` });
  const open = () =>
    send(
      "PUT",
      "/v1/owner/availability",
      { weekly: { mon: [["09:00", "18:00"]], tue: [["09:00", "18:00"]] } },
      { authorization: `Bearer ${ownerKey}` },
    );
  const manifest = async () => manifestSchema.parse(await (await get(MANIFEST_PATH)).json());
  const mcp = async () => {
    const client = new Client({ name: "an-agent", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        fetch: async (input: string | URL | Request, init?: RequestInit) => inbox.app.request(String(input), init),
      }),
    );
    return client;
  };
  return { get, send, settings, open, manifest, mcp, service };
}

describe("a studio whose bookings are at Fresha", () => {
  it("names Fresha in its manifest and its profile, over REST and MCP", async () => {
    const s = await setup("studio");
    await s.open();
    const set = await s.settings({ doorsElsewhere: [{ itemType: "booking", url: FRESHA, platform: "fresha" }] });
    expect(set.status, await set.clone().text()).toBe(200);
    const m = await s.manifest();
    expect(m.item_types).toEqual(["message", "quote_request"]);
    expect(m.doors_elsewhere).toEqual([{ item_type: "booking", url: FRESHA, platform: "fresha" }]);
    expect(readDoorsElsewhere(m)).toEqual(m.doors_elsewhere);
    const profile = (await (await s.get("/v1/business")).json()) as { doors_elsewhere: unknown };
    expect(profile.doors_elsewhere).toEqual([{ item_type: "booking", url: FRESHA, platform: "fresha" }]);

    const agent = await s.mcp();
    const read = await agent.callTool({ name: "get_business_profile", arguments: {} });
    expect(JSON.stringify(read.content)).toContain(`Taken elsewhere: booking at Fresha, ${FRESHA}.`);
    expect((read.structuredContent as { doors_elsewhere: unknown }).doors_elsewhere).toEqual(profile.doors_elsewhere);
    await agent.close();
  });

  it("sends a customer's agent to Fresha by name, by REST, MCP and the page, and writes nothing", async () => {
    const s = await setup("studio");
    await s.open();
    await s.settings({ doorsElsewhere: [{ itemType: "booking", url: FRESHA, platform: "fresha" }] });
    const asked = {
      payload: {
        reservationFor: { serviceId: s.service, name: "Silk press" },
        startTime: `${DAY}T14:00:00Z`,
        endTime: `${DAY}T15:00:00Z`,
      },
      contact: { name: "Amara Okafor", email: "amara@example.ca" },
    };
    const refused = await s.send("POST", "/v1/bookings", asked);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      details: { reason: "taken_elsewhere", item_type: "booking", url: FRESHA, platform: "fresha", place: "Fresha" },
    });
    const agent = await s.mcp();
    const r = await agent.callTool({ name: "create_booking", arguments: asked });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain(`This business takes bookings at Fresha (${FRESHA}), not here`);
    await agent.close();
    const html = await (await s.get("/", { "accept-language": "en" })).text();
    expect(html).toContain(`<a href="${FRESHA}" rel="noopener noreferrer">Book at Fresha</a>`);
  });

  it("refuses a link that is not the studio's own page on the platform it names, saying why", async () => {
    const s = await setup("studio");
    const wrong = await s.settings({
      doorsElsewhere: [{ itemType: "booking", url: "https://www.fresha.com/", platform: "fresha" }],
    });
    expect(wrong.status).toBe(422);
    const problem = (await wrong.json()) as { fields?: { path: string; message: string }[] };
    expect(problem.fields).toContainEqual(
      expect.objectContaining({
        path: "doc.doorsElsewhere.0.url",
        message: "that is Fresha's own page: paste the link to your business's page on Fresha",
      }),
    );
    const tracked = await s.settings({
      doorsElsewhere: [{ itemType: "booking", url: `${FRESHA}?utm_source=instagram`, platform: "fresha" }],
    });
    expect(tracked.status).toBe(422);
    expect(await s.manifest()).not.toHaveProperty("doors_elsewhere");
  });
});

describe("a pizzeria whose orders are in its own WooCommerce checkout", () => {
  const CHECKOUT = "https://fornodanonnabia.com.br/loja/";

  it("names the checkout by its own host, keeps WooCommerce for agents, and holds it to its own domain", async () => {
    const s = await setup("pizzeria");
    const set = await s.settings({ doorsElsewhere: [{ itemType: "order", url: CHECKOUT, platform: "woocommerce" }] });
    expect(set.status, await set.clone().text()).toBe(200);
    expect((await s.manifest()).doors_elsewhere).toEqual([
      { item_type: "order", url: CHECKOUT, platform: "woocommerce" },
    ]);
    const html = await (await s.get("/", { "accept-language": "en" })).text();
    expect(html).toContain(`<a href="${CHECKOUT}" rel="noopener noreferrer">Order at fornodanonnabia.com.br</a>`);
    const stranger = await s.settings({
      doorsElsewhere: [
        { itemType: "order", url: "https://another-pizzeria.example.com/loja/", platform: "woocommerce" },
      ],
    });
    expect(stranger.status).toBe(422);
    expect(JSON.stringify(await stranger.json())).toContain(
      "that link is not on your website (fornodanonnabia.com.br)",
    );
  });
});

describe("the API's own description", () => {
  it("documents the platform on the business profile's doors elsewhere", async () => {
    const s = await setup("studio");
    const doc = JSON.stringify(await (await s.get("/openapi.json")).json());
    expect(doc).toContain("vocab/door-platforms.json");
  });
});
