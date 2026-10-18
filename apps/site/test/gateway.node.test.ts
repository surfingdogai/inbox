import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ASSISTANT_STEPS,
  CARRY_PROMISE,
  CONNECTOR_NAME,
  HOSTED_KEEPS,
  MCP_URL,
  REACH_ORDER,
  REACH_WORDS,
  SUPPORT,
} from "../src/lib/gateway";

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
    expect(docs).toContain('carried_requests: {"accepted": true}');
    expect(docs).toContain("The business can answer your person by email.");
    const privacy = read("src/pages/privacy.astro");
    expect(privacy).toContain("We never carry a phone number.");
    expect(privacy).toContain("never who sent");
    // What is passed, all of it: the details, the language, the retry key and the sender's daily code.
    for (const said of ["the details of", "the language you want", "a key made from", "a code that tells"]) {
      expect(privacy, said).toContain(said);
    }
    // Nothing promises that the business will answer: it can.
    for (const page of ["src/pages/privacy.astro", "src/pages/support.astro", "src/content/docs/docs/mcp.md"]) {
      expect(read(page), page).not.toMatch(/(?:it|business) answers (?:you|your person) by email/);
    }
    // The promise is the network's; a hosted inbox keeps what its customers write, for the business.
    for (const page of ["src/pages/support.astro", "src/pages/privacy.astro"])
      expect(read(page), page).toContain("{HOSTED_KEEPS}");
    expect(HOSTED_KEEPS).toContain("hosted inbox is the business's own");
  });
});

describe("each assistant's steps", () => {
  it("cover the nine assistants, each with its maker's page, and say not yet where there is no way", () => {
    // In reach order: what works first, "not yet" last.
    expect(ASSISTANT_STEPS.map((a) => a.name)).toEqual([
      "Claude",
      "Gemini",
      "Le Chat",
      "ChatGPT",
      "Grok",
      "Meta AI and Muse",
      "Perplexity",
      "Copilot",
      "dots",
    ]);
    const order = ASSISTANT_STEPS.map((a) => REACH_ORDER.indexOf(a.reach));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // One name for the connector, everywhere a step names it.
    for (const a of ASSISTANT_STEPS) {
      for (const step of a.steps) {
        if (/named?|called/i.test(step))
          expect(step, a.name).toMatch(new RegExp(`${CONNECTOR_NAME}|${CONNECTOR_NAME.replaceAll(" ", "")}`));
      }
      // A pill never claims more than was checked; a source is the page that was read, not a help centre's home.
      expect(new URL(a.source.href).pathname.length, a.name).toBeGreaterThan(1);
    }
    expect(ASSISTANT_STEPS.find((a) => a.slug === "perplexity")?.reach).toBe("unconfirmed");
    expect(REACH_WORDS.unconfirmed).toBe("Not confirmed");
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
    // For people only: a business is pointed to its own page in one line.
    expect(hub).toContain('href="/inbox/assistants/"');
    expect(hub).not.toContain("ASSISTANTS.map");
    expect(hub).toContain("location.hash");
    const biz = read("src/pages/inbox/assistants.astro");
    expect(biz).toContain("ASSISTANTS.map");
    expect(biz).toContain("{CHECKED}");
    expect(biz).not.toContain("STEPS_CHECKED");
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
