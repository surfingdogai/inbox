/**
 * Builds the social card at public/art/og-flow.png — the picture Slack,
 * WhatsApp, LinkedIn and X show when someone shares a link to the site.
 *
 *   node scripts/og-card.mjs
 *
 * The drawing is not redrawn here. It is the hero's own still frame: the
 * server-rendered SVG inside HeroFlow.astro, with that component's own style
 * block, rendered in the night theme. So the card shows exactly what the home
 * page shows — several AI agents sending one business typed work, the rules
 * and the owner's AI answering, the connected systems kept in step — and it
 * cannot drift away from the hero, because it is the hero.
 *
 * Fonts are inlined as data URIs: Chrome will not load a font across file://.
 *
 * Run it again whenever the headline or the hero changes. Give the file a NEW
 * NAME when the picture changes — /art/* is cached for a day at the edge and
 * cannot be purged, so an overwrite keeps showing the old card.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, "..");
const repo = path.resolve(site, "../..");
const out = path.join(site, "public/art/og-flow.png");

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
});
if (!CHROME) throw new Error("no Chrome or Chromium found; install one or render the card by hand");

const font = (file) => `data:font/woff2;base64,${readFileSync(path.join(repo, file)).toString("base64")}`;
const jakarta = font("packages/ui/dist/fonts/plus-jakarta-sans-latin-wght-normal.woff2");
const manrope = font("packages/ui/dist/fonts/manrope-latin-wght-normal.woff2");

/** The hero's still frame and the styles that draw it, taken from the component itself. */
const hero = readFileSync(path.join(site, "src/components/HeroFlow.astro"), "utf8");
const svg = hero.slice(
  hero.indexOf('<svg class="sd-seed"'),
  hero.indexOf("</svg>", hero.indexOf('<svg class="sd-seed"')) + 6,
);
const sdfCss = /<style[^>]*>([\s\S]*?)<\/style>/.exec(hero)[1];
/**
 * The component's own drawing machine, inlined. Chrome renders this card with
 * reduced motion forced on, and under that preference the machine steps itself
 * to a composed still frame — the arrangement the hero was designed to hold
 * when it must not move. So the card shows the typed rows, the rule strip and
 * the chip in flight, drawn by the same code that draws them on the page.
 */
const sdfJs = /<script[^>]*>([\s\S]*?)<\/script>/.exec(hero)[1];
if (!svg.startsWith("<svg") || sdfCss.length < 1000 || sdfJs.length < 1000) {
  throw new Error("HeroFlow.astro no longer has a still frame, a style block and its script");
}

/** The card's words. The headline is the one on the home page, deliberately. */
const EYEBROW = "Surfing Dog Inbox · open source";
const TITLE = "Get AI bookings, orders and messages.";
const SUB = "One inbox that takes them in, applies your rules and answers for you.";
const TAG = "Automated AI relations";

const html = `<!doctype html>
<html data-theme="dark"><head><meta charset="utf-8">
<style>
  @font-face { font-family: "Plus Jakarta Sans Variable"; src: url(${jakarta}) format("woff2"); font-weight: 200 800; }
  @font-face { font-family: "Manrope Variable"; src: url(${manrope}) format("woff2"); font-weight: 200 800; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  body {
    background:
      radial-gradient(900px 620px at 64% 48%, #1c2352 0%, transparent 68%),
      linear-gradient(140deg, #090a1c 0%, #101637 55%, #161d44 100%);
    color: #f2f1ff;
    font-family: "Manrope Variable", sans-serif;
    -webkit-font-smoothing: antialiased;
    display: grid; grid-template-columns: 516px 1fr; align-items: center;
    overflow: hidden;
  }
  .copy { padding: 0 16px 0 68px; }
  .eyebrow {
    font-size: 15px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
    color: #ab95ff; margin-bottom: 20px;
  }
  h1 {
    font-family: "Plus Jakarta Sans Variable", sans-serif; font-weight: 600; font-size: 50px;
    line-height: 1.08; letter-spacing: -0.022em;
  }
  .sub { margin-top: 22px; font-size: 19px; line-height: 1.45; color: #b9bce0; font-weight: 500; }
  .foot { margin-top: 30px; display: flex; align-items: center; gap: 13px; }
  .url { font-family: "Plus Jakarta Sans Variable", sans-serif; font-weight: 600; font-size: 21px; }
  .dot { width: 5px; height: 5px; border-radius: 50%; background: #9a9dc4; opacity: 0.6; }
  .tag { font-size: 16px; font-weight: 600; color: #9a9dc4; }
  /* The whole drawing, never cropped: clipping it takes the bottom off the
     business card, which is the one thing the picture is about. Sized so the
     YOUR SYSTEMS caption — the widest thing in it — keeps a margin from the
     card's right edge. */
  .art { width: 656px; height: 492px; justify-self: center; }
  .sdf { width: 100%; }
  .sdf svg { width: 100%; height: auto; display: block; }
${sdfCss}
</style></head>
<body>
  <div class="copy">
    <p class="eyebrow">${EYEBROW}</p>
    <h1>${TITLE}</h1>
    <p class="sub">${SUB}</p>
    <div class="foot">
      <span class="url">surfingdog.ai</span><i class="dot"></i><span class="tag">${TAG}</span>
    </div>
  </div>
  <div class="art"><figure class="sdf">${svg}</figure></div>
  <script>${sdfJs}</script>
</body></html>`;

const work = mkdtempSync(path.join(tmpdir(), "og-"));
const page = path.join(work, "card.html");
writeFileSync(page, html);
execFileSync(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    // The still composition the hero holds for anyone who asked not to be moved.
    "--force-prefers-reduced-motion",
    // Let the machine mount and settle before the shutter.
    "--virtual-time-budget=3000",
    `--screenshot=${out}`,
    "--window-size=1200,630",
    `file://${page}`,
  ],
  { stdio: ["ignore", "ignore", "ignore"] },
);
const bytes = readFileSync(out);
if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
  throw new Error("the card is not a PNG; something rendered it as another format");
}
console.log(`og-flow.png — 1200×630, ${Math.round(bytes.length / 1024)} KB`);
