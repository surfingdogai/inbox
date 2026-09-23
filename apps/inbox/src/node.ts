import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApiKey, ensureNetworkPing, pingNetworksNow } from "@surfingdog/adapters";
import {
  Capabilities,
  createDb,
  createSecretBox,
  ensureLifecycleSweep,
  MIGRATIONS,
  parseSecretKeys,
} from "@surfingdog/core";
import {
  cloudflareEmailRestMailOut,
  ensureMigrated,
  LOCAL_SENDER,
  type MailOut,
  resendMailOut,
} from "@surfingdog/platform";
import { nodeSqliteClient } from "@surfingdog/platform/node";
import { createInbox } from "./app";
import { seedDemo, seedShowcase, seedSurfingDog } from "./seed";

/**
 * Node/Bun entry: the same app over the built-in SQLite, the owner app Vite builds into
 * ../dist/client (or INBOX_STATIC), and a one-second job loop. Any path that is neither a door nor
 * a file gets the app shell, like the Worker's `not_found_handling: "single-page-application"`.
 * INBOX_DB points at the database file (default ./data/inbox.db). Mail goes out through Cloudflare
 * Email Service (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_EMAIL_TOKEN + MAIL_FROM), else Resend
 * (RESEND_API_KEY), else the console. INBOX_OWNER_EMAIL (comma-separated) lists who may create the
 * first account by magic link. INBOX_SECRET_KEY (comma-separated, newest first) seals connector
 * credentials and webhook secrets; without it the instance refuses to store one.
 *
 *   node server.mjs                    serve
 *   node server.mjs create-owner-key   print a new owner API key (first sign-in without email)
 *   node server.mjs seed-demo          add the demo bike shop if the instance is empty
 *   node server.mjs seed-showcase      the demo bike shop with a week of items, rules and hours (screenshots)
 *   node server.mjs seed-surfingdog    add Surfing Dog itself if the instance is empty
 *   node server.mjs network-ping       report to every network now instead of at the next hour
 */
const file = process.env.INBOX_DB ?? path.join(process.cwd(), "data", "inbox.db");
mkdirSync(path.dirname(file), { recursive: true });
const db = createDb(nodeSqliteClient(file));

const command = process.argv[2];
if (command) {
  await ensureMigrated(db.client, MIGRATIONS);
  // Seeds confirm items, and a confirmed item earns a receipt when the host can sign one.
  const seedDeps = {
    receipts: new Capabilities(
      db,
      createSecretBox(parseSecretKeys(process.env.INBOX_SECRET_KEY)),
      process.env.INBOX_PUBLIC_URL,
    ).receipts,
  };
  if (command === "create-owner-key") {
    const { key } = await createApiKey(db, { kind: "owner", name: process.argv[3] ?? "cli" });
    console.log(key);
  } else if (command === "seed-demo") {
    const r = await seedDemo(db, Date.now(), seedDeps);
    console.log(r.seeded ? "seeded the demo business" : "an instance business already exists; nothing changed");
  } else if (command === "seed-showcase") {
    const r = await seedShowcase(db, Date.now(), seedDeps);
    console.log(
      r.seeded ? `seeded the showcase: ${r.items} items` : "an instance business already exists; nothing changed",
    );
  } else if (command === "seed-surfingdog") {
    const r = await seedSurfingDog(db, Date.now(), seedDeps);
    console.log(r.seeded ? "seeded Surfing Dog's own inbox" : "an instance business already exists; nothing changed");
  } else if (command === "network-ping") {
    await pingNetworksNow(db);
    console.log("queued a ping to every network that is on; the running server sends them within a second");
  } else {
    console.error(
      `unknown command ${command}; use create-owner-key, seed-demo, seed-showcase, seed-surfingdog or network-ping`,
    );
    process.exit(2);
  }
  process.exit(0);
}

// Migrate before the job loop starts, so a fresh database never sees a query for a missing table.
await ensureMigrated(db.client, MIGRATIONS);
await ensureNetworkPing(db);
// The quarter-hourly lifecycle sweep (ADR-017 §3.1) queues its own successor from here on.
await ensureLifecycleSweep(db);
const mailOut: MailOut =
  process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_EMAIL_TOKEN && process.env.MAIL_FROM
    ? cloudflareEmailRestMailOut({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        token: process.env.CLOUDFLARE_EMAIL_TOKEN,
        from: { address: process.env.MAIL_FROM, name: process.env.MAIL_FROM_NAME },
      })
    : process.env.RESEND_API_KEY
      ? resendMailOut(process.env.RESEND_API_KEY)
      : consoleMailOut();
const ownerEmails = (process.env.INBOX_OWNER_EMAIL ?? "")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);
const { app, runner } = createInbox({
  db,
  mailOut,
  baseUrl: process.env.INBOX_PUBLIC_URL,
  ownerEmails,
  secretKey: process.env.INBOX_SECRET_KEY,
});

/** The doors answer these first; everything else that is not a file is the app. Same list as vite.config.ts. */
const DOOR_PREFIXES = ["/v1", "/mcp", "/auth", "/oauth", "/openapi.json", "/healthz", "/.well-known", "/c"];
const isDoor = (p: string) => DOOR_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));

const clientDir = process.env.INBOX_STATIC ?? path.resolve(import.meta.dirname, "../dist/client");
if (existsSync(clientDir)) {
  app.use("/*", serveStatic({ root: clientDir }));
  const shell = serveStatic({ root: clientDir, path: "index.html" });
  app.get("/*", (c, next) => (isDoor(c.req.path) ? next() : shell(c, next)));
} else {
  console.warn(`No client build at ${clientDir}. Run "pnpm build:client", or "pnpm dev:client" for the dev server.`);
}

const loop = setInterval(() => {
  runner.runDue(db, { workerId: `node:${process.pid}` }).catch((error) => console.error("jobs:", error));
}, 1_000);
loop.unref();

/**
 * No mail provider: the whole message goes to stdout, so a sign-in link can be copied from the
 * terminal. A customer's network key or pass is not the operator's to copy: its secret is cut.
 */
function consoleMailOut(): MailOut {
  return {
    // Nothing leaves this machine, so a message with no sender of its own can still be shown, and
    // the mail log never records it as sent.
    sender: LOCAL_SENDER,
    delivers: false,
    async send(mail) {
      const body = mail.text
        .replace(/\b(sd(?:key|pass)1_[a-z0-9.-]+_[a-z2-7]{16}_)[a-z2-7]{32}\b/g, "$1…")
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n");
      const headers = Object.entries(mail.headers ?? {})
        .map(([k, v]) => `    ${k}: ${v}\n`)
        .join("");
      console.log(`mail to ${mail.to.join(", ")}: ${mail.subject}\n${headers}${body}`);
      return { messageId: `console-${crypto.randomUUID()}` };
    },
  };
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, (info) => {
  console.log(`Surfing Dog Inbox listening on http://${info.address}:${info.port} (database ${file})`);
});
