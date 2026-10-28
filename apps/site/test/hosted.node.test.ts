import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEPLOY_URL,
  HOSTED_CTA,
  HOSTED_FAQ,
  HOSTED_HERO,
  HOSTED_HOME,
  HOSTED_HOW,
  HOSTED_HOW_DATA,
  HOSTED_INBOX_LD,
  HOSTED_INBOX_POINTS,
  HOSTED_INSTALL,
  HOSTED_LINE,
  HOSTED_LLMS,
  HOSTED_NO_DOOR,
  HOSTED_OWNERSHIP,
  HOSTED_PILOT_OPEN,
  HOSTED_RUN,
  HOSTED_STATUS,
  hostedCta,
  hostedFaq,
  hostedHero,
  hostedHome,
  hostedHow,
  hostedHowData,
  hostedInboxLd,
  hostedInboxPoints,
  hostedInstall,
  hostedLlms,
  hostedNoDoor,
  hostedOwnership,
  hostedRun,
  START_URL,
} from "../src/lib/hosted";
import { hostedDocsData, hostedDrops, hostedMarkdownPlugin, type MdNode } from "../src/lib/hosted-markdown";
import { stateOf } from "../src/lib/status";

/**
 * The hosted pilot's copy, checked without a build: one switch decides whether any of it is
 * public, and everything that depends on the switch agrees with it; the words make no claim the
 * pilot cannot keep; the inbox and its backups are stored in the European Union, and what the edge
 * carries and keeps elsewhere is said; the servers' country is said on the hosted terms and nowhere
 * else; and the DNS guide covers every provider the Connect screen knows.
 */
const site = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(site(path), "utf8");

const HOSTED_DIR = "src/content/hosted";
const HOSTED = readdirSync(site(HOSTED_DIR))
  .filter((f) => f.endsWith(".md"))
  .map((f) => `${HOSTED_DIR}/${f}`);
const DOCS_PAGE = "src/content/docs/docs/get-your-agent-inbox.md";
const LEGAL = HOSTED.filter((p) => !p.endsWith("/index.md"));

/** A page as a reader sees it: no frontmatter, no HTML comments. */
function body(path: string): string {
  return read(path)
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

/** The frontmatter's `key: value` lines. */
function front(path: string): Record<string, string> {
  const m = read(path).match(/^---\n([\s\S]*?)\n---\n/);
  const out: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Every text file under a directory, recursively, skipping build output and dependencies. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(md|mdx|astro|ts|tsx|mjs|json|txt|html|css)$/.test(name)) out.push(full);
  }
  return out;
}

describe("the hosted pilot's switch", () => {
  it("is one constant, and the docs page, the sidebar, the status list and the guides agree with it", () => {
    expect(/^draft: true$/m.test(read(DOCS_PAGE)), "the docs page is a draft exactly while the pilot is closed").toBe(
      !HOSTED_PILOT_OPEN,
    );
    expect(read("astro.config.mjs").includes('"docs/get-your-agent-inbox"'), "and in the sidebar while open").toBe(
      HOSTED_PILOT_OPEN,
    );
    expect(stateOf("hosted")).toBe(HOSTED_STATUS.state);
    expect(HOSTED_STATUS.state).toBe(HOSTED_PILOT_OPEN ? "live" : "coming");
    if (!HOSTED_PILOT_OPEN) {
      expect(HOSTED_LINE).toBe("There's no hosted version yet.");
      expect(HOSTED_STATUS.label).toBe("A hosted inbox");
    }
    expect(START_URL).toBe("https://app.surfingdog.ai/start");
  });

  it("opens only while the hosted terms say the inbox and its backups are stored in the European Union", () => {
    // The open words say so (the /inbox hero, how it works, the quickstart), so the terms must too.
    // That the backups are really there (eu-storage deployed) is on the flip's list in hosted.ts.
    expect(read("src/lib/hosted.ts")).toContain("eu-storage is deployed");
    if (HOSTED_PILOT_OPEN) {
      expect(body(`${HOSTED_DIR}/terms.md`)).toContain(
        "Your inbox and its backups are stored in the European Union and nowhere else.",
      );
    }
  });

  it("generates no hosted page while closed, and the waitlist stays until it opens", () => {
    const route = read("src/pages/hosted/[...slug].astro");
    expect(route).toContain("if (!HOSTED_PILOT_OPEN && !import.meta.env.DEV) return [];");
    const run = read("src/components/Run.astro");
    expect(run).toContain("HOSTED_PILOT_OPEN && (");
    expect(run).toContain("!HOSTED_PILOT_OPEN && (");
    expect(run).toContain("Join the waitlist");
  });
});

describe("the hosted pilot's words", () => {
  const COPY = [...HOSTED, DOCS_PAGE];

  it("make no claim of being first or alone, and nothing the pilot does not do", () => {
    for (const path of COPY) {
      // "DNS only" is the name of a setting in one provider's panel, quoted as it shows it.
      const text = body(path)
        .replace(/DNS only/g, "")
        .replace(/read-only/g, "");
      expect(text, path).not.toMatch(/\b(first|only)\b/i);
      expect(text, path).not.toMatch(/passkey|two minutes|litestream|\blinked\b|agents can find you/i);
      expect(text, path).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    }
  });

  it("describe the edge and the email by their role, never by a company's name", () => {
    // Only the DNS guide names companies, and those are the business's own DNS providers.
    for (const path of HOSTED) expect(body(path), path).not.toMatch(/cloudflare/i);
  });

  // The words themselves are private (our host, its places, the people), so they come from the
  // environment of whoever runs the check, as in site.node.test.ts.
  const privateWords = (process.env.SITE_PRIVATE_WORDS ?? "")
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  it.skipIf(privateWords.length === 0)("name no person, host or place of ours (SITE_PRIVATE_WORDS)", () => {
    const amendment = readFileSync(repo("docs/adr/003-hosted-tenancy.md"), "utf8").split("## Amendment 1")[1] ?? "";
    const texts: [string, string][] = [
      ...[...COPY, "src/lib/hosted.ts"].map((p): [string, string] => [p, read(p)]),
      ["ADR-003, Amendment 1", amendment],
    ];
    for (const [path, text] of texts) {
      const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/));
      for (const w of privateWords) expect(words.has(w), `${path}: a private word`).toBe(false);
    }
  });

  it("say the inbox and its backups are stored in the European Union, and what the edge keeps and carries elsewhere", () => {
    const terms = body(`${HOSTED_DIR}/terms.md`);
    expect(terms).toContain("its backups are stored in the European Union");
    expect(terms).toContain("Your inbox and its backups are stored in the European Union and nowhere else.");
    expect(terms).toContain("which can be outside the European Union");
    expect(terms).toContain("it also keeps its own records of requests (addresses, times and the pages asked for)");
    expect(terms).toContain(
      "It keeps a record of each email (sender, recipient, subject and whether it arrived) for about a month",
    );
    const processing = body(`${HOSTED_DIR}/processing.md`);
    expect(processing).toContain("Your inbox and its backups are stored in the European Union and nowhere else");
    expect(processing).toContain("It also stores our encrypted backups; those are in the European Union.");
    expect(processing).toContain("Apart from what you send elsewhere yourself");
    expect(processing).toContain("what can pass outside the European Union is what travels through our edge network");
    expect(processing).toContain(
      "The edge network also keeps its own records, which can be kept outside the European Union",
    );
    expect(processing).toContain("Do not send us your customers' personal data by email");
    const privacy = body(`${HOSTED_DIR}/privacy.md`);
    expect(privacy).toContain("our backups of it are stored in the European Union");
    expect(privacy).toContain("It can do this from its locations outside the European Union.");
    expect(privacy).toContain("It also keeps its own records, which can be kept outside the European Union");
    expect(privacy).toContain("a language-model company may read a short digest of its public pages");
    expect(privacy).toContain("public certificate logs");
    expect(privacy).toContain("which may store it outside the European Union");
    for (const path of COPY) {
      // Not everything stays in the EU at rest: the edge keeps records and the email's delivery log.
      expect(body(path), path).not.toMatch(/at rest, it stays|stays there at rest/i);
      // Only the hosted backups are encrypted; the owner's data is also in backups that are not.
      expect(body(path), path).not.toMatch(/encrypted backups of it/i);
      // Where a provider keeps things is said as "the European Union", never in the provider's own
      // words; those words are private (they would name the provider), so they are checked through
      // SITE_PRIVATE_WORDS below, and only the neutral ones here.
      expect(body(path), path).not.toMatch(/data.?cent(er|re)/i);
    }
  });

  it("state the servers' country on the hosted terms, and nowhere else", () => {
    expect(body(`${HOSTED_DIR}/terms.md`)).toContain("stored in the European Union and nowhere else");
    const allowed = new Set([site(`${HOSTED_DIR}/terms.md`)]);
    const files = [...walk(site("src")), ...walk(repo("docs")), ...walk(site("public"))];
    for (const f of files) {
      if (allowed.has(f)) continue;
      expect(/\bgermany\b|deutschland/i.test(readFileSync(f, "utf8")), f).toBe(false);
    }
  });

  it("name the company and its number on every legal page, with no postal address and no review note", () => {
    const pages = [
      read("src/pages/hosted/[...slug].astro"),
      read("src/pages/terms.astro"),
      read("src/pages/privacy.astro"),
    ];
    for (const page of pages) {
      expect(page).toContain("{COMPANY_LINE}");
      expect(page).not.toMatch(/lawyer/i);
    }
    const company = read("src/lib/company.ts");
    expect(company).toContain('name: "Surfing Dog, Lda"');
    expect(company).toContain('nipc: "517113325"');
    expect(company).not.toMatch(/\brua\b|\bavenida\b|\b\d{4}-\d{3}\b/i);
    for (const path of LEGAL) expect(front(path).reviewed, path).toBeUndefined();
    expect(LEGAL.map((p) => p.replace(`${HOSTED_DIR}/`, "")).sort()).toEqual([
      "acceptable-use.md",
      "privacy.md",
      "processing.md",
      "reports.md",
      "terms.md",
    ]);
  });

  it("carry the promises: Free with no end date, Pro by choice, notice before a price change, one DNS record, download and close", () => {
    const terms = body(`${HOSTED_DIR}/terms.md`).replace(/\s+/g, " ");
    for (const promise of [
      "Free costs nothing, with no end date",
      "$10, €10 or £9 a month, taxes included",
      "Nothing is charged without your agreement",
      "Pro runs to the end of the month you paid for",
      "Closing your inbox stops Pro from renewing",
      "at least 30 days before any change to Pro's price",
      "one DNS record (a CNAME)",
      "at least 15 days before",
      "at most one hour earlier",
      "30 more days",
      "72 hours",
      "We charge nothing for downloading or switching",
    ]) {
      expect(terms.toLowerCase(), promise).toContain(promise.toLowerCase());
    }
  });

  it("link to pages that exist, or that the switch brings with it", () => {
    const hostedPages = new Set(
      HOSTED.map((p) =>
        p.endsWith("/index.md") ? "/hosted/" : `/hosted/${p.split("/").pop()?.replace(/\.md$/, "")}/`,
      ),
    );
    const docs = new Set(readdirSync(site("src/content/docs/docs")).map((f) => `/docs/${f.replace(/\.md$/, "")}/`));
    const pages = new Set(readdirSync(site("src/pages")).map((f) => `/${f.replace(/\.astro$/, "")}/`));
    for (const path of COPY) {
      for (const [, href] of body(path).matchAll(/\]\((\/[^)\s#]*)/g)) {
        if (!href) continue;
        const ok = hostedPages.has(href) || docs.has(href) || pages.has(href) || href === "/check";
        expect(ok, `${path} links to ${href}`).toBe(true);
      }
    }
  });
});

describe("the DNS guide", () => {
  const guide = body(DOCS_PAGE);

  it("has steps for every provider the Connect screen names, and a way for anyone else", () => {
    for (const provider of [
      "Cloudflare",
      "GoDaddy",
      "Namecheap",
      "Squarespace Domains",
      "Wix",
      "IONOS",
      "Google Cloud DNS",
      "Shopify",
      "Any other provider",
    ]) {
      expect(guide, provider).toContain(`### ${provider}\n`);
    }
    expect(guide).toContain("**Proxy status: DNS only**");
    expect(guide).toContain("with a final dot");
    expect(guide).toContain("Host, Host name, Alias or Record name");
    expect(guide).toContain("Value, Points to, Data, Canonical name or Destination");
  });

  it("shows the record, the email for a web person, and every status and problem line", () => {
    expect(guide).toContain("| CNAME | `inbox` | `k7m2qxpa.hosted.surfingdog.ai` | leave as it is |");
    expect(guide).toContain("**unique to your inbox**");
    expect(guide).toContain("Subject: One DNS record for yourbusiness.com");
    expect(guide).toContain(
      "It connects our agent inbox at inbox.yourbusiness.com. Nothing else on the website changes.",
    );
    for (const line of [
      "Waiting for the record.",
      "Record found. Connecting inbox.yourbusiness.com…",
      "Issuing the certificate for inbox.yourbusiness.com.",
      "Testing as an agent…",
      "inbox.yourbusiness.com is live.",
      "The record is proxied by Cloudflare.",
      "Still no record after two days.",
      "a CAA record",
      "We can't connect this name.",
    ]) {
      expect(guide, line).toContain(line);
    }
  });

  it("never asks for an email or a phone number in a link, and names no real business", () => {
    expect(guide).not.toMatch(/\?[^)\s]*email=/i);
    expect(guide).toMatch(/yourbusiness\.com/);
    expect(guide).not.toMatch(
      /https?:\/\/(?!app\.surfingdog\.ai|inbox\.yourbusiness\.com|surfingdog\.ai)[a-z0-9.-]+\.[a-z]{2,}/i,
    );
  });
});

/**
 * Once the pilot is open, every place that tells a business how to get the inbox offers the hosted
 * inbox first and running it yourself second; while it is closed, each says what it says today.
 * Each place's words come from a function of the switch, so both states are read here, whichever
 * one the site is built with.
 */
describe("hosted first, once the pilot is open", () => {
  const BOTH = [true, false] as const;

  it("builds the site with the words for the state the switch is in", () => {
    expect(HOSTED_HERO).toEqual(hostedHero(HOSTED_PILOT_OPEN));
    expect(HOSTED_RUN).toEqual(hostedRun(HOSTED_PILOT_OPEN));
    expect(HOSTED_HOME).toEqual(hostedHome(HOSTED_PILOT_OPEN));
    expect(HOSTED_INSTALL).toEqual(hostedInstall(HOSTED_PILOT_OPEN));
    expect(HOSTED_FAQ).toBe(hostedFaq(HOSTED_PILOT_OPEN));
    expect(HOSTED_NO_DOOR).toEqual(hostedNoDoor(HOSTED_PILOT_OPEN));
    expect(HOSTED_HOW).toBe(hostedHow(HOSTED_PILOT_OPEN));
    expect(HOSTED_LLMS).toEqual(hostedLlms(HOSTED_PILOT_OPEN));
    expect(HOSTED_INBOX_POINTS).toEqual(hostedInboxPoints(HOSTED_PILOT_OPEN));
    expect(HOSTED_OWNERSHIP).toEqual(hostedOwnership(HOSTED_PILOT_OPEN));
    expect(HOSTED_INBOX_LD).toBe(hostedInboxLd(HOSTED_PILOT_OPEN));
    expect(HOSTED_HOW_DATA).toEqual(hostedHowData(HOSTED_PILOT_OPEN));
  });

  it("/hosted/, /try/ and /inbox/assistants/: the hosted inbox's start is their primary button while open", () => {
    expect(HOSTED_CTA).toEqual(hostedCta(HOSTED_PILOT_OPEN));
    expect(hostedCta(true)).toEqual({ label: "Get your agent inbox", href: START_URL });
    expect(hostedCta(false)).toBeNull();
    for (const page of [
      "src/pages/hosted/[...slug].astro",
      "src/pages/try.astro",
      "src/pages/inbox/assistants.astro",
    ]) {
      const src = read(page);
      expect(src, page).toContain("import { HOSTED_CTA");
      expect(src, page).toMatch(/<a class="btn btn-primary" href=\{HOSTED_CTA\.href\}>/);
    }
    // While open, /try/ and /inbox/assistants/ step their own buttons back; /assistants/ is a person's page, with none.
    expect(read("src/pages/try.astro")).toContain('HOSTED_CTA ? "btn btn-secondary" : "btn btn-primary"');
    expect(read("src/pages/inbox/assistants.astro")).toContain('HOSTED_CTA ? "btn btn-secondary" : "btn btn-primary"');
    expect(read("src/pages/assistants/index.astro")).not.toContain("HOSTED_CTA");
  });

  it("install.md starts with the hosted inbox, and an AI hands the email and the code to the person", () => {
    const md = read("public/install.md");
    const hosted = md.indexOf("## The short way: we host it");
    expect(hosted).toBeGreaterThan(0);
    expect(hosted).toBeLessThan(md.indexOf("## Or they run it themselves"));
    expect(hosted).toBeLessThan(md.indexOf("## Path A"));
    expect(md).toContain(`${START_URL}?domain=<their domain>`);
    expect(md).toContain("Never type either for\n   them, and never ask them to paste the code to you.");
  });

  it("the /inbox hero: the hosted inbox first while open, Deploy to Cloudflare while closed", () => {
    const open = hostedHero(true);
    expect(open.primary).toEqual({ label: "Get your agent inbox", href: START_URL });
    expect(open.also).toEqual({ label: "Or run it yourself", href: "#run" });
    // The lede says we host it; the fine line carries only the terms.
    expect(open.lede).toContain("We host Surfing Dog Inbox for you at your own address, like inbox.yourbusiness.com");
    expect(open.lede).not.toMatch(/you run/);
    expect(open.note).toBe(
      "Free, or Pro at $10, €10 or £9 a month. Your inbox and its backups are stored in the European Union.",
    );
    const closed = hostedHero(false);
    expect(closed.primary).toEqual({ label: "Deploy to Cloudflare", href: DEPLOY_URL, rel: "noopener" });
    expect(closed.also).toBeNull();
    expect(closed.lede).toBeNull();
    expect(closed.note).toBeNull();
    // The hero draws its lede, buttons and line from them, keeps "Try it with your AI" either way, and
    // keeps two buttons: running it yourself is a quiet one after them.
    const hero = read("src/components/InboxHero.astro");
    expect(hero).toContain("= HOSTED_HERO;");
    expect(hero).toContain('<p class="hero-sub">{lede}</p>');
    expect(hero).toContain("Surfing Dog Inbox is open-source software you run at");
    expect(hero).toContain("href={primary.href} rel={primary.rel}>{primary.label}</a>");
    expect(hero).toContain('<a class="btn btn-ghost btn-lg" href={also.href}>');
    expect(hero).toContain("{note && <p");
    expect(hero).toContain('<a class="btn btn-secondary btn-lg" href="/try/">Try it with your AI</a>');
    expect(hero.indexOf("/try/")).toBeLessThan(hero.indexOf("href={also.href}"));
    expect(hero.match(/btn-lg/g)?.length).toBe(3);
    expect(hero).not.toContain(DEPLOY_URL);
    // "Or run it yourself" lands on the ways to run, where Deploy to Cloudflare still is.
    const run = read("src/components/Run.astro");
    expect(read("src/pages/inbox.astro")).toContain("<Run />");
    expect(run).toContain('id="run"');
    expect(run).toContain("href={DEPLOY_URL}");
  });

  it("the points on /inbox: where it runs and the ways in say the hosted case while open", () => {
    const open = hostedInboxPoints(true);
    expect(open?.yours).toContain("hosted by us or on your own Cloudflare account or server");
    expect(open?.yours).toContain("You can download everything it holds and leave whenever you like.");
    // A hosted inbox takes no email in during the pilot (docs/self-hosted-vs-hosted).
    expect(open?.waysIn).toContain("by email when you run it yourself");
    expect(hostedInboxPoints(false)).toBeNull();
    const inbox = read("src/components/Inbox.astro");
    expect(inbox).toContain("HOSTED_INBOX_POINTS?.yours ??");
    expect(inbox).toContain("HOSTED_INBOX_POINTS?.waysIn ??");
    expect(read("src/content/docs/docs/self-hosted-vs-hosted.md")).toContain("| Email in |");
  });

  it("the ways to run: the hosted card leads while open, and holds the waitlist at the end while closed", () => {
    const run = read("src/components/Run.astro");
    const openCard = run.indexOf("HOSTED_PILOT_OPEN && (");
    const deploy = run.indexOf('<h3 class="h-card">Deploy to Cloudflare</h3>');
    const server = run.indexOf('<h3 class="h-card">Your own server</h3>');
    const closedCard = run.indexOf("!HOSTED_PILOT_OPEN && (");
    expect(openCard).toBeGreaterThan(-1);
    expect(openCard).toBeLessThan(deploy);
    expect(deploy).toBeLessThan(server);
    expect(server).toBeLessThan(closedCard);
    expect(run).toContain('<p class="lede">{HOSTED_RUN.lede}</p>');
    expect(run).toContain("class={HOSTED_RUN.deployClass}");
    expect(hostedRun(true)).toEqual({
      lede: "We host it for you, or you run it on your Cloudflare account or your own server. Joining the network is optional.",
      deployClass: "btn btn-secondary",
    });
    expect(hostedRun(false)).toEqual({ lede: null, deployClass: "btn btn-primary" });
    // Each card's foot holds only its button, so the three line up at the bottom.
    const hostedCard = run.slice(openCard, deploy);
    expect(hostedCard).toContain('<a class="link" href="/hosted/">How it works</a>\n            </p>');
    expect(hostedCard).not.toContain('class="hint"');
    expect(hostedCard).not.toMatch(/check result/);
  });

  it("the home page, /install, the FAQ, /search and how it works: hosted first while open, today's words while closed", () => {
    const home = hostedHome(true);
    expect(home?.title).toBe("Your own inbox");
    expect(home?.lead.text).toBe("We host it for you at inbox.yourbusiness.com, free.");
    expect(home?.lead.link.href).toBe(START_URL);
    expect(read("src/components/CopyBlock.astro")).toContain(
      '<a class="btn btn-secondary btn-sm" href={lead.link.href}>',
    );
    expect(home?.what).toMatch(/^Or give this to your AI/);
    expect(hostedHome(false)).toBeNull();
    expect(read("src/pages/index.astro")).toContain('title: "Install your own inbox",');

    const install = hostedInstall(true);
    expect(install?.title).toBe("Your own inbox");
    expect(install?.lede).toBe("We host it for you at inbox.yourbusiness.com, free.");
    expect(install?.cta.href).toBe(START_URL);
    expect(install?.promptEyebrow).toBe("Or let your AI set it up");
    expect(hostedInstall(false)).toBeNull();
    const installPage = read("src/pages/install.astro");
    expect(installPage).toContain('{HOSTED_INSTALL?.title ?? "Let your AI do it"}');
    expect(installPage).toContain('{HOSTED_INSTALL?.promptEyebrow ?? "Step one, and often the only step"}');
    expect(installPage).toContain('id="prompt-h"');

    expect(hostedFaq(true)).toMatch(/^where we host it for you for free, or you run it/);
    expect(hostedFaq(false)).toBe(
      "on your Cloudflare account or your own server (a hosted option, where we run it for you, is coming)",
    );
    expect(read("src/pages/faq.astro")).toContain("HOSTED_FAQ +");

    const door = hostedNoDoor(true);
    expect(door.pills).toEqual([{ id: "hosted", text: "Live" }]);
    expect(door.card?.cta.href).toBe(START_URL);
    // Setting it up yourself is a link in the card's words, to the line for your AI.
    expect(door.card?.link).toEqual({ label: "your AI sets it up", href: "/install/#prompt-h" });
    expect(`${door.card?.before} ${door.card?.link.label} ${door.card?.after}`).toBe(
      "Get the inbox at your own address, and agents write to you there. We host it for free, or your AI sets it up from one line.",
    );
    expect(read("src/components/ForBusinesses.astro")).toContain("{pills[1] && <StatusPill");
    expect(door.price).toBe("Hosted inbox: free, Pro $10, €10 or £9 a month · Self-host: free");
    const shut = hostedNoDoor(false);
    expect(shut.pills).toEqual([
      { id: "inbox", text: "Live: self-host" },
      { id: "hosted", text: "Coming: hosted" },
    ]);
    expect(shut.card).toBeNull();
    expect(shut.price).toBe("Inbox: free to self-host · Hosted: coming");
    // Each pill's word matches the state it shows.
    for (const open of BOTH) {
      for (const p of hostedNoDoor(open).pills) {
        const state = p.id === "hosted" ? (open ? "live" : "coming") : "live";
        expect(p.text.startsWith(state === "live" ? "Live" : "Coming"), p.text).toBe(true);
      }
    }

    expect(hostedHow(true)).toMatch(/^We host it for you at your own address, for free\./);
    expect(hostedHow(false)).toContain("We will also host it for you once that opens.");
    expect(read("src/pages/how-it-works.astro")).toContain("text: HOSTED_HOW,");
    const data = hostedHowData(true);
    expect(data?.data.title).toBe("Your data stays yours");
    expect(data?.data.text).toMatch(/^Hosted by us, it and its backups are kept in the European Union/);
    expect(data?.data.text).toContain("Run yourself, it lives on your Cloudflare account or your own server.");
    expect(data?.customers).not.toMatch(/database/);
    expect(hostedHowData(false)).toBeNull();
    const how = read("src/pages/how-it-works.astro");
    expect(how).toContain('HOSTED_HOW_DATA?.data.title ?? "Your data stays with you"');
    expect(how).toContain("HOSTED_HOW_DATA?.customers ??");
  });

  it("the structured data on / and /inbox: hosted or run yourself while open, today's words while closed", () => {
    expect(hostedInboxLd(true)).toMatch(
      /^An open-source inbox at a business's own address, hosted by Surfing Dog or run/,
    );
    expect(hostedInboxLd(true)).not.toContain("not in the middle");
    expect(hostedInboxLd(false)).toMatch(/^An open-source inbox a business runs itself/);
    expect(hostedInboxLd(false)).toMatch(/Surfing Dog is not in the middle\.$/);
    for (const page of ["src/pages/index.astro", "src/pages/inbox.astro"]) {
      expect(read(page), page).toContain("description: HOSTED_INBOX_LD,");
    }
  });

  it("never say Surfing Dog is out of the middle of an inbox it hosts", () => {
    // Out of the middle is true only of an inbox the business runs itself: a hosted one runs on our
    // servers. So in the open words every sentence that says it names running it yourself.
    const open = JSON.stringify([
      hostedHero(true),
      hostedInboxPoints(true),
      hostedRun(true),
      hostedHome(true),
      hostedInstall(true),
      hostedFaq(true),
      hostedOwnership(true),
      hostedInboxLd(true),
      hostedNoDoor(true),
      hostedHow(true),
      hostedHowData(true),
      hostedLlms(true),
    ]);
    expect(open).not.toMatch(/does not put (a|the) business on Surfing Dog/);
    // Open, "not in the middle" gives way to the promise of carried requests (ADR-025); keeping
    // nothing anyone writes is still said only of an inbox the business runs itself.
    expect(open).not.toContain("not in the middle");
    const sentences = open.split(/(?<=[.;])\s+/).filter((t) => /never keeps what anyone writes/.test(t));
    expect(sentences.length).toBeGreaterThan(0);
    for (const t of sentences) expect(t, t).toMatch(/runs? it (yourself|itself)/);
    // The pages read these words rather than their own.
    expect(read("src/pages/faq.astro")).toContain("HOSTED_OWNERSHIP.faq +");
    expect(read("src/pages/faq.astro")).not.toContain("not in the middle");
    expect(read("astro.config.mjs")).toContain(`\${HOSTED_OWNERSHIP.llms}`);
    expect(read("astro.config.mjs")).not.toContain("not in the middle");
    expect(hostedOwnership(false).faq).toBe(
      "Surfing Dog is not in the middle of a message, a booking, an order or a payment, and your data is in your own database, so you can leave whenever you like.",
    );
  });

  it("llms.txt: hosted first while open, not open yet while closed", () => {
    expect(hostedLlms(true).where).toMatch(/^hosted by us for free, or on its own/);
    expect(hostedLlms(true).get).toContain(START_URL);
    expect(hostedLlms(false).where).toContain("a hosted option is not open yet");
    expect(hostedLlms(false).open).toBe("Self-host the inbox today; a hosted inbox is not open yet.");
    const config = read("astro.config.mjs");
    for (const key of ["summary", "where", "get", "open"]) expect(config).toContain(`\${HOSTED_LLMS.${key}}`);
    expect(hostedLlms(true).summary).toContain("hosted by us or run by the business itself");
    expect(hostedLlms(false).summary).toMatch(
      /^open-source software a business runs itself.*Surfing Dog is not in the middle$/,
    );
  });

  it("say what is true while open, and nothing the pilot does not promise", () => {
    for (const open of BOTH) {
      const words = JSON.stringify([
        hostedHero(open),
        hostedInboxPoints(open),
        hostedRun(open),
        hostedHome(open),
        hostedInstall(open),
        hostedFaq(open),
        hostedOwnership(open),
        hostedInboxLd(open),
        hostedNoDoor(open),
        hostedHow(open),
        hostedHowData(open),
        hostedLlms(open),
      ]);
      // The promise of carried requests (ADR-025) says "keep only a record": its words, not a claim.
      expect(words.replace(/\bkeep only a record that it was delivered\b/g, "")).not.toMatch(
        /free forever|forever free|\b(first|only)\b|guarantee/i,
      );
      // Hosting is free, with no end date, and said so wherever a price is; Pro is never said while closed.
      expect(words).not.toMatch(/during the pilot|no price is set/);
      if (open) expect(words.match(/\bfree\b/gi)?.length).toBeGreaterThanOrEqual(7);
      else expect(words).not.toMatch(/European Union|app\.surfingdog\.ai|\$10|\bPro\b/);
    }
  });
});

/**
 * The price (the founder's decisions, 26 and 27 Oct 2026): the hosted inbox is Free, with no end
 * date, and Pro is $10, €10 or £9 a month, taxes included, for an owner who wants it: the AI spam
 * filters, nothing else. Said short, the same way wherever a price is, with what the $10 supports in
 * the founder's own words; no "during the pilot" left on a price, nor "no price is set".
 */
const PRO = "$10, €10 or £9 a month, taxes included";
const SUPPORT =
  "The $10 supports the open-source inbox, the open network, and keeping access to AI agents from being locked in a connector store.";

describe("the price: Free, and Pro at $10", () => {
  const flat = (t: string) => t.replace(/\s+/g, " ");

  it("the hosted page says Free, Pro and what the $10 supports", () => {
    const page = flat(body(`${HOSTED_DIR}/index.md`));
    expect(page).toContain(
      "Free: the whole inbox, its connectors, your listing on the network and the catalogue, with basic spam protection. No card, and no end date.",
    );
    expect(page).toContain(
      `Pro, if you want it: ${PRO}, for each inbox. It adds the three AI spam filters, for sales pitches, scams and junk, on from the start.`,
    );
    expect(page).toContain(
      "They put messages aside and never delete them, and ask Claude Haiku, an AI model from Anthropic",
    );
    expect(page).toContain("Cancel at any time; Pro runs to the end of the month you paid for.");
    expect(page).toContain(SUPPORT);
    expect(page).not.toMatch(/during the pilot|30 days before|a price, when there is one/);
    expect(read(`${HOSTED_DIR}/index.md`)).toMatch(/^description: .*Free, or Pro at \$10, €10 or £9 a month\.$/m);
  });

  it("the guide's question, the comparison and the quickstart say the same", () => {
    const guide = flat(body(DOCS_PAGE));
    expect(guide).toContain(
      `**What does it cost?** Nothing. Pro is optional: ${PRO}, for the three AI spam filters ([spam](/docs/spam/)). ${SUPPORT}`,
    );
    expect(guide).toContain(`It is free; Pro is ${PRO}, if you want it ([terms](/hosted/terms/)).`);
    const vs = flat(version(read("src/content/docs/docs/self-hosted-vs-hosted.md"), true));
    expect(vs).toContain(`Pro adds the three AI spam filters ([spam](/docs/spam/)). ${SUPPORT}`);
    expect(vs).not.toContain("no price is set");
  });

  it("the hosted terms and privacy notice say Free and Pro, with no pilot that ends, and who takes Pro's payment", () => {
    const terms = flat(body(`${HOSTED_DIR}/terms.md`));
    expect(terms).not.toMatch(/pilot/i);
    expect(terms).toContain(`Pro is optional, for each inbox: ${PRO}.`);
    expect(terms).toContain("Pro is sold through Link: Stripe is the merchant of record.");
    expect(terms).toContain("you can choose US dollars there and pay $10");
    expect(terms).toContain("Checkout charges €10 if you pay in euros and £9 if you pay in pounds.");
    expect(terms).toContain(
      "If it still can't be paid, Pro ends and your inbox is Free again. Nothing in your inbox is deleted.",
    );
    expect(terms).toContain("We may give an inbox Pro for free until a date");
    expect(terms).toContain("**Ending the service.**");
    expect(terms).toContain("or what you paid for Pro in the 12 months before the claim, if that is more");
    const privacy = flat(body(`${HOSTED_DIR}/privacy.md`));
    expect(privacy).not.toMatch(/pilot|future price/i);
    expect(privacy).toContain("**If you choose Pro**");
    expect(privacy).toContain("Stripe gets your email address and your domain");
    for (const page of ["index.md", "terms.md", "privacy.md", "processing.md", "acceptable-use.md", "reports.md"]) {
      expect(front(`${HOSTED_DIR}/${page}`).eyebrow, page).not.toMatch(/pilot/i);
      expect(flat(read(`${HOSTED_DIR}/${page}`)), page).not.toMatch(/pilot/i);
    }
    expect(privacy).toContain(
      "On Pro, with its AI check on, the spam filters send Anthropic the masked text of new senders' messages they cannot decide by themselves",
    );
    expect(privacy).toContain("whether and when you turned its AI check on or off");
    // A Pro we give: the owner is told, and its AI check waits for them.
    expect(terms).toContain("We tell you by email, and Settings → Spam says until when.");
    expect(terms).toContain(
      "Its filters are on, but its AI check stays off until you turn it on in Settings → Spam: until then nothing goes to Anthropic.",
    );
    // The filters ship with Pro: nothing says they are coming, or that Pro changes nothing.
    expect(terms).not.toMatch(/which are coming|filters \(coming\)|Pro changes nothing/);
    expect(terms).toContain(
      "Until that AI check is switched on for hosted inboxes, the filters look for known phrases, and Settings → Spam says so.",
    );
    expect(terms).toContain(SUPPORT);
    for (const page of ["terms.md", "privacy.md", "processing.md"])
      expect(front(`${HOSTED_DIR}/${page}`).updated, page).toBe("27 October 2026");
    expect(front(`${HOSTED_DIR}/terms.md`).description).not.toMatch(/pilot/i);
  });

  it("the processing agreement names Pro's AI model once, what each check sends, and what its maker keeps", () => {
    const dpa = flat(body(`${HOSTED_DIR}/processing.md`));
    // One entry for Anthropic, one transfer paragraph, and the confidentiality section says it too.
    expect(dpa.match(/\*\*Anthropic/g)).toHaveLength(1);
    expect(dpa.match(/Anthropic is in the United States|to Anthropic \(section 5\) is processed/g)).toHaveLength(1);
    expect(dpa).toContain(
      "On Pro, the spam filters' AI check has Anthropic's AI model read the masked text of a new sender's message that the filters cannot decide by themselves (section 5).",
    );
    expect(dpa).toContain(
      "**Anthropic, for Pro's AI spam filters.** When the filters cannot decide by themselves a message from someone your inbox has not dealt with before, they ask Anthropic's AI model, Claude Haiku, at most 150 times a day and 1,500 times a month for your inbox.",
    );
    expect(dpa).toContain(
      "Each check sends the message's masked text: earlier mail quoted in it cut, at most 2,000 characters, with every email address, phone number, payment address, bank account and card number taken out and each link cut to its domain.",
    );
    expect(dpa).toContain("the sender's domain, never their address");
    expect(dpa).toContain("how many files it has, never the files");
    expect(dpa).toContain(
      "The answer is a verdict from a fixed list, with at most three short passages copied from the message.",
    );
    // Anthropic's own words (privacy.claude.com, articles 7996866 and 7996868, read 27 Oct 2026): no
    // training by default, 30 days, flagged inputs and outputs up to two years, the scores up to seven.
    expect(dpa).toContain("By default, Anthropic does not use what it is sent to train its models.");
    expect(dpa).toContain("It deletes it within 30 days");
    expect(dpa).toContain(
      "it may keep what was sent and answered for up to two years and the checks' scores for up to seven",
    );
    expect(dpa).toContain(
      "On a Pro you pay for, the AI check is on from the start; on a Pro we give you for free, it stays off until you turn it on in Settings → Spam. On Free, nothing is sent to it.",
    );
    expect(dpa).toContain("relies on the standard contractual clauses in Anthropic's data processing addendum");
    expect(dpa).not.toMatch(/zero (data )?retention|pilot/i);
  });

  it("leaves no pilot on a price anywhere a business reads one", () => {
    const files = [
      "src/lib/hosted.ts",
      "src/pages/technical.astro",
      "src/pages/try.astro",
      "public/install.md",
      "src/content/docs/docs/quickstart.md",
      "src/content/docs/docs/self-hosted-vs-hosted.md",
      DOCS_PAGE,
      `${HOSTED_DIR}/index.md`,
    ];
    files.push(
      "src/components/Run.astro",
      "src/pages/terms.astro",
      "src/content/blog/surfing-dog-inbox-is-open.md",
      `${HOSTED_DIR}/terms.md`,
      `${HOSTED_DIR}/privacy.md`,
    );
    for (const path of files)
      expect(flat(read(path)), path).not.toMatch(
        /free during (the|its) pilot|nothing during the pilot|no price is set|a future price|Ending the pilot/i,
      );
    expect(read("src/content/docs/docs/self-hosted-vs-hosted.md")).not.toContain("Hosted by us (pilot");
    // No pilot left where a business reads about joining: the card's pill, and who cannot join yet.
    expect(read("src/components/Run.astro")).not.toContain('<span class="pill">Pilot</span>');
    for (const path of ["public/install.md", DOCS_PAGE])
      expect(flat(read(path)), path).not.toMatch(/during the pilot|cannot join during/);
    // Nor "coming" on Pro's filters, now they ship with it.
    for (const path of [`${HOSTED_DIR}/index.md`, DOCS_PAGE, "src/content/docs/docs/self-hosted-vs-hosted.md"])
      expect(flat(read(path)), path).not.toMatch(/filters \(coming\)|coming soon/);
    expect(readFileSync(repo("README.md"), "utf8")).not.toMatch(/free during the pilot/i);
    expect(read("src/pages/technical.astro")).toContain(
      '"We run it for you, at an address on your own domain. Free, or Pro at $10, €10 or £9 a month."',
    );
  });
});

/** A Markdown page's body as it reads for one state of the switch: the other version and the markers gone. */
function version(source: string, open: boolean): string {
  const keep = open ? "open" : "closed";
  return source
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(
      /<!-- hosted: (open|closed) -->([\s\S]*?)(?=<!-- hosted: (?:open|closed|end) -->)/g,
      (_, part: string, text: string) => (part === keep ? text : ""),
    )
    .replace(/<!-- hosted: end -->/g, "");
}

describe("the docs, in both states", () => {
  const QUICKSTART = read("src/content/docs/docs/quickstart.md");
  const VS = read("src/content/docs/docs/self-hosted-vs-hosted.md");
  const OVERVIEW = read("src/content/docs/docs/index.md");
  const SETUP = read("src/content/docs/docs/setting-up-for-agents.md");

  it("mark every version with an open part or a closed one, and close each", () => {
    for (const source of [QUICKSTART, VS, OVERVIEW, SETUP]) {
      let part: string | null = null;
      for (const [, word] of source.matchAll(/<!-- hosted: ([a-z]+) -->/g)) {
        expect(["open", "closed", "end"]).toContain(word);
        if (word === "end") {
          expect(part).not.toBeNull();
          part = null;
        } else part = word ?? null;
      }
      expect(part).toBeNull();
    }
  });

  it("the quickstart: hosting first while open, the waitlist last while closed", () => {
    const open = version(QUICKSTART, true);
    expect(open.indexOf("## Hosted by us")).toBeLessThan(open.indexOf("## Deploy to Cloudflare"));
    expect(open).toContain(`[Get your agent inbox](${START_URL})`);
    expect(open).toContain("on our own servers, free.");
    expect(open).not.toContain("during the pilot");
    expect(open).toContain("Your inbox and its backups are stored in the European Union.");
    expect(open).not.toMatch(/waitlist|not open yet/);
    const closed = version(QUICKSTART, false);
    expect(closed.indexOf("## Hosted by us")).toBeGreaterThan(closed.indexOf("## Your own server"));
    expect(closed).toContain("Hosting is not open yet.");
    expect(closed).toContain("[waitlist](/inbox/#run)");
    expect(closed).not.toContain(START_URL);
    // The description is frontmatter: the open one sits beside today's and replaces it once open.
    const front = QUICKSTART.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
    const today = front.match(/^description: (.+)$/m)?.[1];
    const opened = front.match(/^hostedOpen:\n {2}description: (.+)$/m)?.[1];
    expect(today).toBe(
      "Deploy to Cloudflare, run on your own server, or join the hosted waitlist. Then make your first calls.",
    );
    expect(opened).toBe(
      "Let us host it, deploy to Cloudflare, or run it on your own server. Then make your first calls.",
    );
    const data = { title: "Quickstart", description: today, hostedOpen: { description: opened ?? "" } };
    expect(hostedDocsData(data, true).description).toBe(opened);
    expect(hostedDocsData(data, false).description).toBe(today);
    expect(read("src/content.config.ts")).toContain(".transform((data) => hostedDocsData(data))");
  });

  it("self-hosted vs hosted and the overview: no 'not open yet' or waitlist while open", () => {
    expect(version(VS, true)).toContain("Hosted is free, with Pro at $10, €10 or £9 a month if you want it.");
    expect(version(VS, true)).toContain("| Free; Pro, if you want it: $10, €10 or £9 a month, taxes included |");
    expect(version(VS, false)).not.toMatch(/\$10|\bPro\b/);
    expect(version(VS, true)).toContain("| Hosted by us |");
    expect(version(VS, false)).toContain("Hosted is not open yet; until it is, self-host.");
    expect(version(VS, false)).toContain("| Hosted by us (not open yet) |");
    expect(version(OVERVIEW, true)).toContain("Still to come: customer records");
    expect(version(OVERVIEW, true)).toContain("let us host it, deploy to Cloudflare, or run it on your own server");
    expect(version(OVERVIEW, false)).toContain("Still to come: hosted tenancy and customer records");
    expect(version(OVERVIEW, false)).toContain("or join the hosted waitlist, then make your first calls.");
    for (const doc of [QUICKSTART, VS, OVERVIEW]) expect(version(doc, true)).not.toMatch(/waitlist|not open yet/);
  });

  it("setting up for agents: out of the middle only when the business runs it itself, while open", () => {
    const closed = version(SETUP, false);
    expect(closed).toContain(
      "at its own subdomain, on its own Cloudflare account or its own server. Customers and their agents write to the business there. Surfing Dog is not in the middle of a message, a booking, an order or a payment. Joining a network",
    );
    const open = version(SETUP, true);
    expect(open).toContain("at its own subdomain, hosted by us or on its own Cloudflare account or server.");
    expect(open).toContain(
      "When the business runs it itself, Surfing Dog never touches the money and never keeps what anyone writes",
    );
    expect(open).not.toContain("not in the middle");
  });
});

describe("the Markdown plugin", () => {
  const html = (value: string): MdNode => ({ type: "html", value });
  const text = (value: string): MdNode => ({ type: "text", value });
  const kept = (tree: MdNode, open: boolean): MdNode => {
    const dropped = new Set<MdNode>();
    hostedDrops(tree, open, (n) => dropped.add(n));
    const walk = (n: MdNode): MdNode =>
      n.children ? { ...n, children: n.children.filter((c) => !dropped.has(c)).map(walk) } : n;
    return walk(tree);
  };
  const words = (n: MdNode): string => n.value ?? (n.children ?? []).map(words).join("");

  it("keeps one version, between blocks and inside a line, and drops every marker", () => {
    const tree: MdNode = {
      type: "root",
      children: [
        { type: "paragraph", children: [text("Before.")] },
        html("<!-- hosted: open -->"),
        { type: "heading", children: [text("Hosted by us")] },
        html("<!-- hosted: end -->"),
        {
          type: "paragraph",
          children: [
            text("Hosted is "),
            html("<!-- hosted: open -->"),
            text("free during the pilot"),
            html("<!-- hosted: closed -->"),
            text("not open yet"),
            html("<!-- hosted: end -->"),
            text("."),
          ],
        },
      ],
    };
    expect(words(kept(tree, true))).toBe("Before.Hosted by usHosted is free during the pilot.");
    expect(words(kept(tree, false))).toBe("Before.Hosted is not open yet.");
    expect(JSON.stringify(kept(tree, false))).not.toContain("hosted:");
  });

  it("stops the build on a part left open, a marker it does not know, or one that shares its block", () => {
    const open = { type: "root", children: [html("<!-- hosted: open -->"), text("x")] };
    expect(() => hostedDrops(open, true, () => {})).toThrow(/without its <!-- hosted: end -->/);
    const unknown = { type: "root", children: [html("<!-- hosted: maybe -->")] };
    expect(() => hostedDrops(unknown, true, () => {})).toThrow(/unknown marker/);
    // A line that starts with a marker and goes on is one block of raw HTML: both versions would show.
    const glued = {
      type: "root",
      children: [html("<!-- hosted: open -->Open.<!-- hosted: closed -->Closed.<!-- hosted: end -->")],
    };
    for (const state of [true, false]) {
      expect(() => hostedDrops(glued, state, () => {})).toThrow(/a marker must stand alone/);
    }
  });

  it("renders every page with markers through the site's own Markdown parser, one version and no marker left", async () => {
    // Sätteri, as Astro's Markdown processor loads it (astro → @astrojs/markdown-satteri → satteri).
    const fromAstro = createRequire(createRequire(import.meta.url).resolve("astro/package.json"));
    const fromProcessor = createRequire(fromAstro.resolve("@astrojs/markdown-satteri"));
    const { markdownToHtml } = (await import(pathToFileURL(fromProcessor.resolve("satteri")).href)) as {
      markdownToHtml: (
        source: string,
        options: { mdastPlugins: unknown[]; features: { gfm: boolean } },
      ) => { html: string };
    };
    const render = (source: string, open: boolean) =>
      markdownToHtml(source.replace(/^---\n[\s\S]*?\n---\n/, ""), {
        mdastPlugins: [hostedMarkdownPlugin(open)],
        features: { gfm: true },
      }).html;

    const marked = walk(site("src/content")).filter(
      (f) => f.endsWith(".md") && readFileSync(f, "utf8").includes("<!-- hosted:"),
    );
    expect(marked.length).toBeGreaterThanOrEqual(4);
    for (const file of marked) {
      const source = readFileSync(file, "utf8");
      for (const open of [true, false]) expect(render(source, open), file).not.toMatch(/<!--\s*hosted:/);
    }
    const quickstart = read("src/content/docs/docs/quickstart.md");
    expect(render(quickstart, true)).toContain(START_URL);
    expect(render(quickstart, false)).not.toContain(START_URL);
    expect(render(quickstart, false)).toContain("Hosting is not open yet.");

    // The shape that used to slip through: the parser makes it one HTML block, and the build stops.
    const glued = "Before.\n\n<!-- hosted: open -->Open.<!-- hosted: closed -->Closed.<!-- hosted: end -->\n";
    for (const open of [true, false]) expect(() => render(glued, open)).toThrow(/a marker must stand alone/);
  });

  it("runs first, and changes its name with the switch so a build after a flip renders every page again", () => {
    expect(hostedMarkdownPlugin(true).name).not.toBe(hostedMarkdownPlugin(false).name);
    const config = read("astro.config.mjs");
    expect(config.indexOf("hostedPilotMarkdown(),")).toBeGreaterThan(-1);
    expect(config.indexOf("hostedPilotMarkdown(),")).toBeLessThan(config.indexOf("starlight({"));
  });
});
