/**
 * The translated pages, put together: a sentence's references resolved in the page's language, and
 * each page's head (title, description, social card, every version of it, and what it is as data).
 * The route files (src/pages/tools.astro, src/pages/guides/<slug>.astro, src/pages/[lang]/[...path].astro)
 * give the Layout what localPage returns, and the page's body (src/components/LocalBody.astro).
 */
import { DICTS } from "../i18n";
import type { Dict, Head } from "../i18n/types";
import type { Faq } from "./faq";
import { GUIDE_SLUGS, type GuideSlug, guideHref } from "./guides";
import { START_URL } from "./hosted";
import {
  type Alternate,
  alternates,
  isLang,
  LANGS,
  type Lang,
  LOCAL_GUIDES,
  PAGE_IDS,
  type PageId,
  pagePath,
  TOOL_IDS,
  type ToolId,
  toolEn,
  toolPath,
} from "./i18n";
import { inline, plain } from "./inline";

/** When these pages' words last changed; the guides' Article data and their "Updated" line say it. */
export const LOCAL_MODIFIED = "2026-10-19";

const REF = /\]\(@([a-z0-9:-]+)\)/g;

/** A reference's address in a language: @<page>, @tool:<id>, @guide:<slug> or @start. */
export function refHref(ref: string, lang: Lang): string {
  if (ref === "start") return START_URL;
  if (ref.startsWith("tool:")) {
    const id = ref.slice(5);
    if ((TOOL_IDS as readonly string[]).includes(id)) return toolPath(id as ToolId, lang);
  } else if (ref.startsWith("guide:")) {
    const slug = ref.slice(6);
    if ((GUIDE_SLUGS as readonly string[]).includes(slug)) return guideHref(slug as GuideSlug);
  } else if ((PAGE_IDS as readonly string[]).includes(ref)) {
    return pagePath(ref as PageId, lang);
  }
  throw new Error(`no page for the reference @${ref}`);
}

/** The sentence with every @reference replaced by its address in the language. */
export const resolve = (text: string, lang: Lang): string =>
  text.replace(REF, (_all, ref: string) => `](${refHref(ref, lang)})`);

/** The tools whose page in a language is the English one, by address: a link to one says so. */
const englishTools = (lang: Lang): ReadonlySet<string> =>
  new Set(TOOL_IDS.filter((t) => toolEn(t, lang)).map((t) => toolPath(t, lang)));

/** The sentence as HTML, its references resolved, a link to an English-only tool marked as such. */
export const rich = (text: string, lang: Lang): string => inline(resolve(text, lang), englishTools(lang));

/** The words a page's head gives, by page. */
export function headOf(d: Dict, id: PageId): Head {
  switch (id) {
    case "tools":
      return d.hub;
    case "validate-llms-txt":
      return d.validate;
    case "llms-txt-examples":
      return d.examples;
    case "ai-agent-assisted-payments":
      return d.payments;
  }
}

/** The questions a page answers, by page. */
export function faqsOf(d: Dict, id: PageId): readonly Faq[] {
  switch (id) {
    case "validate-llms-txt":
      return d.validate.faqs;
    case "llms-txt-examples":
      return d.examples.faqs;
    case "ai-agent-assisted-payments":
      return d.payments.faqs;
    default:
      return [];
  }
}

/** A page's social card: made for the page in each language by scripts/og-local.mjs. */
export const ogCard = (id: PageId, lang: Lang) => `/art/og-${id}-${lang}-v1.png`;

/** What the Layout needs for one translated page. */
export interface LocalLayout {
  readonly title: string;
  readonly description: string;
  readonly image: string;
  readonly imageAlt: string;
  readonly type: "website" | "article";
  readonly lang: Lang;
  readonly alternates: readonly Alternate[];
  readonly ld: readonly Record<string, unknown>[];
}

/** One translated page: its id, its language, and its head. */
export function localPage(
  id: PageId,
  lang: Lang,
  site?: URL | string,
): { id: PageId; lang: Lang; layout: LocalLayout } {
  const base = (site?.toString() ?? "https://surfingdog.ai/").replace(/\/+$/, "");
  const d = DICTS[lang];
  const head = headOf(d, id);
  const url = `${base}${pagePath(id, lang)}`;
  const image = ogCard(id, lang);
  const hub = { name: d.hub.short, url: `${base}${pagePath("tools", lang)}` };
  // The English guides sit under /guides/, the checklist's hub; the others under their language's hub.
  const parent = id === "tools" ? null : lang === "en" ? { name: "Guides", url: `${base}${guideHref("")}` } : hub;
  const crumbs = [
    { name: d.ui.home, url: `${base}/` },
    ...(parent ? [parent] : []),
    { name: id === "tools" ? d.hub.short : head.short, url },
  ];
  const ld: Record<string, unknown>[] = [];
  if (id === "tools") {
    ld.push({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: head.h1,
      headline: head.h1,
      description: head.description,
      inLanguage: lang,
      url,
      image: `${base}${image}`,
      publisher: { "@id": `${base}/#org` },
      hasPart: [
        ...TOOL_IDS.map((t) => ({
          "@type": "WebApplication",
          name: d.hub.tools[t].name,
          description: d.hub.tools[t].line,
          url: `${base}${toolPath(t, lang)}`,
          inLanguage: toolEn(t, lang) ? "en" : lang,
          applicationCategory:
            t === "mcp-server" || t === "agent-inbox" ? "DeveloperApplication" : "BusinessApplication",
          operatingSystem: "Web",
          isAccessibleForFree: true,
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        })),
        ...LOCAL_GUIDES.map((g) => ({
          "@type": "Article",
          headline: headOf(d, g).h1,
          description: d.hub.guides[g],
          url: `${base}${pagePath(g, lang)}`,
          inLanguage: lang,
        })),
      ],
    });
  } else {
    ld.push({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: head.h1,
      description: head.description,
      inLanguage: lang,
      datePublished: LOCAL_MODIFIED,
      dateModified: LOCAL_MODIFIED,
      author: { "@type": "Organization", name: "Surfing Dog", url: `${base}/` },
      publisher: { "@id": `${base}/#org` },
      image: `${base}${image}`,
      mainEntityOfPage: url,
      url,
    });
  }
  ld.push({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: c.url })),
  });
  if (id === "validate-llms-txt") {
    ld.push({
      "@context": "https://schema.org",
      "@type": "HowTo",
      name: head.h1,
      description: head.intro,
      inLanguage: lang,
      totalTime: "PT5M",
      step: d.validate.steps.map((s, i) => ({
        "@type": "HowToStep",
        position: i + 1,
        name: s.name,
        text: plain(s.text),
        url: `${url}#step-${i + 1}`,
      })),
    });
  }
  const faqs = faqsOf(d, id);
  if (faqs.length) {
    ld.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      url,
      inLanguage: lang,
      mainEntity: faqs.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });
  }
  return {
    id,
    lang,
    layout: {
      title: head.title,
      description: head.description,
      image,
      // The heading, then the card's idea, as two sentences (a question keeps its own mark).
      imageAlt: `${head.h1}${/[?!.]$/.test(head.h1) ? "" : "."} ${head.idea.replace(/\n/g, " ")}`,
      type: id === "tools" ? "website" : "article",
      lang,
      alternates: alternates(id, base),
      ld,
    },
  };
}

/** Every language's version of a page, for the language row: its own name and address. */
export function versions(id: PageId): { lang: Lang; href: string }[] {
  return LANGS.map((l) => ({ lang: l, href: pagePath(id, l) }));
}

export { isLang };

/** A link at the foot of a page: its words, its address, and whether that page is in English only. */
export interface RelatedLink {
  readonly label: string;
  readonly href: string;
  readonly en: boolean;
}

/** What each guide links at its foot: its tools, then the guides beside it. */
const RELATED: Readonly<Record<Exclude<PageId, "tools">, readonly string[]>> = {
  "validate-llms-txt": [
    "tool:llms-txt",
    "tool:llms-txt-generator",
    "llms-txt-examples",
    "guide:llms-txt",
    "tool:ai-crawlers",
    "tools",
  ],
  "llms-txt-examples": [
    "tool:llms-txt-generator",
    "tool:llms-txt",
    "validate-llms-txt",
    "guide:findable-agent-doors",
    "guide:business-details-for-ai",
    "tools",
  ],
  "ai-agent-assisted-payments": [
    "guide:ai-assistant-payments",
    "tool:ucp",
    "guide:sell-through-ai-assistants",
    "guide:ai-assistant-bookings",
    "tools",
  ],
};

export function relatedOf(id: Exclude<PageId, "tools">, lang: Lang): RelatedLink[] {
  const d = DICTS[lang];
  return RELATED[id].map((ref) => {
    const href = refHref(ref, lang);
    if (ref.startsWith("tool:")) {
      const id = ref.slice(5) as ToolId;
      return { label: d.hub.tools[id].name, href, en: toolEn(id, lang) };
    }
    if (ref.startsWith("guide:")) {
      return { label: d.hub.checklist.names[ref.slice(6) as GuideSlug], href, en: lang !== "en" };
    }
    return { label: headOf(d, ref as PageId).short, href, en: false };
  });
}

/**
 * The free tools and their guides as a section of our own llms.txt (astro.config.mjs), in the
 * proposal's own form: an H2, then one Markdown link a line, with a note. English, with the other
 * languages' hub addresses on the hub's line.
 */
export function freeToolsLlms(site = "https://surfingdog.ai"): string {
  const base = site.replace(/\/+$/, "");
  const d = DICTS.en;
  const others = LANGS.filter((l) => l !== "en")
    .map((l) => `${base}${pagePath("tools", l)}`)
    .join(", ");
  return [
    "## Free tools",
    "",
    ...TOOL_IDS.map((t) => `- [${d.hub.tools[t].name}](${base}${toolPath(t, "en")}): ${d.hub.tools[t].line}`),
    ...LOCAL_GUIDES.map((g) => `- [${headOf(d, g).h1}](${base}${pagePath(g, "en")}): ${d.hub.guides[g]}`),
    `- [${d.hub.h1}](${base}${pagePath("tools", "en")}): every tool and guide, also in Spanish, Portuguese, French, German and Italian at ${others}`,
  ].join("\n");
}
