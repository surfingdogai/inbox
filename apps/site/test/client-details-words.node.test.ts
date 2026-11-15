import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What the docs and the API's own descriptions say of a new request's client hold to what an inbox does
 * (ADR-048): every new booking, order, request for a price, message and stay an assistant sends names its person
 * and an email address or a phone number, asked of the person first; none is said to be optional; the examples
 * people copy send them; and an order names what the business sells, at its prices.
 */
const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(repo(path), "utf8").replace(/\s+/g, " ");
const API = "apps/site/src/content/docs/docs/api.md";
const AGENTS = "apps/site/public/for-agents.md";
const MCP = "packages/adapters/src/mcp.ts";
const REST = "packages/adapters/src/rest.ts";

describe("what is said of a new request's client", () => {
  it("says a name and an email or a phone is needed, asked of the person, on every page and door that tells agents", () => {
    expect(read(API)).toContain(
      "carries its person's details in `contact`: `name`, and an `email` or a `phone` (at least one)",
    );
    expect(read(API)).toContain('`details.reason` `"client_details"`');
    expect(read(AGENTS)).toContain("their name, and an email or a phone (at least one)");
    expect(read(AGENTS)).toContain("Ask your person first, and send only what they agree to give the business.");
    expect(read(MCP)).toContain(
      "Needs your person's name and an email address or a phone number in contact: ask them first",
    );
    expect(read(MCP)).toContain(
      "Before you send anything new here, ask your person for their name and an email address or a phone number",
    );
    expect(read(REST)).toContain("Needs contact: your person's name, and an email address or a phone number");
    // The guide says the details are required, and the docs say what a detail is, letters in a phone included.
    expect(read(AGENTS)).toContain("The person's details are required: every new request carries their name");
    expect(read(API)).toContain("a phone number has 6 to 20 digits and no letters (no extension)");
    expect(read(API)).not.toContain("or any other client of these doors");
  });

  it("never calls the contact optional", () => {
    for (const f of [API, AGENTS, MCP, REST, "apps/site/src/content/docs/docs/mcp.md"]) {
      expect(read(f), f).not.toMatch(/an optional `?contact`?/);
      expect(read(f), f).not.toContain("and a name if they want one");
    }
  });

  it("gives copied examples a client: the try page's curl sends an email, the guide's sandbox booking a made-up one", () => {
    expect(read("apps/site/src/pages/try.astro")).toContain('contact: { name: "Rita", email: "rita@example.com" }');
    const connect = read("apps/site/public/connect.md");
    expect(connect).not.toContain("header and no contact");
    expect(connect).toContain('"contact": {"name": "Test", "email": "test@example.com"}');
  });

  it("says an assistant's order names what the business sells, at its prices", () => {
    expect(read(API)).toContain(
      "An assistant's order is for products the business sells, at its prices, in its currency.",
    );
    expect(read(MCP)).toContain("Order products this business sells at a fixed price, at the business's price");
    expect(read(API)).not.toContain("A line naming no product the business has");
  });
});
