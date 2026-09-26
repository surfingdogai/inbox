import { describe, expect, it } from "vitest";
import { easter, holidays, lawOf, workingDay } from "../src/negotiation/holidays";
import { classifyReturn, owedForLines, paidFor, refundDueOf } from "../src/negotiation/refunds";
import {
  exceptionOf,
  localDay,
  type PeriodInput,
  periodEnd,
  startOfDay,
  withdrawalRight,
  withdrawalUntil,
} from "../src/negotiation/withdrawal";

/**
 * The right of withdrawal as pure functions (ADR-018 §7): the period counted as Regulation 1182/71
 * counts it — the first day not counted, an end on a weekend or a public holiday moved to the next
 * working day, in the business's zone — for goods from delivery and for a service from the booking,
 * and whether the right runs for a booking or an order as it stands. Runs on Node and in workerd,
 * whose Intl data differ.
 */
const DAY = 86_400_000;
const LISBON = "Europe/Lisbon";
const LONDON = "Europe/London";
const end = (date: string, tz: string) => startOfDay(date, tz) + DAY - 1;
const at = (iso: string) => Date.parse(iso);

describe("the law a business sells under", () => {
  it("is Portugal's, the UK's, or the EU's", () => {
    expect(lawOf("PT")).toBe("pt");
    expect(lawOf("pt")).toBe("pt");
    expect(lawOf("GB")).toBe("uk");
    expect(lawOf("UK")).toBe("uk");
    expect(lawOf("ES")).toBe("eu");
    expect(lawOf("")).toBe("eu");
    expect(lawOf(undefined)).toBe("eu");
  });
});

describe("public holidays", () => {
  it("find Easter by the Gregorian computus", () => {
    expect(["2026", "2027", "2028", "2029", "2030"].map((y) => easter(Number(y)))).toEqual([
      "2026-04-05",
      "2027-03-28",
      "2028-04-16",
      "2029-04-01",
      "2030-04-21",
    ]);
  });

  it("are Portugal's national holidays, Good Friday and Corpus Christi included", () => {
    const pt = holidays(2026, "pt");
    for (const d of [
      "2026-01-01",
      "2026-04-03",
      "2026-04-05",
      "2026-04-25",
      "2026-05-01",
      "2026-06-04",
      "2026-06-10",
      "2026-08-15",
      "2026-10-05",
      "2026-11-01",
      "2026-12-01",
      "2026-12-08",
      "2026-12-25",
    ]) {
      expect(pt.has(d), d).toBe(true);
    }
    expect(pt.size).toBe(13);
    expect(holidays(2027, "pt").has("2027-05-27")).toBe(true); // Corpus Christi 2027
  });

  it("are England and Wales's bank holidays, moved off the weekend", () => {
    expect([...holidays(2026, "uk")].sort()).toEqual([
      "2026-01-01",
      "2026-04-03",
      "2026-04-06",
      "2026-05-04",
      "2026-05-25",
      "2026-08-31",
      "2026-12-25",
      "2026-12-28",
    ]);
    // Christmas on a Saturday: Monday and Tuesday. On a Sunday: Monday and Tuesday too.
    expect(holidays(2027, "uk").has("2027-12-27")).toBe(true);
    expect(holidays(2027, "uk").has("2027-12-28")).toBe(true);
    expect(holidays(2022, "uk").has("2022-12-26")).toBe(true);
    expect(holidays(2022, "uk").has("2022-12-27")).toBe(true);
    // New Year's Day on a Saturday: the Monday after.
    expect(holidays(2028, "uk").has("2028-01-03")).toBe(true);
  });

  it("are none of the EU's at large: only weekends move a period's end there", () => {
    expect(holidays(2026, "eu").size).toBe(0);
    expect(workingDay("2026-06-10", "eu")).toBe(true);
    expect(workingDay("2026-06-10", "pt")).toBe(false);
    expect(workingDay("2026-09-26", "eu")).toBe(false); // a Saturday
  });
});

describe("the period", () => {
  it("does not count its first day, and ends at the end of the last one in the business's zone", () => {
    // Delivered on Wednesday 23 September 2026 at 18:00 in Lisbon (17:00 UTC): 14 days is Wednesday 7 October.
    const from = at("2026-09-23T17:00:00Z");
    expect(localDay(from, LISBON)).toBe("2026-09-23");
    expect(periodEnd(from, 14, "eu", LISBON)).toBe(end("2026-10-07", LISBON));
    expect(new Date(periodEnd(from, 14, "eu", LISBON)).toISOString()).toBe("2026-10-07T22:59:59.999Z");
    // The same instant is already the 24th in Tokyo: the period ends a day later there.
    expect(periodEnd(from, 14, "eu", "Asia/Tokyo")).toBe(end("2026-10-08", "Asia/Tokyo"));
  });

  it("ending on a weekend, runs to the end of the next working day", () => {
    // From Saturday 26 September: 14 days is Saturday 10 October, so Monday 12 October.
    expect(periodEnd(at("2026-09-26T10:00:00Z"), 14, "eu", LISBON)).toBe(end("2026-10-12", LISBON));
  });

  it("ending on a public holiday, runs past it where that law keeps it", () => {
    // From Wednesday 27 May 2026: 14 days is Wednesday 10 June, Portugal Day.
    const from = at("2026-05-27T09:00:00Z");
    expect(periodEnd(from, 14, "eu", LISBON)).toBe(end("2026-06-10", LISBON));
    expect(periodEnd(from, 14, "pt", LISBON)).toBe(end("2026-06-11", LISBON));
    // From Friday 18 December 2026 in London: 14 days is Friday 1 January, then the weekend: Monday 4.
    expect(periodEnd(at("2026-12-18T10:00:00Z"), 14, "uk", LONDON)).toBe(end("2027-01-04", LONDON));
  });

  it("keeps the business's local day across a change of clocks", () => {
    // Lisbon leaves summer time on Sunday 25 October 2026: the day after, midnight is 00:00 UTC.
    expect(new Date(startOfDay("2026-10-26", LISBON)).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(new Date(startOfDay("2026-10-24", LISBON)).toISOString()).toBe("2026-10-23T23:00:00.000Z");
    expect(new Date(periodEnd(at("2026-10-12T12:00:00Z"), 14, "eu", LISBON)).toISOString()).toBe(
      "2026-10-26T23:59:59.999Z",
    );
  });
});

describe("until when the customer may withdraw", () => {
  const base: PeriodInput = {
    kind: "goods",
    concludedAt: at("2026-09-21T10:00:00Z"),
    days: 14,
    assumedTransitDays: 7,
    law: "eu",
    timezone: LISBON,
  };

  it("runs from delivery for goods, and has not begun before it", () => {
    expect(withdrawalUntil(base)).toBeNull();
    expect(withdrawalUntil({ ...base, deliveredAt: at("2026-09-23T17:00:00Z") })).toBe(end("2026-10-07", LISBON));
  });

  it("with no delivery recorded, runs from when they were sent plus the transit days", () => {
    // Sent on Tuesday 22 September; taken to arrive a week later, on the 29th; 14 days on, 13 October.
    expect(withdrawalUntil({ ...base, fulfilledAt: at("2026-09-22T10:00:00Z") })).toBe(end("2026-10-13", LISBON));
  });

  it("runs from the booking for a service", () => {
    expect(withdrawalUntil({ ...base, kind: "service" })).toBe(end("2026-10-05", LISBON));
  });

  it("is the business's longer policy when it gives one, and 12 months longer when the customer was not told", () => {
    const delivered = { ...base, deliveredAt: at("2026-09-23T17:00:00Z") };
    expect(withdrawalUntil({ ...delivered, days: 30 })).toBe(end("2026-10-23", LISBON));
    expect(withdrawalUntil({ ...delivered, informed: false })).toBe(end("2027-10-07", LISBON));
  });
});

describe("whether the customer may withdraw now", () => {
  const period: PeriodInput = {
    kind: "goods",
    concludedAt: at("2026-09-21T10:00:00Z"),
    days: 14,
    assumedTransitDays: 7,
    law: "eu",
    timezone: LISBON,
  };
  const order = (state: string, extra: Partial<Parameters<typeof withdrawalRight>[0]> = {}) =>
    withdrawalRight({
      type: "order",
      state,
      consumer: true,
      flags: ["standard"],
      paid: true,
      period,
      now: at("2026-09-25T10:00:00Z"),
      ...extra,
    });

  it("from an order agreed and not sent yet, whatever the date", () => {
    for (const state of ["accepted", "awaiting_payment", "payment_failed", "paid", "fulfilling"]) {
      expect(order(state), state).toEqual({ available: true, until: null });
    }
    expect(order("paid", { now: at("2027-01-01T00:00:00Z") }).available).toBe(true);
  });

  it("from an order sent, within the period from delivery, and not after it", () => {
    const delivered = { ...period, deliveredAt: at("2026-09-23T17:00:00Z") };
    expect(order("fulfilled", { period: delivered })).toEqual({ available: true, until: end("2026-10-07", LISBON) });
    expect(order("completed", { period: delivered, now: end("2026-10-07", LISBON) }).available).toBe(true);
    expect(order("fulfilled", { period: delivered, now: end("2026-10-07", LISBON) + 1 })).toMatchObject({
      available: false,
      why: "lapsed",
    });
  });

  it("from nothing that is not agreed, excepted, or sold to a business", () => {
    for (const state of ["received", "needs_info", "proposed", "cancelled", "declined", "charged_back"]) {
      expect(order(state), state).toMatchObject({ available: false, why: "not_agreed" });
    }
    expect(order("paid", { flags: ["standard", "perishable"] })).toMatchObject({
      available: false,
      why: "excepted",
      exception: "perishable",
    });
    expect(order("paid", { consumer: false })).toMatchObject({ available: false, why: "business_customer" });
  });

  it("from a booking only once paid, and before it starts, for the period from booking", () => {
    const booking = (extra: Partial<Parameters<typeof withdrawalRight>[0]> = {}) =>
      withdrawalRight({
        type: "booking",
        state: "confirmed",
        consumer: true,
        flags: ["standard"],
        paid: true,
        startTime: at("2026-10-20T10:00:00Z"),
        period: { ...period, kind: "service" },
        now: at("2026-09-25T10:00:00Z"),
        ...extra,
      });
    expect(booking()).toEqual({ available: true, until: end("2026-10-05", LISBON) });
    expect(booking({ paid: false })).toMatchObject({ available: false, why: "not_paid" });
    expect(booking({ startTime: at("2026-09-25T09:00:00Z") })).toMatchObject({ available: false, why: "started" });
    expect(booking({ flags: ["dated_leisure"] })).toMatchObject({ available: false, why: "excepted" });
    expect(booking({ now: at("2026-10-06T10:00:00Z") })).toMatchObject({ available: false, why: "lapsed" });
    expect(booking({ state: "requested" })).toMatchObject({ available: false, why: "not_agreed" });
  });

  it("names the first exception among the lines", () => {
    expect(exceptionOf(["standard", "standard"])).toBeNull();
    expect(exceptionOf([undefined, "standard", "sealed_hygiene", "perishable"])).toBe("sealed_hygiene");
  });
});

describe("what a return owes, and when", () => {
  const order = {
    orderedItem: [
      { quantity: 2, price: { value: 1850, currency: "EUR" } },
      { quantity: 1, price: { value: 900, currency: "EUR" } },
    ],
    totalPrice: { value: 4600, currency: "EUR" },
  };

  it("is what was paid for the lines that come back, never more than was paid", () => {
    expect(owedForLines(order, undefined)).toEqual({ value: 4600, currency: "EUR" });
    expect(owedForLines(order, [{ index: 0, quantity: 1 }])).toEqual({ value: 1850, currency: "EUR" });
    expect(
      owedForLines(order, [
        { index: 0, quantity: 1 },
        { index: 0, quantity: 1 },
        { index: 1, quantity: 1 },
      ]),
    ).toEqual({ value: 4600, currency: "EUR" });
    expect(owedForLines(order, [{ index: 0, quantity: 3 }])).toBeNull();
    expect(owedForLines(order, [{ index: 5, quantity: 1 }])).toBeNull();
    expect(owedForLines({ ...order, paidAmount: { value: 3000, currency: "EUR" } }, undefined)).toEqual({
      value: 3000,
      currency: "EUR",
    });
  });

  it("was paid when a payment says so, or a reference was recorded against the total", () => {
    expect(paidFor({ totalPrice: order.totalPrice })).toBeNull();
    expect(paidFor({ totalPrice: order.totalPrice, paymentRef: "pi_1" })).toEqual(order.totalPrice);
    expect(paidFor({ paidAmount: { value: 1000, currency: "EUR" } })).toEqual({ value: 1000, currency: "EUR" });
  });

  it("is due 14 days after a withdrawal's notice, or after the goods when they come later", () => {
    const notice = at("2026-10-01T10:00:00Z");
    expect(refundDueOf({ kind: "withdrawal", noticeAt: notice, refundDays: 14 })).toBeNull();
    expect(refundDueOf({ kind: "withdrawal", noticeAt: notice, settledAt: notice, refundDays: 14 })).toBe(
      notice + 14 * DAY,
    );
    expect(refundDueOf({ kind: "withdrawal", noticeAt: notice, evidenceAt: notice + 2 * DAY, refundDays: 14 })).toBe(
      notice + 14 * DAY,
    );
    expect(refundDueOf({ kind: "withdrawal", noticeAt: notice, evidenceAt: notice + 20 * DAY, refundDays: 14 })).toBe(
      notice + 23 * DAY,
    );
  });

  it("is due the business's refund days after nothing more has to come back, for anything else", () => {
    const t = at("2026-10-01T10:00:00Z");
    expect(refundDueOf({ kind: "policy", refundDays: 7 })).toBeNull();
    expect(refundDueOf({ kind: "policy", settledAt: t, refundDays: 7 })).toBe(t + 7 * DAY);
    expect(refundDueOf({ kind: "faulty", evidenceAt: t, refundDays: 5 })).toBe(t + 5 * DAY);
    expect(refundDueOf({ kind: "cancellation", settledAt: t, refundDays: 14 })).toBe(t + 14 * DAY);
  });

  it("is faulty goods, a withdrawal while the period runs, or the business's policy", () => {
    for (const reason of ["faulty", "not_as_described", "wrong_item"]) {
      expect(classifyReturn(reason, true)).toBe("faulty");
      expect(classifyReturn(reason, false)).toBe("faulty");
    }
    expect(classifyReturn("changed_mind", true)).toBe("withdrawal");
    expect(classifyReturn("changed_mind", false)).toBe("policy");
    expect(classifyReturn("other", true)).toBe("withdrawal");
  });
});
