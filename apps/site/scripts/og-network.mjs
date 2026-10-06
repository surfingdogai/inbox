/**
 * Builds the home page's social card at public/art/og-network-v1.png: the picture Slack, WhatsApp,
 * LinkedIn and X show when someone shares surfingdog.ai.
 *
 *   pnpm --filter @surfingdog/site build && node scripts/og-network.mjs
 *
 * The drawing is not redrawn here. It is the home hero's own still frame: the server-rendered SVG
 * inside HeroSearch.astro, with that component's own style block, in the night theme. That frame
 * needs no script (the component ships it composed), so the card cannot drift from the hero. The
 * brand mark is lifted from the built home page's nav, and the colours are the design tokens
 * themselves, read from the two stylesheets that define them, the way scripts/og-post.mjs does.
 *
 * /art/* is cached for a day at the edge and cannot be purged, so an existing card is never
 * overwritten without --force: when the picture changes, give it a NEW name (and change
 * src/pages/index.astro and src/layouts/Layout.astro to match).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, "..");
const repo = path.resolve(site, "../..");
const out = path.join(site, "public/art/og-network-v1.png");
if (existsSync(out) && !process.argv.includes("--force")) {
  throw new Error("og-network-v1.png exists and /art is cached for a day: give it a new name, or pass --force");
}

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => existsSync(p));
if (!CHROME) throw new Error("no Chrome or Chromium found; install one or render the card by hand");

const font = (pkg, file) =>
  `data:font/woff2;base64,${readFileSync(path.join(site, "node_modules/@fontsource-variable", pkg, "files", file)).toString("base64")}`;
const jakarta = font("plus-jakarta-sans", "plus-jakarta-sans-latin-wght-normal.woff2");
const manrope = font("manrope", "manrope-latin-wght-normal.woff2");

/** Every :root / [data-theme] block's custom properties; the card sets data-theme="dark". */
function tokens(file) {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const kept = [];
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const s = sel.split(";").pop().trim().replace(/\s+/g, " ");
    const isTheme = s === "@theme inline" || s === "@theme";
    if (!isTheme && (!/^(:root|\[data-theme)/.test(s) || s.includes(":not("))) continue;
    const decls = body
      .split(";")
      .map((d) => d.trim().replace(/\s+/g, " "))
      .filter((d) => /^(--[\w-]+|color-scheme)\s*:/.test(d));
    if (decls.length) kept.push(`${isTheme ? ":root" : s} { ${decls.join("; ")}; }`);
  }
  return kept.join("\n");
}
const TOKENS = [
  tokens(path.join(repo, "packages/ui/src/index.css")),
  tokens(path.join(site, "src/styles/site.css")),
].join("\n");

const comp = readFileSync(path.join(site, "src/components/HeroSearch.astro"), "utf8");
const start = comp.indexOf('<figure\n  class="sdh"');
const figure = comp.slice(start, comp.indexOf("</figure>", start) + "</figure>".length);
const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(comp)?.[1];
if (start < 0 || !figure.includes("<svg") || !css) {
  throw new Error("HeroSearch.astro no longer has its figure and style block");
}

const built = path.join(site, "dist/index.html");
if (!existsSync(built)) throw new Error("build the site first: pnpm --filter @surfingdog/site build");
const mark = /<a\b[^>]*class="brand\b[^"]*"[^>]*>\s*(<svg\b[\s\S]*?<\/svg>)/.exec(readFileSync(built, "utf8"))?.[1];
if (!mark) throw new Error("the built home page has no brand mark in its nav");

/** The card's words: the home page's own. */
const EYEBROW = "Surfing Dog · open network";
const TITLE = "Open doors to the agentic internet.";
const SUB = "An open directory your AI can search.";

const html = `<!doctype html>
<html data-theme="dark" lang="en"><head><meta charset="utf-8">
<style>
  @font-face { font-family: "Plus Jakarta Sans Variable"; src: url(${jakarta}) format("woff2"); font-weight: 200 800; }
  @font-face { font-family: "Manrope Variable"; src: url(${manrope}) format("woff2"); font-weight: 200 800; }
${TOKENS}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  body {
    position: relative; overflow: hidden;
    background: var(--ground); color: var(--ink);
    font-family: var(--font-sans); -webkit-font-smoothing: antialiased;
  }
  .sky { position: absolute; inset: 0; overflow: hidden; }
  .sky i { position: absolute; display: block; border-radius: 9999px; filter: blur(72px); opacity: var(--field-alpha); }
  .sky .f1 { width: 52vw; height: 52vw; left: -14vw; top: -18vw; background: var(--sky-1); }
  .sky .f2 { width: 48vw; height: 48vw; right: -12vw; top: 6vh; background: var(--sky-2); }
  .sky .f3 { width: 56vw; height: 56vw; right: -10vw; bottom: -24vw; background: var(--sky-3); }
  .card {
    position: relative; height: 630px; padding: 64px 40px 64px 64px;
    display: grid; grid-template-columns: 430px 642px; column-gap: 24px; align-items: center;
  }
  .brand { display: flex; align-items: center; gap: 12px; font-family: var(--font-display); font-weight: 600; font-size: 24px; }
  .brand svg { width: 44px; height: 22px; display: block; flex: none; }
  .eyebrow { margin-top: 44px; font-size: 15px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); }
  h1 { margin-top: 14px; font-family: var(--font-display); font-weight: 600; font-size: 48px; line-height: 1.1; letter-spacing: -0.022em; }
  .line { display: grid; grid-template-columns: 44px 1fr; gap: 16px; align-items: center; margin-top: 30px; font-size: 22px; line-height: 1.35; font-weight: 600; }
  .line i { display: block; height: 2px; border-radius: 9px; background: linear-gradient(90deg, var(--flamingo), var(--tangerine) 34%, var(--lagoon) 68%, var(--violet)); }
  .art { width: 642px; }
${css}
</style></head>
<body>
  <div class="sky" aria-hidden="true"><i class="f1"></i><i class="f2"></i><i class="f3"></i></div>
  <main class="card">
    <div>
      <div class="brand">${mark}<span>Surfing Dog</span></div>
      <p class="eyebrow">${EYEBROW}</p>
      <h1>${TITLE}</h1>
      <p class="line"><i></i><span>${SUB}</span></p>
    </div>
    <div class="art">${figure}</div>
  </main>
</body></html>`;

const work = mkdtempSync(path.join(tmpdir(), "og-network-"));
const page = path.join(work, "card.html");
writeFileSync(page, html);
try {
  execFileSync(
    CHROME,
    [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--force-prefers-reduced-motion",
      "--virtual-time-budget=3000",
      `--screenshot=${out}`,
      "--window-size=1200,630",
      `file://${page}`,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
const bytes = readFileSync(out);
if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("the card is not a PNG");
console.log(`og-network-v1.png — 1200×630, ${Math.round(bytes.length / 1024)} KB`);
