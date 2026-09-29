import { createApiKey } from "@surfingdog/adapters";
import { schema, ulid } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb, futureDay } from "./harness";

/**
 * The business's own page (the web form door, ADR-010), through the whole app: a visitor at `/`
 * sees the business, its services and the ways to ask, in its name and their language; a signed-in
 * owner still gets their app; each form writes one request through the same doors an agent uses,
 * the priced booking only after its summary was confirmed. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const BASE = "https://inbox.test";
const DAY = futureDay();

async function setup(opts: { appShell?: (r: Request) => Promise<Response> } = {}) {
  const db = await freshDb();
  const priced = ulid();
  const free = ulid();
  const quoted = ulid();
  await db.orm.insert(schema.services).values([
    {
      id: priced,
      name: "Full service",
      durationMin: 90,
      capacity: 1,
      granularityMin: 30,
      price: { model: "fixed", value: 4500, currency: "EUR" },
      createdAt: T0,
      updatedAt: T0,
    },
    { id: free, name: "Tyre check", durationMin: 30, capacity: 1, granularityMin: 30, createdAt: T0, updatedAt: T0 },
    {
      id: quoted,
      name: "Wheel build",
      durationMin: 120,
      price: { model: "quote" },
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Oficina Maré",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    languages: ["en", "pt"],
    createdAt: T0,
    updatedAt: T0,
  });
  const mail = logMailOut();
  const inbox = createInbox({
    db,
    mailOut: mail,
    baseUrl: BASE,
    secretKey: "front-page-test-secret-0123456789ab",
    background: () => {},
    ...(opts.appShell ? { appShell: opts.appShell } : {}),
  });
  const owner = await createApiKey(db, { kind: "owner", name: "t" });
  return { db, app: inbox.app, priced, free, quoted, owner: { authorization: `Bearer ${owner.key}` } };
}
type S = Awaited<ReturnType<typeof setup>>;

let visitor = 0;
/** Each test's visitor comes from an address of its own, so the limits of one never reach another. */
const from = () => `198.51.100.${(visitor++ % 250) + 1}`;

function get(s: S, path: string, headers: Record<string, string> = {}) {
  return s.app.request(new Request(`${BASE}${path}`, { headers: { "cf-connecting-ip": from(), ...headers } }));
}

function post(s: S, path: string, fields: Record<string, string>, ip = from(), headers: Record<string, string> = {}) {
  return s.app.request(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip, ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

async function items(s: S) {
  const r = await s.app.request(new Request(`${BASE}/v1/owner/items?limit=50`, { headers: s.owner }));
  expect(r.status).toBe(200);
  return ((await r.json()) as { items: { item: { id: string; type: string; channel: string; partyId?: string } }[] })
    .items;
}

/** The hidden fields of the page's form, as a browser would send them back. */
function hiddenOf(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    out[m[1] as string] = (m[2] as string)
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  return out;
}

describe("the front page", () => {
  it("shows a visitor the business, what can be booked, and the other ways to ask, in its name", async () => {
    const s = await setup();
    const r = await get(s, "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await r.text();
    expect(html).toContain("Oficina Maré");
    expect(html).toContain("How can we help?");
    expect(html).toContain("Full service · 1 h 30 min · €45.00");
    expect(html).toContain(`/p/book?service=${s.priced}`);
    expect(html).toContain(`/p/book?service=${s.free}`);
    // A service priced on request is asked for as a quote, not booked.
    expect(html).not.toContain(`/p/book?service=${s.quoted}`);
    expect(html).toContain('href="/p/quote"');
    expect(html).toContain('href="/p/message"');
    expect(html).not.toMatch(/surfing dog/i);
    expect(html).not.toContain("<script");
  });

  it("speaks the visitor's language when the business does", async () => {
    const s = await setup();
    const html = await (await get(s, "/", { "accept-language": "pt-PT,pt;q=0.9" })).text();
    expect(html).toContain("Em que podemos ajudar?");
    expect(html).toContain("Pedir um orçamento");
  });

  it("leaves `/` to the owner's app when they are signed in", async () => {
    const shell = new Response("the owner app", { headers: { "content-type": "text/html" } });
    const s = await setup({ appShell: async () => shell.clone() });
    const r = await get(s, "/", { cookie: "sdi_session=abc" });
    expect(await r.text()).toBe("the owner app");
    const plain = await setup();
    const fell = await get(plain, "/", { cookie: "sdi_session=abc" });
    expect(await fell.text()).not.toContain("How can we help?");
  });
});

describe("booking from the page", () => {
  it("lists free times, and a free service is booked on the first send", async () => {
    const s = await setup();
    const page = await get(s, `/p/book?service=${s.free}&from=${DAY}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Book: Tyre check");
    expect(html).toContain('type="email" name="email"');
    expect(html).toContain('name="website"');
    const start = /name="start" value="([^"]+)"/.exec(html)?.[1];
    expect(start).toBeTruthy();
    const sent = await post(s, "/p/book", {
      ...hiddenOf(html),
      start: start as string,
      name: "Rita",
      email: "rita@example.com",
      note: "The back wheel wobbles",
    });
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe("/p/sent?k=booking");
    const all = await items(s);
    expect(all).toHaveLength(1);
    expect(all[0]?.item.type).toBe("booking");
    expect(all[0]?.item.channel).toBe("form");
    const thanks = await (await get(s, "/p/sent?k=booking")).text();
    expect(thanks).toContain("We have your booking request.");
  });

  it("shows a priced booking's summary to confirm, and writes it only once confirmed, once", async () => {
    const s = await setup();
    const html = await (await get(s, `/p/book?service=${s.priced}&from=${DAY}`)).text();
    const start = /name="start" value="([^"]+)"/.exec(html)?.[1] as string;
    const person = { ...hiddenOf(html), start, name: "Rita", email: "rita@example.com" };
    const first = await post(s, "/p/book", person);
    expect(first.status).toBe(200);
    const confirm = await first.text();
    expect(confirm).toContain("Check and confirm");
    expect(confirm).toContain("Order with obligation to pay");
    expect(confirm).toContain("€45.00");
    expect(await items(s)).toHaveLength(0);
    const again = hiddenOf(confirm);
    expect(again.terms_sha).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const done = await post(s, "/p/book", again);
    expect(done.status).toBe(303);
    // The same form sent twice (a double click, a reload) makes one booking.
    expect((await post(s, "/p/book", again)).status).toBe(303);
    const all = await items(s);
    expect(all).toHaveLength(1);
    expect(all[0]?.item.type).toBe("booking");
  });

  it("gives the form back, filled in, when something is missing, and says so", async () => {
    const s = await setup();
    const html = await (await get(s, `/p/book?service=${s.free}&from=${DAY}`)).text();
    const r = await post(s, "/p/book", { ...hiddenOf(html), name: "Rita", email: "not-an-address", note: "hi" });
    expect(r.status).toBe(422);
    const back = await r.text();
    expect(back).toContain("That email address doesn&#39;t look right.");
    expect(back).toContain('value="Rita"');
    expect(back).toContain(">hi</textarea>");
    expect(await items(s)).toHaveLength(0);
  });

  it("says a service that is not offered is not offered", async () => {
    const s = await setup();
    expect((await get(s, "/p/book?service=nope")).status).toBe(404);
    expect((await get(s, `/p/book?service=${s.quoted}`)).status).toBe(404);
  });
});

describe("asking from the page", () => {
  it("sends a quote request and a message through the same doors as an agent", async () => {
    const s = await setup();
    const q = await get(s, "/p/quote");
    const quote = await post(s, "/p/quote", {
      ...hiddenOf(await q.text()),
      name: "Rita",
      email: "rita@example.com",
      text: "A wheel build for a gravel bike\nDT Swiss hubs, 28 spokes",
    });
    expect(quote.status).toBe(303);
    expect(quote.headers.get("location")).toBe("/p/sent?k=quote");
    const m = await get(s, "/p/message");
    const message = await post(s, "/p/message", {
      ...hiddenOf(await m.text()),
      name: "Rita",
      email: "rita@example.com",
      text: "Are you open on the holiday?",
    });
    expect(message.status).toBe(303);
    const all = await items(s);
    expect(all.map((i) => i.item.type).sort()).toEqual(["message", "quote_request"]);
    expect(all.every((i) => i.item.channel === "form")).toBe(true);
  });

  it("thanks a bot that filled the trap, and writes nothing", async () => {
    const s = await setup();
    const r = await post(s, "/p/message", {
      name: "x",
      email: "x@example.com",
      text: "cheap pills",
      website: "https://spam.example",
    });
    expect(r.status).toBe(303);
    expect(await items(s)).toHaveLength(0);
  });

  it("stops a flood from one address with the same limit the API's creates have", async () => {
    const s = await setup();
    const ip = "203.0.113.77";
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      statuses.push(
        (await post(s, "/p/message", { name: "x", email: "x@example.com", text: "t", website: "y" }, ip)).status,
      );
    }
    expect(statuses.slice(0, 20).every((st) => st === 303)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
