import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import { type Caller, schema, ulid } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { base64, textPng } from "../../../packages/core/test/trades-files";
import { createInbox } from "../src/app";
import { aProduct, freshDb, onTheGrid, openAllWeek } from "./harness";

/**
 * Every new request carries its client, on every door (ADR-048): an assistant's, or any other client's of the
 * REST, MCP and stays doors, new booking, order, request for a price, message or stay names its person and an
 * email address or a phone number, or it is refused with the same words everywhere and nothing is written. The
 * tool list and /openapi.json say what to bring before anything is sent. The business's own keys, a person's
 * email, a website's form and the business's own page are never refused for it.
 */
const BASE = "https://inbox.oficinamare.example";
const INBOUND = "client-details-inbound-secret-0123456789";
const DAY = 86_400_000;
const date = (t: number) => new Date(t).toISOString().slice(0, 10);
const RITA = { name: "Rita Silva", email: "rita@example.com" };

const ownerCaller: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
};

async function setup(o: { demo?: boolean } = {}) {
  const db = await freshDb();
  const mail = logMailOut();
  const inbox = createInbox({
    db,
    mailOut: mail,
    baseUrl: BASE,
    secretKey: "client-details-test-secret-0123456789ab",
    eventSettleMs: 0,
    background: () => {},
    ...(o.demo
      ? {
          ownerEmails: ["owner@example.com"],
          demo: { ownerEmails: ["owner@example.com"], from: { address: "demo@demo.test", name: "Demo" } },
        }
      : {}),
  });
  if (o.demo) await inbox.prepare();
  const owner = { authorization: `Bearer ${(await createApiKey(db, { kind: "owner", name: "cli" })).key}` };
  const integration = {
    authorization: `Bearer ${(await createApiKey(db, { kind: "integration", name: "Till", scopes: ["*"] })).key}`,
  };
  const forms = {
    authorization: `Bearer ${(await createApiKey(db, { kind: "integration", name: "Website forms", scopes: ["forms:submit"] })).key}`,
  };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    inbox.app.request(
      new Request(`${BASE}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const mcp = async () => {
    const client = new Client({ name: "some-assistant", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        fetch: async (input: string | URL, init?: RequestInit) => inbox.app.request(String(input), init),
      }),
    );
    return client;
  };
  const count = async (table: string) =>
    Number((await db.client.query({ sql: `SELECT COUNT(*) FROM ${table}`, method: "all" })).rows[0]?.[0]);
  return { db, mail, inbox, owner, integration, forms, call, mcp, count };
}

/** A workshop that takes every kind: a priced service with hours, a product, and a room it confirms at once. */
async function workshop() {
  const s = await setup();
  const now = Date.now();
  await s.db.orm.insert(schema.business).values({
    id: "self",
    name: "Oficina Maré",
    timezone: "UTC",
    currency: "EUR",
    createdAt: now,
    updatedAt: now,
  });
  const svc = ulid();
  await s.db.orm.insert(schema.services).values({
    id: svc,
    name: "Full service",
    durationMin: 60,
    price: { model: "fixed", value: 4500, currency: "EUR" },
    createdAt: now,
    updatedAt: now,
  });
  await openAllWeek(s.db);
  const chain = await aProduct(s.db, { name: "Chain", value: 1850 });
  const saved = await s.call(
    "PUT",
    "/v1/owner/settings",
    { doc: { business: { name: "Oficina Maré" }, email: { inboundSecret: INBOUND } } },
    s.owner,
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
  const stays = s.inbox.caps.stays;
  await stays.upsertProperty(ownerCaller, {
    name: "Casa Maré",
    kind: "guesthouse",
    currency: "EUR",
    mode: "allotment",
  });
  const { id: room } = await stays.upsertRoomType(ownerCaller, {
    name: "Harbour room",
    units: 4,
    capacity: { adults: 2, children: 0, total: 2 },
    beds: [{ type: "queen", count: 1 }],
  });
  const { id: plan } = await stays.upsertRatePlan(ownerCaller, {
    name: "Flexible",
    meal: "breakfast",
    policy: { preset: "free_until", days: 7, after: "first_night", no_show: "full" },
    deposit: { kind: "none" },
  });
  await stays.setRates(ownerCaller, { rate_plan_id: plan, room_type_id: room, nightly: 9_000, base_guests: 2 });
  await stays.setAllotment(ownerCaller, {
    room_type_id: room,
    from_date: date(now),
    to_date: date(now + 90 * DAY),
    units: 4,
    closed_elsewhere: true,
  });
  const start = onTheGrid(now + 3 * DAY);
  const bodies = {
    "/v1/quotes": { payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel, 28 spokes" } },
    "/v1/bookings": {
      payload: {
        reservationFor: { serviceId: svc, name: "Full service" },
        startTime: new Date(start).toISOString(),
        endTime: new Date(start + 3_600_000).toISOString(),
      },
    },
    "/v1/orders": { payload: { orderedItem: [{ productId: chain, quantity: 1 }] } },
    "/v1/messages": { body: "Do you true wheels?" },
    "/v1/stays": {
      check_in: date(now + 30 * DAY),
      check_out: date(now + 32 * DAY),
      rooms: [{ room_type_id: room, adults: 2 }],
      consent: true,
    },
    "/v1/stays/holds": {
      check_in: date(now + 40 * DAY),
      check_out: date(now + 42 * DAY),
      rooms: [{ room_type_id: room, adults: 2 }],
      consent: true,
    },
  } as const;
  const tools = {
    request_quote: bodies["/v1/quotes"],
    create_booking: {
      payload: {
        ...bodies["/v1/bookings"].payload,
        startTime: new Date(start + 2 * 3_600_000).toISOString(),
        endTime: new Date(start + 3 * 3_600_000).toISOString(),
      },
    },
    create_order: bodies["/v1/orders"],
    send_message: bodies["/v1/messages"],
    request_stay: { ...bodies["/v1/stays"], check_in: date(now + 50 * DAY), check_out: date(now + 52 * DAY) },
    hold_stay: { ...bodies["/v1/stays/holds"], check_in: date(now + 60 * DAY), check_out: date(now + 62 * DAY) },
  } as const;
  return { ...s, svc, chain, room, bodies, tools };
}

type Problem = { code: string; detail: string; details?: Record<string, unknown>; fields?: { path: string }[] };

describe("REST", () => {
  it("refuses each new request without its client, as a problem naming what to add, and takes it with one", async () => {
    const s = await workshop();
    for (const [path, body] of Object.entries(s.bodies)) {
      const res = await s.call("POST", path, body);
      expect(res.status, path).toBe(422);
      expect(res.headers.get("content-type"), path).toContain("application/problem+json");
      const p = (await res.json()) as Problem;
      expect(p.code, path).toBe("invalid_input");
      expect(p.details, path).toMatchObject({ reason: "client_details", missing: ["name", "email_or_phone"] });
      expect(p.detail, path).toMatch(/^To take this (booking|order|request for a price|message|stay) we need/);
      expect(
        p.fields?.map((f) => f.path),
        path,
      ).toEqual(["contact.name", "contact.email"]);
    }
    expect(await s.count("items")).toBe(0);
    for (const [path, body] of Object.entries(s.bodies)) {
      const res = await s.call("POST", path, { ...body, contact: RITA });
      expect([201, 409], `${path} ${await res.clone().text()}`).toContain(res.status);
      if (res.status === 409) expect(((await res.json()) as Problem).code, path).toBe("confirm_terms");
    }
  });

  it("refuses a request a network says it carried without its person's name, and marks one with it", async () => {
    const s = await workshop();
    const carried = { "Surfing-Dog-Carried": "1", "Surfing-Dog-Carried-For": "a1b2c3d4e5f6a7b8c9d0e1" };
    const nameless = await s.call(
      "POST",
      "/v1/messages",
      { body: "Are you open on Saturday?", contact: { email: "ana@example.com" } },
      carried,
    );
    expect(nameless.status).toBe(422);
    expect(((await nameless.json()) as Problem).details).toMatchObject({ reason: "client_details", missing: ["name"] });
    const named = await s.call(
      "POST",
      "/v1/messages",
      { body: "Are you open on Saturday?", contact: { name: "Ana", email: "ana@example.com" } },
      carried,
    );
    expect(named.status).toBe(201);
    const id = ((await named.json()) as { view: { item: { id: string } } }).view.item.id;
    const { rows } = await s.db.client.query({
      sql: "SELECT flags FROM items WHERE id = ?",
      params: [id],
      method: "all",
    });
    expect(JSON.parse(String(rows[0]?.[0]))).toMatchObject({ carried: true });
  });

  it("refuses a key that may not write items, a website's forms key or a read-only one, on every door that makes something new", async () => {
    const s = await workshop();
    const readOnly = {
      authorization: `Bearer ${(await createApiKey(s.db, { kind: "integration", name: "Dashboard", scopes: ["inbox:read", "events:read", "settings:read"] })).key}`,
    };
    // As it arrived, and with a client: neither key writes anything as the business.
    const incident = {
      "/v1/orders": {
        payload: {
          orderedItem: [{ name: "audit-fixturex", quantity: 1, price: { value: 1, currency: "AUD" } }],
          totalPrice: { value: 1, currency: "AUD" },
        },
      },
      "/v1/quotes": { payload: { itemOffered: { name: "audit-fixturex" }, description: "audit-fixturex" } },
      "/v1/messages": { body: "audit-fixturex" },
    };
    for (const key of [s.forms, readOnly]) {
      for (const [path, body] of [...Object.entries(incident), ...Object.entries(s.bodies)]) {
        const res = await s.call("POST", path, { ...body, contact: RITA }, key);
        expect(res.status, `${path} ${await res.clone().text()}`).toBe(403);
        expect(((await res.json()) as Problem).details, path).toMatchObject({
          reason: "outside_scopes",
          required_scopes: ["inbox:write"],
        });
      }
    }
    // Through the public MCP too.
    const client = new Client({ name: "dashboard", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        fetch: async (input: string | URL, init?: RequestInit) =>
          s.inbox.app.request(String(input), {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...readOnly },
          }),
      }),
    );
    const r = (await client.callTool({
      name: "create_order",
      arguments: { ...s.tools.create_order, contact: RITA },
    })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("inbox:write");
    await client.close();
    expect(await s.count("items")).toBe(0);
    expect(await s.count("blobs")).toBe(0);
    // A key that may write items still writes them down as the business.
    const automation = {
      authorization: `Bearer ${(await createApiKey(s.db, { kind: "integration", name: "Zapier", scopes: ["inbox:read", "inbox:write", "events:read"] })).key}`,
    };
    const made = await s.call(
      "POST",
      "/v1/messages",
      { body: "Called about wheels", idempotency_key: ulid() },
      automation,
    );
    expect(made.status, await made.clone().text()).toBe(201);
  });

  it("lets the business's own keys write a booking down with no client", async () => {
    const s = await workshop();
    for (const key of [s.owner, s.integration]) {
      const res = await s.call(
        "POST",
        "/v1/bookings",
        { payload: s.tools.create_booking.payload, idempotency_key: ulid() },
        key,
      );
      expect(res.status, await res.clone().text()).toBe(201);
    }
  });

  it("judges what was sent by the client rule on every door, in the same words: a bad address, a long name, a blank email", async () => {
    const s = await workshop();
    const client = await s.mcp();
    const wrong = [
      { contact: { name: "Rita", email: "rita@" }, invalid: ["email"] },
      { contact: { name: "R".repeat(201), phone: "+351 912 345 678" }, invalid: ["name"] },
      { contact: { name: "Rita", phone: "9".repeat(41) }, invalid: ["phone"] },
    ];
    for (const { contact, invalid } of wrong) {
      const res = await s.call("POST", "/v1/bookings", { ...s.bodies["/v1/bookings"], contact });
      expect(res.status, JSON.stringify(contact)).toBe(422);
      const p = (await res.json()) as Problem;
      expect(p.details, JSON.stringify(contact)).toMatchObject({ reason: "client_details", missing: [], invalid });
      expect(p.detail).toMatch(/^To take this booking we need your person's details as they give them\. contact\./);
      const r = (await client.callTool({
        name: "create_booking",
        arguments: { ...s.tools.create_booking, contact },
      })) as { isError?: boolean; content: { text: string }[]; structuredContent?: { error?: Problem } };
      expect(r.isError).toBe(true);
      expect(r.content[0]?.text).toMatch(/^Invalid input: To take this booking we need your person's details/);
      expect(r.structuredContent?.error?.details).toMatchObject({ reason: "client_details", invalid });
    }
    await client.close();
    // A blank email beside a phone is no email: the phone is enough. Stored trimmed.
    const res = await s.call("POST", "/v1/messages", {
      body: "Open on Saturday?",
      contact: { name: "  Rita Silva ", email: "", phone: " +351 912 345 678 " },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { rows } = await s.db.client.query({ sql: "SELECT display_name, contact FROM parties", method: "all" });
    expect(rows[0]?.[0]).toBe("Rita Silva");
    expect(JSON.parse(String(rows[0]?.[1]))).toMatchObject({ name: "Rita Silva", phone: "+351 912 345 678" });
    // The business's own key is held to an address that is one, in the same words, and asked for nothing else.
    const own = await s.call("POST", "/v1/messages", { body: "Called", contact: { email: "rita@" } }, s.integration);
    expect(own.status).toBe(422);
    expect(((await own.json()) as Problem).details).toMatchObject({ reason: "client_details", invalid: ["email"] });
  });

  it("says what to bring in /openapi.json", async () => {
    const s = await workshop();
    const doc = (await (await s.call("GET", "/openapi.json")).json()) as Record<string, unknown>;
    const resolve = (node: unknown): Record<string, unknown> => {
      let n = node as Record<string, unknown>;
      while (typeof n?.$ref === "string") {
        const path = (n.$ref as string).replace(/^#\//, "").split("/");
        n = path.reduce<unknown>((at, k) => (at as Record<string, unknown>)?.[k], doc) as Record<string, unknown>;
      }
      return n;
    };
    for (const path of ["/v1/quotes", "/v1/bookings", "/v1/orders", "/v1/stays", "/v1/stays/holds"]) {
      const op = (doc.paths as Record<string, Record<string, { requestBody: unknown }>>)[path]?.post;
      expect(op, path).toBeDefined();
      const content = (op?.requestBody as { content?: Record<string, { schema: unknown }> } | undefined)?.content;
      const body = resolve(content?.["application/json"]?.schema);
      expect(body.required, path).toContain("contact");
      const contact = resolve((body.properties as Record<string, unknown>).contact);
      expect(contact.required, path).toEqual(["name"]);
    }
    expect(JSON.stringify(doc)).toContain("Needs contact: your person's name, and an email address or a phone number");
  });
});

describe("MCP", () => {
  it("lists what to bring, and refuses each new request without it in the same words, taking it with them", async () => {
    const s = await workshop();
    const client = await s.mcp();
    const listed = (await client.listTools()).tools;
    const creates = ["request_quote", "create_booking", "create_order", "request_stay", "hold_stay"];
    for (const name of creates) {
      const t = listed.find((x) => x.name === name);
      const input = t?.inputSchema as { required?: string[]; properties: Record<string, { required?: string[] }> };
      expect(input.required, name).toContain("contact");
      expect(input.properties.contact?.required, name).toEqual(["name"]);
      expect(t?.description, name).toContain("name and an email address or a phone number");
    }
    const message = listed.find((t) => t.name === "send_message");
    expect((message?.inputSchema as { required?: string[] } | undefined)?.required ?? []).not.toContain("contact");
    expect(message?.description).toContain("name and an email address or a phone number");
    for (const [name, args] of Object.entries(s.tools)) {
      const r = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(r.isError, name).toBe(true);
      expect(r.content[0]?.text, name).toMatch(/^Invalid input: To take this /);
      // What each detail needs, said in full: an email or a phone will do.
      expect(r.content[0]?.text, name).toContain(
        "Fix: contact.name (missing: your person's name, as they give it), contact.email (missing: an email address, or a phone number in contact.phone).",
      );
    }
    expect(await s.count("items")).toBe(0);
    for (const [name, args] of Object.entries(s.tools)) {
      const r = (await client.callTool({ name, arguments: { ...args, contact: RITA } })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(r.isError, `${name}: ${r.content[0]?.text}`).toBeFalsy();
    }
    await client.close();
  });

  it("keeps no file of a trade's request for a price that names nobody, and takes it with its person", async () => {
    const s = await workshop();
    const saved = await s.call("PUT", "/v1/owner/settings", { doc: { doors: { quoteRequest: true } } }, s.owner);
    expect(saved.status).toBe(200);
    const client = await s.mcp();
    const args = {
      payload: {
        itemOffered: { name: "Leaking kitchen tap" },
        description: "The tap under the sink drips all night.",
        job: { urgency: "this_week", visit: "needed" },
      },
      attachments: [{ data_base64: base64(textPng()), name: "tap.png" }],
    };
    const refused = (await client.callTool({ name: "request_quote", arguments: args })) as { isError?: boolean };
    expect(refused.isError).toBe(true);
    expect(await s.count("blobs")).toBe(0);
    const taken = (await client.callTool({ name: "request_quote", arguments: { ...args, contact: RITA } })) as {
      isError?: boolean;
    };
    expect(taken.isError).toBeFalsy();
    expect(await s.count("blobs")).toBe(1);
    await client.close();
  });
});

describe("people, who are never refused for it", () => {
  it("by email: with no display name the address stands for them; an address as a name is no name", async () => {
    const s = await workshop();
    const mime = (from: string, id: string) =>
      [
        `From: ${from}`,
        "To: Oficina Maré <inbox@oficinamare.example>",
        "Subject: Wheels",
        `Message-ID: <${id}@example.com>`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Do you true wheels?",
      ].join("\r\n");
    const inbound = (raw: string) =>
      s.inbox.app.request(
        new Request(`${BASE}/v1/email/inbound`, {
          method: "POST",
          headers: { "x-inbox-email-secret": INBOUND, "content-type": "message/rfc822" },
          body: raw,
        }),
      );
    const party = async (email: string) => {
      const { rows } = await s.db.client.query({
        sql: "SELECT p.display_name, p.contact FROM items i JOIN parties p ON p.id = i.party_id WHERE json_extract(p.contact, '$.email') = ?",
        params: [email],
        method: "all",
      });
      return { display: rows[0]?.[0], contact: JSON.parse(String(rows[0]?.[1] ?? "{}")) as Record<string, unknown> };
    };
    expect((await inbound(mime("joao@example.com", "m1"))).ok).toBe(true);
    expect(await party("joao@example.com")).toMatchObject({ display: "joao@example.com" });
    expect((await party("joao@example.com")).contact).not.toHaveProperty("name");
    expect((await inbound(mime('"rita@example.com" <rita@example.com>', "m2"))).ok).toBe(true);
    expect((await party("rita@example.com")).contact).not.toHaveProperty("name");
  });

  it("on a form on the business's website, with only their words", async () => {
    const s = await workshop();
    const res = await s.call(
      "POST",
      "/v1/forms/submit",
      {
        form: "contact",
        page: "https://oficinamare.example/contact",
        fields: { message: "Do you true wheels?" },
        visitor: { ip: "203.0.113.7", user_agent: "Mozilla/5.0" },
        signals: { trap_filled: false, elapsed_ms: 40_000, drawn_at: Date.now() - 40_000 },
      },
      s.forms,
    );
    expect(res.status, await res.clone().text()).toBe(201);
  });

  it("on the business's own page, asked again for a name that is none, with nothing written", async () => {
    const s = await workshop();
    const page = await s.inbox.app.request(
      new Request(`${BASE}/p/message`, { headers: { "cf-connecting-ip": "198.51.100.9" } }),
    );
    const hidden: Record<string, string> = {};
    for (const m of (await page.text()).matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
      hidden[m[1] as string] = (m[2] as string)
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
    }
    const sent = await s.inbox.app.request(
      new Request(`${BASE}/p/message`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.9" },
        body: new URLSearchParams({ ...hidden, name: "1234", email: "rita@example.com", text: "Hello" }).toString(),
      }),
    );
    expect(sent.status).toBe(422);
    // They filled every field in: told what is wrong with the one that is, never to fill it in.
    const said = await sent.text();
    expect(said).toContain("Please write your name in letters, as you&#39;d like us to call you.");
    expect(said).not.toContain("Please fill in your name");
    expect(await s.count("items")).toBe(0);
  });
});

describe("the demo", () => {
  it("asks testers' assistants for details too, and still writes to nobody and shows no name", async () => {
    const s = await setup({ demo: true });
    const services = await s.db.orm
      .select({ id: schema.services.id, name: schema.services.name })
      .from(schema.services);
    const full = services.find((x) => x.name === "Full service")?.id as string;
    const client = await s.mcp();
    // A time the shop takes, as an assistant finds one.
    const from = Date.now() + DAY;
    const times = (await client.callTool({
      name: "check_availability",
      arguments: { service_id: full, from: new Date(from).toISOString(), to: new Date(from + 6 * DAY).toISOString() },
    })) as { structuredContent: { slots: { startTime: string; endTime: string }[] } };
    const slot = times.structuredContent.slots[0] as { startTime: string; endTime: string };
    const args = {
      payload: {
        reservationFor: { serviceId: full, name: "Full service" },
        startTime: slot.startTime,
        endTime: slot.endTime,
      },
    };
    const nameless = (await client.callTool({ name: "create_booking", arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(nameless.isError).toBe(true);
    expect(nameless.content[0]?.text).toContain("To take this booking we need your person's name");
    const made = { ...args, contact: { name: "Zeferino Quaresma", email: "zeferino@example.net" } };
    const asked = (await client.callTool({ name: "create_booking", arguments: made })) as {
      structuredContent: { confirm?: { terms_sha: string }; view?: { item: { id: string } } };
    };
    const booked = (await client.callTool({
      name: "create_booking",
      arguments: { ...made, terms_sha: asked.structuredContent.confirm?.terms_sha },
    })) as { isError?: boolean; structuredContent: { view: { item: { id: string } } } };
    expect(booked.isError, JSON.stringify(booked)).toBeFalsy();
    await client.close();
    for (let i = 0; i < 30; i++) {
      if ((await s.inbox.runner.runDue(s.db, { now: Date.now() + 5 * 60_000, limit: 50 })).claimed === 0) break;
    }
    const { rows } = await s.db.client.query({
      sql: "SELECT state FROM items WHERE id = ?",
      params: [booked.structuredContent.view.item.id],
      method: "all",
    });
    expect(rows[0]?.[0]).toBe("confirmed");
    expect(s.mail.sent).toEqual([]);
    expect(await (await s.inbox.app.request(`${BASE}/demo/live`)).text()).not.toContain("Zeferino");
  });
});
