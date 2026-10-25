#!/usr/bin/env node
/**
 * Screenshots for the site. Starts the Node server on a temporary database, seeds the showcase,
 * signs in through the real magic-link flow (the link is read from the server's own stdout), and
 * captures 1440×900 at 2× into apps/site/public/shots:
 *
 *   inbox-day.png, inbox-night.png   the three panes with the Today pane, names in the rows
 *   item-day.png                     a quote request with its quote, transitions and thread
 *   settings-day.png                 the settings page
 *   rules-day.png                    the rules screen
 *   availability-day.png             the opening hours screen
 *   spam-day.png, spam-night.png     Spam, with a pitch the filter put aside open: why it's here
 *   held-day.png                     Held, with a booking request that may be a customer's open
 *   spam-settings-day.png            Settings → Spam
 *
 * and, from the phone app's demo (its Vite server, 390×508 at 2×, the top of the screen):
 *
 *   phone-held.png, phone-held-night.png   a held booking request: why it's here, Let it in and Spam
 *
 *   pnpm --filter @surfingdog/inbox shots                 everything
 *   pnpm --filter @surfingdog/inbox shots phone           the phone's alone
 *   pnpm --filter @surfingdog/inbox shots spam held       those whose names start so
 *
 * Needs Google Chrome on this machine: playwright-core drives it through channel "chrome" and
 * downloads nothing.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(app, "../site/public/shots");
const tsx = path.join(app, "node_modules", ".bin", "tsx");
const port = 8790 + Math.floor(Math.random() * 100);
const base = `http://localhost:${port}`;
const email = "owner@oficinamare.pt";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function cli(args, env) {
  const r = spawnSync(tsx, ["src/node.ts", ...args], { cwd: app, env: { ...process.env, ...env }, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${args.join(" ")} failed with status ${r.status}`);
}

/** The phone app's held booking request, light and dark, from its demo on a Vite dev server. */
async function phoneShots() {
  const mobile = path.resolve(app, "../mobile");
  const vite = path.join(mobile, "node_modules", ".bin", "vite");
  const mport = 5300 + Math.floor(Math.random() * 100);
  const dev = spawn(vite, ["--port", String(mport), "--strictPort", "--host", "127.0.0.1"], {
    cwd: mobile,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let log = "";
  dev.stdout.on("data", (chunk) => {
    log += String(chunk);
  });
  let browser;
  try {
    await waitFor(() => log.includes(`127.0.0.1:${mport}`), 30_000, "the phone app's dev server");
    browser = await chromium.launch({ channel: "chrome" });
    await mkdir(out, { recursive: true });
    for (const [colorScheme, name] of [
      ["light", "phone-held"],
      ["dark", "phone-held-night"],
    ]) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        colorScheme,
        locale: "en-GB",
        timezoneId: "Europe/Lisbon",
        reducedMotion: "reduce",
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${mport}/?demo&screen=item&id=amara`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Let it in" }).first().waitFor({ timeout: 20_000 });
      await page.evaluate(() => document.fonts.ready);
      await sleep(400);
      // The heading, why it's here with Let it in, and what was asked: the top of the screen.
      await page.screenshot({ path: path.join(out, `${name}.png`), clip: { x: 0, y: 0, width: 390, height: 508 } });
      console.log(`wrote ${path.relative(process.cwd(), path.join(out, `${name}.png`))}`);
      await context.close();
    }
  } finally {
    await browser?.close();
    dev.kill();
  }
}

/** The prints asked for by the start of their names; none named, every one. */
const only = process.argv.slice(2);
const wanted = (name) => only.length === 0 || only.some((o) => name.startsWith(o));

async function main() {
  if (wanted("phone")) await phoneShots();
  if (only.length > 0 && only.every((o) => "phone".startsWith(o))) return;
  if (!existsSync(path.join(app, "dist", "client", "index.html"))) {
    console.log("no client build yet: building it");
    const r = spawnSync("pnpm", ["build:client"], { cwd: app, stdio: "inherit" });
    if (r.status !== 0) throw new Error("build:client failed");
  }
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sdi-shots-"));
  const env = {
    INBOX_DB: path.join(tmp, "showcase.db"),
    PORT: String(port),
    HOST: "127.0.0.1",
    INBOX_PUBLIC_URL: base,
    // An empty instance hands itself only to a listed owner; the pipeline's owner is this address.
    INBOX_OWNER_EMAIL: email,
    // The spam filter reads with a model on this machine, as the showcase's verdicts say; nothing is
    // ever asked of it here, since the showcase writes them.
    SPAM_MODEL_API: "chat",
    SPAM_MODEL_URL: "http://127.0.0.1:11434/v1",
    SPAM_MODEL: "local-model",
    SPAM_MODEL_NAME: "a small local model",
  };
  cli(["seed-showcase"], env);

  const server = spawn(tsx, ["src/node.ts"], {
    cwd: app,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let log = "";
  server.stdout.on("data", (chunk) => {
    log += String(chunk);
  });
  let browser;
  try {
    await waitFor(() => log.includes("listening on"), 30_000, "the server to start");

    // Sign in like a person would: ask for an email, then open the link the server printed.
    const ask = await fetch(`${base}/auth/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!ask.ok) throw new Error(`magic link request answered ${ask.status}`);
    await waitFor(() => /\/auth\/verify\?token=/.test(log), 10_000, "the sign-in link in the server log");
    const link = /https?:\/\/\S+\/auth\/verify\?token=\S+/.exec(log)?.[0];
    if (!link) throw new Error("no sign-in link in the server log");

    browser = await chromium.launch({ channel: "chrome" });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: "light",
      locale: "en-GB",
      timezoneId: "Europe/Lisbon",
    });
    const page = await context.newPage();
    // The link opens a page; its button is what signs in.
    await page.goto(link);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.locator(".row").first().waitFor({ timeout: 20_000 });

    const items = async (query) => {
      const res = await page.request.get(`${base}/v1/owner/items?${query}`);
      if (!res.ok()) throw new Error(`items?${query} answered ${res.status()}`);
      return (await res.json()).items;
    };
    const [booking] = await items("type=booking&state=confirmed");
    const [quote] = await items("type=quote_request&state=quoted");
    if (!booking || !quote) throw new Error("the showcase seed did not produce the expected items");
    const pitch = (await items("state=spam&open_only=false")).find((v) => v.spam?.cause === "pitches");
    const held = (await items("screen=held&open_only=false")).find((v) => v.spam?.may_be_customer);
    if (!pitch || !held) throw new Error("the showcase seed did not produce the spam filter's items");

    await mkdir(out, { recursive: true });
    const shot = async (name, url, colorScheme, ready) => {
      if (!wanted(name)) return;
      await page.emulateMedia({ colorScheme });
      await page.goto(`${base}${url}`);
      await page.locator(ready).first().waitFor({ timeout: 20_000 });
      await page.evaluate(() => document.fonts.ready);
      await sleep(400);
      await page.screenshot({ path: path.join(out, `${name}.png`) });
      console.log(`wrote ${path.relative(process.cwd(), path.join(out, `${name}.png`))}`);
    };
    await shot("inbox-day", "/", "light", ".today-list");
    await shot("inbox-night", "/", "dark", ".today-list");
    await shot("item-day", `/items/${quote.item.id}`, "light", ".card .actions");
    await shot("settings-day", "/settings", "light", ".subnav");
    await shot("rules-day", "/settings/rules", "light", ".rule-line");
    await shot("availability-day", "/settings/availability", "light", ".hours-day");
    await shot("spam-day", `/items/${pitch.item.id}?f=spam`, "light", ".spam-why");
    await shot("spam-night", `/items/${pitch.item.id}?f=spam`, "dark", ".spam-why");
    await shot("held-day", `/items/${held.item.id}?f=held`, "light", ".spam-why");
    await shot("spam-settings-day", "/settings/spam", "light", ".spam-settings");
  } finally {
    await browser?.close();
    server.kill();
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
