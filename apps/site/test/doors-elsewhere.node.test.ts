import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import vocabulary from "../../../packages/spec/vocab/door-platforms.json";

/**
 * Docs → Booked or ordered elsewhere (ADR-035): the page lists every platform the owner app's chooser offers, by the
 * vocabulary's own names and groups, and never words a door as a connection or an integration.
 */
const page = readFileSync(
  fileURLToPath(new URL("../src/content/docs/docs/connectors/elsewhere.md", import.meta.url)),
  "utf8",
);

describe("the doors elsewhere page", () => {
  it("names every platform and group of vocab/door-platforms.json", () => {
    for (const g of vocabulary.groups) expect(page, g.label).toContain(`**${g.label}**`);
    for (const p of vocabulary.platforms) expect(page, p.name).toContain(p.name);
  });

  it("never calls a door elsewhere a connection or an integration", () => {
    expect(page).not.toMatch(/\bconnect (to )?(fresha|opentable|toast|shopify|woocommerce|square|calendly)/i);
    expect(page).not.toMatch(/integration/i);
  });

  it("says nothing of what platforms charge but that it is between the business and the platform", () => {
    expect(page).not.toMatch(/share of each sale/i);
    expect(page).toContain("What a platform charges you is between you and it.");
  });
});
