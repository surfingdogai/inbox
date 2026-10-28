import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASSISTANTS } from "../src/lib/assistants";
import { faqPage } from "../src/lib/faq";
import { GUIDE_SLUGS, wordCount } from "../src/lib/guides";
import { linksIn, plain } from "../src/lib/inline";
import { PLATFORMS } from "../src/lib/platforms";
import { namesWoo, TOPICS, TOPICS_AS_OF, type Topic, topicHref } from "../src/lib/topics";

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

const exists = (href: string): boolean => {
  const [path = "", anchor] = href.split("#");
  const p = path.replace(/\?.*$/, "");
  if (p === "/check") return true;
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
  const bare = p.replace(/\/+$/, "");
  return existsSync(site(`src/pages${bare}.astro`)) || existsSync(site(`src/pages${bare}/index.astro`));
};

describe("the topic guides", () => {
  it("are three pages of their own under /guides/, outside the guides' contract, and the hub links each", () => {
    expect(TOPICS.map((t) => t.slug)).toEqual(["agentic-commerce", "sell-on-chatgpt", "ai-hotel-booking"]);
    for (const t of TOPICS) {
      expect((GUIDE_SLUGS as readonly string[]).includes(t.slug), t.slug).toBe(false);
      expect(existsSync(site(`src/content/guides/${t.slug}.md`)), t.slug).toBe(false);
      expect(read(`src/pages/guides/${t.slug}.astro`)).toContain(`const t = topicBySlug("${t.slug}");`);
      expect(read(`src/pages/guides/${t.slug}.astro`)).toContain("<TopicGuide topic={t} />");
      expect(read("src/pages/guides/index.astro"), t.slug).toContain(`href="${topicHref(t.slug)}"`);
    }
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
    // Phrasings nobody types are not built on.
    for (const t of TOPICS)
      expect(`${t.title} ${t.heading}`, t.slug).not.toMatch(
        /for small business|is my website ready|direct booking ai/i,
      );
  });

  it("write the short names out, and never a bare AI inbox", () => {
    for (const t of TOPICS) {
      const text = words(t);
      if (/\bUCP\b/.test(text)) expect(text, t.slug).toContain("Universal Commerce Protocol (UCP)");
      if (/\bACP\b/.test(text)) expect(text, t.slug).toContain("Agentic Commerce Protocol (ACP)");
      expect(text, t.slug).not.toMatch(/\bAI inbox\b/i);
    }
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
    expect(read(COMPONENT)).toContain("Sources, {TOPICS_AS_OF}");
    for (const t of TOPICS) {
      expect(words(t), t.slug).toMatch(/October 2026/);
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
    // Each links the other two.
    for (const t of TOPICS)
      for (const o of TOPICS.filter((x) => x !== t))
        expect(links(t), `${t.slug} → ${o.slug}`).toContain(topicHref(o.slug));
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
    for (const t of TOPICS) {
      for (const m of words(t).matchAll(/Surfing Dog Inbox(.{0,22})/g))
        expect(m[1], t.slug).toMatch(/^ \(ours, open source\)/);
      expect(words(t), t.slug).not.toMatch(/\b(the first|the only|best|verified|certified|guaranteed?)\b/i);
      expect(words(t), t.slug).not.toMatch(
        /\b(seamless(ly)?|effortless(ly)?|revolutionary|game.?chang\w*|supercharge\w*|cutting.?edge|world.?class|unlock\w*|leading)\b/i,
      );
    }
  });

  it("show each question and its answer, and give the FAQPage data the same words", () => {
    const component = read(COMPONENT);
    expect(component).toContain("<Faqs faqs={t.faqs} />");
    expect(read("src/lib/topics.ts")).toContain("faqPage(t.faqs, url)");
    for (const t of TOPICS) expect(read(`src/pages/guides/${t.slug}.astro`)).toContain("ld={ld}");
    expect(component).toContain('<GuideCheck examples={[]} title="Check your website" />');
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
});
