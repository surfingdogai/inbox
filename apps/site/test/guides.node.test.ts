import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import scoreRulesV2 from "../../../packages/spec/vocab/score-rules-v2.json";
import {
  CHECK_HREF,
  GUIDE_ANCHORS,
  GUIDE_SLUGS,
  GUIDES,
  type Guide,
  HUB,
  INBOX_WAY,
  LEVELS,
  PLATFORM_PAGES,
  SCORE_GRADES,
  SCORE_GROUPS,
  wordCount,
} from "../src/lib/guides";
import { HOSTED_LINE } from "../src/lib/hosted";
import { LOCAL_GUIDES, PAGES } from "../src/lib/i18n";

/**
 * The guides at /guides/: every address the network's result pages link to answers, each guide ends
 * with a way to check the change worked, the words fit a search result and stay plain, they are
 * written for any business anywhere, and our own inbox is one labelled option in three guides and
 * nowhere else. Checked without a build, from the sources the build reads.
 */
const site = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(site(path), "utf8");
const body = (slug: string) => read(`src/content/guides/${slug}.md`);

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
/** Everything a guide says: its words in guides.ts and its Markdown. */
const said = (g: Guide) =>
  [
    g.title,
    g.short,
    g.description,
    g.answer,
    ...g.options.flatMap((o) => [o.way, o.what, ...(o.links ?? []).map((l) => l.label)]),
    ...g.examples.map((e) => e.label),
    body(g.slug),
  ].join("\n");

/** The ids a guide's page has: those its Markdown writes out, and those its headings are given. */
const idsOf = (md: string) => [
  ...[...md.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1] ?? ""),
  ...[...md.matchAll(/^#{2,3} (.+)$/gm)].map((m) =>
    (m[1] ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, "")
      .replace(/ /g, "-"),
  ),
];

/** The slugs the network's spec gives its result pages (vocab/guide.json): a contract, never renamed. */
const CONTRACT = [
  "ai-assistant-bookings",
  "sell-through-ai-assistants",
  "ai-assistant-messages-and-quotes",
  "ai-assistant-payments",
  "business-details-for-ai",
  "findable-agent-doors",
  "llms-txt",
  "robots-txt-ai-agents",
];

describe("the guides", () => {
  it("answer at every address the result pages link to, and at the anchors they name", () => {
    expect([...GUIDE_SLUGS]).toEqual(CONTRACT);
    expect(GUIDES.map((g) => g.slug)).toEqual(CONTRACT);
    const files = readdirSync(site("src/content/guides")).filter((f) => f.endsWith(".md"));
    expect(files.sort()).toEqual(CONTRACT.map((s) => `${s}.md`).sort());
    expect(existsSync(site("src/pages/guides/index.astro"))).toBe(true);
    expect(existsSync(site("src/pages/guides/[slug].astro"))).toBe(true);
    // The anchors: #memberships, #after, #quotes and #kind in the guides, #score on the hub.
    for (const [slug, ids] of Object.entries(GUIDE_ANCHORS)) {
      const text = slug ? body(slug) : read("src/pages/guides/index.astro");
      for (const id of ids) expect(text, `${slug || "/guides/"}#${id}`).toContain(`id="${id}"`);
    }
    expect(GUIDE_ANCHORS["sell-through-ai-assistants"]).toContain("after");
    expect(GUIDE_ANCHORS["ai-assistant-bookings"]).toContain("memberships");
    expect(GUIDE_ANCHORS["ai-assistant-messages-and-quotes"]).toContain("quotes");
    expect(GUIDE_ANCHORS["business-details-for-ai"]).toContain("kind");
    expect(GUIDE_ANCHORS[""]).toContain("score");
  });

  it("each says what an assistant needs and what the check counts, then ends with Check it worked, posting to the checker", () => {
    for (const slug of CONTRACT) {
      expect(body(slug), slug).toMatch(/^## What an assistant needs$/m);
      expect(body(slug), slug).toMatch(/^## What counts in the check$/m);
    }
    expect(CHECK_HREF).toBe("/check");
    const check = read("src/components/GuideCheck.astro");
    expect(check).toContain('title = "Check it worked"');
    expect(check).toMatch(/<form class="g-form" method="post" action=\{CHECK_HREF\}>/);
    expect(check).toContain('name="url"');
    expect(check).toMatch(/<a class="link" href=\{CHECK_HREF\}>free AI agent readiness checker<\/a>/);
    const page = read("src/pages/guides/[slug].astro");
    expect(page).toContain("<GuideCheck examples={guide.examples} />");
    expect(page).toContain("<GuideOptions options={guide.options} />");
    expect(page).toContain("<GuideAnswer text={guide.answer} />");
    expect(page).toContain('"@type": "Article"');
    expect(page).toContain('"@type": "BreadcrumbList"');
    expect(read("src/pages/guides/index.astro")).toContain('"@type": "CollectionPage"');
  });

  it("fit a search result: a description of at most 160 characters, and an answer of at most 50 words", () => {
    for (const g of [...GUIDES, { ...HUB, slug: "", short: "Guides", options: [], examples: HUB.examples }]) {
      expect(g.description.length, `${g.slug}: ${g.description}`).toBeLessThanOrEqual(160);
      expect(g.description.length, g.slug).toBeGreaterThan(80);
      expect(wordCount(g.answer), `${g.slug}: ${g.answer}`).toBeLessThanOrEqual(50);
      expect(g.answer).not.toMatch(/`/);
    }
    expect(new Set(GUIDES.map((g) => g.title)).size).toBe(GUIDES.length);
    expect(new Set(GUIDES.map((g) => g.description)).size).toBe(GUIDES.length);
    expect(wordCount("one two, three: four-five")).toBe(4);
  });

  it("make no claim of being first, alone, verified or certified, and name no other product's score", () => {
    const texts: [string, string][] = [
      ...GUIDES.map((g): [string, string] => [g.slug, said(g)]),
      ["hub", [HUB.title, HUB.description, HUB.answer, ...LEVELS.map((l) => l.says)].join("\n")],
      ...["src/pages/guides/index.astro", "src/pages/guides/[slug].astro"].map((p): [string, string] => [
        p,
        visible(read(p)),
      ]),
      ...["GuideAnswer", "GuideCheck", "GuideList", "GuideOptions"].map((c): [string, string] => [
        c,
        visible(read(`src/components/${c}.astro`)),
      ]),
    ];
    for (const [name, raw] of texts) {
      const text = withoutUrls(raw).replace(/not a certification/g, "");
      expect(text, name).not.toMatch(/\b(first|only|verified|certified|people free|guaranteed?)\b/i);
      expect(text, name).not.toMatch(
        /\b(seamless(ly)?|effortless(ly)?|revolutionary|game.?chang\w*|supercharge\w*|cutting.?edge|world.?class|unlock\w*)\b/i,
      );
      // "AI agent readiness checklist" is a plain description, in lower case; a product's name for a
      // score, "Agent Readiness" in capitals or an "agent readiness score", is never ours to use.
      expect(text, name).not.toMatch(/Agent ?Readiness|AgentReady/);
      expect(text, name).not.toMatch(/agent ?readiness score|AgentReady/i);
    }
  });

  it("are written for any business anywhere: a guide that names a place names places on at least three continents", () => {
    const places: [RegExp, string][] = [
      [/\b(UK|United Kingdom|Britain|British|England)\b/, "Europe"],
      [/\b(EU|Europe|European|EEA|SEPA)\b/, "Europe"],
      [/\b(Portugal|Portuguese|Spain|France|Germany|Italy|Netherlands|Ireland)\b/, "Europe"],
      [/\b(US|USA|United States|American|Canada|Canadian|Mexico)\b/, "North America"],
      [/\b(Brazil|Brazilian|Argentina|Chile|Colombia)\b/, "South America"],
      [/\b(India|Indian|China|Chinese|Japan|Singapore|Indonesia)\b/, "Asia"],
      [/\b(Australia|Australian|New Zealand)\b/, "Oceania"],
      [/\b(Africa|African|Nigeria|Kenya|Egypt)\b/, "Africa"],
    ];
    for (const g of GUIDES) {
      const text = withoutUrls(said(g));
      const continents = new Set(places.filter(([re]) => re.test(text)).map(([, c]) => c));
      expect(continents.size === 0 || continents.size >= 3, `${g.slug}: ${[...continents].join(", ")}`).toBe(true);
    }
    // The payments guide gives regional methods from several continents, not one country's.
    const pay = withoutUrls(said(GUIDES.find((g) => g.slug === "ai-assistant-payments") as Guide));
    expect(new Set(places.filter(([re]) => re.test(pay)).map(([, c]) => c)).size).toBeGreaterThanOrEqual(3);
  });

  it("list our inbox as one labelled option, in the bookings, selling and messages guides, and nowhere else", () => {
    expect(INBOX_WAY).toBe("Surfing Dog Inbox (ours, open source)");
    const withInbox = GUIDES.filter((g) =>
      g.options.some((o) => /Surfing Dog Inbox|\binbox\b/i.test(`${o.way} ${o.what}`)),
    );
    expect(withInbox.map((g) => g.slug)).toEqual([
      "ai-assistant-bookings",
      "sell-through-ai-assistants",
      "ai-assistant-messages-and-quotes",
    ]);
    for (const g of withInbox) {
      const rows = g.options.filter((o) => o.ours);
      expect(rows, g.slug).toHaveLength(1);
      expect(rows[0]?.way, g.slug).toBe(INBOX_WAY);
      expect(rows[0]?.what, g.slug).toMatch(/MIT/);
      expect(rows[0]?.what, g.slug).toMatch(/about \$5 a month/);
      // Hosting, as the pilot's switch says it (src/lib/hosted.ts): "no hosted version yet" while closed.
      expect(rows[0]?.what, g.slug).toContain(HOSTED_LINE);
      // It is a row of the table, never a row on its own: other ways sit beside it.
      expect(g.options.length, g.slug).toBeGreaterThanOrEqual(3);
    }
    // The prose of every guide, and the hub, never sells it.
    for (const slug of CONTRACT) expect(body(slug), slug).not.toMatch(/Surfing Dog Inbox/);
    expect(visible(read("src/pages/guides/index.astro"))).not.toMatch(/Surfing Dog Inbox/);
    for (const g of GUIDES) {
      if (!withInbox.includes(g))
        expect(
          g.options.some((o) => o.ours),
          g.slug,
        ).toBe(false);
    }
  });

  it("link to pages that exist here, to the checker and the leaderboards with filters the network knows", () => {
    const proxied = [/^\/check$/, /^\/leaderboard$/, /^\/v1\//, /^\/bot$/, /^\/network\//];
    const exists = (href: string) => {
      const [path = "", anchor] = href.split("#");
      const p = path.replace(/\?.*$/, "");
      if (proxied.some((r) => r.test(p))) return true;
      const guide = p.match(/^\/guides\/([a-z0-9-]+)\/$/)?.[1];
      if (guide && PLATFORM_PAGES.some((pp) => pp.slug === guide)) {
        return !anchor && existsSync(site(`src/pages/guides/${guide}.astro`));
      }
      // The guides that go with the free tools, in English: pages of their own (src/lib/i18n.ts).
      if (guide && LOCAL_GUIDES.some((g) => PAGES[g].en === p)) {
        return !anchor && existsSync(site(`src/pages/guides/${guide}.astro`));
      }
      if (guide) {
        if (!(CONTRACT as string[]).includes(guide)) return false;
        return !anchor || idsOf(body(guide)).includes(anchor);
      }
      if (p === "/guides/") return true;
      const bare = p.replace(/\/+$/, "");
      return existsSync(site(`src/pages${bare}.astro`)) || existsSync(site(`src/pages${bare}/index.astro`));
    };
    const hrefs = [
      ...GUIDES.flatMap((g) => [...body(g.slug).matchAll(/\]\((\/[^)\s]*)\)/g)].map((m) => m[1] ?? "")),
      ...GUIDES.flatMap((g) => g.options.flatMap((o) => (o.links ?? []).map((l) => l.href))).filter((h) =>
        h.startsWith("/"),
      ),
      ...[...read("src/pages/guides/index.astro").matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1] ?? ""),
    ];
    expect(hrefs.length).toBeGreaterThan(10);
    for (const h of hrefs) expect(exists(h), h).toBe(true);
    // A link to an anchor in another guide names one that is written out.
    for (const g of GUIDES) {
      for (const m of body(g.slug).matchAll(/\]\(\/guides\/([a-z0-9-]+)\/#([a-z-]+)\)/g)) {
        expect(idsOf(body(m[1] ?? "")), `${g.slug} → ${m[1]}#${m[2]}`).toContain(m[2]);
      }
    }
    // The leaderboards' filters, as the network accepts them.
    const can = [
      "message",
      "book",
      "order",
      "signup",
      "cancel",
      "change",
      "negotiate",
      "catalogue",
      "availability",
      "pay",
      "track",
      "return",
    ];
    for (const e of [...GUIDES.flatMap((g) => g.examples), ...HUB.examples]) {
      const q = new URL(e.href, "https://surfingdog.ai").searchParams;
      expect(q.get("can") === null ? q.get("ready") === "1" : can.includes(q.get("can") ?? ""), e.href).toBe(true);
    }
  });

  it("the hub's score summary is the published rules: group weights, what each holds, the grades and the credit", () => {
    const rules = scoreRulesV2 as {
      groups: { id: string; weight: number; members: string[] }[];
      grades: { grade: string; min: number }[];
      credit: Record<string, number>;
    };
    const weighed = rules.groups.filter((g) => g.weight > 0);
    expect(SCORE_GROUPS.map((g) => [g.id, g.weight]).sort()).toEqual(weighed.map((g) => [g.id, g.weight]).sort());
    expect(SCORE_GRADES).toEqual(rules.grades);
    expect(rules.credit).toMatchObject({ yes: 1, partial: 0.5, no: 0 });
    // Each group's words name each of its members.
    const words: Record<string, RegExp> = {
      message: /Message/,
      book: /book/,
      order: /order/,
      signup: /sign up/,
      pay: /pay/,
      change: /Change/,
      cancel: /cancel/,
      return: /return/,
      subscription: /membership/,
      receipt: /receipt/,
      availability: /Free times or stock/,
      track: /tracking/,
      catalogue: /Catalogue/,
      policies: /policies/,
      negotiate: /Quotes/,
      find: /Who you are/,
    };
    for (const g of weighed) {
      const holds = SCORE_GROUPS.find((s) => s.id === g.id)?.holds ?? "";
      for (const m of g.members) expect(holds, `${g.id}: ${m}`).toMatch(words[m] ?? /^$/);
    }
    expect(LEVELS.map((l) => l.name)).toEqual(["Listed", "Readable", "Askable", "Bookable", "Payable"]);
  });
});
