import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASSISTANTS } from "../src/lib/assistants";
import { faqPage } from "../src/lib/faq";
import { GUIDE_SLUGS, wordCount } from "../src/lib/guides";
import { LANGS, PAGES as LOCAL_PAGES, TOOLS } from "../src/lib/i18n";
import { linksIn, plain } from "../src/lib/inline";
import { PLATFORMS } from "../src/lib/platforms";
import {
  namesWoo,
  TOPIC_COVERS,
  TOPIC_WORDS,
  TOPICS,
  TOPICS_AS_OF,
  TOPICS_NOVEMBER,
  type Topic,
  topicAlternates,
  topicAt,
  topicCard,
  topicFile,
  topicHref,
  topicLang,
  topicLd,
  topicMonth,
  topicSources,
  topicVersions,
} from "../src/lib/topics";

/**
 * The topic guides (src/lib/topics.ts): pages beside the eight guides, outside their contract, for what
 * owners search for. Each fits a search result, says what it says as of a month with a source for
 * what another company does, builds on the guides by linking them, labels our own inbox as ours, and
 * gives its questions the same words on the page and in its FAQPage data. Checked without a build.
 */
const site = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(site(path), "utf8");
const COMPONENT = "src/components/TopicGuide.astro";
const SUFFIX = " · Surfing Dog";

const blocks = (t: Topic) => t.sections.flatMap((s) => [...s.paras, ...(s.list ?? [])]);
const words = (t: Topic) =>
  [
    t.title,
    t.heading,
    t.lede,
    t.description,
    t.answer,
    ...t.sections.map((s) => s.heading),
    ...blocks(t).map((b) => b.text),
    ...t.faqs.flatMap((f) => [f.q, f.a]),
  ].join("\n");

/** The network's pages under this address, and the free tools it serves in each language. */
const NETWORK = [/^\/check$/, /^\/leaderboard$/, /^\/bot$/];
const TOOL_PATHS = new Set(Object.values(TOOLS).flatMap((t) => Object.values(t)));
/** The translated pages of src/lib/i18n.ts, in every language. */
const LOCAL_PATHS = new Set(Object.values(LOCAL_PAGES).flatMap((p) => Object.values(p)));

const exists = (href: string): boolean => {
  const [path = "", anchor] = href.split("#");
  const p = path.replace(/\?.*$/, "");
  if (NETWORK.some((r) => r.test(p)) || TOOL_PATHS.has(p) || LOCAL_PATHS.has(p)) return true;
  if (topicAt(p)) return !anchor && existsSync(site(topicFile(topicAt(p) as Topic)));
  const guide = p.match(/^\/guides\/([a-z0-9-]+)\/$/)?.[1];
  if (guide)
    return (
      !anchor &&
      ((GUIDE_SLUGS as readonly string[]).includes(guide) || existsSync(site(`src/pages/guides/${guide}.astro`)))
    );
  const integration = p.match(/^\/integrations\/([a-z0-9-]+)\/$/)?.[1];
  if (integration) return PLATFORMS.some((x) => x.slug === integration);
  const assistant = p.match(/^\/assistants\/([a-z0-9-]+)\/$/)?.[1];
  if (assistant) return ASSISTANTS.some((a) => a.slug === assistant);
  const post = p.match(/^\/blog\/([a-z0-9-]+)\/$/)?.[1];
  if (post) return !anchor && existsSync(site(`src/content/blog/${post}.md`));
  const bare = p.replace(/\/+$/, "");
  return existsSync(site(`src/pages${bare}.astro`)) || existsSync(site(`src/pages${bare}/index.astro`));
};

describe("the topic guides", () => {
  it("are pages of their own, outside the guides' contract, and the hub links each", () => {
    expect(TOPICS.map((t) => t.slug)).toEqual([
      "agentic-commerce",
      "sell-on-chatgpt",
      "ai-hotel-booking",
      "agent-payments-protocol",
      "ai-inbox-for-business",
      "ai-receptionist",
      "get-your-business-on-chatgpt",
      "ai-product-search",
      "agentic-commerce-protocols",
      "how-ai-agents-pay",
      "agent-ready-website",
      "aparecer-en-chatgpt",
      "aparecer-no-chatgpt",
    ]);
    for (const t of TOPICS) {
      expect((GUIDE_SLUGS as readonly string[]).includes(t.slug), t.slug).toBe(false);
      expect(existsSync(site(`src/content/guides/${t.slug}.md`)), t.slug).toBe(false);
      expect(read(topicFile(t))).toContain(`const t = topicBySlug("${t.slug}");`);
      expect(read(topicFile(t))).toContain("<TopicGuide topic={t} />");
      expect(read("src/pages/guides/index.astro"), t.slug).toContain(`href="${topicHref(t.slug)}"`);
    }
    // English beside the checklist, the others under their language's guides.
    expect(topicFile(TOPICS[0] as Topic)).toBe("src/pages/guides/agentic-commerce.astro");
    expect(topicHref("aparecer-en-chatgpt")).toBe("/es/guias/aparecer-en-chatgpt/");
    expect(topicHref("aparecer-no-chatgpt")).toBe("/pt/guias/aparecer-no-chatgpt/");
    expect(new Set(TOPICS.map((t) => topicHref(t.slug))).size).toBe(TOPICS.length);
    // No topic sits at an address a translated page of src/lib/i18n.ts has.
    for (const t of TOPICS) expect(LOCAL_PATHS.has(topicHref(t.slug)), t.slug).toBe(false);
  });

  it("fit a search result, and say what owners search for in their words", () => {
    for (const t of TOPICS) {
      const title = `${t.title}${SUFFIX}`;
      expect(title.length, title).toBeLessThanOrEqual(70);
      expect(title.length, title).toBeGreaterThan(30);
      expect(t.description.length, `${t.slug}: ${t.description}`).toBeLessThanOrEqual(160);
      expect(t.description.length, t.slug).toBeGreaterThanOrEqual(80);
      expect(wordCount(t.answer), t.slug).toBeLessThanOrEqual(50);
      expect(t.answer, t.slug).not.toMatch(/[`*[\]]/);
    }
    expect(new Set(TOPICS.map((t) => t.title)).size).toBe(TOPICS.length);
    const [commerce, chatgpt, hotels] = TOPICS as [Topic, Topic, Topic];
    // "Agentic e-commerce" folds into "agentic commerce": the title says the one, the answer the other,
    // once. The definition is said once, in the answer: no lede, and no question that asks it again.
    expect(commerce.title).toMatch(/^Agentic commerce explained/);
    expect(words(commerce).match(/agentic e-commerce/gi)?.length).toBe(1);
    expect(commerce.answer).toMatch(/^Agentic commerce, or agentic e-commerce, is /);
    expect(commerce.lede).toBeUndefined();
    expect(commerce.faqs.map((f) => f.q)).not.toContain("What is agentic commerce, in simple terms?");
    expect(words(commerce).match(/is shopping an AI assistant does for a person/gi)?.length).toBe(1);
    expect(chatgpt.title).toMatch(/^How to sell on ChatGPT/);
    expect(chatgpt.faqs.map((f) => f.q)).toContain("How do I sell on ChatGPT?");
    expect(hotels.title).toMatch(/^AI hotel booking/);
    // What owners type: the payments protocol by its name, the receptionist, the AI inbox, ChatGPT.
    const titleOf = (slug: string) => TOPICS.find((t) => t.slug === slug)?.title ?? "";
    expect(titleOf("agent-payments-protocol")).toMatch(/^Agent Payments Protocol \(AP2\)/);
    expect(titleOf("ai-receptionist")).toMatch(/^AI receptionist/);
    expect(titleOf("ai-inbox-for-business")).toMatch(/^AI inbox for business/);
    expect(titleOf("get-your-business-on-chatgpt")).toMatch(/^How to get your business on ChatGPT/);
    expect(titleOf("aparecer-en-chatgpt")).toMatch(/ChatGPT recomiende tu negocio$/);
    expect(titleOf("aparecer-no-chatgpt")).toMatch(/aparecer no ChatGPT$/);
    // Phrasings nobody types are not built on.
    for (const t of TOPICS)
      expect(`${t.title} ${t.heading}`, t.slug).not.toMatch(
        /for small business|is my website ready|direct booking ai/i,
      );
  });

  it("write the short names out, and never a bare AI inbox but on the page that says what the words mean", () => {
    for (const t of TOPICS) {
      const text = words(t);
      if (/\bUCP\b/.test(text)) expect(text, t.slug).toContain("Universal Commerce Protocol (UCP)");
      if (/\bACP\b/.test(text)) expect(text, t.slug).toContain("Agentic Commerce Protocol (ACP)");
      if (/\bAP2\b/.test(text)) expect(text, t.slug).toMatch(/Agent Payments Protocol(,| \()/);
      if (t.slug !== "ai-inbox-for-business") expect(text, t.slug).not.toMatch(/\bAI inbox\b/i);
    }
    // "AI inbox" is the founder's word for what owners search (31 October 2026), and Gmail's AI Inbox
    // is Google's: the one page that uses the words says so, with its sources, and never calls ours one.
    const inbox = TOPICS.find((t) => t.slug === "ai-inbox-for-business") as Topic;
    const text = words(inbox);
    expect(text).toContain("Gmail's AI Inbox is Google's");
    expect(text).not.toMatch(/Surfing Dog(?:'s)? Inbox[^.?]*\bis an AI (?:email )?inbox\b/i);
    expect(inbox.faqs.find((f) => f.q === "Is Surfing Dog's inbox an AI email inbox?")?.a).toMatch(/^No\. /);
    const gmail = blocks(inbox).filter((b) => b.text.includes("Gmail"));
    for (const b of gmail) expect(b.sources?.length ?? 0, b.text).toBeGreaterThan(0);
  });

  it("say of ChatGPT's checkout what their sources say, and of Shopify only what Shopify says", () => {
    const [commerce, chatgpt] = TOPICS as [Topic, Topic, Topic];
    for (const t of [commerce, chatgpt]) {
      const text = words(t);
      // Deprioritised as a stand-alone feature; a shop's own app inside ChatGPT can still take payment.
      expect(text, t.slug).not.toMatch(/Not inside the chat|rather than inside the chat|stepped back/);
      expect(text, t.slug).toContain("deprioritised Instant Checkout");
      expect(text, t.slug).toMatch(/app inside ChatGPT|app in ChatGPT/);
      expect(text, t.slug).toContain("Walmart");
      // Shopify sets where the store sells, not where ChatGPT's users are.
      expect(text, t.slug).not.toMatch(/for buyers in the US\.|ChatGPT's shopping on Shopify is for buyers/);
    }
    const sourced = blocks(chatgpt).find((b) => b.text.includes("deprioritised Instant Checkout"));
    expect(sourced?.sources?.map((x) => x.href)).toEqual(
      expect.arrayContaining([
        "https://techcrunch.com/2026/03/24/openais-plans-to-make-chatgpt-more-like-amazon-arent-going-so-well/",
        "https://macrumors.com/2026/03/25/chatgpt-revamps-shopping-features",
        "https://squareup.com/us/en/press/claude-chatgpt-integrations",
      ]),
    );
  });

  it("date what moves, and give a source for what another company does", () => {
    expect(TOPICS_AS_OF).toBe("as of October 2026");
    expect(TOPIC_WORDS.en.sources).toBe("Sources, as of October 2026");
    expect(read(COMPONENT)).toContain("<summary>{topicSources(t)}</summary>");
    // A page written in a later month says so, in its words and over its sources.
    const november = TOPICS.filter((t) => t.month);
    expect(november.map((t) => [t.slug, t.month, t.modified])).toEqual(
      ["agentic-commerce-protocols", "how-ai-agents-pay", "agent-ready-website"].map((s) => [
        s,
        "November 2026",
        TOPICS_NOVEMBER,
      ]),
    );
    for (const t of november) expect(topicSources(t)).toBe("Sources, as of November 2026");
    for (const t of TOPICS) {
      expect(words(t), t.slug).toContain(topicMonth(t));
      expect(topicSources(t), t.slug).toContain(topicMonth(t));
      const sourced = blocks(t).filter((b) => b.sources && b.sources.length > 0);
      expect(sourced.length, t.slug).toBeGreaterThanOrEqual(4);
      for (const b of sourced)
        for (const s of b.sources ?? []) expect(s.href, s.label).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\//);
      // A line that names another company's product with a date or a number of countries has its source.
      for (const b of blocks(t)) {
        if (/\b(March|July|November) 20\d\d\b|Canada|Australia|waitlist|Apache 2\.0/.test(b.text))
          expect(b.sources?.length ?? 0, `${t.slug}: ${b.text}`).toBeGreaterThan(0);
      }
    }
  });

  it("build on the guides by linking them rather than saying them again", () => {
    const links = (t: Topic) => [...blocks(t).flatMap((b) => linksIn(b.text)), ...t.related.map((r) => r.href)];
    const [commerce, chatgpt, hotels] = TOPICS as [Topic, Topic, Topic];
    expect(links(commerce)).toEqual(
      expect.arrayContaining(["/guides/sell-through-ai-assistants/", "/guides/ai-assistant-payments/"]),
    );
    expect(links(chatgpt)).toEqual(expect.arrayContaining(["/assistants/chatgpt/", "/guides/agentic-commerce/"]));
    expect(links(hotels)).toEqual(expect.arrayContaining(["/guides/ai-assistant-bookings/", "/integrations/beds24/"]));
    // The first three link each other; every topic links at least two others, and every one is linked
    // from at least two.
    for (const t of [commerce, chatgpt, hotels])
      for (const o of [commerce, chatgpt, hotels].filter((x) => x !== t))
        expect(links(t), `${t.slug} → ${o.slug}`).toContain(topicHref(o.slug));
    const others = (t: Topic) =>
      new Set(links(t).filter((h) => topicAt(h.split("#")[0] ?? "") && topicAt(h.split("#")[0] ?? "") !== t));
    for (const t of TOPICS) expect(others(t).size, t.slug).toBeGreaterThanOrEqual(2);
    for (const t of TOPICS.filter((x) => topicLang(x) === "en"))
      expect(TOPICS.filter((o) => o !== t && others(o).has(topicHref(t.slug))).length, t.slug).toBeGreaterThanOrEqual(
        2,
      );
    for (const t of TOPICS) {
      for (const h of links(t)) expect(exists(h), `${t.slug}: ${h}`).toBe(true);
      expect(
        wordCount(
          plain(
            blocks(t)
              .map((b) => b.text)
              .join(" "),
          ),
        ),
        t.slug,
      ).toBeGreaterThanOrEqual(200);
    }
    expect([...read(COMPONENT).matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1] ?? "").every(exists)).toBe(true);
  });

  it("name our inbox only as ours, as one way among others", () => {
    expect(TOPIC_WORDS.en.ours).toBe(" (ours, open source)");
    for (const t of TOPICS) {
      const ours = TOPIC_WORDS[topicLang(t)].ours;
      for (const m of words(t).matchAll(/Surfing Dog Inbox(.{0,40})/g))
        expect(m[1]?.startsWith(ours), `${t.slug}: ${m[0]}`).toBe(true);
      expect(words(t), t.slug).not.toMatch(/\b(the first|the only|best|verified|certified|guaranteed?)\b/i);
      expect(words(t), t.slug).not.toMatch(
        /\b(seamless(ly)?|effortless(ly)?|revolutionary|game.?chang\w*|supercharge\w*|cutting.?edge|world.?class|unlock\w*|leading)\b/i,
      );
    }
  });

  it("show each question and its answer, and give the FAQPage data the same words", () => {
    const component = read(COMPONENT);
    expect(read("src/lib/topics.ts")).toContain("faqPage(t.faqs, url)");
    for (const t of TOPICS) expect(read(topicFile(t))).toContain("ld={ld}");
    expect(component).toContain('<GuideCheck examples={[]} title="Check your website" />');
    expect(component).toContain("<Faqs faqs={t.faqs} title={w.questions} />");
    for (const t of TOPICS) {
      const ld = faqPage(t.faqs, `https://surfingdog.ai${topicHref(t.slug)}`) as {
        mainEntity: { name: string; acceptedAnswer: { text: string } }[];
      };
      expect(ld.mainEntity.map((q) => [q.name, q.acceptedAnswer.text])).toEqual(t.faqs.map((f) => [f.q, f.a]));
      expect(t.faqs.length, t.slug).toBeGreaterThanOrEqual(4);
      for (const f of t.faqs) {
        expect(f.q, t.slug).toMatch(/\?$/);
        expect(f.a, `${t.slug}: ${f.q}`).not.toMatch(/[<>`[\]]|\]\(|\*\*/);
        expect(wordCount(f.a), `${t.slug}: ${f.q}`).toBeLessThanOrEqual(60);
      }
    }
  });

  it("carry Automattic's notice where they name WooCommerce, and the site's quiet styles", () => {
    const component = read(COMPONENT);
    expect(component).toContain('{woo && <p class="fine">{WOO_NOTICE}</p>}');
    for (const t of TOPICS) {
      const text = words(t);
      expect(namesWoo(t), t.slug).toBe(JSON.stringify(t).includes("WooCommerce"));
      if (text.includes("WooCommerce"))
        expect(text.slice(text.indexOf("WooCommerce"), text.indexOf("WooCommerce") + 12)).toBe("WooCommerce®");
    }
    const styles = component.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\bred\b|crimson|tomato/i);
  });

  it("give the guides of November 2026 an explainer and a social card of their own, none shared", () => {
    const covered = TOPICS.filter((t) => t.cover);
    expect(covered.map((t) => [t.slug, t.cover?.anim, t.og])).toEqual([
      ["agentic-commerce-protocols", "protocols", "/art/og-agentic-commerce-protocols-v1.png"],
      ["how-ai-agents-pay", "pay-routes", "/art/og-how-ai-agents-pay-v1.png"],
      ["agent-ready-website", "agent-visit", "/art/og-agent-ready-website-v1.png"],
    ]);
    // Every page written from November on has both; a card is made for one page and never reused.
    for (const t of TOPICS.filter((x) => (x.modified ?? "") >= TOPICS_NOVEMBER))
      expect(Boolean(t.cover && t.og), t.slug).toBe(true);
    expect(new Set(covered.map((t) => t.cover?.anim)).size).toBe(covered.length);
    expect(new Set(covered.map((t) => t.og)).size).toBe(covered.length);
    expect([...TOPIC_COVERS].sort()).toEqual(covered.map((t) => t.cover?.anim).sort());
    const registry = read("src/components/topic-covers.ts");
    const component = read(COMPONENT);
    expect(component).toContain('<div class="t-cover" data-idea={t.cover.idea}>');
    expect(component).toContain("<Cover alt={t.cover.alt} />");
    const prefixes = new Set<string>();
    for (const t of covered) {
      const cover = t.cover as NonNullable<Topic["cover"]>;
      // Its words: what it shows, for readers who can't see it, and one idea for its card.
      expect(cover.alt.length, t.slug).toBeGreaterThan(80);
      expect(cover.idea.split("\n").length, t.slug).toBe(2);
      expect(topicCard(t), t.slug).toEqual({ image: t.og, imageAlt: `${t.title}. ${cover.idea.replace("\n", " ")}` });
      const ld = topicLd(t, "https://surfingdog.ai/") as { image?: string }[];
      expect(ld[0]?.image, t.slug).toBe(`https://surfingdog.ai${t.og}`);
      expect(read(topicFile(t)), t.slug).toContain("const card = topicCard(t);");
      expect(read(topicFile(t)), t.slug).toContain("{...card}");
      // Its component: registered under its name, an image with its words, still under reduced
      // motion, stopped off screen, everything under one prefix of its own, the design's colours only.
      const name = registry.match(new RegExp(`"?${cover.anim}"?: (Cover[A-Za-z]+),`))?.[1];
      expect(name, cover.anim).toBeDefined();
      const src = read(`src/components/${name}.astro`);
      expect(src, name).toMatch(/role="img" aria-label=\{alt\}/);
      expect(src, name).toMatch(/prefers-reduced-motion/);
      expect(src, name).toMatch(/IntersectionObserver/);
      const prefix = src.match(/<figure class="([a-z]+)" role="img"/)?.[1] ?? "";
      expect(prefix, name).toMatch(/^c[a-z]{2}$/);
      expect(prefixes.has(prefix), name).toBe(false);
      prefixes.add(prefix);
      const styles = src.match(/<style is:global>([\s\S]*?)<\/style>/)?.[1] ?? "";
      expect(styles, name).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\bred\b|crimson|tomato|--flamingo/i);
      for (const m of styles.matchAll(/^\s*\.([a-z][\w-]*)/gm))
        expect(m[1]?.startsWith(prefix), `${name}: .${m[1]}`).toBe(true);
      for (const m of styles.matchAll(/@keyframes ([\w-]+)/g))
        expect(m[1]?.startsWith(`${prefix}-`), `${name}: ${m[1]}`).toBe(true);
      // Its card: made from the built page by scripts/og-topic.mjs, a PNG of 1200×630.
      const file = site(`public${t.og}`);
      expect(existsSync(file), file).toBe(true);
      const bytes = readFileSync(file);
      expect(bytes.subarray(0, 8).toString("hex"), file).toBe("89504e470d0a1a0a");
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], file).toEqual([1200, 630]);
    }
  });

  it("are written in Spanish and Portuguese where owners search in them, every version naming the others", () => {
    const local = TOPICS.filter((t) => topicLang(t) !== "en");
    expect(local.map((t) => [t.slug, topicLang(t), t.of])).toEqual([
      ["aparecer-en-chatgpt", "es", "get-your-business-on-chatgpt"],
      ["aparecer-no-chatgpt", "pt", "get-your-business-on-chatgpt"],
    ]);
    const root = TOPICS.find((t) => t.slug === "get-your-business-on-chatgpt") as Topic;
    for (const t of [root, ...local]) {
      expect(topicVersions(t).map((v) => v.slug)).toEqual([
        "get-your-business-on-chatgpt",
        "aparecer-en-chatgpt",
        "aparecer-no-chatgpt",
      ]);
      // The same set from every version, English as the x-default: hreflang pairs that return.
      expect(topicAlternates(t)).toEqual([
        { hreflang: "en", href: "https://surfingdog.ai/guides/get-your-business-on-chatgpt/" },
        { hreflang: "es", href: "https://surfingdog.ai/es/guias/aparecer-en-chatgpt/" },
        { hreflang: "pt", href: "https://surfingdog.ai/pt/guias/aparecer-no-chatgpt/" },
        { hreflang: "x-default", href: "https://surfingdog.ai/guides/get-your-business-on-chatgpt/" },
      ]);
      expect(read(topicFile(t)), t.slug).toContain("alternates={topicAlternates(t, site)}");
    }
    // A page in one language names no versions; the sitemap writes them as the head does.
    expect(topicAlternates(TOPICS[0] as Topic)).toEqual([]);
    expect(read("astro.config.mjs")).toContain("topicAlternates(topic)");
    for (const t of local) {
      const lang = topicLang(t);
      expect((LANGS as readonly string[]).includes(lang)).toBe(true);
      expect(read(topicFile(t))).toContain("lang={topicLang(t)}");
      // Its frame is in its language, its check says the result is in English, and its data says its language.
      const w = TOPIC_WORDS[lang];
      expect(w.check?.text, lang).toMatch(lang === "es" ? /en inglés/ : /em inglês/);
      expect(w.hub.href).toBe(`/${lang}/${lang === "es" ? "herramientas" : "ferramentas"}/`);
      const ld = topicLd(t, "https://surfingdog.ai/") as { inLanguage?: string }[];
      expect(ld[0]?.inLanguage).toBe(lang);
      expect(ld[2]?.inLanguage).toBe(lang);
      // No sentence of it is left in English: each has a word only its language writes.
      const own = lang === "es" ? /\b(que|de|los|las|tu|una?|en)\b/ : /\b(que|de|os|as|seu|uma?|no)\b/;
      for (const b of blocks(t)) expect(plain(b.text), `${t.slug}: ${b.text}`).toMatch(own);
      for (const f of t.faqs) expect(f.a, `${t.slug}: ${f.q}`).toMatch(own);
    }
    // Its language's hub, which its eyebrow and breadcrumb name, links it back (English ones: /guides/).
    const hub = read("src/components/LocalTools.astro");
    expect(hub).toContain("const topics = en ? TOPICS.filter((t) => topicLang(t) === lang) : [];");
    expect(hub).toContain("<a href={topicHref(t.slug)}>");
    // Every link of ours from such a page to a page in English says so.
    expect(read(COMPONENT)).toContain('{english.has(r.href) && <span lang="en"> (EN)</span>}');
    expect(read(COMPONENT)).toContain("inline(text, english)");
  });
});
