import { describe, expect, it } from "vitest";
import {
  answerOf,
  areaSettingsSchema,
  areaSummary,
  areaWords,
  bandOf,
  blurredBase,
  checkSite,
  distanceKm,
  isPostalCode,
  matchZone,
  type Point,
  postalMatches,
  postalPrefixProblem,
  postalShapes,
  roundedPoint,
} from "../src/area/index";
import { parseStoredSettings } from "../src/settings/schema";

/**
 * Where a business works (ADR-034 §3), checked in several countries: a radius from a base it chose as
 * a place (never typed coordinates, never published, a site told as a band), postal prefixes in each
 * country's own shape (nothing geocoded), and "on request" whenever it cannot be told.
 */

// Fixtures (plan §4.6): Fundi Flow Plumbing, Nairobi; Elektro Brandt, Leipzig; Southern Cross
// Renovations, Perth; a roofer in Santiago.
const NAIROBI_CBD: Point = { lat: -1.2864, lng: 36.8172 };
const WESTLANDS: Point = { lat: -1.2676, lng: 36.8108 }; // about 2 km
const KAREN: Point = { lat: -1.3195, lng: 36.7076 }; // about 13 km
const THIKA: Point = { lat: -1.0333, lng: 37.0693 }; // about 40 km
const NAIVASHA: Point = { lat: -0.7167, lng: 36.4333 }; // about 75 km
const MOMBASA: Point = { lat: -4.0435, lng: 39.6682 }; // hundreds of km

const area = (over: Record<string, unknown>) => areaSettingsSchema.parse(over);

describe("a radius", () => {
  it("measures from the base and answers with a band, never a distance", () => {
    expect(distanceKm(NAIROBI_CBD, WESTLANDS)).toBeGreaterThan(1.5);
    expect(distanceKm(NAIROBI_CBD, WESTLANDS)).toBeLessThan(3);
    const fundi = area({ mode: "radius", radiusKm: 25, base: { from: "device", point: NAIROBI_CBD } });
    // From a device's point, no band nearer than 10 km.
    expect(checkSite(fundi, null, { point: WESTLANDS })).toEqual({ status: "inside", by: "radius", within_km: 10 });
    expect(checkSite(fundi, null, { point: KAREN })).toEqual({ status: "inside", by: "radius", within_km: 25 });
    expect(checkSite(fundi, null, { point: THIKA })).toEqual({ status: "outside", by: "radius" });
    expect(bandOf(4.99)).toBe(5);
    expect(bandOf(4.99, 10)).toBe(10);
    expect(bandOf(50)).toBe(50);
    expect(bandOf(51)).toBeUndefined();
    // A radius beyond 50 km: the nearest bands still, and past 50 km inside with no band.
    const wide = area({ mode: "radius", radiusKm: 100, base: { from: "device", point: NAIROBI_CBD } });
    expect(checkSite(wide, null, { point: THIKA })).toEqual({ status: "inside", by: "radius", within_km: 50 });
    expect(checkSite(wide, null, { point: NAIVASHA })).toEqual({ status: "inside", by: "radius" });
    expect(checkSite(wide, null, { point: MOMBASA }).status).toBe("outside");
  });

  it("is on request without a base, or without a point for the site: a postal code is not geocoded", () => {
    const noBase = area({ mode: "radius", radiusKm: 25 });
    expect(checkSite(noBase, null, { point: WESTLANDS })).toEqual({ status: "unknown", by: "radius" });
    const fromPremises = area({ mode: "radius", radiusKm: 25, base: { from: "business" } });
    expect(checkSite(fromPremises, null, { point: WESTLANDS }).status).toBe("unknown");
    expect(checkSite(fromPremises, NAIROBI_CBD, { point: WESTLANDS }).status).toBe("inside");
    expect(checkSite(fromPremises, NAIROBI_CBD, { postalCode: "00100", country: "KE" }).status).toBe("unknown");
    expect(answerOf(fromPremises, { status: "unknown", by: "radius" })).toBe("on_request");
  });

  it("declines from outside only when the business says so", () => {
    const declines = area({
      mode: "radius",
      radiusKm: 10,
      outside: "decline",
      base: { from: "device", point: NAIROBI_CBD },
    });
    expect(answerOf(declines, checkSite(declines, null, { point: THIKA }))).toBe("outside");
    const decides = area({
      mode: "radius",
      radiusKm: 10,
      outside: "on_request",
      base: { from: "device", point: NAIROBI_CBD },
    });
    expect(answerOf(decides, checkSite(decides, null, { point: THIKA }))).toBe("on_request");
  });

  it("publishes the radius and never the base", () => {
    const fundi = area({ mode: "radius", radiusKm: 25, base: { from: "device", point: NAIROBI_CBD, label: "Home" } });
    const summary = areaSummary(fundi);
    expect(summary).toEqual({ mode: "radius", radius_km: 25, outside: "on_request" });
    expect(JSON.stringify(summary)).not.toContain("1.28");
    expect(areaWords("Fundi Flow Plumbing", fundi, checkSite(fundi, null, { point: KAREN }))).toBe(
      "Fundi Flow Plumbing works within 25 km: this site is within 25 km.",
    );
    expect(roundedPoint({ lat: -1.286389, lng: 36.817223 })).toEqual({ lat: -1.286, lng: 36.817 });
  });
});

describe("a base that is a device's point", () => {
  it("is measured from the middle of its grid cell, so asking round the edge never finds the point", () => {
    const home: Point = { lat: -31.9505, lng: 115.8605 }; // Perth
    const cell = blurredBase(home);
    // The cell's middle is within about 4 km of the point, and the same for every point in the cell.
    expect(distanceKm(cell, home)).toBeLessThan(4.2);
    expect(blurredBase({ lat: (home.lat + cell.lat) / 2, lng: (home.lng + cell.lng) / 2 })).toEqual(cell);
    expect(blurredBase(cell)).toEqual(cell);
    // Cells stay about 5 km wide far from the equator too: Tromsø, and Ushuaia.
    for (const far of [
      { lat: 69.6492, lng: 18.9553 },
      { lat: -54.8019, lng: -68.303 },
    ]) {
      expect(distanceKm(blurredBase(far), far)).toBeLessThan(4.2);
    }
    // Probe a line of sites across the edge of a 25 km radius: where inside turns to outside says
    // where the cell's middle is, never the point.
    const southern = area({ mode: "radius", radiusKm: 25, base: { from: "device", point: home } });
    let edge = 0;
    for (let km = 20; km <= 30; km += 0.05) {
      const site = { lat: home.lat, lng: home.lng + km / (111.32 * Math.cos((home.lat * Math.PI) / 180)) };
      if (checkSite(southern, null, { point: site }).status === "outside") {
        edge = km;
        break;
      }
    }
    expect(edge).toBeGreaterThan(0);
    expect(Math.abs(edge - 25)).toBeGreaterThan(0.2);
    // The premises the business publishes are measured as they are.
    const premises = area({ mode: "radius", radiusKm: 25, base: { from: "business" } });
    expect(checkSite(premises, NAIROBI_CBD, { point: WESTLANDS })).toEqual({
      status: "inside",
      by: "radius",
      within_km: 5,
    });
  });
});

describe("postal codes", () => {
  it("covers a code by its start, in each country's own shape", () => {
    // Leipzig: 04xxx, not 14xxx.
    expect(postalMatches("DE", "04103", "04")).toBe(true);
    expect(postalMatches("DE", "14103", "04")).toBe(false);
    // Nairobi's five digits, Perth's four, Santiago's seven.
    expect(postalMatches("KE", "00100", "00100")).toBe(true);
    expect(postalMatches("AU", "6000", "60")).toBe(true);
    expect(postalMatches("AU", "6105", "60")).toBe(false);
    expect(postalMatches("CL", "8320000", "83")).toBe(true);
    // A ZIP+4 and a Dutch code with its letters, written however the agent wrote them.
    expect(postalMatches("US", "94110-1234", "941")).toBe(true);
    expect(postalMatches("NL", "1012 AB", "1012")).toBe(true);
    expect(postalMatches("CA", "m5v 3l9", "M5V")).toBe(true);
  });

  it("matches a British code by its outward code, so M1 is not M12 and S is not SW", () => {
    expect(postalMatches("GB", "M1 1AE", "M1")).toBe(true);
    expect(postalMatches("GB", "M12 3AB", "M1")).toBe(false);
    expect(postalMatches("GB", "SW1A 1AA", "SW")).toBe(true);
    expect(postalMatches("GB", "S1 2HE", "SW")).toBe(false);
    expect(postalMatches("GB", "SW1A 1AA", "SW1A1")).toBe(true);
    expect(postalMatches("GB", "SW1A 2AA", "SW1A1")).toBe(false);
  });

  it("is inside, outside, or not known when the code is not one of the country's", () => {
    const brandt = area({ mode: "postal", postal: [{ country: "DE", prefix: "04" }] });
    expect(checkSite(brandt, null, { postalCode: "04109", country: "DE" })).toEqual({ status: "inside", by: "postal" });
    expect(checkSite(brandt, null, { postalCode: "10115", country: "DE" })).toEqual({
      status: "outside",
      by: "postal",
    });
    // Not a German code, a country not matched here, no code at all: on request.
    expect(checkSite(brandt, null, { postalCode: "0410", country: "DE" }).status).toBe("unknown");
    expect(checkSite(brandt, null, { postalCode: "12345", country: "QQ" }).status).toBe("unknown");
    expect(checkSite(brandt, null, {}).status).toBe("unknown");
    expect(answerOf(brandt, { status: "unknown", by: "postal" })).toBe("on_request");
    expect(isPostalCode("DE", "04109")).toBe(true);
    expect(isPostalCode("QQ", "04109")).toBeNull();
  });

  it("takes a prefix only in the shape of the country's codes, and says what one looks like", () => {
    expect(postalPrefixProblem("KE", "00100")).toBeNull();
    expect(postalPrefixProblem("AU", "60")).toBeNull();
    expect(postalPrefixProblem("GB", "sw1")).toBeNull();
    expect(postalPrefixProblem("DE", "041039")).toMatch(/like 04/);
    expect(postalPrefixProblem("CA", "5MV")).toMatch(/like M5V/);
    expect(postalPrefixProblem("QQ", "1")).toMatch(/use a radius/);
    expect(areaSettingsSchema.safeParse({ mode: "postal", postal: [{ country: "AU", prefix: "6X" }] }).success).toBe(
      false,
    );
    expect(areaSettingsSchema.safeParse({ mode: "postal", postal: [{ country: "CL", prefix: "75" }] }).success).toBe(
      true,
    );
    // Postal codes and none of them is refused; stored, it reads as anywhere and the rest stands.
    expect(areaSettingsSchema.safeParse({ mode: "postal", postal: [] }).success).toBe(false);
    const stored = parseStoredSettings({ area: { mode: "postal", postal: [], radiusKm: 40 } });
    expect(stored.settings.area).toMatchObject({ mode: "anywhere", radiusKm: 40 });
    expect(stored.ignored).toEqual(["area.mode"]);
    // How each country's codes are written, for the owner's chooser.
    expect(postalShapes().GB).toEqual({ example: "SW1", covers: "SW1A 1AA" });
    expect(postalShapes().DE).toEqual({ example: "04", covers: "04103" });
    expect(postalShapes().KE).toEqual({ example: "00100", covers: "00100" });
  });

  it("publishes the prefixes as written, normalised, with no base", () => {
    const perth = area({
      mode: "postal",
      postal: [
        { country: "AU", prefix: "60" },
        { country: "AU", prefix: "61" },
      ],
    });
    expect(areaSummary(perth)).toEqual({
      mode: "postal",
      postal: [
        { country: "AU", prefix: "60" },
        { country: "AU", prefix: "61" },
      ],
      outside: "on_request",
    });
  });
});

describe("anywhere", () => {
  it("is inside wherever the site is, and says nothing of a base", () => {
    const any = area({});
    expect(any.mode).toBe("anywhere");
    expect(checkSite(any, null, {})).toEqual({ status: "inside", by: "anywhere" });
    expect(areaSummary(any)).toEqual({ mode: "anywhere", outside: "on_request" });
  });
});

describe("delivery zones (for food)", () => {
  it("are rings inside out: the first a site falls in wins, by distance or by code", () => {
    const zones = [
      { name: "Near", mode: "radius" as const, radiusKm: 3, fee: { value: 0, currency: "KES" }, etaMin: 30 },
      { name: "City", mode: "radius" as const, radiusKm: 15, fee: { value: 25_000, currency: "KES" }, etaMin: 60 },
      { name: "Outer", mode: "postal" as const, postal: [{ country: "KE", prefix: "01" }] },
    ];
    expect(matchZone(zones, NAIROBI_CBD, { point: WESTLANDS })?.zone.name).toBe("Near");
    expect(matchZone(zones, NAIROBI_CBD, { point: KAREN })?.zone.name).toBe("City");
    expect(matchZone(zones, NAIROBI_CBD, { point: THIKA, postalCode: "01000", country: "KE" })?.zone.name).toBe(
      "Outer",
    );
    expect(matchZone(zones, NAIROBI_CBD, { point: MOMBASA })).toBeNull();
    expect(matchZone(zones, null, { point: WESTLANDS })).toBeNull();
  });
});
