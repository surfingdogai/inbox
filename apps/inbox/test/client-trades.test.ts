import { describe, expect, it } from "vitest";
import { stepsFor } from "../client/src/lib/setup";
import {
  areaDocOf,
  areaLine,
  areaReady,
  balanceOf,
  emptyArea,
  noonIn,
  pricesBeforeTax,
  sameWeek,
  stageWhen,
} from "../client/src/lib/trades";

/**
 * The owner's trade screens (ADR-039), the parts that decide something: the last stage of a quote as
 * the rest of the total, a stage's date as noon where the business is, prices before tax where they are
 * quoted that way, the area's words, and the setup asking a trade where it works. Fixtures from
 * several countries: Perth (AUD), Toronto (CAD), Nairobi (KES), Santiago (CLP).
 */

describe("a quote in stages, on the owner's screen", () => {
  it("makes the last stage the rest of the total, and none when the others take it all", () => {
    expect(balanceOf(440_000, [100_000])).toBe(340_000);
    expect(balanceOf(1_500_000, [500_000, 500_000])).toBe(500_000);
    expect(balanceOf(100_000, [100_000])).toBeNull();
    expect(balanceOf(100_000, [120_000])).toBeNull();
  });

  it("dates a stage at noon in the business's own zone, wherever the owner's device is", () => {
    expect(noonIn("2026-12-15", "Australia/Perth")).toBe("2026-12-15T04:00:00.000Z");
    expect(noonIn("2026-12-15", "America/Toronto")).toBe("2026-12-15T17:00:00.000Z");
    expect(noonIn("2026-12-15", "Africa/Nairobi")).toBe("2026-12-15T09:00:00.000Z");
    expect(noonIn("2026-12-15", undefined)).toBe("2026-12-15T12:00:00.000Z");
    expect(noonIn("2026-12-15", "Not/AZone")).toBe("2026-12-15T12:00:00.000Z");
  });

  it("starts before tax only where prices are usually quoted that way", () => {
    expect(pricesBeforeTax("US")).toBe(true);
    expect(pricesBeforeTax("CA")).toBe(true);
    expect(pricesBeforeTax("AU")).toBe(false);
    expect(pricesBeforeTax("KE")).toBe(false);
    expect(pricesBeforeTax(null)).toBe(false);
    expect(stageWhen("at_property")).toBe("On site");
  });
});

describe("words on a request", () => {
  it("says why the area was not checked in plain words", () => {
    expect(areaLine({ status: "unknown", by: "radius" })).toBe("Area not checked: no location sent");
    expect(areaLine({ status: "unknown", by: "postal" })).toBe("Area not checked: postal code not recognised");
    expect(areaLine({ status: "inside", by: "radius", within_km: 10 })).toBe("Inside your area · ≤ 10 km");
  });

  it("tells two weeks of hours apart day by day, whatever order they came in", () => {
    const a = { mon: [["08:00", "17:00"] as const], sat: [["09:00", "13:00"] as const] };
    const b = { sat: [["09:00", "13:00"] as const], mon: [["08:00", "17:00"] as const] };
    expect(sameWeek(a, b)).toBe(true);
    expect(sameWeek(a, { mon: [["08:00", "17:00"] as const] })).toBe(false);
  });
});

describe("the setup, for a trade", () => {
  it("asks where it works after who it is, and nobody else", () => {
    expect(stepsFor("trades").map((s) => s.id)).toEqual([
      "kind",
      "you",
      "where",
      "doors",
      "offer",
      "hours",
      "answering",
    ]);
    expect(stepsFor("projects").map((s) => s.id)).toContain("where");
    expect(stepsFor("appointments").map((s) => s.id)).not.toContain("where");
    expect(stepsFor(null).map((s) => s.id)).not.toContain("where");
  });

  it("saves postal codes or a distance from where the device is, and nothing when skipped", () => {
    const none = emptyArea("CL");
    expect(areaReady(none)).toBe(true);
    expect(areaDocOf(none)).toBeNull();
    const postal = { ...none, mode: "postal" as const };
    expect(areaReady(postal)).toBe(false);
    expect(areaDocOf({ ...postal, postal: [{ country: "CL", prefix: "75" }] })).toEqual({
      area: { mode: "postal", postal: [{ country: "CL", prefix: "75" }] },
    });
    const radius = { ...none, mode: "radius" as const, radiusKm: 50 };
    expect(areaReady(radius)).toBe(false);
    const base = { from: "device" as const, point: { lat: -33.45, lng: -70.667 }, label: "Where I was on 21 Oct" };
    expect(areaDocOf({ ...radius, base })).toEqual({ area: { mode: "radius", radiusKm: 50, base } });
  });
});
