import {
  checkStayTotals,
  fillStayTemplate,
  type Policy,
  readDoorsElsewhere,
  type StayQuote,
  stayPolicySteps,
} from "@surfingdog/spec";
import { datePolicy, feeAt } from "../src/policy/index";
import { nightsOf, stayTimes } from "../src/stays/nights";

/**
 * The stays vectors (spec 0.11, ADR-037), built from the code that keeps them so a second
 * implementation can be checked against the same answers:
 *
 *   vectors/stay-totals.json           quotes that hold together, and ones that do not, and why (JPY, KWD, CAD)
 *   vectors/stay-policy.json           presets dated in zones across clock changes, and the fee at moments
 *   vectors/stay-nights.json           a stay's nights, and its start and end with the zone's offset
 *   vectors/doors-elsewhere-stay.json  a stay taken elsewhere, with its deep link, kept or dropped and filled
 *
 * `test/stay-vectors.test.ts` rebuilds them and fails when a committed file differs.
 */

const money = (value: number, currency: string) => ({ value, currency });

type TotalsCase = {
  name: string;
  quote: Pick<StayQuote, "currency" | "lines" | "total" | "schedule" | "policy" | "validThrough">;
  now: string;
  arrival_at: string;
};

/** Ryokan Hoshi, Kyoto (JPY, no minor unit): 3 nights, the first as deposit, the city tax at the property. */
const ryokan: TotalsCase = {
  name: "Ryokan Hoshi, JPY: 3 nights for 2, service charge, accommodation tax paid at the property",
  quote: {
    currency: "JPY",
    lines: [
      {
        type: "subtotal",
        label: "Japanese room, 3 nights (includes 10% consumption tax)",
        amount: 77_400,
        collected: "with_booking",
      },
      { type: "extra", label: "Late check-out", amount: 3_000, collected: "with_booking" },
      { type: "fee", label: "Service charge 10%", amount: 7_740, collected: "with_booking" },
      {
        type: "tax",
        label: "Accommodation tax, ¥400 per guest per night (paid at the property)",
        amount: 2_400,
        collected: "at_property",
      },
    ],
    total: money(90_540, "JPY"),
    schedule: [
      { id: "deposit", type: "immediate", amount: money(25_800, "JPY"), label: "Deposit" },
      { id: "at_property", type: "at_property", amount: money(64_740, "JPY"), label: "At the property" },
    ],
    policy: {
      steps: [{ until: "2026-12-09T23:59:59+09:00", fee: money(0, "JPY") }],
      after: money(25_800, "JPY"),
      noShow: money(90_540, "JPY"),
      zone: "Asia/Tokyo",
    },
    validThrough: "2026-11-13T10:00:00+09:00",
  },
  now: "2026-11-12T10:00:00+09:00",
  arrival_at: "2026-12-12T15:00:00+09:00",
};

/** Dar Al Bahr, Kuwait City (KWD, three decimals): 2 nights, 30% now, the rest at the property. */
const darAlBahr: TotalsCase = {
  name: "Dar Al Bahr, KWD (three decimals): 2 nights, 30% now",
  quote: {
    currency: "KWD",
    lines: [
      { type: "subtotal", label: "Sea view king, 2 nights", amount: 91_500, collected: "with_booking" },
      { type: "fee", label: "Service 5%", amount: 4_575, collected: "with_booking" },
    ],
    total: money(96_075, "KWD"),
    schedule: [
      { id: "deposit", type: "immediate", amount: money(28_823, "KWD"), label: "Deposit" },
      { id: "at_property", type: "at_property", amount: money(67_252, "KWD"), label: "At the property" },
    ],
    policy: {
      steps: [{ until: "2027-02-18T23:59:59+03:00", fee: money(0, "KWD") }],
      after: money(48_038, "KWD"),
      noShow: money(96_075, "KWD"),
      zone: "Asia/Kuwait",
    },
    validThrough: "2027-02-01T12:00:00+03:00",
  },
  now: "2027-01-31T12:00:00+03:00",
  arrival_at: "2027-02-20T14:00:00+03:00",
};

const broken = (name: string, change: (q: TotalsCase["quote"]) => void, base: TotalsCase = ryokan): TotalsCase => {
  const c = structuredClone(base);
  change(c.quote);
  return { ...c, name };
};

function totals() {
  const cases: TotalsCase[] = [
    ryokan,
    darAlBahr,
    broken("the lines add up to less than the total", (q) => {
      (q.lines[1] as { amount: number }).amount = 600;
    }),
    broken("the schedule adds up to less than the total", (q) => {
      (q.schedule[0] as { amount: { value: number } }).amount.value = 23_400;
    }),
    broken("what is collected at the property is not left for it in the schedule", (q) => {
      q.schedule = [
        { id: "deposit", type: "immediate", amount: money(89_540, "JPY"), label: "Deposit" },
        { id: "at_property", type: "at_property", amount: money(1_000, "JPY"), label: "At the property" },
      ];
    }),
    broken("a cancellation fee is more than the total", (q) => {
      q.policy = { ...q.policy, noShow: money(95_000, "JPY") };
    }),
    broken("a step ends after arrival", (q) => {
      q.policy = { ...q.policy, steps: [{ until: "2026-12-13T23:59:59+09:00", fee: money(0, "JPY") }] };
    }),
    broken("it can be accepted until after arrival", (q) => {
      q.validThrough = "2026-12-12T16:00:00+09:00";
    }),
    broken("a schedule in another currency", (q) => {
      (q.schedule[0] as { amount: { currency: string } }).amount.currency = "USD";
    }),
  ];
  return {
    description:
      "Whether a stay's quote holds together (checkStayTotals in @surfingdog/spec): the lines add up to the total, the schedule does too, what is collected at the property is left for it, one currency throughout, no fee above the total, the policy's steps in order and before arrival, and it can be accepted now and only until before arrival. Amounts are ISO 4217 minor units: JPY has none, KWD three. Read by packages/core/test/stay-vectors.test.ts.",
    cases: cases.map((c) => ({
      ...c,
      problems: checkStayTotals(c.quote, { now: Date.parse(c.now), arrivalAt: Date.parse(c.arrival_at) }),
    })),
  };
}

type PolicyCase = {
  name: string;
  preset: Parameters<typeof stayPolicySteps>[0];
  check_in: string;
  check_in_time: string;
  zone: string;
  total: { value: number; currency: string };
  nights: number[];
  at: string[];
};

function policy() {
  const cases: PolicyCase[] = [
    {
      name: "Kyoto: free until 3 days before, then the first night; no-show the full stay",
      preset: { preset: "free_until", days: 3, after: "first_night", noShow: "full" },
      check_in: "2026-12-12",
      check_in_time: "15:00",
      zone: "Asia/Tokyo",
      total: money(90_540, "JPY"),
      nights: [25_800, 25_800, 25_800],
      at: ["2026-12-09T23:59:58+09:00", "2026-12-10T00:00:00+09:00"],
    },
    {
      name: "Halifax, check-in on the day the clocks go forward: the step ends at 23:59:59 local, the day before is still standard time",
      preset: { preset: "free_until", days: 1, after: "half", noShow: "full" },
      check_in: "2027-03-14",
      check_in_time: "16:00",
      zone: "America/Halifax",
      total: money(43_470, "CAD"),
      nights: [18_900, 18_900],
      at: ["2027-03-13T23:59:58-04:00", "2027-03-14T00:00:00-04:00"],
    },
    {
      name: "Havana, whose clocks change at midnight: 2 days before ends at 23:59:59 local",
      preset: { preset: "free_until", days: 2, after: "first_night", noShow: "first_night" },
      check_in: "2027-03-16",
      check_in_time: "14:00",
      zone: "America/Havana",
      total: money(36_000, "USD"),
      nights: [12_000, 12_000, 12_000],
      at: ["2027-03-14T23:59:00-04:00", "2027-03-15T00:00:30-04:00"],
    },
    {
      name: "Lord Howe Island, half-hour daylight saving",
      preset: { preset: "free_until", days: 7, after: "full", noShow: "full" },
      check_in: "2027-04-05",
      check_in_time: "14:00",
      zone: "Australia/Lord_Howe",
      total: money(150_000, "AUD"),
      nights: [50_000, 50_000, 50_000],
      at: ["2027-03-29T23:59:00+11:00", "2027-03-30T00:30:00+11:00"],
    },
    {
      name: "Kathmandu, +5:45; non-refundable from booking",
      preset: { preset: "non_refundable" },
      check_in: "2027-01-08",
      check_in_time: "13:00",
      zone: "Asia/Kathmandu",
      total: money(1_200_000, "NPR"),
      nights: [600_000, 600_000],
      at: ["2027-01-01T09:00:00+05:45"],
    },
    {
      name: "Jaipur, +5:30: custom steps, 50% inside 14 days, the full stay inside 2",
      preset: {
        preset: "custom",
        steps: [
          { daysBefore: 14, fee: { kind: "none" } },
          { daysBefore: 2, fee: { kind: "percent", value: 50 } },
        ],
        after: { kind: "full" },
        noShow: { kind: "full" },
      },
      check_in: "2027-02-20",
      check_in_time: "12:00",
      zone: "Asia/Kolkata",
      total: money(4_800_000, "INR"),
      nights: [1_600_000, 1_600_000, 1_600_000],
      at: [
        "2027-02-06T23:59:59+05:30",
        "2027-02-07T00:00:00+05:30",
        "2027-02-18T23:59:59+05:30",
        "2027-02-19T00:00:00+05:30",
      ],
    },
    {
      name: "Apia, across the date line: a step 1 day before",
      preset: { preset: "free_until", days: 1, after: "first_night", noShow: "full" },
      check_in: "2027-01-10",
      check_in_time: "14:00",
      zone: "Pacific/Apia",
      total: money(90_000, "WST"),
      nights: [45_000, 45_000],
      at: ["2027-01-09T23:59:59+13:00", "2027-01-10T00:00:00+13:00"],
    },
  ];
  return {
    description:
      "A stay's cancellation preset dated for its arrival (stayPolicySteps in @surfingdog/spec, datePolicy and feeAt in the inbox): each step ends at 23:59:59 local on the day N days before the check-in date, in the property's zone, whatever its clocks do; `first_night` is the first night's price, `half` half the total, `full` the total. Then the fee at given instants. Read by packages/core/test/stay-vectors.test.ts.",
    cases: cases.map((c) => {
      const steps: Policy = stayPolicySteps(c.preset);
      const dated = datePolicy(steps, {
        start: { date: c.check_in, time: c.check_in_time },
        zone: c.zone,
        total: c.total,
        units: c.nights,
      });
      return {
        ...c,
        policy: steps,
        dated,
        fees: c.at.map((at) => ({ at, fee: feeAt(dated, Date.parse(at), { total: c.total }) })),
      };
    }),
  };
}

function nights() {
  const cases = [
    {
      name: "three nights in Kyoto",
      check_in: "2026-12-12",
      check_out: "2026-12-15",
      zone: "Asia/Tokyo",
      from: "15:00",
      until: "10:00",
    },
    {
      name: "across the end of a year",
      check_in: "2026-12-30",
      check_out: "2027-01-02",
      zone: "Asia/Kolkata",
      from: "14:00",
      until: "11:00",
    },
    {
      name: "across February in a leap-free year",
      check_in: "2027-02-27",
      check_out: "2027-03-02",
      zone: "Africa/Nairobi",
      from: "14:00",
      until: "11:00",
    },
    {
      name: "over the night the clocks go forward in Halifax",
      check_in: "2027-03-13",
      check_out: "2027-03-15",
      zone: "America/Halifax",
      from: "16:00",
      until: "11:00",
    },
    {
      name: "over the night the clocks go back in Hobart",
      check_in: "2027-04-03",
      check_out: "2027-04-05",
      zone: "Australia/Hobart",
      from: "15:00",
      until: "10:00",
    },
    {
      name: "St John's, a half-hour zone",
      check_in: "2027-07-01",
      check_out: "2027-07-03",
      zone: "America/St_Johns",
      from: "15:00",
      until: "11:00",
    },
    {
      name: "Kiritimati, UTC+14",
      check_in: "2027-01-01",
      check_out: "2027-01-02",
      zone: "Pacific/Kiritimati",
      from: "14:00",
      until: "12:00",
    },
  ];
  return {
    description:
      "A stay's nights are the dates from check-in up to the day before check-out, never minutes; its start is the check-in date at the property's check-in time, its end the check-out date at its check-out time, each with the zone's offset on that day. Read by packages/core/test/stay-vectors.test.ts.",
    cases: cases.map((c) => {
      const t = stayTimes({ checkInFrom: c.from, checkOutUntil: c.until, timezone: c.zone }, c.check_in, c.check_out);
      return { ...c, nights: nightsOf(c.check_in, c.check_out), start_time: t.startTime, end_time: t.endTime };
    }),
  };
}

function doorsElsewhere() {
  const values = { check_in: "2027-05-14", check_out: "2027-05-17", adults: 2, children: 1, rooms: 1 };
  const cases = [
    {
      name: "a guesthouse that takes stays on its own booking engine, with a deep link",
      manifest: {
        item_types: ["message"],
        doors_elsewhere: [
          {
            item_type: "stay",
            url: "https://book.alpenrose.example/",
            url_template:
              "https://book.alpenrose.example/search?arrive={check_in}&depart={check_out}&adults={adults}&kids={children}",
          },
        ],
      },
    },
    {
      name: "a template on another host is dropped; the entry stays",
      manifest: {
        item_types: ["message"],
        doors_elsewhere: [
          {
            item_type: "stay",
            url: "https://book.alpenrose.example/",
            url_template: "https://elsewhere.example/?d={check_in}",
          },
        ],
      },
    },
    {
      name: "a template that is not https is dropped",
      manifest: {
        item_types: ["message"],
        doors_elsewhere: [
          {
            item_type: "stay",
            url: "https://stay.harbourlight.example/",
            url_template: "http://stay.harbourlight.example/?from={check_in}",
          },
        ],
      },
    },
    {
      name: "unknown variables are dropped when filled",
      manifest: {
        item_types: ["message"],
        doors_elsewhere: [
          {
            item_type: "stay",
            url: "https://reserve.haveli-rang.example/",
            url_template: "https://reserve.haveli-rang.example/b?in={check_in}&out={check_out}&promo={promo}",
          },
        ],
      },
    },
    {
      name: "a template on any other item type is not kept",
      manifest: {
        item_types: ["message"],
        doors_elsewhere: [
          {
            item_type: "booking",
            url: "https://book.example/salon",
            url_template: "https://book.example/salon?d={check_in}",
          },
        ],
      },
    },
    {
      name: "a stay the inbox takes itself is not elsewhere",
      manifest: {
        item_types: ["message", "stay"],
        doors_elsewhere: [{ item_type: "stay", url: "https://book.alpenrose.example/" }],
      },
    },
  ];
  return {
    description:
      "Since spec 0.11 a manifest's doors_elsewhere may name `stay`, with an optional url_template: kept when, filled in, it is an https URL on the same host as the entry's url, and dropped alone otherwise. A reader fills {check_in}, {check_out}, {adults}, {children} and {rooms} and drops any other {…}. `filled` is the kept template filled with `values`. Read by packages/core/test/stay-vectors.test.ts.",
    values,
    cases: cases.map((c) => {
      const kept = readDoorsElsewhere(c.manifest);
      const t = kept.find((k) => k.item_type === "stay")?.url_template;
      return { ...c, kept, filled: t ? fillStayTemplate(t, values) : null };
    }),
  };
}

export function buildStayVectors() {
  return { totals: totals(), policy: policy(), nights: nights(), doorsElsewhere: doorsElsewhere() };
}
