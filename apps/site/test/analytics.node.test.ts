import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Cloudflare Web Analytics (src/lib/analytics.ts): off unless the build is given a token, so
 * nobody else's build of this repository counts for us; then one beacon in the head of the site's
 * pages and of the docs, said on the privacy page, and never in what a business runs.
 */
const site = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(site(path), "utf8");
const repo = fileURLToPath(new URL("../../../", import.meta.url));

async function beacon(token: string) {
  vi.resetModules();
  vi.stubEnv("WEB_ANALYTICS_TOKEN", token);
  const { BEACON, BEACON_HEAD } = await import("../src/lib/analytics");
  expect(BEACON_HEAD).toEqual(BEACON ? [{ tag: "script", attrs: BEACON }] : []);
  return BEACON;
}

/** Every source file under dir, build outputs and dependencies left out. */
function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

describe("the visit counter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off when the build has no token", async () => {
    expect(await beacon("")).toBeNull();
  });

  it("with a token, is Cloudflare's beacon, deferred, carrying it", async () => {
    expect(await beacon("c23bbe8929bc4673a47605d9b36eaf50")).toEqual({
      defer: true,
      src: "https://static.cloudflareinsights.com/beacon.min.js",
      "data-cf-beacon": '{"token":"c23bbe8929bc4673a47605d9b36eaf50"}',
    });
  });

  it("refuses a value that is not a token, rather than write it into every page", async () => {
    await expect(beacon('x"><script>')).rejects.toThrow(/WEB_ANALYTICS_TOKEN/);
  });

  it("is in the one head the site's pages share, and in the docs' head", () => {
    const layout = read("src/layouts/Layout.astro");
    const head = layout.slice(layout.indexOf("<head>"), layout.indexOf("</head>"));
    expect(head.match(/\{BEACON && <script is:inline \{\.\.\.BEACON\}><\/script>\}/g)).toHaveLength(1);
    expect(layout.match(/BEACON &&/g)).toHaveLength(1);
    const config = read("astro.config.mjs");
    expect(config.match(/\.\.\.BEACON_HEAD,/g)).toHaveLength(1);
    // No page writes a head of its own, so every page has the layout's, or the docs' when it is
    // built on Starlight's page (as /spec/check/ is).
    for (const path of files(site("src/pages"))) {
      if (!path.endsWith(".astro")) continue;
      const page = readFileSync(path, "utf8");
      expect(page, path).not.toMatch(/<head[\s>]/);
      expect(page, path).toMatch(
        /import (Layout from "(\.\.\/)+layouts\/Layout\.astro"|StarlightPage from "@astrojs\/starlight\/components\/StarlightPage\.astro")/,
      );
    }
  });

  it("is never in the inbox, its owner app or anything a business serves", () => {
    for (const dir of ["apps/inbox", "packages", "examples"]) {
      for (const path of files(join(repo, dir))) {
        const text = readFileSync(path, "utf8");
        expect(text, path).not.toContain("cloudflareinsights");
        expect(text, path).not.toContain("WEB_ANALYTICS_TOKEN");
      }
    }
  });

  it("is on the privacy page, with what it records", () => {
    const privacy = read("src/pages/privacy.astro").replace(/\s+/g, " ");
    expect(privacy).toContain(
      "We count visits to this website with Cloudflare Web Analytics, which sets no cookies and does not follow you across sites: it records the page, the site you came from, your country and your browser, and is never on a business's inbox.",
    );
    expect(privacy).not.toMatch(/No analytics/);
  });
});
