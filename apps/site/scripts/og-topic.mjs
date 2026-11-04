/**
 * Builds the social cards of the topic guides that have a cover of their own (src/lib/topics.ts,
 * `cover` and `og`): one card a page, 1200×630, at the path the page's own og:image names.
 *
 *   pnpm --filter @surfingdog/site build && node scripts/og-topic.mjs
 *   node scripts/og-topic.mjs how-ai-agents-pay       just these pages
 *   node scripts/og-topic.mjs --force …                replace cards that already exist
 *
 * It reads the built pages in dist/ (no server needed): every topic guide under /guides/, /es/guias/
 * and /pt/guias/ whose page carries a cover with an idea (TopicGuide.astro's .t-cover). It imports
 * nothing from src/, so it runs on any Node the site builds with.
 *
 * The rules are scripts/og-local.mjs's. The drawing is not redrawn here: it is the page's own
 * animated cover at the composed rest frame its component ships as markup, lifted from the built page
 * with the component's own style block and drawing machine, run with reduced motion forced on so the
 * machine settles on that frame. Beside it: the page's title (its <title>, without " · Surfing Dog"),
 * in the heading font, the cover's one idea, and the brand mark from the page's own nav. Night theme,
 * the design tokens read from the two stylesheets that define them, fonts inlined.
 *
 * /art/* is cached for a day at the edge and cannot be purged, so an existing card is never
 * overwritten without --force: when a picture changes, give it a new name (the topic's `og`, -v2) and
 * run this again. Do not open a card's surfingdog.ai address before it is deployed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, "..");
const repo = path.resolve(site, "../..");
const dist = path.join(site, "dist");
const components = path.join(site, "src/components");
/** Where the topic guides live once built, in each language they are written in. */
const DIRS = ["guides", "es/guias", "pt/guias"];

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => existsSync(p));
if (!CHROME) throw new Error("no Chrome or Chromium found; install one or render the cards by hand");

const font = (pkg, file) =>
  `data:font/woff2;base64,${readFileSync(path.join(site, "node_modules/@fontsource-variable", pkg, "files", file)).toString("base64")}`;
const jakarta = font("plus-jakarta-sans", "plus-jakarta-sans-latin-wght-normal.woff2");
const manrope = font("manrope", "manrope-latin-wght-normal.woff2");

/** The design tokens, as scripts/og-local.mjs reads them: :root and [data-theme] blocks only. */
function tokens(file) {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const s = sel.split(";").pop().trim().replace(/\s+/g, " ");
    const isTheme = s === "@theme inline" || s === "@theme";
    if (!isTheme && (!/^(:root|\[data-theme)/.test(s) || s.includes(":not("))) continue;
    const decls = body
      .split(";")
      .map((d) => d.trim().replace(/\s+/g, " "))
      .filter((d) => /^(--[\w-]+|color-scheme)\s*:/.test(d));
    if (decls.length) out.push(`${isTheme ? ":root" : s} { ${decls.join("; ")}; }`);
  }
  return out.join("\n");
}
const TOKENS = [
  tokens(path.join(repo, "packages/ui/src/index.css")),
  tokens(path.join(site, "src/styles/site.css")),
].join("\n");
for (const t of ["--ground", "--ink", "--ink-2", "--violet", "--palm", "--lagoon", "--font-display", "--sky-1"]) {
  if (!TOKENS.includes(`${t}:`)) throw new Error(`the design tokens no longer define ${t}`);
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s) =>
  s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** The component whose figure carries this class, read from its source. */
function componentOf(cls) {
  const file = readdirSync(components)
    .filter((f) => /^Cover\w+\.astro$/.test(f))
    .find((f) => readFileSync(path.join(components, f), "utf8").includes(`<figure class="${cls}"`));
  if (!file) throw new Error(`no component draws a figure of class ${cls}`);
  return readFileSync(path.join(components, file), "utf8");
}

/** Every built topic guide with a cover of its own: [its address, its built file]. */
function pages() {
  const out = [];
  for (const dir of DIRS) {
    const root = path.join(dist, dir);
    if (!existsSync(root)) continue;
    for (const slug of readdirSync(root)) {
      const file = path.join(root, slug, "index.html");
      if (existsSync(file) && readFileSync(file, "utf8").includes('<div class="t-cover'))
        out.push([`/${dir}/${slug}/`, slug, file]);
    }
  }
  return out;
}

function card(where, file, force) {
  const page = readFileSync(file, "utf8");
  const target = /<meta property="og:image" content="https:\/\/surfingdog\.ai(\/art\/og-[a-z0-9-]+\.png)">/.exec(
    page,
  )?.[1];
  if (!target || target === "/art/og-network-v1.png") throw new Error(`${where} names no card of its own`);
  const out = path.join(site, "public", target);
  if (existsSync(out) && !force) {
    throw new Error(`${target} exists and /art is cached for a day at the edge: give it a new name, or pass --force`);
  }
  const lang = /<html lang="([a-z]{2})"/.exec(page)?.[1] ?? "en";

  const wrap = /<div class="t-cover[^"]*" data-idea="([^"]*)"[^>]*>/.exec(page);
  if (!wrap) throw new Error(`${where} has no cover with an idea`);
  const idea = unesc(wrap[1]);
  const open = /<figure\b[^>]*\bclass="(c[a-z]{2})\b[^"]*"[^>]*>/.exec(page.slice(wrap.index));
  if (!open) throw new Error(`${where}: the cover has no figure`);
  const from = wrap.index + open.index;
  const figure = page.slice(from, page.indexOf("</figure>", from) + "</figure>".length);
  const comp = componentOf(open[1]);
  const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(comp)?.[1];
  const js = /<script[^>]*>([\s\S]*?)<\/script>/.exec(comp)?.[1] ?? "";
  if (!css) throw new Error(`${where}: its cover's component has no style block`);
  const title = unesc((/<title>([\s\S]*?)<\/title>/.exec(page)?.[1] ?? "").replace(/ · Surfing Dog$/, "").trim());
  if (!title) throw new Error(`${where} has no title`);
  const mark = /<a\b[^>]*class="brand\b[^"]*"[^>]*>\s*(<svg\b[\s\S]*?<\/svg>)/.exec(page)?.[1];
  if (!mark) throw new Error(`${where} has no brand mark in its nav`);
  // A long title gets a smaller size, never a smaller column.
  const size = title.length <= 34 ? 56 : title.length <= 44 ? 48 : title.length <= 56 ? 44 : 40;

  const html = `<!doctype html>
<html data-theme="dark" lang="${lang}"><head><meta charset="utf-8">
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
  .ogp-sky { position: absolute; inset: 0; overflow: hidden; }
  .ogp-sky i { position: absolute; display: block; border-radius: 9999px; filter: blur(72px); opacity: var(--field-alpha); }
  .ogp-sky .f1 { width: 52vw; height: 52vw; left: -14vw; top: -18vw; background: var(--sky-1); }
  .ogp-sky .f2 { width: 48vw; height: 48vw; right: -12vw; top: 6vh; background: var(--sky-2); }
  .ogp-sky .f3 { width: 56vw; height: 56vw; right: -10vw; bottom: -24vw; background: var(--sky-3); }
  .ogp-sky .f4 { width: 38vw; height: 38vw; left: 4vw; bottom: -14vw; background: var(--sky-4); }
  .ogp {
    position: relative; height: 630px; padding: 64px 40px 64px 64px;
    display: grid; grid-template-columns: 412px 660px; column-gap: 24px; align-items: center;
  }
  .ogp-brand {
    display: flex; align-items: center; gap: 12px;
    font-family: var(--font-display); font-weight: 600; font-size: 24px; letter-spacing: -0.005em;
  }
  .ogp-brand svg { width: 44px; height: 22px; display: block; flex: none; }
  .ogp h1 {
    margin-top: 36px;
    font-family: var(--font-display); font-weight: 600; font-size: ${size}px; line-height: 1.08;
    letter-spacing: -0.022em; text-wrap: balance; hyphens: manual;
  }
  .ogp p {
    margin-top: 22px;
    font-size: 25px; line-height: 1.34; font-weight: 500; color: var(--ink-2); text-wrap: pretty;
  }
  .ogp-art { width: 660px; }
${css}
</style></head>
<body>
  <div class="ogp-sky" aria-hidden="true"><i class="f1"></i><i class="f2"></i><i class="f3"></i><i class="f4"></i></div>
  <main class="ogp">
    <div>
      <div class="ogp-brand">${mark}<span>Surfing Dog</span></div>
      <h1>${esc(title)}</h1>
      <p>${esc(idea).replace(/\n/g, "<br>")}</p>
    </div>
    <div class="ogp-art">${figure}</div>
  </main>
  <script type="module">${js}</script>
</body></html>`;

  const work = mkdtempSync(path.join(tmpdir(), "og-topic-"));
  const pageFile = path.join(work, "card.html");
  writeFileSync(pageFile, html);
  try {
    execFileSync(
      CHROME,
      [
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        `--user-data-dir=${path.join(work, "profile")}`,
        "--force-device-scale-factor=1",
        "--force-prefers-reduced-motion",
        "--virtual-time-budget=3000",
        `--screenshot=${out}`,
        "--window-size=1200,630",
        `file://${pageFile}`,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const bytes = readFileSync(out);
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`${target} is not a PNG`);
  const [w, h] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (w !== 1200 || h !== 630) throw new Error(`${target} came out ${w}×${h}, not 1200×630`);
  console.log(`${target.slice(5)} — ${Math.round(bytes.length / 1024)} KB`);
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const named = args.filter((a) => !a.startsWith("--"));
const found = pages();
if (!found.length) throw new Error(`no built topic guide has a cover of its own in ${dist}: build the site first`);
for (const n of named)
  if (!found.some(([, slug]) => slug === n)) throw new Error(`no built topic guide "${n}" has a cover`);
let failed = 0;
for (const [where, slug, file] of found) {
  if (named.length && !named.includes(slug)) continue;
  try {
    card(where, file, force);
  } catch (err) {
    failed++;
    console.error(`${where}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
