import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLI, DB, repo, type Server, SH, server } from "./harness";

/**
 * The `inbox` command the installer puts on the server: a backup is the inbox's own full copy, an
 * update that does not start rolls back to the version and the data of before, and a restore looks
 * at a file before it replaces anything. Run against stand-ins (harness.ts, stubs/docker).
 */
let s: Server;
afterEach(() => s?.done());

function installed(version = "0.1.0") {
  s = server();
  mkdirSync(path.join(s.dir, "data"), { recursive: true });
  copyFileSync(path.join(repo, "deploy/docker-compose.yml"), path.join(s.dir, "docker-compose.yml"));
  copyFileSync(path.join(repo, "deploy/Caddyfile"), path.join(s.dir, "Caddyfile"));
  writeFileSync(
    path.join(s.dir, ".env"),
    `INBOX_DOMAIN=inbox.example.com\nINBOX_OWNER_EMAIL=owner@example.com\nINBOX_SECRET_KEY=a2V5\nINBOX_VERSION=${version}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(s.dir, "data/inbox.db"), DB("as it was"));
  s.set("running", "");
  s.set("images", `ghcr.io/surfingdogai/inbox:${version}\n`);
  return s;
}
const inbox = (...args: string[]) => s.run(CLI, args);
const db = () => readFileSync(path.join(s.dir, "data/inbox.db"), "utf8");
const version = () => readFileSync(path.join(s.dir, ".env"), "utf8").match(/^INBOX_VERSION=(.*)$/m)?.[1];
const backups = () => readdirSync(path.join(s.dir, "data/backups")).sort();
const calls = () => readFileSync(path.join(s.state, "calls"), "utf8");

/** A release on the stand-in GitHub: its kit as a tarball, and SHA256SUMS (wrong when `tamper`). */
function release(version: string, compose: string, tamper = false) {
  const dir = path.join(s.state, `release-${version}`);
  const kit = path.join(s.root, `kit-${version}`, "inbox-selfhost");
  mkdirSync(kit, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(kit, "docker-compose.yml"), compose);
  copyFileSync(path.join(repo, "deploy/Caddyfile"), path.join(kit, "Caddyfile"));
  writeFileSync(
    path.join(kit, "inbox"),
    readFileSync(CLI, "utf8").replace("# inbox: look after", `# inbox ${version}: look after`),
  );
  const tar = path.join(dir, "inbox-selfhost.tar.gz");
  execFileSync("tar", ["-czf", tar, "-C", path.dirname(kit), "inbox-selfhost"]);
  const sum = createHash("sha256")
    .update(tamper ? "something else" : readFileSync(tar))
    .digest("hex");
  writeFileSync(path.join(dir, "SHA256SUMS"), `${sum}  inbox-selfhost.tar.gz\n`);
}

describe("inbox backup", { timeout: 60_000 }, () => {
  it("is the inbox's own copy, in data/backups, and the nightly one keeps seven", async () => {
    installed();
    const r = await inbox("backup");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Backed up to \S+\/data\/backups\/inbox-\d{8}T\d{6}Z\.db/);
    expect(r.out).toContain("Copy it somewhere else too, with");
    expect(readFileSync(path.join(s.state, "calls"), "utf8")).toContain(
      "exec -T inbox node /opt/inbox/server.mjs backup /opt/inbox/data/backups/inbox-",
    );
    expect(statSync(path.join(s.dir, "data/backups")).mode & 0o777).toBe(0o700);
    for (let day = 1; day <= 9; day++)
      writeFileSync(
        path.join(s.dir, `data/backups/inbox-202610${String(day).padStart(2, "0")}T033000Z-daily.db`),
        "old",
      );
    expect((await inbox("backup", "--auto", "--quiet")).out).toBe("");
    expect(backups().filter((f) => f.endsWith("-daily.db"))).toHaveLength(7);
    // The newest seven: today's and the last six days'.
    expect(backups()).not.toContain("inbox-20261003T033000Z-daily.db");
    expect(backups()).toContain("inbox-20261009T033000Z-daily.db");
  });

  it("is made by a one-off container of the same version when the inbox is stopped", async () => {
    installed();
    await inbox("stop");
    expect((await inbox("backup")).code).toBe(0);
    expect(readFileSync(path.join(s.state, "calls"), "utf8")).toContain(
      "run --rm --no-deps -T inbox node /opt/inbox/server.mjs backup",
    );
  });
});

describe("inbox update", { timeout: 60_000 }, () => {
  it("moves to the version, after a backup made with the inbox stopped", async () => {
    installed("0.1.0");
    s.set("migrates", "");
    const r = await inbox("update", "0.2.0");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    // The stand-in's /healthz says 0.1.0 whatever runs, so the line says so too.
    expect(r.out).toContain("Updated: 0.1.0 → 0.2.0. The data as it was before is in");
    expect(version()).toBe("0.2.0");
    const before = backups().find((f) => f.endsWith("-before-0.2.0.db"));
    expect(before).toBeDefined();
    expect(readFileSync(path.join(s.dir, "data/backups", before ?? ""), "utf8")).toBe(DB("as it was"));
    // The command's own notes are root's, apart from the data.
    expect(readFileSync(path.join(s.dir, "state/last-update"), "utf8")).toMatch(
      new RegExp(`^version=0\\.1\\.0\\nbackup=${before}\\nkit=\\S+/state/kit-\\d{8}T\\d{6}Z-0\\.1\\.0\\n$`),
    );
    expect(existsSync(path.join(s.dir, "data/backups/last-update"))).toBe(false);
    // Stopped, then backed up by a one-off container: nothing written between the two is lost.
    expect(calls().indexOf(" stop inbox")).toBeLessThan(
      calls().indexOf("run --rm --no-deps -T inbox node /opt/inbox/server.mjs backup"),
    );
    expect((await inbox("update", "0.2.0")).out).toContain("Already on 0.2.0.");
  });

  it("rolls back to the version and the data of before when the new one does not start", async () => {
    installed("0.1.0");
    s.set("migrates", "");
    s.set("broken", "0.2.0\n");
    const r = await inbox("update", "0.2.0");
    expect(r.code).toBe(1);
    expect(r.err).toContain("0.2.0 did not start. Going back to 0.1.0, with the data as it was.");
    expect(r.err).toMatch(
      /Back on 0\.1\.0; nothing was lost\. What 0\.2\.0 said is in \S+\/state\/update-\d{8}T\d{6}Z-0\.2\.0\.log\./,
    );
    expect(r.err).toContain("0.1.0 may send it again.");
    expect(version()).toBe("0.1.0");
    // What the broken version wrote is gone; the rollback's own start writes its line on top.
    expect(db()).not.toContain("migrated-by-0.2.0");
    expect(db().startsWith(DB("as it was"))).toBe(true);
    // Root never wrote into the data folder: the inbox's own one-off container swapped the file.
    expect(calls()).toContain("run --rm --no-deps -T --entrypoint sh inbox -c cp -- ");
    expect(calls()).toContain("mv -f inbox.db.new inbox.db");
    expect(statSync(path.join(s.dir, "data/inbox.db")).mode & 0o777).toBe(0o600);
  });

  it("starts the inbox again, and changes nothing, when the backup before it fails", async () => {
    installed("0.1.0");
    s.set("no-backup", "");
    const r = await inbox("update", "0.2.0");
    expect(r.code).toBe(1);
    expect(r.err).toContain("database or disk is full");
    expect(r.err).toContain("The backup failed, so nothing changed: 0.1.0 runs again.");
    expect(version()).toBe("0.1.0");
    expect(existsSync(path.join(s.state, "running"))).toBe(true);
    expect(db()).toBe(DB("as it was"));
  });

  it("refuses an older version, and names the rollback instead", async () => {
    installed("0.3.0");
    const r = await inbox("update", "0.2.9");
    expect(r.code).toBe(1);
    expect(r.err).toContain("0.2.9 is older than 0.3.0, and may not read the database 0.3.0 left.");
    expect(r.err).toContain("sudo inbox rollback");
    expect(version()).toBe("0.3.0");
    // 0.10.0 is newer than 0.9.0, not older.
    installed("0.9.0");
    expect((await inbox("update", "0.10.0")).code).toBe(0);
    installed("0.3.0");
    expect((await inbox("update", "0.2.9", "--force")).code).toBe(0);
    expect(version()).toBe("0.2.9");
  });

  it("takes a release after its own pre-release, and refuses the pre-release after the release", async () => {
    installed("0.2.0-rc.1");
    expect((await inbox("update", "0.2.0")).code).toBe(0);
    expect(version()).toBe("0.2.0");
    installed("0.2.0-rc.1");
    expect((await inbox("update", "0.2.0-rc.2")).code).toBe(0);
    installed("0.2.0");
    const r = await inbox("update", "0.2.0-rc.1");
    expect(r.code).toBe(1);
    expect(r.err).toContain("0.2.0-rc.1 is older than 0.2.0");
    expect(version()).toBe("0.2.0");
  });

  it("brings the kit up to date from the release, checked, and puts the old one back on a rollback", async () => {
    installed("0.1.0");
    const kitCompose = `${readFileSync(path.join(repo, "deploy/docker-compose.yml"), "utf8")}# the 0.2.0 kit\n`;
    release("0.2.0", kitCompose);
    const r = await inbox("update", "0.2.0");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(readFileSync(path.join(s.dir, "docker-compose.yml"), "utf8")).toBe(kitCompose);
    // The command itself, set to this server's directory and place, as the installer set it.
    const cli = readFileSync(path.join(s.binDir, "inbox"), "utf8");
    expect(cli).toContain("# inbox 0.2.0: look after");
    expect(cli).toContain(`INBOX_DIR="\${INBOX_DIR:-${s.dir}}"`);
    expect(cli).toContain(`INBOX_BIN="\${INBOX_BIN:-${path.join(s.binDir, "inbox")}}"`);
    expect(readdirSync(s.state).filter((f) => f.startsWith("kit-new"))).toEqual([]);
    const rollback = await inbox("rollback", "--yes");
    expect(rollback.code).toBe(0);
    expect(readFileSync(path.join(s.dir, "docker-compose.yml"), "utf8")).toBe(
      readFileSync(path.join(repo, "deploy/docker-compose.yml"), "utf8"),
    );
  });

  it("stops, changing nothing, when a release's kit does not match its checksum", async () => {
    installed("0.1.0");
    release("0.2.0", "services: {}\n", true);
    const r = await inbox("update", "0.2.0");
    expect(r.code).toBe(1);
    expect(r.err).toContain("The kit of 0.2.0 does not match the checksum in its SHA256SUMS. Nothing changed.");
    expect(version()).toBe("0.1.0");
    expect(readFileSync(path.join(s.dir, "docker-compose.yml"), "utf8")).toBe(
      readFileSync(path.join(repo, "deploy/docker-compose.yml"), "utf8"),
    );
    expect(existsSync(path.join(s.state, "running"))).toBe(true);
  });

  it("changes nothing when the new version cannot be downloaded", async () => {
    installed("0.1.0");
    s.set("no-pull", "");
    const r = await inbox("update", "0.2.0");
    expect(r.code).toBe(1);
    expect(r.err).toContain("Could not download ghcr.io/surfingdogai/inbox:0.2.0. Nothing changed.");
    expect(version()).toBe("0.1.0");
    expect(existsSync(path.join(s.dir, "data/backups"))).toBe(false);
  });

  it("finds the newest release on its own, and rolls back on request", async () => {
    installed("0.1.0");
    s.set("latest", "0.3.0");
    expect((await inbox("update")).code).toBe(0);
    expect(version()).toBe("0.3.0");
    const r = await inbox("rollback", "--yes");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Back on 0\.1\.0\. The inbox as it was just now is in \S+-before-rollback\.db/);
    expect(version()).toBe("0.1.0");
  });
});

describe("inbox restore", { timeout: 60_000 }, () => {
  it("looks at the file, keeps the inbox of now, then puts the backup in its place", async () => {
    installed();
    const file = path.join(s.root, "copy.db");
    writeFileSync(file, DB("from last week", 23));
    const r = await inbox("restore", file, "--yes");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("That backup holds 3 requests.");
    expect(db()).toBe(DB("from last week", 23));
    expect(statSync(path.join(s.dir, "data/inbox.db")).mode & 0o777).toBe(0o600);
    const safety = backups().find((f) => f.endsWith("-before-restore.db"));
    expect(readFileSync(path.join(s.dir, "data/backups", safety ?? ""), "utf8")).toBe(DB("as it was"));
    // The backup itself is untouched, and no copy of it is left in the data folder.
    expect(readFileSync(file, "utf8")).toBe(DB("from last week", 23));
    expect(readdirSync(path.join(s.dir, "data")).filter((f) => f.startsWith(".restore"))).toEqual([]);
    // The file went in through the inbox's own container, on its standard input.
    expect(calls()).toContain('--entrypoint sh inbox -c cat >"/opt/inbox/data/$1"');
  });

  it("keeps the last five backups made before a restore", async () => {
    installed();
    mkdirSync(path.join(s.dir, "data/backups"), { recursive: true });
    for (let day = 1; day <= 7; day++)
      writeFileSync(path.join(s.dir, `data/backups/inbox-2026100${day}T120000Z-before-restore.db`), "old");
    const file = path.join(s.root, "copy.db");
    writeFileSync(file, DB("from last week"));
    expect((await inbox("restore", file, "--yes")).code).toBe(0);
    expect(backups().filter((f) => f.endsWith("-before-restore.db"))).toHaveLength(5);
  });

  it("works on the real data folders only, never through a link", async () => {
    installed();
    symlinkSync(s.root, path.join(s.dir, "data/backups"));
    const r = await inbox("backup");
    expect(r.code).toBe(1);
    expect(r.err).toContain("is a symbolic link");
  });

  it("refuses what is not a database, and a backup from a newer version", async () => {
    installed();
    const text = path.join(s.root, "notes.txt");
    writeFileSync(text, "not a database");
    const notDb = await inbox("restore", text, "--yes");
    expect(notDb.code).toBe(1);
    expect(notDb.err).toContain("That file is not one to restore from: it is not an SQLite database.");
    const newer = path.join(s.root, "newer.db");
    writeFileSync(newer, DB("from a newer inbox", 30));
    const r = await inbox("restore", newer, "--yes");
    expect(r.code).toBe(1);
    expect(r.err).toContain("That backup was made by a newer version of the inbox than this one. Update first");
    expect(db()).toBe(DB("as it was"));
  });

  it("asks first, and with no terminal and no --yes changes nothing", async () => {
    installed();
    const file = path.join(s.root, "copy.db");
    writeFileSync(file, DB("from last week"));
    const r = await inbox("restore", file);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Run it again with --yes");
    expect(db()).toBe(DB("as it was"));
  });
});

describe("inbox sign-in, owner-key and status", { timeout: 60_000 }, () => {
  it("asks the inbox for a sign-in email, and shows its code and link", async () => {
    installed();
    s.set(
      "logs",
      [
        "Surfing Dog Inbox listening on http://0.0.0.0:8787",
        "sign-in email for owner@example.com written here, not sent: there is no address to send email from (set MAIL_FROM, or Send from in Settings)",
        "Sign in to your inbox",
        "Your sign-in code: 111111",
        "",
        "Or open this link and press Sign in:",
        "https://inbox.example.com/auth/verify?token=old",
        "",
        "The code and the link work once, for 15 minutes. If you did not ask to sign in, ignore this email.",
        // On Node with no email service the console stands in for one: the whole email, indented.
        "mail to owner@example.com: Sign in to Oficina Maré",
        "    Your sign-in code: 482913",
        "    ",
        "    Or open this link and press Sign in:",
        "    https://inbox.example.com/auth/verify?token=new",
        "    ",
        "    The code and the link work once, for 15 minutes. If you did not ask to sign in, ignore this email.",
        "",
      ].join("\n"),
    );
    const r = await inbox("sign-in");
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "Your sign-in code: 777777\nOr open: https://inbox.example.com/auth/verify?token=fresh777777",
    );
    expect(calls()).toContain("/auth/magic-link");
    // When the inbox does not take the request, the newest one in its log.
    s.set("no-magic", "");
    const last = await inbox("sign-in");
    expect(last.out).toContain("Your sign-in code: 777777");
    s.set(
      "logs",
      s.state
        ? (readFileSync(path.join(s.state, "logs"), "utf8").split(
            "mail to owner@example.com: Sign in to Oficina Maré\n    Your sign-in code: 777777",
          )[0] ?? "")
        : "",
    );
    const older = await inbox("sign-in");
    expect(older.out).toContain("Your sign-in code: 482913\nOr open: https://inbox.example.com/auth/verify?token=new");
    expect(older.out).not.toContain("111111");
    s.set("logs", "");
    expect((await inbox("sign-in")).err).toContain(
      "No sign-in email came. sudo inbox status says whether the inbox runs; then open https://inbox.example.com/login, enter owner@example.com, and run this again.",
    );
  });

  it("never shows what a customer wrote as the sign-in", async () => {
    installed();
    s.set("no-magic", "");
    s.set(
      "logs",
      [
        // An owner notification in console mode, about a customer's message that mimics a sign-in.
        "mail to owner@example.com: New message: Sign in to your account",
        "    Your sign-in code: 999999",
        "    https://evil.example/auth/verify?token=x",
        "    The code and the link work once, for 15 minutes.",
        "mail to someone@else.example: Sign in to Oficina Maré",
        "    Your sign-in code: 888888",
        "    The code and the link work once, for 15 minutes.",
        "mail to owner@example.com: Sign in to Oficina Maré",
        "    Your sign-in code: 482913",
        "    https://evil.example/auth/verify?token=y",
        "    https://inbox.example.com/auth/verify?token=real",
        "    The code and the link work once, for 15 minutes.",
        "",
      ].join("\n"),
    );
    const r = await inbox("sign-in");
    expect(r.out).toContain("Your sign-in code: 482913\nOr open: https://inbox.example.com/auth/verify?token=real");
    expect(r.out).not.toContain("evil.example");
    expect(r.out).not.toContain("999999");
    expect(r.out).not.toContain("888888");
  });

  it("makes an owner key, and says what runs", async () => {
    installed();
    const key = await inbox("owner-key", "laptop");
    expect(key.out.split("\n")[0]).toBe("sdi_own_stub_key_for_laptop");
    expect((await inbox("owner-key", "my laptop")).err).toContain("A key's name is letters, digits, dots and dashes.");
    s.set("latest", "0.2.0");
    const status = await inbox("status");
    expect(status.code).toBe(0);
    expect(status.out).toContain("https://inbox.example.com");
    expect(status.out).toContain("Running 0.1.0 (image ghcr.io/surfingdogai/inbox:0.1.0), and its database answers.");
    expect(status.out).toContain("The newest release is 0.2.0: sudo inbox update");
    expect(status.out).toContain("Email    not set up: sudo inbox email");
    // A pre-release of the next version is newer than the last release: nothing older is suggested.
    installed("0.2.0-rc.1");
    s.set("latest", "0.1.0");
    expect((await inbox("status")).out).not.toContain("The newest release is");
    s.set("latest", "0.2.0");
    expect((await inbox("status")).out).toContain("The newest release is 0.2.0: sudo inbox update");
  });

  it("lists the Cloudflare accounts a token can use, so nobody types an account ID", () => {
    installed();
    s.set(
      "cloudflare-accounts",
      JSON.stringify({
        success: true,
        result: [
          { id: "0123456789abcdef0123456789abcdef", name: "Oficina Maré" },
          { id: "not-an-id", name: "Odd" },
        ],
      }),
    );
    const out = execFileSync(SH, ["-c", `. "$0"; cloudflare_accounts token-123`, CLI], {
      env: {
        ...process.env,
        PATH: `${s.bin}:${process.env.PATH}`,
        SDI_INBOX_LIB: "1",
        STUB_STATE: s.state,
        STUB_NODE: process.execPath,
        INBOX_DIR: s.dir,
      },
      encoding: "utf8",
    });
    expect(out).toBe("0123456789abcdef0123456789abcdef\tOficina Maré\n");
    // The token went to curl on its standard input, not on a command line.
    expect(calls()).not.toContain("token-123");
  });

  it("restarts with the settings in .env, and runs Litestream's file with the rest", async () => {
    installed();
    expect((await inbox("restart")).code).toBe(0);
    expect(calls()).toContain("up -d --force-recreate inbox");
    writeFileSync(path.join(s.dir, "docker-compose.litestream.yml"), "services: {}\n");
    const file = path.join(s.root, "copy.db");
    writeFileSync(file, DB("from last week"));
    expect((await inbox("restore", file, "--yes")).code).toBe(0);
    const log = calls();
    expect(log).toContain(`-f ${s.dir}/docker-compose.litestream.yml`);
    // Stopped for the swap, and started again after it.
    const swap = log.indexOf("mv -f inbox.db.new inbox.db");
    expect(log.lastIndexOf("stop litestream", swap)).toBeGreaterThan(-1);
    expect(log.indexOf("up -d litestream", swap)).toBeGreaterThan(swap);
  });

  it("wants root and an installed inbox", async () => {
    installed();
    s.set("uid", "1000\n");
    expect((await inbox("status")).err).toContain("Run it as root: sudo inbox status");
    s.set("uid", "0\n");
    const elsewhere = await s.run(CLI, ["status"], { INBOX_DIR: path.join(s.root, "nowhere") });
    expect(elsewhere.err).toContain("No inbox is installed in");
    expect((await inbox("help")).out).toContain(
      "update [version]    the newest release, or that one; undone if it does not start",
    );
  });
});
