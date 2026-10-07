import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildShell, SHELL_SHA256, SHELL_VERSION, shellFonts, shellHash, siteDir } from "../src/lib/shell";

/**
 * /shell.css is how the network's public pages wear the site's look (src/lib/shell.ts). These tests
 * hold it to the site: every design token in shell.css is the one site.css and the design system
 * declare, in the same theme block; the fonts it names are published; and the version the network
 * links (?v=SHELL_VERSION) changes whenever what it builds does.
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

  it("is the version the network links", () => {
    expect(css.split("\n")[0]).toContain(`shell.css v${SHELL_VERSION}`);
    const hash = shellHash(css);
    expect(
      hash,
      `shell.css changed: raise SHELL_VERSION in src/lib/shell.ts, set SHELL_SHA256 to ${hash}, and raise shellVersion in the network to match`,
    ).toBe(SHELL_SHA256);
  });
});
