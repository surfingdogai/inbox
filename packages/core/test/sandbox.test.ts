import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import type { IdentityPort } from "../src/identity/types";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { outboundMail, services, threadEntries } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * A test item is a rehearsal (Tiago, 23 September 2026): it emails nobody — not the customer, not
 * the owner — and contacts no network. What would have been sent is kept, marked as a test, so the
 * owner can read it; a one-time code is left on the item for the owner, who is the one testing.
 * Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const customer = (t: number, sandbox: boolean): Caller => ({
  actor: { kind: "customer_agent", id: `anon:${ulid()}`, channel: "rest" },
  tier: "anonymous",
  sandbox,
  now: () => t,
});

/** A network port that only counts: a test item must never reach it. */
function countingPort() {
  const calls: string[] = [];
  const port: IdentityPort = {
    canSign: async () => true,
    present: async () => {
      calls.push("present");
      return { presentations: [], notes: [] };
    },
    issue: async (input) => {
      calls.push("issue");
      return input.networks.map((network) => ({ network, outcome: "unreachable" as const, error: "test" }));
    },
  };
  return { port, calls };
}

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Massage",
    durationMin: 60,
    capacity: 3,
    granularityMin: 30,
    price: { model: "fixed", value: 4_500, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  const caps = new Capabilities(db, createSecretBox(["sandbox-test-instance-key-0123456789"]), "https://inbox.example");
  await caps.updateSettings(owner, {
    doc: {
      business: { name: "Oficina Maré" },
      notifications: { ownerEmail: "hello@oficinamare.pt", appUrl: "https://inbox.example" },
      email: { fromAddress: "inbox@oficinamare.pt" },
      networks: { "https://net.example.com": { enabled: true } },
    },
  });
  await db.client.query({
    sql: "INSERT INTO network_status (network, registration, failures, updated_at) VALUES (?, 'registered', 0, ?)",
    params: ["https://net.example.com", T0],
    method: "run",
  });
  const mail = logMailOut();
  const { port, calls } = countingPort();
  caps.people.attachPort(port);
  caps.people.attachMail(mail);
  const runner = createRunner({ mailOut: mail, secrets: caps.secrets, baseUrl: "https://inbox.example" });
  const drain = async (t: number) => {
    for (let i = 0; i < 10; i++) if ((await runner.runDue(db, { now: t, limit: 100 })).claimed === 0) return;
  };
  let slot = 0;
  const book = (caller: Caller, email: string) => {
    const start = T0 + 2 * DAY + ++slot * 90 * MIN;
    return caps.createBooking(caller, {
      payload: {
        reservationFor: { serviceId: svc, name: "Massage" },
        startTime: new Date(start).toISOString(),
        endTime: new Date(start + 60 * MIN).toISOString(),
      },
      contact: { name: "Rita", email },
    });
  };
  return { db, caps, mail, calls, drain, book };
}

describe("a test item", () => {
  it("emails neither the customer nor the owner, and keeps what it would have sent", async () => {
    const s = await setup();
    const r = await s.book(customer(T0, true), "rita@example.com");
    const id = r.view.item.id;
    // The owner answers it as they would a real one: a proposal, then a confirmation.
    await s.caps.transitionItem(owner, {
      item_id: id,
      event: "propose",
      input: {
        startTime: new Date(T0 + 3 * DAY).toISOString(),
        endTime: new Date(T0 + 3 * DAY + 60 * MIN).toISOString(),
      },
    });
    await s.caps.transitionItem(owner, { item_id: id, event: "confirm" });
    await s.caps.reply(owner, { item_id: id, body: "See you then.", internal: false });
    await s.drain(T0 + DAY + 5 * MIN);
    expect(s.mail.sent).toEqual([]);
    const rows = await s.db.orm
      .select({ recipient: outboundMail.recipient, status: outboundMail.status, reason: outboundMail.skipReason })
      .from(outboundMail)
      .where(eq(outboundMail.itemId, id));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(new Set(rows.map((m) => m.recipient))).toEqual(new Set(["owner", "customer"]));
    expect(rows.every((m) => m.status === "skipped" && m.reason === "test_item")).toBe(true);
    // A real one, beside it, is sent as ever.
    await s.book(customer(T0, false), "ana@example.com");
    await s.drain(T0 + DAY + 10 * MIN);
    expect(s.mail.sent.map((m) => m.to[0])).toContain("hello@oficinamare.pt");
  });

  it("asks no network for a key, and presents nothing to one", async () => {
    const s = await setup();
    const test = await s.caps.createBooking(customer(T0, true), {
      payload: {
        reservationFor: {
          serviceId: (await s.caps.listServices({ limit: 1 })).items[0]?.id as string,
          name: "Massage",
        },
        startTime: new Date(T0 + 2 * DAY).toISOString(),
        endTime: new Date(T0 + 2 * DAY + 60 * MIN).toISOString(),
      },
      contact: { email: "rita@example.com" },
      pass: "sdpass1_net.example.com_abcdefghijklmnop_abcdefghijklmnopqrstuvwxyz234567",
    });
    expect(test.identity?.networks).toEqual([]);
    await s.caps.getItemStatus(customer(T0 + MIN, false), {
      item_id: test.view.item.id,
      access_token: test.accessToken,
      pass: "sdpass1_net.example.com_abcdefghijklmnop_abcdefghijklmnopqrstuvwxyz234567",
    });
    expect(s.calls).toEqual([]);
    // The same request, for real, does ask.
    await s.book(customer(T0, false), "ana@example.com");
    expect(s.calls).toEqual(["issue"]);
  });

  it("leaves a one-time code on the item for the owner instead of emailing it", async () => {
    const s = await setup();
    // A customer the business knows, and a test request with the same address: a weak match.
    await s.book(customer(T0, false), "ana@example.pt");
    await s.drain(T0 + 5 * MIN);
    const sentBefore = s.mail.sent.length;
    const weak = await s.book(customer(T0 + MIN, true), "ana@example.pt");
    const target = { item_id: weak.view.item.id, access_token: weak.accessToken };
    const sent = await s.caps.verifyCustomer(customer(T0 + 2 * MIN, true), target);
    expect(sent).toEqual({ sent_to: "a•••@e•••.pt", test: true });
    expect(s.mail.sent).toHaveLength(sentBefore);
    const notes = await s.db.orm
      .select({ direction: threadEntries.direction, body: threadEntries.bodyText })
      .from(threadEntries)
      .where(eq(threadEntries.itemId, weak.view.item.id));
    const note = notes.find((n) => n.direction === "note");
    expect(note?.body).toMatch(/^Test item: nothing was emailed\. .* is \d{6}\.$/);
    // The owner types it in, as the customer would have.
    const code = /(\d{6})\.$/.exec(note?.body ?? "")?.[1] as string;
    expect(await s.caps.verifyCustomer(customer(T0 + 3 * MIN, true), { ...target, code })).toEqual({
      recognised: "strong",
    });
    // The customer's view never shows the note.
    const status = await s.caps.getItemStatus(customer(T0 + 4 * MIN, true), target);
    expect(JSON.stringify(status)).not.toContain(code);
  });
});
