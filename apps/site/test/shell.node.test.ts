import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildShell, fontFaceCss, shellFonts, siteDir } from "../src/lib/shell";

/**
 * /shell.css is how the network's public pages wear the site's look (src/lib/shell.ts). These tests
 * hold it to the site: every design token in shell.css is the one site.css and the design system
 * declare, in the same theme block; the bar, footer, box and score card in shell/parts.css carry the
 * declarations of the components they copy; and the fonts it names are published, and are the ones
 * the site's own pages load.
 */
const dir = siteDir(fileURLToPath(new URL("..", import.meta.url)));
const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

/**
 * Every custom property a stylesheet declares, keyed by where: the at-rules and selector around it
 * (cascade layers left out, since the compiled file puts the design system's base in one) and its
 * name. A later declaration in the same place wins, as it does in the cascade.
 */
function tokens(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const stack: string[] = [];
  let buf = "";
  const flush = () => {
    const m = buf.trim().match(/^(--[\w-]+)\s*:\s*([\s\S]*)$/);
    if (m?.[1] && m[2] !== undefined) {
      const where = stack.filter((s) => !s.startsWith("@layer")).join(" > ");
      out.set(`${where} | ${m[1]}`, m[2].trim().replace(/\s+/g, " "));
    }
    buf = "";
  };
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (ch === "{") {
      stack.push(buf.trim().replace(/\s+/g, " "));
      buf = "";
    } else if (ch === "}") {
      flush();
      stack.pop();
    } else if (ch === ";") {
      flush();
    } else {
      buf += ch;
    }
  }
  return out;
}

/**
 * A value as the optimiser writes it: the site's own build (and shell.css) turns rgba() into hex
 * and shortens hex and numbers, so both sides are put in one spelling before they are compared.
 */
function canon(value: string): string {
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return value
    .replace(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/g, (_m, r, g, b, a) => {
      const alpha = a === undefined ? 1 : Number(a);
      return `#${hex(+r)}${hex(+g)}${hex(+b)}${alpha === 1 ? "" : hex(alpha * 255)}`;
    })
    .replace(/#([0-9a-f]{3,8})\b/gi, (_m, h: string) => {
      let x = h.toLowerCase();
      if (x.length === 3 || x.length === 4) x = [...x].map((c) => c + c).join("");
      if (x.length === 8 && x.endsWith("ff")) x = x.slice(0, 6);
      return `#${x}`;
    })
    .replace(/(^|[\s,(])0\.(\d)/g, "$1.$2")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

describe("shell.css", () => {
  let css = "";
  let readable = "";
  beforeAll(async () => {
    css = await buildShell(dir);
    readable = await buildShell(dir, { minify: false });
  });

  it("declares every token of site.css and the design system, with the same value in the same theme block", () => {
    const ui = readFileSync(`${dir}/node_modules/@surfingdog/ui/src/index.css`, "utf8");
    const source = tokens(`${ui}\n${read("src/styles/site.css")}`);
    const shell = tokens(readable);
    let n = 0;
    for (const [key, value] of source) {
      // @theme and @utility are Tailwind's own; the compiler writes the ones in use into the theme layer.
      if (key.startsWith("@theme") || key.startsWith("@utility")) continue;
      n++;
      // A colour-mix() token is written twice by Tailwind, in the site's build as here: a plain
      // fallback, then the value itself inside @supports. The value is the one that counts.
      const [where = "", name] = key.split(" | ");
      const parts = where.split(" > ");
      const mixed = [...parts.slice(0, -1), "@supports (color: color-mix(in lab, red, red))", parts.at(-1)].join(" > ");
      const got = shell.get(`${mixed} | ${name}`) ?? shell.get(key) ?? "(missing)";
      expect(canon(got), key).toBe(canon(value));
    }
    // The three theme blocks and the theme-independent scale, at least.
    expect(n).toBeGreaterThan(150);
    for (const name of ["--ground", "--ink", "--ink-2", "--edge", "--card-veil", "--fs-page-title", "--radius-card"]) {
      expect(
        [...shell.keys()].some((k) => k.endsWith(`| ${name}`)),
        name,
      ).toBe(true);
    }
    // The fonts the design system names, resolved the way the site's own build resolves them.
    expect(readable).toMatch(/--font-display: "Plus Jakarta Sans Variable"/);
    expect(readable).toMatch(/--font-sans: "Manrope Variable"/);
  });

  it("adds no token of its own beyond the sd- ones, so nothing in it can override the site's", () => {
    const names = [...tokens(read("shell/parts.css")).keys()].map((k) => k.split(" | ")[1]);
    expect(names.filter((n) => !n?.startsWith("--sd-"))).toEqual([]);
  });

  it("follows the system's theme and the data-theme the network stamps from the cookie", () => {
    expect(readable).toContain('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"])');
    expect(readable).toContain(':root[data-theme="dark"]');
  });

  it("names only fonts the site publishes, at names that change with their bytes", () => {
    const fonts = shellFonts(dir);
    const named = [...css.matchAll(/url\(\/fonts\/([^)]+)\)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThanOrEqual(4);
    expect(new Set(named)).toEqual(new Set(fonts.map((f) => f.name)));
    for (const f of fonts) {
      expect(f.name).toMatch(/^[a-z0-9-]+\.[0-9a-f]{8}\.woff2$/);
      expect(existsSync(f.path), f.path).toBe(true);
    }
    // Nothing that only exists inside one build, and no image from this host: a page on the
    // network's own host may load styles and fonts from here, and nothing else.
    expect(css).not.toContain("/_astro/");
    expect(css.replace(/url\(\/fonts\/[^)]+\)|url\(data:[^)]+\)/g, "")).not.toMatch(/url\(/);
  });

  it("has the pieces the network's pages are built from", () => {
    for (const cls of [
      // the site's own
      "wrap",
      "wrap-read",
      "section",
      "is-head",
      "eyebrow",
      "h-page",
      "h-section",
      "lede",
      "fine",
      "prose",
      "glass",
      "glass-strong",
      "card",
      "panel",
      "btn",
      "btn-secondary",
      "pill",
      "input",
      "link",
      "mono",
      "sky",
      "skip",
      "u-line",
      // shell/parts.css
      "sd-nav",
      "sd-bar",
      "sd-links",
      "sd-menu",
      "sd-sheet",
      "sd-foot",
      "sd-ask",
      "sd-ask-go",
      "sd-note",
      "sd-card",
      "sd-score",
      "sd-rows",
      "sd-ans",
      "sd-table",
      "sd-caps",
      "sd-lb",
      "sd-chips",
      "sd-prose",
    ]) {
      expect(css, cls).toMatch(new RegExp(`\\.${cls}[\\s,.:{\\[>]`));
    }
  });

  it("has no version to keep in step: the network links one address", () => {
    expect(css.split("\n")[0]).toMatch(/^\/\* surfingdog\.ai shell\.css: /);
    expect(read("src/lib/shell.ts")).not.toMatch(/SHELL_VERSION|SHELL_SHA256/);
  });

  it("loads the very fonts the site's pages load, so they are fetched once", () => {
    const layout = read("src/layouts/Layout.astro");
    expect(layout).not.toMatch(/import\s+["']@fontsource/);
    expect(layout).toMatch(/<style is:inline set:html=\{fonts\}><\/style>/);
    const faces = fontFaceCss(dir);
    for (const m of faces.matchAll(/url\(\/fonts\/([^)]+)\)/g)) expect(css).toContain(`url(/fonts/${m[1]})`);
  });
});

/**
 * Every declaration of a stylesheet, keyed by where (the at-rules around it, layers left out) and
 * by selector, one key per selector of a list, with :global() unwrapped. A later declaration of the
 * same property in the same place wins, as in the cascade.
 */
function rules(css: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const stack: string[] = [];
  let buf = "";
  const flush = () => {
    const m = buf.trim().match(/^([a-z-]+)\s*:\s*([\s\S]+)$/);
    const top = stack.at(-1);
    if (m?.[1] && m[2] && top && !top.startsWith("@")) {
      const where = stack
        .slice(0, -1)
        .filter((x) => !x.startsWith("@layer"))
        .join(" > ");
      for (const sel of top.split(/,(?![^(]*\))/)) {
        const key = `${where} | ${sel.trim().replace(/:global\(([^)]*)\)/g, "$1")}`.trim();
        if (!out.has(key)) out.set(key, new Map());
        out.get(key)?.set(m[1], m[2].trim().replace(/\s+/g, " "));
      }
    }
    buf = "";
  };
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (ch === "{") {
      stack.push(buf.trim().replace(/\s+/g, " "));
      buf = "";
    } else if (ch === "}") {
      flush();
      stack.pop();
    } else if (ch === ";") {
      flush();
    } else {
      buf += ch;
    }
  }
  return out;
}

/** One spelling for values that mean the same: the pill radius, the easing, a box's four sides. */
function same(value: string): string {
  const v = value
    .replace(/\bvar\(--ease\)/g, "var(--ease-out-soft)")
    .replace(/\b9999px\b/g, "var(--radius-pill)")
    .replace(/\s+/g, " ")
    .trim();
  const [top, right, bottom, left, ...rest] = v.split(" ");
  if (top !== undefined && left !== undefined && rest.length === 0 && right === left) {
    if (top === bottom) return top === right ? top : `${top} ${right}`;
    return `${top} ${right} ${bottom}`;
  }
  return v;
}

/**
 * The components shell/parts.css copies, with their classes as parts.css names them. A rule of the
 * component whose classes are all named here must be in parts.css (under the same selector, or the
 * one `as` gives) with every declaration it has, at the same value, unless it is listed under `not`
 * with the reason it differs on the network.
 */
const COPIES: {
  file: string;
  names: Record<string, string>;
  as?: Record<string, string>;
  not: Record<string, string[] | "rule">;
}[] = [
  {
    file: "src/components/Nav.astro",
    names: {
      "nav-shell": "sd-nav",
      navbar: "sd-bar",
      side: "sd-side",
      lead: "sd-lead",
      actions: "sd-actions",
      brand: "sd-brand",
      mark: "sd-mark",
      word: "sd-word",
      where: "sd-where",
      "where-slash": "sd-where-slash",
      links: "sd-links",
      lbl: "sd-lbl",
      tt: "sd-tt-btn",
      menu: "sd-menu > summary",
      bars: "sd-bars",
      tick: "sd-tick",
      out: "sd-out",
      rule: "sd-sheet .sd-sep",
      "theme-row": "sd-theme-row",
      "theme-label": "sd-theme-label",
      seg: "sd-seg",
    },
    as: { "| .sd-brand .sd-mark": "| .sd-mark" },
    not: {
      // The bar is not fixed over a hero and has no scrolled state (no script to see the scroll).
      "| .sd-nav": "rule",
      "| .sd-bar": "rule",
      // The site's menu is a button in the bar; the network's is a <details> laid over the bar,
      // open by [open] rather than aria-expanded.
      "| .sd-menu > summary": ["display", "flex", "background"],
      "@media (max-width: 899px) | .sd-menu > summary": "rule",
      '| .sd-menu > summary[aria-expanded="true"] .sd-bars i:first-child': "rule",
      '| .sd-menu > summary[aria-expanded="true"] .sd-bars i:last-child': "rule",
      // The sheet's own rule: the network's sits under the bar without the site's animation.
      "| .sd-actions": ["gap"],
      // Day and night are two buttons on the network, not two icons in one turned by a script; on a
      // phone the whole form moves into the menu.
      "| .sd-tt-btn svg": ["transition"],
      '| .sd-tt-btn[data-spun="1"] svg': "rule",
      "@media (max-width: 560px) | .sd-bar .sd-tt-btn": "rule",
      "| .sd-tt-btn .i-sun": "rule",
      '@media (prefers-color-scheme: dark) | :root:not([data-theme="light"]) .sd-tt-btn .i-sun': "rule",
      '@media (prefers-color-scheme: dark) | :root:not([data-theme="light"]) .sd-tt-btn .i-moon': "rule",
      '| :root[data-theme="dark"] .sd-tt-btn .i-sun': "rule",
      '| :root[data-theme="dark"] .sd-tt-btn .i-moon': "rule",
      // Drawn once when a page arrives on the site; a network page is a fresh load each time.
      '| .sd-links a[aria-current="page"] .sd-lbl::after': ["transform-origin", "animation"],
      '@media (prefers-reduced-motion: reduce) | .sd-links a[aria-current="page"] .sd-lbl::after': "rule",
      // The theme row is a form whose top margin is the site's, written with its own margin reset.
      "| .sd-theme-row": ["margin-top"],
      // On a phone the network keeps the menu's room only (the site's .side keeps half the bar).
      "@media (max-width: 899px) | .sd-bar": ["--sd-none"],
    },
  },
  {
    file: "src/components/Footer.astro",
    names: {
      footer: "sd-foot",
      "brand-line": "u-line",
      top: "sd-foot-top",
      identity: "sd-identity",
      fbrand: "sd-fbrand",
      mark: "sd-mark",
      say: "sd-say",
      groups: "sd-groups",
      group: "sd-group",
      ghead: "sd-ghead",
      links: "sd-flinks",
      base: "sd-foot-base",
      who: "sd-who",
      licence: "sd-licence",
    },
    // The mark is one rule for both; the logo is drawn from shell.css itself (no image from this
    // host on the network's), as the footer line's ::before.
    as: { "| .sd-fbrand .sd-mark": "| .sd-mark", "| .sd-who img": "| .sd-who::before" },
    not: {
      // Written as .sd-foot .u-line, the line inside the footer.
      "| .u-line": "rule",
    },
  },
  {
    file: "src/components/AskBox.astro",
    names: {
      ask: "sd-ask",
      "ask-lg": "sd-ask",
      "ask-lens": "sd-ask-lens",
      "ask-input": "sd-ask-input",
      "ask-go": "sd-ask-go",
    },
    not: {
      // The network's buttons keep their words ("Check", "Stop crawling this site"), so the button is
      // a pill with a label and the arrow after it rather than the home page's round arrow.
      "| .sd-ask-go": ["width", "justify-content", "background", "color", "transition"],
      "| .sd-ask-go:hover, .sd-ask-go:focus-visible": "rule",
      "| .sd-ask-go:hover": "rule",
      "| .sd-ask-go:focus-visible": ["color"],
      "| .sd-ask-go svg": ["width", "height"],
      // The network's box is a text field, never a search field with a clear button.
      "| .sd-ask-input::-webkit-search-cancel-button": "rule",
    },
  },
  {
    file: "src/components/AgentCard.astro",
    names: {
      ac: "",
      "ac-score": "sd-score",
      "ac-num": "sd-num",
      "ac-of": "sd-of",
      "ac-grade": "sd-grade",
      "ac-what": "sd-what",
      "ac-track": "sd-track",
      "ac-rows": "sd-rows",
      "ac-row": "sd-row",
      "ac-ans": "sd-ans",
      "ac-yes": "sd-yes",
      "ac-partly": "sd-partly",
      "ac-no": "sd-no",
      "ac-na": "sd-na",
      "ac-door": "sd-door",
      dot: "dot",
    },
    not: {
      // The result page's rows are questions in words ("Can an agent book here?"), not the card's
      // one-word labels, so they get a column of their own and the card's body type.
      "| .sd-row": ["grid-template-columns", "gap", "align-items", "padding"],
      "| .sd-row dt": "rule",
      "| .sd-row dd": ["align-items"],
      // A grade can be two characters ("A+"), so the box grows from 26px rather than being 26px.
      "| .sd-grade": ["width"],
      // The bar's width with a default, for a result with no score.
      "| .sd-track i": ["width"],
    },
  },
];

describe("shell/parts.css copies the site's components", () => {
  const parts = rules(read("shell/parts.css"));
  for (const copy of COPIES) {
    it(`carries the declarations of ${copy.file.split("/").at(-1)}`, () => {
      const src = read(copy.file);
      const style = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
      const problems: string[] = [];
      let compared = 0;
      for (const [key, decls] of rules(style)) {
        const cut = key.indexOf("| ");
        const where = key.slice(0, cut).trim();
        const selector = key.slice(cut + 2);
        const classes = [...selector.matchAll(/\.([a-z][\w-]*)/g)].map((m) => m[1] ?? "");
        if (classes.length === 0 || !classes.every((c) => c in copy.names)) continue;
        const named = selector
          .replace(/\.([a-z][\w-]*)/g, (_m, c: string) => (copy.names[c] ? `.${copy.names[c]}` : ""))
          .replace(/\s+/g, " ")
          .trim();
        if (!named) continue;
        const at = `${where} | ${named}`.trim();
        const skip = copy.not[at];
        if (skip === "rule") continue;
        const theirs = parts.get(copy.as?.[at] ?? at);
        if (!theirs) {
          problems.push(`${at}: not in parts.css`);
          continue;
        }
        for (const [prop, value] of decls) {
          if (skip?.includes(prop)) continue;
          compared++;
          const got = theirs.get(prop);
          if (got === undefined || same(got) !== same(value)) {
            problems.push(`${at} { ${prop}: ${value} } but parts.css has ${got ?? "nothing"}`);
          }
        }
      }
      expect(problems).toEqual([]);
      expect(compared).toBeGreaterThan(20);
    });
  }
});
