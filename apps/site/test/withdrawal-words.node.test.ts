import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What the docs and the API's own descriptions say of withdrawal hold to what an inbox does (ADR-018
 * Amendment 7): a contract keeps the law it was made under, with no date after which it loses its right;
 * a right to cancel is promised only where the inbox applies one, named as the inbox names it (the EU, the
 * EEA, Gibraltar or the UK, or no country set), never "where the business's country's law gives one",
 * which Brazil's or Japan's own law also does; a message passed on says why only where there is a reason;
 * Gibraltar is held to the 14 days as the EU, the EEA and the UK are; and elsewhere the settings' returns
 * are never said to be the published policy.
 */
const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(repo(path), "utf8");
const API = "apps/site/src/content/docs/docs/api.md";
const SAID = [
  API,
  "apps/site/src/content/docs/docs/concepts.md",
  "apps/site/src/content/docs/docs/your-page.md",
  "apps/site/public/for-agents.md",
  "docs/adr/018-negotiation.md",
  "docs/protocol/network.md",
  "packages/adapters/src/mcp.ts",
  "packages/adapters/src/rest.ts",
  "packages/adapters/src/responses.ts",
  "packages/spec/src/network/catalogue-policies.ts",
];

describe("what is said of withdrawal", () => {
  it("names no date after which a contract loses its right: it keeps the law it was made under", () => {
    for (const f of SAID) expect(read(f), f).not.toMatch(/10 November 2026|OTHER_LAW_FROM/);
    expect(read(API)).toContain("a contract keeps it whatever the business's country becomes after");
  });

  it("promises a right to cancel only where the inbox applies one, and names where that is", () => {
    const page = read("apps/site/src/content/docs/docs/your-page.md");
    expect(page).toContain(
      "their right to cancel where the business's country is in the EU, the EEA, Gibraltar or the UK, or none is set",
    );
    expect(page).not.toContain("their right to cancel)");
    for (const f of [...SAID, "docs/adr/047-catalogue-v2.md", "packages/core/src/settings/schema.ts"]) {
      const text = read(f).replace(/\s+/g, " ");
      expect(text, f).not.toMatch(
        /(?:business's|your) (?:own )?country(?:'s law)? gives (?:one|the right|that right)|law of the business's (?:own )?country gives/,
      );
    }
  });

  it("never says the settings' returns are the published policy where the business is elsewhere", () => {
    const api = read(API).replace(/\s+/g, " ");
    expect(api).not.toContain("and every product without one of its own uses the default. Your returns settings are");
    expect(api).toContain("elsewhere only a policy you write is published");
  });

  it("says why a message was passed on only where there is a reason, and what asks a summary again", () => {
    for (const f of [API, "packages/adapters/src/rest.ts"]) {
      expect(read(f), f).toContain("saying why where there is a reason");
      expect(read(f), f).not.toMatch(/passed_on`?, saying why\)/);
    }
    expect(read(API)).toContain("a change in the law it would be made under, or in a return policy it tells");
    expect(read(API)).not.toContain("the law its summary told");
  });

  it("holds Gibraltar to the 14 days with the EU, the EEA and the UK", () => {
    for (const f of ["docs/protocol/network.md", "packages/spec/src/network/catalogue-policies.ts"]) {
      const text = read(f).replace(/\s+/g, " ");
      expect(text, f).toContain("the EU, the EEA, Gibraltar and the UK");
      expect(text, f).not.toMatch(/the EU, the EEA and the UK|the EU, the EEA or the UK/);
    }
  });
});
