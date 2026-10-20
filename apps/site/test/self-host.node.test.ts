import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DOCKER_COMMAND, IMAGE, INSTALL_COMMAND, SELF_HOST } from "../src/lib/self-host";

/**
 * Running it yourself, as the site says it: the installer served at /install.sh with its checksum,
 * the three ways after the hosted inbox on /install, install.md's path B, and docs that say what
 * each platform cannot do as plainly as what it can.
 */
const site = (p: string) => path.resolve(import.meta.dirname, "..", p);
const read = (p: string) => readFileSync(site(p), "utf8");

describe("the installer the site serves", () => {
  it("is at /install.sh, its checksum beside it, and every page gives the same command", () => {
    const script = read("public/install.sh");
    expect(read("public/install.sh.sha256")).toBe(`${createHash("sha256").update(script).digest("hex")}  install.sh\n`);
    expect(script).toContain(`#   ${INSTALL_COMMAND}`);
    expect(INSTALL_COMMAND).toBe("curl -fsSL https://surfingdog.ai/install.sh | sudo sh");
    for (const page of [
      "src/content/docs/docs/run-it-yourself.md",
      "src/content/docs/docs/quickstart.md",
      "src/components/Run.astro",
    ]) {
      const text = read(page);
      expect(text.includes(INSTALL_COMMAND) || text.includes("{INSTALL_COMMAND}"), page).toBe(true);
    }
    expect(read("public/install.md")).toContain("curl -fsSL https://surfingdog.ai/install.sh.sha256 | sha256sum -c");
  });
});

describe("/install", () => {
  const page = read("src/pages/install.astro");

  it("offers the hosted inbox first, then three ways to run it yourself, then the line for your AI", () => {
    const head = page.indexOf('id="install-h"');
    const yourself = page.indexOf('id="yourself-h"');
    const prompt = page.indexOf('id="prompt-h"');
    expect(head).toBeGreaterThan(-1);
    expect(head).toBeLessThan(yourself);
    expect(yourself).toBeLessThan(prompt);
    expect(page).toContain(">Or run it yourself</p>");
    expect(page).toContain(">Three ways</h2>");
    expect(SELF_HOST.map((w) => w.id)).toEqual(["server", "docker", "cloudflare"]);
    expect(SELF_HOST.map((w) => w.command)).toEqual([INSTALL_COMMAND, DOCKER_COMMAND, null]);
    expect(page).toContain("href={DEPLOY_URL}");
    // The old four commands from a clone are in the docs now, not on this page.
    expect(page).not.toContain("It is four commands");
  });

  it("says each way in few words, and claims nothing the kit does not do", () => {
    for (const way of SELF_HOST) {
      expect(way.what.split(/\s+/).length, way.id).toBeLessThanOrEqual(32);
      expect(way.links.length, way.id).toBeGreaterThan(0);
    }
    expect(DOCKER_COMMAND).toContain(IMAGE);
    expect(DOCKER_COMMAND).toContain("-v inbox-data:/opt/inbox/data");
    expect(DOCKER_COMMAND).toContain("INBOX_OWNER_EMAIL=");
  });
});

describe("install.md, path B", () => {
  const md = read("public/install.md");

  it("is the one command first, the image second, Node and systemd third", () => {
    const b1 = md.indexOf("### B1. One command");
    const b2 = md.indexOf("### B2. The Docker image");
    const b3 = md.indexOf("### B3. Node and systemd");
    expect(md.indexOf("## The short way: we host it")).toBeLessThan(b1);
    expect(b1).toBeLessThan(b2);
    expect(b2).toBeLessThan(b3);
    expect(md).toContain("sudo sh install.sh --domain inbox.theirdomain.com --email them@theirdomain.com --yes");
  });

  it("has the agent ask before the DNS record, never skip the check, and never handle the email key", () => {
    expect(md).toContain("(a DNS change: ask first, and wait)");
    expect(md).toContain("never add\n`--skip-dns-check` to get past a record that is wrong");
    expect(md).toContain("the person runs `sudo inbox email` themselves");
    expect(md).toContain("Never print the key itself in your answer.");
  });
});

describe("the docs for running it yourself", () => {
  it("are in the sidebar, and link to each other", () => {
    const config = read("astro.config.mjs");
    for (const doc of ["run-it-yourself", "platforms", "backups"]) {
      expect(existsSync(site(`src/content/docs/docs/${doc}.md`)), doc).toBe(true);
      expect(config).toContain(`"docs/${doc}"`);
    }
  });

  it("say plainly what a platform cannot do", () => {
    const platforms = read("src/content/docs/docs/platforms.md");
    expect(platforms).toContain("**App Platform cannot run the inbox**");
    expect(platforms).toContain("Render gives disks only to paid instances");
    expect(platforms).toContain("Never scale it past one machine.");
    expect(platforms).toContain("RAILWAY_RUN_UID=0");
    expect(platforms).toContain("There is no Railway template to press yet");
  });

  it("say what restores an inbox whole: a backup and the secret key", () => {
    const backups = read("src/content/docs/docs/backups.md");
    expect(backups).toContain("**A backup of the database.**");
    expect(backups).toContain("**`INBOX_SECRET_KEY`.**");
    expect(backups).toContain("copy backups somewhere else too");
    expect(read("src/content/docs/docs/quickstart.md")).not.toContain("There is no published image yet");
  });
});
