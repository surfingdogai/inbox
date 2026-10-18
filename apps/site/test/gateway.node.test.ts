import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASSISTANT_STEPS, CARRY_PROMISE, MCP_URL, REACH_WORDS, SUPPORT } from "../src/lib/gateway";

/**
 * Surfing Dog in a person's own assistant (ADR-020): the promise, word for word wherever carried
 * requests are described; every assistant's steps with their source, and "not yet" where it cannot
 * take a server of one's own; the support page; the MCP docs naming every tool.
 */
const site = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(site(path), "utf8");

describe("carried requests, as the site says them", () => {
  it("are promised in the words decided for them", () => {
    expect(CARRY_PROMISE).toBe(
      "Surfing Dog never touches the money and never keeps what anyone writes. When a business allows it, we carry an assistant's request to the business's own inbox and keep only a record that it was delivered.",
    );
    for (const page of ["src/pages/assistants/index.astro", "src/pages/support.astro", "src/pages/privacy.astro"]) {
      expect(read(page), page).toContain("{CARRY_PROMISE}");
    }
    expect(read("src/content/docs/docs/mcp.md")).toContain(`> ${CARRY_PROMISE}`);
  });

  it("are described as the server carries them: an email, never a phone, and only a record kept", () => {
    const docs = read("src/content/docs/docs/mcp.md");
    for (const tool of [
      "search_businesses",
      "get_business",
      "check_business",
      "ask_business",
      "request_quote",
      "request_booking",
      "report_door",
      "register_business",
      "update_business",
    ]) {
      expect(docs, tool).toContain(`\`${tool}\``);
    }
    expect(docs).toContain("Never a phone number.");
    expect(docs).toContain("`consent: true`");
    expect(docs).toContain('carried_requests: {"accepted": false}');
    const privacy = read("src/pages/privacy.astro");
    expect(privacy).toContain("We never carry a phone number.");
    expect(privacy).toContain("never who sent");
  });
});

describe("each assistant's steps", () => {
  it("cover the nine assistants, each with its maker's page, and say not yet where there is no way", () => {
    expect(ASSISTANT_STEPS.map((a) => a.name)).toEqual([
      "ChatGPT",
      "Claude",
      "Gemini",
      "Le Chat",
      "Grok",
      "Perplexity",
      "Copilot",
      "Meta AI and Muse",
      "dots",
    ]);
    for (const a of ASSISTANT_STEPS) {
      expect(a.source.href, a.name).toMatch(/^https:\/\//);
      expect(a.steps.length, a.name).toBeGreaterThan(0);
      expect(REACH_WORDS[a.reach], a.name).toBeTruthy();
      // A way in names the address; a "not yet" says so in its own words.
      if (a.reach === "not_yet") expect(a.steps.join(" "), a.name).toMatch(/not yet|no way|no server/i);
      else expect(a.steps.join(" "), a.name).toContain(MCP_URL);
    }
    expect(ASSISTANT_STEPS.filter((a) => a.reach === "not_yet").map((a) => a.slug)).toEqual([
      "microsoft-copilot",
      "dots",
    ]);
  });

  it("are on the assistants page, folded, each with its pill", () => {
    const hub = read("src/pages/assistants/index.astro");
    expect(hub).toContain("ASSISTANT_STEPS.map");
    expect(hub).toContain("<details>");
    expect(hub).toContain("REACH_WORDS[a.reach]");
    expect(hub).toContain("value={MCP_URL}");
  });
});

describe("support", () => {
  it("names one address for each thing, and is linked from every footer", () => {
    expect(SUPPORT).toEqual({
      email: "hello@surfingdog.ai",
      privacy: "privacy@surfingdog.ai",
      abuse: "abuse@surfingdog.ai",
    });
    const page = read("src/pages/support.astro");
    for (const k of ["SUPPORT.email", "SUPPORT.privacy", "SUPPORT.abuse"]) expect(page, k).toContain(k);
    expect(page).toContain('href="/assistants/"');
    expect(page).toContain('href="/privacy/"');
    expect(read("src/components/Footer.astro").match(/href: "\/support\/"/g)?.length).toBe(2);
  });
});
