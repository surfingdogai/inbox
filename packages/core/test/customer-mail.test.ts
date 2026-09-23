import { logMailOut, runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { codeMail } from "../src/capabilities/identity";
import { Capabilities } from "../src/capabilities/service";
import { COPY } from "../src/customer/copy";
import { DISCLOSURE, keyMail, privacyPage, privacyUrl } from "../src/customer/disclosure";
import { moneyIn, shortRef, whenText } from "../src/customer/format";
import type { CustomerLang } from "../src/customer/lang";
import type { LinkAction } from "../src/customer/links";
import {
  answerLines,
  type CustomerMailInput,
  effectiveWrittenBy,
  isAutomated,
  renderCustomerMail,
} from "../src/customer/mail";
import { createDb } from "../src/db";
import type { Item } from "../src/domain/types";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { services } from "../src/schema/tables";
import type { Caller } from "../src/write/caller";
import { describeToCustomer } from "../src/write/views";
import { makeClient, resetTables } from "./harness";

/**
 * What a customer reads (Tiago, 23 September 2026): most customers do not know which software a
 * business runs, or that there is any — they contacted the business. So every email is the business
 * speaking, in its own name and its customer's language (English or Portuguese), with the time in
 * its zone and the zone named, the price and the total, until when to answer, the links to answer
 * with, and a six-character reference; none of it names the software, a network, a pass, a key, a
 * receipt or an id. An email a rule or the business's assistant sent says so in one line. Runs on
 * Node and in workerd, whose Intl data differ: times are compared with `whenText` itself.
 */
const PLATFORM_WORDS = /surfing ?dog|network|\bpass(es)?\b|\bkeys?\b|receipt|reputation|presentation|\binbox\b/i;
const PT_PLATFORM_WORDS = /surfing ?dog|\brede\b|\bpasse\b|\bchave\b|recibo|\binbox\b/i;
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;
const T0 = Date.parse("2026-09-22T09:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const TZ = "Europe/Lisbon";

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

const ID = "01JD0000000000000000QX7K3A";
const REF = shortRef(ID);
const base = {
  id: ID,
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
const START = "2026-09-25T08:00:00Z";
const booking = (state: string, extra: Record<string, unknown> = {}) =>
  ({
    ...base,
    type: "booking",
    state,
    subject: "Surf lesson",
    payload: {
      reservationFor: { serviceId: "s", name: "Surf lesson" },
      startTime: START,
      endTime: "2026-09-25T09:30:00Z",
      totalPrice: { value: 4500, currency: "EUR" },
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
      orderedItem: [{ productId: "w", name: "Wax", quantity: 2, price: { value: 800, currency: "EUR" } }],
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
const refund = (state: string) =>
  ({
    ...base,
    type: "refund",
    state,
    subject: null,
    payload: { orderItemId: "o", amount: { value: 1200, currency: "EUR" }, reason: "Broken" },
  }) as unknown as Item;

const at = (iso: string, lang: CustomerLang = "en", tz = TZ) => whenText(iso, tz, lang);
const mail = (item: Item, extra: Partial<CustomerMailInput> = {}) =>
  renderCustomerMail({
    item,
    event: "x",
    lang: "en",
    timezone: TZ,
    business: "Oficina Maré",
    name: "Rita",
    cancellationWindowMin: 0,
    now: T0,
    ...extra,
  });
/** The email's lines between the greeting and the footer. */
const bodyOf = (text: string) => {
  const lines = text.split("\n");
  const end = lines.findIndex((l) => l.startsWith("Reference: ") || l.startsWith("Referência: "));
  const body = lines.slice(2, end);
  while (body.at(-1) === "") body.pop();
  return body;
};

describe("the emails a business sends its customer", () => {
  it("says every change in its own voice, in English, with the time, the zone, the price and the reference", () => {
    const cases: [Item, Partial<CustomerMailInput>, string, string, string][] = [
      [
        booking("requested"),
        { event: "create" },
        "ack.booking",
        "We have your booking request: Surf lesson",
        `Thank you. We have your request for "Surf lesson" on ${at(START)}.`,
      ],
      [
        order("received"),
        { event: "create" },
        "ack.order",
        "We have your order: 2 × Wax",
        "Thank you. We have your order:",
      ],
      [
        quote("received"),
        { event: "create" },
        "ack.quote",
        "We have your request: Board repair",
        'Thank you. We have your request for a quote for "Board repair". We will send you a price soon.',
      ],
      [
        booking("confirmed"),
        { event: "confirm" },
        "booking.confirmed",
        "Confirmed: Surf lesson",
        `Your booking "Surf lesson" on ${at(START)} is confirmed.`,
      ],
      [
        booking("confirmed"),
        { event: "confirm", fromState: "proposed" },
        "booking.confirmed",
        "Confirmed: Surf lesson",
        `Your booking "Surf lesson" is confirmed for ${at(START)}, the time we suggested.`,
      ],
      [
        booking("confirmed"),
        { event: "accept", actorKind: "customer_agent" },
        "booking.accepted",
        "Confirmed: Surf lesson",
        `Thank you. Your booking "Surf lesson" is confirmed for ${at(START)}.`,
      ],
      [
        booking("requested"),
        { event: "counter", actorKind: "customer_agent" },
        "booking.counter",
        "We have your new time: Surf lesson",
        `Thank you. You asked for ${at(START)} instead. We will confirm it soon.`,
      ],
      [
        booking("needs_info"),
        { event: "request_info", words: "Which board size?" },
        "needs_info",
        "A question about your booking: Surf lesson",
        'We need a little more detail about your booking "Surf lesson":',
      ],
      [
        booking("declined"),
        { event: "decline" },
        "declined",
        "We cannot take Surf lesson",
        `Sorry, we cannot take your booking "Surf lesson" for ${at(START)}.`,
      ],
      [
        booking("cancelled_by_business"),
        { event: "cancel_by_business" },
        "cancelled.by_us",
        "Cancelled: Surf lesson",
        `We are sorry: we had to cancel your booking "Surf lesson" on ${at(START)}.`,
      ],
      [
        booking("cancelled_by_customer"),
        { event: "cancel", fromState: "confirmed", actorKind: "customer_human" },
        "cancelled.as_asked",
        "Cancelled: Surf lesson",
        `Your booking "Surf lesson" on ${at(START)} is cancelled, as you asked.`,
      ],
      [
        booking("cancelled_by_customer"),
        { event: "record_cancel", fromState: "requested", actorKind: "owner" },
        "cancelled.as_asked",
        "Cancelled: Surf lesson",
        'Your booking request "Surf lesson" is cancelled, as you asked.',
      ],
      [
        booking("cancelled_by_customer"),
        { event: "cancel", fromState: "proposed", actorKind: "customer_agent" },
        "booking.declined_time",
        "Request closed: Surf lesson",
        'You declined the time we suggested for "Surf lesson", so we have closed your request. Thank you for letting us know.',
      ],
      [
        order("accepted"),
        { event: "accept" },
        "order.accepted",
        "Accepted: 2 × Wax",
        'We have accepted your order "2 × Wax".',
      ],
      [
        order("awaiting_payment", { paymentUrl: "https://pay.example/2" }),
        { event: "request_payment" },
        "order.awaiting_payment",
        "Payment for 2 × Wax",
        'We have accepted your order "2 × Wax"; it is waiting for your payment of €16.00.',
      ],
      [
        order("paid"),
        { event: "record_payment" },
        "order.paid",
        "Payment received: 2 × Wax",
        'Thank you: we have received your payment of €16.00 for "2 × Wax".',
      ],
      [
        order("payment_failed", { paymentUrl: "https://pay.example/1" }),
        { event: "payment_failed" },
        "order.payment_failed",
        "Your payment for 2 × Wax did not go through",
        'Your payment for "2 × Wax" did not go through.',
      ],
      [
        order("fulfilled"),
        { event: "fulfil" },
        "order.fulfilled",
        "Completed: 2 × Wax",
        'We have completed your order "2 × Wax".',
      ],
      [
        order("declined"),
        { event: "decline" },
        "declined",
        "We cannot take 2 × Wax",
        'Sorry, we cannot take your order "2 × Wax".',
      ],
      [
        order("cancelled"),
        { event: "cancel", actorKind: "customer_human" },
        "cancelled.as_asked",
        "Cancelled: 2 × Wax",
        'Your order "2 × Wax" is cancelled, as you asked.',
      ],
      [
        order("cancelled"),
        { event: "record_cancel", actorKind: "owner" },
        "cancelled.as_asked",
        "Cancelled: 2 × Wax",
        'Your order "2 × Wax" is cancelled, as you asked.',
      ],
      [
        order("cancelled"),
        { event: "cancel", actorKind: "owner" },
        "cancelled.by_us",
        "Cancelled: 2 × Wax",
        'We are sorry: we had to cancel your order "2 × Wax".',
      ],
      [
        quote("declined"),
        { event: "decline", actorKind: "customer_agent" },
        "quote.declined",
        "Declined: Board repair",
        'You declined our quote for "Board repair". Thank you for letting us know.',
      ],
      [
        quote("declined"),
        { event: "decline", actorKind: "owner" },
        "declined",
        "We cannot take Board repair",
        'Sorry, we cannot take on "Board repair".',
      ],
      [
        refund("approved"),
        { event: "approve" },
        "refund.approved",
        "Your refund",
        "We have approved your refund request.",
      ],
      [
        refund("rejected"),
        { event: "reject" },
        "refund.rejected",
        "Your refund",
        "Sorry, we cannot approve your refund request.",
      ],
      [refund("refunded"), { event: "refund" }, "refund.refunded", "Your refund", "We have refunded €12.00."],
      [
        booking("no_show"),
        { event: "no_show" },
        "news",
        "News about Surf lesson",
        'There is news about your booking "Surf lesson".',
      ],
    ];
    for (const [item, extra, template, subject, first] of cases) {
      const m = mail(item, extra);
      const label = `${item.type} ${item.state} ${extra.event}`;
      expect([m.template, m.subject], label).toEqual([template, subject]);
      expect(bodyOf(m.text)[0], label).toBe(first);
      expect(m.text.split("\n")[0], label).toBe("Hello Rita,");
      expect(m.text, label).toContain(`Reference: ${REF}`);
      expect(m.text, label).not.toMatch(ULID);
      expect(`${m.subject}\n${m.text}`, label).not.toMatch(PLATFORM_WORDS);
      // Every time the email writes names its zone.
      for (const line of m.text.split("\n").filter((l) => /2026/.test(l))) expect(line, label).toMatch(/\(.+\)/);
    }
  });

  it("puts the footer last: the reference, how to reach us, and the business's name", () => {
    const m = mail(booking("confirmed"), { event: "confirm" });
    expect(m.text.split("\n").slice(-4)).toEqual([
      `Reference: ${REF}`,
      "Reply to this email to reach us.",
      "",
      "Oficina Maré",
    ]);
    expect(mail(booking("confirmed"), { event: "confirm", name: null }).text.split("\n")[0]).toBe("Hello,");
    expect(mail(booking("confirmed"), { event: "confirm", business: "" }).text.split("\n").at(-1)).toBe(
      "Reply to this email to reach us.",
    );
  });

  it("carries the price, the total, the answer-by and the cancellation cutoff", () => {
    expect(bodyOf(mail(booking("requested"), { event: "create" }).text)).toEqual([
      `Thank you. We have your request for "Surf lesson" on ${at(START)}.`,
      "Price: €45.00.",
      "We will confirm it or suggest another time soon.",
    ]);
    // A price the business has not set yet is not written as ours.
    expect(bodyOf(mail(booking("requested"), { event: "create", unpriced: true }).text)).toContain(
      "We will confirm the price with you.",
    );
    const lines = bodyOf(
      mail(
        order("received", { orderedItem: [{ name: "Custom fin", quantity: 1, price: { value: 1, currency: "EUR" } }] }),
        {
          event: "create",
          unpriced: true,
        },
      ).text,
    );
    expect(lines).toEqual([
      "Thank you. We have your order:",
      "",
      "1 × Custom fin — price to be confirmed",
      "We will confirm the price with you.",
      "",
      "We will confirm it soon.",
    ]);
    expect(bodyOf(mail(order("accepted"), { event: "accept" }).text)).toEqual([
      'We have accepted your order "2 × Wax".',
      "",
      "2 × Wax — €16.00",
      "Total: €16.00",
    ]);
    // Confirmed with a window: until when the customer can tell us, while that is still ahead.
    const confirmed = mail(booking("confirmed"), { event: "confirm", cancellationWindowMin: 24 * 60 });
    expect(bodyOf(confirmed.text)).toEqual([
      `Your booking "Surf lesson" on ${at(START)} is confirmed.`,
      "Price: €45.00.",
      `If you cannot come, please tell us before ${at("2026-09-24T08:00:00Z")}.`,
    ]);
    expect(
      bodyOf(
        mail(booking("confirmed"), { event: "confirm", cancellationWindowMin: 24 * 60, now: Date.parse(START) }).text,
      ),
    ).not.toContain(`If you cannot come, please tell us before ${at("2026-09-24T08:00:00Z")}.`);
    // A payment asked for says where to pay.
    expect(
      bodyOf(mail(order("awaiting_payment", { paymentUrl: "https://pay.example/2" }), { event: "x" }).text),
    ).toEqual([
      'We have accepted your order "2 × Wax"; it is waiting for your payment of €16.00.',
      "You can pay here: https://pay.example/2",
    ]);
  });

  it("proposes another time with the old one beside it, the price, until when to answer, and the links", () => {
    const proposed = booking("proposed", {
      proposed: { startTime: "2026-09-25T13:00:00Z", endTime: "2026-09-25T14:30:00Z" },
    });
    const links = new Map<LinkAction, string>([
      ["accept_time", "https://x.example/c/a"],
      ["decline_time", "https://x.example/c/d"],
      ["other_time", "https://x.example/c/o"],
    ]);
    const m = mail(proposed, { event: "propose", words: "We are full in the morning.", links });
    expect(m.subject).toBe("Another time for Surf lesson");
    expect(bodyOf(m.text)).toEqual([
      `We would like to suggest another time for "Surf lesson": ${at("2026-09-25T13:00:00Z")}.`,
      `(You asked for ${at(START)}.)`,
      "Price: €45.00.",
      `Please answer by ${at("2026-09-25T13:00:00Z")}. The time is yours if it is still free when you say yes.`,
      "",
      "We are full in the morning.",
      "",
      "Accept: https://x.example/c/a",
      "Decline: https://x.example/c/d",
      "Pick another time: https://x.example/c/o",
    ]);
    // The minimum notice brings the answer-by forward.
    expect(mail(proposed, { event: "propose", minNoticeMin: 60 }).text).toContain(
      `Please answer by ${at("2026-09-25T12:00:00Z")}.`,
    );
    // Without links, a reply does the same.
    expect(mail(proposed, { event: "propose" }).text).toContain(
      "Reply to this email to accept, decline or ask for another time.",
    );
    // A price the business proposes with the time is ours, whatever the request held.
    expect(
      mail(
        booking("proposed", {
          proposed: {
            startTime: "2026-09-25T13:00:00Z",
            endTime: "2026-09-25T14:30:00Z",
            totalPrice: { value: 5000, currency: "EUR" },
          },
        }),
        { event: "propose", unpriced: true },
      ).text,
    ).toContain("Price: €50.00.");
  });

  it("sends a quote with its lines, total, time and validity, and says when it replaces one", () => {
    const quoted = quote("quoted", {
      quote: {
        totalPrice: { value: 12000, currency: "EUR" },
        validThrough: "2026-10-01T18:00:00Z",
        lines: [
          { name: "Resin", quantity: 2, price: { value: 3000, currency: "EUR" } },
          { name: "Labour", quantity: 1, price: { value: 6000, currency: "EUR" } },
        ],
        notes: "Two days in the workshop.",
        creates: "booking",
        startTime: "2026-09-30T09:00:00Z",
      },
    });
    const links = new Map<LinkAction, string>([
      ["accept_quote", "https://x.example/c/a"],
      ["decline_quote", "https://x.example/c/d"],
    ]);
    const m = mail(quoted, { event: "quote", links });
    expect([m.template, m.subject]).toEqual(["quote.quoted", "Our quote for Board repair"]);
    expect(bodyOf(m.text)).toEqual([
      'Here is our quote for "Board repair":',
      "2 × Resin — €60.00",
      "1 × Labour — €60.00",
      "Total: €120.00",
      `For ${at("2026-09-30T09:00:00Z")}.`,
      `This price holds until ${at("2026-10-01T18:00:00Z")}.`,
      "",
      "Two days in the workshop.",
      "",
      "Accept: https://x.example/c/a",
      "Decline: https://x.example/c/d",
    ]);
    expect(bodyOf(mail(quoted, { event: "quote", revised: true }).text)[0]).toBe(
      'Here is our new quote for "Board repair"; it replaces the one before:',
    );
    // What an accepted quote became, with its total.
    const accepted = { ...quote("accepted"), subject: "Wheel" } as Item;
    expect(
      bodyOf(mail(accepted, { event: "accept", actorKind: "customer_agent", linked: booking("confirmed") }).text),
    ).toEqual([
      `Thank you for accepting our quote. Your booking "Wheel" is confirmed for ${at(START)}.`,
      "Total: €45.00",
    ]);
    expect(bodyOf(mail(accepted, { event: "accept", linked: order("accepted") }).text)).toEqual([
      'Thank you for accepting our quote. Your order "Wheel" is confirmed.',
      "Total: €16.00",
    ]);
  });

  it("asks for a detail with the question, the link, and the reply that does the same", () => {
    const withLink = mail(booking("needs_info"), {
      event: "request_info",
      words: "Which board size?",
      links: new Map<LinkAction, string>([["details", "https://x.example/c/q"]]),
    });
    expect(bodyOf(withLink.text)).toEqual([
      'We need a little more detail about your booking "Surf lesson":',
      "",
      "Which board size?",
      "",
      "Send the details: https://x.example/c/q",
      "Or simply reply to this email.",
    ]);
    expect(mail(booking("needs_info"), { event: "request_info" }).text).toContain(
      "Reply to this email with the details.",
    );
  });

  it("sends a reply as the business wrote it, and says so when nobody at the business wrote it", () => {
    const reply = mail(booking("confirmed"), { event: "message", words: "See you at the beach.", actorKind: "owner" });
    expect(reply).toEqual({
      template: "reply",
      subject: "Re: Surf lesson",
      text: [
        "See you at the beach.",
        "",
        `Reference: ${REF}`,
        "Reply to this email to reach us.",
        "",
        "Oficina Maré",
      ].join("\n"),
    });
    // Anything no person typed (Tiago, 23 September 2026): a rule's reply, the business's assistant's
    // (its own key, or anything through the owner's MCP), another system's (an integration key, a
    // shop's connector).
    for (const extra of [
      { actorKind: "rule" },
      { actorKind: "owner_ai" },
      { actorKind: "integration" },
      { actorKind: "connector" },
      { actorKind: "owner", automated: true },
    ] as Partial<CustomerMailInput>[]) {
      const auto = mail(booking("confirmed"), { event: "message", words: "See you at the beach.", ...extra });
      expect(auto.text.split("\n").slice(-5), JSON.stringify(extra)).toEqual([
        "",
        "This reply was sent automatically. Reply to reach a person.",
        `Reference: ${REF}`,
        "",
        "Oficina Maré",
      ]);
      expect(auto.text).not.toContain("Reply to this email to reach us.");
    }
    // A change a rule made carries the line too; one a person or the customer made does not.
    expect(mail(booking("confirmed"), { event: "confirm", actorKind: "rule" }).text).toContain(
      "This reply was sent automatically. Reply to reach a person.",
    );
    for (const actorKind of ["owner", "staff", "system", "customer_agent", "customer_human"]) {
      expect(mail(booking("confirmed"), { event: "confirm", actorKind }).text, actorKind).not.toContain(
        "sent automatically",
      );
    }
    expect(mail(booking("confirmed"), { event: "confirm", actorKind: "integration" }).text).toContain(
      "This reply was sent automatically. Reply to reach a person.",
    );
    // An integration whose request says a person typed it (a CRM's user) is not automatic; nobody
    // else can say so, and anyone can say nobody did.
    expect(isAutomated("integration", "rest", "person")).toBe(false);
    expect(isAutomated("integration", "mcp_owner", "person")).toBe(true);
    expect(isAutomated("owner_ai", "mcp_owner", "person")).toBe(true);
    expect(isAutomated("owner", "owner_ui", "automation")).toBe(true);
    expect(isAutomated("owner", "owner_ui", null)).toBe(false);
    const integration = {
      actor: { kind: "integration", channel: "rest" },
      principal: { keyKind: "integration" },
    } as const;
    expect(effectiveWrittenBy(integration, "person")).toBe("person");
    expect(effectiveWrittenBy({ ...integration, actor: { kind: "integration", channel: "mcp_owner" } }, "person")).toBe(
      null,
    );
    expect(effectiveWrittenBy({ actor: { kind: "owner_ai", channel: "mcp_owner" } }, "person")).toBe(null);
    expect(effectiveWrittenBy({ actor: { kind: "owner", channel: "owner_ui" } }, "person")).toBe(null);
    expect(effectiveWrittenBy({ actor: { kind: "owner_ai", channel: "mcp_owner" } }, "automation")).toBe("automation");
    expect(effectiveWrittenBy(integration, undefined)).toBe(null);
    const pt = mail(booking("confirmed"), { event: "message", words: "Até amanhã.", actorKind: "rule", lang: "pt" });
    expect(pt.text).toContain("Esta resposta foi enviada automaticamente. Responda para falar com uma pessoa.");
    expect(pt.text).not.toContain("Responda a este email para falar connosco.");
    // A message answered without words says so.
    const answered = {
      ...base,
      type: "message",
      state: "answered",
      subject: "Wetsuits",
      payload: { text: "?" },
    } as unknown as Item;
    expect(mail(answered, { event: "answer" })).toMatchObject({
      template: "message.answered",
      subject: "Re: Wetsuits",
    });
  });

  it("writes every email in Portuguese for a Portuguese customer, and names nobody else there either", () => {
    const pt = (item: Item, extra: Partial<CustomerMailInput>) => mail(item, { lang: "pt", ...extra });
    const cases: [Item, Partial<CustomerMailInput>, string, string][] = [
      [
        booking("requested"),
        { event: "create" },
        "Recebemos o seu pedido de marcação: Surf lesson",
        `Obrigado. Recebemos o seu pedido de "Surf lesson" para ${at(START, "pt")}.`,
      ],
      [
        order("received"),
        { event: "create" },
        "Recebemos a sua encomenda: 2 × Wax",
        "Obrigado. Recebemos a sua encomenda:",
      ],
      [
        quote("received"),
        { event: "create" },
        "Recebemos o seu pedido: Board repair",
        'Obrigado. Recebemos o seu pedido de orçamento para "Board repair". Vamos enviar-lhe um preço em breve.',
      ],
      [
        booking("confirmed"),
        { event: "confirm" },
        "Confirmado: Surf lesson",
        `A sua marcação "Surf lesson" para ${at(START, "pt")} está confirmada.`,
      ],
      [
        booking("confirmed"),
        { event: "accept", actorKind: "customer_agent" },
        "Confirmado: Surf lesson",
        `Obrigado. A sua marcação "Surf lesson" está confirmada para ${at(START, "pt")}.`,
      ],
      [
        booking("proposed", { proposed: { startTime: "2026-09-25T13:00:00Z", endTime: "2026-09-25T14:30:00Z" } }),
        { event: "propose" },
        "Outra hora para Surf lesson",
        `Queremos sugerir outra hora para "Surf lesson": ${at("2026-09-25T13:00:00Z", "pt")}.`,
      ],
      [
        booking("needs_info"),
        { event: "request_info" },
        "Uma pergunta sobre a sua marcação: Surf lesson",
        'Precisamos de mais um detalhe sobre a sua marcação "Surf lesson":',
      ],
      [
        booking("declined"),
        { event: "decline" },
        "Não podemos aceitar Surf lesson",
        `Lamentamos, mas não podemos aceitar a sua marcação "Surf lesson" para ${at(START, "pt")}.`,
      ],
      [
        booking("cancelled_by_business"),
        { event: "cancel_by_business" },
        "Cancelado: Surf lesson",
        `Lamentamos: tivemos de cancelar a sua marcação "Surf lesson" de ${at(START, "pt")}.`,
      ],
      [
        booking("cancelled_by_customer"),
        { event: "cancel", fromState: "confirmed", actorKind: "customer_human" },
        "Cancelado: Surf lesson",
        `A sua marcação "Surf lesson" de ${at(START, "pt")} foi cancelada, como pediu.`,
      ],
      [
        booking("cancelled_by_customer"),
        { event: "cancel", fromState: "proposed", actorKind: "customer_human" },
        "Pedido fechado: Surf lesson",
        'Recusou a hora que sugerimos para "Surf lesson", por isso fechámos o seu pedido. Obrigado por nos avisar.',
      ],
      [
        booking("requested"),
        { event: "counter", actorKind: "customer_agent" },
        "Recebemos a nova hora: Surf lesson",
        `Obrigado. Pediu ${at(START, "pt")} em alternativa. Vamos confirmar em breve.`,
      ],
      [
        order("paid"),
        { event: "record_payment" },
        "Pagamento recebido: 2 × Wax",
        `Obrigado: recebemos o seu pagamento de ${moneyIn({ value: 1600, currency: "EUR" }, "pt")} para "2 × Wax".`,
      ],
      [order("fulfilled"), { event: "fulfil" }, "Concluída: 2 × Wax", 'Concluímos a sua encomenda "2 × Wax".'],
      [
        quote("declined"),
        { event: "decline", actorKind: "customer_agent" },
        "Recusado: Board repair",
        'Recusou o nosso orçamento para "Board repair". Obrigado por nos avisar.',
      ],
      [
        refund("refunded"),
        { event: "refund" },
        "O seu reembolso",
        `Fizemos o reembolso de ${moneyIn({ value: 1200, currency: "EUR" }, "pt")}.`,
      ],
    ];
    for (const [item, extra, subject, first] of cases) {
      const m = pt(item, extra);
      const label = `${item.type} ${item.state} ${extra.event}`;
      expect(m.subject, label).toBe(subject);
      expect(bodyOf(m.text)[0], label).toBe(first);
      expect(m.text.split("\n")[0], label).toBe("Olá Rita,");
      expect(m.text, label).toContain(`Referência: ${REF}`);
      expect(m.text, label).toContain("Responda a este email para falar connosco.");
      expect(`${m.subject}\n${m.text}`, label).not.toMatch(PT_PLATFORM_WORDS);
      expect(m.text, label).not.toMatch(ULID);
    }
    expect(pt(booking("requested"), { event: "create" }).text).toContain(
      `Preço: ${moneyIn({ value: 4500, currency: "EUR" }, "pt")}.`,
    );
  });

  it("gives the customer a way to answer: the links, or a reply where there are none", () => {
    const time = booking("proposed", {
      proposed: { startTime: "2026-09-25T13:00:00Z", endTime: "2026-09-25T14:30:00Z" },
    });
    expect(answerLines(time, null, "en")).toEqual(["Reply to this email to accept, decline or ask for another time."]);
    expect(answerLines(time, null, "pt")).toEqual(["Responda a este email para aceitar, recusar ou pedir outra hora."]);
    expect(answerLines(booking("needs_info"), null, "en")).toEqual(["Reply to this email with the details."]);
    expect(answerLines(booking("confirmed"), null, "en")).toEqual([]);
    const links = new Map<LinkAction, string>([
      ["accept_time", "https://x.example/c/a"],
      ["decline_time", "https://x.example/c/d"],
      ["other_time", "https://x.example/c/o"],
    ]);
    expect(answerLines(time, links, "pt")).toEqual([
      "Aceitar: https://x.example/c/a",
      "Recusar: https://x.example/c/d",
      "Escolher outra hora: https://x.example/c/o",
    ]);
  });

  it("answers a customer's request in the business's voice, and the owner as before", () => {
    expect(describeToCustomer(booking("requested"))).toContain("(UTC)");
    expect(describeToCustomer(booking("requested"))).not.toContain(base.id);
    expect(describeToCustomer(order("cancelled_by_business"))).not.toMatch(PLATFORM_WORDS);
  });
});

describe("the code a customer asked for, and the code for their assistant", () => {
  it("sends the one-time code as the business, in the customer's language", () => {
    expect(codeMail({ business: "Oficina Maré", minutes: 10, code: "482913", lang: "en" })).toEqual({
      subject: "Your code for Oficina Maré",
      text: "Your code is 482913. It works for 10 minutes.\n\nIf you did not ask for it, you can ignore this email.",
    });
    expect(codeMail({ business: "", minutes: 10, code: "000123", lang: "en" }).subject).toBe("Your code");
    expect(codeMail({ business: "Oficina Maré", minutes: 10, code: "482913", lang: "pt" })).toEqual({
      subject: "O seu código para Oficina Maré",
      text: "O seu código é 482913. É válido durante 10 minutos.\n\nSe não o pediu, pode ignorar este email.",
    });
  });

  it("sends the assistant's code alone, with one line about the booking network and a link to the page", () => {
    const key = `sdkey1_net.example.com_${"a".repeat(16)}_${"b".repeat(32)}`;
    const en = keyMail({
      lang: "en",
      name: "Rita",
      business: "Oficina Maré",
      item: { type: "booking", subject: "Surf lesson" },
      keys: [key],
      privacyUrl: privacyUrl("https://inbox.oficinamare.pt/", "en"),
    });
    expect(en).toEqual({
      template: "key",
      subject: "For next time",
      text: [
        "Hello Rita,",
        "",
        'Thank you for your booking "Surf lesson".',
        "If you use an assistant, it can show this code next time so we recognise you:",
        key,
        "",
        "We use a booking network to recognise returning customers. How it works: https://inbox.oficinamare.pt/c/privacy?l=en",
        "",
        "Oficina Maré",
      ].join("\n"),
    });
    const pt = keyMail({
      lang: "pt",
      name: null,
      business: "Oficina Maré",
      item: { type: "order", subject: "2 × Wax" },
      keys: [key, key],
      privacyUrl: privacyUrl("https://inbox.oficinamare.pt", "pt"),
    });
    expect(pt.subject).toBe("Para a próxima vez");
    expect(pt.text.split("\n").slice(0, 4)).toEqual([
      "Olá,",
      "",
      'Obrigado pela sua encomenda "2 × Wax".',
      "Se usar um assistente, ele pode mostrar estes códigos da próxima vez para o reconhecermos:",
    ]);
    expect(pt.text).toContain(
      "Usamos uma rede de reservas para reconhecer clientes habituais. Como funciona: https://inbox.oficinamare.pt/c/privacy?l=pt",
    );
    // Only the booking network is named, and only as that; nothing else of the software's.
    for (const m of [en, pt])
      expect(m.text.replaceAll(key, "")).not.toMatch(/surfing|\binbox\b(?!\.)|\bpass\b|receipt/i);
  });

  it("explains the network on its own page: which, what it keeps, what for, how to stop", () => {
    const page = privacyPage({ lang: "en", business: "Oficina Maré", networks: ["https://net.example.com"] });
    expect(page.title).toBe("Returning customers — Oficina Maré");
    expect(page.heading).toBe("How we recognise returning customers");
    expect(page.sections?.map((s) => s.heading)).toEqual([
      "Which network",
      "What the network keeps",
      "What it is for",
      "How to stop",
      "Questions",
    ]);
    expect(page.sections?.[0]?.links).toEqual([{ label: "net.example.com", href: "https://net.example.com" }]);
    // Where to ask the network: its own address, never a page it may not have.
    expect(page.sections?.[3]?.links).toEqual([{ label: "net.example.com", href: "https://net.example.com" }]);
    const none = privacyPage({ lang: "pt", business: "Oficina Maré", networks: [] });
    expect(none.sections?.[0]?.paragraphs).toEqual(["De momento não usamos nenhuma rede de reservas."]);
    // Both languages say the same things.
    const keys = (lang: CustomerLang) => Object.keys(DISCLOSURE[lang].privacy).sort();
    expect(keys("pt")).toEqual(keys("en"));
    for (const lang of ["en", "pt"] as const) {
      const all = JSON.stringify(DISCLOSURE[lang]);
      expect(all).not.toMatch(/surfing|\binbox\b|\bpass\b|receipt|recibo/i);
    }
  });

  it("has no email that carries the assistant's code on anything else", () => {
    for (const lang of ["en", "pt"] as const) {
      expect(JSON.stringify(COPY[lang])).not.toContain(DISCLOSURE[lang].keyLine);
      expect(JSON.stringify(COPY[lang].email)).not.toMatch(/sdkey/);
    }
  });
});

describe("the emails a customer gets", () => {
  async function setup(languages = ["en"]) {
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
        business: { name: "Oficina Maré", languages },
        booking: { cancellationWindowMin: 0 },
        email: { fromAddress: "hello@oficinamare.pt", replyTo: "hello@oficinamare.pt" },
      },
    });
    const mailOut = logMailOut();
    const runner = createRunner({ mailOut });
    const drain = async (t: number) => {
      for (let i = 0; i < 10; i++) if ((await runner.runDue(db, { now: t, limit: 100 })).claimed === 0) return;
    };
    const toRita = () => mailOut.sent.filter((m) => m.to.includes("rita@example.com"));
    return { db, caps, svc, mail: mailOut, drain, toRita };
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
    await s.drain(T0 + 2 * MIN);
    // The decline went out; the acknowledgement due after it did not, since it no longer applied.
    const [declined, ...more] = s.toRita();
    expect(more).toEqual([]);
    expect(declined?.from).toEqual({ address: "hello@oficinamare.pt", name: "Oficina Maré" });
    expect(declined?.subject).toBe("We cannot take Surf lesson");
    expect(declined?.text.split("\n")).toEqual([
      "Hello Rita,",
      "",
      `Sorry, we cannot take your booking "Surf lesson" for ${whenText(new Date(T0 + 2 * DAY).toISOString(), "UTC", "en")}.`,
      "",
      "We are closed that week, sorry.",
      "",
      `Reference: ${shortRef(b.view.item.id)}`,
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
    await s.caps.reply(owner(T0 + 4 * MIN), { item_id: messageId, body: "Sizes S to XL.", internal: false });
    await s.drain(T0 + 4 * MIN);
    expect(s.toRita().at(-1)?.text.split("\n")[0]).toBe("Sizes S to XL.");

    for (const sent of s.toRita()) expect(`${sent.subject}\n${sent.text}`).not.toMatch(PLATFORM_WORDS);
  });

  it("acknowledge a request a moment later, in the business's first language, and only once", async () => {
    const s = await setup(["pt", "en"]);
    const b = await s.caps.createBooking(customer(), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Surf lesson" },
        startTime: new Date(T0 + 2 * DAY).toISOString(),
        endTime: new Date(T0 + 2 * DAY + 90 * MIN).toISOString(),
      },
      contact: { name: "Rita", email: "rita@example.com" },
    });
    await s.drain(T0 + MIN);
    expect(s.toRita()).toHaveLength(0);
    await s.drain(T0 + 2 * MIN);
    const [ack] = s.toRita();
    expect(ack?.subject).toBe("Recebemos o seu pedido de marcação: Surf lesson");
    expect(ack?.text).toContain(`Referência: ${shortRef(b.view.item.id)}`);
    // Threaded from the first email: the item's anchor, which a reply carries back.
    expect(ack?.headers?.References).toMatch(/^<a\.[0-9a-z]{22}@oficinamare\.pt>$/);
    expect(ack?.headers?.["In-Reply-To"]).toBe(ack?.headers?.References);
    // A customer whose assistant said they read English gets English.
    const en = await s.caps.createBooking(
      { ...customer(T0 + 3 * MIN), actor: { kind: "customer_agent", id: "a", channel: "rest" } },
      {
        payload: {
          reservationFor: { serviceId: s.svc, name: "Surf lesson" },
          startTime: new Date(T0 + 3 * DAY).toISOString(),
          endTime: new Date(T0 + 3 * DAY + 90 * MIN).toISOString(),
        },
        contact: { name: "Ana", email: "ana@example.com", locale: "en-GB" },
      },
    );
    await s.drain(T0 + 6 * MIN);
    const toAna = s.mail.sent.filter((m) => m.to.includes("ana@example.com"));
    expect(toAna.map((m) => m.subject)).toEqual(["We have your booking request: Surf lesson"]);
    expect(toAna[0]?.text).toContain(`Reference: ${shortRef(en.view.item.id)}`);
    // No message is acknowledged: an automatic answer to an email could loop.
    await s.caps.sendMessage(customer(T0 + 7 * MIN), { body: "Hi", contact: { email: "joe@example.com" } });
    await s.drain(T0 + 10 * MIN);
    expect(s.mail.sent.filter((m) => m.to.includes("joe@example.com"))).toHaveLength(0);
  });
});
