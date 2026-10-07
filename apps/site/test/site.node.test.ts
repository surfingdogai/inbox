import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixesOf, scoreOf, scoreRulesSchema } from "../../../packages/spec/src/index";
import scoreVectors from "../../../packages/spec/vectors/score.json";
import scoreRulesV1 from "../../../packages/spec/vocab/score-rules-v1.json";
import { AGENT_EXAMPLE, exampleCard } from "../src/lib/agent-example";

/**
 * The site's words and its example, checked without a build: the pages and components the checker
 * brought in say "Agentic score" and never a competitor's name for it, make no claim of being first
 * or alone, never say "verified", and name no person, host or server; the home page's example card
 * shows exactly what the published rules give for its states.
 */
const site = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(site(path), "utf8");

/** What a reader sees of a source file: comments, styles and scripts removed. */
function visible(source: string): string {
  return source
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const NEW_OR_CHANGED = [
  "src/components/AgentCard.astro",
  "src/components/Hero.astro",
  "src/components/WhatAiSees.astro",
  "src/components/Leaderboards.astro",
  "src/components/Nav.astro",
  "src/components/Footer.astro",
  "src/pages/about.astro",
  "src/pages/faq.astro",
  "src/lib/agent-example.ts",
  "src/lib/status.ts",
  "public/robots.txt",
];

describe("the checker's pages and components", () => {
  it("say Agentic score, and make no claim of being first, alone, people free or verified", () => {
    for (const path of NEW_OR_CHANGED) {
      const text = visible(read(path));
      expect(text, path).not.toMatch(/Agent ?Readiness|AgentReady/i);
      expect(text, path).not.toMatch(/\b(first|only|verified|people free)\b/i);
      expect(text, path).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    }
  });

  // The words themselves are private, so they come from the environment of whoever runs the check.
  const privateWords = (process.env.SITE_PRIVATE_WORDS ?? "")
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  it.skipIf(privateWords.length === 0)("name no person and no host (SITE_PRIVATE_WORDS)", () => {
    for (const path of NEW_OR_CHANGED) {
      const words = new Set(
        read(path)
          .toLowerCase()
          .split(/[^a-z0-9]+/),
      );
      for (const w of privateWords) expect(words.has(w), `${path}: a private word`).toBe(false);
    }
  });

  it("the example card is score.json's homepage-example: 72, B, and the answers its states give", () => {
    const rules = scoreRulesSchema.parse(scoreRulesV1);
    const vector = scoreVectors.cases.find((c) => c.name === "homepage-example");
    expect(vector).toBeDefined();
    expect(vector?.profile).toBe(AGENT_EXAMPLE.profile);
    // The vector names every capability; the example names those that apply, and agrees on each.
    for (const [id, state] of Object.entries(vector?.states ?? {})) {
      expect(AGENT_EXAMPLE.states[id] ?? "na", id).toBe(state);
    }
    const r = scoreOf("appointments", AGENT_EXAMPLE.states, rules);
    expect({ score: r.score, grade: r.grade }).toEqual({ score: AGENT_EXAMPLE.score, grade: AGENT_EXAMPLE.grade });
    expect({ score: r.score, grade: r.grade }).toEqual({ score: vector?.expect.score, grade: vector?.expect.grade });
    expect(fixesOf("appointments", AGENT_EXAMPLE.states, rules)).toEqual(vector?.expect.fixes);

    const card = exampleCard();
    expect(card.domain).toMatch(/\.example$/);
    expect(card.answers.map((a) => `${a.label}: ${a.answer}${a.door ? ` · ${a.door}` : ""}`)).toEqual([
      "Message: Yes · A2A",
      "Book: Yes · MCP",
      "Order: Not applicable",
      "Cancel: Yes · MCP",
      "Negotiate: Not applicable",
    ]);
    expect(card.extra).toEqual([
      { label: "Pay", answer: "Partly" },
      { label: "Change a booking", answer: "No" },
    ]);
    expect(card.checked).toBe("2026-10-07");
  });

  it("robots.txt allows search and AI use and names both sitemaps; the AI catalog comes from the network", () => {
    const robots = read("public/robots.txt");
    expect(robots).toContain("Content-Signal: search=yes, ai-input=yes, ai-train=yes");
    expect(robots).toContain("Sitemap: https://surfingdog.ai/sitemap-index.xml");
    expect(robots).toContain("Sitemap: https://surfingdog.ai/sitemap-checks.xml");
    // The catalog is proxied from the network, so its tool list has one source.
    expect(existsSync(site("public/.well-known/ai-catalog.json"))).toBe(false);
  });

  it("llms.txt points agents at the checker, the score's rules, the leaderboards and the discovery documents", () => {
    const config = read("astro.config.mjs");
    for (const url of [
      "https://surfingdog.ai/check",
      "https://surfingdog.ai/v1/score-rules",
      "https://surfingdog.ai/leaderboard",
      "https://surfingdog.ai/.well-known/ai-catalog.json",
      "https://surfingdog.ai/.well-known/mcp/server-card.json",
      "https://surfingdog.ai/.well-known/agent-card.json",
    ]) {
      expect(config, url).toContain(url);
    }
    expect(config).not.toMatch(/version 6\)/);
  });

  it("the hero checks a site with a plain form, and the bar and the footer link the checker and the leaderboards", () => {
    const hero = read("src/components/Hero.astro");
    expect(hero).toMatch(/<form class="hero-check" method="post" action="\/check">/);
    expect(hero).toMatch(/name="url"/);
    expect(hero).toContain('placeholder="yoursite.example"');
    expect(hero).toContain(">Check your business</a>");
    for (const path of ["src/components/Nav.astro", "src/components/Footer.astro"]) {
      const text = read(path);
      expect(text, path).toContain('href: "/check"');
      expect(text, path).toContain('href: "/leaderboard"');
    }
    const footer = read("src/components/Footer.astro");
    expect(footer).toContain('href: "/about/"');
    expect(footer).toContain('href: "/faq/"');
  });
});
