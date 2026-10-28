import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { builtInConnectors } from "../../../packages/adapters/src/connectors/index";
import { ASSISTANTS } from "../src/lib/assistants";
import { INTEGRATIONS, SYSTEMS, UNTRIED_LINE } from "../src/lib/integrations";
import { COMING, ROWS, type Row, SYSTEM_GROUPS, TABLE } from "../src/lib/integrations-table";
import { PLATFORMS } from "../src/lib/platforms";

/**
 * /integrations (src/lib/integrations-table.ts, src/pages/integrations/index.astro), read against the
 * connectors in packages/adapters and their docs: a row that Works is ready with nothing set on a
 * hosted inbox and on one's own server, a row Coming is not, every connector this release ships is in
 * a row, every name on the /inbox row is in the table, and nothing carries a date. The one line said of
 * the systems' connections sits under them, never under payments, assistants or automations. Checked
 * without a build.
 */
const site = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(site(path), "utf8");
const PAGE = "src/pages/integrations/index.astro";

const HOSTS = { "own server": builtInConnectors(), hosted: builtInConnectors({ hosted: true }) };
type Host = keyof typeof HOSTS;
const connector = (host: Host, kind: string) => HOSTS[host].find((c) => c.kind === kind);
/** Whether a connector, and the preset a row names, is ready with nothing set on that host. */
function ready(host: Host, kind: string, preset?: string): boolean {
  const c = connector(host, kind);
  if (!c) return false;
  if ((c.ready?.() ?? true) !== true) return false;
  if (!preset) return true;
  const p = c.presets?.find((x) => x.id === preset);
  return Boolean(p) && (p?.ready?.() ?? true) === true;
}

/** The doc an href names, and whether the heading its anchor names is there. */
function docOf(href: string): { text: string; anchored: boolean } {
  const [path = "", anchor] = href.split("#");
  const file = site(`src/content/docs${path.replace(/\/$/, "")}.md`);
  if (!existsSync(file)) return { text: "", anchored: false };
  const text = readFileSync(file, "utf8");
  if (!anchor) return { text, anchored: true };
  const ids = [...text.matchAll(/^#{2,4} (.+)$/gm)].map((m) =>
    (m[1] ?? "")
      .replace(/\s*\{#([a-z0-9-]+)\}\s*$/, " $1")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-"),
  );
  return { text, anchored: ids.includes(anchor) };
}

describe("the table of integrations", () => {
  it("is grouped as owners look for it, and ends with what is coming", () => {
    expect(TABLE.map((g) => g.title)).toEqual([
      "Calendars and bookings",
      "Shops and orders",
      "Restaurants and cafés",
      "Places to stay",
      "Trades",
      "Payments",
      "AI assistants that reach your inbox",
      "Automations",
    ]);
    expect(COMING.map((g) => g.title)).toEqual([
      "Built; on once each company agrees",
      "Built; off while the standard is a draft (on your own server, `INBOX_UCP_LODGING=on`)",
    ]);
    // Works, but for Meta's custom connectors for Muse, which follow Meta's own roll-out.
    for (const g of TABLE)
      for (const r of g.rows) expect(r.status, r.name).toBe(r.assistant === "meta-muse" ? "Rolling out" : "Works");
    expect(read("src/lib/assistants.ts")).toContain("custom connectors follow Meta's roll-out.");
    for (const g of COMING) for (const r of g.rows) expect(r.status, r.name).toBe("Coming");
    const page = read(PAGE);
    expect(page.indexOf(">More coming<")).toBeGreaterThan(page.indexOf("TABLE.map"));
    expect(page.indexOf("COMING.map")).toBeGreaterThan(page.indexOf(">More coming<"));
  });

  it("says Works only of connectors ready with nothing set, on a hosted inbox and on one's own server", () => {
    for (const r of ROWS.filter((x) => x.status === "Works" && x.connectors)) {
      for (const c of r.connectors ?? []) {
        for (const host of Object.keys(HOSTS) as Host[]) {
          expect(
            ready(host, c.kind, c.preset),
            `${r.name}: ${c.kind}${c.preset ? `/${c.preset}` : ""} on ${host}`,
          ).toBe(true);
        }
      }
    }
  });

  it("says Coming of connectors that wait on something, and of nothing a host has ready", () => {
    for (const r of ROWS.filter((x) => x.status === "Coming" && x.connectors)) {
      for (const c of r.connectors ?? []) {
        expect(connector("hosted", c.kind), `${r.name}: ${c.kind} is in this release`).toBeDefined();
        for (const host of Object.keys(HOSTS) as Host[])
          expect(ready(host, c.kind), `${r.name} on ${host}`).toBe(false);
      }
    }
    // Every one is built: in the release, and on once its company agrees.
    const company = COMING.find((g) => g.id === "company");
    for (const r of company?.rows ?? []) {
      expect(r.connectors?.length, r.name).toBeGreaterThan(0);
      for (const c of r.connectors ?? []) expect(connector("hosted", c.kind), r.name).toBeDefined();
    }
    // And UCP Lodging, built and off while it is a draft, switched on by its own setting on one's own server.
    const ucp = ROWS.find((r) => r.name === "UCP Lodging");
    expect(ucp?.status).toBe("Coming");
    const stays = read("src/content/docs/docs/stays.md");
    expect(stays).toContain("## UCP Lodging (off for now)");
    expect(stays).toContain("On your own server, `INBOX_UCP_LODGING=on` turns it on");
    expect(COMING.find((g) => g.rows.includes(ucp as Row))?.title).toContain("`INBOX_UCP_LODGING=on`");
  });

  it("has every connector this release ships, and every name the /inbox row shows", () => {
    const named = new Set(ROWS.flatMap((r) => (r.connectors ?? []).map((c) => c.kind)));
    for (const c of HOSTS.hosted) expect(named.has(c.kind), `${c.title} (${c.kind}) has no row`).toBe(true);
    for (const c of HOSTS.hosted) {
      for (const p of c.presets ?? []) {
        // A preset that is a way to connect (a sign-in, keys), not a calendar of its own, needs no row.
        if (!["caldav", "ics"].includes(c.kind)) continue;
        const has = ROWS.some((r) => r.connectors?.some((x) => x.kind === c.kind && x.preset === p.id));
        expect(has, `${c.kind}/${p.id}`).toBe(true);
      }
    }
    for (const i of INTEGRATIONS) {
      const row = ROWS.find(
        (r) =>
          r.name.replace("®", "") === i.name &&
          r.connectors?.some((c) => c.kind === i.connector && (i.preset ? c.preset === i.preset : !c.preset)),
      );
      expect(row, i.id).toBeDefined();
      expect(row?.status, i.id).toBe("Works");
    }
    expect(new Set(ROWS.map((r) => r.name)).size).toBe(ROWS.length);
  });

  it("lists the assistants that reach the inbox, each linked to its own page", () => {
    const rows = ROWS.filter((r) => r.assistant);
    expect(rows.map((r) => r.assistant).sort()).toEqual(ASSISTANTS.map((a) => a.slug).sort());
    for (const r of rows) {
      const a = ASSISTANTS.find((x) => x.slug === r.assistant);
      expect(r.href).toBe(`/assistants/${a?.slug}/`);
      expect(r.name, r.href).toBe(a?.name);
    }
  });

  it("links every row to a page or a doc that exists, at a heading that exists, that does not call it live when it waits", () => {
    for (const r of ROWS) {
      const path = r.href.replace(/[?#].*$/, "");
      if (path.startsWith("/docs/")) {
        const doc = docOf(r.href);
        expect(doc.text, `${r.name}: ${r.href}`).not.toBe("");
        expect(doc.anchored, `${r.name}: ${r.href}`).toBe(true);
      } else if (path.startsWith("/assistants/")) {
        expect(
          ASSISTANTS.some((a) => `/assistants/${a.slug}/` === path),
          r.href,
        ).toBe(true);
      } else {
        const slug = path.match(/^\/integrations\/([a-z0-9-]+)\/$/)?.[1];
        expect(slug, r.href).toBeDefined();
        expect(
          PLATFORMS.some((p) => p.slug === slug),
          r.href,
        ).toBe(true);
      }
    }
    // The waiting property systems' docs say they are switched off.
    for (const name of ["apaleo", "Cloudbeds", "Mews"]) {
      const r = ROWS.find((x) => x.name === name) as Row;
      expect(docOf(r.href).text, name).toContain("**Not switched on yet.**");
    }
  });

  it("says each line in a few words, with no date, no hype and no claim of being first", () => {
    for (const r of ROWS) {
      expect(r.does.split(/\s+/).length, r.name).toBeLessThanOrEqual(13);
      expect(r.does, r.name).not.toMatch(/[.!]$/);
      if (r.status !== "Works") expect(r.does, r.name).not.toMatch(/\b(19|20)\d\d\b|\bQ[1-4]\b|\bsoon\b/i);
      expect(r.does, r.name).not.toMatch(/\b(the first|the only|best|seamless\w*|effortless\w*|unlock\w*)\b/i);
    }
    // The one date is GloriaFood's own end, which its owner announced.
    expect(ROWS.filter((r) => /\b20\d\d\b/.test(r.does)).map((r) => r.name)).toEqual(["GloriaFood"]);
  });

  it("says the one line of the systems under them alone, and gives the credits, and no logo", () => {
    const page = read(PAGE);
    // Under the last group of systems, before payments, assistants and automations.
    expect(TABLE.map((g) => g.id).slice(0, SYSTEM_GROUPS.length)).toEqual([...SYSTEM_GROUPS]);
    expect(page).toContain("const lastSystem = TABLE.filter((g) => SYSTEM_GROUPS.includes(g.id)).at(-1)?.id;");
    expect(page).toContain("{g.id === lastSystem && (");
    expect(page.match(/\{UNTRIED_LINE\}/g)?.length).toBe(1);
    expect(page).not.toMatch(/NOT_YET_REAL|None of these connections/);
    expect(UNTRIED_LINE).toMatch(/^Each was built from its platform's documentation and tested against a stand-in/);
    // The /inbox row's systems are these groups' rows; its payments are not.
    for (const i of INTEGRATIONS) {
      const group = TABLE.find((g) => g.rows.some((r) => r.connectors?.some((c) => c.kind === i.connector)));
      expect(SYSTEM_GROUPS.includes(group?.id ?? ""), i.id).toBe(SYSTEMS.includes(i.group));
    }
    expect(page).toContain("the names are their owners' trademarks, and none endorses us.");
    expect(page).toContain("{WOO_NOTICE}");
    expect(page).toContain("{APPLE_NOTICE}");
    expect(page).toContain("<Marked text={r.name} />");
    expect(page).not.toMatch(/<img|\.svg/);
    expect(ROWS.find((r) => r.name.startsWith("WooCommerce"))?.name).toBe("WooCommerce®");
    // Its title and description fit a search result.
    const title = page.match(/const TITLE = "([^"]+)";/)?.[1] ?? "";
    const description = page.match(/const DESCRIPTION =\s*"([^"]+)";/)?.[1] ?? "";
    expect(title.endsWith(" · Surfing Dog")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(70);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(description.length).toBeGreaterThanOrEqual(80);
    // Its colours are the site's tokens; no red.
    const styles = page.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\bred\b|crimson|tomato|--c-danger|--c-error/i);
  });

  it("is in the sitemap with every platform page and topic guide: the site's sitemap leaves no page out", () => {
    const config = read("astro.config.mjs");
    const call = config.slice(config.indexOf("sitemap({"), config.indexOf("starlight({"));
    expect(call).toContain("customSitemaps");
    expect(call).not.toMatch(/\bfilter\s*:/);
    // Static pages, built for every slug: the index, one per platform.
    expect(existsSync(site("src/pages/integrations/index.astro"))).toBe(true);
    expect(read("src/pages/integrations/[slug].astro")).toContain(
      "return PLATFORMS.map((p) => ({ params: { slug: p.slug }",
    );
    for (const path of ["src/pages/integrations/index.astro", "src/pages/integrations/[slug].astro"])
      expect(read(path), path).not.toMatch(/noindex/);
  });

  it("is linked from the /inbox row, the footer and the docs", () => {
    expect(read("src/components/WorksWith.astro")).toContain('href="/integrations/"');
    expect(read("src/components/WorksWith.astro")).toContain("all of them, and more coming");
    expect(read("src/components/Footer.astro")).toContain('{ href: "/integrations/", label: "Integrations" }');
    expect(read("src/content/docs/docs/index.md")).toContain("[Integrations](/integrations/)");
    expect(read("src/content/docs/docs/integrations.md")).toContain("[Integrations](/integrations/)");
  });
});
