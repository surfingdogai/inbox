import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import { networksLink, schema, ulid } from "@surfingdog/core";
import { logMailOut, type MailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb, futureDay } from "./harness";

/**
 * A customer's privacy through the whole app (Tiago, 23 September 2026): the page the code email
 * links to stops the booking network for them, with no script and nothing a GET does; the owner's
 * doors say who the customer is, export them, switch networks off and erase them — erasing only for
 * the owner or a key given customers:erase, never through the owner's AI. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const BASE = "https://inbox.test";
const DAY = futureDay();

async function setup(opts: { languages?: string[]; mailOut?: MailOut } = {}) {
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
    languages: opts.languages ?? ["en"],
    createdAt: T0,
    updatedAt: T0,
  });
  const inbox = createInbox({
    db,
    mailOut: opts.mailOut ?? logMailOut(),
    baseUrl: BASE,
    secretKey: "customer-privacy-test-secret-0123456789",
    background: () => {},
  });
  const owner = await createApiKey(db, { kind: "owner", name: "t" });
  const auth = { authorization: `Bearer ${owner.key}` };
  const book = async (email = "rita@example.com") => {
    const res = await inbox.app.request(
      post("/v1/bookings", {
        payload: {
          reservationFor: { serviceId: svc, name: "Full service" },
          startTime: `${DAY}T09:00:00Z`,
          endTime: `${DAY}T10:30:00Z`,
        },
        contact: { name: "Rita", email },
      }),
    );
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { view: { item: { id: string } } }).view.item.id;
    const [row] = (
      await db.client.query({ sql: "SELECT party_id FROM items WHERE id = ?", params: [id], method: "all" })
    ).rows;
    return { id, party: String(row?.[0]) };
  };
  return { db, inbox, app: inbox.app, auth, book };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const submit = (app: ReturnType<typeof createInbox>["app"], path: string, form: Record<string, string>) =>
  app.request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
  });

describe("the page that stops the booking network", () => {
  it("only shows on a GET, stops it on the form's POST, and says since when, in the business's language", async () => {
    const s = await setup({ languages: ["pt"] });
    const { id } = await s.book();
    const url = await networksLink(s.db, s.inbox.caps.secrets, {
      itemId: id,
      mailKey: `key:${id}`,
      lang: "pt",
      base: BASE,
      now: Date.now(),
    });
    const path = String(url).slice(BASE.length);
    const count = async () =>
      Number((await s.db.client.query({ sql: "SELECT COUNT(*) FROM network_stops", method: "all" })).rows[0]?.[0]);

    const shown = await s.app.request(`${BASE}${path}`);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("cache-control")).toBe("no-store");
    expect(shown.headers.get("referrer-policy")).toBe("no-referrer");
    expect(shown.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await shown.text();
    expect(html).toContain('<html lang="pt">');
    expect(html).toContain("<title>Clientes habituais — Oficina Maré</title>");
    expect(html).toContain("Se parar, a partir daí não dizemos mais nada sobre si a nenhuma rede de reservas");
    expect(html).toContain("Deixar de a usar para mim");
    expect(html).not.toContain("<script");
    expect(await count()).toBe(0);

    // A POST that is not the page's own form (a scanner, a script): nothing.
    const bare = await submit(s.app, path, {});
    expect(bare.status).toBe(422);
    expect(await count()).toBe(0);

    const done = await submit(s.app, path, { terms: "networks", stop: "1" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe(path);
    expect(await count()).toBeGreaterThan(0);
    const after = await (await s.app.request(`${BASE}${path}`)).text();
    expect(after).toContain("Feito. Desde");
    expect(after).not.toContain("Deixar de a usar para mim");
  });

  it("tells anyone how to stop on the public page, in words that are true", async () => {
    const s = await setup();
    const html = await (await s.app.request(`${BASE}/c/privacy?l=en`)).text();
    expect(html).toContain("use the link in the email that brought your code, or reply to any of our emails");
    expect(html).toContain("we send it to a booking network, which makes a code for you");
    expect(html).not.toContain("<form");
  });
});

describe("the owner's doors to one customer", () => {
  it("says who the customer is, exports them as a file, and switches networks off for them", async () => {
    const s = await setup();
    const { id, party } = await s.book();
    await s.book("rita@example.com");
    const summary = await s.app.request(`${BASE}/v1/owner/customers/${party}`, { headers: s.auth });
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({ party_id: party, name: "Rita", items: 2, networks_off: null });
    const exported = await s.app.request(`${BASE}/v1/owner/customers/${party}/export`, { headers: s.auth });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toMatch(/^attachment; filename="customer-[0-9A-Z]{6}\.json"$/);
    const data = (await exported.json()) as { items: { item: { id: string } }[] };
    expect(data.items.map((i) => i.item.id)).toContain(id);
    const off = await s.app.request(post(`/v1/owner/customers/${party}/networks-off`, { item_id: id }, s.auth));
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ networks_off: { via: "owner", networks: [] } });
    const missing = await s.app.request(`${BASE}/v1/owner/customers/nobody/export`, { headers: s.auth });
    expect(missing.status).toBe(404);
  });

  it("erases only with the confirm it gave, for the owner or a key given customers:erase", async () => {
    const s = await setup();
    const { party } = await s.book();
    // A key without the scope is refused, even though scopes are only logged by default.
    const crm = await createApiKey(s.db, { kind: "integration", name: "CRM", scopes: ["inbox:read", "inbox:write"] });
    const refused = await s.app.request(
      post(`/v1/owner/customers/${party}/erase`, {}, { authorization: `Bearer ${crm.key}` }),
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "not_allowed", details: { reason: "owner_only" } });
    // The owner, without confirm: what it would erase, and nothing done.
    const asked = await s.app.request(
      new Request(`${BASE}/v1/owner/customers/${party}/erase`, { method: "POST", headers: s.auth }),
    );
    expect(asked.status).toBe(409);
    const problem = (await asked.json()) as { code: string; details: { confirm: string; summary: { items: number } } };
    expect(problem).toMatchObject({ code: "confirm_erase", details: { summary: { items: 1 } } });
    // A key given customers:erase, with that confirm.
    const eraser = await createApiKey(s.db, { kind: "integration", name: "Privacy desk", scopes: ["customers:erase"] });
    const erased = await s.app.request(
      post(
        `/v1/owner/customers/${party}/erase`,
        { confirm: problem.details.confirm },
        { authorization: `Bearer ${eraser.key}` },
      ),
    );
    expect(erased.status).toBe(200);
    expect(await erased.json()).toMatchObject({ erased: true, customer: { name: "Erased customer" } });
  });

  it("lets the owner's AI export and stop networks, and gives it no way to erase", async () => {
    const s = await setup();
    const { party } = await s.book();
    const key = (await createApiKey(s.db, { kind: "owner", name: "cli" })).key;
    const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${key}`);
      return s.app.request(String(input), { ...init, headers });
    };
    const client = new Client({ name: "owner-ai", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/owner`), { fetch: fetchLike }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["export_customer", "stop_customer_networks"]));
    expect(names.some((n) => n.includes("erase"))).toBe(false);
    const exported = await client.callTool({ name: "export_customer", arguments: { party_id: party } });
    expect(exported.isError).toBeFalsy();
    expect((exported.structuredContent as { customer: { items: number } }).customer.items).toBe(1);
    const stopped = await client.callTool({ name: "stop_customer_networks", arguments: { party_id: party } });
    expect(stopped.isError).toBeFalsy();
    // The customer's name is their own words: quoted in the untrusted block, never in the sentence.
    const said = (stopped.content as { text: string }[])[0]?.text ?? "";
    expect(said).toContain("Booking networks are off for this customer (name below)");
    expect(said.split("\n\n<<<UNTRUSTED")[0]).not.toContain("Rita");
    expect(said).toMatch(/<<<UNTRUSTED [0-9a-f]{12}>>>[\s\S]*\| Rita/);
  });

  it("says in Settings when email does not go out", async () => {
    const quiet = await setup({ mailOut: logMailOut(() => {}, { delivers: false }) });
    const res = await quiet.app.request(`${BASE}/v1/owner/mail`, { headers: quiet.auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ service: false, sender: true, links: true });
    const working = await setup();
    expect(await (await working.app.request(`${BASE}/v1/owner/mail`, { headers: working.auth })).json()).toEqual({
      service: true,
      sender: true,
      links: true,
    });
  });
});
