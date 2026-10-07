import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixesOf, scoreOf, scoreRulesSchema } from "../../../packages/spec/src/index";
import scoreVectors from "../../../packages/spec/vectors/score.json";
import scoreRulesV1 from "../../../packages/spec/vocab/score-rules-v1.json";
import { AGENT_EXAMPLE, exampleCard } from "../src/lib/agent-example";
import {
  ago,
  CHECKED_HREF,
  COUNTED,
  countHref,
  countRows,
  looksLikeAddress,
  READY_HREF,
  readDirectory,
} from "../src/lib/ask";
import { resultView } from "../src/lib/results";
import { rulesFallback, rulesLine } from "../src/lib/rules";
import { capabilities, leastOf, stateOf } from "../src/lib/status";

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
  "src/pages/index.astro",
  "src/pages/search.astro",
  "src/pages/trust.astro",
  "src/components/AskBox.astro",
  "src/components/CopyBlock.astro",
  "src/components/DirectoryCounts.astro",
  "src/components/Products.astro",
  "src/lib/ask.ts",
  "src/lib/results.ts",
  "src/lib/rules.ts",
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
      "Sign up: Not applicable",
      "Cancel: Yes · MCP",
      "Negotiate: Not applicable",
    ]);
    expect(card.extra).toEqual([
      { label: "Pay", answer: "Partly" },
      { label: "Change a booking", answer: "No" },
    ]);
    expect(card.checked).toBe("2026-10-07");
  });

  it("who is named is said in the score rules' own words, in the FAQ and beside the leaderboards", () => {
    const rules = scoreRulesSchema.parse(scoreRulesV1);
    expect(rules.named).toContain("when it is agent-ready (askable or above); others are counted, not named.");
    expect(rules.named).toContain(
      "If your site tells AI systems not to use or train on its content, we don't name you or list you publicly.",
    );
    expect(rules.named).not.toMatch(/claim|badge/i);
    for (const path of ["src/pages/faq.astro", "src/components/Leaderboards.astro"]) {
      const text = visible(read(path)).replace(/\s+/g, " ");
      expect(text, path).toContain(rules.named);
      expect(text, path).not.toMatch(/own badge|claimed (its|their) listing/i);
    }
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

  it("/search checks a site without script, its hero adds no second check, and the bar and the footer link the checker and the leaderboards", () => {
    const hero = read("src/components/Hero.astro");
    expect(hero).not.toMatch(/<form/);
    expect(hero).not.toContain("btn-primary");
    expect(visible(hero)).not.toContain("Open doors to the agentic internet.");
    const search = read("src/pages/search.astro");
    expect(search).toMatch(
      /<noscript>[\s\S]*<form class="ns-check" method="post" action="\/check">[\s\S]*name="url"[\s\S]*<\/noscript>/,
    );
    expect(visible(search)).not.toMatch(/Filters narrow/);
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

describe("the home page and the three products", () => {
  it("the home page is the line, the box, the counts, two things to copy and the three products, and nothing else", () => {
    const home = read("src/pages/index.astro");
    for (const part of ["<AskBox", "<DirectoryCounts", "<CopyBlock", "<Products", "minimalFooter"]) {
      expect(home, part).toContain(part);
    }
    // The explainer moved to /search; none of its sections stay on the home page.
    for (const moved of [
      "<Hero",
      "<WhatAiSees",
      "<Leaderboards",
      "<FairOrder",
      "<ForBusinesses",
      "<OpenNetwork",
      "<Status",
    ]) {
      expect(home, moved).not.toContain(moved);
      expect(read("src/pages/search.astro"), moved).toContain(moved);
    }
    expect(home).toContain("https://surfingdog.ai/mcp");
    // Each copy is a heading, each button is named for what it copies, and only the address is monospace.
    const block = read("src/components/CopyBlock.astro");
    expect(block).toContain('<h2 class="cb-title">');
    expect(block).toMatch(/aria-label=\{`Copy: \$\{title\}`\}/);
    expect(block).toMatch(/aria-label=\{`Copy: \$\{title\}, in plain words`\}/);
    expect(block).toMatch(/<details class="cb-alt">/);
    expect(home.match(/\baddress\b\s*\n/g)?.length).toBe(1);
    expect(read("src/components/Products.astro")).toContain('<h3 class="p-name">');
    expect(home).toContain("Open doors to the agentic internet.");
    // The install line is the install page's, word for word, and points at the real guide.
    const line = (path: string) => read(path).match(/"(Install Surfing Dog Inbox for my business\.[^"]+)"/)?.[1];
    expect(line("src/pages/index.astro")).toBeDefined();
    expect(line("src/pages/index.astro")).toBe(line("src/pages/install.astro"));
    expect(line("src/pages/index.astro")).toContain("https://surfingdog.ai/install.md");
    expect(existsSync(site("public/install.md"))).toBe(true);
  });

  it("the box searches words and checks addresses", () => {
    for (const a of ["salon.example", "https://shop.example/menu", "www.café.example", "bike-repair.co.example:8443"]) {
      expect(looksLikeAddress(a), a).toBe(true);
    }
    for (const w of ["bakery", "hair salon", "bakery.", "dentist near me", "", "  ", "e.g", "1.5"]) {
      expect(looksLikeAddress(w), w).toBe(false);
    }
    const box = read("src/components/AskBox.astro");
    expect(box).toMatch(/action="\/search" method="get"/);
    expect(box).toMatch(/method="post" action="\/check"/);
  });

  it("what the home page says matches the status pills", () => {
    const home = visible(read("src/pages/index.astro"));
    const counts = visible(read("src/components/DirectoryCounts.astro"));
    // It lists and tracks agent-ready businesses, counts what the crawler checked, and its box
    // checks any address: the directory, the crawler, the businesses it finds and the checker are live.
    expect(home).toMatch(/lists and tracks agent-ready businesses/);
    expect(counts).toMatch(/businesses checked/);
    expect(read("src/components/AskBox.astro")).toMatch(/action="\/check"/);
    for (const id of ["directory", "crawler", "crawled", "checker", "search"]) expect(stateOf(id), id).toBe("live");
    // The Search product finds and checks: its pill is the least live of the parts it names.
    const products = read("src/components/Products.astro");
    expect(products).toContain('state: leastOf("search", "directory", "checker")');
    expect(leastOf("search", "directory", "checker")).toBe("live");
    expect(leastOf("search", "hosted")).toBe("coming");
    expect(leastOf("search", "reliability", "hosted")).toBe("coming");
    // Nothing live says it is not yet.
    for (const c of capabilities) {
      if (c.state === "live") expect(c.label, c.id).not.toMatch(/\b(yet|coming|being built|will)\b/i);
    }
  });

  it("the counts read the directory block, say nothing they did not read, and hide empty optional rows", () => {
    expect(readDirectory(null)).toBeNull();
    expect(readDirectory({ instances_online: 1 })).toBeNull();
    expect(readDirectory({ directory: { checked: 3, agent_ready: 1 } })).toBeNull();
    // Zeros the network could not take are no counts: the zero time, or a degraded API with nothing checked.
    const zeros = { checked: 0, agent_ready: 0, capabilities: {}, doors: {} };
    expect(readDirectory({ directory: { ...zeros, as_of: "0001-01-01T00:00:00Z" } })).toBeNull();
    expect(
      readDirectory({ status: { api: "degraded" }, directory: { ...zeros, as_of: "2026-10-07T12:00:00Z" } }),
    ).toBeNull();
    expect(
      readDirectory({ status: { api: "ok" }, directory: { ...zeros, as_of: "2026-10-07T12:00:00Z" } })?.checked,
    ).toBe(0);
    expect(
      readDirectory({ status: { api: "degraded" }, directory: { ...zeros, checked: 9, as_of: "2026-10-07T12:00:00Z" } })
        ?.checked,
    ).toBe(9);
    const d = readDirectory({
      directory: {
        checked: 1200,
        agent_ready: 300,
        capabilities: { message: 200, book: 0, order: 5, catalogue: 9, pay: 1, cancel: 0, negotiate: 4, x: "no" },
        doors: { mcp: 2 },
        as_of: "2026-10-07T12:00:00Z",
      },
    });
    expect(d).not.toBeNull();
    if (!d) return;
    expect(countRows(d).map((r) => `${r.n} ${r.label}`)).toEqual([
      "200 take messages",
      "0 take bookings",
      "5 take orders",
      "9 have a catalogue",
      "1 take payment",
      "4 negotiate",
    ]);
    // Sign up shows once a business does it, after orders.
    const withSignup = readDirectory({
      directory: {
        checked: 9,
        agent_ready: 4,
        capabilities: { message: 3, order: 1, signup: 2 },
        as_of: "2026-10-07T12:00:00Z",
      },
    });
    expect(withSignup && countRows(withSignup).map((r) => `${r.n} ${r.label}`)).toEqual([
      "3 take messages",
      "0 take bookings",
      "1 take orders",
      "2 sign up",
      "0 have a catalogue",
      "0 take payment",
    ]);
    // Every count links to the list of the businesses it counts.
    expect(CHECKED_HREF).toBe("/leaderboard");
    expect(READY_HREF).toBe("/leaderboard?ready=1");
    for (const c of COUNTED) expect(countHref(c.key)).toBe(`/leaderboard?can=${c.key}`);
    const counts = read("src/components/DirectoryCounts.astro");
    expect(counts).toMatch(/href=\{CHECKED_HREF\}/);
    expect(counts).toMatch(/href=\{READY_HREF\}/);
    expect(counts).toMatch(/a\.href = countHref\(r\.key\)/);
    const at = Date.parse("2026-10-07T12:00:00Z");
    expect(ago("2026-10-07T12:00:00Z", at + 20_000)).toBe("just now");
    expect(ago("2026-10-07T12:00:00Z", at + 6 * 60_000)).toBe("6 minutes ago");
    expect(ago("2026-10-07T12:00:00Z", at + 3_600_000)).toBe("1 hour ago");
  });

  it("a result says what the entry says, links to the business's own site, and invents nothing", () => {
    expect(resultView(null)).toBeNull();
    expect(resultView({ name: "No site" })).toBeNull();
    const found = resultView({
      domain: "crumb.example",
      name: "Crumb",
      level: "bookable",
      category: { primary: { label: "Bakery" } },
      place: { locality: "Porto", country: "PT" },
      accepts: { kinds: ["ask", "book"] },
      doors: [
        { type: "mcp", status: "live" },
        { type: "a2a", status: "down" },
      ],
      found: { checked_at: "2026-10-05T10:00:00Z" },
    });
    expect(found).toEqual({
      name: "Crumb",
      href: "https://crumb.example",
      where: "Bakery · Porto, PT",
      takes: "Takes messages, bookings",
      found: "Found on its own website, checked 5 Oct 2026.",
      tags: [
        { text: "Bookable", on: false },
        { text: "MCP", on: false },
      ],
    });
    const member = resultView({ domain: "inbox.example", name: "", answering: true, item_types: ["booking"] });
    expect(member?.name).toBe("inbox.example");
    expect(member?.tags[0]).toEqual({ text: "Answering", on: true });
    expect(member?.found).toBe("");
    expect(resultView({ domain: "x.example", url: "javascript:alert(1)" })?.href).toBe("https://x.example");
    // Door types as people say them: a platform by its name, "other" by its protocol or not at all.
    const tagsOf = (doors: unknown[]) => resultView({ domain: "d.example", doors })?.tags.map((t) => t.text);
    expect(
      tagsOf([
        { type: "platform:shopify", status: "live" },
        { type: "platform:square-online", status: "live" },
        { type: "other", status: "live" },
        { type: "other", status: "live", protocol: "ARP" },
        { type: "agent_inbox", status: "live" },
        { type: "some_long_unknown_type", status: "live" },
      ]),
    ).toEqual(["Shopify", "Square Online", "ARP", "Inbox"]);
  });

  it("the trust page states the rules in force from /v1/ranking, and its fallback never names an old version", () => {
    expect(
      rulesLine({
        version: 6,
        rules: "0.1.3",
        status: "in_force",
        effective_at: "2026-09-29T13:16:48Z",
        next: { version: 7, effective_at: "2026-10-23T00:00:00Z" },
      }),
    ).toEqual({
      now: "Version 6 (0.1.3), in force since 29 Sep 2026.",
      next: "Version 7 is announced, and takes effect on 23 Oct 2026.",
    });
    expect(rulesLine({ version: 7, status: "announced" })).toBeNull();
    expect(rulesFallback(Date.parse("2026-10-07T00:00:00Z")).now).toContain("Version 6");
    expect(rulesFallback(Date.parse("2026-10-23T00:00:00Z"))).toEqual({
      now: "Version 7 (0.2.0), in force since 23 Oct 2026.",
      next: "",
    });
  });

  it("every internal link in the bar, the footer and the product pages goes somewhere", () => {
    // Paths the network answers on this address (the proxy's list), and files in public/.
    const proxied = [/^\/check$/, /^\/leaderboard/, /^\/v1\//, /^\/mcp$/, /^\/b\//];
    const pages = [
      "src/components/Nav.astro",
      "src/components/Footer.astro",
      "src/components/Hero.astro",
      "src/components/FairOrder.astro",
      "src/components/Products.astro",
      "src/pages/index.astro",
      "src/pages/search.astro",
      "src/pages/trust.astro",
    ];
    const exists = (path: string) => {
      const p = path.replace(/[?#].*$/, "").replace(/\/+$/, "");
      if (p === "") return existsSync(site("src/pages/index.astro"));
      if (proxied.some((r) => r.test(p))) return true;
      if (p.startsWith("/docs")) return existsSync(site(`src/content/docs${p}.md`)) || p === "/docs";
      if (p.startsWith("/blog")) return true;
      return (
        existsSync(site(`src/pages${p}.astro`)) ||
        existsSync(site(`src/pages${p}/index.astro`)) ||
        existsSync(site(`public${p}`))
      );
    };
    for (const path of pages) {
      const hrefs = [...read(path).matchAll(/href(?:=|: )["'`](\/[^"'`{]*)["'`]/g)].map((m) => m[1] ?? "");
      for (const h of hrefs) expect(exists(h), `${path}: ${h}`).toBe(true);
    }
  });
});
