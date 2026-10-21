import { checkStayTotals } from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import { quoteFromRates } from "../src/stays/price";
import type { FeeRow, PropertySetup, RatePlanRow, RoomTypeRow } from "../src/stays/store";

/**
 * A stay's price from the property's own rates (ADR-033 §5.1–§5.2), pure: seasons, weekends, extra
 * guests, children free under an age, a derived plan's discount, extras, every fee basis with tiers,
 * caps and child exemptions, prices that include a tax, each line rounded half up to the currency's own
 * minor unit, the lines adding up to the total and the schedule too. Real tax rates are the property's
 * own; these are the example properties'.
 */
const NOW = Date.parse("2026-11-02T01:00:00Z");

function setup(o: {
  currency: string;
  timezone: string;
  rooms?: Partial<RoomTypeRow>[];
  plans?: Partial<RatePlanRow>[];
  rates?: PropertySetup["rates"];
  fees?: Partial<FeeRow>[];
  extras?: PropertySetup["extras"];
  freeUnder?: number;
  pricesInclude?: { name: string; rateBp: number } | null;
}): PropertySetup {
  const room = (r: Partial<RoomTypeRow>, i: number): RoomTypeRow => ({
    id: `room${i}`,
    propertyId: "p",
    name: `Room ${i}`,
    description: null,
    units: 3,
    capacity: { adults: 3, children: 2, total: 4 },
    beds: [],
    sizeM2: null,
    amenities: [],
    accessible: false,
    photos: [],
    externalId: null,
    offered: true,
    active: true,
    sort: i,
    ...r,
  });
  const plan = (p: Partial<RatePlanRow>, i: number): RatePlanRow => ({
    id: `plan${i}`,
    propertyId: "p",
    name: `Plan ${i}`,
    meal: "room_only",
    policyId: "pol",
    policy: {
      steps: [{ before: { days: 3 }, fee: { kind: "none" } }],
      after: { kind: "units", value: 1 },
      noShow: { kind: "full" },
    },
    policyPreset: "free_until:3",
    deposit: { kind: "none" },
    balance: { when: "at_property" },
    guarantee: "none",
    roomTypeIds: null,
    derived: null,
    minNights: 1,
    maxNights: null,
    externalId: null,
    offered: true,
    active: true,
    sort: i,
    ...p,
  });
  const fee = (f: Partial<FeeRow>, i: number): FeeRow => ({
    id: `fee${i}`,
    name: `Fee ${i}`,
    kind: "fee",
    basis: "per_stay",
    amount: null,
    rateBp: null,
    tiers: null,
    collected: "with_booking",
    childExemptUnder: null,
    maxNights: null,
    active: true,
    ...f,
  });
  return {
    property: {
      id: "p",
      locationId: "l",
      kind: "hotel",
      name: "Test property",
      currency: o.currency,
      timezone: o.timezone,
      checkInFrom: "15:00",
      checkInUntil: null,
      checkOutUntil: "11:00",
      mode: "request",
      instant: false,
      freshMinutes: 15,
      answerHours: 12,
      quoteValidHours: 24,
      payWithinHours: 24,
      holdMinutes: 20,
      maxNights: 30,
      sameDayUntil: null,
      children: { welcome: true, ...(o.freeUnder !== undefined ? { freeUnder: o.freeUnder } : {}) },
      pets: { allowed: "no" },
      houseRules: { chips: [] },
      arrivalPublic: null,
      hasArrivalPrivate: false,
      preArrivalText: null,
      registration: null,
      pricesInclude: o.pricesInclude ?? null,
      connectorId: null,
      externalId: null,
      active: true,
      locality: null,
    },
    rooms: (o.rooms ?? [{}]).map(room),
    plans: (o.plans ?? [{}]).map(plan),
    rates: o.rates ?? [],
    fees: (o.fees ?? []).map(fee),
    extras: o.extras ?? [],
    allotments: [],
    closures: [],
  };
}

const base = (nightly: number, extra: Partial<PropertySetup["rates"][number]> = {}) => ({
  ratePlanId: "plan0",
  roomTypeId: "room0",
  fromDate: "",
  toDate: "",
  weekdays: 127,
  nightly,
  baseGuests: 2,
  extraAdult: null,
  extraChild: null,
  minNights: null,
  ...extra,
});

const priced = (
  s: PropertySetup,
  checkIn: string,
  checkOut: string,
  rooms = [
    {
      roomTypeId: "room0",
      adults: 2,
      childrenAges: [] as number[],
      extras: [] as { extraId: string; quantity: number }[],
    },
  ],
) => {
  const r = quoteFromRates(s, { checkIn, checkOut, rooms, lang: "en", now: NOW, source: "rates" });
  if (!r.ok) throw new Error(r.reason);
  // Whatever it gives holds together, as an agent checks it.
  expect(checkStayTotals(r.quote, { now: NOW })).toEqual([]);
  return r.quote;
};

describe("a stay's price from the rates", () => {
  it("Ryokan Hoshi in yen: the worked example, deposit the first night, the city tax at the property", () => {
    const s = setup({
      currency: "JPY",
      timezone: "Asia/Tokyo",
      plans: [{ deposit: { kind: "first_night" }, meal: "breakfast" }],
      rates: [base(25_800)],
      fees: [
        { name: "Service charge", basis: "percent_of_room", rateBp: 1_000 },
        { name: "Accommodation tax", kind: "tax", basis: "per_person_night", amount: 400, collected: "at_property" },
      ],
      extras: [
        { id: "late", item: "late_checkout", name: "Late check-out", price: 3_000, basis: "per_stay", active: true },
      ],
      pricesInclude: { name: "consumption tax", rateBp: 1_000 },
    });
    const q = priced(s, "2026-12-12", "2026-12-15", [
      { roomTypeId: "room0", adults: 2, childrenAges: [], extras: [{ extraId: "late", quantity: 1 }] },
    ]);
    expect(q.lines.map((l) => [l.type, l.label, l.amount, l.collected])).toEqual([
      ["subtotal", "Room 0, 3 nights (includes 10% consumption tax)", 77_400, "with_booking"],
      ["extra", "Late check-out", 3_000, "with_booking"],
      ["fee", "Service charge 10%", 7_740, "with_booking"],
      [
        "tax",
        expect.stringMatching(/^Accommodation tax, (JP)?¥400 per guest per night \(paid at the property\)$/),
        2_400,
        "at_property",
      ],
    ]);
    expect(q.total).toEqual({ value: 90_540, currency: "JPY" });
    expect(q.schedule.map((x) => [x.id, x.type, x.amount.value])).toEqual([
      ["deposit", "immediate", 25_800],
      ["at_property", "at_property", 64_740],
    ]);
    expect(q.includes).toEqual(["Breakfast for 2"]);
  });

  it("takes a season over the base, a weekend over the week, and extra adults and paying children", () => {
    const s = setup({
      currency: "INR",
      timezone: "Asia/Kolkata",
      freeUnder: 6,
      rates: [
        base(800_000, { extraAdult: 150_000, extraChild: 90_000 }),
        // Friday and Saturday (16 + 32).
        base(950_000, { weekdays: 48, extraAdult: 150_000, extraChild: 90_000 }),
        base(1_200_000, { fromDate: "2027-01-01", toDate: "2027-01-02", extraAdult: 150_000, extraChild: 90_000 }),
      ],
    });
    // Thu 31 Dec, Fri 1 Jan (season), Sat 2 Jan (season): 3 adults, a 4-year-old (free) and an 8-year-old.
    const q = priced(s, "2026-12-31", "2027-01-03", [
      { roomTypeId: "room0", adults: 3, childrenAges: [4, 8], extras: [] },
    ]);
    const nights = q.lines[0]?.nights?.map((n) => n.amount);
    expect(nights).toEqual([800_000 + 150_000 + 90_000, 1_200_000 + 150_000 + 90_000, 1_200_000 + 150_000 + 90_000]);
  });

  it("prices a weekend night outside any season at the weekend rate, whatever order the rows come in", () => {
    const every = base(800_000);
    // Friday and Saturday (16 + 32).
    const weekend = base(950_000, { weekdays: 48 });
    const winter = base(700_000, { fromDate: "2027-02-01", toDate: "2027-02-28" });
    const winterWeekend = base(820_000, { fromDate: "2027-02-01", toDate: "2027-02-28", weekdays: 48 });
    for (const rates of [
      [every, weekend, winter, winterWeekend],
      [weekend, every, winterWeekend, winter],
    ]) {
      const s = setup({ currency: "INR", timezone: "Asia/Kolkata", rates });
      // Thu 14, Fri 15, Sat 16 Jan 2027: no season; then Thu 4, Fri 5 Feb 2027 in the winter season.
      expect(priced(s, "2027-01-14", "2027-01-17").lines[0]?.nights?.map((n) => n.amount)).toEqual([
        800_000, 950_000, 950_000,
      ]);
      expect(priced(s, "2027-02-04", "2027-02-06").lines[0]?.nights?.map((n) => n.amount)).toEqual([700_000, 820_000]);
    }
  });

  it("gives a derived plan's percent off night by night, rounded half up in the currency's own unit", () => {
    const s = setup({
      currency: "MXN",
      timezone: "America/Mexico_City",
      plans: [
        {},
        {
          name: "Non-refundable",
          derived: { fromPlanId: "plan0", percentOff: 10 },
          policy: { steps: [], after: { kind: "full" }, noShow: { kind: "full" } },
        },
      ],
      rates: [base(189_995)],
    });
    const r = quoteFromRates(s, {
      checkIn: "2027-02-01",
      checkOut: "2027-02-03",
      rooms: [{ roomTypeId: "room0", ratePlanId: "plan1", adults: 2, childrenAges: [], extras: [] }],
      lang: "es",
      now: NOW,
      source: "rates",
    });
    if (!r.ok) throw new Error(r.reason);
    // 90% of 1,899.95 is 1,709.955: half up to 1,709.96.
    expect(r.quote.lines[0]?.nights?.map((n) => n.amount)).toEqual([170_996, 170_996]);
    expect(r.quote.ratePlan.refundable).toBe(false);
  });

  it("charges every basis of fee, with tiers on the nightly price per guest, caps and children exempt", () => {
    const s = setup({
      currency: "EUR",
      timezone: "Europe/Vienna",
      rates: [base(6_000, { baseGuests: 1, extraAdult: 3_000, extraChild: 2_000 })],
      fees: [
        { name: "Cleaning", basis: "per_stay", amount: 2_500 },
        { name: "Linen", basis: "per_night", amount: 300 },
        { name: "Bed tax", kind: "tax", basis: "per_room_night", amount: 150, maxNights: 2 },
        {
          name: "City tax",
          kind: "tax",
          basis: "per_person_night",
          tiers: [
            { upToNightly: 4_000, amount: 200 },
            { upToNightly: null, rateBp: 500 },
          ],
          childExemptUnder: 15,
          collected: "at_property",
        },
        { name: "Resort fee", basis: "percent_of_room", rateBp: 333 },
      ],
    });
    // Two adults and a 10-year-old for 3 nights: 6,000 + 3,000 + 2,000 = 11,000 a night.
    const q = priced(s, "2027-02-10", "2027-02-13", [
      { roomTypeId: "room0", adults: 2, childrenAges: [10], extras: [] },
    ]);
    const by = Object.fromEntries(q.lines.map((l) => [l.label.split(",")[0]?.split(" (")[0], l.amount]));
    expect(by["Room 0"]).toBe(33_000);
    expect(by.Cleaning).toBe(2_500);
    expect(by.Linen).toBe(900);
    expect(by["Bed tax"]).toBe(300);
    // 11,000 / 3 guests = 3,666 a guest a night: the first tier; the child is exempt: 2 × 200 × 3.
    expect(by["City tax"]).toBe(1_200);
    // 3.33% of 33,000 = 1,098.9: half up to 1,099.
    expect(by["Resort fee 3.33%"]).toBe(1_099);
    expect(q.total.value).toBe(33_000 + 2_500 + 900 + 300 + 1_200 + 1_099);
  });

  it("prices Dar Al Bahr in fils (three decimals): 30% now, the rest at the property, adding up", () => {
    const s = setup({
      currency: "KWD",
      timezone: "Asia/Kuwait",
      plans: [{ deposit: { kind: "percent", value: 30 } }],
      rates: [base(45_750)],
      fees: [{ name: "Service", basis: "percent_of_room", rateBp: 500 }],
    });
    const q = priced(s, "2027-02-20", "2027-02-22");
    expect(q.total).toEqual({ value: 91_500 + 4_575, currency: "KWD" });
    const deposit = q.schedule.find((x) => x.id === "deposit")?.amount.value ?? 0;
    expect(deposit).toBe(28_823);
    expect(q.schedule.reduce((a, x) => a + x.amount.value, 0)).toBe(q.total.value);
  });

  it("says why a stay cannot be priced: no rate for a night, too short, a room that is not the property's", () => {
    const s = setup({
      currency: "AUD",
      timezone: "Australia/Hobart",
      plans: [{ minNights: 2 }],
      rates: [base(21_000, { fromDate: "2027-03-01", toDate: "2027-03-01" })],
    });
    const r = (checkIn: string, checkOut: string, roomTypeId = "room0") =>
      quoteFromRates(s, {
        checkIn,
        checkOut,
        rooms: [{ roomTypeId, adults: 2, childrenAges: [], extras: [] }],
        lang: "en",
        now: NOW,
        source: "rates",
      });
    expect(r("2027-03-01", "2027-03-02")).toMatchObject({ ok: false, code: "too_short" });
    expect(r("2027-03-01", "2027-03-03")).toMatchObject({ ok: false, code: "no_price" });
    expect(r("2027-03-01", "2027-03-03", "nope")).toMatchObject({ ok: false, code: "no_room" });
  });

  it("asks the balance a week ahead as its own entry, and takes it now when that date has passed", () => {
    const s = setup({
      currency: "CAD",
      timezone: "America/Halifax",
      plans: [{ deposit: { kind: "percent", value: 20 }, balance: { when: "days_before", days: 7 } }],
      rates: [base(18_900)],
    });
    const later = priced(s, "2026-12-20", "2026-12-22");
    expect(later.schedule.map((x) => [x.id, x.type, x.amount.value, x.dueAt ?? null])).toEqual([
      ["deposit", "immediate", 7_560, null],
      ["balance", "deferred", 30_240, "2026-12-13T10:00:00-04:00"],
    ]);
    const soon = priced(s, "2026-11-05", "2026-11-07");
    expect(soon.schedule.map((x) => [x.id, x.amount.value])).toEqual([["deposit", 37_800]]);
  });
});
