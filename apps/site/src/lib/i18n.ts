/**
 * The site in more than one language: which languages, and where each translated page lives. Small
 * businesses search in their own language, so the free tools' hub and the guides that go with the
 * tools are written in each of these, natively rather than word for word (src/i18n/<lang>.ts).
 *
 * The language comes from the address only: English has no prefix and is the x-default, every other
 * language lives under /<lang>/. Never from the visitor's IP, their browser's Accept-Language or a
 * cookie, and nothing redirects. Every translated page names all its versions (hreflang, in its head
 * and in the sitemap), and a quiet row of the languages' own names links them.
 *
 * Why not Astro's own `i18n` setting: Starlight reads it too, and would then build every docs page in
 * every language. The docs stay in English; the pages below are the only translated ones, so the
 * routes are ours (src/pages/tools.astro, src/pages/guides/<slug>.astro and
 * src/pages/[lang]/[...path].astro), and so is the sitemap's hreflang (astro.config.mjs).
 *
 * Adding a language: its code here, its dictionary in src/i18n (a type error names every key it
 * lacks), a path for each page below, and its tools' paths as the network serves them. The tests
 * (test/i18n.node.test.ts) fail until all of it is there.
 */

export const LANGS = ["en", "es", "pt", "fr", "de", "it"] as const;
export type Lang = (typeof LANGS)[number];

/** Each language by its own name, as the language row shows it. */
export const LANG_NAMES: Readonly<Record<Lang, string>> = {
  en: "English",
  es: "Español",
  pt: "Português",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
};

/** Each language as Open Graph names a locale, for a social preview of a translated page. */
export const OG_LOCALE: Readonly<Record<Lang, string>> = {
  en: "en_GB",
  es: "es_ES",
  pt: "pt_BR",
  fr: "fr_FR",
  de: "de_DE",
  it: "it_IT",
};

export const isLang = (s: string): s is Lang => (LANGS as readonly string[]).includes(s);

/**
 * The translated pages, each at its address in every language. A slug is in the language where
 * people search a word of their own (guías, ratgeber, validar, ejemplos…), and keeps the words they
 * type as they are (llms-txt). An address, once published, never changes.
 */
export const PAGE_IDS = ["tools", "validate-llms-txt", "llms-txt-examples", "ai-agent-assisted-payments"] as const;
export type PageId = (typeof PAGE_IDS)[number];

export const PAGES: Readonly<Record<PageId, Readonly<Record<Lang, string>>>> = {
  tools: {
    en: "/tools/",
    es: "/es/herramientas/",
    pt: "/pt/ferramentas/",
    fr: "/fr/outils/",
    de: "/de/tools/",
    it: "/it/strumenti/",
  },
  "validate-llms-txt": {
    en: "/guides/validate-llms-txt/",
    es: "/es/guias/validar-llms-txt/",
    pt: "/pt/guias/validar-llms-txt/",
    fr: "/fr/guides/valider-llms-txt/",
    de: "/de/ratgeber/llms-txt-validieren/",
    it: "/it/guide/validare-llms-txt/",
  },
  "llms-txt-examples": {
    en: "/guides/llms-txt-examples/",
    es: "/es/guias/ejemplos-llms-txt/",
    pt: "/pt/guias/exemplos-llms-txt/",
    fr: "/fr/guides/exemples-llms-txt/",
    de: "/de/ratgeber/llms-txt-beispiele/",
    it: "/it/guide/esempi-llms-txt/",
  },
  "ai-agent-assisted-payments": {
    en: "/guides/ai-agent-assisted-payments/",
    es: "/es/guias/pagos-agenticos/",
    pt: "/pt/guias/pagamentos-agenticos/",
    fr: "/fr/guides/paiement-agentique/",
    de: "/de/ratgeber/agentic-payments/",
    it: "/it/guide/pagamenti-agentici/",
  },
};

/** The three guides among the pages, in the order the hub lists them. */
export const LOCAL_GUIDES = ["validate-llms-txt", "llms-txt-examples", "ai-agent-assisted-payments"] as const;
export type LocalGuideId = (typeof LOCAL_GUIDES)[number];

/**
 * The free tools, which the network serves on this same address (its check lane reads the sites;
 * nothing here fetches anything). Their translated addresses are the network's own: the `check`
 * segment stays the same in every language so its routes stay simple, and the leaf is translated
 * where people search a word of their own.
 *
 * The whole-site check is /check in every language until the network publishes one of its own in a
 * language (its catalogue's path.check); a page in another language says that link is in English
 * (toolEn). Release order: the network serves /check and /check/llms-txt today. The other
 * addresses are the network's free-tools release; this site ships after it, the same rule as the
 * counts' "directory" block (src/lib/status.ts).
 */
export const TOOL_IDS = [
  "check",
  "llms-txt",
  "llms-txt-generator",
  "ai-crawlers",
  "mcp-server",
  "ucp",
  "agent-inbox",
] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export const TOOLS: Readonly<Record<ToolId, Readonly<Record<Lang, string>>>> = {
  check: { en: "/check", es: "/check", pt: "/check", fr: "/check", de: "/check", it: "/check" },
  "llms-txt": {
    en: "/check/llms-txt",
    es: "/es/check/llms-txt",
    pt: "/pt/check/llms-txt",
    fr: "/fr/check/llms-txt",
    de: "/de/check/llms-txt",
    it: "/it/check/llms-txt",
  },
  "llms-txt-generator": {
    en: "/check/llms-txt/generator",
    es: "/es/check/llms-txt/generador",
    pt: "/pt/check/llms-txt/gerador",
    fr: "/fr/check/llms-txt/generateur",
    de: "/de/check/llms-txt/generator",
    it: "/it/check/llms-txt/generatore",
  },
  "ai-crawlers": {
    en: "/check/ai-crawlers",
    es: "/es/check/rastreadores-ia",
    pt: "/pt/check/rastreadores-ia",
    fr: "/fr/check/robots-ia",
    de: "/de/check/ki-crawler",
    it: "/it/check/crawler-ia",
  },
  "mcp-server": {
    en: "/check/mcp-server",
    es: "/es/check/servidor-mcp",
    pt: "/pt/check/servidor-mcp",
    fr: "/fr/check/serveur-mcp",
    de: "/de/check/mcp-server",
    it: "/it/check/server-mcp",
  },
  ucp: {
    en: "/check/ucp",
    es: "/es/check/ucp",
    pt: "/pt/check/ucp",
    fr: "/fr/check/ucp",
    de: "/de/check/ucp",
    it: "/it/check/ucp",
  },
  "agent-inbox": {
    en: "/check/agent-inbox",
    es: "/es/check/agent-inbox",
    pt: "/pt/check/agent-inbox",
    fr: "/fr/check/agent-inbox",
    de: "/de/check/agent-inbox",
    it: "/it/check/agent-inbox",
  },
};

export const pagePath = (id: PageId, lang: Lang): string => PAGES[id][lang];
export const toolPath = (id: ToolId, lang: Lang): string => TOOLS[id][lang];

/** Whether a tool's page in a language is its English one: a link to it from that language says so. */
export const toolEn = (id: ToolId, lang: Lang): boolean => lang !== "en" && TOOLS[id][lang] === TOOLS[id].en;

export interface Alternate {
  /** A language, or x-default: the version for everyone else, which is English. */
  readonly hreflang: Lang | "x-default";
  readonly href: string;
}

/** Every version of a page, absolute, x-default last: the same list in the head and the sitemap. */
export function alternates(id: PageId, site = "https://surfingdog.ai"): Alternate[] {
  const base = site.replace(/\/+$/, "");
  return [
    ...LANGS.map((l) => ({ hreflang: l, href: `${base}${PAGES[id][l]}` })),
    { hreflang: "x-default" as const, href: `${base}${PAGES[id].en}` },
  ];
}

/** The page and language at a path, if it is one of the translated pages. */
export function pageAt(path: string): { id: PageId; lang: Lang } | undefined {
  const p = `/${path.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
  for (const id of PAGE_IDS) {
    for (const lang of LANGS) if (PAGES[id][lang] === p) return { id, lang };
  }
  return undefined;
}

/** The translated pages outside English, as [lang, path-after-it] pairs: the routes of [lang]/[...path]. */
export function localRoutes(): { lang: Exclude<Lang, "en">; id: PageId; rest: string }[] {
  const out: { lang: Exclude<Lang, "en">; id: PageId; rest: string }[] = [];
  for (const id of PAGE_IDS) {
    for (const lang of LANGS) {
      if (lang === "en") continue;
      const path = PAGES[id][lang];
      const prefix = `/${lang}/`;
      if (!path.startsWith(prefix)) throw new Error(`${id} in ${lang} must live under ${prefix}: ${path}`);
      out.push({ lang, id, rest: path.slice(prefix.length).replace(/\/+$/, "") });
    }
  }
  return out;
}

/** A date as the page's language writes it: 19 October 2026, 19 de octubre de 2026… */
export function longDate(iso: string, lang: Lang): string {
  // English as the rest of the site writes it, day first, for readers anywhere.
  return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : lang, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}
