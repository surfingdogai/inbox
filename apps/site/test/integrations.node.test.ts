import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { builtInConnectors } from "../../../packages/adapters/src/connectors/index";
import { ASSISTANTS } from "../src/lib/assistants";
import { CASES, caseHref } from "../src/lib/cases";
import { HOSTED_PILOT_OPEN } from "../src/lib/hosted";
import {
  APPLE_NOTICE,
  ASSISTANT_LINKS,
  INTEGRATIONS,
  noticesOf,
  SYSTEMS,
  UNTRIED,
  UNTRIED_LINE,
  untried,
  untriedOne,
  WOO_NOTICE,
} from "../src/lib/integrations";

/**
 * The "Works with" row and the examples on /inbox (src/lib/integrations.ts, src/lib/cases.ts), read
 * against the code and the docs: every name on the row is a connector this release ships, that an
 * owner connects today on a hosted inbox and on their own server, whose doc says so; one line, under the
 * calendars, shops, kitchens, stays and trades alone, says each was built from its platform's
 * documentation and tested against a stand-in, and each one's doc says it of itself; every example runs
 * on one of them and names no system that is switched off; names are text, never a logo; and
 * WooCommerce carries ® and Automattic's notice wherever the site names it. Checked without a build.
 */
const site = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(site(path), "utf8");

/** Every connector as each kind of host offers it with nothing set: no partner apps, no switches. */
const HOSTS = { "own server": builtInConnectors(), hosted: builtInConnectors({ hosted: true }) };
const byKind = (host: keyof typeof HOSTS, kind: string) => HOSTS[host].find((c) => c.kind === kind);

/** A heading's id as Starlight makes it (github-slugger): lower case, punctuation out, spaces to dashes. */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

/** The doc an href names, and the part of it under the heading its anchor names (all of it without one). */
function docAt(href: string): { file: string; text: string; section: string } {
  const [path = "", anchor] = href.split("#");
  const file = `src/content/docs${path.replace(/\/$/, "")}.md`;
  const text = existsSync(site(file)) ? read(file) : "";
  if (!anchor) return { file, text, section: text };
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^#{2,4} /.test(l) && slug(l.replace(/^#+ /, "")) === anchor);
  if (start < 0) return { file, text, section: "" };
  const level = (lines[start]?.match(/^#+/)?.[0] ?? "").length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return { file, text, section: lines.slice(start, end < 0 ? undefined : end).join("\n") };
}

/** What a doc says of something that does not work yet. */
const NOT_LIVE = /\*\*Being built\.\*\*|not in a release yet|\*\*Not switched on yet\.\*\*|\bswitched off until\b/i;

/** The word a doc names a row entry by: "iCloud" for iCloud Calendar, "Outlook" for Microsoft Outlook. */
const word = (name: string) => name.replace(/^Microsoft /, "").split(" ")[0] ?? name;

/**
 * The systems an owner cannot connect today: a connector that is not ready with nothing set on the
 * server, or whose own doc says it is being built or switched off, or that the property systems page
 * lists as switched off.
 */
const OFF = new Set<string>();
for (const host of Object.values(HOSTS)) {
  for (const c of host) {
    const ready = c.ready?.() ?? true;
    const own = docAt(`/docs/connectors/${c.kind.replace(/_/g, "-")}/`).text;
    if (ready !== true || NOT_LIVE.test(own)) OFF.add(c.title);
  }
}
for (const line of read("src/content/docs/docs/property-systems.md").split("\n")) {
  const named = line.match(/^(?:- )?\*\*([^*]+)\*\* \((being built|built, switched off)/)?.[1];
  if (named) OFF.add(named);
}

describe("the Works with row", () => {
  it("knows which systems are off: the ones waiting on a company, a partner app or a server's switch", () => {
    for (const t of ["Smoobu", "Mews", "apaleo", "Cloudbeds", "Toast", "Clover", "Deliverect", "Jobber", "Fergus"]) {
      expect(OFF.has(t), t).toBe(true);
    }
    // In 0.2.0, and their docs say so.
    for (const t of ["Shopify", "Square", "Hostaway", "WooCommerce", "Calendly", "Beds24"])
      expect(OFF.has(t), t).toBe(false);
  });

  it("names only connectors this release ships, ready with nothing set, on a hosted inbox and on one's own server", () => {
    expect(INTEGRATIONS.length).toBeGreaterThan(12);
    expect(new Set(INTEGRATIONS.map((i) => i.id)).size).toBe(INTEGRATIONS.length);
    for (const i of INTEGRATIONS) {
      for (const host of Object.keys(HOSTS) as (keyof typeof HOSTS)[]) {
        const c = byKind(host, i.connector);
        expect(c, `${i.id}: no connector "${i.connector}"`).toBeDefined();
        expect(c?.ready?.() ?? true, `${i.id} on ${host}`).toBe(true);
        expect(OFF.has(c?.title ?? ""), `${i.id}: ${c?.title} is off`).toBe(false);
        if (i.preset) {
          const preset = c?.presets?.find((p) => p.id === i.preset);
          expect(preset, `${i.id}: no preset "${i.preset}"`).toBeDefined();
          expect(preset?.ready?.() ?? true, `${i.id}: preset ${i.preset}`).toBe(true);
          expect(preset?.label, i.id).toBe(word(i.name));
        }
      }
      // A calendar whose own sign-in is not ready everywhere (Google's) is named only through its
      // private link, and says it gives busy times only.
      if (OFF.has(i.name)) {
        expect(i.connector, i.name).toBe("ics");
        expect(i.only, i.name).toBe("busy times");
      }
      expect(Boolean(i.only), i.id).toBe(i.connector === "ics");
    }
    // Shops, stays, food, trades and payments each have their names on the row, grouped by kind.
    const groups = INTEGRATIONS.map((i) => i.group);
    expect([...new Set(groups)]).toEqual(["calendars", "shops", "stays", "food", "trades", "payments"]);
    for (let n = 1; n < groups.length; n++) {
      if (groups[n] !== groups[n - 1]) expect(groups.slice(n + 1), "a kind is together").not.toContain(groups[n - 1]);
    }
  });

  it("links each name to a doc that exists, at a heading that exists, that names it and says it works today", () => {
    for (const i of INTEGRATIONS) {
      const doc = docAt(i.href);
      expect(doc.text, `${i.id}: ${doc.file}`).not.toBe("");
      expect(doc.section, `${i.id}: no heading for ${i.href}`).not.toBe("");
      expect(doc.section, i.id).toContain(word(i.name));
      expect(doc.section, `${i.id}: ${i.href}`).not.toMatch(NOT_LIVE);
      if (i.href.startsWith("/docs/connectors/")) expect(doc.text, i.id).not.toMatch(NOT_LIVE);
    }
  });

  it("says of the systems alone, once under them, that each was built from its documentation and tested against a stand-in", () => {
    const systems = INTEGRATIONS.filter((i) => SYSTEMS.includes(i.group));
    const others = INTEGRATIONS.filter((i) => !SYSTEMS.includes(i.group));
    expect(others.map((i) => i.id)).toEqual(["stripe", "mollie"]);
    // Each system's own doc says it of that system, word for word, beside its name.
    for (const i of systems) {
      const text = docAt(i.href.split("#")[0] ?? "").text;
      const says = text.split(/\n\n|\n(?=[-|])/).some((p) => p.includes(UNTRIED) && p.includes(word(i.name)));
      expect(says, `${i.id}: its doc should say "${UNTRIED}" beside its name`).toBe(true);
    }
    // A payment's doc says nothing of the kind.
    for (const i of others) expect(docAt(i.href.split("#")[0] ?? "").text, i.id).not.toContain(UNTRIED);
    // A connector the owner app marks as new from its documentation is one of the systems.
    for (const i of INTEGRATIONS) if (byKind("hosted", i.connector)?.fresh) expect(systems, i.id).toContain(i);
    // The overview of what connects says it once, of the same set, and of no payment.
    const overview = read("src/content/docs/docs/integrations.md");
    const lines = overview.split("\n").filter((l) => l.includes(UNTRIED));
    expect(lines.length).toBe(1);
    for (const i of systems) expect(lines[0], i.id).toContain(word(i.name));
    for (const i of others) expect(lines[0], i.id).not.toContain(word(i.name));
    // The line the site says, open and closed.
    expect(untried(true)).toBe(
      "Each was built from its platform's documentation and tested against a stand-in; the beta is where they first run with a business's real account.",
    );
    expect(untried(false)).toBe(
      "Each was built from its platform's documentation and tested against a stand-in; none has yet run with a business's real account.",
    );
    expect(UNTRIED_LINE).toBe(untried(HOSTED_PILOT_OPEN));
    expect(untriedOne("Shopify", true)).toBe(
      "Built from Shopify's documentation and tested against a stand-in; the beta is where it first runs with a business's real account.",
    );
    // On the row: under the systems' names, before the payments and the assistants, and marking none.
    const row = read("src/components/WorksWith.astro");
    const markup = row.slice(row.indexOf('<div class="ww">'));
    expect(markup.match(/\{UNTRIED_LINE\}/g)?.length).toBe(1);
    expect(markup.indexOf("{UNTRIED_LINE}")).toBeGreaterThan(markup.indexOf('id="ww-systems"'));
    expect(markup.indexOf("{UNTRIED_LINE}")).toBeLessThan(markup.indexOf('id="ww-payments"'));
    expect(markup.indexOf("{UNTRIED_LINE}")).toBeLessThan(markup.indexOf('id="ww-assistants"'));
    expect(row).toContain("const systems = items.filter((i) => SYSTEMS.includes(i.group));");
    expect(row).toContain('{systems.length > 0 && <p class="ww-note ww-untried">{UNTRIED_LINE}</p>}');
    expect(row).not.toMatch(/ww-mark|<sup[^>]*>\*<\/sup>|not yet run with a real account\)|None of these connections/);
    for (const i of INTEGRATIONS) expect(Object.keys(i), i.id).not.toContain("untried");
    // No lone "new" beside one name, here or in its doc.
    expect(row).not.toMatch(/>\s*new\s*</);
    expect(read("src/content/docs/docs/connectors/beds24.md")).not.toContain("**New:**");
    expect(read("src/content/docs/docs/property-systems.md")).not.toContain("(new)");
    // The note to agents says it of the same set: the shops, stays, kitchens and trades, and the calendars.
    const connect = read("public/connect.md").replace(/\s+/g, " ");
    expect(connect).toContain(
      "These, and the calendars above, were built from each one's documentation and tested against a stand-in; not yet run with a real account.",
    );
  });

  it("is names only, in text: no logo file, no logo field, no image on the row", () => {
    expect(existsSync(site("src/assets/logos"))).toBe(false);
    for (const i of INTEGRATIONS) expect(Object.keys(i.brand), i.id).not.toContain("logo");
    const row = read("src/components/WorksWith.astro");
    expect(row).not.toMatch(/<img|\.svg/);
    expect(readFileSync(fileURLToPath(new URL("../../../biome.json", import.meta.url)), "utf8")).not.toContain(
      "assets/logos",
    );
  });

  it("writes iCloud Calendar with Apple's credit, WooCommerce with ® and Automattic's notice, and says nobody endorses us", () => {
    const icloud = INTEGRATIONS.find((i) => i.id === "icloud");
    expect(icloud?.name).toBe("iCloud Calendar");
    expect(icloud?.brand.notice).toBe(APPLE_NOTICE);
    expect(APPLE_NOTICE).toBe(
      "iCloud is a trademark of Apple Inc., registered in the U.S. and other countries and regions.",
    );
    const woo = INTEGRATIONS.find((i) => i.id === "woocommerce");
    expect(woo?.brand.symbol).toBe("®");
    expect(woo?.brand.notice).toBe(WOO_NOTICE);
    expect(WOO_NOTICE).toBe("WooCommerce and its associated designs are trademarks of Automattic Inc.");
    expect(noticesOf(INTEGRATIONS)).toEqual([APPLE_NOTICE, WOO_NOTICE]);
    const row = read("src/components/WorksWith.astro");
    expect(row).toContain("the names are their owners' trademarks, and none endorses us.");
    expect(row).toContain("noticesOf(items)");
  });

  it("says the assistants' own pages hold what each needs, and links each one", () => {
    expect(ASSISTANT_LINKS.map((a) => a.slug).sort()).toEqual(ASSISTANTS.map((a) => a.slug).sort());
    for (const a of ASSISTANT_LINKS) expect(a.guidelines, a.slug).toMatch(/^https:\/\//);
    expect(read("src/components/WorksWith.astro")).toContain("each page says what it needs");
  });

  it("turns the site's accent under the pointer, as the case links do", () => {
    expect(read("src/components/WorksWith.astro")).toMatch(
      /\.ww-item:hover,\s*\.ww-item:focus-visible \{\s*color: var\(--violet-ink\);/,
    );
    // The site's accent is violet: its links, its focus ring and its selection.
    const css = read("src/styles/site.css");
    expect(css).toContain("--focus: color-mix(in srgb, var(--violet-ink) 78%, transparent);");
    expect(css).toContain("text-decoration-color: var(--violet);");
  });

  it("is on /inbox, right after the examples", () => {
    const page = read("src/pages/inbox.astro");
    expect(page.indexOf("<WorksWith />")).toBeGreaterThan(page.indexOf("<UseCases />"));
    expect(page.indexOf("<WorksWith />")).toBeLessThan(page.indexOf("<Inbox />"));
  });
});

describe("the docs say what 0.2.0 does", () => {
  it("lists every name on the row as working today, and none as being built", () => {
    const overview = read("src/content/docs/docs/integrations.md");
    const today = overview.split("## Works today")[1]?.split("## ")[0] ?? "";
    const waiting = overview.split("## Waiting on another company")[1]?.split("## ")[0] ?? "";
    expect(overview).not.toContain("## Being built");
    for (const i of INTEGRATIONS) {
      expect(today, i.id).toContain(word(i.name));
      expect(waiting, i.id).not.toContain(`**${word(i.name)}**`);
    }
    for (const t of ["Mews", "apaleo", "Cloudbeds", "Smoobu", "Toast", "Clover", "Deliverect", "Jobber"]) {
      expect(waiting, t).toContain(t);
    }
    expect(read("src/pages/install.astro")).not.toMatch(/Being built/);
    const notBuilt = read("public/connect.md").split("**Not built yet.**")[1]?.split("\n---")[0] ?? "";
    expect(notBuilt).not.toMatch(/Native connectors|Shopify|WooCommerce|Square|Calendly/);
    for (const i of INTEGRATIONS) expect(read("public/connect.md"), i.id).toContain(word(i.name));
    expect(read("src/content/docs/docs/property-systems.md")).not.toMatch(/Hostaway\*\* \(being built/);
  });

  it("say bookings and orders taken elsewhere are set today, in the owner app, and published in the manifest", () => {
    for (const path of ["src/content/docs/docs/setting-up-for-agents.md", "public/setting-up-for-agents.md"]) {
      const text = read(path);
      expect(text, path).not.toContain("handled elsewhere at an address the business owns");
      expect(text, path).not.toContain("join it with the per-door setting that is coming");
      expect(text, path).toContain("**Take bookings or orders on another site?**");
      expect(text, path).toContain("(`doors_elsewhere`)");
      expect(text, path).toMatch(
        /\[Booked or ordered elsewhere\]\((https:\/\/surfingdog\.ai)?\/docs\/connectors\/elsewhere\/\)/,
      );
    }
    // The setting is the core's: the manifest lists those doors, and leaves their kind out.
    const manifest = read("../../packages/core/src/manifest.ts");
    expect(manifest).toContain("doors_elsewhere: elsewhere.map(");
  });

  it("give pay links where the code makes them: orders, a stay's deposit and balance, and a table's deposit", () => {
    const connect = read("public/connect.md");
    expect(connect).not.toContain("(booked services not yet)");
    expect(connect).toContain("a table's deposit");
    expect(connect).toContain("https://surfingdog.ai/docs/ordering/#tables");
    expect(read("../../packages/core/src/kitchen/deposits.ts")).toContain("A table's deposit");
    expect(read("src/content/docs/docs/ordering.md")).toContain("a **deposit per person** from a party size");
  });

  it("head the WooCommerce doc with its mark", () => {
    expect(read("src/content/docs/docs/connectors/woocommerce.md")).toMatch(/^---\ntitle: WooCommerce®\n/);
  });
});

/** Every file the site renders text from, under src and public: docs, pages, components, data. */
function files(dir: string): string[] {
  return readdirSync(site(dir)).flatMap((f) => {
    const path = join(dir, f);
    if (statSync(site(path)).isDirectory()) return files(path);
    return /\.(md|mdx|astro|ts|txt)$/.test(f) ? [path] : [];
  });
}

describe("WooCommerce, wherever the site names it", () => {
  /** Where the name is set by data, and the page that shows that data and its notice. */
  const SHOWN_BY: Record<string, string[]> = {
    "src/lib/integrations.ts": ["src/components/WorksWith.astro"],
    "src/lib/integrations-table.ts": ["src/pages/integrations/index.astro"],
    "src/lib/platforms.ts": ["src/lib/platforms.ts", "src/pages/integrations/[slug].astro"],
    "src/lib/topics.ts": ["src/components/TopicGuide.astro"],
    "src/lib/cases.ts": ["src/pages/inbox/for/[slug].astro", "src/components/WorksWith.astro"],
    "src/lib/guides.ts": ["src/pages/guides/[slug].astro"],
  };

  it("carries ® on its first use, with Automattic's notice on the same page", () => {
    const named = [...files("src"), ...files("public")].filter((f) => read(f).includes("WooCommerce"));
    expect(named.length).toBeGreaterThan(8);
    for (const f of named) {
      // Markdown's frontmatter (a docs page's title) is not its text; the name's first use in the text is.
      const text = f.endsWith(".md") ? read(f).replace(/^---\n[\s\S]*?\n---\n/, "") : read(f);
      const first = text.indexOf("WooCommerce");
      if (f !== "src/lib/integrations.ts") expect(text.slice(first, first + 12), f).toBe("WooCommerce®");
      const shows = SHOWN_BY[f] ?? [f];
      for (const page of shows)
        expect(read(page), `${f}: ${page}`).toMatch(
          /WOO_NOTICE|noticesOf|platformNotices|trademarks of Automattic Inc\./,
        );
    }
  });

  it("on /inbox and every business page: on the example, its page and the other examples", () => {
    const shop = CASES.find((c) => c.slug === "shops");
    expect(shop?.label).toBe("A shop on WooCommerce®");
    expect(shop?.description).toContain("WooCommerce®");
    // Only the shop's own page names it beyond its label, and that page puts the notice under its example.
    for (const c of CASES) {
      const text = [c.short, c.does, c.title, c.description, c.lede, ...c.points].join("\n");
      if (text.includes("WooCommerce")) expect(c.label, c.slug).toContain("WooCommerce®");
    }
    const page = read("src/pages/inbox/for/[slug].astro");
    expect(page).toContain('{wooHere && <p class="fine notice">{WOO_NOTICE}</p>}');
    expect(page).toContain('{wooOthers && <p class="fine notice">{WOO_NOTICE}</p>}');
    expect(page).toContain("<Marked text={o.label} />");
    // On /inbox the examples name it first, with its mark; the row that follows gives the notice.
    expect(read("src/components/UseCases.astro")).toContain("<Marked text={c.label} />");
    expect(noticesOf(INTEGRATIONS)).toContain(WOO_NOTICE);
  });
});

describe("the examples", () => {
  const live = new Map(INTEGRATIONS.map((i) => [i.id, i]));
  /** Every connector's own name, but the generic ones ("Calendar", "Calendar link", "Share your bookings"). */
  const titles = [...new Set(HOSTS.hosted.map((c) => c.title))].filter(
    (t) => !/^(Calendar|Calendar link|Share your bookings)$/.test(t),
  );
  const words = (c: (typeof CASES)[number]) =>
    [c.label, c.arrives, c.short, c.does, c.title, c.description, c.lede, ...c.points].join("\n");
  const has = (text: string, name: string) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(text);

  it("are one per kind of business, each on a system it connects to today", () => {
    expect(CASES.map((c) => c.slug)).toEqual(["restaurants", "salons", "guesthouses", "shops", "trades"]);
    for (const c of CASES) {
      expect(live.has(c.system), c.slug).toBe(true);
      expect(c.works, c.slug).toContain(c.system);
      for (const w of c.works) expect(live.has(w), `${c.slug}: ${w}`).toBe(true);
      const system = live.get(c.system);
      expect(c.label, c.slug).toBe(`${c.label.split(" on ")[0]} on ${system?.name}${system?.brand.symbol ?? ""}`);
    }
  });

  it("name no business: a kind of business on its system, and nothing else", () => {
    for (const c of CASES) expect(c.label).toMatch(/^An? (café|barber|guesthouse|shop|plumber) on [A-Z][\w.]+®?$/);
    const section = read("src/components/UseCases.astro");
    expect(section).toContain('<p class="eyebrow">Examples</p>');
    expect(section).toContain("These are examples of what it does today, not customers.");
    expect(read("src/pages/inbox/for/[slug].astro")).toContain("shown on a made-up business");
  });

  it("say on /inbox what the inbox does in one short sentence, and keep the detail on their own page", () => {
    for (const c of CASES) {
      const n = c.short.split(/\s+/).length;
      expect(n, `${c.slug}: ${n} words`).toBeGreaterThanOrEqual(15);
      expect(n, `${c.slug}: ${n} words`).toBeLessThanOrEqual(23);
      expect(c.short.replace(/\.$/, ""), c.slug).not.toMatch(/[.?!]/);
      expect(c.does.length, c.slug).toBeGreaterThan(c.short.length);
    }
    const section = read("src/components/UseCases.astro");
    expect(section).toContain("{c.short}");
    expect(section).not.toContain("{c.does}");
    expect(read("src/pages/inbox/for/[slug].astro")).toContain("{c.does}");
  });

  it("name every shop and stay system the row has on the page for that kind of business", () => {
    expect(CASES.find((c) => c.slug === "shops")?.works).toEqual([
      "woocommerce",
      "shopify",
      "square",
      "stripe",
      "mollie",
    ]);
    expect(CASES.find((c) => c.slug === "shops")?.points.join(" ")).toContain("Shopify or Square");
    expect(CASES.find((c) => c.slug === "guesthouses")?.works).toEqual(["beds24", "hostaway", "stripe", "mollie"]);
    for (const i of INTEGRATIONS.filter((x) => x.group === "shops" || x.group === "stays")) {
      expect(
        CASES.some((c) => c.works.includes(i.id)),
        i.id,
      ).toBe(true);
    }
  });

  it("promise of a calendar only what it does: bookings into those that take them, and times not offered rather than never", () => {
    const salons = CASES.find((c) => c.slug === "salons");
    expect(salons?.lede).not.toContain("the calendar you already keep");
    expect(salons?.lede).toContain("iCloud Calendar, Cal.com or Calendly's paid plans");
    for (const c of CASES) expect(words(c), c.slug).not.toMatch(/never offered|never at a time/);
  });

  it("say what Calendly gives: its busy times, never its availability schedule", () => {
    const salons = CASES.find((c) => c.slug === "salons");
    for (const t of [salons?.short, salons?.does, salons?.description, salons?.lede, ...(salons?.points ?? [])]) {
      expect(t).not.toMatch(/shows? free/);
    }
    expect(salons?.short).toContain("busy in a calendar it checks");
    expect(salons?.does).toContain("busy in a calendar Calendly checks");
    expect(salons?.does).toContain("one-on-one event type of the same length");
    // As the connector does: GET /user_busy_times, and bookings only on the paid plans.
    const calendly = read("../../packages/adapters/src/connectors/calendly.ts");
    expect(calendly).toContain("/user_busy_times");
    expect(calendly).not.toContain("/user_availability_schedules");
  });

  it("never name a system that is switched off, and name every system they work with", () => {
    for (const c of CASES) {
      const text = words(c);
      for (const off of OFF) {
        if (!has(text, off)) continue;
        // Only a calendar named through its link, in a sentence that says it blocks busy times only.
        expect(INTEGRATIONS.find((i) => i.name === off)?.only, `${c.slug} names ${off}`).toBe("busy times");
        const sentence = text.split(/(?<=\.)\s/).find((x) => has(x, off)) ?? "";
        expect(sentence, `${c.slug} names ${off}`).toMatch(/link[\s\S]*busy times only/);
      }
      for (const t of titles) {
        if (has(text, t))
          expect(
            INTEGRATIONS.some((i) => i.name === t || word(i.name) === t),
            `${c.slug} names ${t}`,
          ).toBe(true);
      }
      expect(has(text, live.get(c.system)?.name ?? "?"), c.slug).toBe(true);
      const said = c.description.match(/Works with (.+)\.$/)?.[1];
      if (said) {
        const names = said.replace(/®/g, "").split(/, | and /);
        for (const n of names)
          expect(
            c.works.map((w) => live.get(w)?.name),
            `${c.slug}: ${n}`,
          ).toContain(n);
      }
    }
  });

  it("each have a page with a title and a description that fit a search result", () => {
    for (const c of CASES) {
      expect(c.title.endsWith(" · Surfing Dog"), c.title).toBe(true);
      expect(c.title.length, c.title).toBeLessThanOrEqual(70);
      expect(c.title.length, c.title).toBeGreaterThan(30);
      expect(c.description.length, c.description).toBeLessThanOrEqual(160);
      expect(c.description.length, c.description).toBeGreaterThanOrEqual(80);
    }
    expect(new Set(CASES.map((c) => c.title)).size).toBe(CASES.length);
    expect(new Set(CASES.map((c) => c.description)).size).toBe(CASES.length);
    expect(read("src/components/UseCases.astro")).toContain("href={caseHref(c)}");
    expect(caseHref(CASES[0] as (typeof CASES)[number])).toBe("/inbox/for/restaurants/");
  });

  it("are plain: no hype, no promise of being checked or certified, and no other company's word for us", () => {
    for (const c of CASES) {
      const text = words(c);
      expect(text, c.slug).not.toMatch(/\b(verified|certified|guaranteed?|best|#1|number one)\b/i);
      expect(text, c.slug).not.toMatch(
        /\b(seamless(ly)?|effortless(ly)?|revolutionary|game.?chang\w*|supercharge\w*|cutting.?edge|world.?class|unlock\w*|leading|partner(ed|ship)?)\b/i,
      );
    }
  });

  it("link only where something is: the docs, the assistants' pages, the checker and the ways to run it", () => {
    const hrefs = [
      ...INTEGRATIONS.map((i) => i.href),
      ...CASES.map((c) => c.doc.href),
      ...ASSISTANT_LINKS.map((a) => `/assistants/${a.slug}/`),
      ...[...read("src/pages/inbox/for/[slug].astro").matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1] ?? ""),
    ];
    for (const h of hrefs) {
      const p = h.replace(/[?#].*$/, "").replace(/\/+$/, "");
      const found = p.startsWith("/docs/")
        ? existsSync(site(`src/content/docs${p}.md`))
        : p.startsWith("/assistants/")
          ? ASSISTANTS.some((a) => `/assistants/${a.slug}` === p)
          : existsSync(site(`src/pages${p}.astro`)) || existsSync(site(`src/pages${p}/index.astro`));
      expect(found, h).toBe(true);
    }
  });
});
