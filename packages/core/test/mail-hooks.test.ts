import {
  type CustomerMailKind,
  type LogMailOut,
  logMailOut,
  type MailAbout,
  type MailHold,
  type MailOut,
  type OutboundMail,
  pinnedMailOut,
  runMigrations,
} from "@surfingdog/platform";
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
import { confirming, makeClient, resetTables } from "./harness";

/**
 * The email an inbox sends, under whoever runs it: every message goes from the sender that host
 * pinned, whatever Settings say; only the kinds of customer email it allows go; and it is asked
 * before each email, so what it keeps across inboxes (a cap per address, a suppression list, a
 * pause) holds. What it holds back stays on the item as not sent, with the reason, and is never
 * retried as an error. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-10-12T09:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BASE = "https://calm-otter-7k2q.example.net";
const PIN = { address: "calm-otter-7k2q@mail.example.net", name: "Oficina Maré" };

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

async function setup(mailOut: MailOut & { sent: OutboundMail[] }, settings: Record<string, unknown> = {}) {
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
  const secrets = createSecretBox(["mail-hooks-test-secret-0123456789abcdef"]);
  const caps = confirming(new Capabilities(db, secrets, BASE));
  caps.attachMail(mailOut);
  await caps.updateSettings(owner(), {
    doc: {
      business: { name: "Oficina Maré", timezone: "Europe/Lisbon" },
      notifications: { ownerEmail: "owner@oficinamare.pt" },
      ...settings,
    },
  });
  const runner = createRunner({ mailOut, secrets, baseUrl: BASE });
  const drain = async (t: number) => {
    for (let i = 0; i < 20; i++) if ((await runner.runDue(db, { now: t, limit: 100 })).claimed === 0) return;
  };
  let slot = 0;
  const book = (t = T0, contact: Record<string, unknown> = { name: "Rita", email: "rita@example.com" }) => {
    const start = T0 + 3 * DAY + ++slot * 90 * MIN;
    return caps.createBooking(customer(t), {
      payload: {
        reservationFor: { serviceId: svc, name: "Surf lesson" },
        startTime: new Date(start).toISOString(),
        endTime: new Date(start + 90 * MIN).toISOString(),
      },
      contact,
    });
  };
  const to = (address: string) => mailOut.sent.filter((m) => m.to.includes(address));
  return { db, caps, drain, book, to, mailOut };
}

const skipped = async (db: Db, itemId: string) =>
  (
    await db.client.query({
      sql: "SELECT template, status, skip_reason FROM outbound_mail WHERE item_id = ? ORDER BY created_at, id",
      params: [itemId],
      method: "all",
    })
  ).rows.map((r) => [String(r[0]), String(r[1]), r[2] === null ? null : String(r[2])]);

/**
 * What a host keeps across every inbox it runs: how many emails each address got today, the
 * addresses that bounced or complained, and whether sending is paused. `sentElsewhere` is what
 * other inboxes sent an address today, through this same ledger.
 */
function ledger(opts: { perRecipient: number; suppressed?: string[]; sentElsewhere?: Record<string, number> }) {
  const today = new Map(Object.entries(opts.sentElsewhere ?? {}));
  const asked: MailAbout[] = [];
  const state = { paused: false };
  const beforeSend = (mail: OutboundMail, about: MailAbout): MailHold | null => {
    asked.push(about);
    const to = mail.to[0]?.toLowerCase() ?? "";
    if (state.paused) return "paused";
    if (opts.suppressed?.includes(to)) return "suppressed";
    if (about.recipient === "owner") return null;
    const n = today.get(to) ?? 0;
    if (n >= opts.perRecipient) return "recipient_limit";
    today.set(to, n + 1);
    return null;
  };
  return { beforeSend, asked, state };
}

describe("a pinned sender", () => {
  it("is who every email is from, with its name and no Reply-To, whatever Send from, its name and Reply-to say", async () => {
    const log = logMailOut();
    const s = await setup(Object.assign(pinnedMailOut(log, { from: PIN }), { sent: log.sent }), {
      email: { fromAddress: "owner@personal.example", fromName: "Someone else", replyTo: "reply@personal.example" },
    });
    const b = await s.book();
    await s.drain(T0 + 2 * MIN);
    await s.caps.reply(owner(T0 + 3 * MIN), { item_id: b.view.item.id, body: "See you there.", internal: false });
    await s.drain(T0 + 4 * MIN);
    expect(s.to("rita@example.com")).toHaveLength(2);
    expect(s.to("owner@oficinamare.pt").length).toBeGreaterThan(0);
    for (const mail of log.sent) {
      expect(mail.from).toEqual(PIN);
      expect(mail.replyTo).toBeUndefined();
      expect(JSON.stringify(mail)).not.toContain("personal.example");
    }
    // The threading ids carry the pinned sender's domain, never the one Settings name.
    expect(s.to("rita@example.com")[0]?.headers?.References).toMatch(/@mail\.example\.net>$/);
    expect((await s.caps.getMailStatus(owner())).sender).toBe(true);
  });
});

describe("the kinds of customer email a host allows", () => {
  it("sends a customer only what a person at the business did, and keeps the rest on the item as not sent", async () => {
    const asked: CustomerMailKind[] = [];
    const log = logMailOut();
    const s = await setup(
      Object.assign(log, {
        allowCustomerMail: (kind: CustomerMailKind) => {
          asked.push(kind);
          return kind === "person";
        },
      }),
    );
    const b = await s.book();
    const id = b.view.item.id;
    await s.drain(T0 + 2 * MIN);
    // No acknowledgement; the owner still hears of the request.
    expect(s.to("rita@example.com")).toHaveLength(0);
    expect(s.to("owner@oficinamare.pt")).toHaveLength(1);
    expect(await skipped(s.db, id)).toContainEqual(["ack.booking", "skipped", "host_policy"]);
    // The owner's AI answers: held back. The owner answers in person: sent.
    await s.caps.reply(owner(T0 + 3 * MIN, "owner_ai"), { item_id: id, body: "Any time.", internal: false });
    await s.drain(T0 + 4 * MIN);
    expect(s.to("rita@example.com")).toHaveLength(0);
    await s.caps.reply(owner(T0 + 5 * MIN), { item_id: id, body: "See you on Thursday.", internal: false });
    await s.drain(T0 + 6 * MIN);
    expect(s.to("rita@example.com").map((m) => m.text.split("\n")[0])).toEqual(["See you on Thursday."]);
    expect(asked).toEqual(expect.arrayContaining(["acknowledgement", "automatic", "person"]));
    // Nothing held back is tried again.
    await s.drain(T0 + DAY);
    expect(s.to("rita@example.com")).toHaveLength(1);
  });

  it("asks before a payment request, and before any email that became one by the time it went", async () => {
    const asked: CustomerMailKind[] = [];
    const log = logMailOut();
    const s = await setup(
      Object.assign(log, {
        allowCustomerMail: (kind: CustomerMailKind) => {
          asked.push(kind);
          return kind !== "payment_request";
        },
      }),
    );
    const o = await s.caps.createOrder(customer(), {
      payload: {
        orderedItem: [{ sku: "W-1", name: "Wax", quantity: 2, price: { value: 500, currency: "EUR" } }],
        totalPrice: { value: 1000, currency: "EUR" },
      },
      contact: { name: "Rita", email: "rita@example.com" },
    });
    const id = o.view.item.id;
    await transitionItem(s.db, owner(T0 + MIN), { itemId: id, event: "accept" });
    await transitionItem(s.db, owner(T0 + 2 * MIN), {
      itemId: id,
      event: "request_payment",
      input: { paymentUrl: "https://pay.example.com/o/1" },
    });
    await s.drain(T0 + 3 * MIN);
    expect(asked).toContain("payment_request");
    expect(s.to("rita@example.com").some((m) => m.text.includes("pay.example.com"))).toBe(false);
    // The acceptance's email, written once payment was asked for, carries the link to pay too.
    expect((await skipped(s.db, id)).filter((r) => r[0] === "order.awaiting_payment")).toEqual([
      ["order.awaiting_payment", "skipped", "host_policy"],
      ["order.awaiting_payment", "skipped", "host_policy"],
    ]);
  });

  it("sends no one-time code when codes are not allowed, and says only that it cannot", async () => {
    const log = logMailOut();
    const s = await setup(Object.assign(log, { allowCustomerMail: (kind: CustomerMailKind) => kind !== "code" }));
    await s.book(T0, { name: "Ana Silva", email: "ana@example.pt" });
    const weak = await s.book(T0 + MIN, { name: "Ana", email: "ana@example.pt" });
    await expect(
      s.caps.verifyCustomer(customer(T0 + 2 * MIN), { item_id: weak.view.item.id, access_token: weak.accessToken }),
    ).rejects.toMatchObject({ code: "nothing_to_verify" });
    expect(log.sent.filter((m) => /\b\d{6}\b/.test(m.text))).toHaveLength(0);
  });
});

describe("a host asked before each email", () => {
  it("caps one address across inboxes: what another inbox sent it today counts here", async () => {
    const host = ledger({ perRecipient: 5, sentElsewhere: { "victim@example.com": 3 } });
    const log: LogMailOut = logMailOut();
    const s = await setup(Object.assign(log, { beforeSend: host.beforeSend }));
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await s.book(T0 + i * MIN, { name: "Rita", email: "victim@example.com" })).view.item.id);
    }
    await s.drain(T0 + 10 * MIN);
    expect(s.to("victim@example.com")).toHaveLength(2);
    expect(await skipped(s.db, ids[2] as string)).toContainEqual(["ack.booking", "skipped", "recipient_limit"]);
    // The owner heard of all three, and the host was told who each email was for, and what it was.
    expect(s.to("owner@oficinamare.pt")).toHaveLength(3);
    expect(host.asked).toContainEqual({ recipient: "customer", kind: "acknowledgement", template: "ack.booking" });
    expect(host.asked).toContainEqual({ recipient: "owner", template: "owner.create" });
  });

  it("sends a suppressed address nothing, and the owner still hears of its request", async () => {
    const host = ledger({ perRecipient: 5, suppressed: ["bounced@example.com"] });
    const log = logMailOut();
    const s = await setup(Object.assign(log, { beforeSend: host.beforeSend }));
    const b = await s.book(T0, { name: "Rita", email: "bounced@example.com" });
    await s.drain(T0 + 2 * MIN);
    await s.caps.reply(owner(T0 + 3 * MIN), { item_id: b.view.item.id, body: "See you there.", internal: false });
    await s.drain(T0 + DAY);
    expect(s.to("bounced@example.com")).toHaveLength(0);
    expect(s.to("owner@oficinamare.pt")).toHaveLength(1);
    expect((await skipped(s.db, b.view.item.id)).filter((r) => r[2] === "suppressed")).toHaveLength(2);
  });

  it("sends nothing while sending is paused, the owner's alerts included", async () => {
    const host = ledger({ perRecipient: 5 });
    host.state.paused = true;
    const log = logMailOut();
    const s = await setup(Object.assign(log, { beforeSend: host.beforeSend }));
    const b = await s.book();
    await s.drain(T0 + 2 * MIN);
    expect(log.sent).toHaveLength(0);
    expect((await skipped(s.db, b.view.item.id)).map((r) => r[2])).toEqual(["paused", "paused"]);
  });

  it("is asked again after a hook that failed: the email is retried, not lost", async () => {
    let down = true;
    const log = logMailOut();
    const s = await setup(
      Object.assign(log, {
        beforeSend: () => {
          if (down) throw new Error("ledger unavailable");
          return null;
        },
      }),
    );
    await s.book();
    await s.drain(T0 + 2 * MIN);
    expect(log.sent).toHaveLength(0);
    down = false;
    await s.drain(T0 + DAY);
    expect(s.to("rita@example.com")).toHaveLength(1);
    expect(s.to("owner@oficinamare.pt")).toHaveLength(1);
  });

  it("never sends a one-time code to an address it holds back", async () => {
    const host = ledger({ perRecipient: 5, suppressed: ["ana@example.pt"] });
    const log = logMailOut();
    const s = await setup(Object.assign(log, { beforeSend: host.beforeSend }));
    await s.book(T0, { name: "Ana Silva", email: "ana@example.pt" });
    const weak = await s.book(T0 + MIN, { name: "Ana", email: "ana@example.pt" });
    await expect(
      s.caps.verifyCustomer(customer(T0 + 2 * MIN), { item_id: weak.view.item.id, access_token: weak.accessToken }),
    ).rejects.toMatchObject({ code: "nothing_to_verify" });
    expect(host.asked).toContainEqual({ recipient: "customer", kind: "code", template: "code" });
    expect(log.sent).toHaveLength(0);
  });
});
