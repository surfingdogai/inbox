import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { builtInConnectors } from "../../../packages/adapters/src/connectors/index";
import { ASSISTANTS } from "../src/lib/assistants";
import { faqPage } from "../src/lib/faq";
import { GUIDE_SLUGS, wordCount } from "../src/lib/guides";
import { linksIn, plain } from "../src/lib/inline";
import { APPLE_NOTICE, INTEGRATIONS, integration, SYSTEMS, untriedOf, WOO_NOTICE } from "../src/lib/integrations";
import { ROWS } from "../src/lib/integrations-table";
import { PLATFORMS, type Platform, pageOf, platformHref, platformNotices } from "../src/lib/platforms";
import { SHOPIFY_FAQS } from "../src/lib/shopify";
import { TOPICS, topicHref } from "../src/lib/topics";

/**
 * The platform pages at /integrations/<slug>/ (src/lib/platforms.ts), read against the connectors in
 * packages/adapters and their docs: one page for each platform an owner connects today, and none for
 * one still coming; each page's status is its connector's; its questions are the same words on the page
 * and in its FAQPage data; what it says of the platform's own products names where it was read; each is
 * long enough to be worth a page and says things no other page says; and its links go somewhere.
 * Checked without a build.
 */
const site = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(site(path), "utf8");
const PAGE = "src/pages/integrations/[slug].astro";
const SUFFIX = " · Surfing Dog";

const HOSTS = { "own server": builtInConnectors(), hosted: builtInConnectors({ hosted: true }) };
const readyEverywhere = (kind: string, preset?: string) =>
  Object.values(HOSTS).every((host) => {
    const c = host.find((x) => x.kind === kind);
    if (!c || (c.ready?.() ?? true) !== true) return false;
    const p = preset ? c.presets?.find((x) => x.id === preset) : undefined;
    return !preset || (Boolean(p) && (p?.ready?.() ?? true) === true);
  });

/** Everything a page says, in words. */
const words = (p: Platform) =>
  [
    p.title,
    p.heading,
    p.description,
    p.answer,
    ...p.can,
    p.stays.heading,
    ...p.stays.points,
    p.theirs.heading,
    ...p.theirs.facts.map((f) => f.text),
    p.theirs.beside,
    p.connect.text,
    ...p.faqs.flatMap((f) => [f.q, f.a]),
  ].join("\n");
/** What a page says in its own body, the questions apart. */
const body = (p: Platform) =>
  [...p.can, ...p.stays.points, ...p.theirs.facts.map((f) => f.text), p.theirs.beside, p.connect.text].join(" ");

const exists = (href: string): boolean => {
  const [path = "", anchor] = href.split("#");
  const p = path.replace(/\?.*$/, "");
  if (p === "/check") return true;
  if (p.startsWith("/docs/")) {
    const file = site(`src/content/docs${p.replace(/\/$/, "")}.md`);
    if (!existsSync(file)) return false;
    if (!anchor) return true;
    const ids = [...readFileSync(file, "utf8").matchAll(/^#{2,4} (.+)$/gm)].map((m) =>
      (m[1] ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s/g, "-"),
    );
    return ids.includes(anchor);
  }
  const slug = p.match(/^\/integrations\/([a-z0-9-]+)\/$/)?.[1];
  if (slug) return PLATFORMS.some((x) => x.slug === slug);
  const guide = p.match(/^\/guides\/([a-z0-9-]+)\/$/)?.[1];
  if (guide && (GUIDE_SLUGS as readonly string[]).includes(guide)) return true;
  const bare = p.replace(/\/+$/, "");
  return existsSync(site(`src/pages${bare}.astro`)) || existsSync(site(`src/pages${bare}/index.astro`));
};

describe("the platform pages", () => {
  it("are one for each platform an owner connects today, every name on the /inbox row among them", () => {
    expect(PLATFORMS.map((p) => p.slug)).toEqual([
      "shopify",
      "woocommerce",
      "square",
      "calendly",
      "calcom",
      "calendars",
      "beds24",
      "hostaway",
      "gloriafood",
      "flipdish",
      "servicem8",
      "stripe",
      "mollie",
    ]);
    for (const i of INTEGRATIONS) expect(pageOf(i.id), i.id).toBeDefined();
    for (const p of PLATFORMS) {
      expect(p.ids.length, p.slug).toBeGreaterThan(0);
      for (const id of p.ids) {
        const i = INTEGRATIONS.find((x) => x.id === id);
        expect(i, `${p.slug}: ${id}`).toBeDefined();
        expect(readyEverywhere(i?.connector ?? "", i?.preset), `${p.slug}: ${id} works with nothing set`).toBe(true);
      }
    }
  });

  it("have no page for a platform still coming", () => {
    const coming = ROWS.filter((r) => r.status === "Coming");
    for (const r of coming) expect(r.href, r.name).not.toMatch(/^\/integrations\//);
    const comingNames = coming.map((r) => r.name.toLowerCase().split(/[ ,]/)[0]);
    for (const p of PLATFORMS) expect(comingNames, p.slug).not.toContain(p.slug);
    // And the table sends every name that has a page to it.
    for (const r of ROWS.filter((x) => x.status === "Works" && x.connectors)) {
      const pages = PLATFORMS.filter((p) =>
        p.ids.some((id) => {
          const i = INTEGRATIONS.find((x) => x.id === id);
          return r.connectors?.some((c) => c.kind === i?.connector);
        }),
      );
      if (pages.length > 0)
        expect(
          pages.map((p) => platformHref(p.slug)),
          r.name,
        ).toContain(r.href);
    }
  });

  it("fit a search result: a title and a description of the right length, and no two pages the same", () => {
    const titles = [...PLATFORMS.map((p) => `${p.title}${SUFFIX}`)];
    for (const p of PLATFORMS) {
      const title = `${p.title}${SUFFIX}`;
      // The calendars page names its three calendars, as owners search for them, at the cost of a
      // title a result cuts short; every other page's fits.
      if (p.slug === "calendars")
        expect(p.title).toBe("Google Calendar, iCloud and Outlook: AI bookings that keep to your calendar");
      else expect(title.length, title).toBeLessThanOrEqual(70);
      expect(title.length, title).toBeGreaterThan(30);
      expect(p.description.length, `${p.slug}: ${p.description}`).toBeLessThanOrEqual(160);
      expect(p.description.length, p.slug).toBeGreaterThanOrEqual(80);
      expect(wordCount(p.answer), `${p.slug}: answer`).toBeLessThanOrEqual(50);
      expect(p.answer, p.slug).not.toMatch(/[`*[\]]/);
    }
    expect(new Set(titles).size).toBe(PLATFORMS.length);
    expect(new Set(PLATFORMS.map((p) => p.description)).size).toBe(PLATFORMS.length);
    expect(new Set(PLATFORMS.map((p) => p.heading)).size).toBe(PLATFORMS.length);
  });

  it("are not thin: each says enough, and what it says is its own", () => {
    const seen = new Map<string, string>();
    for (const p of PLATFORMS) {
      expect(p.can.length, p.slug).toBeGreaterThanOrEqual(3);
      expect(p.stays.points.length, p.slug).toBeGreaterThanOrEqual(3);
      expect(p.faqs.length, p.slug).toBeGreaterThanOrEqual(3);
      expect(wordCount(plain(body(p))), p.slug).toBeGreaterThanOrEqual(170);
      expect(wordCount(words(p)), p.slug).toBeGreaterThanOrEqual(450);
      // Its own name, or a name it covers, all through it.
      const name =
        p.slug === "calendars" ? /Calendar|iCloud|Outlook|Google/g : new RegExp(p.name.replace("®", ""), "g");
      expect((body(p).match(name) ?? []).length, p.slug).toBeGreaterThanOrEqual(3);
      // No bullet is another page's word for word.
      for (const line of [...p.can, ...p.stays.points]) {
        expect(seen.get(line), `${p.slug} repeats ${seen.get(line)}: ${line}`).toBeUndefined();
        seen.set(line, p.slug);
      }
    }
  });

  it("say what the platform's own AI does with a source for each line, beside the inbox's own words", () => {
    for (const p of PLATFORMS) {
      for (const f of p.theirs.facts) {
        expect(f.sources.length, `${p.slug}: ${f.text}`).toBeGreaterThanOrEqual(1);
        for (const s of f.sources) expect(s.href, s.label).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\//);
      }
      expect(p.theirs.beside.length, p.slug).toBeGreaterThan(40);
    }
    // The platforms with an AI of their own, as the research read their pages, each say so.
    for (const slug of [
      "shopify",
      "woocommerce",
      "square",
      "calendly",
      "hostaway",
      "flipdish",
      "servicem8",
      "stripe",
      "mollie",
    ])
      expect(PLATFORMS.find((p) => p.slug === slug)?.theirs.facts.length, slug).toBeGreaterThanOrEqual(1);
    const page = read(PAGE);
    expect(page).toContain("From its own pages, {PLATFORMS_AS_OF}:");
    expect(page).toContain('rel="noopener">{s.label}</a>');
  });

  it("say only what each connector does, in its doc's words where it counts", () => {
    const doc = (path: string) => read(`src/content/docs/docs/${path}.md`);
    const p = (slug: string) => PLATFORMS.find((x) => x.slug === slug) as Platform;
    expect(words(p("shopify"))).toContain("draft order");
    expect(doc("connectors/shopify")).toContain("An accepted quote or order becomes a draft order");
    expect(words(p("woocommerce"))).toContain("**pending**");
    expect(doc("connectors/woocommerce")).toContain("WooCommerce, pending,");
    expect(words(p("square"))).toContain("Appointments Plus or Premium");
    expect(doc("connectors/square")).toContain("Appointments Plus or Premium");
    expect(words(p("calendly"))).toContain("Standard and above");
    expect(doc("connectors/calendly")).toContain("Standard plan and above");
    expect(words(p("beds24"))).toContain("**Deposit due**");
    expect(doc("connectors/beds24")).toContain("flagged **Deposit due**");
    expect(words(p("hostaway"))).toContain("direct channel");
    expect(doc("connectors/hostaway")).toContain("direct channel");
    expect(words(p("flipdish"))).toContain("no order is written into Flipdish");
    expect(read("../../packages/adapters/src/connectors/pos/flipdish.ts")).toMatch(
      /no\s+\*?\s*order is written into Flipdish/,
    );
    expect(words(p("servicem8"))).toContain("Quote status");
    expect(doc("job-tools")).toContain("A job in Quote status");
    for (const slug of ["stripe", "mollie"]) expect(words(p(slug)), slug).toContain("a table's deposit");
    expect(read("../../packages/core/src/kitchen/deposits.ts")).toContain("A table's deposit");
    // Payment by the customer's assistant with a Shared Payment Token is built after 0.2.0 and its
    // guide is a draft: coming, never denied.
    expect(read("src/content/docs/docs/agent-payments.md")).toMatch(/^---\n[\s\S]*?\ndraft: true\n[\s\S]*?---\n/);
    expect(words(p("stripe"))).toContain(
      "Payment by the customer's assistant itself, with a Shared Payment Token, is in the inbox too, off until you switch it on in Settings.",
    );
    expect(words(p("stripe"))).not.toMatch(/doesn't take (Shared Payment Tokens|them)/);
    // What each writes, all of it.
    expect(words(p("shopify"))).toContain("It writes draft orders, tagged inbox, and its own webhooks");
    expect(doc("connectors/shopify")).toContain("| Writes | draft orders, tagged `inbox`; the webhooks below");
    // Each page's own doc names its platform.
    for (const x of PLATFORMS) {
      const [path = ""] = x.connect.doc.href.split("#");
      const text = read(`src/content/docs${path.replace(/\/$/, "")}.md`);
      const name = x.slug === "calendars" ? "iCloud" : x.name.replace("®", "");
      expect(text, x.slug).toContain(name);
    }
  });

  it("say GloriaFood's end, Shopify Inbox's difference and the owners' words, without the clashing names", () => {
    const g = PLATFORMS.find((x) => x.slug === "gloriafood") as Platform;
    expect(g.heading).toContain("30 April 2027");
    expect(g.answer).toContain("30 April 2027");
    expect(words(g)).toContain("FoodAmigos");
    expect(words(g)).toContain("It is not an ordering website for people.");
    const s = PLATFORMS.find((x) => x.slug === "shopify") as Platform;
    expect(s.theirs.heading).toBe("Shopify Inbox and an inbox for agents: the difference");
    // "Shopify AI inbox" and a bare "AI inbox" are other companies' products: never a title.
    for (const x of PLATFORMS) expect(`${x.title} ${x.heading}`, x.slug).not.toMatch(/\bAI inbox\b/i);
    // Ambiguous short names are written out.
    for (const x of PLATFORMS) {
      const text = words(x);
      if (/\bUCP\b/.test(text)) expect(text, x.slug).toContain("Universal Commerce Protocol (UCP)");
      if (/\bACP\b/.test(text)) expect(text, x.slug).toMatch(/Agentic Commerce Protocol/);
    }
  });

  it("show each question and its answer on the page, and give the FAQPage data the same words", () => {
    const page = read(PAGE);
    expect(page).toContain("<Faqs faqs={p.faqs} />");
    expect(page).toContain("faqPage(p.faqs, url)");
    for (const p of PLATFORMS) {
      const ld = faqPage(p.faqs, `https://surfingdog.ai${platformHref(p.slug)}`) as {
        "@type": string;
        mainEntity: { "@type": string; name: string; acceptedAnswer: { "@type": string; text: string } }[];
      };
      expect(ld["@type"]).toBe("FAQPage");
      expect(ld.mainEntity.map((q) => [q.name, q.acceptedAnswer.text])).toEqual(p.faqs.map((f) => [f.q, f.a]));
      expect(JSON.parse(JSON.stringify(ld))).toEqual(ld);
      for (const f of p.faqs) {
        expect(f.q, p.slug).toMatch(/\?$/);
        expect(f.a, `${p.slug}: ${f.q}`).not.toMatch(/[<>`[\]]|\]\(|\*\*/);
        expect(wordCount(f.a), `${p.slug}: ${f.q}`).toBeLessThanOrEqual(60);
      }
      expect(new Set(p.faqs.map((f) => f.q)).size, p.slug).toBe(p.faqs.length);
    }
  });

  it("end with the check, related platforms, its guides, the one line for a system and the credits, and no logo", () => {
    const page = read(PAGE);
    expect(page).toContain("<GuideCheck examples={[]} title={p.check} />");
    // The line is said of a calendar, shop, kitchen, stay or trade connection, never of a payment.
    expect(page).toContain("const systems = p.ids.map(integration).filter((i) => SYSTEMS.includes(i.group));");
    expect(page).toContain("{untried && <p>{untried}</p>}");
    expect(page).toContain('untriedOf(p.name.replace("®", ""))');
    for (const p of PLATFORMS) {
      const systems = p.ids.map(integration).filter((i) => SYSTEMS.includes(i.group));
      expect(systems.length > 0, p.slug).toBe(!["stripe", "mollie"].includes(p.slug));
    }
    expect(untriedOf("Beds24")).toMatch(/^Built from Beds24's documentation and tested against a stand-in; /);
    for (const p of PLATFORMS) {
      expect(p.guides.length, p.slug).toBeGreaterThanOrEqual(1);
      for (const g of p.guides) expect(exists(g.href), `${p.slug}: ${g.href}`).toBe(true);
    }
    expect(page).toContain("p.guides.map((g, i) => (");
    expect(page).toContain("the names are their owners' trademarks, and none endorses us.");
    expect(page).not.toMatch(/<img|\.svg/);
    for (const p of PLATFORMS) {
      expect(p.check, p.slug).toMatch(/^Check your (website|store|shop)$/);
      expect(p.related.length, p.slug).toBeGreaterThanOrEqual(2);
      for (const r of p.related) {
        expect(r, p.slug).not.toBe(p.slug);
        expect(
          PLATFORMS.some((x) => x.slug === r),
          `${p.slug}: ${r}`,
        ).toBe(true);
      }
    }
    const woo = PLATFORMS.find((x) => x.slug === "woocommerce") as Platform;
    expect(woo.name).toBe("WooCommerce®");
    expect(woo.heading).toContain("WooCommerce®");
    expect(woo.title).toContain("for WooCommerce®");
    expect(platformNotices(woo)).toContain(WOO_NOTICE);
    // A page naming WooCommerce among its related ones carries the notice too; one naming iCloud, Apple's.
    for (const p of PLATFORMS) {
      const names = [JSON.stringify(p), ...p.related.map((r) => PLATFORMS.find((x) => x.slug === r)?.name ?? "")].join(
        " ",
      );
      expect(platformNotices(p).includes(WOO_NOTICE), p.slug).toBe(names.includes("WooCommerce"));
      expect(platformNotices(p).includes(APPLE_NOTICE), p.slug).toBe(names.includes("iCloud"));
    }
    // Colours are the site's tokens; no red.
    const styles = page.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\bred\b|crimson|tomato/i);
  });

  it("link only where something is", () => {
    for (const p of PLATFORMS) {
      const hrefs = [
        p.connect.doc.href,
        ...[...p.can, ...p.stays.points, p.theirs.beside, p.connect.text].flatMap((t) => linksIn(t)),
        ...p.related.map(platformHref),
      ];
      for (const h of hrefs.filter((x) => x.startsWith("/"))) expect(exists(h), `${p.slug}: ${h}`).toBe(true);
    }
    expect([...read(PAGE).matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1] ?? "").every(exists)).toBe(true);
  });

  it("link the topic guides from the pages that share their questions, and ask each question on one page only", () => {
    const by = (slug: string) => PLATFORMS.find((x) => x.slug === slug) as Platform;
    const hrefs = (p: Platform) => [...p.guides.map((g) => g.href), ...linksIn(p.theirs.beside)];
    for (const slug of ["shopify", "square", "woocommerce"])
      expect(hrefs(by(slug)), slug).toContain(topicHref("sell-on-chatgpt"));
    for (const slug of ["shopify", "woocommerce", "square", "stripe", "mollie", "gloriafood", "flipdish"])
      expect(hrefs(by(slug)), slug).toContain(topicHref("agentic-commerce"));
    for (const slug of ["beds24", "hostaway"]) {
      expect(hrefs(by(slug)), slug).toContain(topicHref("ai-hotel-booking"));
      expect(linksIn(by(slug).theirs.beside), slug).toContain(topicHref("ai-hotel-booking"));
    }
    expect(hrefs(by("shopify"))).toContain("/guides/shopify-ai-assistants/");
    // Every question is asked on one page: the platforms', the topic guides', the assistants' and Shopify's.
    const asked = new Map<string, string>();
    const pages: [string, readonly { q: string }[]][] = [
      ...PLATFORMS.map((p): [string, readonly { q: string }[]] => [platformHref(p.slug), p.faqs]),
      ...TOPICS.map((t): [string, readonly { q: string }[]] => [topicHref(t.slug), t.faqs]),
      ...ASSISTANTS.map((a): [string, readonly { q: string }[]] => [`/assistants/${a.slug}/`, a.owner.faqs]),
      ["/guides/shopify-ai-assistants/", SHOPIFY_FAQS],
    ];
    for (const [page, faqs] of pages) {
      for (const f of faqs) {
        expect(asked.get(f.q), `"${f.q}" on ${page} and ${asked.get(f.q)}`).toBeUndefined();
        asked.set(f.q, page);
      }
    }
    expect(asked.get("Will Google AI Mode book my rooms?")).toBe(topicHref("ai-hotel-booking"));
    expect(asked.get("Do I stay the merchant of record?")).toBe(topicHref("ai-hotel-booking"));
    expect(asked.get("How do I sell on ChatGPT?")).toBe(topicHref("sell-on-chatgpt"));
    expect(ASSISTANTS.find((a) => a.slug === "chatgpt")?.guides?.map((g) => g.href)).toContain(
      topicHref("sell-on-chatgpt"),
    );
  });

  it("are plain: no hype, no claim of being first or best, no other company's word for us", () => {
    for (const p of PLATFORMS) {
      const text = words(p).replace(/https?:\/\/[^\s)]+/g, " ");
      expect(text, p.slug).not.toMatch(/\b(the first|the only|best|verified|certified|guaranteed?)\b/i);
      expect(text, p.slug).not.toMatch(
        /\b(seamless(ly)?|effortless(ly)?|revolutionary|game.?chang\w*|supercharge\w*|cutting.?edge|world.?class|unlock\w*|leading|partner(ed|ship))\b/i,
      );
    }
  });
});
