import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOSTED_LINE, HOSTED_PILOT_OPEN, HOSTED_STATUS, START_URL } from "../src/lib/hosted";
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
    expect(body(`${HOSTED_DIR}/terms.md`)).toContain("stored on our servers in Germany");
    const allowed = new Set([site(`${HOSTED_DIR}/terms.md`)]);
    const files = [...walk(site("src")), ...walk(repo("docs")), ...walk(site("public"))];
    for (const f of files) {
      if (allowed.has(f)) continue;
      expect(/\bgermany\b|deutschland/i.test(readFileSync(f, "utf8")), f).toBe(false);
    }
  });

  it("say on every legal page that a lawyer has not reviewed it, until one has", () => {
    const route = read("src/pages/hosted/[...slug].astro");
    expect(route).toContain("a lawyer has not reviewed it yet");
    expect(route).toContain("isTerms && !page.data.reviewed");
    for (const path of LEGAL) expect(front(path).reviewed, path).toBeUndefined();
    expect(LEGAL.map((p) => p.replace(`${HOSTED_DIR}/`, "")).sort()).toEqual([
      "acceptable-use.md",
      "privacy.md",
      "processing.md",
      "reports.md",
      "terms.md",
    ]);
  });

  it("carry the pilot's promises: free, counted, notice before a charge, one DNS record, download and close", () => {
    const terms = body(`${HOSTED_DIR}/terms.md`);
    for (const promise of [
      "free during the pilot",
      "at least 30 days before any charge",
      "Nothing is charged without your agreement",
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
