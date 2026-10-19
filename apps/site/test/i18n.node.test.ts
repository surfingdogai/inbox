import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DICTS, navWord } from "../src/i18n";
import { type Dict, KIND_IDS } from "../src/i18n/types";
import { GUIDE_SLUGS, guideHref, wordCount } from "../src/lib/guides";
import { START_URL } from "../src/lib/hosted";
import {
  alternates,
  LANGS,
  LOCAL_GUIDES,
  localRoutes,
  longDate,
  PAGE_IDS,
  PAGES,
  pageAt,
  TOOL_IDS,
  TOOLS,
  toolEn,
} from "../src/lib/i18n";
import { inline, linksIn, plain } from "../src/lib/inline";
import { faqsOf, freeToolsLlms, headOf, LOCAL_MODIFIED, localPage, ogCard, relatedOf, resolve } from "../src/lib/local";

/**
 * The free tools' hub and its three guides, in six languages (src/lib/i18n.ts, src/i18n): every
 * language says everything English says, fits a search result, makes no claim of being first or
 * best, links only pages that answer, and names every version of every page, both ways. The examples
 * are valid llms.txt on reserved addresses. Checked from the sources; when the site has been built,
 * the built pages, their structured data and the sitemap are checked too.
 */
const site = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(site(path), "utf8");
const DIST = site("dist");
const BUILT = existsSync(`${DIST}/tools/index.html`);

/** Every string in a dictionary, with where it is. */
function strings(v: unknown, at = ""): [string, string][] {
  if (typeof v === "string") return [[at, v]];
  if (Array.isArray(v)) return v.flatMap((x, i) => strings(x, `${at}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => strings(x, at ? `${at}.${k}` : k));
  return [];
}

/** A dictionary's shape: its keys, with arrays as their length, except where languages may differ. */
function shape(v: unknown, at = ""): string[] {
  if (Array.isArray(v)) {
    if (/faqs$/.test(at)) return [`${at}[]`];
    return [`${at}[${v.length}]`, ...v.flatMap((x, i) => shape(x, `${at}[${i}]`))];
  }
  if (v && typeof v === "object") {
    return Object.entries(v).flatMap(([k, x]) => {
      const p = at ? `${at}.${k}` : k;
      // The bar's words are checked on their own below; a statement exists where its language needs it.
      if (p === "ui.nav" || p === "payments.statement") return [];
      return [p, ...shape(x, p)];
    });
  }
  return [];
}

/** What a reader sees of an .astro file: frontmatter, comments, styles and scripts removed. */
const visible = (source: string) =>
  source
    .replace(/^---[\s\S]*?\n---\n/, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ");
/** The markup with every {expression} taken out, the nested ones too. */
function withoutExpressions(text: string): string {
  let out = text;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(/\{[^{}]*\}/g, " ");
  }
  return out;
}

/**
 * llms.txt as llmstxt.org writes it, for our examples: an H1 first, then a > summary, details with no
 * heading, then H2 sections whose lines are Markdown links with a note; no ### anywhere; at least 50
 * characters and one link. `holes` allows {placeholders} for the template. Returns what is wrong.
 */
function llmsProblems(file: string, holes = false): string[] {
  const out: string[] = [];
  const lines = file.split("\n");
  if (!/^# \S/.test(lines[0] ?? "")) out.push(`line 1 is not "# Name": ${lines[0]}`);
  if (lines.filter((l) => /^# /.test(l)).length !== 1) out.push("more than one # line");
  if (!/^> \S/.test(lines[2] ?? "")) out.push("no > summary after the name");
  if (file.length < 50) out.push("shorter than 50 characters");
  let inSection = false;
  let links = 0;
  lines.forEach((l, i) => {
    if (/^#{3,} /.test(l)) out.push(`line ${i + 1}: ${l} is deeper than ##`);
    if (/^## /.test(l)) inSection = true;
    // A template's address may be a {hole in words}; a real one is a whole https address.
    const link = (
      holes
        ? /^- \[([^\]]+)\]\((https:\/\/(?:\{[^}]+\}|[^)\s])+)\)(?:: \S.*)?$/
        : /^- \[([^\]]+)\]\((https:\/\/[^)\s]+)\)(?:: \S.*)?$/
    ).exec(l);
    if (link) {
      links++;
      if (!inSection) out.push(`line ${i + 1}: a link before the first ## section`);
      const host = holes ? "" : new URL(link[2] ?? "").hostname;
      if (!holes && !host.endsWith(".example")) out.push(`line ${i + 1}: ${host} is not a reserved .example address`);
    } else if (inSection && l.trim() !== "" && !/^## /.test(l)) {
      out.push(`line ${i + 1}: not a list link: ${l}`);
    }
    if (/\bhttp:\/\//.test(l)) out.push(`line ${i + 1}: http, not https`);
  });
  if (links === 0) out.push("no Markdown link");
  if (!lines.includes("## Optional")) out.push("no ## Optional section");
  return out;
}

/** Claims a page of ours never makes, in each language: first, only, best, number one, about a tool. */
const CLAIMS: RegExp[] = [
  /#1|number one|world'?s first/i,
  /\b(first|only|best|leading)\s+(free\s+)?(tool|checker|validator|generator|guide|platform)/i,
  /\b(primer|primera|únic[oa]|mejor)\s+(herramienta|validador|comprobador|generador|guía)/i,
  /\b(primeir[oa]|únic[oa]|melhor)\s+(ferramenta|validador|verificador|gerador|guia)/i,
  /\b(premi(er|ère)|seul(e)?|meilleur(e)?)\s+(outil|validateur|vérificateur|générateur|guide)/i,
  /\b(erste[rns]?|einzige[rns]?|beste[rns]?)\s+(tool|checker|validator|generator|ratgeber)/i,
  /\b(prim[oa]|unic[oa]|migliore)\s+(strumento|validatore|generatore|guida)/i,
  /\b(seamless(ly)?|effortless(ly)?|revolutionary|game.?chang\w*|supercharge\w*|cutting.?edge|world.?class|unlock\w*)\b/i,
];

/** The bar's and the footer's words, as their sources write them. */
const NAV_LABELS = [
  ...new Set(
    ["src/components/Nav.astro", "src/components/Footer.astro"].flatMap((p) => [
      ...[...read(p).matchAll(/label: "([^"]+)"/g)].map((m) => m[1] ?? ""),
      ...[...read(p).matchAll(/\bw\("([^"]+)"\)/g)].map((m) => m[1] ?? ""),
      ...[...read(p).matchAll(/title: "([^"]+)"/g)].map((m) => m[1] ?? ""),
    ]),
  ),
];
/** Names that stay as they are in every language: our three products, and names that are names. */
const KEPT = new Set(["Blog", "GitHub", "Auto"]);

/**
 * The pages the network registers on this address, pinned from its own language catalogues (each
 * tool's path) as its free-tools release serves them, beside /check and /leaderboard. Pinned rather than read from TOOLS, so a tool address the network does not serve
 * fails here instead of passing because it is listed. A language's own whole-site check joins the
 * list when the network publishes it (path.check).
 */
const NETWORK_PATHS: ReadonlySet<string> = new Set([
  "/check",
  "/leaderboard",
  ...["", "/es", "/pt", "/fr", "/de", "/it"].flatMap((pre) => [
    `${pre}/check/llms-txt`,
    `${pre}/check/ucp`,
    `${pre}/check/agent-inbox`,
  ]),
  "/check/llms-txt/generator",
  "/es/check/llms-txt/generador",
  "/pt/check/llms-txt/gerador",
  "/fr/check/llms-txt/generateur",
  "/de/check/llms-txt/generator",
  "/it/check/llms-txt/generatore",
  "/check/ai-crawlers",
  "/es/check/rastreadores-ia",
  "/pt/check/rastreadores-ia",
  "/fr/check/robots-ia",
  "/de/check/ki-crawler",
  "/it/check/crawler-ia",
  "/check/mcp-server",
  "/es/check/servidor-mcp",
  "/pt/check/servidor-mcp",
  "/fr/check/serveur-mcp",
  "/de/check/mcp-server",
  "/it/check/server-mcp",
]);
const NETWORK = (p: string) => NETWORK_PATHS.has(p);

/** Whether a path this site links answers: a page here, a guide, a network page or a file. */
function answers(href: string): boolean {
  if (href.startsWith("https://")) return true;
  const p = href.replace(/[?#].*$/, "");
  if (NETWORK(p)) return true;
  if (pageAt(p)) return true;
  if (p === "/guides/") return true;
  const guide = /^\/guides\/([a-z0-9-]+)\/$/.exec(p)?.[1];
  if (guide) return (GUIDE_SLUGS as readonly string[]).includes(guide);
  if (p === "/spec/check/") return existsSync(site("src/pages/spec/check.astro"));
  return false;
}

describe("the translated pages: languages and addresses", () => {
  it("live at an address in every language, English unprefixed, every other under its own /<lang>/", () => {
    expect([...LANGS]).toEqual(["en", "es", "pt", "fr", "de", "it"]);
    const all: string[] = [];
    for (const id of PAGE_IDS) {
      expect(Object.keys(PAGES[id]).sort(), id).toEqual([...LANGS].sort());
      for (const l of LANGS) {
        const p = PAGES[id][l];
        all.push(p);
        expect(p, `${id} ${l}`).toMatch(/^\/[a-z0-9/-]+\/$/);
        if (l === "en") expect(p, id).not.toMatch(/^\/(es|pt|fr|de|it)\//);
        else expect(p.startsWith(`/${l}/`), `${id} ${l}`).toBe(true);
        expect(pageAt(p)).toEqual({ id, lang: l });
      }
    }
    expect(new Set(all).size).toBe(all.length);
    // The routes: English as files of their own, the rest through [lang]/[...path].
    expect(existsSync(site("src/pages/tools.astro"))).toBe(true);
    for (const g of LOCAL_GUIDES)
      expect(existsSync(site(`src/pages${PAGES[g].en.replace(/\/$/, "")}.astro`)), g).toBe(true);
    expect(
      localRoutes()
        .map((r) => `/${r.lang}/${r.rest}/`)
        .sort(),
    ).toEqual(all.filter((p) => !pageAt(p)?.lang.startsWith("en")).sort());
    // The guides' slugs are in each language where people search a word of their own.
    expect(PAGES["validate-llms-txt"].de).toBe("/de/ratgeber/llms-txt-validieren/");
    expect(PAGES["llms-txt-examples"].es).toBe("/es/guias/ejemplos-llms-txt/");
    expect(PAGES["ai-agent-assisted-payments"].pt).toBe("/pt/guias/pagamentos-agenticos/");
  });

  it("name every version of each page, both ways, with English as the x-default", () => {
    for (const id of PAGE_IDS) {
      const alts = alternates(id);
      expect(alts.map((a) => a.hreflang)).toEqual([...LANGS, "x-default"]);
      expect(alts.at(-1)?.href).toBe(`https://surfingdog.ai${PAGES[id].en}`);
      for (const l of LANGS) {
        // The same set from every version: hreflang pairs are complete and return.
        const page = localPage(id, l);
        expect(page.layout.alternates, `${id} ${l}`).toEqual(alts);
        expect(page.layout.lang).toBe(l);
      }
    }
  });

  it("send the tools to the network's addresses: /check in English, /<lang>/check in the others, leaf in the language", () => {
    for (const t of TOOL_IDS) {
      expect(Object.keys(TOOLS[t]).sort(), t).toEqual([...LANGS].sort());
      expect(TOOLS[t].en, t).toMatch(/^\/check(\/[a-z0-9/-]+)?$/);
      for (const l of LANGS.filter((x) => x !== "en")) {
        // The whole-site check is English until the network publishes one in the language.
        if (t === "check") expect(TOOLS[t][l] === "/check" || TOOLS[t][l] === `/${l}/check`, l).toBe(true);
        else expect(TOOLS[t][l], `${t} ${l}`).toMatch(new RegExp(`^/${l}/check(/[a-z0-9/-]+)?$`));
        expect(toolEn(t, l), `${t} ${l}`).toBe(TOOLS[t][l] === TOOLS[t].en);
      }
      // Every address is one the network registers, in every language.
      for (const l of LANGS) expect(NETWORK(TOOLS[t][l]), `${t} ${l}: ${TOOLS[t][l]}`).toBe(true);
    }
    expect(toolEn("check", "es")).toBe(true);
    expect(toolEn("check", "en")).toBe(false);
    // The network serves the first two today, and they never move.
    expect(TOOLS.check.en).toBe("/check");
    expect(TOOLS["llms-txt"].en).toBe("/check/llms-txt");
    expect(TOOLS["ai-crawlers"].de).toBe("/de/check/ki-crawler");
    expect(TOOLS["llms-txt-generator"].fr).toBe("/fr/check/llms-txt/generateur");
  });

  it("take the language from the address only: no redirect, no IP, no Accept-Language, no cookie", () => {
    const sources = [
      "src/lib/i18n.ts",
      "src/lib/local.ts",
      "src/components/LangRow.astro",
      "src/components/LocalBody.astro",
      "src/pages/[lang]/[...path].astro",
      "src/layouts/Layout.astro",
    ].map((p) => [p, read(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")] as const);
    for (const [p, src] of sources) {
      expect(src, p).not.toMatch(
        /Accept-Language|navigator\.language|Astro\.redirect|location\.(href|replace|assign)\s*=?\s*["'`]\/(es|pt|fr|de|it)/i,
      );
    }
    expect(read("src/layouts/Layout.astro")).toContain("<html lang={lang}>");
    expect(read("src/layouts/Layout.astro")).toMatch(
      /<link rel="alternate" hreflang=\{a\.hreflang\} href=\{a\.href\} \/>/,
    );
  });
});

describe("the dictionaries", () => {
  const en = DICTS.en;

  it("say in every language everything English says, with the same steps, errors, examples and standards", () => {
    const want = shape(en);
    for (const l of LANGS) {
      expect(DICTS[l].lang, l).toBe(l);
      expect(shape(DICTS[l]), l).toEqual(want);
      expect(
        DICTS[l].examples.kinds.map((k) => k.id),
        l,
      ).toEqual([...KIND_IDS]);
      expect(DICTS[l].payments.faqs.length, l).toBeGreaterThanOrEqual(4);
    }
  });

  it("have the bar's and the footer's words in every language, but for the products' names", () => {
    expect(NAV_LABELS.length).toBeGreaterThan(30);
    expect(NAV_LABELS).toContain("Free tools");
    for (const l of LANGS.filter((x) => x !== "en")) {
      for (const label of NAV_LABELS) {
        if (KEPT.has(label)) continue;
        expect(DICTS[l].ui.nav[label], `${l}: ${label}`).toBeTruthy();
      }
    }
    // English is the source: no English entry overrides its own words.
    expect(Object.keys(en.ui.nav)).toEqual([]);
  });

  it("fit a search result: titles of at most 60 characters, descriptions of 80 to 155, answers of at most 50 words", () => {
    for (const l of LANGS) {
      const d = DICTS[l];
      const titles = PAGE_IDS.map((id) => headOf(d, id).title);
      expect(new Set(titles).size, l).toBe(titles.length);
      for (const id of PAGE_IDS) {
        const h = headOf(d, id);
        expect(h.title.length, `${l} ${id}: ${h.title}`).toBeLessThanOrEqual(60);
        expect(h.title.length, `${l} ${id}`).toBeGreaterThan(25);
        expect(h.description.length, `${l} ${id}: ${h.description}`).toBeLessThanOrEqual(155);
        expect(h.description.length, `${l} ${id}: ${h.description}`).toBeGreaterThanOrEqual(80);
        expect(h.h1.length, `${l} ${id}`).toBeLessThanOrEqual(80);
        for (const f of faqsOf(d, id)) {
          expect(wordCount(f.a), `${l} ${id}: ${f.a}`).toBeLessThanOrEqual(50);
          expect(f.q.trim()).toMatch(/[?？]$/);
        }
      }
      expect(wordCount(d.payments.answer), `${l}: ${d.payments.answer}`).toBeLessThanOrEqual(50);
    }
  });

  it("make no claim of being first, only, best or number one, in any language", () => {
    for (const l of LANGS) {
      for (const [at, text] of strings(DICTS[l])) {
        const t = text.replace(/https?:\/\/\S+/g, " ");
        for (const re of CLAIMS) expect(re.test(t), `${l} ${at}: ${text}`).toBe(false);
      }
    }
    // And no figure we didn't count: the only numbers about the directory are read live, dated.
    for (const l of LANGS) {
      const said = strings(DICTS[l].payments)
        .map(([, s]) => s)
        .join("\n");
      expect(said, l).not.toMatch(/\b\d{1,3}(?:[.,\u00a0 ]\d{3})+\b|\b\d+\s?%/);
      // The base is every site checked, not the agent-ready ones: the share is never read as "most".
      expect(DICTS[l].payments.counts.line, l).toContain("{pay}");
      expect(DICTS[l].payments.counts.line, l).toContain("{checked}");
      expect(DICTS[l].payments.counts.line, l).not.toContain("{ready}");
      expect(DICTS[l].payments.counts.line, l).toContain("{date}");
    }
  });

  it("resolve every reference, and every link they make goes to a page that answers", () => {
    for (const l of LANGS) {
      for (const [at, text] of strings(DICTS[l])) {
        if (!text.includes("](")) continue;
        // Inside example files and FAQ answers a link is the format being shown, not a link we make.
        if (/\.file$|\.sample$|faqs\[\d+\]\.a$|\.idea$/.test(at)) continue;
        const out = resolve(text, l);
        expect(out, `${l} ${at}`).not.toContain("](@");
        for (const href of linksIn(out)) expect(answers(href), `${l} ${at}: ${href}`).toBe(true);
      }
      for (const id of LOCAL_GUIDES) {
        for (const r of relatedOf(id, l)) expect(answers(r.href), `${l} ${id}: ${r.href}`).toBe(true);
      }
    }
  });

  it("show only valid llms.txt: each example, and each sample, on reserved .example addresses", () => {
    for (const l of LANGS) {
      for (const k of DICTS[l].examples.kinds) {
        expect(llmsProblems(k.file, k.id === "template"), `${l} ${k.id}`).toEqual([]);
        if (k.id === "template") {
          expect(k.file, l).toMatch(/\{[^}]+\}/);
          continue;
        }
        // Doors are named so a reader knows them: MCP in the words, or the inbox's or UCP's own file.
        const doors = k.file
          .split(/\n## /)
          .find((s, i) => i > 0 && /agent-inbox\.json|\/mcp\)|\.well-known\/ucp/.test(s));
        for (const line of (doors ?? "").split("\n").filter((x) => x.startsWith("- ["))) {
          expect(/MCP|agent-inbox\.json|\.well-known\/ucp/.test(line), `${l} ${k.id}: ${line}`).toBe(true);
        }
      }
      expect(llmsProblems(DICTS[l].validate.sample), `${l} sample`).toEqual([]);
      // Some examples show the agents' section, and some show a business with no door yet.
      const withDoors = DICTS[l].examples.kinds.filter((k) => /agent-inbox\.json|\/mcp\)/.test(k.file));
      expect(withDoors.length, l).toBeGreaterThanOrEqual(5);
      expect(DICTS[l].examples.kinds.find((k) => k.id === "clinic")?.file, l).not.toMatch(/agent-inbox|mcp/);
    }
    // Never patient details, staff contacts or a private link in a clinic's file.
    for (const l of LANGS) {
      expect(DICTS[l].examples.kinds.find((k) => k.id === "clinic")?.file, l).not.toMatch(/@|tel:|wa\.me|whatsapp/i);
    }
  });

  it("name the agent inbox only where it fills the gap, as an option; never in the payments guide", () => {
    for (const l of LANGS) {
      const d: Dict = DICTS[l];
      const all = strings(d).map(([at, s]) => [at, s] as const);
      const starts = all.filter(([, s]) => s.includes("](@start)"));
      // Where a business has no door yet: the examples' doors, and what a valid file doesn't do.
      expect(
        starts.map(([at]) => at),
        l,
      ).toEqual(["validate.limits[1]", "examples.doors[0]"]);
      expect(
        strings(d.payments).some(([, s]) => s.includes("@start") || s.includes(START_URL)),
        l,
      ).toBe(false);
    }
  });

  it("mark up only code and links, escape the rest, and keep a plain version for data and e-mail", () => {
    expect(inline("a `<b>` and [x](/tools/) & <i>")).toBe(
      'a <code>&lt;b&gt;</code> and <a class="link" href="/tools/">x</a> &amp; &lt;i&gt;',
    );
    expect(inline("[out](https://example.org/x)")).toContain('rel="noopener"');
    expect(inline("[js](javascript:alert(1))")).not.toContain("<a ");
    expect(inline("[x](//evil.example)")).not.toContain("<a ");
    // A link to a page in English only says so, on a page in another language.
    expect(inline("[w](/check) and [t](/tools/)", new Set(["/check"]))).toBe(
      '<a class="link" href="/check" hreflang="en">w</a><span lang="en"> (EN)</span> and <a class="link" href="/tools/">t</a>',
    );
    expect(plain("Write `# Name` then [a link](/x).")).toBe("Write # Name then a link.");
    expect(resolve("[a](@tool:llms-txt) [b](@llms-txt-examples) [c](@guide:llms-txt) [d](@start)", "de")).toBe(
      `[a](/de/check/llms-txt) [b](/de/ratgeber/llms-txt-beispiele/) [c](${guideHref("llms-txt")}) [d](${START_URL})`,
    );
    expect(() => resolve("[x](@nowhere)", "en")).toThrow(/@nowhere/);
  });

  it("write every link with its note as the format does, the colon right after the link, in every language", () => {
    // llmstxt.org: "[name](url)" then optionally ":" and notes. French sets a space before a colon
    // in prose (a link to one of our pages may have one), but a parser takes a file's note only when
    // ":" comes straight after ")": wherever a sentence shows the format, a link to an address.
    for (const l of LANGS) {
      for (const [at, text] of strings(DICTS[l])) {
        expect(/\]\(https?:[^)]*\) :/.test(text), `${l} ${at}: ${text}`).toBe(false);
      }
    }
  });

  it("send the steps by e-mail with the checker's own address, not 'the top of this page'", () => {
    for (const l of LANGS) {
      const v = DICTS[l].validate;
      expect(v.mail.validator, l).toContain("{url}");
      expect(v.steps[4]?.text, l).toBeTruthy();
    }
    expect(read("src/components/LocalValidate.astro")).toMatch(/v\.mail\.validator\.replace\("\{url\}", checker\)/);
  });

  it("date the pages, in each language's own way", () => {
    expect(LOCAL_MODIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(longDate("2026-10-19", "en")).toBe("19 October 2026");
    expect(longDate("2026-10-19", "es")).toBe("19 de octubre de 2026");
    expect(longDate("2026-10-19", "de")).toBe("19. Oktober 2026");
    for (const l of LANGS) expect(DICTS[l].ui.updated, l).toContain("{date}");
  });
});

describe("the pages' data", () => {
  it("is valid JSON-LD: an Article or a CollectionPage in the page's language, a breadcrumb, and its questions word for word", () => {
    for (const id of PAGE_IDS) {
      for (const l of LANGS) {
        const { layout } = localPage(id, l);
        const ld = JSON.parse(JSON.stringify(layout.ld)) as Record<string, unknown>[];
        expect(ld, `${id} ${l}`).toEqual(layout.ld);
        for (const node of ld) expect(node["@context"], `${id} ${l}`).toBe("https://schema.org");
        const types = ld.map((n) => n["@type"]);
        expect(types, `${id} ${l}`).toContain(id === "tools" ? "CollectionPage" : "Article");
        expect(types).toContain("BreadcrumbList");
        expect(ld[0]?.inLanguage, `${id} ${l}`).toBe(l);
        const faq = ld.find((n) => n["@type"] === "FAQPage") as
          | { mainEntity: { name: string; acceptedAnswer: { text: string } }[] }
          | undefined;
        const faqs = faqsOf(DICTS[l], id);
        if (faqs.length) {
          expect(faq?.mainEntity.map((q) => [q.name, q.acceptedAnswer.text])).toEqual(faqs.map((f) => [f.q, f.a]));
        } else expect(faq).toBeUndefined();
        if (id === "validate-llms-txt") {
          const how = ld.find((n) => n["@type"] === "HowTo") as { step: { text: string; name: string }[] } | undefined;
          expect(
            how?.step.map((s) => s.name),
            l,
          ).toEqual(DICTS[l].validate.steps.map((s) => s.name));
          for (const s of how?.step ?? []) expect(s.text).not.toMatch(/`/);
        }
        if (id === "tools") {
          const parts = (ld[0] as { hasPart: { "@type": string; url: string }[] }).hasPart;
          expect(parts.filter((p) => p["@type"] === "WebApplication").length).toBe(TOOL_IDS.length);
          expect(parts.filter((p) => p["@type"] === "Article").length).toBe(LOCAL_GUIDES.length);
        }
        expect(layout.image).toBe(ogCard(id, l));
      }
    }
  });

  it("has a social card made for each page in each language, 1200×630", () => {
    for (const id of PAGE_IDS) {
      for (const l of LANGS) {
        const file = site(`public${ogCard(id, l)}`);
        expect(existsSync(file), file).toBe(true);
        const bytes = readFileSync(file);
        expect(bytes.subarray(0, 8).toString("hex"), file).toBe("89504e470d0a1a0a");
        expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], file).toEqual([1200, 630]);
      }
    }
  });

  it("puts the tools and guides in our own llms.txt, a Markdown link a line", () => {
    const section = freeToolsLlms();
    const lines = section.split("\n");
    expect(lines[0]).toBe("## Free tools");
    for (const l of lines.slice(2)) expect(l, l).toMatch(/^- \[[^\]]+\]\(https:\/\/surfingdog\.ai\/[^)\s]*\): \S/);
    expect(lines.length - 2).toBe(TOOL_IDS.length + LOCAL_GUIDES.length + 1);
    expect(read("astro.config.mjs")).toContain("freeToolsLlms()");
  });

  it("each guide has its own animation, still under reduced motion, and the page's words in its picture", () => {
    for (const c of ["CoverValidate", "CoverExamples", "CoverPay", "CoverTools"]) {
      const src = read(`src/components/${c}.astro`);
      expect(src, c).toMatch(/prefers-reduced-motion/);
      expect(src, c).toMatch(/role="img" aria-label=\{alt\}/);
      expect(src, c).toMatch(/IntersectionObserver/);
      // No colour of its own: tokens first, the brand's literal only as the fallback; never red.
      expect(src, c).not.toMatch(/\bred\b|crimson|tomato|#f00\b|#ff0000/i);
    }
    const body = ["LocalValidate", "LocalExamples", "LocalPayments", "LocalTools"].map((c) =>
      read(`src/components/${c}.astro`),
    );
    expect(body.every((b) => /class="lg-cover" data-idea=/.test(b))).toBe(true);
  });

  it("is no page of its own words in English only: the bodies print nothing that is not from a dictionary", () => {
    for (const c of [
      "LocalBody",
      "LocalValidate",
      "LocalExamples",
      "LocalPayments",
      "LocalTools",
      "LocalRelated",
      "LangRow",
    ]) {
      const text = withoutExpressions(visible(read(`src/components/${c}.astro`)))
        .replace(/<[^>]+>/g, " ")
        .replace(/[{}()·.:\s]+/g, " ")
        .trim();
      // What is left are attribute-free words written into the markup; only a source's name is.
      expect(text.replace(/HelpWithMyBank gov|EN/g, "").trim(), c).toBe("");
    }
  });
});

describe.runIf(BUILT)("the built pages", () => {
  const html = (path: string) => readFileSync(`${DIST}${path}index.html`, "utf8");

  it("carry their language, their canonical, and every version of themselves", () => {
    for (const id of PAGE_IDS) {
      for (const l of LANGS) {
        const path = PAGES[id][l];
        const page = html(path);
        expect(page, path).toContain(`<html lang="${l}"`);
        expect(page, path).toContain(`<link rel="canonical" href="https://surfingdog.ai${path}">`);
        const alts = [...page.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => [
          m[1],
          m[2],
        ]);
        expect(alts, path).toEqual(alternates(id).map((a) => [a.hreflang, a.href]));
        expect(page, path).toContain(`<meta property="og:image" content="https://surfingdog.ai${ogCard(id, l)}">`);
        // The language row: every other version linked, its own marked.
        for (const o of LANGS) {
          if (o === l) expect(page, path).toMatch(new RegExp(`<span aria-current="page" lang="${o}"`));
          else expect(page, path).toContain(`href="${PAGES[id][o]}" hreflang="${o}"`);
        }
      }
    }
  });

  it("have JSON-LD that parses, and questions on the page that are the data's, word for word", () => {
    const decode = (s: string) =>
      s
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
    for (const id of PAGE_IDS) {
      for (const l of LANGS) {
        const page = html(PAGES[id][l]);
        const blocks = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
          (m) => m[1] ?? "",
        );
        expect(blocks.length, PAGES[id][l]).toBe(1);
        const ld = JSON.parse(blocks[0] ?? "[]") as Record<string, unknown>[];
        const faq = ld.find((n) => n["@type"] === "FAQPage") as { mainEntity: { name: string }[] } | undefined;
        const asked = [...page.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)].map((m) => decode(m[1] ?? "").trim());
        expect(asked, PAGES[id][l]).toEqual((faq?.mainEntity ?? []).map((q) => q.name));
      }
    }
  });

  it("are in the sitemap with every version beside each, and our llms.txt lists them", () => {
    const sitemap = readdirSync(DIST)
      .filter((f) => /^sitemap-\d+\.xml$/.test(f))
      .map((f) => readFileSync(`${DIST}/${f}`, "utf8"))
      .join("\n");
    for (const id of PAGE_IDS) {
      for (const l of LANGS) {
        const url = `https://surfingdog.ai${PAGES[id][l]}`;
        const entry =
          new RegExp(`<url><loc>${url.replace(/[.?]/g, "\\$&")}</loc>([\\s\\S]*?)</url>`).exec(sitemap)?.[1] ?? "";
        expect(entry, url).not.toBe("");
        for (const a of alternates(id)) {
          expect(entry, `${url} → ${a.hreflang}`).toContain(
            `<xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}"/>`,
          );
        }
      }
    }
    const llms = readFileSync(`${DIST}/llms.txt`, "utf8");
    expect(llms).toContain(`\n${freeToolsLlms()}\n\n## Documentation Sets`);
  });

  it("post the llms.txt check from the validate guide to the llms.txt checker in the page's language", () => {
    for (const l of LANGS) {
      const page = html(PAGES["validate-llms-txt"][l]);
      expect(page).toContain(`<form class="lg-form" method="post" action="${TOOLS["llms-txt"][l]}">`);
      expect(page).not.toContain('name="focus"');
      expect(page).not.toContain('name="fresh"');
      expect(page).toContain('name="url"');
    }
  });

  it("link the hub and the check in the page's language from the bar and the footer, and say which links are English", () => {
    for (const id of PAGE_IDS) {
      for (const l of LANGS) {
        const page = html(PAGES[id][l]);
        // The footer's "Free tools" goes to the hub in the page's language.
        const free = new RegExp(`<a href="([^"]+)"[^>]*>\\s*<span[^>]*>${navWord(l, "Free tools")}</span>`).exec(page);
        expect(free?.[1], `${id} ${l}`).toBe(PAGES.tools[l]);
        if (l === "en") continue;
        // Every link to the English whole-site check says it is in English.
        for (const m of page.matchAll(/<a\b[^>]*\bhref="\/check"[^>]*>/g)) {
          if (/class="link"/.test(m[0])) expect(m[0], `${id} ${l}`).toContain('hreflang="en"');
        }
        expect(page, `${id} ${l}`).toMatch(/<meta property="og:locale" content="[a-z]{2}_[A-Z]{2}">/);
        expect([...page.matchAll(/<meta property="og:locale:alternate"/g)].length, `${id} ${l}`).toBe(LANGS.length - 1);
      }
    }
  });
});
