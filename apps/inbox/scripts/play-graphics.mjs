#!/usr/bin/env node
/**
 * Google Play's graphics for the phone app, into apps/mobile/store/play/graphics:
 *
 *   phone/light/01-inbox.png … 06-connect.png   1080 × 1920, the Play copy's own screens, light
 *   phone/dark/01-inbox.png … 06-connect.png    the same, dark
 *   icon-512.png                                the launcher icon, as Play asks for it
 *   feature-graphic.png                         1024 × 500, the mark and one line on the app's ground
 *
 * The screenshots are real screens, never drawn: the Play copy's screens (`vite build --mode play`) in
 * Chrome at 360 × 640 and device pixel ratio 3, opened on "Try the demo". The demo shop is started
 * here: this server with INBOX_DEMO=1 on a temporary database, which seeds itself as
 * demo.surfingdog.ai does every night, and the browser's requests to https://demo.surfingdog.ai go to
 * it. Times and dates in the screens are the run's own.
 *
 * The icon is the launcher's adaptive icon (android/app/src/main/res/drawable/ic_launcher_foreground.xml
 * on its #f6f5ff ground), drawn from the same mark (public/favicon.svg) with the same placement, and
 * cropped to the part a launcher shows; Play rounds the corners itself.
 *
 *   pnpm --filter @surfingdog/inbox play-graphics
 *
 * Needs Google Chrome (playwright-core drives it through channel "chrome") and ImageMagick (`magick`),
 * which takes the alpha channel off the screenshots and the feature graphic, as Play asks.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(app, "../..");
const mobile = path.join(repo, "apps/mobile");
const dist = path.join(mobile, "dist");
const out = path.join(mobile, "store/play/graphics");
const tsx = path.join(app, "node_modules", ".bin", "tsx");
const DEMO = "https://demo.surfingdog.ai";
const GROUND = "#f6f5ff";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A PNG as Play takes it: 24-bit with no alpha channel, or 32-bit for the icon. */
function flatten(src, file, keepAlpha = false) {
  const args = keepAlpha
    ? [src, "-strip", `PNG32:${file}`]
    : [src, "-background", GROUND, "-alpha", "remove", "-alpha", "off", "-strip", `PNG24:${file}`];
  const r = spawnSync("magick", args, { stdio: "inherit" });
  if (r.error || r.status !== 0) throw new Error(`magick failed for ${file}: is ImageMagick installed?`);
}

// ---- the Play copy's screens, served as the app serves them ----

function buildPlayScreens() {
  const r = spawnSync("pnpm", ["--filter", "@surfingdog/mobile", "build:play"], { cwd: repo, stdio: "inherit" });
  if (r.status !== 0) throw new Error("build:play failed");
}

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveScreens() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      const file = path.join(dist, p === "/" ? "index.html" : p);
      if (!file.startsWith(dist)) {
        res.writeHead(404).end();
        return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ---- the demo shop, as demo.surfingdog.ai runs it ----

async function startDemo(tmp) {
  const port = 8890 + Math.floor(Math.random() * 100);
  // Only what the server needs: nothing of this shell's mail or model keys reaches the demo.
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    INBOX_DB: path.join(tmp, "demo.db"),
    INBOX_STATIC: path.join(tmp, "no-client"),
    PORT: String(port),
    HOST: "127.0.0.1",
    INBOX_PUBLIC_URL: DEMO,
    INBOX_OWNER_EMAIL: "owner@example.com",
    INBOX_DEMO: "1",
    INBOX_PUSH_RELAY: "off",
  };
  const server = spawn(tsx, ["src/node.ts"], { cwd: app, env, stdio: ["ignore", "pipe", "inherit"] });
  let log = "";
  server.stdout.on("data", (chunk) => {
    log += String(chunk);
  });
  await waitFor(() => log.includes("listening on"), 60_000, "the demo shop to start");
  return { server, base: `http://127.0.0.1:${port}` };
}

// ---- the screenshots ----

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await sleep(500);
}

async function screenshots(browser, screens, demo, tmp) {
  for (const colorScheme of ["light", "dark"]) {
    const dir = path.join(out, "phone", colorScheme);
    await mkdir(dir, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: 360, height: 640 },
      deviceScaleFactor: 3,
      colorScheme,
      locale: "en-GB",
      timezoneId: "Europe/Lisbon",
      reducedMotion: "reduce",
      isMobile: true,
      hasTouch: true,
    });
    // The app asks the demo shop; here the demo shop is the one started above. On the phone its fetch is
    // native (CapacitorHttp), so the browser alone needs the CORS header.
    await context.route(`${DEMO}/**`, async (route) => {
      const u = new URL(route.request().url());
      const r = await route.fetch({ url: `${demo}${u.pathname}${u.search}` });
      await route.fulfill({ response: r, headers: { ...r.headers(), "access-control-allow-origin": "*" } });
    });
    const page = await context.newPage();
    const shot = async (name) => {
      await settle(page);
      const raw = path.join(tmp, `${colorScheme}-${name}.png`);
      await page.screenshot({ path: raw });
      flatten(raw, path.join(dir, `${name}.png`));
      console.log(`wrote ${path.relative(repo, path.join(dir, `${name}.png`))}`);
    };
    const openDemo = async () => {
      await page.goto(screens, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Try the demo" }).click();
      await page.locator(".demo-line").waitFor();
      await page.locator("main .card").first().waitFor();
    };

    // The first screen of a phone with nothing connected.
    await page.goto(screens, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Scan the code" }).waitFor();
    const connect = path.join(tmp, `${colorScheme}-connect.png`);
    await settle(page);
    await page.screenshot({ path: connect });

    // The demo inbox: what needs you.
    await openDemo();
    await shot("01-inbox");

    // The booking request that needs you, with Accept, Propose another time and Decline.
    await page
      .locator("main .card")
      .filter({ has: page.locator(".chip.booking") })
      .first()
      .click();
    await page.getByRole("button", { name: "Propose another time" }).waitFor();
    const when = (await page.locator(".facts > div", { hasText: "When" }).locator("span").nth(1).textContent()) ?? "";
    await shot("02-request");

    // Propose another time, on the day the customer asked for when the sheet offers it.
    await page.getByRole("button", { name: "Propose another time" }).click();
    await page.getByText(/^Free times for/).waitFor();
    const day = /^(\w+)\s+(\d+)\s+(\w+)/.exec(when);
    const pick = day ? page.getByRole("button", { name: new RegExp(`^${day[1]}\\s*${day[2]}\\s+${day[3]}$`) }) : null;
    if (pick && (await pick.count()) > 0) await pick.first().click();
    await shot("03-propose");

    // Today.
    await openDemo();
    await page.locator("nav.nav").getByRole("button", { name: "Today" }).click();
    await page.getByRole("heading", { name: "Today" }).waitFor();
    await shot("04-today");

    // Settings: what the phone is told about, quiet hours and the lock screen.
    await page.locator("nav.nav").getByRole("button", { name: "Settings" }).click();
    const tell = page.getByRole("heading", { name: "Tell me about" });
    await tell.waitFor();
    await tell.evaluate((h) => {
      h.scrollIntoView({ block: "start" });
      const body = h.closest(".body");
      if (body) body.scrollTop -= 8;
    });
    await shot("05-settings");

    flatten(connect, path.join(dir, "06-connect.png"));
    console.log(`wrote ${path.relative(repo, path.join(dir, "06-connect.png"))}`);
    await context.close();
  }
}

// ---- the icon and the feature graphic ----

async function mark() {
  const svg = await readFile(path.join(app, "public/favicon.svg"), "utf8");
  // The drawing inside the favicon's <svg>, without its title.
  return svg
    .slice(svg.indexOf(">", svg.indexOf("<svg")) + 1, svg.lastIndexOf("</svg>"))
    .replace(/<title>[\s\S]*?<\/title>/, "");
}

async function icon(browser, tmp) {
  // ic_launcher_foreground.xml: the 64-unit mark scaled 0.714 and moved (31.14, 31.86) in a 108 dp layer;
  // a launcher shows the middle 72 dp of it.
  const html = `<!doctype html><html><head><style>html,body{margin:0;width:512px;height:512px}</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="18 18 72 72">
  <rect x="0" y="0" width="108" height="108" fill="${GROUND}"/>
  <g transform="translate(31.14 31.86) scale(0.714)">${await mark()}</g>
</svg></body></html>`;
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  const raw = path.join(tmp, "icon.png");
  await page.screenshot({ path: raw });
  await page.close();
  flatten(raw, path.join(out, "icon-512.png"), true);
  console.log(`wrote ${path.relative(repo, path.join(out, "icon-512.png"))}`);
}

async function featureGraphic(browser, tmp) {
  const font = async (pkg, file) =>
    `data:font/woff2;base64,${(await readFile(path.join(mobile, "node_modules/@fontsource-variable", pkg, "files", file))).toString("base64")}`;
  const jakarta = await font("plus-jakarta-sans", "plus-jakarta-sans-latin-wght-normal.woff2");
  const manrope = await font("manrope", "manrope-latin-wght-normal.woff2");
  // The listing's own words: the short description's first sentence and the app's name. Kept clear of
  // the edges, where Play may lay a button or crop.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: "Jakarta"; src: url(${jakarta}) format("woff2"); font-weight: 200 800; }
  @font-face { font-family: "Manrope"; src: url(${manrope}) format("woff2"); font-weight: 200 800; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1024px; height: 500px; }
  body {
    background: radial-gradient(560px 380px at 30% 50%, #ffffff 0%, transparent 70%), ${GROUND};
    color: #14163c; font-family: "Manrope", sans-serif; -webkit-font-smoothing: antialiased;
    display: flex; align-items: center; justify-content: center; gap: 56px;
  }
  svg { width: 196px; height: 196px; flex: none; }
  .name { font-family: "Jakarta", sans-serif; font-weight: 500; font-size: 22px; letter-spacing: 0.02em; color: #474a75; }
  h1 { margin-top: 14px; font-family: "Jakarta", sans-serif; font-weight: 600; font-size: 46px; line-height: 1.12; letter-spacing: -0.02em; max-width: 560px; }
  .site { margin-top: 26px; font-size: 19px; font-weight: 500; color: #6b6e96; letter-spacing: 0.01em; }
</style></head><body>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 4 64 52">${await mark()}</svg>
  <div>
    <p class="name">Surfing Dog Inbox</p>
    <h1>New requests on your phone, answered from there.</h1>
    <p class="site">surfingdog.ai</p>
  </div>
</body></html>`;
  const page = await browser.newPage({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  const raw = path.join(tmp, "feature.png");
  await page.screenshot({ path: raw });
  await page.close();
  flatten(raw, path.join(out, "feature-graphic.png"));
  console.log(`wrote ${path.relative(repo, path.join(out, "feature-graphic.png"))}`);
}

async function main() {
  buildPlayScreens();
  const channel = JSON.parse(await readFile(path.join(dist, "channel.json"), "utf8"));
  if (channel.channel !== "play") throw new Error("dist is not the Play copy's screens");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sdi-play-"));
  const screens = await serveScreens();
  let demo;
  let browser;
  try {
    demo = await startDemo(tmp);
    browser = await chromium.launch({ channel: "chrome" });
    await mkdir(out, { recursive: true });
    await screenshots(browser, `http://127.0.0.1:${screens.address().port}/`, demo.base, tmp);
    await icon(browser, tmp);
    await featureGraphic(browser, tmp);
  } finally {
    await browser?.close();
    demo?.server.kill();
    screens.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

await main();
