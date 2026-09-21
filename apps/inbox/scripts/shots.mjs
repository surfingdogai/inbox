#!/usr/bin/env node
/**
 * Screenshots for the site. Starts the Node server on a temporary database, seeds the showcase,
 * signs in through the real magic-link flow (the link is read from the server's own stdout), and
 * captures 1440×900 at 2× into apps/site/public/shots:
 *
 *   inbox-day.png, inbox-night.png   the three panes with tomorrow's booking open
 *   item-day.png                     a quote request with its quote, transitions and thread
 *   settings-day.png                 the settings page
 *   rules-day.png                    the rules screen
 *   availability-day.png             the opening hours screen
 *
 *   pnpm --filter @surfingdog/inbox shots
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
const email = "tiago@oficinamare.pt";

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

async function main() {
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

    // Sign in like a person would: ask for a link, then open the one the server printed.
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
    await page.goto(link);
    await page.locator(".row").first().waitFor({ timeout: 20_000 });

    const items = async (query) => {
      const res = await page.request.get(`${base}/v1/owner/items?${query}`);
      if (!res.ok()) throw new Error(`items?${query} answered ${res.status()}`);
      return (await res.json()).items;
    };
    const [booking] = await items("type=booking&state=confirmed");
    const [quote] = await items("type=quote_request&state=quoted");
    if (!booking || !quote) throw new Error("the showcase seed did not produce the expected items");

    await mkdir(out, { recursive: true });
    const shot = async (name, url, colorScheme, ready) => {
      await page.emulateMedia({ colorScheme });
      await page.goto(`${base}${url}`);
      await page.locator(ready).first().waitFor({ timeout: 20_000 });
      await page.evaluate(() => document.fonts.ready);
      await sleep(400);
      await page.screenshot({ path: path.join(out, `${name}.png`) });
      console.log(`wrote ${path.relative(process.cwd(), path.join(out, `${name}.png`))}`);
    };
    await shot("inbox-day", `/items/${booking.item.id}`, "light", ".card .actions");
    await shot("inbox-night", `/items/${booking.item.id}`, "dark", ".card .actions");
    await shot("item-day", `/items/${quote.item.id}`, "light", ".card .actions");
    await shot("settings-day", "/settings", "light", ".settings-grid");
    await shot("rules-day", "/settings/rules", "light", ".rule-line");
    await shot("availability-day", "/settings/availability", "light", ".hours-day");
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
