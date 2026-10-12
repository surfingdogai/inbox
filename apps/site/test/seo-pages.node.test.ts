import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import scoreRulesV2 from "../../../packages/spec/vocab/score-rules-v2.json";
import { ASSISTANTS, OWNER_AS_OF, OWNER_CHECKED } from "../src/lib/assistants";
import { type Faq, faqPage } from "../src/lib/faq";
import { GUIDES, HUB, PLATFORM_PAGES, wordCount } from "../src/lib/guides";
import {
  SHOPIFY,
  SHOPIFY_AS_OF,
  SHOPIFY_CHANNELS,
  SHOPIFY_CHECKED,
  SHOPIFY_DOORS,
  SHOPIFY_FAQS,
  SHOPIFY_SOURCES,
} from "../src/lib/shopify";

/**
 * The pages that answer what owners search for: "can ChatGPT book appointments" on each assistant's
 * page, Shopify and AI assistants, the readiness checklist (the guides' hub) and agentic commerce
 * readiness (the selling guide). Each has a title and a description that fit a search result, its
 * questions are the same words on the page and in its FAQPage data, what it says about another
 * company's product is dated and sourced, its links go somewhere, and its words stay plain. Checked
 * without a build, from the sources the build reads.
 */
const site = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(site(path), "utf8");

/** What a reader sees of an .astro file: frontmatter, comments, styles and scripts removed. */
function visible(source: string): string {
  return source
    .replace(/^---[\s\S]*?\n---\n/, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ");
}
const withoutUrls = (text: string) => text.replace(/https?:\/\/[^\s)>"'`]+/g, " ");
/** The part of a source from a marker to the end mark after it, both kept; "" when the marker is missing. */
function between(source: string, from: string, to: string): string {
  const i = source.indexOf(from);
  if (i < 0) return "";
  const j = source.indexOf(to, i + from.length);
  return source.slice(i, j < 0 ? undefined : j + to.length);
}

const ASSISTANT_PAGE = "src/pages/assistants/[slug].astro";
const ASSISTANT_HUB = "src/pages/assistants/index.astro";
const SHOPIFY_PAGE = "src/pages/guides/shopify-ai-assistants.astro";
const GUIDES_HUB = "src/pages/guides/index.astro";
const DOCS_WITH_CHECK = ["index", "quickstart", "manifest"].map((d) => `src/content/docs/docs/${d}.md`);
const SUFFIX = " · Surfing Dog";

/** A title attribute written out in a page's source: title="…". */
const titleIn = (path: string) => read(path).match(/\n\s+title="([^"]+)"/)?.[1] ?? "";
const descriptionIn = (path: string) => read(path).match(/\n\s+description="([^"]+)"/)?.[1] ?? "";

/** Every page these changes made or touched, with the title and description it is published with. */
const PAGES: { name: string; title: string; description: string }[] = [
  ...ASSISTANTS.map((a) => ({ name: `/assistants/${a.slug}/`, title: a.title, description: a.description })),
  { name: "/assistants/", title: titleIn(ASSISTANT_HUB), description: descriptionIn(ASSISTANT_HUB) },
  { name: "/guides/", title: `${HUB.title}${SUFFIX}`, description: HUB.description },
  ...GUIDES.filter((g) => g.slug === "sell-through-ai-assistants").map((g) => ({
    name: `/guides/${g.slug}/`,
    title: `${g.title}${SUFFIX}`,
    description: g.description,
  })),
  { name: "/guides/shopify-ai-assistants/", title: `${SHOPIFY.title}${SUFFIX}`, description: SHOPIFY.description },
];

/** Every question these pages answer, by page. */
const FAQS: [string, readonly Faq[]][] = [
  ...ASSISTANTS.map((a): [string, readonly Faq[]] => [a.slug, a.owner.faqs]),
  ["shopify", SHOPIFY_FAQS],
];

/** Everything these pages say about assistants and Shopify, in words. */
const SAID: [string, string][] = [
  ...ASSISTANTS.map((a): [string, string] => [
    a.slug,
    [a.title, a.description, a.owner.question, ...a.owner.does.map((d) => d.text)].join("\n"),
  ]),
  [
    "shopify",
    [
      SHOPIFY.heading,
      SHOPIFY.title,
      SHOPIFY.description,
      SHOPIFY.answer,
      ...SHOPIFY_CHANNELS.flatMap((c) => [c.name, c.does]),
      ...SHOPIFY_DOORS.map((d) => d.what),
    ].join("\n"),
  ],
  ...FAQS.map(([name, faqs]): [string, string] => [`${name} questions`, faqs.map((f) => `${f.q}\n${f.a}`).join("\n")]),
  ...[SHOPIFY_PAGE, "src/components/Faqs.astro"].map((p): [string, string] => [p, visible(read(p))]),
  // In pages that were there before, the words these changes added.
  [
    `${ASSISTANT_PAGE} owner section`,
    between(read(ASSISTANT_PAGE), '<section class="wrap wrap-read section section-tight owner"', "</section>"),
  ],
  [`${ASSISTANT_HUB} lede`, between(read(ASSISTANT_HUB), "Each page says what that assistant", "</p>")],
  [
    `${GUIDES_HUB} checklist`,
    between(read(GUIDES_HUB), '<h2 id="guides-h">', '<section class="prose hub-body" aria-labelledby="score">'),
  ],
  ["hub", [HUB.title, HUB.description].join("\n")],
];

describe("the owners' pages", () => {
  it("each has a title and a description that fit a search result, and no two pages share either", () => {
    expect(PAGES.length).toBe(ASSISTANTS.length + 4);
    for (const p of PAGES) {
      expect(p.title.endsWith(SUFFIX), `${p.name}: ${p.title}`).toBe(true);
      expect(p.title.length, `${p.name}: ${p.title}`).toBeLessThanOrEqual(70);
      expect(p.title.length, p.name).toBeGreaterThan(30);
      expect(p.description.length, `${p.name}: ${p.description}`).toBeLessThanOrEqual(160);
      expect(p.description.length, `${p.name}: ${p.description}`).toBeGreaterThanOrEqual(80);
    }
    expect(new Set(PAGES.map((p) => p.title)).size).toBe(PAGES.length);
    expect(new Set(PAGES.map((p) => p.description)).size).toBe(PAGES.length);
  });

  it("say what owners search for: the assistant's question, the checklist, agentic commerce readiness and Shopify", () => {
    for (const a of ASSISTANTS) {
      expect(a.title, a.slug).toMatch(new RegExp(`^Can (Meta )?${a.short} book or order with your business\\?`));
      expect(a.owner.question, a.slug).toMatch(/^Can .+ book or order with your business\?$/);
    }
    const chatgpt = ASSISTANTS.find((a) => a.slug === "chatgpt");
    expect(chatgpt?.owner.faqs.map((f) => f.q)).toEqual([
      "Can ChatGPT book appointments?",
      "Can ChatGPT make restaurant reservations?",
      "Can ChatGPT order things for you?",
      "How do I sell on ChatGPT?",
    ]);
    expect(ASSISTANTS.find((a) => a.slug === "gemini")?.owner.faqs[0]?.q).toBe("Can Gemini book an appointment?");
    expect(ASSISTANTS.find((a) => a.slug === "claude")?.owner.faqs[0]?.q).toBe("Can Claude book reservations?");
    // The hub is the checklist, and the selling guide leads with agentic commerce readiness; their
    // addresses stay as they were (the guides' own test holds the slugs).
    expect(HUB.title).toBe("AI agent readiness checklist for small businesses");
    expect(read(GUIDES_HUB)).toContain('<h1 class="h-page" id="hub-h">{HUB.title}</h1>');
    const selling = GUIDES.find((g) => g.slug === "sell-through-ai-assistants");
    expect(selling?.title).toMatch(/^Agentic commerce readiness: /);
    expect(selling?.description).toMatch(/^Agentic commerce readiness /);
    expect(SHOPIFY.heading).toBe("Shopify and AI assistants: can ChatGPT order from your store?");
    expect(SHOPIFY.title).toMatch(/^Shopify agentic commerce/);
    expect(read(SHOPIFY_PAGE)).toContain('<h1 class="h-page" id="g-title">{SHOPIFY.heading}</h1>');
    expect(visible(read(SHOPIFY_PAGE))).toContain("Agentic commerce readiness on Shopify");
    expect(SHOPIFY_FAQS.map((f) => f.q)).toContain("Can I sell on ChatGPT with Shopify?");
    expect(SHOPIFY_FAQS.map((f) => f.q)).toContain("Does Shopify make an llms.txt for my store?");
    expect(wordCount(SHOPIFY.answer)).toBeLessThanOrEqual(50);
  });

  it("show each question and its answer on the page, and give the FAQPage data the same words", () => {
    // The component prints the question and the answer as they are, with nothing around them.
    const faqs = read("src/components/Faqs.astro");
    expect(faqs).toContain("<summary>{f.q}</summary>");
    expect(faqs).toContain("<p>{f.a}</p>");
    // Each page hands the one list to both: the folded questions and the structured data.
    expect(read(ASSISTANT_PAGE)).toContain("<Faqs faqs={a.owner.faqs} />");
    expect(read(ASSISTANT_PAGE)).toContain("faqPage(a.owner.faqs, url)");
    expect(read(SHOPIFY_PAGE)).toContain("<Faqs faqs={SHOPIFY_FAQS} />");
    expect(read(SHOPIFY_PAGE)).toContain("faqPage(SHOPIFY_FAQS, url)");
    // And the data is those words, one Question for each, in order.
    for (const [name, list] of FAQS) {
      const ld = faqPage(list, "https://surfingdog.ai/x/") as {
        "@type": string;
        mainEntity: { "@type": string; name: string; acceptedAnswer: { "@type": string; text: string } }[];
      };
      expect(ld["@type"]).toBe("FAQPage");
      expect(
        ld.mainEntity.map((q) => [q.name, q.acceptedAnswer.text]),
        name,
      ).toEqual(list.map((f) => [f.q, f.a]));
      expect(list.length, name).toBeGreaterThanOrEqual(1);
      for (const f of list) {
        expect(f.q, name).toMatch(/\?$/);
        expect(f.a, `${name}: ${f.q}`).not.toMatch(/[<>`[\]]|\]\(|\*\*/);
        expect(wordCount(f.a), `${name}: ${f.q}`).toBeLessThanOrEqual(60);
      }
      expect(new Set(list.map((f) => f.q)).size, name).toBe(list.length);
    }
    // FAQPage data appears only where the questions are shown: no other page here builds one.
    for (const p of [ASSISTANT_HUB, GUIDES_HUB, "src/pages/guides/[slug].astro"]) {
      expect(read(p), p).not.toMatch(/FAQPage|faqPage\(/);
    }
  });

  it("date what another company's product does, and say where each line was read", () => {
    expect(OWNER_AS_OF).toBe("as of October 2026");
    expect(SHOPIFY_AS_OF).toBe("as of October 2026");
    expect(OWNER_CHECKED).toBe("12 October 2026");
    expect(SHOPIFY_CHECKED).toBe("12 October 2026");
    const page = read(ASSISTANT_PAGE);
    expect(page).toContain("What {a.short} does, {OWNER_AS_OF}");
    expect(page).toContain("Read {OWNER_CHECKED} from each maker's own pages");
    expect(read(SHOPIFY_PAGE)).toContain("What each one does, {SHOPIFY_AS_OF}:");
    expect(read(SHOPIFY_PAGE)).toContain("Sources, read {SHOPIFY_CHECKED}");
    const sources = [
      ...ASSISTANTS.flatMap((a) => a.owner.does.flatMap((d) => d.sources)),
      ...SHOPIFY_CHANNELS.flatMap((c) => c.sources),
      ...Object.values(SHOPIFY_SOURCES),
    ];
    for (const a of ASSISTANTS) {
      expect(a.owner.does.length, a.slug).toBeGreaterThanOrEqual(2);
      for (const d of a.owner.does) expect(d.sources.length, `${a.slug}: ${d.text}`).toBeGreaterThanOrEqual(1);
    }
    for (const s of sources) {
      expect(s.href, s.label).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\//);
      expect(s.label.length, s.href).toBeGreaterThan(5);
    }
    // A line that says when names the month and the year.
    for (const a of ASSISTANTS) {
      expect(
        a.owner.does.some((d) => /\b(19|20)\d\d\b/.test(d.text)),
        a.slug,
      ).toBe(true);
    }
  });

  it("are plain: no claim of being first, alone, best or guaranteed, no hype, and no other checker's name", () => {
    for (const [name, raw] of SAID) expect(raw.length, name).toBeGreaterThan(40);
    for (const [name, raw] of SAID) {
      const text = withoutUrls(raw);
      expect(text, name).not.toMatch(/\b(first|only|best|verified|certified|guaranteed?|people free)\b/i);
      expect(text, name).not.toMatch(/#1|number one|no\. 1/i);
      expect(text, name).not.toMatch(
        /\b(seamless(ly)?|effortless(ly)?|revolutionary|game.?chang\w*|supercharge\w*|cutting.?edge|world.?class|unlock\w*|skyrocket\w*|leading)\b/i,
      );
      expect(text, name).not.toMatch(/Agent ?Readiness|AgentReady/);
      expect(text, name).not.toMatch(/agent ?readiness score/i);
      // Other checkers and their makers are never named; platforms and assistants may be.
      expect(text, name).not.toMatch(
        /backlinko|semrush|frase|chat ?thing|geo ?toolbox|shero|codal|isitagentready|ucpchecker|profiletree|findskill/i,
      );
    }
  });

  // The words themselves are private, so they come from the environment of whoever runs the check.
  const privateWords = (process.env.SITE_PRIVATE_WORDS ?? "")
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  it.skipIf(privateWords.length === 0)("name no person, business we worked with, or host (SITE_PRIVATE_WORDS)", () => {
    for (const [name, raw] of SAID) {
      const words = new Set(raw.toLowerCase().split(/[^a-z0-9]+/));
      for (const w of privateWords) expect(words.has(w), `${name}: a private word`).toBe(false);
    }
  });

  it("say only what the check counts for a Shopify store, by the published rules as amended on 12 October 2026", () => {
    const text = visible(read(SHOPIFY_PAGE)).replace(/\s+/g, " ");
    // A cart or a checkout cancelled is not an order cancelled; a message counts for a shop.
    expect(text).toMatch(/<b>Cancelling a cart or a checkout<\/b>[^<]*<code>cancel_cart<\/code>/);
    expect(text).toContain("that isn't cancelling an order, so it earns nothing");
    expect(SHOPIFY_FAQS.some((f) => f.a.includes("Cancelling a cart or a checkout isn't cancelling an order"))).toBe(
      true,
    );
    expect(text).toContain('<a href="/v1/score-rules">published rules</a>');
    // The points it gives are the rules' weights for a shop that sells goods: core (message, order,
    // pay) and after (change, cancel, return, receipt). The spec's copy of version 2 predates the
    // amendment that made message apply to shops, so it is added here as the rules now say.
    const rules = scoreRulesV2 as {
      groups: { id: string; weight: number; members: string[] }[];
      profiles: { id: string; applicable: string[] }[];
    };
    const shop = new Set([...(rules.profiles.find((p) => p.id === "shop")?.applicable ?? []), "message"]);
    const groups = rules.groups.filter((g) => g.weight > 0 && g.members.some((m) => shop.has(m)));
    const possible = groups.reduce((n, g) => n + g.weight, 0);
    const share = (cap: string) => {
      const g = groups.find((x) => x.members.includes(cap));
      return g ? (100 * g.weight) / g.members.filter((m) => shop.has(m)).length / possible : 0;
    };
    expect(Math.round(share("message"))).toBe(14);
    for (const c of ["change", "cancel", "return", "receipt"]) expect(Math.round(share(c)), c).toBe(8);
    expect(text).toContain("about 14 of 100 points");
    expect(text).toContain("about 8 points each");
    // Our inbox is one labelled option among others, and says what it doesn't do for a Shopify order.
    expect(text).toContain("<b>Surfing Dog Inbox (ours, open source)</b>, one option among apps");
    expect(text).toContain("Orders placed in your Shopify checkout stay in Shopify");
    expect(text).toContain("There's no hosted version yet.");
  });

  it("link to the checker in their own words, and every link they make on this site goes somewhere", () => {
    // In-content links to the checker, besides the check box itself.
    expect(read(ASSISTANT_PAGE)).toContain('<a class="link" href="/check">free check of your website</a>');
    expect(read(ASSISTANT_PAGE)).toMatch(
      /<GuideCheck examples=\{\[\]\} title=\{`Check what \$\{a\.short\} can do with you`\}/,
    );
    expect(read(ASSISTANT_HUB)).toContain('<a class="link" href="/check">check your website for AI agents</a>');
    expect(read(SHOPIFY_PAGE)).toMatch(/<GuideCheck[\s\S]*title="Check your store"/);
    for (const doc of DOCS_WITH_CHECK) expect(read(doc), doc).toContain("[check your website for AI agents](/check)");

    const proxied = [/^\/check$/, /^\/leaderboard$/, /^\/v1\//, /^\/bot$/];
    const exists = (href: string) => {
      const p = href.replace(/[?#].*$/, "");
      if (proxied.some((r) => r.test(p))) return true;
      const guide = p.match(/^\/guides\/([a-z0-9-]+)\/$/)?.[1];
      if (guide) {
        return (
          GUIDES.some((g) => g.slug === guide) ||
          (PLATFORM_PAGES.some((pp) => pp.slug === guide) && existsSync(site(`src/pages/guides/${guide}.astro`)))
        );
      }
      if (p === "/guides/") return true;
      const post = p.match(/^\/blog\/([a-z0-9-]+)\/$/)?.[1];
      if (post) return existsSync(site(`src/content/blog/${post}.md`));
      if (p.startsWith("/docs/")) return existsSync(site(`src/content/docs${p.replace(/\/$/, "")}.md`));
      const bare = p.replace(/\/+$/, "");
      return (
        existsSync(site(`src/pages${bare}.astro`)) ||
        existsSync(site(`src/pages${bare}/index.astro`)) ||
        existsSync(site(`public${bare}`))
      );
    };
    const hrefs = [
      ...[ASSISTANT_PAGE, ASSISTANT_HUB, SHOPIFY_PAGE, GUIDES_HUB].flatMap((p) =>
        [...read(p).matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1] ?? ""),
      ),
      ...DOCS_WITH_CHECK.flatMap((p) => [...read(p).matchAll(/\]\((\/[^)\s]*)\)/g)].map((m) => m[1] ?? "")),
      ...ASSISTANTS.flatMap((a) => (a.post ? [a.post.href] : [])),
      ...PLATFORM_PAGES.map((pp) => `/guides/${pp.slug}/`),
    ];
    expect(hrefs.length).toBeGreaterThan(15);
    for (const h of hrefs) expect(exists(h), h).toBe(true);
    // The Shopify page is linked from the hub and from the selling guide's Shopify row.
    expect(read(GUIDES_HUB)).toContain('href="/guides/shopify-ai-assistants/"');
    const selling = GUIDES.find((g) => g.slug === "sell-through-ai-assistants");
    expect(selling?.options.flatMap((o) => (o.links ?? []).map((l) => l.href))).toContain(
      "/guides/shopify-ai-assistants/",
    );
  });

  it("keep to the site's quiet styles: tokens for every colour, and folded detail", () => {
    for (const p of [ASSISTANT_PAGE, SHOPIFY_PAGE, "src/components/Faqs.astro"]) {
      const styles = [...read(p).matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? "").join("\n");
      expect(styles.length, p).toBeGreaterThan(0);
      expect(styles, p).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|\bred\b|crimson|tomato/i);
    }
    expect(read("src/components/Faqs.astro")).toContain('<details class="faq">');
    expect(read(SHOPIFY_PAGE)).toContain('<details class="sources">');
  });

  it("the sitemap index lists the network's sitemap beside this site's, as robots.txt does", () => {
    const config = read("astro.config.mjs");
    expect(config).toContain('import sitemap from "@astrojs/sitemap";');
    expect(config).toContain('const NETWORK_SITEMAP = "https://surfingdog.ai/sitemap-checks.xml";');
    expect(config).toContain("sitemap({ customSitemaps: [NETWORK_SITEMAP] })");
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@astrojs/sitemap"]).toBeDefined();
    expect(read("public/robots.txt")).toContain("Sitemap: https://surfingdog.ai/sitemap-checks.xml");
  });
});
