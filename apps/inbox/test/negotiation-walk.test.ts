import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey, pingNetworksNow } from "@surfingdog/adapters";
import { type Db, networkSuccessStatement, schema, ulid } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { confirmed, freshDb, futureDay } from "./harness";

/**
 * Negotiation walked end to end (ADR-018, Amendments 1 to 6), through the whole app as it runs, on a
 * fresh database, with a network that is only a fake and a mail service that only keeps what it is
 * given — once with a customer who writes in English, once with one who writes in Portuguese:
 *
 * - a quote asked for, revised, answered by the customer's assistant with another quantity, quoted
 *   again and accepted from the email's link (a GET shows it and writes nothing, a POST acts);
 * - a booking confirmed, then moved by the customer's assistant and accepted by the owner, the move
 *   going to a person while the network holding the promise applies rules 5 and becoming an
 *   `amended` receipt only once it applies rules 6;
 * - an order paid, withdrawn from the link in its confirmation within the 14 days, and refunded, the
 *   refund's receipts waiting until the network announces rules 6;
 * - a price of the customer's own while the owner has price counters off: their message, for a person;
 * - a reward the owner set: the customer's price, with the notice in the business's voice;
 * - the owner's AI, holding the owner's own key: a time it may offer, money it may not touch.
 *
 * Runs on Node and in workerd.
 */
const BASE = "https://inbox.example.com";
const NET = "https://net.example.com";
const DAY = futureDay();
const HOUR = 3_600_000;

type Lang = "en" | "pt";

/** What each customer reads, in their own language, and nothing that names anyone but the business. */
const WORDS = {
  en: {
    name: "Rita",
    email: "rita@example.com",
    locale: "en",
    accept: "Accept",
    decline: "Decline",
    acceptQuote: "Accept our quote?",
    obligation: "Order with obligation to pay",
    quoted580: /€580\.00/,
    changeTime: "Change the time",
    moved: /Done: your booking "Full service" is now for /,
    withdraw: "Withdraw from contract here",
    withdrawHeading: "Withdraw from your contract",
    confirmWithdrawal: "Confirm withdrawal",
    passedOn: /^We have passed this on to a person on our team/,
    notice:
      "Your price: €42.75 (our price €45.00). We personalised this price for you by automated decision-making. Thank you for coming back.",
    automated: "This reply was sent automatically. Reply to reach a person.",
  },
  pt: {
    name: "Ana",
    email: "ana@example.pt",
    locale: "pt-PT",
    accept: "Aceitar",
    decline: "Recusar",
    acceptQuote: "Aceitar o nosso orçamento?",
    obligation: "Encomenda com obrigação de pagar",
    quoted580: /580,00\s€/,
    changeTime: "Mudar a hora",
    moved: /Feito: a sua marcação "Full service" passa para /,
    withdraw: "Retrate-se do contrato aqui",
    withdrawHeading: "Retratar-se do contrato",
    confirmWithdrawal: "Confirmar retratação",
    passedOn: /^Passámos isto a uma pessoa da nossa equipa/,
    notice:
      "O seu preço: 42,75 € (o nosso preço: 45,00 €). Este preço foi personalizado com base numa decisão automatizada. Thank you for coming back.",
    automated: "Esta resposta foi enviada automaticamente. Responda para falar com uma pessoa.",
  },
} as const;

/** Words that would tell a customer there is anything between them and the business. */
const NOT_THE_BUSINESS =
  /surfing|network|\brede\b|\binbox\b|\boffers?\b|\bround\b|\bdraft\b|\btier\b|\bscore\b|reputa|ulid/i;

/**
 * A network, faked: its `/v1/ranking` says the rules it applies (changed by the test as the network
 * would change them), it takes every receipt, and answers everything else with nothing.
 */
function fakeNetwork() {
  const state = { version: 5, next: null as number | null };
  const posted: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin !== NET) return new Response(null, { status: 404 });
    if (url.pathname === "/v1/ranking") {
      return Response.json({
        version: state.version,
        status: "in_force",
        next: state.next
          ? { version: state.next, effective_at: "2026-10-12T00:00:00Z", url: `${NET}/v1/ranking?version=6` }
          : null,
      });
    }
    if (url.pathname === "/v1/receipts" && init?.body) {
      const body = JSON.parse(String(init.body)) as { receipt: string; ack?: string };
      const claims = JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(atob((body.receipt.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")), (c) =>
            c.charCodeAt(0),
          ),
        ),
      ) as { typ: string; knd: string; out?: string };
      if (!body.ack) posted.push(claims.out ?? `${claims.typ} ${claims.knd}`);
      return Response.json(
        { ok: true, state: body.ack ? "acknowledged" : "issued", duplicate: false },
        { status: 201 },
      );
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { state, posted, fetchImpl };
}

async function setup(lang: Lang, opts: { network?: boolean } = {}) {
  const db = await freshDb();
  const now = Date.now();
  const svc = ulid();
  await db.orm.insert(schema.services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    capacity: 1,
    granularityMin: 30,
    price: { model: "fixed", value: 4500, currency: "EUR" },
    createdAt: now,
    updatedAt: now,
  });
  const chain = ulid();
  await db.orm.insert(schema.products).values({
    id: chain,
    sku: "CH-9",
    name: "Chain",
    price: { value: 1850, currency: "EUR" },
    active: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Oficina Maré",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    languages: ["en", "pt"],
    createdAt: now,
    updatedAt: now,
  });
  const net = fakeNetwork();
  const mail = logMailOut();
  const inbox = createInbox({
    db,
    mailOut: mail,
    baseUrl: BASE,
    secretKey: "negotiation-walk-test-secret-0123456789",
    fetchImpl: net.fetchImpl,
    background: () => {},
  });
  const ownerKey = (await createApiKey(db, { kind: "owner", name: "t" })).key;
  const owner = { authorization: `Bearer ${ownerKey}` };
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    inbox.app.request(
      new Request(`${BASE}${path}`, {
        method,
        headers: { "content-type": "application/json", "user-agent": "SomeAssistant/1.0", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const drain = async (now = Date.now()) => {
    for (let i = 0; i < 30; i++) if ((await inbox.runner.runDue(db, { limit: 100, now })).claimed === 0) return;
  };
  const w = WORDS[lang];
  const doc: Record<string, unknown> = {
    commerce: { legal: { legalName: "Oficina Maré Lda", address: "Rua do Mar 1, Lisboa", country: "PT" } },
  };
  if (opts.network) {
    // A network switched on to take receipts, and verified; it issues no keys, so a create asks it nothing.
    doc.networks = { [NET]: { enabled: true, issue: false, share: { listing: false, counts: false, receipts: true } } };
  }
  const saved = await send("PUT", "/v1/owner/settings", { doc }, owner);
  expect(saved.status, await saved.clone().text()).toBe(200);
  if (opts.network) {
    await db.client.query(networkSuccessStatement(NET, Date.now(), { registration: "registered", pinged: true }));
    await drain();
  }
  /** The network reads its rules again the next day, at its hourly tick. */
  const nextDaysTick = async () => {
    const later = Date.now() + 25 * HOUR;
    await pingNetworksNow(db, later);
    await drain(later);
  };
  const mailTo = () => mail.sent.filter((m) => m.to.includes(w.email));
  const lastMail = () => mailTo().at(-1)?.text ?? "";
  const submit = (path: string, form: Record<string, string>) =>
    inbox.app.request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
    });
  const connectOwnerAi = async () => {
    const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const merged = new Headers(init?.headers);
      merged.set("authorization", owner.authorization);
      return inbox.app.request(String(input), { ...init, headers: merged });
    };
    const client = new Client({ name: "assistant", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/owner`), { fetch: fetchLike }));
    return client;
  };
  return {
    db,
    app: inbox.app,
    svc,
    chain,
    net,
    send,
    owner,
    drain,
    nextDaysTick,
    mailTo,
    lastMail,
    submit,
    w,
    connectOwnerAi,
  };
}
type S = Awaited<ReturnType<typeof setup>>;

/** A customer's assistant, which sends a priced request again with the fingerprint once its person confirmed. */
const assistant = (s: S, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  confirmed(
    (r) => s.app.request(r),
    new Request(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", "user-agent": "SomeAssistant/1.0", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

function linksIn(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, label, url] of text.matchAll(/^([^:\n]+): (https:\/\/inbox\.example\.com\/c\/\S+)$/gm)) {
    if (label && url) out[label] = url.slice(BASE.length);
  }
  return out;
}

function formOf(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    if (name) out[name] = value ?? "";
  }
  return out;
}

async function counts(db: Db) {
  const one = async (sql: string) => Number((await db.client.query({ sql, method: "all" })).rows[0]?.[0]);
  return {
    events: await one("SELECT COUNT(*) FROM item_events"),
    items: await one("SELECT COUNT(*) FROM items"),
    used: await one("SELECT COUNT(*) FROM action_links WHERE used_at IS NOT NULL"),
  };
}

async function itemRow(db: Db, id: string) {
  const { rows } = await db.client.query({
    sql: "SELECT state, payload, party_id FROM items WHERE id = ?",
    params: [id],
    method: "all",
  });
  return {
    state: String(rows[0]?.[0]),
    payload: JSON.parse(String(rows[0]?.[1])) as Record<string, unknown>,
    partyId: String(rows[0]?.[2]),
  };
}

async function linkedTo(db: Db, id: string) {
  const { rows } = await db.client.query({
    sql: "SELECT id, type, state, payload FROM items WHERE linked_item_id = ? OR id = (SELECT linked_item_id FROM items WHERE id = ?)",
    params: [id, id],
    method: "all",
  });
  return rows.map((r) => ({
    id: String(r[0]),
    type: String(r[1]),
    state: String(r[2]),
    payload: JSON.parse(String(r[3])) as Record<string, unknown>,
  }));
}

type Created = { view: { item: { id: string } }; accessToken: string };

/** A booking for DAY at 10:00 in Lisbon, asked for by the customer's assistant. */
async function booked(s: S, headers: Record<string, string> = {}) {
  const res = await assistant(
    s,
    "POST",
    "/v1/bookings",
    {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: `${DAY}T09:00:00Z`,
        endTime: `${DAY}T10:30:00Z`,
      },
      contact: { name: s.w.name, email: s.w.email, locale: s.w.locale },
    },
    headers,
  );
  expect(res.status, await res.clone().text()).toBe(201);
  const body = (await res.json()) as Created;
  return { id: body.view.item.id, q: `access_token=${body.accessToken}` };
}

const LANGS: Lang[] = ["en", "pt"];

describe.each(LANGS)("negotiation, end to end, with a customer who writes in %s", (lang) => {
  it("a quote: asked for, revised, answered with another quantity, quoted again and accepted from the link", async () => {
    const s = await setup(lang);
    const asked = await s.send("POST", "/v1/quotes", {
      payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel, 28 spokes", quantity: 1 },
      contact: { name: s.w.name, email: s.w.email, locale: s.w.locale },
    });
    expect(asked.status, await asked.clone().text()).toBe(201);
    const created = (await asked.json()) as Created;
    const id = created.view.item.id;
    const q = `access_token=${created.accessToken}`;
    const quote = (value: number, quantity: number, key: string) =>
      s.send(
        "POST",
        `/v1/owner/items/${id}/transitions`,
        {
          event: "quote",
          idempotency_key: key,
          input: {
            totalPrice: { value: value * quantity, currency: "EUR" },
            validThrough: `${DAY}T18:00:00Z`,
            lines: [{ name: "Wheel rebuild", quantity, price: { value, currency: "EUR" } }],
          },
        },
        s.owner,
      );

    // Quoted, then revised: the new quote replaces ours, and the customer's request stays answered.
    expect((await quote(31_000, 1, "quote-1")).status).toBe(200);
    expect((await quote(29_000, 1, "quote-2")).status).toBe(200);
    const offers = async () =>
      (
        (await (await s.send("GET", `/v1/owner/items/${id}/offers`, undefined, s.owner)).json()) as {
          offers: { by: string; status: string; form: string }[];
        }
      ).offers.map((o) => `${o.by} ${o.form} ${o.status}`);
    expect(await offers()).toEqual(["customer request countered", "business quote superseded", "business quote open"]);

    // The customer's assistant reads it and asks for two instead: back with us, our quote gone.
    const status = (await (await s.send("GET", `/v1/items/${id}?${q}`)).json()) as {
      offer: { kind: string; terms_sha: string };
      next: { action: string }[];
    };
    expect(status.offer.kind).toBe("quote");
    expect(status.next.map((n) => n.action)).toContain("make_offer");
    const countered = await s.send("POST", `/v1/items/${id}/offers?${q}`, {
      terms: { quantity: 2 },
      note: "Both wheels, please.",
      idempotency_key: "counter-1",
    });
    expect(countered.status, await countered.clone().text()).toBe(200);
    expect(await countered.json()).toMatchObject({
      view: { item: { state: "received", payload: { quantity: 2 } }, waiting_on: "us" },
    });

    // Quoted again for two: the email carries the terms and one link for each answer.
    expect((await quote(29_000, 2, "quote-3")).status).toBe(200);
    await s.drain();
    const email = s.lastMail();
    expect(email).toMatch(s.w.quoted580);
    expect(email.replace(/https?:\/\/\S+/g, "")).not.toMatch(NOT_THE_BUSINESS);
    const links = linksIn(email);
    expect(Object.keys(links)).toEqual([s.w.accept, s.w.decline]);

    // The link's page shows the quote and the legal button; opening it (twice) writes nothing.
    const before = await counts(s.db);
    const page = await s.app.request(`${BASE}${links[s.w.accept]}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    await s.app.request(`${BASE}${links[s.w.accept]}`);
    expect(await counts(s.db)).toEqual(before);
    expect(html).toContain(s.w.acceptQuote);
    expect(html).toContain(s.w.obligation);
    expect(html).toMatch(s.w.quoted580);
    expect(html).not.toMatch(NOT_THE_BUSINESS);
    expect((await itemRow(s.db, id)).state).toBe("quoted");

    // The POST acts, once: the quote is accepted and the order made, already accepted, in the same write.
    const acted = await s.submit(links[s.w.accept] as string, formOf(html));
    expect(acted.status).toBe(303);
    expect((await itemRow(s.db, id)).state).toBe("accepted");
    const [order] = await linkedTo(s.db, id);
    expect(order).toMatchObject({
      type: "order",
      state: "accepted",
      payload: { totalPrice: { value: 58_000, currency: "EUR" } },
    });
    expect((await offers()).at(-1)).toBe("business quote accepted");
    // A second POST of the same page does nothing more.
    const again = await s.submit(links[s.w.accept] as string, formOf(html));
    expect(again.status).toBe(409);
    expect(await linkedTo(s.db, id)).toHaveLength(1);
    await s.drain();
    expect(s.lastMail()).toMatch(s.w.quoted580);
  });

  it("a booking: confirmed, moved by the customer, accepted by the owner; the move is a receipt only under rules 6", async () => {
    const s = await setup(lang, { network: true });
    const b = await booked(s);
    expect((await s.send("POST", `/v1/owner/items/${b.id}/transitions`, { event: "confirm" }, s.owner)).status).toBe(
      200,
    );
    await s.drain();
    expect(s.net.posted).toEqual(["booking confirmed"]);
    expect(Object.keys(linksIn(s.lastMail()))).toEqual([s.w.changeTime]);

    // The network holding the promise applies rules 5, which would hold us to the date first agreed:
    // the customer's move goes to a person as their message, and what was agreed stands.
    const move = (key: string) =>
      s.send("POST", `/v1/items/${b.id}/offers?${b.q}`, {
        terms: { start_time: `${DAY}T13:00:00Z` },
        note: "The afternoon suits me better.",
        idempotency_key: key,
      });
    const held = await move("move-1");
    expect(held.status, await held.clone().text()).toBe(202);
    expect(await held.json()).toMatchObject({ waiting_on: "us", appended: true });
    expect((await itemRow(s.db, b.id)).payload).toMatchObject({ startTime: `${DAY}T09:00:00Z` });

    // The network now applies rules 6, and says so the next day: the same move is now a change.
    s.net.state.version = 6;
    await s.nextDaysTick();
    const asked = await move("move-2");
    expect(asked.status, await asked.clone().text()).toBe(200);
    expect(await asked.json()).toMatchObject({
      view: {
        item: { state: "confirmed", payload: { startTime: `${DAY}T09:00:00Z` } },
        waiting_on: "us",
        requested_change: { terms: { startTime: `${DAY}T13:00:00.000Z` } },
      },
    });
    const accepted = await s.send(
      "POST",
      `/v1/owner/items/${b.id}/transitions`,
      { event: "accept_change", idempotency_key: "accept-change-1" },
      s.owner,
    );
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const after = (await (await s.send("GET", `/v1/items/${b.id}?${b.q}`)).json()) as {
      agreed: { terms: { startTime: string } };
      requested_change: unknown;
    };
    expect(after).toMatchObject({ agreed: { terms: { startTime: `${DAY}T13:00:00.000Z` } }, requested_change: null });
    await s.drain();
    expect(s.lastMail()).toMatch(s.w.moved);
    expect(s.lastMail().replace(/https?:\/\/\S+/g, "")).not.toMatch(NOT_THE_BUSINESS);
    expect(s.net.posted).toEqual(["booking confirmed", "booking amended"]);
  });

  it("an order: paid, withdrawn from the link within 14 days and refunded; the refund's receipts wait for rules 6", async () => {
    const s = await setup(lang, { network: true });
    const order = {
      payload: {
        orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 2, price: { value: 1850, currency: "EUR" } }],
        totalPrice: { value: 3700, currency: "EUR" },
      },
      contact: { name: s.w.name, email: s.w.email, locale: s.w.locale },
    };
    // The confirm step: nothing binds the customer until they confirm the summary.
    const first = await s.send("POST", "/v1/orders", order);
    expect(first.status).toBe(409);
    const problem = (await first.json()) as {
      code: string;
      details: { terms_sha: string; obligation_to_pay: boolean };
    };
    expect(problem).toMatchObject({ code: "confirm_terms", details: { obligation_to_pay: true } });
    const made = await s.send("POST", "/v1/orders", { ...order, terms_sha: problem.details.terms_sha });
    expect(made.status, await made.clone().text()).toBe(201);
    const id = ((await made.json()) as Created).view.item.id;
    for (const [event, input] of [
      ["accept", undefined],
      ["record_payment", { paymentRef: "pi_1", amount: { value: 3700, currency: "EUR" } }],
    ] as const) {
      const moved = await s.send("POST", `/v1/owner/items/${id}/transitions`, { event, input }, s.owner);
      expect(moved.status, event).toBe(200);
    }
    await s.drain();
    expect(s.net.posted).toEqual(["order accepted", "order paid"]);

    // The confirmation carries the withdrawal link; its page shows the statement and writes nothing.
    const link = linksIn(s.lastMail())[s.w.withdraw] as string;
    expect(link).toBeTruthy();
    const before = await counts(s.db);
    const page = await s.app.request(`${BASE}${link}`);
    const html = await page.text();
    expect(html).toContain(s.w.withdrawHeading);
    expect(html).toContain(s.w.confirmWithdrawal);
    expect(html).toContain(s.w.email);
    expect(html).not.toMatch(NOT_THE_BUSINESS);
    expect(await counts(s.db)).toEqual(before);

    // Confirmed: the order ends, neutrally, and what was paid is owed back — agreed, nobody asked.
    const sent = await s.submit(link, formOf(html));
    expect(sent.status).toBe(303);
    expect((await itemRow(s.db, id)).state).toBe("cancelled");
    const [refund] = await linkedTo(s.db, id);
    expect(refund).toMatchObject({
      type: "refund",
      state: "approved",
      payload: { kind: "withdrawal", amount: { value: 3700, currency: "EUR" } },
    });
    const paid = await s.send(
      "POST",
      `/v1/owner/items/${refund?.id}/transitions`,
      { event: "refund", input: { paymentRef: "re_1" } },
      s.owner,
    );
    expect(paid.status, await paid.clone().text()).toBe(200);
    expect((await itemRow(s.db, refund?.id as string)).state).toBe("refunded");
    await s.drain();
    // Rules 5, nothing announced: the order's outcome goes, the refund's receipts wait.
    expect(s.net.posted).toEqual(["order accepted", "order paid", "order.cancelled_by_customer"]);
    const local = await s.db.client.query({
      sql: "SELECT kind, outcome FROM receipts WHERE item_id = ? ORDER BY kind",
      params: [refund?.id],
      method: "all",
    });
    expect(local.rows.map((r) => `${String(r[0])} ${String(r[1] ?? "")}`.trim())).toEqual([
      "accepted",
      "outcome refund.honoured",
    ]);

    // The network announces rules 6: at its next tick, what waited goes, the promise first.
    s.net.state.next = 6;
    await s.nextDaysTick();
    expect(s.net.posted.slice(3)).toEqual(["refund accepted", "refund.honoured"]);
  });

  it("a price of the customer's own while price counters are off: their message, for a person", async () => {
    const s = await setup(lang);
    const business = (await (await s.send("GET", "/v1/business")).json()) as { price_negotiable: boolean };
    expect(business.price_negotiable).toBe(false);
    const b = await booked(s);
    const proposed = await s.send(
      "POST",
      `/v1/owner/items/${b.id}/transitions`,
      { event: "propose", input: { startTime: `${DAY}T13:00:00Z`, endTime: `${DAY}T14:30:00Z` } },
      s.owner,
    );
    expect(proposed.status).toBe(200);
    const priced = await s.send("POST", `/v1/items/${b.id}/offers?${b.q}`, {
      terms: { total_price: { value: 3000, currency: "EUR" } },
      note: "Would you do it for 30?",
      idempotency_key: "price-1",
    });
    expect(priced.status, await priced.clone().text()).toBe(202);
    const body = (await priced.json()) as { waiting_on: string; appended: boolean; passed_on: string };
    expect(body).toMatchObject({ waiting_on: "us", appended: true });
    expect(body.passed_on).toMatch(s.w.passedOn);
    // What we proposed stands, at our price; the owner has the customer's words to answer.
    const row = await itemRow(s.db, b.id);
    expect(row).toMatchObject({ state: "proposed", payload: { totalPrice: { value: 4500, currency: "EUR" } } });
    const detail = (await (await s.send("GET", `/v1/owner/items/${b.id}`, undefined, s.owner)).json()) as {
      thread: { direction: string; body: string }[];
    };
    expect(detail.thread.map((t) => t.body)).toEqual(expect.arrayContaining([expect.stringContaining("30")]));
  });

  it("a reward the owner set: the customer's price, with the notice in our voice", async () => {
    const s = await setup(lang);
    const saved = await s.send(
      "PUT",
      "/v1/owner/settings",
      {
        doc: {
          negotiation: {
            rewards: {
              regulars: {
                if: { path: "customer.completed", op: "gte", value: 1 },
                pct: 5,
                says: "Thank you for coming back.",
              },
            },
          },
        },
      },
      s.owner,
    );
    expect(saved.status, await saved.clone().text()).toBe(200);
    // A first visit, at the list price: no record yet.
    const first = await booked(s);
    expect((await itemRow(s.db, first.id)).payload).toMatchObject({ totalPrice: { value: 4500, currency: "EUR" } });
    for (const event of ["confirm", "complete"]) {
      const r = await s.send("POST", `/v1/owner/items/${first.id}/transitions`, { event }, s.owner);
      expect(r.status, event).toBe(200);
    }
    // Her assistant comes back with its key, which names her: the summary she confirms holds her price.
    const party = (await itemRow(s.db, first.id)).partyId;
    const key = (await createApiKey(s.db, { kind: "agent", name: s.w.name, partyId: party })).key;
    const headers = { authorization: `Bearer ${key}` };
    const request = {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: `${DAY}T13:00:00Z`,
        endTime: `${DAY}T14:30:00Z`,
      },
      contact: { name: s.w.name, email: s.w.email, locale: s.w.locale },
    };
    const asked = await s.send("POST", "/v1/bookings", request, headers);
    expect(asked.status).toBe(409);
    const d = ((await asked.json()) as { details: Record<string, unknown> }).details as {
      summary: string;
      terms: { totalPrice: unknown };
      disclosures: string[];
      terms_sha: string;
    };
    expect(d.terms.totalPrice).toEqual({ value: 4275, currency: "EUR" });
    expect(d.disclosures).toEqual(["personalised_price"]);
    // Money is written with the no-break spaces of the customer's locale.
    const plain = (t: string) => t.replace(/\s/g, " ");
    expect(plain(d.summary)).toContain(s.w.notice);
    expect(d.summary).not.toMatch(NOT_THE_BUSINESS);
    const made = await s.send("POST", "/v1/bookings", { ...request, terms_sha: d.terms_sha }, headers);
    expect(made.status, await made.clone().text()).toBe(201);
    const { view } = (await made.json()) as Created & { view: { item: { payload: unknown } } };
    expect(view.item.payload).toMatchObject({
      totalPrice: { value: 4275, currency: "EUR" },
      personalised: { listPrice: { value: 4500, currency: "EUR" } },
    });
    const status = (await (await s.send("GET", `/v1/items/${view.item.id}`, undefined, headers)).json()) as {
      human: string;
    };
    expect(plain(status.human)).toContain(s.w.notice.split(".")[0]);
  });

  it("the owner's AI, on the owner's own key: a time it may offer, money it may not touch", async () => {
    const s = await setup(lang);
    const b = await booked(s);
    const ai = await s.connectOwnerAi();
    const text = (r: { content: unknown }) => (r.content as { text: string }[])[0]?.text ?? "";

    // Money no: a lower price is a draft for the owner, and the customer hears nothing of it.
    const cheaper = await ai.callTool({
      name: "make_offer",
      arguments: {
        item_id: b.id,
        input: {
          startTime: `${DAY}T13:00:00Z`,
          endTime: `${DAY}T14:30:00Z`,
          totalPrice: { value: 4000, currency: "EUR" },
        },
      },
    });
    expect(cheaper.isError, text(cheaper)).toBeFalsy();
    expect(text(cheaper)).toMatch(/^Not sent: .*below_floor/);
    expect((await itemRow(s.db, b.id)).state).toBe("requested");

    // Time yes: another time, at our price, goes to the customer, marked as sent automatically.
    const later = await ai.callTool({
      name: "make_offer",
      arguments: { item_id: b.id, input: { startTime: `${DAY}T13:00:00Z`, endTime: `${DAY}T14:30:00Z` } },
    });
    expect(later.isError, text(later)).toBeFalsy();
    expect((await itemRow(s.db, b.id)).state).toBe("proposed");
    await s.drain();
    const proposal = s.lastMail();
    expect(proposal).toContain(s.w.automated);
    expect(proposal).not.toMatch(/40[.,]00/);

    // Money no: it records no payment, whatever key it holds.
    const order = await assistant(s, "POST", "/v1/orders", {
      payload: {
        orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 1, price: { value: 1850, currency: "EUR" } }],
        totalPrice: { value: 1850, currency: "EUR" },
      },
      contact: { name: s.w.name, email: s.w.email, locale: s.w.locale },
    });
    expect(order.status).toBe(201);
    const orderId = ((await order.json()) as Created).view.item.id;
    expect((await s.send("POST", `/v1/owner/items/${orderId}/transitions`, { event: "accept" }, s.owner)).status).toBe(
      200,
    );
    const payment = await ai.callTool({
      name: "transition_item",
      arguments: {
        item_id: orderId,
        event: "record_payment",
        input: { paymentRef: "pi_ai", amount: { value: 1850, currency: "EUR" } },
      },
    });
    expect(payment.isError).toBe(true);
    expect((payment.structuredContent as { error: { code: string } }).error.code).toBe("not_allowed");
    expect((await itemRow(s.db, orderId)).payload).not.toHaveProperty("paidAmount");
    await ai.close();
  });
});
