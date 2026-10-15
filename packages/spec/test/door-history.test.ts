import { describe, expect, it } from "vitest";
import {
  DOOR_HISTORY_CURRENT_DAYS,
  DOOR_HISTORY_MIN_DAYS,
  DOOR_HISTORY_PUBLIC_TYPES,
  DOOR_HISTORY_RECENT_DAYS,
  type DoorHistoryInput,
  doorHistoryEntrySchema,
  doorHistoryOf,
  doorHistorySchema,
  getBusinessOutputSchema,
  jsonSchemaOf,
  listingDetailSchema,
} from "../src/index";
import vectors from "../vectors/door-history.json";

/**
 * A door's history (protocol §4.8, ADR-020) against `vectors/door-history.json`, which an implementation of its own
 * wrote and the network's code is held to as well.
 */

describe("vectors/door-history.json", () => {
  it("says the protocol's numbers and public names", () => {
    expect(vectors.min_days).toBe(DOOR_HISTORY_MIN_DAYS);
    expect(vectors.recent_days).toBe(DOOR_HISTORY_RECENT_DAYS);
    expect(vectors.current_days).toBe(DOOR_HISTORY_CURRENT_DAYS);
    expect(vectors.public_types).toEqual(DOOR_HISTORY_PUBLIC_TYPES);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(15);
  });

  for (const c of vectors.cases) {
    it(c.name, () => {
      const got = doorHistoryOf(c.entry as unknown as DoorHistoryInput, c.as_of);
      expect(got).toEqual(c.expect);
      if (got !== null) expect(doorHistoryEntrySchema.safeParse(got).success).toBe(true);
    });
  }
});

describe("door_history on a listing, get_business and a check result", () => {
  const entry = doorHistoryOf(vectors.cases[2]?.entry as unknown as DoorHistoryInput, vectors.cases[2]?.as_of ?? "");

  it("is optional and checked when present", () => {
    const history = { as_of: "2026-11-13", doors: [entry] };
    expect(doorHistorySchema.safeParse(history).success).toBe(true);
    expect(
      doorHistorySchema.safeParse({
        as_of: "2026-11-13",
        doors: [{ ...entry, checks: { ...entry?.checks, days: 13 } }],
      }).success,
    ).toBe(false);
    expect(
      doorHistorySchema.safeParse({
        as_of: "2026-11-13",
        doors: [{ ...entry, checks: { ...entry?.checks, recent: "a" } }],
      }).success,
    ).toBe(false);
    expect(doorHistorySchema.safeParse({ as_of: "2026-11-13", doors: [{ ...entry, type: "llms_txt" }] }).success).toBe(
      false,
    );
    const listing = listingDetailSchema.shape.door_history;
    expect(listing.safeParse(undefined).success).toBe(true);
    expect(listing.safeParse(history).success).toBe(true);
    expect(getBusinessOutputSchema.shape.door_history.safeParse(history).success).toBe(true);
  });

  it("is in the published JSON Schemas of the detail, get_business and a check result", () => {
    for (const name of ["business", "mcp-get-business-output", "check-result", "mcp-check-business-output"]) {
      const s = jsonSchemaOf(name) as { properties: Record<string, unknown> };
      expect(s.properties.door_history, name).toBeDefined();
    }
  });
});
