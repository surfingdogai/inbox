import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import { schema } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { type App, createApp } from "../src/app";
import { freshDb } from "./harness";

/**
 * The trades doors (ADR-034) as an agent and the owner meet them, on both runtimes: check_area over MCP
 * and REST; a request with its job and photos, inline over MCP and uploaded first over REST; HEIC
 * refused with what to send; the owner's short-lived links to the files, served with headers that
 * run nothing; and the area's base in no answer. Southern Cross Renovations, Perth (AUD), works in
 * postcodes 60 and 61; Elektro Brandt, Leipzig (EUR), within 25 km of where it set out from.
 */

const T0 = Date.parse("2026-11-04T01:30:00Z");
const BASE = "https://scr.example";
const SECRET = "trades-doors-secret-key-0123456789abcdef";

const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9,
]);
const HEIC = Uint8Array.from([
  0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69,
  0x63,
]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function setup(settings: Record<string, unknown>) {
  const db = await freshDb();
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Southern Cross Renovations",
    timezone: "Australia/Perth",
    currency: "AUD",
    createdAt: T0,
    updatedAt: T0,
  });
  const app = createApp({ db, secretKey: SECRET, baseUrl: BASE });
  const owner = await createApiKey(db, { kind: "owner", name: "test" });
  const auth = { authorization: `Bearer ${owner.key}` };
  const put = await app.request(`${BASE}/v1/owner/settings`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ doc: { doors: { quoteRequest: true }, ...settings } }),
  });
  expect(put.status, await put.clone().text()).toBe(200);
  return { db, app, auth };
}

async function mcp(app: App) {
  const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> =>
    app.request(String(input), init);
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { fetch: fetchLike }));
  return client;
}

const perth = {
  area: {
    mode: "postal",
    postal: [
      { country: "AU", prefix: "60" },
      { country: "AU", prefix: "61" },
    ],
    outside: "decline",
  },
};

describe("check_area", () => {
  it("answers over MCP and REST, in the business's words, with no base anywhere", async () => {
    const s = await setup(perth);
    const client = await mcp(s.app);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("check_area");
    const r = (await client.callTool({ name: "check_area", arguments: { postal_code: "6050", country: "AU" } })) as {
      structuredContent?: { answer?: string; words?: string };
    };
    expect(r.structuredContent?.answer).toBe("inside");
    expect(r.structuredContent?.words).toContain("Southern Cross Renovations works in 60, 61");
    const rest = await s.app.request(`${BASE}/v1/area?postal_code=2000&country=AU`);
    expect(await rest.json()).toMatchObject({ answer: "outside", area: { mode: "postal" } });
    const none = await s.app.request(`${BASE}/v1/area?country=AU`);
    expect(none.status).toBe(422);
  });

  it("is asked at most twenty times at once from one address, so nobody can ask round the edge", async () => {
    const s = await setup(perth);
    const ask = () =>
      s.app.request(`${BASE}/v1/area?postal_code=6050&country=AU`, { headers: { "cf-connecting-ip": "203.0.113.50" } });
    for (let i = 0; i < 20; i++) expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(429);
    // Another address is not held back by it.
    const other = await s.app.request(`${BASE}/v1/area?postal_code=6050&country=AU`, {
      headers: { "cf-connecting-ip": "198.51.100.61" },
    });
    expect(other.status).toBe(200);
  });

  it("is not offered where the business says nothing of where it works", async () => {
    const s = await setup({});
    const names = (await (await mcp(s.app)).listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("check_area");
  });

  it("keeps the base of a radius out of the profile and every answer", async () => {
    const s = await setup({
      area: { mode: "radius", radiusKm: 25, base: { from: "device", point: { lat: 51.34, lng: 12.375 } } },
    });
    const profile = await (await s.app.request(`${BASE}/v1/business`)).json();
    expect(profile).toMatchObject({ work: { area: { mode: "radius", radius_km: 25 } } });
    expect(JSON.stringify(profile)).not.toContain("12.375");
    const manifest = await (await s.app.request(`${BASE}/.well-known/agent-inbox.json`)).text();
    expect(manifest).not.toContain("12.375");
  });
});

describe("a request's files", () => {
  it("come inline over MCP, and the owner sees them through links that work for ten minutes", async () => {
    const s = await setup(perth);
    const client = await mcp(s.app);
    const r = (await client.callTool({
      name: "request_quote",
      arguments: {
        payload: {
          itemOffered: { name: "Bathroom renovation" },
          description: "Retile and replace the vanity.",
          job: {
            urgency: "flexible",
            visit: "needed",
            site: { address: { postalCode: "6050", addressCountry: "AU" } },
          },
        },
        contact: { name: "Mia Nguyen", email: "mia@example.com" },
        attachments: [{ data_base64: b64(JPEG), name: "bathroom.jpg" }],
      },
    })) as { isError?: boolean; structuredContent?: { view?: { item?: { id?: string } } } };
    expect(r.isError).toBeFalsy();
    const id = r.structuredContent?.view?.item?.id ?? "";
    const files = (await (await s.app.request(`${BASE}/v1/owner/items/${id}/files`, { headers: s.auth })).json()) as {
      files: { url: string; name: string }[];
    };
    expect(files.files.map((f) => f.name)).toEqual(["bathroom.jpg"]);
    const got = await s.app.request(`${BASE}${files.files[0]?.url}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/jpeg");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("content-security-policy")).toContain("sandbox");
    // The same link with another file's id, or no signature, serves nothing.
    expect(
      (await s.app.request(`${BASE}${files.files[0]?.url.replace(/att_[^?]+/, "att_xxxxxxxxxxxxxxxxxxxxxxxx")}`))
        .status,
    ).toBe(404);
    expect((await s.app.request(`${BASE}${files.files[0]?.url.split("?")[0]}`)).status).toBe(404);
    // A customer's agent has no way to the list.
    expect((await s.app.request(`${BASE}/v1/owner/items/${id}/files`)).status).toBe(401);
  });

  it("can be uploaded first over REST and named by the request; HEIC is refused with what to send", async () => {
    const s = await setup(perth);
    const up = await s.app.request(`${BASE}/v1/uploads`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": "plan%20view.pdf" },
      body: new TextEncoder().encode("%PDF-1.7\n%%EOF\n"),
    });
    expect(up.status, await up.clone().text()).toBe(201);
    const { upload_id, attachment } = (await up.json()) as {
      upload_id: string;
      attachment: { name: string; content_type: string };
    };
    expect(attachment).toMatchObject({ name: "plan view.pdf", content_type: "application/pdf" });
    const q = await s.app.request(`${BASE}/v1/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: { itemOffered: { name: "Deck" }, description: "A timber deck, 20 m²." },
        contact: { name: "Mia Nguyen", email: "mia@example.com" },
        attachments: [{ upload_id }],
      }),
    });
    expect(q.status, await q.clone().text()).toBe(201);
    const heic = await s.app.request(`${BASE}/v1/uploads`, { method: "POST", body: HEIC });
    expect(heic.status).toBe(422);
    expect(((await heic.json()) as { detail: string }).detail).toContain("Send it as a JPEG");
  });
});
