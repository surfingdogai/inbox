import { describe, expect, it } from "vitest";
import { isoAfter } from "../src/util/zoned";

/**
 * A booking's worked-out end (`completeBooking`): the start plus the service's length, written the way
 * the start was, so a retry that writes it out is the same request. Node and workerd.
 */
describe("isoAfter", () => {
  it("keeps the start's offset and its seconds", () => {
    expect(isoAfter("2026-11-07T10:00:00Z", 90)).toBe("2026-11-07T11:30:00Z");
    expect(isoAfter("2026-07-04T10:00:00+01:00", 90)).toBe("2026-07-04T11:30:00+01:00");
    expect(isoAfter("2026-07-04T10:00:00-05:30", 45)).toBe("2026-07-04T10:45:00-05:30");
    expect(isoAfter("2026-11-07T10:00:15.250Z", 30)).toBe("2026-11-07T10:30:15.250Z");
  });

  it("is the same instant as adding the minutes", () => {
    for (const start of ["2026-11-07T10:00:00+01:00", "2026-03-29T00:30:00Z", "2026-12-31T23:30:00-03:00"]) {
      expect(Date.parse(isoAfter(start, 90))).toBe(Date.parse(start) + 90 * 60_000);
    }
  });

  it("crosses midnight, a month and a year on the start's own clock", () => {
    expect(isoAfter("2026-12-31T23:30:00-03:00", 90)).toBe("2027-01-01T01:00:00-03:00");
    expect(isoAfter("2026-02-28T23:00:00+09:00", 120)).toBe("2026-03-01T01:00:00+09:00");
  });

  it("falls back to toISOString for anything else", () => {
    expect(isoAfter("2026-11-07T10:00:00Z", 1.5)).toBe("2026-11-07T10:01:30.000Z");
  });
});
