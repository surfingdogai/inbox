import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Settings → Phone on the web, from any browser, at phone width (ADR-028 Amendment 4): an owner with
 * only a phone signs in there to remove an old phone, so each phone's lines keep their width and its
 * buttons sit under them, within reach, with nothing scrolling sideways.
 */
describe("Settings → Phone at phone width", () => {
  it("puts a phone's Send a test and Remove under its lines on a phone, so a phone-only owner can remove one", () => {
    // At phone width the row is one column, its buttons start on the left under the phone's lines.
    const css = readFileSync(path.resolve(import.meta.dirname, "../client/src/app.css"), "utf8");
    const narrow = css.slice(css.indexOf("@media (max-width: 600px) {\n  .phone-row {"));
    expect(narrow).toMatch(
      /^@media \(max-width: 600px\) \{\s*\.phone-row \{\s*grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(narrow.slice(0, narrow.indexOf("}\n}"))).toContain(".phone-row > .rowx {\n    justify-content: flex-start;");
    const page = readFileSync(path.resolve(import.meta.dirname, "../client/src/routes/settings.phone.tsx"), "utf8");
    expect(page).toContain('className="catalogue-row row-glass phone-row"');
  });
});
