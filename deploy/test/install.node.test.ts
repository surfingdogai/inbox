import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInstaller, checksumLine } from "../../scripts/build-install.mjs";
import { INSTALLER, repo, type Server, SH, server } from "./harness";

/**
 * The one-command installer, `curl -fsSL https://surfingdog.ai/install.sh | sudo sh`: what it asks,
 * what it checks before it writes anything, what it writes, and that a second run keeps the data,
 * the secret key and the version. It runs whole here against stand-ins for the system's commands
 * (harness.ts); the self-host workflow runs it for real in a systemd container with Docker.
 */
let s: Server;
afterEach(() => s?.done());

const env = (s: Server) => readFileSync(path.join(s.dir, ".env"), "utf8");
const value = (s: Server, key: string) => env(s).match(new RegExp(`^${key}=(.*)$`, "m"))?.[1];
const FIRST = ["--domain", "inbox.example.com", "--email", "owner@example.com", "--yes", "--dir"];

function lib(fn: string, ...args: string[]) {
  return execFileSync(SH, ["-c", `. "$0"; ${fn} "$@"`, INSTALLER, ...args], {
    env: { ...process.env, SDI_INSTALL_LIB: "1" },
    encoding: "utf8",
  });
}
const holds = (fn: string, ...args: string[]) => {
  try {
    lib(fn, ...args);
    return true;
  } catch {
    return false;
  }
};

describe("the installer served at /install.sh", () => {
  it("is deploy/install.sh with the kit inside it, and its checksum beside it", () => {
    const served = readFileSync(INSTALLER, "utf8");
    expect(served).toBe(buildInstaller());
    expect(readFileSync(path.join(repo, "apps/site/public/install.sh.sha256"), "utf8")).toBe(checksumLine(served));
    for (const file of ["deploy/docker-compose.yml", "deploy/Caddyfile", "deploy/inbox"]) {
      expect(served).toContain(readFileSync(path.join(repo, file), "utf8").trimEnd());
    }
    expect(served).not.toContain("@@EMBED");
    // Nothing runs until the last line has arrived.
    expect(served.trimEnd().split("\n").at(-1)).toBe(`if [ "\${SDI_INSTALL_LIB:-}" != 1 ]; then main "$@"; fi`);
    expect(served.startsWith("#!/bin/sh\n")).toBe(true);
  });

  it("says plainly that it sends nothing anywhere, and names everything it downloads", () => {
    const head = readFileSync(INSTALLER, "utf8").split("\nset -eu")[0] ?? "";
    expect(head).toContain("No telemetry: it sends nothing about you or your server anywhere.");
    for (const source of ["download.docker.com", "ghcr.io", "Docker Hub", "github.com", "Let's Encrypt"]) {
      expect(head).toContain(source);
    }
    expect(head).toContain("curl -fsSL https://surfingdog.ai/install.sh | sudo sh");
  });
});

describe("what it accepts", { timeout: 60_000 }, () => {
  it("takes an address as typed or pasted, and refuses what is not one", () => {
    expect(lib("normalize_domain", " HTTPS://Inbox.Example.com/login?x=1 ")).toBe("inbox.example.com");
    expect(lib("normalize_domain", "inbox.example.com.")).toBe("inbox.example.com");
    expect(lib("normalize_domain", "inbox.example.com:443")).toBe("inbox.example.com");
    for (const good of ["inbox.example.com", "inbox.my-shop.co.uk", "a.b"])
      expect(holds("valid_domain", good), good).toBe(true);
    for (const bad of [
      "",
      "localhost",
      "-inbox.example.com",
      "inbox-.example.com",
      "in box.example.com",
      "inbox..example.com",
      "203.0.113.7",
      `${"a".repeat(64)}.com`,
    ]) {
      expect(holds("valid_domain", bad), bad).toBe(false);
    }
    // A whole domain is most often the business's website: the installer offers inbox.<it> first.
    expect(holds("is_bare_domain", "example.com")).toBe(true);
    expect(holds("is_bare_domain", "inbox.example.com")).toBe(false);
  });

  it("takes an email address, and refuses a list or a name with it", () => {
    expect(holds("valid_email", "owner@example.com")).toBe(true);
    expect(holds("valid_email", "first.last+inbox@shop.example.co.uk")).toBe(true);
    for (const bad of [
      "owner",
      "owner@",
      "@example.com",
      "a@b",
      "a@example.com,b@example.com",
      "Owner <owner@example.com>",
    ]) {
      expect(holds("valid_email", bad), bad).toBe(false);
    }
  });

  it("knows where an address points, and which addresses are private", () => {
    expect(lib("dns_verdict", "", "203.0.113.7")).toBe("none");
    expect(lib("dns_verdict", "203.0.113.7\n2001:db8::7", "10.0.0.2\n203.0.113.7")).toBe("here");
    expect(lib("dns_verdict", "198.51.100.1", "203.0.113.7")).toBe("elsewhere");
    for (const a of ["10.1.2.3", "192.168.1.10", "172.20.0.5", "100.64.0.1", "fd00::1", "fe80::1"])
      expect(holds("is_private", a), a).toBe(true);
    for (const a of ["203.0.113.7", "172.15.0.1", "100.128.0.1", "2001:db8::1"])
      expect(holds("is_private", a), a).toBe(false);
  });

  it("runs on Ubuntu, Debian and the systems built on them, and on nothing else", () => {
    s = server();
    const os = (text: string) => {
      writeFileSync(s.osRelease, text);
      try {
        return execFileSync(
          SH,
          ["-c", `. "$0"; f=$(os_family) || exit 1; printf '%s %s' "$f" "$(os_codename)"`, INSTALLER],
          {
            env: { ...process.env, SDI_INSTALL_LIB: "1", SDI_OS_RELEASE: s.osRelease },
            encoding: "utf8",
          },
        );
      } catch {
        return "refused";
      }
    };
    expect(os("ID=ubuntu\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n")).toBe("ubuntu noble");
    expect(os("ID=debian\nVERSION_CODENAME=bookworm\n")).toBe("debian bookworm");
    expect(os('ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_CODENAME=wilma\nUBUNTU_CODENAME=noble\n')).toBe(
      "ubuntu noble",
    );
    expect(os('ID=fedora\nID_LIKE="rhel centos"\nVERSION_CODENAME=""\n')).toBe("refused");
  });
});

describe("a first install", { timeout: 60_000 }, () => {
  it("checks, writes /opt/inbox, starts it behind Caddy, and says what to do next", async () => {
    s = server();
    s.set("dns", "203.0.113.7 inbox.example.com\n");
    const r = await s.run(INSTALLER, [...FIRST, s.dir]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    // The settings: readable by root only, a generated key, the newest release pinned.
    expect(statSync(path.join(s.dir, ".env")).mode & 0o777).toBe(0o600);
    expect(value(s, "INBOX_DOMAIN")).toBe("inbox.example.com");
    expect(value(s, "INBOX_OWNER_EMAIL")).toBe("owner@example.com");
    expect(value(s, "INBOX_VERSION")).toBe("0.2.0");
    expect(Buffer.from(value(s, "INBOX_SECRET_KEY") ?? "", "base64")).toHaveLength(32);
    // The kit, as it is in deploy/, and the `inbox` command, set to this directory.
    expect(readFileSync(path.join(s.dir, "docker-compose.yml"), "utf8")).toBe(
      readFileSync(path.join(repo, "deploy/docker-compose.yml"), "utf8"),
    );
    expect(readFileSync(path.join(s.dir, "Caddyfile"), "utf8")).toBe(
      readFileSync(path.join(repo, "deploy/Caddyfile"), "utf8"),
    );
    const cli = readFileSync(path.join(s.binDir, "inbox"), "utf8");
    expect(cli).toContain(`INBOX_DIR="\${INBOX_DIR:-${s.dir}}"`);
    expect(statSync(path.join(s.binDir, "inbox")).mode & 0o111).not.toBe(0);
    expect(statSync(path.join(s.dir, "data")).mode & 0o777).toBe(0o700);
    // A backup every night, the last seven kept.
    expect(readFileSync(path.join(s.systemd, "inbox-backup.timer"), "utf8")).toContain("OnCalendar=*-*-* 03:30:00");
    expect(readFileSync(path.join(s.systemd, "inbox-backup.service"), "utf8")).toContain(
      `ExecStart=${s.binDir}/inbox backup --auto --quiet`,
    );
    const calls = readFileSync(path.join(s.state, "calls"), "utf8");
    expect(calls).toContain("systemctl enable --now inbox-backup.timer");
    expect(calls).toMatch(/docker compose --project-directory \S+ -f \S+ up -d --remove-orphans/);
    // Docker was here already: nothing was installed from apt for it.
    expect(calls).not.toContain("docker-ce");
    // The next step, in a few lines.
    expect(r.out).toContain("Surfing Dog Inbox is running at https://inbox.example.com");
    expect(r.out).toContain("Open https://inbox.example.com/login and enter owner@example.com.");
    expect(r.out).toContain("sudo inbox sign-in");
    expect(r.out).toContain("sudo inbox email");
    expect(r.out).toContain(`Keep a copy of ${s.dir}/.env somewhere safe`);
  });

  it("installs Docker from Docker's own repository when it is missing", async () => {
    s = server();
    s.set("dns", "203.0.113.7 inbox.example.com\n");
    // No docker until apt-get installs docker-ce; then the stand-in appears.
    const docker = path.join(s.bin, "docker");
    renameSync(docker, path.join(s.root, "docker.real"));
    const shell = (name: string, body: string) => {
      writeFileSync(path.join(s.bin, name), `#!/bin/sh\nprintf '${name} %s\\n' "$*" >>"$STUB_STATE/calls"\n${body}\n`);
      chmodSync(path.join(s.bin, name), 0o755);
    };
    shell("apt-get", `case "$*" in *docker-ce*) cp "${s.root}/docker.real" "${docker}" ;; esac`);
    shell(
      "curl",
      `case "$*" in
  *download.docker.com*) while [ $# -gt 0 ]; do [ "$1" = -o ] && echo key >"$2"; shift; done ;;
  *releases/latest*) printf 'HTTP/2 302\\r\\nlocation: https://github.com/surfingdogai/inbox/releases/tag/v0.2.0\\r\\n' ;;
  *healthz*) [ -f "$STUB_STATE/running" ] && echo '{"ok":true}' ;;
  *) exit 7 ;;
esac`,
    );
    // Docker's key and list go where a real system keeps them: here, a directory of the test's own.
    const local = path.join(s.root, "install.sh");
    writeFileSync(local, readFileSync(INSTALLER, "utf8").replaceAll("/etc/apt/", `${s.root}/apt/`));
    mkdirSync(path.join(s.root, "apt/sources.list.d"), { recursive: true });
    const r = await s.run(local, [...FIRST, s.dir]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const calls = readFileSync(path.join(s.state, "calls"), "utf8");
    expect(calls).toContain("curl -fsSL https://download.docker.com/linux/ubuntu/gpg");
    expect(calls).toContain("apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin");
    expect(calls).toContain("systemctl enable --now docker");
    expect(readFileSync(path.join(s.root, "apt/sources.list.d/docker.list"), "utf8")).toBe(
      `deb [arch=amd64 signed-by=${s.root}/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n`,
    );
    expect(r.out).toContain("Installing Docker from download.docker.com (ubuntu noble)…");
  });
});

describe("before it writes anything", { timeout: 60_000 }, () => {
  it("stops when the address points elsewhere, and says where it should point", async () => {
    s = server();
    s.set("dns", "198.51.100.1 inbox.example.com\n");
    const r = await s.run(INSTALLER, [...FIRST, s.dir]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("inbox.example.com points at 198.51.100.1, not at this server (203.0.113.7).");
    expect(r.err).toContain("add --skip-dns-check");
    expect(existsSync(path.join(s.dir, ".env"))).toBe(false);
  });

  it("names the record to add when there is none", async () => {
    s = server();
    const r = await s.run(INSTALLER, [...FIRST, s.dir]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "inbox.example.com has no DNS record yet. Where your domain's DNS is, add an A record: inbox.example.com → 203.0.113.7",
    );
    expect(existsSync(path.join(s.dir, ".env"))).toBe(false);
  });

  it("goes on without the check only when told to", async () => {
    s = server();
    const r = await s.run(INSTALLER, [...FIRST, s.dir, "--skip-dns-check"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Not checking where inbox.example.com points (--skip-dns-check).");
  });

  it("stops when something else holds port 80 or 443, and names it", async () => {
    s = server();
    s.set("dns", "203.0.113.7 inbox.example.com\n");
    s.set("ss", 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))\n');
    const r = await s.run(INSTALLER, [...FIRST, s.dir]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Port 80 is taken by nginx.");
    expect(existsSync(path.join(s.dir, ".env"))).toBe(false);
  });

  it("asks for root, Ubuntu or Debian, and amd64 or arm64", async () => {
    s = server();
    s.set("uid", "1000\n");
    expect((await s.run(INSTALLER, [...FIRST, s.dir])).err).toContain(
      "Run it as root: curl -fsSL https://surfingdog.ai/install.sh | sudo sh",
    );
    s.set("uid", "0\n");
    s.set("arch", "riscv64\n");
    expect((await s.run(INSTALLER, [...FIRST, s.dir])).err).toContain("the inbox's image is for amd64 and arm64");
    s.set("arch", "aarch64\n");
    writeFileSync(s.osRelease, 'ID=alpine\nPRETTY_NAME="Alpine Linux"\n');
    expect((await s.run(INSTALLER, [...FIRST, s.dir])).err).toContain("This installer is for Ubuntu and Debian.");
  });

  it("with no terminal to ask on, wants the address and the email as options", async () => {
    s = server();
    const r = await s.run(INSTALLER, ["--yes", "--dir", s.dir]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Run it with --domain inbox.yourbusiness.com (and --email).");
    const bad = await s.run(INSTALLER, [
      "--domain",
      "not a domain",
      "--email",
      "x@example.com",
      "--yes",
      "--dir",
      s.dir,
    ]);
    expect(bad.err).toContain("is not an address like inbox.yourbusiness.com");
    expect((await s.run(INSTALLER, ["--tls", "selfsigned"])).err).toContain("--tls is acme (the default) or internal.");
  });
});

describe("a second run", { timeout: 60_000 }, () => {
  it("keeps the data, the secret key, the version and the certificate, and points at the update instead", async () => {
    s = server();
    s.set("dns", "203.0.113.7 inbox.example.com\n");
    expect((await s.run(INSTALLER, [...FIRST, s.dir, "--tls", "internal"])).code).toBe(0);
    expect(value(s, "INBOX_TLS")).toBe("internal");
    const key = value(s, "INBOX_SECRET_KEY");
    writeFileSync(path.join(s.dir, "data/inbox.db"), "the business's data");
    writeFileSync(path.join(s.dir, ".env"), `${env(s)}MAIL_FROM=inbox@example.com\n`);
    s.set("latest", "0.3.0");
    const again = await s.run(INSTALLER, ["--yes", "--dir", s.dir]);
    expect(again.err).toBe("");
    expect(again.code).toBe(0);
    expect(value(s, "INBOX_SECRET_KEY")).toBe(key);
    expect(value(s, "INBOX_VERSION")).toBe("0.2.0");
    expect(value(s, "MAIL_FROM")).toBe("inbox@example.com");
    expect(value(s, "INBOX_TLS")).toBe("internal");
    expect(readFileSync(path.join(s.dir, "data/inbox.db"), "utf8")).toBe("the business's data");
    expect(again.out).toContain("A newer release is out (0.3.0; this is 0.2.0): sudo inbox update");
    expect(again.out).toContain("Email goes out from inbox@example.com.");
    // A changed address is taken, and nothing else moves.
    s.set("dns", "203.0.113.7 inbox.example.com\n203.0.113.7 desk.example.com\n");
    const moved = await s.run(INSTALLER, ["--domain", "desk.example.com", "--yes", "--dir", s.dir]);
    expect(moved.code).toBe(0);
    expect(value(s, "INBOX_DOMAIN")).toBe("desk.example.com");
    expect(value(s, "INBOX_SECRET_KEY")).toBe(key);
  });

  it("refuses to make a new key over a settings file that lost its own", async () => {
    s = server();
    s.set("dns", "203.0.113.7 inbox.example.com\n");
    expect((await s.run(INSTALLER, [...FIRST, s.dir])).code).toBe(0);
    writeFileSync(path.join(s.dir, ".env"), env(s).replace(/^INBOX_SECRET_KEY=.*\n/m, ""));
    const r = await s.run(INSTALLER, ["--yes", "--dir", s.dir]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("has no INBOX_SECRET_KEY. It is what opens the data");
  });
});
