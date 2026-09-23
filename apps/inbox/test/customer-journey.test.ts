import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey, hashKey } from "@surfingdog/adapters";
import { ensureLifecycleSweep, networkSuccessStatement, type PublicJwk, schema, ulid } from "@surfingdog/core";
import { logMailOut, type MailOut, type OutboundMail } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { fakeNetwork } from "../../../packages/adapters/test/fake-network";
import { createInbox } from "../src/app";
import { freshDb, futureDay } from "./harness";

/**
 * One customer, end to end, through the whole app as it runs: an assistant books, the business
 * proposes another time, the customer reads the email, opens the link (a GET that does nothing),
 * accepts (a POST), is told it is booked, answers the email from their own mailbox, the answer lands
 * on the same booking, and the business's reply is there for the assistant at the status door. In
 * English over REST, in Portuguese over MCP; a quote declined by its link; a test booking that
 * emails nobody and calls no network; and a customer's privacy, from the code email's own page to
 * the owner exporting and erasing her. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const BASE = "https://inbox.example.com";
const DAY = futureDay();
const INBOUND = "journey-inbound-secret-0123456789";
const NETWORK = "https://net.example.com";

async function setup(languages: string[], opts: { network?: "down" | "issuing" } = {}) {
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
  // The mail service: keeps each email and the id it gave it, as a real one would return.
  const log = logMailOut();
  const ids: string[] = [];
  const mailOut: MailOut = {
    sender: log.sender,
    async send(mail) {
      const r = await log.send(mail);
      ids.push(r.messageId);
      return r;
    },
  };
  // Every call the inbox makes to the outside world: here, only ever a network — one that is down,
  // or one that issues each new customer a code and checks every call's signature.
  const calls: string[] = [];
  let inboxRef: ReturnType<typeof createInbox> | null = null;
  const net = fakeNetwork({
    host: new URL(NETWORK).host,
    keys: async () => (await (inboxRef as ReturnType<typeof createInbox>).caps.receipts.jwks()).keys as PublicJwk[],
    instanceDomain: new URL(BASE).host,
  });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input instanceof Request ? input.url : input));
    if (opts.network === "issuing") return net.fetchImpl(input, init);
    return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const inbox = createInbox({
    db,
    mailOut,
    baseUrl: BASE,
    secretKey: "customer-journey-test-secret-0123456789",
    fetchImpl,
    background: () => {},
  });
  inboxRef = inbox;
  const key = await createApiKey(db, { kind: "owner", name: "t" });
  const owner = { authorization: `Bearer ${key.key}` };
  const put = await inbox.app.request(
    new Request(`${BASE}/v1/owner/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...owner },
      body: JSON.stringify({
        doc: {
          email: { inboundSecret: INBOUND },
          // A network switched on, and verified: a real request asks it; a test one never does.
          networks: { [NETWORK]: { enabled: true, issue: true, share: { listing: false } } },
        },
      }),
    }),
  );
  expect(put.status).toBe(200);
  await db.client.query(networkSuccessStatement(NETWORK, Date.now(), { registration: "registered", pinged: true }));
  // Whatever switching the network on queued has run: from here on, a call is the customer's doing.
  for (let i = 0; i < 20; i++) if ((await inbox.runner.runDue(db, { limit: 100 })).claimed === 0) break;
  calls.length = 0;
  return { db, inbox, app: inbox.app, sent: log.sent, ids, calls, net, svc, owner };
}
type S = Awaited<ReturnType<typeof setup>>;

const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "SomeAssistant/1.0", ...headers },
    body: JSON.stringify(body),
  });

/** Runs what is due; `aheadMs` later for what waits a moment (the acknowledgement waits 90 seconds). */
async function drain(s: S, aheadMs = 0) {
  for (let i = 0; i < 20; i++) {
    if ((await s.inbox.runner.runDue(s.db, { limit: 100, now: Date.now() + aheadMs })).claimed === 0) return;
  }
}
const LATER = 2 * 60_000;

/** The emails to one address, in the order they went, each with the id the service gave it. */
function mailTo(s: S, to: string): { mail: OutboundMail; id: string }[] {
  return s.sent.map((mail, i) => ({ mail, id: s.ids[i] as string })).filter((m) => m.mail.to.includes(to));
}

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

const submit = (s: S, path: string, form: Record<string, string>) =>
  s.app.request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
  });

async function counts(s: S) {
  const one = async (sql: string) => Number((await s.db.client.query({ sql, method: "all" })).rows[0]?.[0]);
  return {
    events: await one("SELECT COUNT(*) FROM item_events"),
    jobs: await one("SELECT COUNT(*) FROM jobs"),
    used: await one("SELECT COUNT(*) FROM action_links WHERE used_at IS NOT NULL"),
    items: await one("SELECT COUNT(*) FROM items"),
  };
}

async function stateOf(s: S, id: string): Promise<string> {
  const { rows } = await s.db.client.query({
    sql: "SELECT state FROM items WHERE id = ?",
    params: [id],
    method: "all",
  });
  return String(rows[0]?.[0]);
}

/** A customer's email reply, as their mail client writes it: quoting ours, naming it in the headers. */
function replyMime(o: {
  from: string;
  subject: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  body: string;
}): string {
  return [
    `From: Rita <${o.from}>`,
    "To: Oficina Maré <inbox@localhost>",
    `Subject: Re: ${o.subject}`,
    `Message-ID: ${o.messageId}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
    ...(o.references ? [`References: ${o.references}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    o.body,
  ].join("\r\n");
}

const inbound = (s: S, raw: string) =>
  s.app.request(
    new Request(`${BASE}/v1/email/inbound`, {
      method: "POST",
      headers: { "x-inbox-email-secret": INBOUND, "content-type": "message/rfc822" },
      body: raw,
    }),
  );

async function connect(s: S) {
  const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("user-agent", "SomeAssistant/1.0");
    return s.app.request(String(input), { ...init, headers });
  };
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { fetch: fetchLike });
  const client = new Client({ name: "some-assistant", version: "0" });
  await client.connect(transport);
  return client;
}

/** What only the business sees never reaches the customer: its flags, its notes. */
function expectNothingInternal(body: string) {
  expect(body).not.toMatch(/needsHuman|"priority"|"spam"|"flags"/);
  expect(body).not.toContain("Internal: she is a regular.");
  expect(body).not.toContain("Nota interna: cliente habitual.");
}

describe("a customer, end to end", () => {
  it("in English: booked by an assistant, another time proposed, accepted by the link, answered by email", async () => {
    const s = await setup(["en"]);
    const rita = "rita@example.com";

    // 1. The assistant books over REST, for 09:00.
    const created = await s.app.request(
      json("/v1/bookings", {
        payload: {
          reservationFor: { serviceId: s.svc, name: "Full service" },
          startTime: `${DAY}T09:00:00Z`,
          endTime: `${DAY}T10:30:00Z`,
        },
        contact: { name: "Rita", email: rita },
      }),
    );
    expect(created.status).toBe(201);
    const createdText = await created.text();
    expectNothingInternal(createdText);
    const booking = JSON.parse(createdText) as { view: { item: { id: string; state: string } }; accessToken: string };
    const id = booking.view.item.id;
    expect(booking.view.item.state).toBe("requested");
    await drain(s, LATER);
    // The request is acknowledged, in the business's name, with the price.
    const [ack] = mailTo(s, rita);
    expect(ack?.mail.subject).toMatch(/Full service/);
    expect(ack?.mail.from.name).toBe("Oficina Maré");
    expect(ack?.mail.text).toContain("€45.00");
    expect(ack?.mail.text).toMatch(/Western European|GMT|WE[S]?T/);
    expect(ack?.mail.text).not.toMatch(/surfing|network|assistant/i);
    // A real request asked the network about its customer.
    expect(s.calls.some((u) => u.startsWith(NETWORK) && !u.endsWith("/ping"))).toBe(true);

    // 2. The owner proposes 13:00 instead.
    const moved = await s.app.request(
      json(
        `/v1/owner/items/${id}/transitions`,
        { event: "propose", input: { startTime: `${DAY}T13:00:00Z`, endTime: `${DAY}T14:30:00Z` } },
        s.owner,
      ),
    );
    expect(moved.status).toBe(200);
    await drain(s);

    // 3. The email: English, the time in Lisbon with the zone named, the price, until when, the links.
    const proposal = mailTo(s, rita).at(-1);
    const text = proposal?.mail.text ?? "";
    expect(proposal?.mail.subject).toMatch(/Full service/);
    expect(text).toMatch(/^Hello Rita,/);
    expect(text).toMatch(/at 1[34]:00 \((Western European[^)]*|GMT\+1|WEST|WET)\)/);
    expect(text).toMatch(/at 1[01]:00 \(/); // what they asked for, 09:00 UTC in Lisbon
    expect(text).toContain("€45.00");
    expect(text).toMatch(/[Aa]nswer by|[Rr]eply by|until/);
    const links = linksIn(text);
    expect(Object.keys(links)).toEqual(["Accept", "Decline", "Pick another time"]);
    expect(text).toContain(`Reference: ${id.slice(-6).toUpperCase()}`);
    expect(text).not.toMatch(/surfing|network|assistant/i);
    // Threaded on the acknowledgement: the item's anchor first in References.
    const anchor = proposal?.mail.headers?.References?.split(" ")[0] as string;
    expect(anchor).toMatch(/^<a\.[0-9a-z]+@localhost>$/);
    expect(proposal?.mail.headers?.["In-Reply-To"]).toBe(anchor);

    // 4. The link opens a page that shows the terms and changes nothing.
    const before = await counts(s);
    const page = await s.app.request(`${BASE}${links.Accept}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<title>Oficina Maré</title>");
    expect(html).toContain("Accept this time?");
    expect(html).toContain("€45.00");
    expect(html).toMatch(/at 1[34]:00 \(/);
    expect(html).not.toMatch(/surfing/i);
    await s.app.request(`${BASE}${links.Decline}`);
    expect(await counts(s)).toEqual(before);
    expect(await stateOf(s, id)).toBe("proposed");

    // 5. Accept: a POST from the page.
    const accepted = await submit(s, links.Accept as string, formOf(html));
    expect(accepted.status).toBe(303);
    expect(await stateOf(s, id)).toBe("confirmed");
    await drain(s);

    // 6. The confirmation, on the same thread.
    const confirmation = mailTo(s, rita).at(-1);
    expect(confirmation?.mail.subject).toBe("Confirmed: Full service");
    expect(confirmation?.mail.text).toMatch(/at 1[34]:00 \(/);
    expect(confirmation?.mail.text).toContain("€45.00");
    expect(confirmation?.mail.headers?.References?.split(" ")[0]).toBe(anchor);

    // 7. Rita answers the confirmation from her own mailbox.
    const replied = await inbound(
      s,
      replyMime({
        from: rita,
        subject: confirmation?.mail.subject ?? "",
        messageId: "<rita-1@mail.example.com>",
        inReplyTo: `<${confirmation?.id}>`,
        references: `${confirmation?.mail.headers?.References} <${confirmation?.id}>`,
        body: "Thanks! Can I bring my own saddle?\r\n\r\nOn Monday, Oficina Maré <inbox@localhost> wrote:\r\n> Confirmed.",
      }),
    );
    expect(replied.status).toBe(200);
    expect(await replied.json()).toEqual({ outcome: "replied", itemId: id });
    await drain(s);

    // 8. The business answers, and writes itself a note.
    const answer = await s.app.request(
      json(`/v1/owner/items/${id}/replies`, { body: "Of course, bring it along." }, s.owner),
    );
    expect(answer.status).toBe(200);
    await s.app.request(
      json(`/v1/owner/items/${id}/replies`, { body: "Internal: she is a regular.", internal: true }, s.owner),
    );
    await drain(s);
    const reply = mailTo(s, rita).at(-1);
    expect(reply?.mail.text).toContain("Of course, bring it along.");
    expect(reply?.mail.text).not.toContain("Internal: she is a regular.");
    // It answers her email: In-Reply-To names it.
    expect(reply?.mail.headers?.["In-Reply-To"]).toBe("<rita-1@mail.example.com>");
    expect(reply?.mail.headers?.References?.split(" ")[0]).toBe(anchor);

    // 9. The assistant reads it at the status door, with her message and never the note.
    const status = await s.app.request(`${BASE}/v1/items/${id}?access_token=${booking.accessToken}`);
    expect(status.status).toBe(200);
    const statusText = await status.text();
    expectNothingInternal(statusText);
    const view = JSON.parse(statusText) as { item: { state: string }; thread: { from: string; text: string }[] };
    expect(view.item.state).toBe("confirmed");
    expect(view.thread).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "you", text: "Thanks! Can I bring my own saddle?" }),
        expect.objectContaining({ from: "us", text: "Of course, bring it along." }),
      ]),
    );

    // The owner's app shows every email and that each went out; one item, not two.
    const detail = (await (await s.app.request(`${BASE}/v1/owner/items/${id}`, { headers: s.owner })).json()) as {
      mail: { recipient: string; template: string; status: string }[];
    };
    const customerMail = detail.mail.filter((m) => m.recipient === "customer");
    // (The acknowledgement went 90 seconds after the request, which this test reached by running ahead.)
    expect(customerMail.map((m) => m.template).sort()).toEqual(
      ["ack.booking", "booking.accepted", "booking.proposed", "reply"].sort(),
    );
    expect(customerMail.every((m) => m.status === "sent")).toBe(true);
    expect((await counts(s)).items).toBe(1);
  });

  it("in Portuguese: the customer's own language, over MCP, a reply found by References alone", async () => {
    // The business writes English first; the customer's assistant says she reads Portuguese.
    const s = await setup(["en", "pt"]);
    const ana = "ana@example.pt";
    const mcp = await connect(s);
    const booked = await mcp.callTool({
      name: "create_booking",
      arguments: {
        payload: {
          reservationFor: { serviceId: s.svc, name: "Full service" },
          startTime: `${DAY}T09:00:00Z`,
          endTime: `${DAY}T10:30:00Z`,
        },
        contact: { name: "Ana", email: ana, locale: "pt-PT" },
      },
    });
    expect(booked.isError).toBeFalsy();
    expectNothingInternal(JSON.stringify(booked.structuredContent));
    const r = booked.structuredContent as { view: { item: { id: string } }; accessToken: string };
    const id = r.view.item.id;
    await drain(s, LATER);
    const [ack] = mailTo(s, ana);
    expect(ack?.mail.text).toMatch(/^Olá Ana,/);
    expect(ack?.mail.text).toMatch(/45,00\s€/);

    await s.app.request(
      json(
        `/v1/owner/items/${id}/transitions`,
        { event: "propose", input: { startTime: `${DAY}T13:00:00Z`, endTime: `${DAY}T14:30:00Z` } },
        s.owner,
      ),
    );
    await drain(s);
    const proposal = mailTo(s, ana).at(-1);
    const text = proposal?.mail.text ?? "";
    expect(text).toMatch(/às 1[34]:00 \((hora da Europa Ocidental[^)]*|GMT\+1|WEST|WET)\)/);
    expect(text).toMatch(/45,00\s€/);
    expect(text).toContain(`Referência: ${id.slice(-6).toUpperCase()}`);
    const links = linksIn(text);
    expect(Object.keys(links)).toEqual(["Aceitar", "Recusar", "Escolher outra hora"]);
    expect(text).not.toMatch(/surfing|rede|assistente/i);

    const before = await counts(s);
    const page = await s.app.request(`${BASE}${links.Aceitar}`);
    const html = await page.text();
    expect(html).toContain('<html lang="pt">');
    expect(html).toContain("Aceitar esta hora?");
    expect(html).toMatch(/45,00(\s|&nbsp;|&#160;)€/);
    expect(await counts(s)).toEqual(before);

    const accepted = await submit(s, links.Aceitar as string, formOf(html));
    expect(accepted.status).toBe(303);
    expect(await stateOf(s, id)).toBe("confirmed");
    await drain(s);
    const confirmation = mailTo(s, ana).at(-1);
    expect(confirmation?.mail.subject).toMatch(/^Confirmad[ao]: Full service$/);
    expect(confirmation?.mail.text).toMatch(/45,00\s€/);

    // Her mail client names only the thread (no In-Reply-To): the anchor finds the booking.
    const replied = await inbound(
      s,
      replyMime({
        from: ana,
        subject: confirmation?.mail.subject ?? "",
        messageId: "<ana-1@mail.example.pt>",
        references: confirmation?.mail.headers?.References ?? "",
        body: "Obrigada! Posso levar o meu selim?\r\n\r\nEm segunda-feira, Oficina Maré escreveu:\r\n> Confirmada.",
      }),
    );
    expect(await replied.json()).toEqual({ outcome: "replied", itemId: id });
    await s.app.request(json(`/v1/owner/items/${id}/replies`, { body: "Claro, traga-o." }, s.owner));
    await s.app.request(
      json(`/v1/owner/items/${id}/replies`, { body: "Nota interna: cliente habitual.", internal: true }, s.owner),
    );
    await drain(s);
    const reply = mailTo(s, ana).at(-1);
    expect(reply?.mail.text).toContain("Claro, traga-o.");
    expect(reply?.mail.headers?.["In-Reply-To"]).toBe("<ana-1@mail.example.pt>");

    const status = await mcp.callTool({
      name: "get_item_status",
      arguments: { item_id: id, access_token: r.accessToken },
    });
    expect(status.isError).toBeFalsy();
    expectNothingInternal(JSON.stringify(status));
    const view = status.structuredContent as { human: string; thread: { from: string; text: string }[] };
    expect(view.human).toMatch(/confirmad/i);
    expect(view.thread).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "you", text: "Obrigada! Posso levar o meu selim?" }),
        expect.objectContaining({ from: "us", text: "Claro, traga-o." }),
      ]),
    );
    await mcp.close();
  });

  it("a quote: requested, quoted, and declined by the link in the email", async () => {
    const s = await setup(["en"]);
    const rita = "rita@example.com";
    const created = await s.app.request(
      json("/v1/quotes", {
        payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel, 28 spokes" },
        contact: { name: "Rita", email: rita },
      }),
    );
    expect(created.status).toBe(201);
    const q = (await created.json()) as { view: { item: { id: string } }; accessToken: string };
    const id = q.view.item.id;
    await drain(s, LATER);
    expect(mailTo(s, rita).at(-1)?.mail.subject).toMatch(/Wheel rebuild/);

    const validThrough = `${DAY}T18:00:00Z`;
    const quoted = await s.app.request(
      json(
        `/v1/owner/items/${id}/transitions`,
        {
          event: "quote",
          input: {
            totalPrice: { value: 31000, currency: "EUR" },
            validThrough,
            lines: [
              { name: "Rim", quantity: 1, price: { value: 9500, currency: "EUR" } },
              { name: "Spokes", quantity: 28, price: { value: 250, currency: "EUR" } },
              { name: "Build", quantity: 1, price: { value: 14500, currency: "EUR" } },
            ],
          },
        },
        s.owner,
      ),
    );
    expect(quoted.status).toBe(200);
    await drain(s);
    const quote = mailTo(s, rita).at(-1)?.mail.text ?? "";
    expect(quote).toContain("28 × Spokes — €70.00");
    expect(quote).toContain("€310.00");
    expect(quote).toMatch(/at 1[89]:00 \(/);
    const links = linksIn(quote);
    expect(Object.keys(links)).toEqual(["Accept", "Decline"]);

    const before = await counts(s);
    const page = await s.app.request(`${BASE}${links.Decline}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("€310.00");
    expect(await counts(s)).toEqual(before);
    expect(await stateOf(s, id)).toBe("quoted");

    const declined = await submit(s, links.Decline as string, formOf(html));
    expect(declined.status).toBe(303);
    expect(await stateOf(s, id)).toBe("declined");
    // The Accept link has nothing left to do.
    expect((await s.app.request(`${BASE}${links.Accept}`)).status).toBe(409);
    await drain(s);
    const last = mailTo(s, rita).at(-1);
    expect(last?.mail.subject).toMatch(/Wheel rebuild/);
    const detail = (await (await s.app.request(`${BASE}/v1/owner/items/${id}`, { headers: s.owner })).json()) as {
      mail: { recipient: string; template: string; status: string }[];
      events: { event: string; actor: string }[];
    };
    expect(
      detail.mail
        .filter((m) => m.recipient === "customer")
        .map((m) => m.template)
        .sort(),
    ).toEqual(["ack.quote", "quote.declined", "quote.quoted"]);
    expect(detail.events.at(-1)?.actor).toMatch(/^customer_/);
  });

  it("a test booking emails nobody and calls no network, all the way through", async () => {
    const s = await setup(["en"]);
    const created = await s.app.request(
      json(
        "/v1/bookings",
        {
          payload: {
            reservationFor: { serviceId: s.svc, name: "Full service" },
            startTime: `${DAY}T09:00:00Z`,
            endTime: `${DAY}T10:30:00Z`,
          },
          contact: { name: "Rita", email: "rita@example.com" },
        },
        { "x-sandbox": "1" },
      ),
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { view: { item: { id: string } } }).view.item.id;
    await drain(s, LATER);
    await s.app.request(
      json(
        `/v1/owner/items/${id}/transitions`,
        { event: "propose", input: { startTime: `${DAY}T13:00:00Z`, endTime: `${DAY}T14:30:00Z` } },
        s.owner,
      ),
    );
    await s.app.request(json(`/v1/owner/items/${id}/transitions`, { event: "confirm" }, s.owner));
    await s.app.request(json(`/v1/owner/items/${id}/replies`, { body: "See you then." }, s.owner));
    await drain(s);
    expect(await stateOf(s, id)).toBe("confirmed");
    expect(s.sent).toEqual([]);
    // Nothing about it went to the network: only the inbox's own hourly ping, which names no one.
    expect(s.calls.filter((u) => !u.endsWith("/ping"))).toEqual([]);
    const detail = (await (await s.app.request(`${BASE}/v1/owner/items/${id}`, { headers: s.owner })).json()) as {
      mail: { recipient: string; status: string; skip_reason: string | null }[];
    };
    expect(detail.mail.length).toBeGreaterThanOrEqual(3);
    expect(detail.mail.every((m) => m.status === "skipped" && m.skip_reason === "test_item")).toBe(true);
  });
});

const DAY_MS = 24 * 60 * 60_000;
const AUTOMATIC_EN = "This reply was sent automatically. Reply to reach a person.";

/** An OAuth access token for an AI app the owner connected, as the consent flow issues one. */
async function ownerAiToken(s: S): Promise<Record<string, string>> {
  const token = `sdi_at_${ulid()}${ulid()}`;
  await s.db.orm
    .insert(schema.oauthClients)
    .values({
      id: "client_ai",
      name: "Some AI",
      redirectUris: ["https://ai.example.com/cb"],
      kind: "cimd",
      createdAt: T0,
    })
    .onConflictDoNothing();
  await s.db.orm.insert(schema.oauthTokens).values({
    tokenHash: await hashKey(token),
    kind: "access",
    clientId: "client_ai",
    userId: "user_1",
    scope: "inbox:read inbox:write settings:read",
    familyId: ulid(),
    expiresAt: Date.now() + 3_600_000,
    createdAt: T0,
  });
  return { authorization: `Bearer ${token}` };
}

/** Every text column of every table, as one string: where a customer's words could still be. */
async function everything(s: S): Promise<string> {
  const { rows: tables } = await s.db.client.query({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '__drizzle%'",
    method: "all",
  });
  const out: string[] = [];
  for (const [name] of tables) {
    const { rows } = await s.db.client.query({ sql: `SELECT * FROM "${String(name)}"`, method: "all" });
    for (const r of rows) out.push(`${String(name)}: ${JSON.stringify([...r])}`);
  }
  return out.join("\n");
}

describe("a customer's privacy, end to end", () => {
  it("stops the network from the code email's page, is exported whole, then erased by the owner and never by the owner's AI", async () => {
    const s = await setup(["en"], { network: "issuing" });
    const rita = "rita@example.com";
    const book = async (start: string, end: string) => {
      const res = await s.app.request(
        json("/v1/bookings", {
          payload: {
            reservationFor: { serviceId: s.svc, name: "Full service" },
            startTime: `${DAY}T${start}:00Z`,
            endTime: `${DAY}T${end}:00Z`,
          },
          contact: { name: "Rita", email: rita },
        }),
      );
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { view: { item: { id: string } }; accessToken: string }).view.item.id;
    };
    const sweepAt = async (ahead: number) => {
      await ensureLifecycleSweep(s.db, Date.now() + ahead);
      await drain(s, ahead);
    };

    // 1. A first booking: the network is asked, and issues her a code the inbox keeps sealed.
    const first = await book("09:00", "10:30");
    expect(s.calls.some((u) => u === `${NETWORK}/v1/persons`)).toBe(true);
    await s.app.request(json(`/v1/owner/items/${first}/transitions`, { event: "confirm" }, s.owner));
    await drain(s, LATER);
    const [code] = s.net.persons.flatMap((p) => [...p.keys].map(([id, secret]) => `${id}_${secret}`));
    expect(code).toBeDefined();
    // Nothing yet carries the code: not the acknowledgement, not the confirmation.
    expect(mailTo(s, rita).length).toBeGreaterThan(0);
    expect(mailTo(s, rita).some((m) => m.mail.text.includes(code as string))).toBe(false);

    // 2. A day on, the code goes alone, with the one line about the network and its page.
    await sweepAt(DAY_MS + 60_000);
    const codeMail = mailTo(s, rita).find((m) => m.mail.subject === "For next time");
    expect(codeMail?.mail.text).toContain(code);
    const line =
      /^We use a booking network to recognise returning customers\. How it works: (https:\/\/inbox\.example\.com\/c\/\S+)$/m.exec(
        codeMail?.mail.text ?? "",
      );
    expect(line).not.toBeNull();
    expect(codeMail?.mail.text).not.toMatch(/surfing/i);
    expect(mailTo(s, rita).filter((m) => m.mail.text.includes(code as string))).toHaveLength(1);
    const stopPath = String(line?.[1]).slice(BASE.length);

    // 3. "How to stop": the GET only shows, the page's own POST stops it.
    const before = await counts(s);
    const shown = await s.app.request(`${BASE}${stopPath}`);
    expect(shown.status).toBe(200);
    const html = await shown.text();
    expect(html).toContain("<title>Returning customers — Oficina Maré</title>");
    expect(html).toContain("Stop using it for me");
    expect(html).not.toContain("<script");
    expect(await counts(s)).toEqual(before);
    const stopped = await submit(s, stopPath, formOf(html));
    expect(stopped.status).toBe(303);
    expect(await (await s.app.request(`${BASE}${stopPath}`)).text()).toContain("Done. Since");

    // 4. Her next booking tells no network anything, and no code follows it.
    const callsBefore = s.calls.length;
    const sentBefore = s.sent.length;
    const second = await book("13:00", "14:30");
    await s.app.request(json(`/v1/owner/items/${second}/transitions`, { event: "confirm" }, s.owner));
    await drain(s, LATER);
    await sweepAt(2 * DAY_MS + 2 * 60_000);
    expect(s.calls.slice(callsBefore).filter((u) => !u.endsWith("/ping") && !u.endsWith("/v1/ranking"))).toEqual([]);
    const { rows: published } = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM network_publications WHERE receipt_id IN (SELECT id FROM receipts WHERE item_id = ?)",
      params: [second],
      method: "all",
    });
    expect(Number(published[0]?.[0])).toBe(0);
    expect(s.sent.slice(sentBefore).some((m) => m.subject === "For next time")).toBe(false);
    // Her bookings and emails go on as before.
    expect(await stateOf(s, second)).toBe("confirmed");
    expect(s.sent.slice(sentBefore).some((m) => m.to.includes(rita) && m.subject === "Confirmed: Full service")).toBe(
      true,
    );

    // 5. Replies: the owner's own has no automatic line; an integration's has it unless a person wrote it.
    const helpdesk = await createApiKey(s.db, {
      kind: "integration",
      name: "Helpdesk",
      scopes: ["inbox:read", "inbox:write"],
    });
    const asHelpdesk = { authorization: `Bearer ${helpdesk.key}` };
    const say = async (body: string, headers: Record<string, string>, extra: Record<string, unknown> = {}) => {
      const r = await s.app.request(json(`/v1/owner/items/${second}/replies`, { body, ...extra }, headers));
      expect(r.status, await r.clone().text()).toBe(200);
      await drain(s);
      const m = mailTo(s, rita).at(-1)?.mail;
      expect(m?.text).toContain(body);
      return m?.text ?? "";
    };
    expect(await say("See you at one.", s.owner)).not.toContain(AUTOMATIC_EN);
    expect(await say("Your booking is in our calendar.", asHelpdesk)).toContain(AUTOMATIC_EN);
    expect(await say("Hi Rita, Joana here.", asHelpdesk, { written_by: "person" })).not.toContain(AUTOMATIC_EN);
    const ai = await ownerAiToken(s);
    expect(await say("Noted, thank you.", ai, { written_by: "person" })).toContain(AUTOMATIC_EN);

    // 6. Her mailbox's out-of-office answers our email: a note on that booking, no new item, no reply.
    const last = mailTo(s, rita).at(-1);
    const itemsBefore = (await counts(s)).items;
    const sentBeforeOoo = s.sent.length;
    const ooo = await inbound(
      s,
      replyMime({
        from: rita,
        subject: last?.mail.subject ?? "",
        messageId: "<ooo-1@mail.example.com>",
        inReplyTo: `<${last?.id}>`,
        body: "I am away until Monday.",
      }).replace("MIME-Version: 1.0", "Auto-Submitted: auto-replied\r\nMIME-Version: 1.0"),
    );
    expect(await ooo.json()).toEqual({ outcome: "noted", itemId: second });
    // One that answers nothing of ours is not kept at all.
    const stray = await inbound(
      s,
      replyMime({
        from: rita,
        subject: "Out of office",
        messageId: "<ooo-2@mail.example.com>",
        body: "I am away until Monday.",
      }).replace("MIME-Version: 1.0", "Auto-Submitted: auto-replied\r\nMIME-Version: 1.0"),
    );
    expect((await stray.json()) as { outcome: string }).toMatchObject({ outcome: "dropped" });
    await drain(s);
    expect((await counts(s)).items).toBe(itemsBefore);
    expect(s.sent.length).toBe(sentBeforeOoo);

    // 7. The owner exports her: every item, its history, conversation and emails; the code never.
    const { rows: partyRows } = await s.db.client.query({
      sql: "SELECT party_id FROM items WHERE id = ?",
      params: [first],
      method: "all",
    });
    const party = String(partyRows[0]?.[0]);
    const exported = await s.app.request(`${BASE}/v1/owner/customers/${party}/export`, { headers: s.owner });
    expect(exported.status).toBe(200);
    const doc = (await exported.json()) as {
      customer: { items: number; networks_off: { via: string } | null };
      parties: { contact: unknown }[];
      items: {
        item: { id: string; state: string };
        events: unknown[];
        thread: { text: string }[];
        emails: { template: string; text: string }[];
      }[];
    };
    expect(doc.customer.items).toBe(2);
    expect(doc.customer.networks_off?.via).toBe("customer");
    expect(JSON.stringify(doc.parties)).toContain(rita);
    expect(doc.items.map((i) => i.item.id).sort()).toEqual([first, second].sort());
    const one = doc.items.find((i) => i.item.id === first);
    const two = doc.items.find((i) => i.item.id === second);
    expect(one?.events.length).toBeGreaterThan(1);
    // (Confirmed within the acknowledgement's 90 seconds: the confirmation is the one email it needed.)
    expect(one?.emails.map((e) => e.template)).toEqual(expect.arrayContaining(["booking.confirmed", "key"]));
    expect(two?.thread.map((t) => t.text)).toEqual(
      expect.arrayContaining([
        "See you at one.",
        "Hi Rita, Joana here.",
        expect.stringContaining("I am away until Monday."),
      ]),
    );
    expect(JSON.stringify(doc)).not.toContain(code);

    // 8. The owner's AI cannot erase her, over REST or MCP.
    const refused = await s.app.request(json(`/v1/owner/customers/${party}/erase`, {}, ai));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ details: { reason: "owner_only" } });
    const aiMcp = new Client({ name: "some-ai", version: "0" });
    await aiMcp.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/owner`), {
        fetch: async (input: string | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", ai.authorization as string);
          return s.app.request(String(input), { ...init, headers });
        },
      }),
    );
    const tools = (await aiMcp.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("export_customer");
    expect(tools.some((n) => n.includes("erase"))).toBe(false);
    await aiMcp.close();
    // What the erasure must leave nowhere is everywhere now.
    expect((await everything(s)).toLowerCase()).toContain(rita);

    // 9. The owner erases her: asked to confirm, then done. Her words are gone; the structure stays.
    const eventsBefore = Number(
      (await s.db.client.query({ sql: "SELECT COUNT(*) FROM item_events", method: "all" })).rows[0]?.[0],
    );
    const asked = await s.app.request(json(`/v1/owner/customers/${party}/erase`, {}, s.owner));
    expect(asked.status).toBe(409);
    const { details } = (await asked.json()) as { details: { confirm: string } };
    const erased = await s.app.request(
      json(`/v1/owner/customers/${party}/erase`, { confirm: details.confirm }, s.owner),
    );
    expect(erased.status).toBe(200);
    expect(await erased.json()).toMatchObject({ erased: true });
    const all = await everything(s);
    for (const word of [rita, "Rita", "Joana here", "See you at one", "away until Monday", code as string]) {
      const where = all.split("\n").filter((l) => l.toLowerCase().includes(word.toLowerCase()));
      expect(where, word).toEqual([]);
    }
    expect(await stateOf(s, first)).toBe("confirmed");
    expect(await stateOf(s, second)).toBe("confirmed");
    expect((await counts(s)).items).toBe(itemsBefore);
    expect(
      Number((await s.db.client.query({ sql: "SELECT COUNT(*) FROM item_events", method: "all" })).rows[0]?.[0]),
    ).toBe(eventsBefore);
  });
});
