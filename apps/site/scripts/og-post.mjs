/**
 * Builds each blog post's social card: the picture Slack, WhatsApp, LinkedIn and X show when
 * someone shares a link to the post. One card per post, 1200×630, in public/art.
 *
 *   node scripts/og-post.mjs                          every post
 *   node scripts/og-post.mjs receipts-not-reviews     just these posts
 *   node scripts/og-post.mjs --force …                replace a card that already exists
 *
 * It reads the running site, so start it first (`pnpm dev`) and point SITE_URL at it when it is
 * not on Astro's default port: SITE_URL=http://127.0.0.1:4399 node scripts/og-post.mjs
 *
 * The drawing is not redrawn here, the same rule scripts/og-card.mjs keeps for the home card. It
 * is the post's own animated cover — the component its front matter names in `coverAnim`, through
 * src/components/covers.ts — at the composed rest frame that component ships as markup. The SVG
 * is lifted from the post page exactly as the server rendered it, and the component's own style
 * block and drawing machine come with it, run with reduced motion forced on, so the machine
 * settles on that same frame. Beside it: the post's title in the heading font, one short line
 * saying the idea in plain words (IDEAS below), and the brand mark lifted from the page's own nav.
 *
 * Night theme, as the home card is: the covers' accent colours read best against it at the sizes
 * a feed shows a card. Colours are the design tokens themselves, read from the two stylesheets
 * that define them. Fonts are inlined as data URIs: Chrome will not load a font across file://.
 *
 * The card is written where the post's front matter says (`og: /art/og-….png`), or to
 * og-<coverAnim>.png when it says nothing. /art/* is cached for a day at the edge and cannot be
 * purged, so an existing card is never overwritten without --force: when a picture changes, give
 * it a NEW name in the front matter and run this again. The same goes before a card is live: do
 * not open or curl its surfingdog.ai URL until it is deployed. The 404 is cached for a day too, at
 * whichever edge answered, and that edge is the one the person checking the share goes through.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, "..");
const repo = path.resolve(site, "../..");
const blog = path.join(site, "src/content/blog");
const SITE_URL = (process.env.SITE_URL || "http://localhost:4321").replace(/\/$/, "");

/**
 * The idea of each post, in one short line a person would say out loud. Not always the
 * description: that is written for search results, this for someone scrolling past a thumbnail.
 * \n is where the line breaks on the card, so a phrase never splits across two lines.
 */
const IDEAS = {
  "receipts-not-reviews": "Stars are easy to fake.\nA signed receipt is much harder.",
  "surfing-dog-inbox-is-open": "One inbox for people\nand AI agents. Open source.",
  "ready-for-the-flood-of-agent-enquiries": "Assistants now book for people.\nYour rules answer them.",
  "launch-your-own-network": "A directory AI agents search,\nranked by your own rules.",
};

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

/**
 * The design tokens, taken from the stylesheets that define them rather than copied: every block
 * whose selector is :root or [data-theme…] (and Tailwind's @theme, which is :root too), keeping only
 * the custom properties and color-scheme. The card sets data-theme="dark", so the night blocks win.
 * Media-query blocks are left out; the attribute blocks carry the same values.
 */
function tokens(file) {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const s = sel.split(";").pop().trim().replace(/\s+/g, " "); // not the @import lines before it
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
for (const t of ["--ground", "--ink", "--ink-2", "--violet", "--font-display", "--font-sans", "--sky-1"]) {
  if (!TOKENS.includes(`${t}:`)) throw new Error(`the design tokens no longer define ${t}`);
}

/** coverAnim name → component file, read from covers.ts so a new cover needs no change here. */
const coversTs = readFileSync(path.join(site, "src/components/covers.ts"), "utf8");
const files = Object.fromEntries(
  [...coversTs.matchAll(/import\s+(\w+)\s+from\s+"\.\/([\w.-]+\.astro)"/g)].map(([, name, file]) => [name, file]),
);
const covers = Object.fromEntries(
  [...coversTs.matchAll(/^\s*(\w+):\s*(\w+),?\s*$/gm)].filter(([, , c]) => files[c]).map(([, k, c]) => [k, files[c]]),
);

/** A post's front matter, flat `key: value` lines, quoted or not. */
function frontMatter(slug) {
  const src = readFileSync(path.join(blog, `${slug}.md`), "utf8");
  const fm = /^---\n([\s\S]*?)\n---/.exec(src);
  if (!fm) throw new Error(`${slug}.md has no front matter`);
  const data = {};
  for (const line of fm[1].split("\n")) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"')) v = JSON.parse(v);
    else if (v.startsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    data[m[1]] = v;
  }
  return data;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function card(slug, force) {
  const fm = frontMatter(slug);
  const idea = IDEAS[slug];
  if (!idea) throw new Error(`no idea line for ${slug}: add one to IDEAS in scripts/og-post.mjs`);
  const file = covers[fm.coverAnim];
  if (!file) throw new Error(`${slug} has no coverAnim that src/components/covers.ts knows (${fm.coverAnim})`);

  const target = fm.og || `/art/og-${fm.coverAnim}.png`;
  if (!/^\/art\/og-[\w-]+\.png$/.test(target)) throw new Error(`${slug}: og must look like /art/og-name.png`);
  const out = path.join(site, "public", target);
  if (existsSync(out) && !force) {
    throw new Error(
      `${target} exists and /art is cached for a day at the edge: give ${slug} a new og: name, or pass --force`,
    );
  }

  /* The component's style block and machine, and the class its figure carries. */
  const comp = readFileSync(path.join(site, "src/components", file), "utf8");
  const cls = /<figure\b[^>]*?\bclass="([\w-]+)/.exec(comp)?.[1];
  const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(comp)?.[1];
  const js = /<script[^>]*>([\s\S]*?)<\/script>/.exec(comp)?.[1] ?? "";
  if (!cls || !css) throw new Error(`${file} no longer has a figure with a class and a style block`);

  /* The figure as the server rendered it, and the brand mark from the page's own nav. */
  const url = `${SITE_URL}/blog/${slug}/`;
  let page;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    page = await res.text();
  } catch (err) {
    throw new Error(`could not read ${url} (${err.message}): start the site, or set SITE_URL`);
  }
  const open = new RegExp(`<figure\\b[^>]*\\bclass="${cls}(?:\\s[^"]*)?"[^>]*>`).exec(page);
  if (!open) throw new Error(`${url} has no <figure class="${cls}">`);
  const figure = page.slice(open.index, page.indexOf("</figure>", open.index) + "</figure>".length);
  if (!figure.includes("<svg")) throw new Error(`${url}: the cover figure has no drawing in it`);
  const mark = /<a\b[^>]*class="brand\b[^"]*"[^>]*>\s*(<svg\b[\s\S]*?<\/svg>)/.exec(page)?.[1];
  if (!mark) throw new Error(`${url} has no brand mark in its nav`);
  /* A title that already says the name gets the mark alone, so the card never reads the name twice. */
  const named = /surfing dog/i.test(fm.title);

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
  /* The site's own sky: the same four fields, the same blur, the night hues. */
  .ogp-sky { position: absolute; inset: 0; overflow: hidden; }
  .ogp-sky i { position: absolute; display: block; border-radius: 9999px; filter: blur(72px); opacity: var(--field-alpha); }
  .ogp-sky .f1 { width: 52vw; height: 52vw; left: -14vw; top: -18vw; background: var(--sky-1); }
  .ogp-sky .f2 { width: 48vw; height: 48vw; right: -12vw; top: 6vh; background: var(--sky-2); }
  .ogp-sky .f3 { width: 56vw; height: 56vw; right: -10vw; bottom: -24vw; background: var(--sky-3); }
  .ogp-sky .f4 { width: 38vw; height: 38vw; left: 4vw; bottom: -14vw; background: var(--sky-4); }
  /* Nothing drawn sits in the outer 40px a feed may crop. The words keep 64px; the drawing's box
     runs to 40px on the right because every cover keeps its own margin inside its viewBox. The
     drawing stays wider than 600px, so each cover shows its full composition, not its narrow step. */
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
    margin-top: 40px;
    font-family: var(--font-display); font-weight: 600; font-size: 58px; line-height: 1.08;
    letter-spacing: -0.022em; text-wrap: balance;
  }
  .ogp p {
    margin-top: 22px;
    font-size: 27px; line-height: 1.34; font-weight: 500; color: var(--ink-2); text-wrap: pretty;
  }
  .ogp-art { width: 660px; }
${css}
</style></head>
<body>
  <div class="ogp-sky" aria-hidden="true"><i class="f1"></i><i class="f2"></i><i class="f3"></i><i class="f4"></i></div>
  <main class="ogp">
    <div>
      <div class="ogp-brand">${mark}${named ? "" : "<span>Surfing Dog</span>"}</div>
      <h1>${esc(fm.title)}</h1>
      <p>${esc(idea).replace(/\n/g, "<br>")}</p>
    </div>
    <div class="ogp-art">${figure}</div>
  </main>
  <script type="module">${js}</script>
</body></html>`;

  const work = mkdtempSync(path.join(tmpdir(), "og-post-"));
  const pageFile = path.join(work, "card.html");
  writeFileSync(pageFile, html);
  try {
    execFileSync(
      CHROME,
      [
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        // The cover's composed frame: the one it holds for anyone who asked not to be moved.
        "--force-prefers-reduced-motion",
        // Let the fonts land and the machine settle before the shutter.
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
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error(`${target} is not a PNG; something rendered it as another format`);
  }
  const [w, h] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (w !== 1200 || h !== 630) throw new Error(`${target} came out ${w}×${h}, not 1200×630`);
  console.log(`${target.slice(5)} — ${slug}, ${Math.round(bytes.length / 1024)} KB`);
  if (!fm.og) console.log(`  add to ${slug}.md's front matter: og: ${target}`);
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const slugs = args.filter((a) => !a.startsWith("--"));
const all = readdirSync(blog)
  .filter((f) => /^[^_].*\.md$/.test(f))
  .map((f) => f.slice(0, -3));
let failed = 0;
for (const slug of slugs.length ? slugs : all) {
  try {
    await card(slug, force);
  } catch (err) {
    failed++;
    console.error(`${slug}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
