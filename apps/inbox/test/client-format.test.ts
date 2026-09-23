import { describe, expect, it } from "vitest";
import {
  currencyOf,
  customerNotes,
  deliveryWord,
  emailLangOf,
  formatAddress,
  formatDateTime,
  formatMoney,
  formatWhen,
  localDateKey,
  mailBannerLines,
  mailWord,
  networksOffWords,
  otherLanguages,
  partyName,
  personStandings,
  receiptWord,
  relativeTime,
  rowTitle,
  snippetFor,
  stateTone,
  stateWord,
  titleFor,
  truncate,
} from "../client/src/lib/format";
import type { Item } from "../client/src/lib/types";

// The owner app's words and numbers: pure functions, so they run here on both runtimes.
const NOW = Date.parse("2026-09-21T12:00:00Z");

const booking: Item = {
  id: "01J0000000000000000000BOOK",
  type: "booking",
  state: "requested",
  version: 1,
  partyId: "p1",
  locationId: null,
  channel: "form",
  subject: "Full service, city bike",
  flags: { needsHuman: false, sandbox: false, priority: 0 },
  linkedItemId: null,
  createdAt: "2026-09-21T10:00:00Z",
  updatedAt: "2026-09-21T10:00:00Z",
  closedAt: null,
  payload: {
    reservationFor: { serviceId: "svc", name: "Full service, city bike" },
    startTime: "2026-09-23T13:00:00Z",
    endTime: "2026-09-23T14:30:00Z",
    totalPrice: { value: 4500, currency: "EUR" },
  },
};

describe("receipts in words", () => {
  it("names a promise by its kind and an outcome by how it ended", () => {
    const r = (kind: string, outcome: string | null, payload: Record<string, unknown> = {}) =>
      ({ kind, outcome, payload }) as Parameters<typeof receiptWord>[0];
    expect(receiptWord(r("confirmed", null))).toBe("Confirmed");
    expect(receiptWord(r("accepted", null))).toBe("Accepted");
    expect(receiptWord(r("outcome", "booking.completed"))).toBe("Completed");
    expect(receiptWord(r("outcome", "booking.completed", { aut: 1 }))).toBe("Completed automatically");
    expect(receiptWord(r("outcome", "booking.cancelled_late_by_customer"))).toBe("Cancelled late by the customer");
    expect(receiptWord(r("outcome", "order.lapsed", { aut: 1 }))).toBe("Lapsed unpaid automatically");
  });
});

describe("client format", () => {
  it("says states in words with a tone", () => {
    expect(stateWord("needs_info")).toBe("Needs info");
    expect(stateWord("cancelled_by_customer")).toBe("Cancelled by customer");
    expect(stateWord("requested")).toBe("Requested");
    expect(stateTone("confirmed")).toBe("success");
    expect(stateTone("needs_info")).toBe("warning");
    expect(stateTone("declined")).toBe("danger");
    expect(stateWord("payment_failed")).toBe("Payment failed");
    expect(stateTone("payment_failed")).toBe("warning");
    expect([stateWord("charged_back"), stateTone("charged_back")]).toEqual(["Charged back", "danger"]);
    expect(stateTone("open")).toBe("neutral");
  });

  it("formats money from minor units", () => {
    expect(formatMoney({ value: 4500, currency: "EUR" }, "en")).toBe("€45.00");
    expect(formatMoney({ value: 7840, currency: "GBP" }, "en")).toBe("£78.40");
    expect(formatMoney(undefined)).toBe("");
  });

  it("formats a booking window in the business time zone", () => {
    expect(formatWhen("2026-09-23T13:00:00Z", "2026-09-23T14:30:00Z", "Europe/Lisbon", "en-GB")).toBe(
      "Wed 23 Sept · 14:00–15:30",
    );
    expect(formatWhen("2026-09-23T13:00:00Z", undefined, "UTC", "en-GB")).toBe("Wed 23 Sept · 13:00");
  });

  it("gives compact ages for list rows", () => {
    expect(relativeTime("2026-09-21T11:59:40Z", NOW)).toBe("now");
    expect(relativeTime("2026-09-21T11:42:00Z", NOW)).toBe("18m");
    expect(relativeTime("2026-09-21T09:00:00Z", NOW)).toBe("3h");
    expect(relativeTime("2026-09-20T09:00:00Z", NOW)).toBe("yesterday");
    expect(relativeTime("2026-09-17T09:00:00Z", NOW, "en")).toBe("Thu");
    expect(relativeTime("2026-08-02T09:00:00Z", NOW, "en")).toBe("Aug 2");
    expect(relativeTime("2025-08-02T09:00:00Z", NOW, "en")).toBe("Aug 2, 2025");
  });

  it("titles and snippets an item from its payload", () => {
    expect(titleFor(booking)).toBe("Full service, city bike");
    expect(snippetFor(booking, "Europe/Lisbon", "en-GB")).toBe("Wed 23 Sept · 14:00–15:30 · €45.00");
    expect(currencyOf(booking)).toBe("EUR");
    const order: Item = {
      ...booking,
      type: "order",
      state: "received",
      subject: null,
      payload: {
        orderedItem: [
          { name: "Tyre", quantity: 2, price: { value: 3920, currency: "EUR" } },
          { name: "Tube", quantity: 1, price: { value: 500, currency: "EUR" } },
        ],
        totalPrice: { value: 8340, currency: "EUR" },
      },
    };
    expect(titleFor(order)).toBe("Order");
    expect(snippetFor(order, undefined, "en")).toBe("2 lines · €83.40");
  });

  it("truncates on one line and joins addresses", () => {
    expect(truncate("a  long\n\nmessage", 20)).toBe("a long message");
    expect(truncate("x".repeat(30), 10)).toBe("xxxxxxxxx…");
    expect(
      formatAddress({
        streetAddress: "Rua A 1",
        postalCode: "1000-001",
        addressLocality: "Lisboa",
        addressCountry: "PT",
      }),
    ).toBe("Rua A 1, 1000-001 Lisboa, PT");
    expect(formatAddress(undefined)).toBe("");
  });
});

describe("client party words", () => {
  it("names who is asking and keys days to the business time zone", () => {
    expect(partyName({ id: "p", name: "Rita Amaral", kind: "human", verified: false })).toBe("Rita Amaral");
    expect(partyName({ id: "p", name: null, kind: "human", email: "rita@example.com", verified: false })).toBe(
      "rita@example.com",
    );
    expect(partyName({ id: "p", name: null, kind: "agent", verified: true })).toBe("An agent");
    expect(partyName(undefined)).toBe("Someone");
    expect(
      rowTitle({
        item: booking,
        transitions: [],
        human: "",
        party: { id: "p", name: "Rita Amaral", kind: "human", verified: true },
      }),
    ).toBe("Rita Amaral · Full service, city bike");
    expect(rowTitle({ item: { ...booking, subject: null }, transitions: [], human: "" })).toBe("Someone · Booking");
    expect(localDateKey("2026-09-23T09:00:00Z", "Europe/Lisbon")).toBe("2026-09-23");
    expect(localDateKey("2026-09-23T23:30:00Z", "Europe/Lisbon")).toBe("2026-09-24");
  });
});

describe("who is asking (ADR-017 §8.2)", () => {
  const base = {
    match: null,
    possible: null,
    known: false,
    history: {
      items: 0,
      completed: 0,
      paid: 0,
      no_shows: 0,
      late_cancellations: 0,
      payment_failed: 0,
      charged_back: 0,
      largest_paid: 0,
      open_bookings: 0,
      first_seen: null,
      last_seen: null,
    },
    persons: [],
    agent: { level: "none", platform: null },
    networks_off: null,
  };

  it("says nothing more than the party for an item from before, or a stranger", () => {
    expect(customerNotes(undefined, "EUR")).toEqual([]);
    expect(customerNotes(base, "EUR")).toEqual([]);
  });

  it("names the customer a weak match may be, unconfirmed", () => {
    expect(customerNotes({ ...base, match: "weak", possible: { party_id: "p", name: "Ana Silva" } }, "EUR")).toEqual([
      { tone: "warning", text: "May be Ana Silva, unconfirmed" },
    ]);
  });

  const trusted = {
    network: "https://network.surfingdog.ai",
    tier: "trusted" as const,
    score: 0.81,
    kept: 6,
    broken: 1,
    businesses: 3,
    email_proven: true,
    since: "2026-03-14T09:00:00Z",
    unusual_use: false,
    seen: "this_item" as const,
    as_of: "2026-09-21T10:00:00Z",
  };

  it("says a customer you know with the history that says so, and the agent", () => {
    const notes = customerNotes(
      {
        ...base,
        match: "strong",
        known: true,
        history: { ...base.history, items: 4, completed: 3, no_shows: 1, largest_paid: 4200 },
        persons: [trusted],
        agent: { level: "vouched", platform: "https://agents.example.net" },
      },
      "EUR",
      "en-GB",
    );
    expect(notes).toEqual([
      { tone: "success", text: "A customer you know: 3 completed, 1 no-show, largest paid €42.00" },
      { tone: "neutral", text: "Signed agent of agents.example.net" },
    ]);
    // A platform's key no network the business uses recognises is signed, and nothing more.
    expect(customerNotes({ ...base, agent: { level: "self", platform: "https://agents.example.net" } }, "EUR")).toEqual(
      [
        {
          tone: "neutral",
          text: "Signed agent (key from agents.example.net, a platform your networks do not recognise)",
        },
      ],
    );
  });

  it("says, per network that knows the person, their standing there in plain words", () => {
    expect(personStandings(undefined)).toEqual([]);
    const rows = personStandings(
      {
        ...base,
        persons: [
          trusted,
          {
            ...trusted,
            network: "https://people.example.org",
            tier: "new",
            score: 0,
            kept: 0,
            broken: 0,
            businesses: 0,
            email_proven: false,
            since: null,
            unusual_use: true,
            seen: "earlier",
            as_of: "2026-09-12T08:30:00Z",
          },
        ],
      },
      "en-GB",
      "UTC",
    );
    expect(rows).toEqual([
      {
        network: "network.surfingdog.ai",
        tier: "Trusted",
        tone: "success",
        text: "6 kept, 1 broken, at 3 businesses. Known there since March 2026; address proven.",
        when: "With this request",
        caution: null,
      },
      {
        network: "people.example.org",
        tier: "New",
        tone: "neutral",
        text: "No record there yet.",
        when: `As last presented, ${formatDateTime("2026-09-12T08:30:00Z", "UTC", "en-GB")}`,
        caution:
          "Their pass was used at many businesses in a day, or by two assistants' keys. It still works; the person can replace it.",
      },
    ]);
  });
});

describe("what became of an email", () => {
  it("never says sent before the mail service took it, and says why one was not", () => {
    const d = (status: string, extra: Partial<Parameters<typeof deliveryWord>[0]> = {}) =>
      deliveryWord({ status, sent_at: null, last_error: null, skip_reason: null, ...extra }, "UTC");
    expect(d("queued")).toBe("Sending…");
    expect(d("sent", { sent_at: "2026-09-21T10:02:00Z" })).toBe(
      `Sent ${formatDateTime("2026-09-21T10:02:00Z", "UTC")}`,
    );
    expect(d("retrying", { last_error: "550 mailbox unavailable" })).toBe(
      "Not sent yet: 550 mailbox unavailable. We keep trying.",
    );
    expect(d("failed", { last_error: "550 mailbox unavailable" })).toBe("Not sent: 550 mailbox unavailable");
    expect(d("skipped", { skip_reason: "no_address" })).toBe("Not sent: no email address");
    expect(d("skipped", { skip_reason: "test_item" })).toBe("Not sent: test item");
    // An instance with no mail service wrote it to its log: nobody got it.
    expect(d("skipped", { skip_reason: "no_service" })).toBe("Not sent: this inbox has no mail service set up");
    // The day's acknowledgements to one address were used: held back, and shown so.
    expect(d("skipped", { skip_reason: "ack_limit" })).toBe("Not sent: this address already had 3 of these today");
    expect(mailWord({ template: "ack.booking", recipient: "customer" })).toBe("We have your request");
    expect(mailWord({ template: "booking.proposed", recipient: "customer" })).toBe("Another time");
    expect(mailWord({ template: "order.paid", recipient: "customer" })).toBe("About their order");
    expect(mailWord({ template: "owner.create", recipient: "owner" })).toBe("To you");
  });
});

describe("email that does not go out, and customers who stopped the networks", () => {
  it("says in Settings what stops emails reaching customers, and nothing when all is well", () => {
    expect(mailBannerLines(undefined)).toEqual([]);
    expect(mailBannerLines({ service: true, sender: true, links: true })).toEqual([]);
    const none = mailBannerLines({ service: false, sender: true, links: true });
    expect(none).toHaveLength(1);
    expect(none[0]).toMatch(/^Emails are not being sent: this inbox has no mail service set up/);
    expect(mailBannerLines({ service: true, sender: false, links: false })).toEqual([
      "Emails are not being sent: there is no address to send them from. Fill in Send from below.",
      "Emails carry no Accept or Decline links: set INBOX_SECRET_KEY and the public address of this inbox. Customers can still answer by replying.",
    ]);
  });

  it("says who stopped the networks, and what each one already had", () => {
    const base = {
      match: null,
      possible: null,
      known: false,
      history: {
        items: 0,
        completed: 0,
        paid: 0,
        no_shows: 0,
        late_cancellations: 0,
        payment_failed: 0,
        charged_back: 0,
        largest_paid: 0,
        open_bookings: 0,
        first_seen: null,
        last_seen: null,
      },
      persons: [],
      agent: { level: "none", platform: null },
      networks_off: null,
    };
    expect(networksOffWords(base, "UTC")).toBeNull();
    const words = networksOffWords(
      {
        ...base,
        networks_off: {
          since: "2026-09-22T10:04:00Z",
          via: "customer",
          networks: [{ network: "https://net.example.com", receipts: 2, open_promises: 1, person: true }],
        },
      },
      "UTC",
    );
    expect(words?.headline).toBe(
      `The customer switched them off, from the link in their code email, ${formatDateTime("2026-09-22T10:04:00Z", "UTC")}. Nothing more about them goes to any network, and no network's standing is read.`,
    );
    expect(words?.networks).toEqual([
      {
        network: "net.example.com",
        text: "Already had 2 receipts and knows their person. It cannot yet be asked to erase them.",
        caution: "1 promise of theirs stays open there: it counts it as unclosed 9 days after it was due.",
      },
    ]);
  });
});

describe("the business's languages", () => {
  it("keeps every other language beside the one customers' emails are in, whichever that is", () => {
    expect(emailLangOf(["es", "pt-PT", "en"])).toBe("pt");
    expect(emailLangOf(["fr"])).toBe("en");
    // Spanish and French are languages too, not English because emails can only be in English.
    expect(otherLanguages(["en", "es", "fr"], "en")).toEqual(["es", "fr"]);
    expect(otherLanguages(["pt", "pt-BR", "en", "es"], "pt")).toEqual(["en", "es"]);
    expect(otherLanguages(["", " es ", "ES", "en-GB"], "en")).toEqual(["es"]);
  });
});
