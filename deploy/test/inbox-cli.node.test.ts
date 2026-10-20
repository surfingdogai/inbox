import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLI, DB, repo, type Server, server } from "./harness";

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
    expect(r.out).toContain("Updated: 0.1.0 → 0.2.0 (it reports 0.1.0). The data as it was before is in");
    expect(version()).toBe("0.2.0");
    const before = backups().find((f) => f.endsWith("-before-0.2.0.db"));
    expect(before).toBeDefined();
    expect(readFileSync(path.join(s.dir, "data/backups", before ?? ""), "utf8")).toBe(DB("as it was"));
    expect(readFileSync(path.join(s.dir, "data/backups/last-update"), "utf8")).toBe(
      `version=0.1.0\nbackup=${before}\n`,
    );
    const calls = readFileSync(path.join(s.state, "calls"), "utf8");
    // Stopped, then backed up by a one-off container: nothing written between the two is lost.
    expect(calls.indexOf(" stop inbox")).toBeLessThan(
      calls.indexOf("run --rm --no-deps -T inbox node /opt/inbox/server.mjs backup"),
    );
    expect((await inbox("update", "0.2.0")).out).toContain("Already on 0.2.0.");
  });

  it("rolls back to the version and the data of before when the new one does not start", async () => {
    installed("0.1.0");
    s.set("migrates", "");
    s.set("broken", "0.2.0\n");
    const r = await inbox("update", "0.2.0");
    expect(r.code).toBe(1);
    expect(r.err).toContain("0.2.0 did not start. Rolling back to 0.1.0, with the data as it was.");
    expect(r.err).toMatch(
      /Rolled back to 0\.1\.0; nothing was lost\. What 0\.2\.0 said is in \S+update-0\.2\.0-\d{8}T\d{6}Z\.log/,
    );
    expect(version()).toBe("0.1.0");
    // What the broken version wrote is gone; the rollback's own start writes its line on top.
    expect(db()).not.toContain("migrated-by-0.2.0");
    expect(db().startsWith(DB("as it was"))).toBe(true);
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
  it("shows the code and the link of the last sign-in email in the log", async () => {
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
    expect(r.out).toContain("Your sign-in code: 482913\nOr open: https://inbox.example.com/auth/verify?token=new");
    expect(r.out).not.toContain("111111");
    s.set("logs", "");
    expect((await inbox("sign-in")).out).toContain(
      "No sign-in email in the last day. Open https://inbox.example.com/login, enter owner@example.com, then run this again.",
    );
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
  });

  it("wants root and an installed inbox", async () => {
    installed();
    s.set("uid", "1000\n");
    expect((await inbox("status")).err).toContain("Run it as root: sudo inbox status");
    s.set("uid", "0\n");
    const elsewhere = await s.run(CLI, ["status"], { INBOX_DIR: path.join(s.root, "nowhere") });
    expect(elsewhere.err).toContain("No inbox is installed in");
    expect((await inbox("help")).out).toContain(
      "update [version]    the newest release, or that one; rolled back if it does not start",
    );
  });
});
