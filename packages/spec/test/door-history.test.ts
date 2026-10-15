import { describe, expect, it } from "vitest";
import {
  DOOR_HISTORY_CURRENT_DAYS,
  DOOR_HISTORY_MIN_DAYS,
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
import doors from "../vocab/doors.json";

/**
 * A door's history (protocol §4.8, ADR-020) against `vectors/door-history.json`, which
 * `scripts/gen-door-history-vectors.py` wrote, independently of this code; the network's code is held to it as well.
 */

describe("vectors/door-history.json", () => {
  it("says the protocol's numbers", () => {
    expect(vectors.min_days).toBe(DOOR_HISTORY_MIN_DAYS);
    expect(vectors.recent_days).toBe(DOOR_HISTORY_RECENT_DAYS);
    expect(vectors.current_days).toBe(DOOR_HISTORY_CURRENT_DAYS);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(15);
  });

  for (const c of vectors.cases) {
    it(c.name, () => {
      const got = doorHistoryOf(c.entry as unknown as DoorHistoryInput, c.as_of);
      expect(got).toEqual(c.expect);
      if (got !== null) expect(doorHistoryEntrySchema.safeParse(got).success).toBe(true);
    });
  }

  it("shows every door type of the vocabulary and a platform's, never an experimental one or llms.txt", () => {
    const entry = {
      host: "salon.example",
      first_seen: "2026-10-03",
      last_seen: "2026-10-03",
      days_seen: 1,
      current: true,
      days: [],
    };
    for (const type of [...doors.types, "platform:fresha"]) {
      expect(doorHistoryOf({ ...entry, type }, "2026-10-16")?.type, type).toBe(type);
    }
    for (const type of [...doors.experimental, "llms.txt", "llms_txt", "agent_inbox", "page", ""]) {
      expect(doorHistoryOf({ ...entry, type }, "2026-10-16"), type).toBeNull();
    }
  });
});

describe("door_history on a listing, get_business and a check result", () => {
  const entry = doorHistoryOf(vectors.cases[2]?.entry as unknown as DoorHistoryInput, vectors.cases[2]?.as_of ?? "");

  it("is optional and checked when present", () => {
    const history = { as_of: "2026-11-13", doors: [entry] };
    expect(doorHistorySchema.safeParse(history).success).toBe(true);
    expect(
      doorHistorySchema.safeParse({
        as_of: "2026-11-13",
        doors: [{ ...entry, checks: { ...entry?.checks, days: 0 } }],
      }).success,
    ).toBe(false);
    expect(
      doorHistorySchema.safeParse({
        as_of: "2026-11-13",
        doors: [{ ...entry, checks: { ...entry?.checks, recent: "ab" } }],
      }).success,
    ).toBe(false);
    expect(doorHistorySchema.safeParse({ as_of: "2026-11-13", doors: [{ ...entry, days_seen: 0 }] }).success).toBe(
      false,
    );
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
