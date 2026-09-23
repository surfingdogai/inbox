import { createApiKey } from "@surfingdog/adapters";
import { type Db, networkSuccessStatement, schema, setFlags, ulid } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb, futureDay, nextDay } from "./harness";

/**
 * The page a link in the business's email opens (ADR-018 §5), through the whole app: the email
 * carries the links, a GET shows the terms in the business's name and does nothing, a POST acts
 * once, and every way it cannot act is said in the customer's words. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const BASE = "https://inbox.test";
const DAY = futureDay();
const NEXT = nextDay(DAY);

async function setup(languages = ["en"], now?: { at: number | null }) {
  const db = await freshDb();
  const svc = ulid();
  await db.orm.insert(schema.services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    capacity: 1,
    granularityMin: 30,
    price: { model: "fixed", value: 4500, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Oficina Maré",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    languages,
    createdAt: T0,
    updatedAt: T0,
  });
  const mail = logMailOut();
  const inbox = createInbox({
    db,
    mailOut: mail,
    baseUrl: BASE,
    secretKey: "customer-page-test-secret-0123456789",
    background: () => {},
    ...(now ? { now: () => now.at ?? Date.now() } : {}),
  });
  const owner = await createApiKey(db, { kind: "owner", name: "t" });
  return { db, inbox, app: inbox.app, mail, svc, owner: { authorization: `Bearer ${owner.key}` } };
}
type S = Awaited<ReturnType<typeof setup>>;

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

async function drain(s: S) {
  for (let i = 0; i < 20; i++) if ((await s.inbox.runner.runDue(s.db, { limit: 100 })).claimed === 0) return;
}

/** A booking the customer asked for, and another time the owner proposed; the email that says so. */
async function proposed(s: S, at = `${DAY}T13:00:00Z`) {
  const created = await s.app.request(
    post("/v1/bookings", {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: `${DAY}T09:00:00Z`,
        endTime: `${DAY}T10:30:00Z`,
      },
      contact: { name: "Rita", email: "rita@example.com" },
    }),
  );
  expect(created.status).toBe(201);
  const id = ((await created.json()) as { view: { item: { id: string } } }).view.item.id;
  const end = new Date(Date.parse(at) + 90 * 60_000).toISOString();
  const moved = await s.app.request(
    post(`/v1/owner/items/${id}/transitions`, { event: "propose", input: { startTime: at, endTime: end } }, s.owner),
  );
  expect(moved.status).toBe(200);
  await drain(s);
  return { id, links: linksIn(lastTo(s, "rita@example.com")) };
}

function lastTo(s: S, to: string): string {
  const m = [...s.mail.sent].reverse().find((x) => x.to.includes(to));
  return m?.text ?? "";
}

function linksIn(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, label, url] of text.matchAll(/^([^:\n]+): (https:\/\/inbox\.test\/c\/\S+)$/gm)) {
    if (label && url) out[label] = url.slice(BASE.length);
  }
  return out;
}

/** The hidden fields of the page's form, as the browser would send them. */
function formOf(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    if (name) out[name] = value ?? "";
  }
  return out;
}

const submit = (s: S, path: string, form: Record<string, string>) =>
  s.app.request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
  });

async function counts(db: Db) {
  const one = async (sql: string) => Number((await db.client.query({ sql, method: "all" })).rows[0]?.[0]);
  return {
    events: await one("SELECT COUNT(*) FROM item_events"),
    jobs: await one("SELECT COUNT(*) FROM jobs"),
    used: await one("SELECT COUNT(*) FROM action_links WHERE used_at IS NOT NULL"),
  };
}

async function stateOf(db: Db, id: string) {
  const { rows } = await db.client.query({
    sql: "SELECT state, payload FROM items WHERE id = ?",
    params: [id],
    method: "all",
  });
  return { state: String(rows[0]?.[0]), payload: JSON.parse(String(rows[0]?.[1])) as Record<string, unknown> };
}

describe("the customer's page", () => {
  it("comes with the email: one link for each answer, in the business's name", async () => {
    const s = await setup();
    const { links } = await proposed(s);
    expect(Object.keys(links)).toEqual(["Accept", "Decline", "Pick another time"]);
    const text = lastTo(s, "rita@example.com");
    expect(text).not.toMatch(/surfing/i);
  });

  it("writes the time in the email as the page does: in the business's own zone", async () => {
    const s = await setup();
    const at = `${DAY}T13:00:00Z`;
    await proposed(s, at);
    const text = lastTo(s, "rita@example.com");
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Lisbon",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(at));
    // The business set its zone in its profile; the settings still hold the default, UTC.
    expect(text).toContain(local);
    expect(text).not.toContain("UTC");
  });

  it("reads no more of a POST than its form can be, however the body is sent", async () => {
    const s = await setup();
    const { id, links } = await proposed(s);
    const page = await (await s.app.request(`${BASE}${links.Accept}`)).text();
    const bytes = new TextEncoder().encode(
      new URLSearchParams({ ...formOf(page), pad: "x".repeat(70_000) }).toString(),
    );
    // In chunks, with no length said: nothing tells the server how much is coming.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 8_192) controller.enqueue(bytes.slice(i, i + 8_192));
        controller.close();
      },
    });
    const before = await counts(s.db);
    const res = await s.app.request(`${BASE}${links.Accept}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      duplex: "half",
      redirect: "manual",
    } as RequestInit);
    expect(res.status).toBe(422);
    expect(await counts(s.db)).toEqual(before);
    expect((await stateOf(s.db, id)).state).toBe("proposed");
  });

  it("shows the terms, the zone and the business, and a GET writes nothing", async () => {
    const s = await setup();
    const { links } = await proposed(s);
    const before = await counts(s.db);
    const res = await s.app.request(`${BASE}${links.Accept}`);
    await s.app.request(`${BASE}${links.Accept}`);
    expect(await counts(s.db)).toEqual(before);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
    const html = await res.text();
    expect(html).toContain("<title>Oficina Maré</title>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Accept this time?");
    // The time in the business's zone, with the zone named (13:00 UTC is 13:00 or 14:00 in Lisbon).
    expect(html).toMatch(/at 1[34]:00 \(.+\)/);
    expect(html).toContain("€45.00");
    expect(html).toContain("Order with obligation to pay");
    expect(html).toContain("Pick another time");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/surfing/i);
  });

  it("acts once on a POST, then shows what was done; a second POST and a sibling link say it is done", async () => {
    const s = await setup();
    const { id, links } = await proposed(s);
    const page = await (await s.app.request(`${BASE}${links.Accept}`)).text();
    const res = await submit(s, links.Accept as string, formOf(page));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(links.Accept);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await stateOf(s.db, id)).state).toBe("confirmed");
    const done = await (await s.app.request(`${BASE}${links.Accept}`)).text();
    expect(done).toContain("Your booking is confirmed");
    const again = await submit(s, links.Accept as string, formOf(page));
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("This is already done.");
    const decline = await s.app.request(`${BASE}${links.Decline}`);
    expect(decline.status).toBe(409);
    expect(await decline.text()).toContain("This can no longer be done here.");
    // The customer hears it is booked.
    await drain(s);
    expect(s.mail.sent.filter((m) => m.to.includes("rita@example.com")).map((m) => m.subject)).toContain(
      "Confirmed: Full service",
    );
  });

  it("does nothing for a POST that did not come from the page", async () => {
    const s = await setup();
    const { id, links } = await proposed(s);
    const res = await submit(s, links.Accept as string, {});
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Nothing was sent.");
    expect((await stateOf(s.db, id)).state).toBe("proposed");
  });

  it("says when we changed what we proposed", async () => {
    const s = await setup();
    const { id, links } = await proposed(s);
    await s.app.request(post(`/v1/owner/items/${id}/transitions`, { event: "request_info" }, s.owner));
    await s.app.request(
      post(
        `/v1/owner/items/${id}/transitions`,
        { event: "propose", input: { startTime: `${DAY}T15:00:00Z`, endTime: `${DAY}T16:30:00Z` } },
        s.owner,
      ),
    );
    const res = await s.app.request(`${BASE}${links.Accept}`);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("We have changed what we proposed.");
  });

  it("offers the free times when the proposed one was taken meanwhile", async () => {
    const s = await setup();
    const { id, links } = await proposed(s);
    const page = await (await s.app.request(`${BASE}${links.Accept}`)).text();
    const other = await s.app.request(
      post("/v1/bookings", {
        payload: {
          reservationFor: { serviceId: s.svc, name: "Full service" },
          startTime: `${DAY}T13:30:00Z`,
          endTime: `${DAY}T15:00:00Z`,
        },
      }),
    );
    const oid = ((await other.json()) as { view: { item: { id: string } } }).view.item.id;
    await s.app.request(post(`/v1/owner/items/${oid}/transitions`, { event: "confirm" }, s.owner));
    const res = await submit(s, links.Accept as string, formOf(page));
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain("That time is no longer free.");
    expect(html).toContain(`action="${links["Pick another time"]}"`);
    expect(html).toMatch(/type="radio"[^>]+name="start"/);
    expect((await stateOf(s.db, id)).state).toBe("proposed");
  });

  it("takes another time the customer picks from the free ones", async () => {
    const s = await setup();
    const { id, links } = await proposed(s);
    const path = links["Pick another time"] as string;
    const page = await (await s.app.request(`${BASE}${path}?from=${NEXT}`)).text();
    expect(page).toContain("Free times for");
    const starts = [...page.matchAll(/name="start" value="([^"]+)"/g)].map((m) => m[1] as string);
    expect(starts.length).toBeGreaterThan(0);
    const res = await submit(s, path, { ...formOf(page), start: starts[0] as string, note: "Any time works." });
    expect(res.status).toBe(303);
    const now = await stateOf(s.db, id);
    expect(now.state).toBe("requested");
    expect(now.payload.startTime).toBe(starts[0]);
    const done = await (await s.app.request(`${BASE}${path}`)).text();
    expect(done).toContain("We have your new time.");
  });

  it("takes the details asked for, escaping the business's words, and refuses an empty answer", async () => {
    const s = await setup();
    const created = await s.app.request(
      post("/v1/bookings", {
        payload: {
          reservationFor: { serviceId: s.svc, name: "Full service" },
          startTime: `${DAY}T09:00:00Z`,
          endTime: `${DAY}T10:30:00Z`,
        },
        contact: { email: "rita@example.com" },
      }),
    );
    const id = ((await created.json()) as { view: { item: { id: string } } }).view.item.id;
    await s.app.request(
      post(
        `/v1/owner/items/${id}/transitions`,
        { event: "request_info", input: { note: "<b>Which bike?</b>" } },
        s.owner,
      ),
    );
    await drain(s);
    const path = linksIn(lastTo(s, "rita@example.com"))["Send the details"] as string;
    expect(path).toBeDefined();
    const page = await (await s.app.request(`${BASE}${path}`)).text();
    expect(page).toContain("&lt;b&gt;Which bike?&lt;/b&gt;");
    expect(page).not.toContain("<b>Which bike?</b>");
    const empty = await submit(s, path, { ...formOf(page), details: "  " });
    expect(empty.status).toBe(422);
    expect(await empty.text()).toContain("Write your answer first.");
    // The business flags the item meanwhile: the page the customer holds is a version behind, and
    // what they answer still stands.
    await setFlags(
      s.db,
      { actor: { kind: "owner", id: "u1", channel: "owner_ui" }, tier: "verified_principal", sandbox: false },
      {
        itemId: id,
        flags: { needsHuman: true },
      },
    );
    const res = await submit(s, path, { ...formOf(page), details: "A blue Brompton." });
    expect(res.status).toBe(303);
    expect((await stateOf(s.db, id)).state).toBe("requested");
    // A new question retires the old link: the customer answers the one we ask now.
    await s.app.request(
      post(`/v1/owner/items/${id}/transitions`, { event: "request_info", input: { note: "And the size?" } }, s.owner),
    );
    const old = await s.app.request(`${BASE}${path}`);
    expect(await old.text()).toContain("This is already done.");
  });

  it("speaks the business's language, and says when a link has expired or is not one of ours", async () => {
    const clock = { at: null as number | null };
    const s = await setup(["pt"], clock);
    const { links } = await proposed(s);
    expect(Object.keys(links)).toEqual(["Aceitar", "Recusar", "Escolher outra hora"]);
    const html = await (await s.app.request(`${BASE}${links.Aceitar}`)).text();
    expect(html).toContain('<html lang="pt">');
    expect(html).toContain("Aceitar esta hora?");
    expect(html).toContain("Encomenda com obrigação de pagar");
    const invalid = await s.app.request(`${BASE}/c/not-a-real-token`, { headers: { "accept-language": "en-GB" } });
    expect(invalid.status).toBe(404);
    expect(await invalid.text()).toContain("This link is not valid.");
    // Past the answer-by date the link still opens, and says why it is too late, with the free times.
    clock.at = Date.parse(`${DAY}T13:30:00Z`);
    const late = await s.app.request(`${BASE}${links.Aceitar}`);
    expect(late.status).toBe(410);
    const lateHtml = await late.text();
    expect(lateHtml).toContain("Já é demasiado tarde para confirmar esta hora online.");
    expect(lateHtml).toContain("Escolha outra hora");
    // A day after that date, the link has done its work.
    clock.at = Date.parse(`${NEXT}T12:30:00Z`);
    const expired = await s.app.request(`${BASE}${links.Aceitar}`);
    expect(expired.status).toBe(410);
    expect(await expired.text()).toContain("Esta ligação expirou.");
  });

  it("explains the booking network on a page of its own, in the business's name, naming the networks that verified us", async () => {
    const s = await setup(["pt", "en"]);
    await s.app.request(
      new Request(`${BASE}/v1/owner/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...s.owner },
        body: JSON.stringify({
          doc: { networks: { "https://net.example.com": { enabled: true, issue: true, share: { listing: false } } } },
        }),
      }),
    );
    // Switched on but not verified: it gets no customer's address, so the page does not name it.
    expect(await (await s.app.request(`${BASE}/c/privacy?l=en`)).text()).not.toContain("net.example.com");
    await s.db.client.query(
      networkSuccessStatement("https://net.example.com", Date.now(), { registration: "registered", pinged: true }),
    );
    const en = await s.app.request(`${BASE}/c/privacy?l=en`);
    expect(en.status).toBe(200);
    expect(en.headers.get("cache-control")).toBe("public, max-age=300");
    expect(en.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await en.text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Returning customers — Oficina Maré</title>");
    expect(html).toContain("How we recognise returning customers");
    expect(html).toContain('<a href="https://net.example.com" rel="noopener noreferrer">net.example.com</a>');
    expect(html).not.toContain("https://net.example.com/privacy");
    expect(html).toContain("You don&#39;t have to use the code");
    expect(html).not.toContain("<script");
    // The business's first language when the link names none; the link's otherwise.
    const pt = await (await s.app.request(`${BASE}/c/privacy`)).text();
    expect(pt).toContain('<html lang="pt">');
    expect(pt).toContain("Como reconhecemos clientes habituais");
    expect(pt).toContain("net.example.com");
    // A network switched off is not named.
    const off = await s.app.request(
      new Request(`${BASE}/v1/owner/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...s.owner },
        body: JSON.stringify({ doc: { networks: { "https://net.example.com": { enabled: false } } } }),
      }),
    );
    expect(off.status).toBe(200);
    expect(await (await s.app.request(`${BASE}/c/privacy?l=en`)).text()).not.toContain("net.example.com");
  });
});
