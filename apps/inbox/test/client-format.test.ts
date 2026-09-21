import { describe, expect, it } from "vitest";
import {
  currencyOf,
  formatAddress,
  formatMoney,
  formatWhen,
  localDateKey,
  partyName,
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

describe("client format", () => {
  it("says states in words with a tone", () => {
    expect(stateWord("needs_info")).toBe("Needs info");
    expect(stateWord("cancelled_by_customer")).toBe("Cancelled by customer");
    expect(stateWord("requested")).toBe("Requested");
    expect(stateTone("confirmed")).toBe("success");
    expect(stateTone("needs_info")).toBe("warning");
    expect(stateTone("declined")).toBe("danger");
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
