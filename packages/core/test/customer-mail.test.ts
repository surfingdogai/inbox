import { logMailOut, runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { codeMail } from "../src/capabilities/identity";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import type { Item } from "../src/domain/types";
import { KEY_LINE, keyLine } from "../src/identity/pending";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { customerMail, whenIn } from "../src/jobs/notify";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { services } from "../src/schema/tables";
import { parseStoredSettings } from "../src/settings/schema";
import type { Caller } from "../src/write/caller";
import { describeToCustomer } from "../src/write/views";
import { makeClient, resetTables } from "./harness";

/**
 * What a customer reads (ADR-017, Tiago 23 September 2026): most customers do not know which
 * software a business runs, or that there is any — they contacted the business. So every email and
 * every sentence that reaches them is the business speaking, in its own name, and none of it names
 * the software, a network, a pass, a key, a receipt, a reputation or a presentation. The one line
 * about a code for their assistant is the business's too, and the business can switch it off.
 */
const PLATFORM_WORDS = /surfing ?dog|network|\bpass(es)?\b|\bkeys?\b|receipt|reputation|presentation|\binbox\b/i;
const T0 = Date.parse("2026-09-22T09:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const owner = (t = T0): Caller => ({
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
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

const base = {
  id: "01JD0000000000000000000000",
  version: 2,
  partyId: "p",
  locationId: null,
  channel: "form",
  flags: { needsHuman: false, sandbox: false, priority: 0 },
  linkedItemId: null,
  createdAt: new Date(T0).toISOString(),
  updatedAt: new Date(T0).toISOString(),
  closedAt: null,
};
const booking = (state: string, extra: Record<string, unknown> = {}) =>
  ({
    ...base,
    type: "booking",
    state,
    subject: "Surf lesson",
    payload: {
      reservationFor: { serviceId: "s", name: "Surf lesson" },
      startTime: "2026-09-25T08:00:00Z",
      endTime: "2026-09-25T09:30:00Z",
      ...extra,
    },
  }) as unknown as Item;
const order = (state: string, extra: Record<string, unknown> = {}) =>
  ({
    ...base,
    type: "order",
    state,
    subject: "2 × Wax",
    payload: {
      orderedItem: [{ name: "Wax", quantity: 2, price: { value: 800, currency: "EUR" } }],
      totalPrice: { value: 1600, currency: "EUR" },
      ...extra,
    },
  }) as unknown as Item;
const quote = (state: string, extra: Record<string, unknown> = {}) =>
  ({
    ...base,
    type: "quote_request",
    state,
    subject: "Board repair",
    payload: { itemOffered: { name: "Board repair" }, description: "A ding on the nose", ...extra },
  }) as unknown as Item;

describe("what the business tells its customer", () => {
  it("says every change in its own voice, naming nobody else", () => {
    const mail = (item: Item, opts: { event?: string; byCustomer?: boolean; words?: string } = {}) =>
      customerMail({ item, event: opts.event ?? "x", business: "Oficina Maré", timezone: "UTC", ...opts });
    const cases: [Item, { event?: string; byCustomer?: boolean; words?: string }, string, string][] = [
      [
        booking("confirmed"),
        {},
        "Confirmed: Surf lesson",
        'Your booking "Surf lesson" for 2026-09-25 08:00 UTC is confirmed.',
      ],
      [
        booking("proposed", { proposed: { startTime: "2026-09-26T08:00:00Z", endTime: "2026-09-26T09:30:00Z" } }),
        {},
        "Another time for Surf lesson",
        'We would like to propose another time for "Surf lesson": 2026-09-26 08:00 UTC.',
      ],
      [
        booking("needs_info"),
        {},
        "We need a detail about Surf lesson",
        'We need a little more detail about your booking "Surf lesson".',
      ],
      [
        booking("declined"),
        {},
        "We cannot take Surf lesson",
        'Sorry, we cannot take your booking "Surf lesson" for 2026-09-25 08:00 UTC.',
      ],
      [
        booking("cancelled_by_business"),
        {},
        "Cancelled: Surf lesson",
        'We are sorry: we had to cancel your booking "Surf lesson" for 2026-09-25 08:00 UTC.',
      ],
      [order("accepted"), {}, "Accepted: 2 × Wax", 'We have accepted your order "2 × Wax".'],
      [order("paid"), {}, "Payment received: 2 × Wax", 'Thank you: we have received your payment for "2 × Wax".'],
      [
        order("payment_failed", { paymentUrl: "https://pay.example/1" }),
        {},
        "Your payment for 2 × Wax did not go through",
        'Your payment for "2 × Wax" did not go through. You can still pay: https://pay.example/1',
      ],
      [order("fulfilled"), {}, "Fulfilled: 2 × Wax", 'We have fulfilled your order "2 × Wax".'],
      [
        order("cancelled"),
        { byCustomer: true },
        "Cancelled: 2 × Wax",
        'Your order "2 × Wax" is cancelled, as you asked.',
      ],
      [order("cancelled"), {}, "Cancelled: 2 × Wax", 'We are sorry: we had to cancel your order "2 × Wax".'],
      [
        quote("declined"),
        { byCustomer: true },
        "Declined: Board repair",
        'You declined our quote for "Board repair". Thank you for letting us know.',
      ],
      [quote("declined"), {}, "We cannot take Board repair", 'Sorry, we cannot take on "Board repair".'],
    ];
    for (const [item, opts, subject, first] of cases) {
      const m = mail(item, opts);
      expect([m.subject, m.lines[0]], `${item.type} ${item.state}`).toEqual([subject, first]);
      expect(`${m.subject}\n${m.lines.join("\n")}`).not.toMatch(PLATFORM_WORDS);
    }
    // A payment asked for says where to pay.
    expect(mail(order("awaiting_payment", { paymentUrl: "https://pay.example/2" })).lines).toEqual([
      'We have accepted your order "2 × Wax"; it is waiting for your payment.',
      "You can pay here: https://pay.example/2",
    ]);
    // A quote says what it comes to, and the business's notes.
    const quoted = mail(
      quote("quoted", {
        quote: {
          totalPrice: { value: 12000, currency: "EUR" },
          validThrough: "2026-10-01T00:00:00Z",
          notes: "Two days.",
        },
      }),
    );
    expect(quoted.subject).toBe("Our quote for Board repair");
    expect(quoted.lines[0]).toMatch(/^Here is our quote for "Board repair": .*120\.00\.$/);
    expect(quoted.lines).toContain("Two days.");
    // The business's own words go with it: a decline's note, and a reply is the email itself.
    expect(mail(booking("declined"), { words: "We are closed that week." }).lines).toEqual([
      'Sorry, we cannot take your booking "Surf lesson" for 2026-09-25 08:00 UTC.',
      "",
      "We are closed that week.",
    ]);
    expect(mail(booking("confirmed"), { event: "message", words: "See you at the beach." })).toEqual({
      subject: "Re: Surf lesson",
      lines: ["See you at the beach."],
    });
  });

  it("writes a time in the business's timezone", () => {
    expect(whenIn("2026-09-25T08:00:00Z", "UTC")).toBe("2026-09-25 08:00 UTC");
    const lisbon = whenIn("2026-09-25T08:00:00Z", "Europe/Lisbon");
    expect(lisbon).toContain("09:00");
    expect(lisbon).toContain("2026");
    expect(whenIn("2026-09-25T08:00:00Z", "Not/AZone")).toBe("2026-09-25 08:00 UTC");
  });

  it("answers a customer's request in the business's voice, and the owner as before", () => {
    expect(describeToCustomer(booking("requested"))).toBe(
      `Your booking "Surf lesson" for 2026-09-25 08:00 UTC is with us; we will confirm it or suggest another time. Reference ${base.id}.`,
    );
    expect(describeToCustomer(order("cancelled_by_business"))).not.toMatch(PLATFORM_WORDS);
    for (const state of ["confirmed", "declined", "cancelled_by_business", "no_show", "completed"]) {
      expect(describeToCustomer(booking(state))).not.toMatch(PLATFORM_WORDS);
    }
  });

  it("sends the one-time code as the business, and says the code is for the customer's assistant only in its own words", () => {
    const named = parseStoredSettings({ business: { name: "Oficina Maré" } }).settings;
    const m = codeMail(named, "482913");
    expect(m.subject).toBe("Your code for Oficina Maré");
    expect(m.text.split("\n")[0]).toBe("Your code for Oficina Maré is 482913. It works for 10 minutes.");
    expect(`${m.subject}\n${m.text}`).not.toMatch(PLATFORM_WORDS);
    const unnamed = codeMail(parseStoredSettings({}).settings, "000123");
    expect(unnamed.subject).toBe("Your code");
    expect(unnamed.text.split("\n")[0]).toBe("Your code is 000123. It works for 10 minutes.");

    expect(KEY_LINE).toBe("If you use an assistant, it can show this code next time so we recognise you:");
    expect(keyLine(["k1"])).toBe(`${KEY_LINE} k1`);
    expect(keyLine(["k1", "k2"])).toBe(
      "If you use an assistant, it can show these codes next time so we recognise you: k1 k2",
    );
    expect(KEY_LINE).not.toMatch(PLATFORM_WORDS);
  });
});

describe("the emails a customer gets", () => {
  async function setup() {
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
      createdAt: T0,
      updatedAt: T0,
    });
    const caps = new Capabilities(db);
    await caps.updateSettings(owner(), {
      doc: {
        business: { name: "Oficina Maré" },
        email: { fromAddress: "hello@oficinamare.pt", replyTo: "hello@oficinamare.pt" },
      },
    });
    const mail = logMailOut();
    const runner = createRunner({ mailOut: mail });
    const drain = async (t: number) => {
      for (let i = 0; i < 10; i++) if ((await runner.runDue(db, { now: t, limit: 100 })).claimed === 0) return;
    };
    const toRita = () => mail.sent.filter((m) => m.to.includes("rita@example.com"));
    return { db, caps, svc, mail, drain, toRita };
  }

  it("come from the business, in its words, with what it wrote", async () => {
    const s = await setup();
    const b = await s.caps.createBooking(customer(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Surf lesson" },
        startTime: new Date(T0 + 2 * DAY).toISOString(),
        endTime: new Date(T0 + 2 * DAY + 90 * MIN).toISOString(),
      },
      contact: { name: "Rita", email: "rita@example.com" },
    });
    await s.caps.transitionItem(owner(T0 + MIN), {
      item_id: b.view.item.id,
      event: "decline",
      input: { note: "We are closed that week, sorry." },
    });
    await s.drain(T0 + MIN);
    const [declined] = s.toRita();
    expect(declined?.from).toEqual({ address: "hello@oficinamare.pt", name: "Oficina Maré" });
    expect(declined?.subject).toBe("We cannot take Surf lesson");
    expect(declined?.text.split("\n")).toEqual([
      'Sorry, we cannot take your booking "Surf lesson" for 2026-09-24 09:00 UTC.',
      "",
      "We are closed that week, sorry.",
      "",
      `Reference: ${b.view.item.id}`,
      "Reply to this email to reach us.",
      "",
      "Oficina Maré",
    ]);

    // A message answered: the reply is the email.
    const m = await s.caps.sendMessage(customer(T0 + 2 * MIN), {
      subject: "Wetsuits",
      body: "Do you rent wetsuits?",
      contact: { email: "rita@example.com" },
    });
    const messageId = (m as { view: { item: { id: string } } }).view.item.id;
    await s.caps.reply(owner(T0 + 3 * MIN), { item_id: messageId, body: "We do: 10 euros a day.", internal: false });
    await s.drain(T0 + 3 * MIN);
    const answer = s.toRita().at(-1);
    expect(answer?.subject).toBe("Re: Wetsuits");
    expect(answer?.text.split("\n")[0]).toBe("We do: 10 euros a day.");
    // And a second reply on the same conversation, not a transition, is the email too.
    await s.caps.reply(owner(T0 + 4 * MIN), { item_id: messageId, body: "Sizes S to XL.", internal: false });
    await s.drain(T0 + 4 * MIN);
    expect(s.toRita().at(-1)?.text.split("\n")[0]).toBe("Sizes S to XL.");

    for (const sent of s.toRita()) expect(`${sent.subject}\n${sent.text}`).not.toMatch(PLATFORM_WORDS);
  });
});
