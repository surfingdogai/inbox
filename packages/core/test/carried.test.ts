import { manifestSchema } from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import { buildManifest } from "../src/manifest";
import { readPingCarried } from "../src/network/carried";
import { mergeSettings } from "../src/settings/merge";
import { DEFAULT_SETTINGS, settingsSchema } from "../src/settings/schema";

/**
 * Requests a network carries for people's AI assistants (ADR-025): on for every inbox unless the
 * owner switches them off, and said in the manifest either way, so a network can tell an inbox that
 * has the switch from one from before it (which says nothing, and is carried nothing). Node and workerd.
 */
describe("carried requests", () => {
  it("are on by default, and the manifest says so", () => {
    expect(DEFAULT_SETTINGS.carried.accepted).toBe(true);
    const m = buildManifest({
      instanceUrl: "https://inbox.example.com",
      itemTypes: ["message"],
      carried: DEFAULT_SETTINGS.carried,
    });
    expect(m.carried_requests).toEqual({ accepted: true });
    expect(manifestSchema.parse(m).carried_requests).toEqual({ accepted: true });
    // Without the setting (an inbox from before the switch, as a network reads it): nothing said.
    expect(buildManifest({ instanceUrl: "https://inbox.example.com", itemTypes: ["message"] })).not.toHaveProperty(
      "carried_requests",
    );
  });

  it("switched off, are refused in the manifest, to every network at once", () => {
    const off = settingsSchema.parse(mergeSettings(DEFAULT_SETTINGS, { carried: { accepted: false } }));
    expect(off.carried.accepted).toBe(false);
    const m = buildManifest({ instanceUrl: "https://inbox.example.com", itemTypes: ["message"], carried: off.carried });
    expect(m.carried_requests).toEqual({ accepted: false });
    expect(manifestSchema.parse(m).carried_requests).toEqual({ accepted: false });
  });

  it("are read from a network's ping answer leniently", () => {
    expect(readPingCarried(null)).toBeNull();
    expect(readPingCarried({ delivered: 1 })).toBeNull();
    expect(
      readPingCarried({
        since: "2026-09-18T10:00:00Z",
        delivered: 2.5,
        confirm: 1,
        not_delivered: { failed: 2, x: -1 },
      }),
    ).toEqual({ since: "2026-09-18T10:00:00Z", delivered: 0, confirm: 1, not_delivered: { failed: 2 } });
  });
});
