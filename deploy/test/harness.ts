import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A pretend server for the installer and the `inbox` command: a directory to install into, and
 * stand-ins for the system's commands (docker, systemctl, getent, ip, ss, apt-get, curl…), so the
 * scripts run whole, as root on Ubuntu, without touching this machine. What a stand-in answers is
 * set through files in `state`; every docker call is logged in `state/calls`.
 */
export const repo = path.resolve(import.meta.dirname, "../..");
export const INSTALLER = path.join(repo, "apps/site/public/install.sh");
export const CLI = path.join(repo, "deploy/inbox");

/** dash where there is one (Debian and Ubuntu's /bin/sh), so the scripts are held to POSIX sh. */
export const SH = existsSync("/bin/dash") ? "/bin/dash" : existsSync("/usr/bin/dash") ? "/usr/bin/dash" : "/bin/sh";

export interface Server {
  readonly root: string;
  readonly dir: string;
  readonly state: string;
  readonly bin: string;
  readonly binDir: string;
  readonly systemd: string;
  readonly osRelease: string;
  set(file: string, text: string): void;
  run(script: string, args: string[], env?: Record<string, string>): Promise<Result>;
  done(): void;
}

export interface Result {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

export const UBUNTU = `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
UBUNTU_CODENAME=noble
`;

/**
 * The ordinary tools the scripts use, and nothing else: the PATH they run with is the stand-ins and
 * these, so a script never reaches this machine's own docker, systemctl or apt-get, even when the
 * test takes a stand-in away (as "Docker is missing" does).
 */
const TOOLS = [
  "awk",
  "base64",
  "basename",
  "cat",
  "chmod",
  "cp",
  "cut",
  "date",
  "df",
  "dirname",
  "du",
  "find",
  "grep",
  "head",
  "install",
  "ls",
  "mkdir",
  "mv",
  "od",
  "rm",
  "sed",
  "sort",
  "stty",
  "tail",
  "touch",
  "tr",
  "wc",
];
const where = (tool: string) =>
  ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map((d) => path.join(d, tool)).find(existsSync);

const stub = (body: string) => `#!/bin/sh\nprintf '%s %s\\n' "$(basename "$0")" "$*" >>"$STUB_STATE/calls"\n${body}\n`;

export function server(): Server {
  const root = mkdtempSync(path.join(tmpdir(), "inbox-kit-"));
  const dir = path.join(root, "opt-inbox");
  const state = path.join(root, "state");
  const bin = path.join(root, "bin");
  const binDir = path.join(root, "usr-local-bin");
  const systemd = path.join(root, "systemd");
  const sys = path.join(root, "sys");
  for (const d of [state, bin, binDir, systemd, sys]) mkdirSync(d, { recursive: true });
  for (const tool of TOOLS) {
    const real = where(tool);
    if (!real) throw new Error(`this machine has no ${tool}, which the scripts use`);
    symlinkSync(real, path.join(sys, tool));
  }
  const osRelease = path.join(root, "os-release");
  writeFileSync(osRelease, UBUNTU);

  const stubs: Record<string, string> = {
    id: `[ "$1" = -u ] && { cat "$STUB_STATE/uid" 2>/dev/null || echo 0; exit 0; }; exec /usr/bin/id "$@"`,
    uname: `[ "$1" = -m ] && { cat "$STUB_STATE/arch" 2>/dev/null || echo x86_64; exit 0; }; exec /usr/bin/uname "$@"`,
    systemctl: "exit 0",
    "apt-get": "exit 0",
    dpkg: "echo amd64",
    chown: "exit 0",
    getent: `grep " $2\\$" "$STUB_STATE/dns" 2>/dev/null | awk '{ print $1 "  STREAM " $2 }'; exit 0`,
    ip: `cat <<EOF
1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever
2: eth0    inet $(cat "$STUB_STATE/ip" 2>/dev/null || echo 203.0.113.7)/24 brd 203.0.113.255 scope global eth0\\       valid_lft forever
EOF`,
    ss: `cat "$STUB_STATE/ss" 2>/dev/null; exit 0`,
    curl: `case "$*" in
  *releases/latest*) printf 'HTTP/2 302\\r\\nlocation: https://github.com/surfingdogai/inbox/releases/tag/v%s\\r\\n\\r\\n' "$(cat "$STUB_STATE/latest" 2>/dev/null || echo 0.2.0)" ;;
  *healthz*) [ -f "$STUB_STATE/running" ] && echo '{"ok":true,"version":"0.1.0","db":"ok"}' || exit 7 ;;
  *) exit 7 ;;
esac`,
    sleep: "exit 0",
  };
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(path.join(bin, name), stub(body));
    chmodSync(path.join(bin, name), 0o755);
  }
  copyFileSync(path.join(import.meta.dirname, "stubs/docker"), path.join(bin, "docker"));
  chmodSync(path.join(bin, "docker"), 0o755);

  return {
    root,
    dir,
    state,
    bin,
    binDir,
    systemd,
    osRelease,
    set(file, text) {
      writeFileSync(path.join(state, file), text);
    },
    run(script, args, env = {}) {
      return new Promise((resolve) => {
        // Its own session, so there is no terminal: a question asked by mistake fails, never hangs.
        const child = spawn(SH, [script, ...args], {
          detached: true,
          env: {
            PATH: `${bin}:${sys}`,
            HOME: root,
            STUB_STATE: state,
            SDI_OS_RELEASE: osRelease,
            SDI_BIN_DIR: binDir,
            SDI_SYSTEMD_DIR: systemd,
            INBOX_DIR: dir,
            ...env,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => {
          out += String(c);
        });
        child.stderr.on("data", (c) => {
          err += String(c);
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve({ code, out, err });
        });
      });
    },
    done() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A database file as far as the stand-ins can tell: SQLite's header, then a line naming what is in it. */
export const DB = (what: string, migration = 24) => `SQLite format 3\u0000\nmigration=${migration}\n${what}\n`;
