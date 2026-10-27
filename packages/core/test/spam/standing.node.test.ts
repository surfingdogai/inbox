import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Trust only lifts (ADR-029 §1.3, R25), read in the code itself: no part of the spam filter reads
 * a person's standing at a network, their receipts, or the tier a rule could judge them by — only a
 * sender the business already knows (`reputed_principal`) skips the screening.
 */
describe("the spam filter's code", () => {
  it("no signal reads a person's standing: no code in the filter touches person, customer or agent records", () => {
    const dir = join(import.meta.dirname, "../../src/spam");
    const files = [
      ...readdirSync(dir).map((f) => join(dir, f)),
      ...readdirSync(join(dir, "signals")).map((f) => join(dir, "signals", f)),
    ].filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(
        /person_links|network_status|\breceipts\b.*SELECT|\.tier\b(?!.*reputed_principal)|customer\.no_shows|person\.(tier|standing)/,
      );
    }
  });
});
