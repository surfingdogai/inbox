import { type Policy, policySchema } from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import {
  datePolicy,
  feeAt,
  feeOf,
  freeUntil,
  policyLang,
  policySentence,
  refundable,
  refundOwed,
} from "../src/policy/index";
import { addDays, daysBetween, instantOf, isoIn, isoWeekday } from "../src/util/zoned";

/**
 * Policies as data (ADR-036): steps before a start, dated in the business's own zone — across zones
 * with odd offsets and on days the clocks change — the fee at each moment, and what is owed back.
 */

const JPY = (value: number) => ({ value, currency: "JPY" });
const freeThenFirstNight: Policy = policySchema.parse({
  steps: [{ before: { days: 3 }, fee: { kind: "none" } }],
  after: { kind: "units", value: 1 },
  noShow: { kind: "full" },
});

describe("dated steps", () => {
  it("Ryokan Hoshi: free until 3 days before arrival, then the first night, in Kyoto's time", () => {
    const dated = datePolicy(freeThenFirstNight, {
      start: { date: "2026-12-12", time: "15:00" },
      zone: "Asia/Tokyo",
      total: JPY(90_540),
      units: [25_800, 25_800, 25_800],
    });
    expect(dated).toEqual({
      steps: [{ until: "2026-12-09T23:59:59+09:00", fee: JPY(0) }],
      after: JPY(25_800),
      noShow: JPY(90_540),
      zone: "Asia/Tokyo",
    });
    expect(freeUntil(dated)).toBe("2026-12-09T23:59:59+09:00");
    // English as it is written in Japan (en-JP), the yen's sign as the runtime writes it there.
    expect(policySentence(dated, { lang: "en", total: JPY(90_540), what: "stay", place: "Kyoto" })).toMatch(
      /^Free cancellation until Dec 9, 2026, 23:59 Kyoto time\. After that: (JP)?¥25,800\. No-show: the full stay\.$/,
    );
    // A locale given wins: a guest's own region.
    expect(
      policySentence(dated, { lang: "en", locale: "en-GB", total: JPY(90_540), what: "stay", place: "Kyoto" }),
    ).toMatch(/^Free cancellation until 9 Dec 2026, 23:59 Kyoto time\./);
  });

  it("dates each step at the end of its local day, whatever the clocks do that day", () => {
    const one: Policy = {
      steps: [{ before: { days: 1 }, fee: { kind: "none" } }],
      after: { kind: "full" },
      noShow: { kind: "full" },
    };
    const cases: [string, string, string][] = [
      // Daylight saving begins at midnight in Havana: the day before is still on standard time.
      ["America/Havana", "2027-03-15", "2027-03-14T23:59:59-04:00"],
      ["America/Havana", "2027-03-14", "2027-03-13T23:59:59-05:00"],
      // Half-hour daylight saving on Lord Howe Island.
      ["Australia/Lord_Howe", "2026-10-05", "2026-10-04T23:59:59+11:00"],
      ["Australia/Lord_Howe", "2026-10-04", "2026-10-03T23:59:59+10:30"],
      ["Asia/Kathmandu", "2026-06-02", "2026-06-01T23:59:59+05:45"],
      ["America/St_Johns", "2027-03-15", "2027-03-14T23:59:59-02:30"],
      ["America/St_Johns", "2027-03-14", "2027-03-13T23:59:59-03:30"],
      // Across the date line, a day ahead of most of the world.
      ["Pacific/Kiritimati", "2026-12-02", "2026-12-01T23:59:59+14:00"],
      ["Pacific/Apia", "2026-12-02", "2026-12-01T23:59:59+13:00"],
      // Nova Scotia, the day clocks go back.
      ["America/Halifax", "2026-11-02", "2026-11-01T23:59:59-04:00"],
    ];
    for (const [zone, arrival, until] of cases) {
      const dated = datePolicy(one, {
        start: { date: arrival, time: "15:00" },
        zone,
        total: { value: 10_000, currency: "CAD" },
      });
      expect(dated.steps[0]?.until, `${zone} ${arrival}`).toBe(until);
    }
  });

  it("dates hours before an appointment's instant, and leaves out steps already past at booking", () => {
    const policy: Policy = {
      steps: [
        { before: { hours: 48 }, fee: { kind: "none" } },
        { before: { hours: 24 }, fee: { kind: "percent", value: 50 } },
      ],
      after: { kind: "full" },
      noShow: { kind: "full" },
    };
    const at = Date.parse("2026-11-20T09:30:00Z");
    const ctx = { start: { at }, zone: "Africa/Nairobi", total: { value: 450_000, currency: "KES" } };
    const dated = datePolicy(policy, ctx);
    expect(dated.steps).toEqual([
      { until: "2026-11-18T12:30:00+03:00", fee: { value: 0, currency: "KES" } },
      { until: "2026-11-19T12:30:00+03:00", fee: { value: 225_000, currency: "KES" } },
    ]);
    // Booked 30 hours before: the free step has passed and is not shown.
    const late = datePolicy(policy, { ...ctx, bookedAt: at - 30 * 3_600_000 });
    expect(late.steps.map((s) => s.fee.value)).toEqual([225_000]);
  });
});

describe("the fee at a moment", () => {
  const dated = datePolicy(freeThenFirstNight, {
    start: { date: "2026-12-12", time: "15:00" },
    zone: "Asia/Tokyo",
    total: JPY(90_540),
    units: [25_800, 25_800, 25_800],
  });
  it("is the first step still ahead, else the fee after the last", () => {
    expect(feeAt(dated, Date.parse("2026-12-09T14:59:58Z"))).toEqual(JPY(0));
    expect(feeAt(dated, Date.parse("2026-12-09T14:59:59Z"))).toEqual(JPY(0));
    expect(feeAt(dated, Date.parse("2026-12-09T15:00:00Z"))).toEqual(JPY(25_800));
    expect(feeAt(dated, Date.parse("2026-12-12T05:00:00Z"))).toEqual(JPY(25_800));
  });

  it("keeps a deposit given as not refundable, and is never more than the total", () => {
    expect(feeAt(dated, Date.parse("2026-11-01T00:00:00Z"), { keep: JPY(10_000) })).toEqual(JPY(10_000));
    expect(feeAt(dated, Date.parse("2026-12-11T00:00:00Z"), { total: JPY(20_000) })).toEqual(JPY(20_000));
  });

  it("leaves what was paid less the fee owed back, never below nothing", () => {
    expect(refundOwed(JPY(25_800), JPY(0))).toEqual(JPY(25_800));
    expect(refundOwed(JPY(25_800), JPY(25_800))).toEqual(JPY(0));
    expect(refundOwed(JPY(10_000), JPY(25_800))).toEqual(JPY(0));
  });

  it("works out every kind of fee for one booking", () => {
    const ctx = { total: { value: 42_750, currency: "KWD" }, units: [14_250, 14_250, 14_250] };
    expect(feeOf({ kind: "none" }, ctx).value).toBe(0);
    expect(feeOf({ kind: "full" }, ctx).value).toBe(42_750);
    expect(feeOf({ kind: "amount", value: 5_000 }, ctx).value).toBe(5_000);
    expect(feeOf({ kind: "amount", value: 99_000 }, ctx).value).toBe(42_750);
    expect(feeOf({ kind: "percent", value: 30 }, ctx).value).toBe(12_825);
    expect(feeOf({ kind: "units", value: 2 }, ctx).value).toBe(28_500);
    expect(feeOf({ kind: "units", value: 1 }, { total: ctx.total }).value).toBe(42_750);
    expect(refundable(freeThenFirstNight)).toBe(true);
    expect(refundable({ steps: [], after: { kind: "full" }, noShow: { kind: "full" } })).toBe(false);
  });
});

describe("the read-back sentence", () => {
  const total = { value: 129_000, currency: "EUR" };
  const policy: Policy = {
    steps: [
      { before: { days: 7 }, fee: { kind: "none" } },
      { before: { days: 2 }, fee: { kind: "percent", value: 50 } },
    ],
    after: { kind: "full" },
    noShow: { kind: "full" },
  };
  const dated = datePolicy(policy, { start: { date: "2027-02-20", time: "14:00" }, zone: "Europe/Vienna", total });

  it("is said in six languages, with the same dates and amounts in each", () => {
    const said = Object.fromEntries(
      ["en", "es", "fr", "de", "it", "pt"].map((l) => [
        l,
        policySentence(dated, { lang: l, total, what: "stay", place: "Innsbruck" }),
      ]),
    );
    // English as Austria writes its amounts.
    expect(said.en).toBe(
      "Free cancellation until 13 Feb 2027, 23:59 Innsbruck time. Until 18 Feb 2027, 23:59 Innsbruck time, cancelling costs €\u00a0645,00. After that: the full stay. No-show: the full stay.",
    );
    expect(said.de).toContain("Kostenlose Stornierung bis 13.");
    expect(said.de).toContain("23:59 Uhr (Ortszeit Innsbruck)");
    expect(said.fr).toContain("Annulation gratuite jusqu'au 13");
    expect(said.es).toContain("Cancelación gratuita hasta el 13");
    expect(said.it).toContain("Cancellazione gratuita fino al 13");
    expect(said.pt).toContain("Cancelamento gratuito até 13");
    for (const text of Object.values(said)) {
      expect(text).toMatch(/645,00|645\.00/);
      expect(text).toContain("23:59");
    }
  });

  it("falls back to English for another language, and names the zone by its country or its own name, never its city", () => {
    expect(policyLang("sw-KE")).toBe("en");
    expect(policyLang("pt-BR")).toBe("pt");
    // Austria has one zone: the country names it.
    expect(policySentence(dated, { lang: "ja", total })).toContain("23:59 Austria time");
    expect(policySentence(dated, { lang: "fr", total })).toContain("(heure locale, Autriche)");
    // Mexico has several: the zone's own name, in the reader's language, never "Mexico City".
    const oaxaca = datePolicy(policy, {
      start: { date: "2027-02-20", time: "15:00" },
      zone: "America/Mexico_City",
      total: { value: 1_450_00, currency: "MXN" },
    });
    const es = policySentence(oaxaca, { lang: "es", total: { value: 1_450_00, currency: "MXN" } });
    expect(es).not.toContain("Mexico City");
    expect(es).toMatch(/\(hora [^)]+\)/);
    // A town given names it.
    expect(
      policySentence(oaxaca, { lang: "es", total: { value: 1_450_00, currency: "MXN" }, place: "Oaxaca" }),
    ).toContain("(hora de Oaxaca)");
  });
});

describe("local dates", () => {
  it("are calendar arithmetic, never minutes", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(daysBetween("2026-12-12", "2026-12-15")).toBe(3);
    expect(isoWeekday("2026-12-12")).toBe(6);
    // A wall time the clocks skip moves forward by the gap; one that comes twice is the first.
    expect(isoIn(instantOf("2027-03-14", "00:30", "America/Havana"), "America/Havana")).toBe(
      "2027-03-14T01:30:00-04:00",
    );
    expect(isoIn(instantOf("2026-11-01", "01:30", "America/Halifax"), "America/Halifax")).toBe(
      "2026-11-01T01:30:00-03:00",
    );
  });
});
