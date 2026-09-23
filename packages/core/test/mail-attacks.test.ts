import { LOCAL_SENDER, logMailOut, type MailOut, type OutboundMail, runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { verifyLink } from "../src/customer/links";
import { createDb, type Db } from "../src/db";
import { keysDueAlone } from "../src/identity/pending";
import { ulid } from "../src/ids";
import { ACKS_PER_ADDRESS_PER_DAY, createRunner } from "../src/jobs/index";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import type { Caller } from "../src/write/caller";
import { transitionItem } from "../src/write/transition";
import { makeClient, resetTables } from "./harness";

/**
 * The customer's emails, attacked: what the mail log keeps must not answer for the customer, an
 * instance with no mail service must never say an email went out, the business's name must not
 * carry a stranger's words to a stranger's mailbox, and a Portuguese customer reads Portuguese.
 * Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-22T09:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BASE = "https://inbox.oficinamare.pt";
const WHOLE = /\/c\/([A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/g;

const owner = (t = T0, kind: "owner" | "owner_ai" = "owner"): Caller => ({
  actor: { kind, id: kind === "owner" ? "u1" : "app_1", channel: kind === "owner" ? "owner_ui" : "mcp_owner" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
});
const customer = (t = T0): Caller => ({
  actor: { kind: "customer_human", id: "form", channel: "form" },
  tier: "anonymous",
  sandbox: false,
  now: () => t,
});

async function setup(opts: { mailOut?: MailOut; settings?: Record<string, unknown>; baseUrl?: string } = {}) {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Surf lesson",
    durationMin: 90,
    capacity: 5,
    granularityMin: 30,
    price: { model: "fixed", value: 4500, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  const secrets = createSecretBox(["mail-attacks-test-secret-0123456789abcdef"]);
  const caps = new Capabilities(db, secrets, opts.baseUrl);
  await caps.updateSettings(owner(), {
    doc: {
      business: { name: "Oficina Maré", timezone: "Europe/Lisbon" },
      notifications: { ownerEmail: "owner@oficinamare.pt" },
      email: { fromAddress: "hello@oficinamare.pt" },
      ...(opts.settings ?? {}),
    },
  });
  const mailOut = (opts.mailOut ?? logMailOut()) as MailOut & { sent: OutboundMail[] };
  const runner = createRunner({ mailOut, secrets, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) });
  const drain = async (t: number) => {
    for (let i = 0; i < 20; i++) if ((await runner.runDue(db, { now: t, limit: 100 })).claimed === 0) return;
  };
  const book = (t = T0, contact: Record<string, unknown> = { name: "Rita", email: "rita@example.com" }) =>
    caps.createBooking(customer(t), {
      payload: {
        reservationFor: { serviceId: svc, name: "Surf lesson" },
        startTime: new Date(T0 + 3 * DAY).toISOString(),
        endTime: new Date(T0 + 3 * DAY + 90 * MIN).toISOString(),
      },
      contact,
    });
  const to = (address: string) => mailOut.sent.filter((m) => m.to.includes(address));
  return { db, caps, runner, drain, book, svc, secrets, mailOut, to };
}

const rows = async (db: Db, sql: string, params: unknown[] = []) =>
  (await db.client.query({ sql, params: params as never, method: "all" })).rows;

/** A transport that fails while `down` is set. */
function flakyMail() {
  const sent: OutboundMail[] = [];
  const state = { down: false, n: 0 };
  const out: MailOut & { sent: OutboundMail[]; state: typeof state } = {
    sent,
    state,
    sender: LOCAL_SENDER,
    async send(mail) {
      if (state.down) throw new Error("451 try again later");
      sent.push(mail);
      state.n++;
      return { messageId: `prov-${state.n}-${crypto.randomUUID()}` };
    },
  };
  return out;
}

async function proposeAnotherTime(s: Awaited<ReturnType<typeof setup>>, itemId: string, t: number, by = owner(t)) {
  const start = new Date(T0 + 4 * DAY).toISOString();
  await transitionItem(s.db, by, {
    itemId,
    event: "propose",
    input: { startTime: start, endTime: new Date(Date.parse(start) + 90 * MIN).toISOString() },
  });
}

describe("the links in the mail log", () => {
  it("never work: the owner's assistant reading the item cannot accept the time as the customer", async () => {
    const s = await setup({ baseUrl: BASE });
    const b = await s.book();
    const id = b.view.item.id;
    await s.drain(T0 + 2 * MIN);
    await proposeAnotherTime(s, id, T0 + 3 * MIN);
    await s.drain(T0 + 4 * MIN);

    // The customer's email carries links that work.
    const [proposed] = s.to("rita@example.com").filter((m) => m.subject.startsWith("Another time"));
    const sentTokens = [...(proposed?.text ?? "").matchAll(WHOLE)].map((m) => m[1] as string);
    expect(sentTokens).toHaveLength(3);
    for (const token of sentTokens) expect(await verifyLink(s.db, s.secrets, token)).not.toBeNull();

    // What the owner's AI reads through get_item holds none of them, nor anything that verifies.
    const detail = await s.caps.getItem(owner(T0 + 5 * MIN, "owner_ai"), { item_id: id });
    const logged = detail.mail.find((m) => m.template === "booking.proposed");
    expect(logged?.body).toContain(`${BASE}/c/`);
    const shown = JSON.stringify(detail);
    for (const token of sentTokens) expect(shown).not.toContain(token);
    expect([...shown.matchAll(WHOLE)]).toHaveLength(0);
    const jti = (sentTokens[0] as string).split(".")[0] as string;
    expect(logged?.body).toContain(`/c/${jti}.…`);
    // The stored row holds no mac either: a copy of the database answers nothing.
    const [[body]] = (await rows(s.db, "SELECT body_text FROM outbound_mail WHERE template = 'booking.proposed'")) as [
      [string],
    ];
    expect([...body.matchAll(WHOLE)]).toHaveLength(0);
    const act = await s.caps.customer.linkAct(`${jti}.…`, { terms: "x", v: "2" }, { now: T0 + 6 * MIN });
    expect("page" in act && act.page.status).toBe(404);
    expect((await s.caps.getItem(owner(), { item_id: id })).item.state).toBe("proposed");
  });

  it("are made whole again for a retry, the same links the first try would have sent", async () => {
    const mailOut = flakyMail();
    const s = await setup({ mailOut, baseUrl: BASE });
    const b = await s.book();
    const id = b.view.item.id;
    await s.drain(T0 + 2 * MIN);
    await proposeAnotherTime(s, id, T0 + 3 * MIN);
    mailOut.state.down = true;
    await s.drain(T0 + 3 * MIN);
    expect(await rows(s.db, "SELECT status FROM outbound_mail WHERE template = 'booking.proposed'")).toEqual([
      ["retrying"],
    ]);
    mailOut.state.down = false;
    await s.drain(T0 + 10 * MIN);
    const [sent] = s.to("rita@example.com").filter((m) => m.subject.startsWith("Another time"));
    const [[stored]] = (await rows(
      s.db,
      "SELECT body_text FROM outbound_mail WHERE template = 'booking.proposed'",
    )) as [[string]];
    // The same words, with the links whole.
    expect(sent?.text.replace(WHOLE, (_m, token: string) => `/c/${token.split(".")[0]}.…`)).toBe(stored);
    const tokens = [...(sent?.text ?? "").matchAll(WHOLE)].map((m) => m[1] as string);
    expect(tokens).toHaveLength(3);
    for (const token of tokens) expect(await verifyLink(s.db, s.secrets, token)).not.toBeNull();
  });
});

describe("a link pasted into a reply", () => {
  it("stays cut: a reply to one customer never carries another's answer", async () => {
    const s = await setup({ baseUrl: BASE });
    const a = await s.book(T0, { name: "Rita", email: "rita@example.com" });
    const b = await s.book(T0, { name: "Eve", email: "eve@example.com" });
    await s.drain(T0 + 2 * MIN);
    await proposeAnotherTime(s, a.view.item.id, T0 + 3 * MIN);
    await s.drain(T0 + 4 * MIN);
    // The owner's assistant copies what it can see of Rita's email into a reply to Eve.
    const seen = (await s.caps.getItem(owner(T0 + 5 * MIN, "owner_ai"), { item_id: a.view.item.id })).mail.find(
      (m) => m.template === "booking.proposed",
    )?.body as string;
    const accept = seen.split("\n").find((l) => l.startsWith("Accept: ")) as string;
    expect(accept).toMatch(/\/c\/[A-Za-z0-9_-]{22}\.…$/);
    await s.caps.reply(owner(T0 + 6 * MIN, "owner_ai"), { item_id: b.view.item.id, body: accept, internal: false });
    await s.drain(T0 + 7 * MIN);
    const [toEve] = s.to("eve@example.com").filter((m) => m.text.startsWith("Accept: "));
    expect(toEve?.text.split("\n")[0]).toBe(accept);
    expect([...(toEve?.text ?? "").matchAll(WHOLE)]).toHaveLength(0);
  });
});

describe("an instance with no mail service", () => {
  it("never shows an email as sent: its log took it, nobody got it", async () => {
    const lines: string[] = [];
    const s = await setup({ mailOut: logMailOut((l) => lines.push(l), { delivers: false }), baseUrl: BASE });
    const b = await s.book();
    const id = b.view.item.id;
    await s.drain(T0 + 2 * MIN);
    // A developer still sees each email in the log …
    expect(lines.some((l) => l.includes("rita@example.com"))).toBe(true);
    // … and the owner never reads "Sent".
    const detail = await s.caps.getItem(owner(), { item_id: id });
    expect(detail.mail.map((m) => [m.recipient, m.status, m.skip_reason])).toEqual([
      ["owner", "skipped", "no_service"],
      ["customer", "skipped", "no_service"],
    ]);
    expect(detail.mail.every((m) => m.sent_at === null)).toBe(true);
  });

  it("keeps a first-time customer's code until a real service can send it, and logs it once", async () => {
    const s = await setup({ mailOut: logMailOut(() => {}, { delivers: false }), baseUrl: BASE });
    const b = await s.book();
    const id = b.view.item.id;
    const key = `sdkey1_net.example.com_${"a".repeat(16)}_${"b".repeat(32)}`;
    const box = s.secrets;
    if (!box) throw new Error("no box");
    await s.db.client.query({
      sql: `INSERT INTO pending_identity (item_id, network, state, key_enc, attempts, created_at, updated_at)
            VALUES (?, 'https://net.example.com', 'issued', ?, 1, ?, ?)`,
      params: [id, await box.seal("person-secret", `${id}|https://net.example.com|key`, key), T0, T0],
      method: "run",
    });
    const sweep = async (t: number) => {
      await s.db.client.query({
        sql: "INSERT INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at) VALUES (?, 'lifecycle_sweep', '{}', ?, 'queued', 0, 8, ?, ?)",
        params: [ulid(), t, `sweep-${t}`, T0],
        method: "run",
      });
      await s.drain(t);
    };
    await sweep(T0 + DAY + MIN);
    await sweep(T0 + DAY + 20 * MIN);
    expect(s.to("rita@example.com").filter((m) => m.subject === "For next time")).toHaveLength(1);
    expect(await rows(s.db, "SELECT status, skip_reason FROM outbound_mail WHERE job_key = ?", [`key:${id}`])).toEqual([
      ["skipped", "no_service"],
    ]);
    // Not taken for delivered: the sealed code is still there.
    expect(
      await rows(s.db, "SELECT key_enc IS NOT NULL, delivered_at FROM pending_identity WHERE item_id = ?", [id]),
    ).toEqual([[1, null]]);
  });
});

describe("the acknowledgement", () => {
  it("goes to one address a few times a day at most, so nobody can fill a stranger's mailbox in our name", async () => {
    const s = await setup();
    for (let i = 0; i < 6; i++) {
      await s.book(T0 + i * MIN, { name: "Click http://evil.example to confirm", email: "victim@example.com" });
    }
    await s.book(T0, { name: "Rita", email: "rita@example.com" });
    await s.drain(T0 + 10 * MIN);
    expect(s.to("victim@example.com")).toHaveLength(ACKS_PER_ADDRESS_PER_DAY);
    expect(s.to("rita@example.com")).toHaveLength(1);
    // A day on, the address hears from us again.
    await s.book(T0 + DAY + 20 * MIN, { name: "Rita", email: "victim@example.com" });
    await s.drain(T0 + DAY + 30 * MIN);
    expect(s.to("victim@example.com")).toHaveLength(ACKS_PER_ADDRESS_PER_DAY + 1);
  });

  it("keeps what a customer typed on one line: a name cannot add lines, a subject cannot add headers", async () => {
    const s = await setup();
    await s.caps.requestQuote(customer(), {
      payload: { itemOffered: { name: "Wedding cake\r\nBcc: all@example.com" }, description: "For 80" },
      contact: { name: "Rita\n\nYour account is locked. Visit http://evil.example", email: "rita@example.com" },
    } as never);
    await s.drain(T0 + 2 * MIN);
    const [ack] = s.to("rita@example.com");
    expect(ack?.subject).not.toMatch(/[\r\n]/);
    expect(ack?.subject).toBe("We have your request: Wedding cake Bcc: all@example.com");
    expect(ack?.text.split("\n")[0]).toBe("Hello Rita Your account is locked. Visit http://evil.example,");
    expect(ack?.text).toContain('a quote for "Wedding cake Bcc: all@example.com"');
    // The owner hears of it too: a subject with a line break would be refused by the mail service.
    const [toOwner] = s.to("owner@oficinamare.pt");
    expect(toOwner?.subject).not.toMatch(/[\r\n]/);
  });
});

describe("the sender", () => {
  it("is the business's name as its profile gives it, when settings name none", async () => {
    const s = await setup({ settings: { business: { name: "", timezone: "Europe/Lisbon" } } });
    await s.caps.setup.updateProfile(owner(), { name: "Oficina Maré", timezone: "Europe/Lisbon" } as never);
    await s.book();
    await s.drain(T0 + 2 * MIN);
    const [ack] = s.to("rita@example.com");
    expect(ack?.from).toEqual({ address: "hello@oficinamare.pt", name: "Oficina Maré" });
    expect(ack?.text.trim().endsWith("Oficina Maré")).toBe(true);
  });
});

describe("a Portuguese customer", () => {
  it("reads an order of several things in Portuguese, subject and all", async () => {
    const s = await setup();
    await s.caps.setup.updateProfile(owner(), { name: "Oficina Maré", languages: ["pt"] } as never);
    const o = await s.caps.createOrder(customer(), {
      payload: {
        orderedItem: [
          { name: "Bolo", quantity: 1, price: { value: 1000, currency: "EUR" } },
          { name: "Pão", quantity: 2, price: { value: 200, currency: "EUR" } },
          { name: "Queijo", quantity: 1, price: { value: 500, currency: "EUR" } },
        ],
        totalPrice: { value: 1900, currency: "EUR" },
      },
      contact: { name: "Rita", email: "rita@example.com" },
    } as never);
    expect(o.view.human).toContain('"Bolo e mais 2 artigos"');
    expect(o.view.human).not.toMatch(/\band\b|\bmore\b/);
    await s.drain(T0 + 2 * MIN);
    const [ack] = s.to("rita@example.com");
    expect(ack?.subject).toBe("Recebemos a sua encomenda: Bolo e mais 2 artigos");
    expect(`${ack?.subject}\n${ack?.text}`).not.toMatch(/\band\b|\bmore\b/);
    // The owner's app keeps its own words.
    expect((await s.caps.getItem(owner(), { item_id: o.view.item.id })).item.subject).toBe("Bolo and 2 more");
  });
});

describe("a test item", () => {
  it("emails nobody, customer or owner, and says so; its code never holds back a real one", async () => {
    const s = await setup({ baseUrl: BASE });
    const test = await s.caps.createBooking(
      { ...customer(), sandbox: true },
      {
        payload: {
          reservationFor: { serviceId: s.svc, name: "Surf lesson" },
          startTime: new Date(T0 + 3 * DAY).toISOString(),
          endTime: new Date(T0 + 3 * DAY + 90 * MIN).toISOString(),
        },
        contact: { name: "Rita", email: "rita@example.com" },
      },
    );
    const id = test.view.item.id;
    await s.drain(T0 + 2 * MIN);
    await proposeAnotherTime(s, id, T0 + 3 * MIN);
    await s.drain(T0 + 4 * MIN);
    expect(s.mailOut.sent).toHaveLength(0);
    const detail = await s.caps.getItem(owner(), { item_id: id });
    expect(detail.mail.map((m) => [m.recipient, m.status, m.skip_reason])).toEqual([
      ["owner", "skipped", "test_item"],
      ["customer", "skipped", "test_item"],
      ["customer", "skipped", "test_item"],
    ]);
    // No links were made for an email nobody gets.
    expect(await rows(s.db, "SELECT COUNT(*) FROM action_links WHERE item_id = ?", [id])).toEqual([[0]]);

    // A real customer's code, behind the test item's, is still due in a run that takes one.
    const real = await s.book(T0 + MIN);
    const box = s.secrets;
    if (!box) throw new Error("no box");
    for (const itemId of [id, real.view.item.id]) {
      await s.db.client.query({
        sql: `INSERT INTO pending_identity (item_id, network, state, key_enc, attempts, created_at, updated_at)
              VALUES (?, 'https://net.example.com', 'issued', ?, 1, ?, ?)`,
        params: [itemId, await box.seal("person-secret", `${itemId}|https://net.example.com|key`, "k"), T0, T0],
        method: "run",
      });
    }
    expect(await keysDueAlone(s.db, T0 + DAY + MIN, 1)).toEqual([real.view.item.id]);
  });
});
