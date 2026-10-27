import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SPAM_FAQS,
  SPAM_FILTERS,
  SPAM_FREE,
  SPAM_GUIDE,
  SPAM_GUIDE_FAQS,
  SPAM_GUIDE_OPTIONS,
  SPAM_LINES,
  SPAM_PAGE,
  SPAM_SOURCES,
} from "../src/lib/spam";
import { DESK, LOOP, PIECES, pose, REST, ROWS, SLOT_Y, SLOTS, TRAY, tap, VIEW } from "../src/lib/spam-flow";

/**
 * The spam filter's pages (ADR-041 §13): /inbox/spam/, the guide on contact form spam and the docs
 * page. They exist and are linked, their words are plain (no claim of rank, nothing of where we run),
 * the screenshots they show are on disk, the drawing holds still for reduced motion and fits its
 * frame, and nothing on them is red. Checked from the sources the build reads; with a build on disk,
 * the sitemap lists all three.
 */
const site = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(site(path), "utf8");

const PAGE = "src/pages/inbox/spam.astro";
const GUIDE = "src/pages/guides/stop-contact-form-spam.astro";
const DOCS = "src/content/docs/docs/spam.md";
const FLOW = "src/components/SpamFlow.astro";

/** What a reader sees of an .astro file: frontmatter, comments, styles and scripts removed. */
function visible(source: string): string {
  return source
    .replace(/^---[\s\S]*?\n---\n/, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

/** Every word the three pages publish: their own text, and the shared words they show. */
const published = [
  visible(read(PAGE)),
  visible(read(GUIDE)),
  read(DOCS).replace(/```[\s\S]*?```/g, " "),
  SPAM_PAGE.title,
  SPAM_PAGE.description,
  SPAM_PAGE.heading,
  SPAM_PAGE.lede,
  ...SPAM_FILTERS.flatMap((f) => [f.title, f.line]),
  ...SPAM_FREE,
  ...Object.values(SPAM_LINES),
  ...SPAM_FAQS.flatMap((f) => [f.q, f.a]),
  SPAM_GUIDE.title,
  SPAM_GUIDE.description,
  SPAM_GUIDE.answer,
  ...SPAM_GUIDE_OPTIONS.flatMap((o) => [o.way, o.what]),
  ...SPAM_GUIDE_FAQS.flatMap((f) => [f.q, f.a]),
].join("\n");

describe("the spam filter's pages", () => {
  it("exist, and are linked from the inbox page, the footer, the guides and the docs", () => {
    for (const path of [PAGE, GUIDE, DOCS]) expect(existsSync(site(path)), path).toBe(true);
    expect(read("src/components/Why.astro")).toContain('href="/inbox/spam/"');
    expect(read("src/components/Footer.astro")).toContain('href: "/inbox/spam/"');
    expect(read("src/pages/guides/index.astro")).toContain('href="/guides/stop-contact-form-spam/"');
    expect(read("src/content/docs/docs/index.md")).toContain("(/docs/spam/)");
    expect(read("astro.config.mjs")).toContain('"docs/spam"');
    expect(read(PAGE)).toContain('href="/docs/spam/"');
    expect(read(PAGE)).toContain(["`/guides/$", "{SPAM_GUIDE.slug}/`"].join(""));
    expect(SPAM_GUIDE.slug).toBe("stop-contact-form-spam");
  });

  it("are in the sitemap: nothing leaves them out, and a build lists all three", () => {
    expect(read("astro.config.mjs")).not.toMatch(/sitemap\(\{[\s\S]*?filter:/);
    const built = site("dist/sitemap-0.xml");
    if (existsSync(built)) {
      const xml = readFileSync(built, "utf8");
      for (const path of ["/inbox/spam/", "/guides/stop-contact-form-spam/", "/docs/spam/"]) {
        expect(xml, path).toContain(`https://surfingdog.ai${path}`);
      }
    }
  });

  it("make no claim of rank, and say nothing of where we run", () => {
    expect(published).not.toMatch(/\b(first|only|best|guaranteed?|leading|unbeatable)\b/i);
    expect(published).not.toMatch(/#1|number one|no\. 1/i);
    // Where it runs is never said: no servers, hosts or data centres in a place.
    expect(published).not.toMatch(/\bservers? (in|at)\b|\bhosted in\b|data cent(er|re)/i);
  });

  it("say what it does as it does it: a flood asked to come back later, nothing to clear, who was not told", () => {
    const docs = read(DOCS);
    // It never refuses for what a request says; a sender starting far more than a person would is asked to retry.
    expect(docs).not.toMatch(/It never refuses, bounces, deletes/);
    expect(docs).toMatch(/never refuses, bounces or deletes a request for what it says/);
    expect(docs).toContain("asked to try again later");
    const miss = SPAM_FAQS.find((f) => f.q === "Will I miss a customer?")?.a ?? "";
    expect(miss).toContain("for what it says");
    expect(miss).toContain("asked to retry later");
    // There is no "clear" to press: what is kept is kept until a time is chosen.
    for (const text of [docs, ...SPAM_FAQS.map((f) => f.a), ...SPAM_GUIDE_FAQS.map((f) => f.a)]) {
      expect(text).not.toMatch(/until (you|I) clear/i);
    }
    // The sender got their acknowledgement: what was not told is the owner, and nothing ran.
    expect(read(PAGE)).not.toMatch(/Nobody was told/);
    expect(docs).not.toMatch(/Nobody is told/);
    // What is put aside is kept as long as the owner chooses; a held booking for the next two days
    // reaches the phone once: neither "anything back" nor "nothing ran" is said.
    expect(docs).toContain("kept for as long as you choose, one tap back");
    expect(docs).toContain("You aren't alerted, except once on your phone for a booking held for the next two days.");
    for (const text of [docs, read(PAGE), ...Object.values(SPAM_LINES)]) {
      expect(text).not.toMatch(/brings anything back|weren't alerted and nothing ran|Nothing is lost/);
    }
    // A release runs the rules and the webhooks; a held sender's acknowledgement went, or never goes.
    expect(docs).not.toMatch(/the rules, the webhooks, the acknowledgement/);
    // What leaves the server: a new sender's mail domain, looked up in DNS with an AI check, never without.
    expect(docs).toMatch(/mail domain is looked up in DNS/);
    expect(docs).toContain("With an AI check, never without one, a new sender's mail domain is looked up in DNS");
    // A bot's form messages go after a week, and the owner may choose a time: nothing says nothing is deleted.
    const ours = SPAM_GUIDE_OPTIONS.find((o) => o.ours)?.what ?? "";
    expect(ours).not.toMatch(/nothing (a person wrote is )?deleted/);
    expect(ours).toContain("kept for as long as you choose");
    // No promise the design breaks: a doubted customer waits, a certain hold sends no acknowledgement.
    expect(`${SPAM_PAGE.heading} ${SPAM_PAGE.description}`).not.toMatch(/Keep every customer|come straight in/);
    const sees = SPAM_FAQS.find((f) => f.q === "What does a customer see?")?.a ?? "";
    expect(sees).not.toMatch(/^The same as without a filter/);
    expect(sees).toContain("unless it looks sent by a bot");
    expect(docs).not.toMatch(/never answers differently|Exactly what they would without a filter/);
    expect(docs).toContain("or nothing when a certain signal held it");
    expect(docs).toContain("a message reads as open, one nobody answered yet");
    // Nothing it does not do: no list of sites is looked up.
    expect(docs).not.toMatch(/listed for scams/);
    // Someone known is never put aside or held, and may still be labelled.
    expect(docs).not.toMatch(/never reads someone you know/);
    expect(read(GUIDE)).not.toMatch(/never filtered again/);
    expect(read(GUIDE)).not.toContain("It never drops a message.");
    expect(read(GUIDE)).toContain("It never drops a customer's message.");
    // A count the tests outgrow is never printed.
    const language = SPAM_FAQS.find((f) => f.q === "Does it work in my language?")?.a ?? "";
    expect(language).toContain("more than 140 customer messages in 29 languages");
  });

  it("answer in a few words, with questions that fit a search result", () => {
    expect(SPAM_PAGE.title.length).toBeLessThanOrEqual(60);
    expect(SPAM_PAGE.description.length).toBeLessThanOrEqual(160);
    expect(SPAM_GUIDE.description.length).toBeLessThanOrEqual(170);
    expect(SPAM_GUIDE.answer.split(/\s+/).length).toBeLessThanOrEqual(50);
    for (const f of [...SPAM_FAQS, ...SPAM_GUIDE_FAQS]) expect(f.a.split(/\s+/).length, f.q).toBeLessThanOrEqual(60);
    expect(SPAM_FAQS.map((f) => f.q)).toEqual([
      "Will I miss a customer?",
      "What does a customer see?",
      "Does it work in my language?",
      "Which AI models can I use?",
      "Can an AI assistant still ask me for a price?",
      "What about my WordPress forms?",
    ]);
  });

  it("list the ways in the guide with what each costs and how it fails, ours labelled, and source what others do", () => {
    expect(SPAM_GUIDE_OPTIONS.map((o) => o.way)).toEqual([
      "A hidden field",
      "A time check",
      "CAPTCHAs and challenges",
      "Cloud spam checkers",
      "Filtering in your inbox (Surfing Dog Inbox, ours)",
      "An AI check",
    ]);
    expect(SPAM_GUIDE_OPTIONS.filter((o) => o.ours).map((o) => o.way)).toEqual([
      "Filtering in your inbox (Surfing Dog Inbox, ours)",
    ]);
    for (const o of SPAM_GUIDE_OPTIONS.filter((x) => !x.ours && x.way !== "A time check")) {
      expect(o.links?.length, o.way).toBeGreaterThan(0);
    }
    for (const s of Object.values(SPAM_SOURCES)) expect(s.href).toMatch(/^https:\/\//);
    expect(read(GUIDE)).toContain("Sources, read {SPAM_CHECKED}");
  });

  it("show screenshots that are on disk", () => {
    const shown = [...read(PAGE).matchAll(/(?:src|night)="(\/shots\/[^"]+)"/g)].map((m) => m[1] ?? "");
    expect(shown.sort()).toEqual([
      "/shots/held-day.png",
      "/shots/phone-held-night.png",
      "/shots/phone-held.png",
      "/shots/spam-day.png",
      "/shots/spam-night.png",
      "/shots/spam-settings-day.png",
    ]);
    for (const path of shown) expect(existsSync(site(`public${path}`)), path).toBe(true);
  });

  it("are never red", () => {
    for (const path of [PAGE, GUIDE, FLOW]) {
      // What draws: comments, which may say "no red", left out.
      const source = read(path)
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/^\s*\/\/.*$/gm, " ");
      expect(source, path).not.toMatch(/--danger|--flamingo|\bred\b|crimson|#e5484d|#f00\b|#ff0000/i);
    }
  });
});

describe("the drawing", () => {
  it("holds still under reduced motion, and pauses where nobody can see it", () => {
    const source = read(FLOW);
    expect(source).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(source).toMatch(/still\.matches \|\| !visible\) \{\s*paint\(REST\)/);
    expect(source).toContain('still.addEventListener("change", run)');
    expect(source).toContain("IntersectionObserver");
    // The server draws the same still frame the script starts from.
    expect(source).toContain("pose(p, REST)");
  });

  it("at rest, has the customers and the one brought back on the desk, and the pitch and the scam in the tray", () => {
    for (const p of PIECES) {
      const at = pose(p, REST);
      if (p.kind === "customer" || p.lift) {
        expect(at.row, p.id).toBe(1);
        expect(at.o, p.id).toBe(0);
        expect(ROWS).toContain(at.rowY);
      } else {
        expect(at.o, p.id).toBe(1);
        expect(SLOTS).toContain(at.x);
        expect(at.y).toBe(SLOT_Y);
        expect(at.y).toBeGreaterThan(TRAY.y);
      }
    }
    expect(tap(REST).o).toBe(0);
  });

  it("keeps every envelope inside its frame, all the way round the loop", () => {
    for (let t = 0; t < LOOP; t += 0.05) {
      for (const p of PIECES) {
        const at = pose(p, t);
        expect(at.x).toBeGreaterThanOrEqual(0);
        expect(at.x).toBeLessThanOrEqual(VIEW.w);
        expect(at.y).toBeGreaterThanOrEqual(0);
        expect(at.y).toBeLessThanOrEqual(VIEW.h);
        expect(at.o).toBeGreaterThanOrEqual(0);
        expect(at.o).toBeLessThanOrEqual(1);
      }
    }
    expect(REST).toBeLessThan(LOOP);
    expect(DESK.y + DESK.h).toBeLessThan(TRAY.y);
  });
});
