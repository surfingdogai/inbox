import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { doorHistoryPublic, doorHistoryShows } from "../src/lib/door-history";

/** A door's history (ADR-020) in the site's words: the share is named only while the network shows it. */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("a door's history on the site", () => {
  it("names the share of days answered only while it is shown, and the days seen answering either way", () => {
    for (const words of [doorHistoryShows, doorHistoryPublic]) {
      expect(words(false)).toMatch(/seen answering/);
      expect(words(false)).not.toMatch(/share|every check|14 days/);
      expect(words(true)).toMatch(/seen answering/);
      expect(words(true)).toMatch(/the share of days every check answered/);
    }
    expect(doorHistoryShows(true)).toMatch(/199 of 200 is 99%/);
  });

  it("is said through the switch on /network and /privacy, never written out", () => {
    for (const page of ["src/pages/network.astro", "src/pages/privacy.astro"]) {
      const src = read(page);
      expect(src, page).toMatch(/DOOR_SHARE_SHOWN/);
      expect(src, page).not.toMatch(/share of days every check answered/);
    }
  });

  it("never claims the history names no person", () => {
    for (const page of ["src/pages/network.astro", "src/pages/privacy.astro"]) {
      expect(read(page), page).not.toMatch(/names no person/);
    }
    expect(read("src/pages/privacy.astro")).toMatch(
      /Beyond the site's own web addresses it holds nothing\s+about a person/,
    );
  });
});
