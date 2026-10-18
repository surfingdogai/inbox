import { existsSync, readdirSync, readFileSync } from "node:fs";
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
import { hostedOwnership } from "../src/lib/hosted";
import { OWN_WORD_NOTE, recordNote, recordView, UNCONFIRMED_NOTE } from "../src/lib/record";
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
  "src/components/TrustFlow.astro",
  "src/lib/record.ts",
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
    // A check's live page streams a read as it happens; it is never a page to index, so every
    // crawler is kept off it, in the one group they all read.
    const everyone = robots.split(/\n\s*\n/).find((g) => /^User-agent: \*$/m.test(g)) ?? "";
    expect(everyone).toMatch(/^Disallow: \/b\/\*\/live$/m);
    expect(robots.match(/^User-agent:/gm)).toHaveLength(1);
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
      expect(text, path).toContain('{ href: "/guides/", label: "Guides" }');
    }
    const footer = read("src/components/Footer.astro");
    expect(footer).toContain('href: "/about/"');
    expect(footer).toContain('href: "/faq/"');
  });

  it("a field's example is a name a business would have, never a reserved .example name", () => {
    const astro = (dir: string): string[] =>
      readdirSync(site(dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? astro(`${dir}/${e.name}`) : e.name.endsWith(".astro") ? [`${dir}/${e.name}`] : [],
      );
    const files = [...astro("src/pages"), ...astro("src/components")];
    expect(files.length).toBeGreaterThan(10);
    for (const path of files) {
      expect(read(path), path).not.toMatch(/placeholder="[^"]*\bexample\b/);
    }
    expect(read("src/pages/search.astro")).toContain('placeholder="yourbusiness.com"');
    expect(read("src/components/GuideCheck.astro")).toContain('placeholder="yourbusiness.com"');
  });
});

describe("the setup guidance", () => {
  const DOC = "src/content/docs/docs/setting-up-for-agents.md";
  const PLAIN = "public/setting-up-for-agents.md";
  const withoutUrls = (text: string) => text.replace(/https?:\/\/[^\s)>"`]+/g, " ");
  const headings = (text: string) => text.split("\n").filter((l) => /^#{2,3} /.test(l));
  const privateWords = (process.env.SITE_PRIVATE_WORDS ?? "")
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);

  it("says it is guidance and not rules, in the page, its Markdown copy, install.md and llms.txt", () => {
    for (const path of [DOC, PLAIN]) {
      expect(read(path), path).toContain("**It is guidance, not a set of rules.**");
      expect(read(path), path).toContain("a business may use other tools and other ways");
    }
    const opening = read("public/install.md").split("Read this whole file")[0] ?? "";
    expect(opening).toContain("https://surfingdog.ai/setting-up-for-agents.md");
    expect(opening).toContain("It is guidance, not rules");
    const config = read("astro.config.mjs");
    expect(config).toContain("https://surfingdog.ai/setting-up-for-agents.md");
    expect(config).toContain("recommendations and not rules");
    expect(config).toContain('"docs/setting-up-for-agents"');
    expect(read("src/content/docs/docs/index.md")).toContain("(/docs/setting-up-for-agents/)");
  });

  it("the Markdown copy has the page's sections, in the same order, and absolute links", () => {
    expect(headings(read(PLAIN))).toEqual(headings(read(DOC)));
    expect(read(PLAIN)).toMatch(/^# Setting a business up for agents: guidance\n/);
    expect(read(PLAIN)).not.toMatch(/\]\(\/(?!\/)/);
  });

  it("makes no claim of being first or alone, names no real business, and dates what moves fast", () => {
    for (const path of [DOC, PLAIN]) {
      const text = withoutUrls(read(path));
      expect(text, path).not.toMatch(/\b(first|only|verified|people free)\b/i);
      expect(text, path).toContain("Written on 9 October 2026");
      expect(text, path).toContain("as of October 2026");
    }
  });

  it.skipIf(privateWords.length === 0)("names no person, business or host (SITE_PRIVATE_WORDS)", () => {
    for (const path of [DOC, PLAIN]) {
      const words = new Set(
        read(path)
          .toLowerCase()
          .split(/[^a-z0-9]+/),
      );
      for (const w of privateWords) expect(words.has(w), `${path}: a private word`).toBe(false);
    }
  });

  it("says where it comes from without naming or placing anyone, and speaks of payments for any country", () => {
    for (const path of [DOC, PLAIN]) {
      const text = read(path);
      expect(text, path).toContain("It comes from a shop we worked with for a week");
      expect(text, path).not.toMatch(/grocer|online shop in|a UK |alongside a /i);
      expect(text, path).toContain("## Payments, as of October 2026");
      expect(text, path).not.toMatch(/UK and the EU/);
      for (const place of ["Brazil", "India", "Australia", "Europe"])
        expect(text, `${path}: ${place}`).toContain(place);
    }
    expect(read("astro.config.mjs")).not.toMatch(/UK and the EU/);
    // No page or file the site publishes says where the guidance came from.
    const files = (dir: string): string[] =>
      readdirSync(site(dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? files(`${dir}/${e.name}`)
          : /\.(md|astro|ts|txt|json|mjs)$/.test(e.name)
            ? [`${dir}/${e.name}`]
            : [],
      );
    for (const path of [...files("src"), ...files("public"), "astro.config.mjs"]) {
      expect(read(path), path).not.toMatch(/grocer/i);
    }
  });

  it("says what our crawler reads of an inbox: the llms.txt line with the manifest's address, never the DNS record", () => {
    for (const path of [DOC, PLAIN]) {
      const text = read(path);
      expect(text, path).toContain(
        "- Inbox for messages, quotes and returns: https://inbox.example.com/.well-known/agent-inbox.json",
      );
      expect(text, path).toMatch(
        /ends in `\/\.well-known\/agent-inbox\.json`: that is how our crawler tells an inbox in `llms\.txt`/,
      );
      expect(text, path).toContain("Our crawler does not look this record up");
    }
  });

  it("every link on this site that the page makes goes somewhere", () => {
    const hrefs = [...read(DOC).matchAll(/\]\((\/[^)\s]*)\)/g)].map((m) => m[1] ?? "");
    expect(hrefs.length).toBeGreaterThan(5);
    for (const h of hrefs) {
      const p = h.replace(/[?#].*$/, "").replace(/\/+$/, "");
      const found = p.startsWith("/docs/")
        ? existsSync(site(`src/content/docs${p}.md`))
        : existsSync(site(`public${p}`)) || existsSync(site(`src/pages${p}.astro`));
      expect(found, h).toBe(true);
    }
  });
});

describe("the home page and the three products", () => {
  it("the home page is the line, the box, the counts, a line on checking a business, two things to copy and the three products, and nothing else", () => {
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

  it("the inbox is the business's own, and the network is a separate choice that records receipts", () => {
    // An assistant read the site and concluded that installing the inbox puts a business on Surfing Dog.
    // It does not: the inbox runs at the business's own address and nobody sits in the middle. Once
    // the hosted pilot opens, that is said of an inbox the business runs itself (src/lib/hosted.ts).
    const faq = visible(read("src/pages/faq.astro"));
    expect(faq).toContain('q: "Does my business move onto Surfing Dog?"');
    expect(faq).toMatch(/a:\s*["']No\. Surfing Dog Inbox is open-source software/);
    expect(faq).toContain("HOSTED_OWNERSHIP.faq +");
    for (const open of [true, false]) {
      expect(hostedOwnership(open).faq).toContain(
        "Surfing Dog is not in the middle of a message, a booking, an order or a payment",
      );
    }
    const opening = read("public/install.md").split("Read this whole file")[0] ?? "";
    expect(opening).toContain("**The inbox is the business's own.**");
    expect(opening).toContain("does not put the business on Surfing Dog");
    expect(opening).toMatch(/Joining a network \(Step 5\) is optional and separate/);
    const llms = read("astro.config.mjs");
    expect(llms).toContain(`\${HOSTED_OWNERSHIP.llms}`);
    expect(hostedOwnership(false).llms).toContain("Installing it does not put a business on Surfing Dog");
    expect(llms).toContain("https://surfingdog.ai/network#shared");
    // The short version of what a network gets never says it gets nothing about customers: the
    // detailed list (install.md Step 5, /network#shared) includes a first-time customer's email.
    for (const path of ["src/pages/faq.astro", "src/pages/trust.astro", "src/components/Products.astro"]) {
      expect(visible(read(path)), path).not.toMatch(/never (your|its) customers/i);
    }
    expect(visible(read("src/pages/network.astro"))).not.toMatch(/directory of inboxes/);
  });

  it("the home page asks whether an assistant can book with you, and every blog post links the checker", () => {
    const home = read("src/pages/index.astro");
    expect(home).toContain('<h2 class="ready-h" id="ready-h">Can a customer\'s AI assistant book with you?</h2>');
    expect(home).toContain('<a class="link" href="/check">check your business</a>');
    expect(home).toContain('href="/guides/"');
    const posts = readdirSync(site("src/content/blog")).filter((f) => f.endsWith(".md"));
    expect(posts.length).toBeGreaterThanOrEqual(7);
    for (const f of posts) expect(read(`src/content/blog/${f}`), f).toMatch(/\]\(\/check\)/);
    expect(read("src/content/blog/what-ai-assistants-need-from-your-business.md")).toMatch(/\]\(\/guides\/\)/);
    expect(visible(read("src/pages/faq.astro"))).toContain('<a href="/guides/">guides</a>');
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
    // It lists and tracks agent-ready businesses, counts them (how many were checked stays internal), and its box
    // checks any address: the directory, the crawler, the businesses it finds and the checker are live.
    expect(home).toMatch(/lists and tracks agent-ready businesses/);
    expect(counts).toMatch(/agent-ready businesses/);
    expect(counts).not.toMatch(/businesses checked/);
    expect(read("src/components/AskBox.astro")).toMatch(/action="\/check"/);
    for (const id of ["directory", "crawler", "crawled", "checker", "search"]) expect(stateOf(id), id).toBe("live");
    // The Search product finds and checks: its pill is the least live of the parts it names.
    const products = read("src/components/Products.astro");
    expect(products).toContain('state: leastOf("search", "directory", "checker")');
    expect(leastOf("search", "directory", "checker")).toBe("live");
    // Against a part that stays coming whichever way the hosted pilot's switch is (src/lib/hosted.ts).
    expect(leastOf("search", "fan-out")).toBe("coming");
    expect(leastOf("search", "reliability", "fan-out")).toBe("coming");
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
    expect(counts).not.toMatch(/CHECKED_HREF/); // how many were checked stays internal
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

describe("the trust page's animation", () => {
  const PATH = "src/components/TrustFlow.astro";
  const source = read(PATH);
  const front = source.split(/^---$/m)[1] ?? "";
  const template = source.split(/^---$/m)[2] ?? "";
  const style = template.match(/<style is:global>([\s\S]*?)<\/style>/)?.[1] ?? "";
  const script = template.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

  type Geo = {
    rows: { name: string; level: number }[];
    pass: { r: number; over: number };
    row: { h: number; slots: number[]; notches: number };
    link: { x0: number; y0: number; bend: number; x1: number };
    ask: string;
    road: string;
    sign: string;
    seals: { ib: number[]; ag: number[]; r: number };
    inbox: { x: number; y: number; w: number };
    item: { y: number };
    net: { x: number };
    say: { phrases: string[] };
    at: {
      loop: number;
      rest: number;
      say: number[];
      reset: number[];
      ask: number[];
      item: number;
      kept: number;
      slip: number;
      seal: number;
      sign: number[];
      road: number[];
      notch: number;
      swap: number[];
      settle: number[];
      coin: number[];
    };
  };
  /** GEO as the figure carries it: the object literal in the frontmatter, through JSON and back. */
  function geo(): Geo {
    const literal = front.match(/const GEO = (\{[\s\S]*?\n\});/)?.[1];
    expect(literal, "GEO").toBeDefined();
    const value: unknown = new Function(`return (${literal});`)();
    return JSON.parse(JSON.stringify(value)) as Geo;
  }

  it("is on /trust, in the hero's art-box beside the words, as the network page places its own", () => {
    const page = read("src/pages/trust.astro");
    expect(page).toContain('import TrustFlow from "../components/TrustFlow.astro";');
    expect(page).toMatch(/<section class="wrap section is-head top"[^>]*>\s*<div class="copy">/);
    expect(page).toMatch(/<div class="art-box">\s*<TrustFlow \/>\s*<\/div>/);
    expect(page.indexOf("<TrustFlow />")).toBeLessThan(page.indexOf('id="how-h"'));
  });

  it("its geometry parses as the JSON the script reads, and its timeline is in order", () => {
    const G = geo();
    const A = G.at;
    expect(source).toContain("data-tf={JSON.stringify(GEO)}");
    expect(G.rows.length).toBeGreaterThanOrEqual(3);
    expect(G.row.slots.length).toBe(G.rows.length);
    for (const r of G.rows) expect(r.level).toBeLessThan(G.row.notches);
    // One phrase per time, every time inside the loop, in order.
    expect(A.say.length).toBe(G.say.phrases.length);
    for (const [i, t] of A.say.entries()) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(A.loop);
      if (i > 0) expect(t).toBeGreaterThan(A.say[i - 1] ?? 0);
    }
    const marks = [
      ...A.reset,
      ...A.ask,
      A.item,
      A.kept,
      A.slip,
      A.seal,
      ...A.sign,
      ...A.road,
      A.notch,
      ...A.swap,
      ...A.settle,
      ...A.coin,
    ];
    for (const m of marks) expect(m >= 0 && m < A.loop, String(m)).toBe(true);
    // The story in order: ordered, kept, signed, counter-signed, sent, counted, reordered, settled,
    // then the coin.
    const story = [
      A.ask[0],
      A.item,
      A.kept,
      A.slip,
      A.seal,
      A.sign[0],
      A.sign[1],
      A.road[0],
      A.road[1],
      A.notch,
      A.swap[0],
      A.swap[1],
    ];
    expect([...story].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(story);
    expect(A.settle[0]).toBeGreaterThan(A.swap[1] ?? 0);
    expect(A.coin[0]).toBeGreaterThan(A.settle[1] ?? 0);
  });

  it("puts up one short phrase at a time, each on screen long enough to read", () => {
    const G = geo();
    const A = G.at;
    for (const p of G.say.phrases) {
      expect(p.split(/\s+/).length, p).toBeLessThanOrEqual(6);
      expect(p, p).not.toMatch(/[!?]|\d/);
    }
    // 1.2 s is the shortest that five words can be read in; the last phrase holds over the wrap.
    for (const [i, t] of A.say.entries()) {
      const next = A.say[i + 1] ?? A.loop + (A.say[0] ?? 0);
      expect(next - t, G.say.phrases[i]).toBeGreaterThanOrEqual(1.2);
    }
    // The strip has one text node, written only after the old phrase has faded.
    expect(template.match(/class="tf-phrase/g)?.length).toBe(1);
    expect(script).toMatch(
      /phrase\.classList\.remove\("on"\);[\s\S]*?hold\(170, \(\) => \{\s*phrase\.textContent = want;/,
    );
  });

  it("never moves the order under the words that say nobody can pay for a place", () => {
    const G = geo();
    const A = G.at;
    const coda = G.say.phrases.findIndex((p) => /pay for a place/.test(p));
    expect(coda).toBe(G.say.phrases.length - 1);
    const from = A.say[coda] ?? 0;
    const until = A.loop + (A.say[0] ?? 0) + 0.17; // the first phrase is written 0.17 s after its time
    const during = (t: number) => (t >= from && t < A.loop) || t + A.loop < until;
    // The rows trade places, and go back at the top of the loop, only while another phrase is up.
    const flip = ((A.reset[0] ?? 0) + (A.reset[1] ?? 0)) / 2;
    for (const t of [flip, ...A.swap]) expect(during(t), String(t)).toBe(false);
    expect(A.reset[0]).toBeGreaterThanOrEqual(A.say[0] ?? 0);
    // The coin falls and goes while that phrase is up.
    for (const t of A.coin) expect(during(t), String(t)).toBe(true);
  });

  it("renders at rest: the server draws the resting frame whole, and the script starts from that same moment", () => {
    const G = geo();
    const A = G.at;
    expect(template).toMatch(/<svg class="tf-seed" viewBox="0 0 520 390"/);
    expect(style).toMatch(/aspect-ratio: 520 \/ 390;/);
    // The resting moment is after the swap and before the receipt settles, so one frame holds the
    // kept order, the signed receipt docked on its listing, the new notch and the new order.
    expect(A.rest).toBeGreaterThan(A.swap[1] ?? 0);
    expect(A.rest).toBeLessThan(A.settle[0] ?? 0);
    expect(A.rest).toBeGreaterThan(A.kept);
    expect(A.rest).toBeGreaterThan(A.notch);
    expect(template).toContain('class="tf-item on res"');
    expect(template).toContain('class="tf-slip signed cosigned"');
    expect(template).toContain('"tf-notch on new"');
    expect(template).toContain('class={gained ? "tf-dir hit" : "tf-dir"}');
    expect(template).toContain("{say.phrases[restSay]}");
    expect(front).toMatch(/const restSay = GEO\.at\.say\.filter\(\(t\) => t <= GEO\.at\.rest\)\.length - 1;/);
    // The script clones the seed, swaps the clone in whole, starts its clock at rest, and a throw
    // leaves the seed standing.
    expect(script).toContain("seed.cloneNode(true)");
    expect(script).toContain("seed.replaceWith(svg)");
    expect(script).toContain("let clock = A.rest;");
    expect(script).toMatch(/try \{\s*mount\(f\);\s*\} catch/);
  });

  it("has the customer's agent sign the receipt too: after the inbox, before it travels, on its own line", () => {
    const G = geo();
    const A = G.at;
    // The captions, one per beat, in the order the story is told.
    expect(G.say.phrases).toEqual([
      "A business keeps its promise",
      "Its inbox signs a receipt",
      "The customer's AI signs it too",
      "Just the receipt travels",
      "Its record grows a notch",
      "The order follows kept promises",
      "Nobody can pay for a place",
    ]);
    const at = (p: RegExp) => {
      const i = G.say.phrases.findIndex((x) => p.test(x));
      expect(i, String(p)).toBeGreaterThan(-1);
      return [A.say[i] ?? 0, A.say[i + 1] ?? A.loop] as const;
    };
    // The counter-sign beat comes after the inbox has signed and before the receipt sets off.
    expect(A.sign[0]).toBeGreaterThan(A.seal);
    expect(A.sign[1]).toBeGreaterThan(A.sign[0] ?? 0);
    expect(A.road[0]).toBeGreaterThan(A.sign[1] ?? 0);
    // And the receipt, signed twice, holds still long enough to be seen, its second seal's pop
    // (0.6 s) done before the receipt moves or the words change.
    expect((A.road[0] ?? 0) - (A.sign[1] ?? 0)).toBeGreaterThanOrEqual(0.6);
    expect((A.say[3] ?? 0) - (A.sign[1] ?? 0)).toBeGreaterThanOrEqual(0.6);
    expect(style).toMatch(/\.stf \.tf-slip\.copop \.seal\.ag \{\s*animation: stf-pop 0\.6s /);
    // Each beat happens under its own words: the inbox's seal, the agent's whole journey, the travel.
    const [inboxFrom, inboxTo] = at(/inbox signs/);
    expect(A.seal).toBeGreaterThanOrEqual(inboxFrom);
    expect(A.seal).toBeLessThan(inboxTo);
    const [coFrom, coTo] = at(/AI signs it too/);
    expect(A.sign[0]).toBeGreaterThanOrEqual(coFrom);
    expect(A.sign[1]).toBeLessThanOrEqual(coTo);
    const [goFrom, goTo] = at(/receipt travels/);
    expect(A.road[0]).toBeGreaterThanOrEqual(goFrom);
    expect(A.road[1]).toBeLessThanOrEqual(goTo);
    // The agent's seal leaves on the agent's own line, never reaches the network, and lands on the
    // receipt's second seal where the receipt is born.
    expect(G.sign.startsWith(G.ask)).toBe(true);
    const xs = [...G.sign.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[1]));
    for (const x of xs) expect(x, String(x)).toBeLessThanOrEqual(G.inbox.x + G.inbox.w);
    expect(Math.max(...xs)).toBeLessThan(G.net.x);
    // In the groove between the inbox's hairline and the order's row, the travelling seal and its
    // faint ring clear both.
    const groove = Number(G.sign.match(/L[\d.]+,([\d.]+)/)?.[1]);
    const ring = Number(script.match(/r: G\.seals\.r \+ ([\d.]+), class: "rim"/)?.[1]);
    const ringW = Number(style.match(/\.stf \.tf-ink \.rim \{[^}]*stroke-width: ([\d.]+);/)?.[1]);
    const outer = G.seals.r + ring + ringW / 2;
    expect(groove - outer, "the hairline").toBeGreaterThan(G.inbox.y + 36 + 0.5);
    expect(groove + outer, "the order's row").toBeLessThan(G.item.y);
    const birth = G.road.match(/^M(-?[\d.]+),(-?[\d.]+)/);
    const landing = G.sign.match(/(-?[\d.]+),(-?[\d.]+)$/);
    expect(Number(landing?.[1])).toBeCloseTo(Number(birth?.[1]) + (G.seals.ag[0] ?? 0), 6);
    expect(Number(landing?.[2])).toBeCloseTo(Number(birth?.[2]) + (G.seals.ag[1] ?? 0), 6);
    // Two seals that do not touch, inside the paper, on either side of its middle.
    expect(G.seals.ag[0] ?? 0).toBeLessThan(0);
    expect(G.seals.ib[0] ?? 0).toBeGreaterThan(0);
    // A gap of at least 1.5 units, so even at a phone's width they read as two seals, not one dot.
    expect((G.seals.ib[0] ?? 0) - (G.seals.ag[0] ?? 0) - 2 * G.seals.r).toBeGreaterThanOrEqual(1.5);
    for (const [x, y] of [G.seals.ib, G.seals.ag]) {
      expect(Math.abs(x ?? 0) + G.seals.r, "inside the paper's inner edge").toBeLessThanOrEqual(6.5);
      expect((y ?? 0) + G.seals.r, "inside the paper's inner edge").toBeLessThanOrEqual(8.5);
    }
    // At rest the receipt carries both seals, filled: the inbox's in palm, the agent's in violet.
    expect(A.rest).toBeGreaterThan(A.sign[1] ?? 0);
    expect(A.rest).toBeLessThan(A.settle[1] ?? 0);
    expect(template).toMatch(
      /<g class="tf-slip signed cosigned"[\s\S]*?class="seal ib" \/>[\s\S]*?class="seal ag" \/>/,
    );
    expect(style).toMatch(/\.stf \.tf-slip\.signed \.seal\.ib \{\s*fill: var\(--tf-palm\);/);
    expect(style).toMatch(/\.stf \.tf-slip\.cosigned \.seal\.ag \{\s*fill: var\(--tf-violet\);/);
    // On the agent's line violet means only the signature: the order travels in its own tangerine.
    expect(style).toMatch(/\.stf \.tf-dot \{\s*fill: var\(--tf-order\);/);
    // The machine follows the same path and fills the second seal as the agent's seal lands.
    expect(script).toContain('E("path", { d: G.sign, class: "tf-guide" })');
    expect(script).toContain('slip.classList.toggle("cosigned", t >= A.sign[1] && t < A.settle[1]);');
    // And the screen reader hears it.
    const words = visible(source);
    expect(words).toMatch(/customer's agent signs the same receipt too/);
    expect(words).toMatch(/carrying both\s+signatures/);
  });

  it("points the receipts' route at the bakery's listing wherever it is, at rest and in motion", () => {
    const G = geo();
    const A = G.at;
    const centre = (slot: number) => (G.row.slots[slot] ?? 0) + G.row.h / 2;
    // The receipt travels while the listing is still in its first place, and the road ends there.
    expect(A.road[1]).toBeLessThan(A.swap[0] ?? 0);
    const end = G.road.match(/(-?[\d.]+),(-?[\d.]+)$/);
    expect(Number(end?.[2])).toBe(centre(G.pass.r));
    expect(G.road).toContain(`L${G.link.x0},${G.link.y0} C${G.link.bend},${G.link.y0}`);
    expect(G.road).toContain(`${G.link.x1},${centre(G.pass.r)}`);
    // At rest the listing has moved up, and the route's far end and its door are drawn to it there.
    const slotAtRest = G.rows.map((_, i) => (i === G.pass.r ? G.pass.over : i === G.pass.over ? G.pass.r : i));
    expect(slotAtRest[G.pass.r]).toBe(G.pass.over);
    expect(front).toMatch(/const passY = row\.slots\[slotAtRest\[GEO\.pass\.r\] \?\? 0\] \?\? 0;/);
    expect(front).toContain("const door = passY + row.h / 2;");
    expect(template).toContain('<path d={linkTo(door)} class="tf-line tf-link" />');
    expect(template).toContain('<circle cx={L.x1} cy={door} r="2.6" class="tf-port tf-door" />');
    // The script draws the same route from the same numbers, and moves its end with the listing.
    const build =
      /const linkTo = \(y: number\) => `M\$\{L\.x0\},\$\{L\.y0\} C\$\{L\.bend\},\$\{L\.y0\} \$\{L\.bend\},\$\{y\} \$\{L\.x1\},\$\{y\}`;/;
    expect(front).toMatch(build);
    expect(script).toMatch(build);
    expect(script).toContain('linkEl.setAttribute("d", linkTo(doorY));');
    expect(script).toContain('doorEl.setAttribute("cy", String(doorY));');
  });

  it("gives the picture at rest a strip wide enough for the phrase at a phone's type size", () => {
    // The container query grows the phrase; the seed's phone strip is estimated at that same size.
    const query = style.match(/@container \(max-width: 460px\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
    const size = query.match(/\.stf \.tf-phrase \{\s*font-size: ([\d.]+)px;/)?.[1];
    expect(size).toBeDefined();
    expect(front).toContain(`est(p, ${size}) + 34`);
    // Shown only in the seed and only below the breakpoint, where the desktop strip steps out.
    expect(template).toMatch(/<rect x=\{sayXn\}[^>]*class="tf-narrow" \/>/);
    expect(template).toMatch(/<circle cx=\{sayXn \+ 12\}[^>]*class="tf-beat tf-narrow" \/>/);
    expect(style).toMatch(/\.stf \.tf-narrow \{\s*display: none;/);
    expect(query).toMatch(/\.stf \.tf-seed \.tf-narrow \{\s*display: inline;/);
    expect(query).toMatch(/\.stf \.tf-seed \.tf-wide \{\s*display: none;/);
    // The live clone drops it before it finds the strip it measures.
    const drop = script.indexOf('for (const el of all(svg, ".tf-narrow")) el.remove();');
    expect(drop).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(script.indexOf('const sayRect = one<SVGRectElement>(sayG, "rect");'));
  });

  it("holds still under reduced motion, from the start or when it is turned on later", () => {
    expect(script).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(script).toMatch(/if \(mq\.matches\) \{\s*still\(\);\s*return;\s*\}/);
    expect(script).toMatch(/mq\.addEventListener\("change"/);
    const media = style.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
    expect(media).toMatch(/\.stf \* \{\s*animation: none !important;\s*transition: none !important;/);
    expect(style).toMatch(
      /\.stf\.tf-still \*,\s*\.stf\.tf-still \{\s*animation: none !important;\s*transition: none !important;/,
    );
    // Off-screen or in a hidden tab the clock stops.
    expect(script).toContain("IntersectionObserver");
    expect(script).toContain('addEventListener("visibilitychange"');
  });

  it("names no red: tokens and written colours are ink, the order's tangerine, palm, violet and sun, and the brand's mark is Mark.astro's", () => {
    // The brand's own mark keeps the brand's own gradient, exactly as Mark.astro draws it.
    const gradient = template.match(/<linearGradient id="tfseed-g"[\s\S]*?<\/linearGradient>/)?.[0] ?? "";
    const stops = (s: string) => [...s.matchAll(/stop-color="var\((--[a-z]+), (#[0-9a-f]{6})\)"/g)].map((m) => m[1]);
    expect(stops(gradient)).toEqual(["--tangerine", "--flamingo", "--violet"]);
    expect(stops(read("src/components/Mark.astro"))).toEqual(["--tangerine", "--flamingo", "--violet"]);
    const rest = source
      .replace(gradient, " ")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/<!--[\s\S]*?-->/g, " ");
    expect(rest).not.toMatch(/--(?:c-)?(?:danger|flamingo|booking|refund|warning)(?:-ink)?\b/);
    expect(rest).not.toMatch(/\bred\b/i);
    const literals = [
      ...[...rest.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)].map((m) => {
        const h = m[1] ?? "";
        const x = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
        return [0, 2, 4].map((i) => Number.parseInt(x.slice(i, i + 2), 16));
      }),
      ...[...rest.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)].map((m) => [m[1], m[2], m[3]].map(Number)),
    ];
    expect(literals.length).toBeGreaterThan(10);
    for (const [r = 0, g = 0, b = 0] of literals) {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max - min < 40) continue; // grey, white or black
      const hue =
        max === r
          ? (60 * ((g - b) / (max - min)) + 360) % 360
          : max === g
            ? 60 * ((b - r) / (max - min)) + 120
            : 60 * ((r - g) / (max - min)) + 240;
      expect(hue > 20 && hue < 330, `rgb(${r}, ${g}, ${b})`).toBe(true);
    }
    // Night redefines the fallbacks under both the media query and the theme attribute.
    expect(style).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \.stf \{/);
    expect(style).toContain('[data-theme="dark"] .stf {');
  });

  it("draws only what the page says is live, with illustrative businesses, and asks nothing of the network", () => {
    const G = geo();
    // Drawn working: receipts and the order that reads them, nobody paying included.
    expect(stateOf("receipts")).toBe("live");
    expect(stateOf("ranking")).toBe("live");
    expect(capabilities.find((c) => c.id === "ranking")?.label).toMatch(/nobody can pay/i);
    // Not drawn: the per-listing track record is live, but its counts are words on the listing's
    // page (kept, broken, still open), never a picture; customers' records are paused, so the agent
    // carries no record, and no listing here says late or broken.
    expect(stateOf("reliability")).toBe("live");
    const words = visible(source);
    expect(words).not.toMatch(/track record|\blate\b|\bbroken\b|\bscore|\bstars?\b|\brating/i);
    expect(template).not.toMatch(/tf-pip|class="pip/);
    // The record is a meter of notches: no numbers in any phrase, any name or the drawing's words.
    expect(G.say.phrases.join(" ")).not.toMatch(/\d/);
    // The businesses are named by their kind, so none can be a real one.
    for (const r of G.rows) expect(r.name, r.name).toMatch(/^[A-Z][a-z]+$/);
    expect(G.rows.some((r) => r.name === "Bakery")).toBe(true);
    // The order goes from the agent to the business; what reaches the network is the receipt.
    expect(words).toMatch(/orders bread from a bakery, directly/);
    expect(words).toMatch(/no names, no messages and nothing of what was ordered/);
    // No external requests: the only address is the SVG namespace.
    expect([...source.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0])).toEqual(["http://www.w3.org/2000/svg"]);
    expect(script).not.toMatch(/\bfetch\(|XMLHttpRequest|import\(/);
  });
});

describe("the track record", () => {
  const member = (extra: Record<string, unknown>) => ({
    domain: "salon.example.com",
    name: "Salon",
    source: "member",
    manifest_url: "https://salon.example.com/.well-known/agent-inbox.json",
    receipts: { issued: 12, acknowledged: 0 },
    ...extra,
  });
  // A member's track_record as the network gives it (docs/protocol/network.md §4.3).
  const threshold = { closed: 5, customers: 3 };
  const record = (extra: Record<string, unknown>) => ({
    state: "shown",
    in_words: "",
    as_of: "2026-10-12T00:00:00Z",
    closed: 12,
    customers: 5,
    kept: 9,
    broken: 3,
    unclosed: 1,
    refunds_late: 1,
    from: "2026-03-04T10:00:00Z",
    to: "2026-10-09T18:00:00Z",
    confirmed: 0,
    confirmable: false,
    threshold,
    rules_url: "https://network.example.com/v1/ranking?version=6",
    ...extra,
  });

  it("is live on the status list, in words that promise no lateness the network does not count", () => {
    expect(stateOf("reliability")).toBe("live");
    const label = capabilities.find((c) => c.id === "reliability")?.label ?? "";
    expect(label).toMatch(/kept, broken and still open/);
    // Rules version 8: a record on the business's own word shows no score until a fifth is confirmed.
    expect(label).toMatch(/the business's own word, with no score, until its customers confirm a fifth of it/);
    expect(label).not.toMatch(/\blate\b|\b(yet|coming|being built|will)\b/i);
  });

  it("the trust page says where it shows, the threshold, the held 30 days, and that no counter-signature is checked", () => {
    const text = visible(read("src/pages/trust.astro")).replace(/\s+/g, " ");
    expect(text).not.toMatch(/kept, late or broken/);
    expect(text).toMatch(/a refund paid late is broken/);
    expect(text).toMatch(/surfingdog\.ai\/b\//);
    expect(text).toMatch(/once at least 5 promises have closed/);
    expect(text).not.toMatch(/from at least 3 customers/);
    expect(text).toMatch(/not in the 30 days after a business joins/);
    // Rules version 8: a record on the business's own word is its counts, no score, no customers.
    expect(text).toMatch(/Until its customers confirm at least a fifth of it, a record is self-reported/);
    expect(text).toMatch(/with no score and no count of customers, and it is not ranked/);
    expect(text).toMatch(/today it cannot check one: it needs an assistant platform's key it recognises/);
    expect(text).toMatch(/0\.40 and its customers confirmed at least a fifth of it/);
    for (const path of ["src/content/docs/docs/index.md", "src/content/docs/docs/receipts.md"]) {
      const doc = read(path).replace(/\s+/g, " ");
      expect(doc, path).toMatch(/track record/);
      expect(doc, path).not.toMatch(/reviews and reputation \(coming\)/);
    }
    const receipts = read("src/content/docs/docs/receipts.md").replace(/\s+/g, " ");
    expect(receipts).toMatch(/It shows once at least 5 promises have closed/);
    expect(receipts).toMatch(/is \*\*self-reported\*\*: the business's own word, shown as its counts, with no score/);
    expect(receipts).toMatch(/today there is neither, so every track record is self-reported/);
    // The network page no longer says a counter-signature counts today, when none can be checked.
    expect(read("src/pages/network.astro")).not.toMatch(/verified customer's agent signs already counts/);
    // What a business's record makes public, and when: the outcome counts and the score from the
    // start, the track record once the threshold is met. It never understates what is published.
    const network = read("src/pages/network.astro").replace(/\s+/g, " ");
    expect(network).toMatch(/a count of how its promises ended, from its first receipt/);
    expect(network).toMatch(
      /as its own word, with no score, until its customers confirm at least a fifth of its record/,
    );
    expect(network).toMatch(/once at least 5 promises have closed/);
    expect(network).not.toMatch(/its score, counted each night/);
    expect(network).not.toMatch(/Public, on its listing once enough promises have closed/);
  });

  it("shows nothing for an entry that is not a member, and one calm line for a member with no receipts", () => {
    expect(recordView(null)).toBeNull();
    expect(recordView({ domain: "shop.example.com", source: "found", found: {} })).toBeNull();
    expect(recordView({ domain: "shop.example.com", source: "registered" })).toBeNull();
    const none = recordView(member({ receipts: { issued: 0, acknowledged: 0 } }));
    expect(none?.text).toBe("A track record appears once its inbox sends signed receipts.");
    expect(none?.href).toBe("/docs/receipts/");
    expect(none?.link).toBe("How receipts work");
    expect(none?.kept).toBeUndefined();
    expect(recordView(member({ track_record: { state: "none", in_words: "", threshold } }))?.text).toBe(none?.text);
    // A member with receipts and no record from the network: nothing is made up.
    expect(recordView(member({}))).toBeNull();
  });

  it("says a new member's 30 days are held, with the date its record is counted from", () => {
    const held = recordView(
      member({ track_record: { state: "held", in_words: "", held_until: "2026-10-22T00:00:00Z", threshold } }),
    );
    expect(held?.text).toBe(
      "A new member's receipts are held for 30 days; its track record is counted from 22 Oct 2026.",
    );
    expect(held?.href).toBe("/b/salon.example.com");
    expect(held?.kept).toBeUndefined();
    const pending = recordView(member({ track_record: { state: "pending", in_words: "", threshold } }));
    // Pending promises only a count, not a record: the next count may still be below the threshold.
    expect(pending?.text).toBe("Its receipts are counted for a track record at the next nightly count.");
    expect(pending?.text).not.toMatch(/shows/);
  });

  it("below the threshold, says how many have closed so far, from how many customers, and draws no meter", () => {
    const gathering = (closed: number, customers: number) =>
      recordView(member({ track_record: { state: "gathering", in_words: "", closed, customers, threshold } }));
    expect(gathering(4, 2)?.text).toBe(
      "Not enough receipts yet for a track record (4 closed so far, from 2 customers).",
    );
    expect(gathering(4, 2)?.kept).toBeUndefined();
    expect(gathering(1, 1)?.text).toBe(
      "Not enough receipts yet for a track record (1 closed so far, from 1 customer).",
    );
    expect(gathering(0, 0)?.text).toBe("Not enough receipts yet for a track record (none closed so far).");
    // Rules version 8: a self-reported record has no count of customers, and says whose word it is.
    const own = (closed: number) =>
      recordView(
        member({
          track_record: { state: "gathering", in_words: "", closed, self_reported: true, threshold: { closed: 5 } },
        }),
      );
    expect(own(2)?.text).toBe(
      "Not enough receipts yet for a track record (2 closed so far, on the business's own word).",
    );
    expect(own(0)?.text).toBe("Not enough receipts yet for a track record (none closed so far).");
    expect(own(2)?.kept).toBeUndefined();
    // A record that is not self-reported and names no customers is not made up.
    expect(recordView(member({ track_record: { state: "gathering", in_words: "", closed: 2, threshold } }))).toBeNull();
  });

  it("from rules version 8, a self-reported record is its counts and still open, labelled, with no meter and no customers", () => {
    const own = recordView(
      member({
        track_record: record({ self_reported: true, customers: undefined, open: 2, threshold: { closed: 5 } }),
      }),
    );
    expect(own?.text).toBe(
      "Self-reported · 9 kept · 3 broken (1 left open 9 days past due, 1 refund paid late) · 2 still open · 4 Mar 2026 – 9 Oct 2026",
    );
    expect(own?.selfReported).toBe(true);
    expect(own?.kept).toBeUndefined();
    expect(own?.text).not.toMatch(/customer|%|\d\.\d|score/);
    expect(own?.note).toBe(UNCONFIRMED_NOTE);
    // Confirmed in part, still on its own word: how many of the closed, never a share.
    const some = recordView(
      member({
        track_record: record({ self_reported: true, customers: undefined, open: 0, confirmable: true, confirmed: 1 }),
      }),
    );
    expect(some?.text).toMatch(/^Self-reported · .* · 0 still open · .* · 1 of 12 confirmed by the customer's side$/);
    expect(some?.note).toBe(OWN_WORD_NOTE);
    // A fifth confirmed: not self-reported, so its customers and the meter, and still open beside them.
    const fifth = recordView(member({ track_record: record({ open: 2, confirmable: true, confirmed: 3 }) }));
    expect(fifth?.text).toBe(
      "9 kept · 3 broken (1 left open 9 days past due, 1 refund paid late) · 2 still open · from 5 customers · 4 Mar 2026 – 9 Oct 2026 · 3 of 12 confirmed by the customer's side",
    );
    expect(fifth?.kept).toBe(0.75);
    expect(fifth?.selfReported).toBeUndefined();
  });

  it("above it, counts kept and broken with why, customers and dates, and the kept share for the meter", () => {
    const shown = recordView(member({ track_record: record({}) }));
    expect(shown?.text).toBe(
      "9 kept · 3 broken (1 left open 9 days past due, 1 refund paid late) · from 5 customers · 4 Mar 2026 – 9 Oct 2026",
    );
    expect(shown?.kept).toBe(0.75);
    expect(shown?.link).toBe("Track record");
    expect(shown?.href).toBe("/b/salon.example.com");
    expect(shown?.confirmable).toBe(false);
    const clean = recordView(
      member({
        track_record: record({ kept: 1200, broken: 0, unclosed: 0, refunds_late: 0, to: "2026-03-04T23:00:00Z" }),
      }),
    );
    expect(clean?.text).toBe("1,200 kept · 0 broken · from 5 customers · 4 Mar 2026");
    expect(clean?.kept).toBe(1);
    // Counts that are not whole numbers the network sent are not shown at all.
    expect(recordView(member({ track_record: record({ kept: "9" }) }))).toBeNull();
    expect(recordView(member({ track_record: record({ state: "unknown" }) }))).toBeNull();
  });

  it("never shows a confirmed share, says a confirmed count of the closed, and says once under a list whose word the rest is", () => {
    // Nothing can be confirmed yet: no count is said, and the list says why.
    const none = recordView(member({ track_record: record({ confirmable: false, confirmed: 0 }) }));
    expect(none?.text).not.toMatch(/confirmed/);
    expect(none?.note).toBe(UNCONFIRMED_NOTE);
    // It could be confirmed and none is: the list still says the counts are the business's own word.
    const notYet = recordView(member({ track_record: record({ confirmable: true, confirmed: 0 }) }));
    expect(notYet?.text).not.toMatch(/confirmed/);
    expect(notYet?.note).toBe(OWN_WORD_NOTE);
    // Some confirmed: how many of the closed, and the rest is the business's own word.
    const some = recordView(member({ track_record: record({ confirmable: true, confirmed: 2 }) }));
    expect(some?.confirmable).toBe(true);
    expect(some?.text).toMatch(/· 2 of 12 confirmed by the customer's side$/);
    expect(some?.text).not.toMatch(/%/);
    expect(some?.note).toBe(OWN_WORD_NOTE);
    // Confirmed before nothing more could be (customer scoring paused): still said, never "cannot".
    const paused = recordView(member({ track_record: record({ confirmable: false, confirmed: 2 }) }));
    expect(paused?.text).toMatch(/· 2 of 12 confirmed by the customer's side$/);
    expect(paused?.note).toBe(OWN_WORD_NOTE);
    // All confirmed: nothing is the business's own word, and no note.
    const all = recordView(member({ track_record: record({ confirmable: true, confirmed: 12 }) }));
    expect(all?.text).toMatch(/· all 12 confirmed by the customer's side$/);
    expect(all?.note).toBeUndefined();
    // Lines that are not a record need no note.
    const held = recordView(
      member({ track_record: { state: "held", in_words: "", held_until: "2026-10-22T00:00:00Z", threshold } }),
    );
    expect(held?.note).toBeUndefined();
    // Under a list: the strongest note any row needs, once.
    expect(recordNote([])).toBe("");
    expect(recordNote([held, all, null])).toBe("");
    expect(recordNote([all, some])).toBe(OWN_WORD_NOTE);
    expect(recordNote([some, none, notYet])).toBe(UNCONFIRMED_NOTE);
    expect(UNCONFIRMED_NOTE).toMatch(/cannot check one/);
    for (const note of [UNCONFIRMED_NOTE, OWN_WORD_NOTE]) {
      expect(note).not.toMatch(/\b(first|only|verified)\b|%/i);
      expect(note).toMatch(/business's own word/);
    }
    for (const path of ["src/pages/directory.astro", "src/pages/search.astro"]) {
      const page = read(path);
      expect(page, path).toContain("recordView(");
      expect(page, path).toContain("recordNote(records)");
      // The meter is drawn for the eye only: its words are printed beside it.
      expect(page, path).toMatch(/data-record-meter aria-hidden="true"/);
      expect(page, path).not.toMatch(/data-record-meter role="img"|aria-label", rec\.text/);
      // The note is never hidden just because a record could be confirmed.
      expect(page, path).not.toMatch(/rec\.confirmable\)/);
      expect(page, path).not.toMatch(/--(?:c-)?(?:danger|flamingo|tangerine|warning)\b/);
      expect(page, path).toMatch(/var\(--c-success\)/);
    }
  });
});

describe("what the directory and the connector claim", () => {
  it("/directory shows members first, labels found entries with what was found and when, and links a manifest only when there is one", () => {
    const page = read("src/pages/directory.astro");
    const text = visible(page);
    expect(text).not.toContain("Each business here proved it owns its domain");
    expect(page).toContain('page("source=member&limit=100")');
    // "Found by our crawler" lists what the crawler found, never a business that registered itself.
    expect(page).toContain('page("source=found&limit=50")');
    expect(page).not.toContain("source=registered,found");
    expect(page.indexOf('page("source=member')).toBeLessThan(page.indexOf('page("source=found'));
    expect(page).toContain("found.note");
    expect(text).toContain("Found by our crawler");
    expect(text).toContain("These are not members and run no inbox with us.");
    // No manifest URL made up for a business that has none.
    expect(page).not.toContain("/.well-known/agent-inbox.json`");
    expect(page).toContain('if (typeof b.manifest_url === "string" && b.manifest_url) manifest.href = b.manifest_url;');
    expect(page).toContain("else manifest.remove();");
  });

  it("says the connector finds and links, and never that it books, orders or lists verified businesses", () => {
    for (const path of [
      "src/pages/assistants/index.astro",
      "src/pages/assistants/[slug].astro",
      "src/pages/index.astro",
    ]) {
      const text = visible(read(path));
      expect(text, path).toMatch(/finds and links/);
      expect(text, path).not.toMatch(/verified businesses/);
    }
  });
});
