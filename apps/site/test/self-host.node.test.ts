import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DOCKER_COMMAND, IMAGE, IMAGE_VERSION, INSTALL_COMMAND, SELF_HOST, SERVER_WHAT } from "../src/lib/self-host";

/**
 * Running it yourself, as the site says it: the installer served at /install.sh with its checksum,
 * the three ways after the hosted inbox on /install, install.md's path B, and docs that say what
 * each platform cannot do as plainly as what it can.
 */
const site = (p: string) => path.resolve(import.meta.dirname, "..", p);
const read = (p: string) => readFileSync(site(p), "utf8");
const repo = (p: string) => readFileSync(path.resolve(import.meta.dirname, "../../..", p), "utf8");

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
    // The check that counts is against GitHub's own copy, not the checksum beside the file.
    expect(read("public/install.md")).toContain(
      "curl -fsSL https://github.com/surfingdogai/inbox/releases/latest/download/SHA256SUMS | grep ' install.sh$' | sha256sum -c",
    );
    expect(read("src/content/docs/docs/run-it-yourself.md")).toContain(
      "gh attestation verify install.sh -R surfingdogai/inbox",
    );
  });
});

describe("the image, run by hand", () => {
  const pages = [
    "README.md",
    "Dockerfile",
    "apps/site/src/content/docs/docs/quickstart.md",
    "apps/site/src/content/docs/docs/run-it-yourself.md",
  ];

  it("answers on the server itself only, with a key kept and the address it answers at", () => {
    expect(DOCKER_COMMAND).toContain("-p 127.0.0.1:8787:8787");
    expect(DOCKER_COMMAND).toContain("INBOX_SECRET_KEY=");
    expect(DOCKER_COMMAND).toContain("INBOX_PUBLIC_URL=");
    expect(DOCKER_COMMAND).toContain(`${IMAGE}:${IMAGE_VERSION}`);
    for (const page of pages) {
      const text = repo(page);
      expect(text, page).toContain("127.0.0.1:8787:8787");
      // Never published on every address, around the proxy that terminates TLS.
      expect(text, page).not.toMatch(/-p 8787:8787/);
      expect(text, page).not.toContain('INBOX_SECRET_KEY="$(openssl');
    }
    expect(repo("README.md")).toContain(DOCKER_COMMAND.split("\n").slice(1).join("\n"));
  });

  it("is pinned to the newest release everywhere, the version the code says", () => {
    const core = repo("packages/core/src/version.ts").match(/VERSION = "([^"]+)"/)?.[1];
    expect(IMAGE_VERSION).toBe(core);
    const files = [
      ...pages,
      "apps/site/public/install.md",
      "apps/site/src/content/docs/docs/platforms.md",
      "apps/site/src/content/docs/docs/backups.md",
      "deploy/fly/Dockerfile",
      "deploy/render/Dockerfile",
      "deploy/coolify/docker-compose.yml",
    ];
    for (const file of files) {
      for (const [, version] of repo(file).matchAll(/ghcr\.io\/surfingdogai\/inbox:(\d[^\s"`'}]*)/g)) {
        expect(version, file).toBe(core);
      }
    }
    expect(repo("deploy/fly/Dockerfile")).toContain(`FROM ghcr.io/surfingdogai/inbox:${core}\n`);
    expect(repo("deploy/render/Dockerfile")).toContain(`FROM ghcr.io/surfingdogai/inbox:${core}\n`);
    expect(repo("deploy/coolify/docker-compose.yml")).toContain(`inbox:\${INBOX_VERSION:-${core}}`);
    expect(repo("deploy/.env.example")).toContain(`\nINBOX_VERSION=${core}\n`);
    expect(repo("render.yaml")).toContain('autoDeployTrigger: "off"');
  });
});

describe("/install", () => {
  const page = read("src/pages/install.astro");

  it("offers the hosted inbox first, then the line for your AI and what it does, then three ways by hand", () => {
    const head = page.indexOf('id="install-h"');
    const prompt = page.indexOf('id="prompt-h"');
    const what = page.indexOf('id="what-h"');
    const yourself = page.indexOf('id="yourself-h"');
    const connect = page.indexOf('id="connect-h"');
    expect(head).toBeGreaterThan(-1);
    expect(head).toBeLessThan(prompt);
    expect(prompt).toBeLessThan(what);
    expect(what).toBeLessThan(yourself);
    expect(yourself).toBeLessThan(connect);
    expect(page).toContain(">Or by hand</p>");
    expect(page).toContain(">Three ways</h2>");
    expect(SELF_HOST.map((w) => w.id)).toEqual(["server", "docker", "cloudflare"]);
    // The Docker way shows the image and the steps, not a half-configured command.
    expect(SELF_HOST.map((w) => w.command)).toEqual([INSTALL_COMMAND, IMAGE, null]);
    expect(page).toContain("href={DEPLOY_URL}");
    // The old four commands from a clone are in the docs now, not on this page.
    expect(page).not.toContain("It is four commands");
  });

  it("says each way in few words, and claims nothing the kit does not do", () => {
    for (const way of SELF_HOST) {
      expect(way.what.split(/\s+/).length, way.id).toBeLessThanOrEqual(32);
      expect(way.links.length, way.id).toBeGreaterThan(0);
    }
    expect(DOCKER_COMMAND).toContain("-v inbox-data:/opt/inbox/data");
    expect(DOCKER_COMMAND).toContain("INBOX_OWNER_EMAIL=");
    // One sentence for the server, the same on /install, /inbox and in the README.
    expect(SELF_HOST[0]?.what).toBe(SERVER_WHAT);
    expect(read("src/components/Run.astro")).toContain("{SERVER_WHAT}");
    expect(repo("README.md")).toContain(SERVER_WHAT);
    // The Cloudflare way and "What it does" agree: free to start, no price of five dollars.
    expect(SELF_HOST[2]?.what).toContain("You can start free");
    expect(page).not.toContain("five dollars");
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

  it("says when the installer stops, as it does", () => {
    expect(md.replace(/\s+/g, " ")).toContain(
      "It stops before it installs Docker or writes anything when the server is not Ubuntu or Debian",
    );
    expect(md).not.toContain("It stops, and changes nothing");
    expect(read("src/content/docs/docs/run-it-yourself.md")).toContain("before it installs Docker or writes anything");
  });

  it("has the agent ask before the DNS record, never skip the check, and never handle the email key", () => {
    expect(md).toContain("(a DNS change: ask first, and wait)");
    expect(md.replace(/\s+/g, " ")).toContain("never add `--skip-dns-check` to get past a record that is wrong");
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
