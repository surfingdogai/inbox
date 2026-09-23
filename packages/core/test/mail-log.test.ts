import { LOCAL_SENDER, logMailOut, type MailOut, type OutboundMail, runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import type { Caller } from "../src/write/caller";
import { transitionItem } from "../src/write/transition";
import { makeClient, resetTables } from "./harness";

/**
 * The mail log (Tiago, 23 September 2026): every email the inbox sends is kept with what it said and
 * what became of it, and a send that failed is visible on the item and in the app — never shown as
 * sent. A retry sends the same email; the last failed try asks for a person. Runs on Node and in
 * workerd.
 */
const T0 = Date.parse("2026-09-22T09:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BASE = "https://inbox.oficinamare.pt";

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

/** A transport that fails while `down` is set, and records what it sent. */
function flakyMail() {
  const sent: OutboundMail[] = [];
  const state = { down: false, n: 0 };
  const out: MailOut & { sent: OutboundMail[]; state: typeof state } = {
    sent,
    state,
    sender: LOCAL_SENDER,
    async send(mail) {
      if (state.down) throw new Error("550 mailbox unavailable");
      sent.push(mail);
      state.n++;
      return { messageId: `prov-${state.n}-${crypto.randomUUID()}` };
    },
  };
  return out;
}

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
  const secrets = createSecretBox(["mail-log-test-secret-0123456789abcdef"]);
  const caps = new Capabilities(db, secrets, opts.baseUrl);
  await caps.updateSettings(owner(), {
    doc: {
      business: { name: "Oficina Maré", timezone: "Europe/Lisbon" },
      notifications: { ownerEmail: "owner@oficinamare.pt" },
      email: { fromAddress: "hello@oficinamare.pt" },
      ...(opts.settings ?? {}),
    },
  });
  const mailOut = opts.mailOut ?? logMailOut();
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
  return { db, caps, runner, drain, book, svc, secrets, mailOut };
}

const rows = async (db: Db, sql: string, params: unknown[] = []) =>
  (await db.client.query({ sql, params: params as never, method: "all" })).rows;

describe("the mail log", () => {
  it("keeps every email with what became of it: queued, then sent with the service's id", async () => {
    const mailOut = flakyMail();
    const s = await setup({ mailOut });
    const b = await s.book();
    const id = b.view.item.id;
    await s.drain(T0 + 2 * MIN);
    const logged = await rows(
      s.db,
      "SELECT recipient, template, lang, status, attempts, provider_id IS NOT NULL, sent_at FROM outbound_mail WHERE item_id = ? ORDER BY recipient",
      [id],
    );
    expect(logged).toEqual([
      ["customer", "ack.booking", "en", "sent", 1, 1, T0 + 2 * MIN],
      ["owner", "owner.create", "en", "sent", 1, 1, T0 + 2 * MIN],
    ]);
    // The item's anchor, the email's own ref and the service's id all name the item for a reply.
    const refs = await rows(s.db, "SELECT kind FROM mail_refs WHERE item_id = ? ORDER BY kind", [id]);
    expect(refs.map((r) => r[0])).toEqual(expect.arrayContaining(["anchor", "sent", "provider"]));
    // The owner's app sees each, and the item needs nobody.
    const detail = await s.caps.getItem(owner(), { item_id: id });
    expect(detail.mail.map((m) => [m.recipient, m.status, m.template])).toEqual([
      ["owner", "sent", "owner.create"],
      ["customer", "sent", "ack.booking"],
    ]);
    expect(detail.item.flags.needsHuman).toBe(false);
  });

  it("keeps trying a send that failed, says so on the item, and asks for a person when it gives up", async () => {
    const mailOut = flakyMail();
    const s = await setup({ mailOut });
    const b = await s.book();
    const id = b.view.item.id;
    await s.drain(T0 + MIN);
    await s.caps.reply(owner(T0 + 2 * MIN), { item_id: id, body: "Bring a towel.", internal: false });
    mailOut.state.down = true;
    // Two tries in this test, not eight.
    await s.db.client.query({ sql: "UPDATE jobs SET max_attempts = 2 WHERE kind = 'notify'", method: "run" });
    await s.drain(T0 + 2 * MIN);
    const reply = async () =>
      (await s.caps.getItem(owner(), { item_id: id })).thread.find((t) => t.body === "Bring a towel.");
    expect((await reply())?.delivery).toMatchObject({ status: "retrying", last_error: "550 mailbox unavailable" });
    expect((await s.caps.getItem(owner(), { item_id: id })).item.flags.needsHuman).toBe(false);
    await s.drain(T0 + 2 * MIN + 2 * MIN);
    expect((await reply())?.delivery).toMatchObject({ status: "failed", last_error: "550 mailbox unavailable" });
    const detail = await s.caps.getItem(owner(), { item_id: id });
    expect(detail.item.flags.needsHuman).toBe(true);
    expect(detail.events.at(-1)).toMatchObject({ event: "flags", reason: "We could not email the customer" });
    expect(mailOut.sent.filter((m) => m.to.includes("rita@example.com"))).toHaveLength(0);
    // The owner finds it by the reference the customer quotes, and among the items whose email did not go out.
    const byRef = await s.caps.listItems(owner(), {
      q: id.slice(-6).toLowerCase(),
      open_only: false,
      sandbox: false,
      limit: 20,
    });
    expect(byRef.items.map((v) => v.item.id)).toEqual([id]);
    const unsent = await s.caps.listItems(owner(), { mail_failed: true, open_only: false, sandbox: false, limit: 20 });
    expect(unsent.items.map((v) => v.item.id)).toEqual([id]);
  });

  it("sends the stored email again on a retry: the same words and the same links", async () => {
    const mailOut = flakyMail();
    const s = await setup({ mailOut, baseUrl: BASE });
    const b = await s.book();
    const id = b.view.item.id;
    await s.drain(T0 + 2 * MIN);
    const start = new Date(T0 + 4 * DAY).toISOString();
    await transitionItem(s.db, owner(T0 + 3 * MIN), {
      itemId: id,
      event: "propose",
      input: { startTime: start, endTime: new Date(Date.parse(start) + 90 * MIN).toISOString() },
    });
    mailOut.state.down = true;
    await s.drain(T0 + 3 * MIN);
    const failed = await rows(s.db, "SELECT status, body_text FROM outbound_mail WHERE template = 'booking.proposed'");
    expect(failed[0]?.[0]).toBe("retrying");
    mailOut.state.down = false;
    await s.drain(T0 + 3 * MIN + 5 * MIN);
    const sent = mailOut.sent.filter((m) => m.subject === "Another time for Surf lesson");
    expect(sent).toHaveLength(1);
    // The same words; the log keeps each link without its mac, and the send makes it whole.
    expect(sent[0]?.text.replace(/(\/c\/[A-Za-z0-9_-]{22})\.[A-Za-z0-9_-]{22}$/gm, "$1.…")).toBe(
      String(failed[0]?.[1]),
    );
    expect(sent[0]?.text).toMatch(new RegExp(`^Accept: ${BASE}/c/[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{22}$`, "m"));
    expect(String(failed[0]?.[1])).toMatch(new RegExp(`^Accept: ${BASE}/c/[A-Za-z0-9_-]{22}\\.…$`, "m"));
    expect(await rows(s.db, "SELECT COUNT(*) FROM action_links WHERE item_id = ?", [id])).toEqual([[3]]);
    expect(await rows(s.db, "SELECT status, attempts FROM outbound_mail WHERE template = 'booking.proposed'")).toEqual([
      ["sent", 2],
    ]);
  });

  it("does not send what cannot go: no address, or no address to send from, and says which", async () => {
    const s = await setup();
    const b = await s.book(T0, { name: "Rita" });
    await s.drain(T0 + 2 * MIN);
    const [ack] = (await s.caps.getItem(owner(), { item_id: b.view.item.id })).mail.filter(
      (m) => m.recipient === "customer",
    );
    expect(ack).toMatchObject({ status: "skipped", skip_reason: "no_address", template: "ack.booking" });

    // A service that has no address of its own, and none in settings: nothing goes, and it says so.
    const quiet: MailOut & { sent: OutboundMail[] } = {
      sent: [],
      async send(m) {
        quiet.sent.push(m);
        return { messageId: "x" };
      },
    };
    const t = await setup({ mailOut: quiet, settings: { email: {} } });
    await t.caps.updateSettings(owner(), { doc: { email: { fromAddress: null } } });
    const c = await t.book();
    await t.drain(T0 + 2 * MIN);
    expect(quiet.sent).toHaveLength(0);
    const mail = (await t.caps.getItem(owner(), { item_id: c.view.item.id })).mail;
    expect(mail.map((m) => [m.recipient, m.status, m.skip_reason])).toEqual([
      ["owner", "skipped", "no_sender"],
      ["customer", "skipped", "no_sender"],
    ]);
  });

  it("shows the customer, at the status door, what we wrote and what they wrote, and never a note", async () => {
    const s = await setup();
    const b = await s.book();
    const id = b.view.item.id;
    const token = b.accessToken as string;
    await s.caps.reply(owner(T0 + MIN), { item_id: id, body: "See you at the beach.", internal: false });
    await s.caps.reply(owner(T0 + 2 * MIN), { item_id: id, body: "She paid last time in cash.", internal: true });
    await s.caps.reply(owner(T0 + 3 * MIN, "owner_ai"), { item_id: id, body: "Parking is free.", internal: false });
    await s.caps.sendMessage(customer(T0 + 4 * MIN), { item_id: id, body: "Thanks!", access_token: token });
    const status = await s.caps.getItemStatus(customer(T0 + 5 * MIN), { item_id: id, access_token: token });
    expect(status.thread).toEqual([
      { from: "us", text: "See you at the beach.", at: new Date(T0 + MIN).toISOString() },
      { from: "us", text: "Parking is free.", at: new Date(T0 + 3 * MIN).toISOString(), automated: true },
      { from: "you", text: "Thanks!", at: new Date(T0 + 4 * MIN).toISOString() },
    ]);
    expect(JSON.stringify(status)).not.toContain("cash");
    // The assistant's reply says, in the email, that nobody wrote it by hand.
    await s.drain(T0 + 6 * MIN);
    const sent = (s.mailOut as ReturnType<typeof logMailOut>).sent.filter((m) => m.to.includes("rita@example.com"));
    expect(sent.find((m) => m.text.startsWith("Parking is free."))?.text).toContain(
      "This reply was sent automatically. Reply to reach a person.",
    );
    expect(sent.find((m) => m.text.startsWith("See you at the beach."))?.text).not.toContain("automatically");
    // The owner reads it with its delivery.
    const detail = await s.caps.getItem(owner(), { item_id: id });
    expect(detail.thread.find((t) => t.body === "See you at the beach.")?.delivery).toMatchObject({ status: "sent" });
    expect(detail.thread.find((t) => t.body === "She paid last time in cash.")).not.toHaveProperty("delivery");
  });
});

describe("what the headers say, and what the log shows (Tiago, 23 September 2026)", () => {
  const integration = (t: number): Caller => ({
    actor: { kind: "integration", id: "key_crm", channel: "rest" },
    actsAs: "owner",
    tier: "verified_principal",
    sandbox: false,
    now: () => t,
    principal: {
      via: "api_key",
      id: "key_crm",
      name: "CRM",
      scopes: ["inbox:write"],
      userId: null,
      keyKind: "integration",
    },
  });

  it("asks mailboxes not to answer any email, and marks every one no person at the business caused", async () => {
    const mailOut = flakyMail();
    const s = await setup({ mailOut });
    const b = await s.book();
    const id = b.view.item.id;
    await s.drain(T0 + 2 * MIN);
    await s.caps.reply(owner(T0 + 3 * MIN), { item_id: id, body: "Typed by the owner.", internal: false });
    await s.caps.reply(owner(T0 + 4 * MIN, "owner_ai"), {
      item_id: id,
      body: "Written by the assistant.",
      internal: false,
    });
    await s.caps.reply(integration(T0 + 5 * MIN), { item_id: id, body: "Sent by the CRM.", internal: false });
    await s.caps.reply(integration(T0 + 6 * MIN), {
      item_id: id,
      body: "Typed in the CRM by Ana.",
      internal: false,
      written_by: "person",
    });
    await s.caps.transitionItem(owner(T0 + 7 * MIN), { item_id: id, event: "confirm" });
    await s.drain(T0 + 10 * MIN);
    const byStart = (text: string) => mailOut.sent.find((m) => m.text.startsWith(text));
    const headersOf = (text: string) => byStart(text)?.headers ?? {};
    for (const m of mailOut.sent) expect(m.headers?.["X-Auto-Response-Suppress"], m.subject).toBe("OOF, AutoReply");
    // The acknowledgement answers her request by itself; the owner's alert is automatic too.
    const ack = mailOut.sent.find((m) => m.subject.startsWith("We have your booking request"));
    expect(ack?.headers?.["Auto-Submitted"]).toBe("auto-replied");
    const alert = mailOut.sent.find((m) => m.to.includes("owner@oficinamare.pt"));
    expect(alert?.headers?.["Auto-Submitted"]).toBe("auto-generated");
    // Replies: a person's carry nothing; the assistant's and a system's are automatic, and say so.
    expect(headersOf("Typed by the owner.")).not.toHaveProperty("Auto-Submitted");
    expect(headersOf("Written by the assistant.")["Auto-Submitted"]).toBe("auto-replied");
    expect(headersOf("Sent by the CRM.")["Auto-Submitted"]).toBe("auto-replied");
    expect(byStart("Sent by the CRM.")?.text).toContain("This reply was sent automatically. Reply to reach a person.");
    // A system whose request says a person typed it: not automatic.
    expect(headersOf("Typed in the CRM by Ana.")).not.toHaveProperty("Auto-Submitted");
    expect(byStart("Typed in the CRM by Ana.")?.text).not.toContain("sent automatically");
    // The owner confirming by hand is a person's doing.
    expect(mailOut.sent.find((m) => m.subject.startsWith("Confirmed"))?.headers).not.toHaveProperty("Auto-Submitted");
    // What was honoured is kept on the entry, and the status door says the same.
    expect(
      (
        await rows(
          s.db,
          "SELECT body_text, written_by FROM thread_entries WHERE item_id = ? AND direction = 'out' ORDER BY created_at",
          [id],
        )
      ).map((r) => [...r]),
    ).toEqual([
      ["Typed by the owner.", null],
      ["Written by the assistant.", null],
      ["Sent by the CRM.", null],
      ["Typed in the CRM by Ana.", "person"],
    ]);
    const status = await s.caps.getItemStatus(customer(T0 + 11 * MIN), { item_id: id, access_token: b.accessToken });
    expect(status.thread?.map((t) => [t.text, t.automated ?? false])).toEqual([
      ["Typed by the owner.", false],
      ["Written by the assistant.", true],
      ["Sent by the CRM.", true],
      ["Typed in the CRM by Ana.", false],
    ]);
  });

  it("claims no person for the owner's AI, and lets anyone say nobody typed it", async () => {
    const mailOut = flakyMail();
    const s = await setup({ mailOut });
    const b = await s.book();
    const id = b.view.item.id;
    await s.caps.reply(owner(T0 + MIN, "owner_ai"), {
      item_id: id,
      body: "The assistant says a person wrote this.",
      internal: false,
      written_by: "person",
    });
    await s.caps.reply(owner(T0 + 2 * MIN), {
      item_id: id,
      body: "The owner's script, marked automatic.",
      internal: false,
      written_by: "automation",
    });
    await s.drain(T0 + 5 * MIN);
    const find = (text: string) => mailOut.sent.find((m) => m.text.startsWith(text));
    expect(find("The assistant says")?.text).toContain("sent automatically");
    expect(find("The owner's script")?.text).toContain("sent automatically");
    expect(find("The owner's script")?.headers?.["Auto-Submitted"]).toBe("auto-replied");
  });

  it("shows on the item an acknowledgement held back by the day's limit, and lists it as not sent", async () => {
    const mailOut = flakyMail();
    const s = await setup({ mailOut });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await s.book(T0 + i * MIN)).view.item.id);
    await s.drain(T0 + 10 * MIN);
    const acks = await rows(
      s.db,
      "SELECT item_id, status, skip_reason FROM outbound_mail WHERE template LIKE 'ack.%' ORDER BY item_id",
    );
    expect(acks.map((r) => [r[1], r[2]])).toEqual([
      ["sent", null],
      ["sent", null],
      ["sent", null],
      ["skipped", "ack_limit"],
    ]);
    const detail = await s.caps.getItem(owner(), { item_id: ids[3] as string });
    expect(detail.mail.find((m) => m.template.startsWith("ack."))).toMatchObject({
      status: "skipped",
      skip_reason: "ack_limit",
    });
    const listed = await s.caps.listItems(owner(), { mail_failed: true, open_only: false, limit: 50, sandbox: false });
    expect(listed.items.map((v) => v.item.id)).toEqual([ids[3]]);
  });
});

describe("the code for a first-time customer's assistant", () => {
  async function withKey(opts: { baseUrl?: string } = {}) {
    const s = await setup(opts);
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
    return { ...s, id, key, sweep };
  }

  it("goes alone, a day after the booking, with the line about the network and its page", async () => {
    const s = await withKey({ baseUrl: BASE });
    await s.sweep(T0 + 23 * 60 * MIN);
    const toRita = () =>
      (s.mailOut as ReturnType<typeof logMailOut>).sent.filter((m) => m.to.includes("rita@example.com"));
    expect(toRita().map((m) => m.subject)).toEqual(["We have your booking request: Surf lesson"]);
    await s.sweep(T0 + DAY + MIN);
    const [, keyMail] = toRita();
    expect(keyMail?.subject).toBe("For next time");
    expect(keyMail?.text).toContain(s.key);
    // The page is hers: a signed link, where she can switch the network off for herself.
    expect(keyMail?.text).toMatch(
      /We use a booking network to recognise returning customers\. How it works: https:\/\/[^\s]+\/c\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}\n/,
    );
    expect(await rows(s.db, "SELECT template, status FROM outbound_mail WHERE job_key = ?", [`key:${s.id}`])).toEqual([
      ["key", "sent"],
    ]);
    // Once, and never on any other email.
    await s.sweep(T0 + DAY + 20 * MIN);
    expect(toRita().filter((m) => m.text.includes("sdkey1_"))).toHaveLength(1);
    expect(toRita()[0]?.text).not.toContain("sdkey1_");
  });

  it("is not sent without an address for the page that explains it", async () => {
    const s = await withKey();
    await s.sweep(T0 + DAY + MIN);
    const sent = (s.mailOut as ReturnType<typeof logMailOut>).sent;
    expect(sent.filter((m) => m.text.includes("sdkey1_"))).toHaveLength(0);
    expect(await rows(s.db, "SELECT COUNT(*) FROM outbound_mail WHERE job_key = ?", [`key:${s.id}`])).toEqual([[0]]);
  });
});
