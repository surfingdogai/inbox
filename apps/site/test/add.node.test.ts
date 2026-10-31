import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { navWord } from "../src/i18n";
import { ADD_FAQS, ADD_HREF, ADD_LABEL, ADD_PAGE, MCP_ADDRESS } from "../src/lib/add";
import { wordCount } from "../src/lib/guides";
import { START_URL } from "../src/lib/hosted";
import { linksIn } from "../src/lib/inline";
import { TOPICS, topicLang } from "../src/lib/topics";

/**
 * "Add your website" (src/lib/add.ts, src/pages/add.astro): one wording and one address wherever a
 * business is offered a way into the directory, on the home page, /search, /network, the footer and
 * the guides, and a page that sends each way to what already does it (the check, register_business,
 * the inbox, the owner's page) and builds nothing of its own. Checked from the sources.
 */
const site = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(site(path), "utf8");
const PAGE = "src/pages/add.astro";

/** Every source file under src, by its path from apps/site. */
function sources(dir = "src"): string[] {
  return readdirSync(site(dir)).flatMap((f) => {
    const p = join(dir, f);
    return statSync(site(p)).isDirectory() ? sources(p) : /\.(astro|ts)$/.test(f) ? [p] : [];
  });
}

/** What a reader sees of an .astro file: frontmatter, comments, styles and scripts removed. */
const visible = (source: string) =>
  source
    .replace(/^---[\s\S]*?\n---\n/, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

describe("Add your website", () => {
  it("is one wording at one address, from the home page, /search, /network and the footer", () => {
    expect(ADD_LABEL).toBe("Add your website");
    expect(ADD_HREF).toBe("/add/");
    const link = "href={ADD_HREF}>{ADD_LABEL}</a>";
    for (const p of [
      "src/pages/index.astro",
      "src/pages/search.astro",
      "src/pages/network.astro",
      "src/pages/directory.astro",
    ]) {
      expect(read(p), p).toContain(link);
      expect(read(p), p).toContain('import { ADD_HREF, ADD_LABEL } from "../lib/add";');
    }
    expect(read("src/components/Footer.astro")).toContain('{ href: "/add/", label: "Add your website" }');
    // The search's opening said "Get your business listed"; the line under the box says it now, once.
    expect(read("src/components/Hero.astro")).not.toContain("Get your business listed");
    // The search's empty answer offers it too, in the same words.
    expect(read("src/pages/search.astro")).toContain('const add = el("a", "link", "Add your website")');
    expect(read("src/pages/search.astro")).toContain('add.href = "/add/";');
    // The footer's word in every language the bar has.
    for (const l of ["es", "pt", "fr", "de", "it"] as const) expect(navWord(l, ADD_LABEL), l).not.toBe(ADD_LABEL);
  });

  it("is never worded another way: every link to it says Add your website, in the page's language", () => {
    for (const p of sources()) {
      const src = read(p);
      for (const m of src.matchAll(/<a\b[^>]*href="\/add\/"[^>]*>([^<]*)<\/a>/g))
        expect(m[1]?.trim(), p).toBe(ADD_LABEL);
      expect(src, p).not.toMatch(/href="\/add"(?!\/)/);
    }
    for (const t of TOPICS) {
      const texts = [...t.sections.flatMap((s) => [...s.paras, ...(s.list ?? [])]).map((b) => b.text)];
      for (const text of texts)
        for (const m of text.matchAll(/\[([^\]]+)\]\(\/add\/\)/g))
          expect(m[1], t.slug).toBe(navWord(topicLang(t), ADD_LABEL));
      for (const r of t.related.filter((x) => x.href === ADD_HREF))
        expect(r.label, t.slug).toBe(navWord(topicLang(t), ADD_LABEL));
    }
    // The guides that send owners here: being found by assistants, and the product search.
    const linked = TOPICS.filter((t) =>
      t.sections.some((s) => [...s.paras, ...(s.list ?? [])].some((b) => linksIn(b.text).includes(ADD_HREF))),
    ).map((t) => t.slug);
    expect(linked).toEqual(
      expect.arrayContaining(["get-your-business-on-chatgpt", "ai-product-search", "aparecer-en-chatgpt"]),
    );
  });

  it("sends each way to what already does it, and builds nothing of its own", () => {
    const page = read(PAGE);
    // The check: the network's own form, asking for a fresh read.
    expect(page).toContain('<form class="add-form" method="post" action="/check">');
    expect(page).toContain('<input type="hidden" name="fresh" value="1" />');
    expect(page).toContain('name="url"');
    // The business's own AI, over the one MCP address, with register_business.
    expect(MCP_ADDRESS).toBe("https://surfingdog.ai/mcp");
    expect(page).toContain("<code>{MCP_ADDRESS}</code>");
    expect(page).toContain("<code>register_business</code>");
    // The inbox, hosted or run yourself; the owner's page; the crawler's rules.
    expect(page).toContain("href={START_URL}");
    expect(START_URL).toMatch(/^https:\/\//);
    for (const href of ["/install/", "/assistants/", "/guides/", "/bot#listed", "/bot#claim", "/bot#stop"])
      expect(page, href).toContain(`href="${href}"`);
    expect(page).toContain("Manage this page");
    // No script, no endpoint, no data of its own.
    expect(page).not.toMatch(/<script|fetch\(|\/v1\//);
  });

  it("fits a search result, and its questions are the same words on the page and in its data", () => {
    expect(ADD_PAGE.title.endsWith(" · Surfing Dog")).toBe(true);
    expect(ADD_PAGE.title.length).toBeLessThanOrEqual(70);
    expect(ADD_PAGE.description.length).toBeGreaterThanOrEqual(80);
    expect(ADD_PAGE.description.length).toBeLessThanOrEqual(160);
    expect(ADD_PAGE.h1).toBe(ADD_LABEL);
    const page = read(PAGE);
    expect(page).toContain("<Faqs faqs={ADD_FAQS} />");
    expect(page).toContain("faqPage(ADD_FAQS, url)");
    expect(ADD_FAQS.length).toBeGreaterThanOrEqual(4);
    for (const f of ADD_FAQS) {
      expect(f.q).toMatch(/\?$/);
      expect(f.a).not.toMatch(/[<>`[\]]|\*\*/);
      expect(wordCount(f.a), f.q).toBeLessThanOrEqual(60);
    }
  });

  it("is plain, quiet and true to the network's own rules: free, no paid place, only agent-ready sites", () => {
    const words = [visible(read(PAGE)), ADD_PAGE.lede, ADD_PAGE.description, ...ADD_FAQS.flatMap((f) => [f.q, f.a])]
      .join("\n")
      .replace(/\s+/g, " ");
    expect(words).not.toMatch(/\b(the first|the only|best|verified|certified|guaranteed?)\b/i);
    expect(words).not.toMatch(/\b(seamless(ly)?|effortless(ly)?|revolutionary|supercharge\w*|unlock\w*|leading)\b/i);
    expect(words).toContain("nobody can pay for a place");
    expect(words).toContain("isn't listed");
    expect(words).toContain("A local business is listed once its site matches its entry on public maps or registers");
    const styles = read(PAGE).match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\bred\b|crimson|tomato/i);
  });
});
