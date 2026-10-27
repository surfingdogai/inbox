import { createApiKey, OWNER_SCOPES, readFields } from "@surfingdog/adapters";
import { schema } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * `POST /v1/forms/submit` (ADR-041 §4.2), through the whole app: the business's own website brings
 * what visitors send through its own forms, with a key that may do this and nothing else. What it sends
 * arrives as a message, screened like one sent through the inbox's own form; each visitor is limited
 * by their own address; one submission is one message however often the site sends it; and the site's
 * answer is the same whatever the filter makes of the message. Runs on Node and in workerd.
 */

const BASE = "https://inbox.example.org";
const clock = { t: Date.parse("2026-10-26T09:00:00Z") };

async function setup() {
  const db = await freshDb();
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Atelier Nour",
    domain: "ateliernour.example",
    timezone: "Africa/Casablanca",
    currency: "MAD",
    languages: ["fr", "ar", "en"],
    createdAt: clock.t,
    updatedAt: clock.t,
  });
  const inbox = createInbox({
    db,
    mailOut: logMailOut(() => {}),
    baseUrl: BASE,
    secretKey: "forms-submit-test-secret-0123456789abcd",
    background: () => {},
    now: () => clock.t,
  });
  const site = await createApiKey(db, { kind: "integration", name: "Website forms", scopes: ["forms:submit"] });
  const crm = await createApiKey(db, { kind: "integration", name: "CRM", scopes: ["inbox:read", "inbox:write"] });
  const owner = await createApiKey(db, { kind: "owner", name: "t" });
  return { db, app: inbox.app, site: site.key, crm: crm.key, owner: owner.key };
}
type S = Awaited<ReturnType<typeof setup>>;

const submit = (s: S, body: unknown, key: string | null = s.site) =>
  s.app.request(
    new Request(`${BASE}/v1/forms/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
    }),
  );

const visitor = (n: number) => ({ ip: `203.0.113.${n}`, user_agent: "Mozilla/5.0" });
const contact = (n: number) => ({
  form: "cf7:12",
  page: "https://ateliernour.example/contact",
  fields: {
    "your-name": "Yasmine Benali",
    "your-email": `yasmine.${n}@example.ma`,
    "your-message": "Bonjour, faites-vous des retouches de robes de mariée ? Je voudrais passer la semaine prochaine.",
  },
  visitor: visitor(n),
  signals: { trap_filled: false, elapsed_ms: 40_000, drawn_at: clock.t - 40_000 + n },
});

async function verdicts(s: S) {
  const { rows } = await s.db.client.query({
    sql: "SELECT i.type, i.state, i.screen, v.verdict, v.cause, v.door, v.signals FROM items i JOIN spam_verdicts v ON v.item_id = i.id ORDER BY i.created_at",
    method: "all",
  });
  return rows.map((r) => ({
    type: r[0],
    state: r[1],
    screen: r[2],
    verdict: r[3],
    cause: r[4],
    door: r[5],
    signals: (JSON.parse(String(r[6])) as { c: string }[]).map((x) => x.c),
  }));
}

describe("who may send a website's forms", () => {
  it("needs a key given forms:submit by name; nobody else, and never the owner's AI", async () => {
    const s = await setup();
    expect((await submit(s, contact(1), null)).status).toBe(401);
    expect((await submit(s, contact(1), s.crm)).status).toBe(403);
    expect((await submit(s, contact(1), s.owner)).status).toBe(403);
    // An AI app is never offered it.
    expect(OWNER_SCOPES).not.toContain("forms:submit");
    const r = await submit(s, contact(1));
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ ok: true, item_id: expect.any(String) });
  });

  it("is a preset of its own, which can do nothing else", async () => {
    const s = await setup();
    const minted = await s.app.request(
      new Request(`${BASE}/v1/owner/api-keys`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.owner}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "My website", preset: "website_forms" }),
      }),
    );
    expect(minted.status).toBe(201);
    const key = (await minted.json()) as { key: string; scopes: string[] };
    expect(key.scopes).toEqual(["forms:submit"]);
    expect((await submit(s, contact(2), key.key)).status).toBe(201);
    const items = await s.app.request(
      new Request(`${BASE}/v1/owner/items`, { headers: { authorization: `Bearer ${key.key}` } }),
    );
    expect(items.status).toBe(403);
  });
});

describe("what a website sends", () => {
  it("arrives as a message from the visitor, screened like the inbox's own form", async () => {
    const s = await setup();
    await submit(s, contact(3));
    const { rows } = await s.db.client.query({
      sql: "SELECT i.type, i.channel, i.payload, p.display_name, p.contact FROM items i JOIN parties p ON p.id = i.party_id",
      method: "all",
    });
    const [type, channel, payload, name, card] = rows[0] ?? [];
    expect([type, channel, name]).toEqual(["message", "form", "Yasmine Benali"]);
    expect(JSON.parse(String(card))).toMatchObject({ email: "yasmine.3@example.ma" });
    expect(JSON.parse(String(payload)).text).toContain("retouches de robes");
    expect(await verdicts(s)).toEqual([
      {
        type: "message",
        state: "open",
        screen: "delivered",
        verdict: "deliver",
        cause: null,
        door: "site_form",
        signals: [],
      },
    ]);
  });

  it("reads the visitor's name, address, phone and message from the labels a form gives them", () => {
    expect(
      readFields({
        Nombre: "Lucía",
        Correo: "lucia@example.es",
        Teléfono: "+34 600 000 000",
        Mensaje: "Hola",
        Talla: "38",
      }),
    ).toEqual({ name: "Lucía", email: "lucia@example.es", phone: "+34 600 000 000", body: "Hola\n\nTalla: 38" });
    // An address that is not one is kept as written, not taken as the contact's.
    expect(readFields({ email: "not an address", message: "Hi" })).toEqual({ body: "Hi\n\nemail: not an address" });
  });

  it("refuses what is not a form submission, within limits", async () => {
    const s = await setup();
    const tooMany = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`field ${i}`, "x"]));
    for (const body of [
      {},
      { ...contact(4), fields: {} },
      { ...contact(4), fields: tooMany },
      { ...contact(4), fields: { message: "x".repeat(5_001) } },
      { ...contact(4), page: "javascript:alert(1)" },
      { ...contact(4), fields: { "your-name": "Yasmine" } },
    ]) {
      const r = await submit(s, body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(422);
      expect(((await r.json()) as { code: string }).code).toBe("invalid_input");
    }
    expect(await verdicts(s)).toEqual([]);
  });

  it("is one message however often the site sends it", async () => {
    const s = await setup();
    const first = await submit(s, contact(5));
    const again = await submit(s, contact(5));
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { item_id: string }).item_id).toBe(
      ((await first.json()) as { item_id: string }).item_id,
    );
    expect(await verdicts(s)).toHaveLength(1);
  });
});

describe("what the site saw of the visitor", () => {
  it("counts a filled hidden field and a form sent faster than anyone types, and answers the same", async () => {
    const s = await setup();
    const trapped = await submit(s, { ...contact(6), signals: { trap_filled: true, elapsed_ms: 40_000 } });
    const fast = await submit(s, { ...contact(7), signals: { trap_filled: false, elapsed_ms: 900 } });
    expect([trapped.status, fast.status]).toEqual([201, 201]);
    const shape = (b: Record<string, unknown>) => Object.keys(b).sort();
    expect(shape((await trapped.json()) as Record<string, unknown>)).toEqual(
      shape((await fast.json()) as Record<string, unknown>),
    );
    const [t, f] = await verdicts(s);
    expect(t).toMatchObject({ state: "spam", screen: "aside", cause: "trap", door: "site_form" });
    expect(f?.signals).toContain("too_fast");
    expect(f?.verdict).toBe("warn");
  });

  it("limits each visitor by their own address, not the website's", async () => {
    const s = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await submit(s, {
        ...contact(8),
        fields: { ...contact(8).fields, "your-message": `Question numéro ${i} sur les retouches.` },
        visitor: visitor(8),
      });
      statuses.push(r.status);
      if (r.status === 429) {
        expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
        break;
      }
    }
    expect(statuses.at(-1)).toBe(429);
    // Another visitor on the same website is not held back by the first.
    expect((await submit(s, contact(9))).status).toBe(201);
  });
});
