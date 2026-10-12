import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApiKey, ensureNetworkPing, pingNetworksNow, setOwnerEmail } from "@surfingdog/adapters";
import {
  type Caller,
  Capabilities,
  createDb,
  createSecretBox,
  ensureLifecycleSweep,
  MIGRATIONS,
  parseSecretKeys,
  type SetupPlanInput,
} from "@surfingdog/core";
import {
  cloudflareEmailRestMailOut,
  consoleMailOut,
  ensureMigrated,
  type MailOut,
  resendMailOut,
} from "@surfingdog/platform";
import { nodeSnapshot, nodeSqliteClient, pinnedFetch } from "@surfingdog/platform/node";
import { createInbox } from "./app";
import { flagOn } from "./demo";
import { listFrom, outboundDenyFrom, publicUrlFrom, secretKeyFrom, senderFrom } from "./env";
import { NODE_SERVER_OPTIONS } from "./node-server";
import { seedDemo, seedShowcase, seedSurfingDog } from "./seed";

/**
 * Node/Bun entry: the same app over the built-in SQLite, the owner app Vite builds into
 * ../dist/client (or INBOX_STATIC), and a one-second job loop. Any path that is neither a door nor
 * a file gets the app shell, like the Worker's `not_found_handling: "single-page-application"`.
 * INBOX_DB points at the database file (default ./data/inbox.db). Mail goes out through Cloudflare
 * Email Service (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_EMAIL_TOKEN + MAIL_FROM), else Resend
 * (RESEND_API_KEY), else the console. INBOX_OWNER_EMAIL (comma-separated) lists who may create the
 * first account by magic link. INBOX_SECRET_KEY (comma-separated, newest first) seals connector
 * credentials and webhook secrets; without it the instance refuses to store one. Every call to an
 * address someone else chose (webhooks, feeds, networks, OAuth client documents, key directories)
 * resolves the name first and connects only to a public address it checked; INBOX_OUTBOUND_DENY
 * (comma-separated addresses and ranges) closes more, such as the server's own public address.
 * INBOX_DEMO=1 makes it a public demo shop (demo.ts): it seeds itself, emails nobody but the owner,
 * calls no network, and wipes itself every night.
 *
 *   node server.mjs                    serve
 *   node server.mjs create-owner-key   print a new owner API key (first sign-in without email)
 *   node server.mjs set-owner-email <new> [<old>]
 *                                      the address the owner signs in with, for one who lost the old one
 *   node server.mjs seed-demo          add the demo bike shop if the instance is empty
 *   node server.mjs seed-showcase      the demo bike shop with a week of items, rules and hours (screenshots)
 *   node server.mjs seed-surfingdog    add Surfing Dog itself if the instance is empty
 *   node server.mjs network-ping       report to every network now instead of at the next hour
 *   node server.mjs apply-plan <file>  apply a setup plan (JSON); --dry-run says what it would do
 */
const file = process.env.INBOX_DB ?? path.join(process.cwd(), "data", "inbox.db");
mkdirSync(path.dirname(file), { recursive: true });
const client = nodeSqliteClient(file);
const db = createDb(client);
const publicUrl = publicUrlFrom(process.env.INBOX_PUBLIC_URL);
const from = senderFrom(process.env.MAIL_FROM, process.env.MAIL_FROM_NAME);

const command = process.argv[2];
if (command) {
  await ensureMigrated(db.client, MIGRATIONS);
  // Seeds confirm items, and a confirmed item earns a receipt when the host can sign one.
  const seedDeps = {
    receipts: new Capabilities(db, createSecretBox(parseSecretKeys(process.env.INBOX_SECRET_KEY)), publicUrl).receipts,
  };
  if (command === "create-owner-key") {
    const { key } = await createApiKey(db, { kind: "owner", name: process.argv[3] ?? "cli" });
    console.log(key);
  } else if (command === "set-owner-email") {
    if (!process.argv[3]) {
      console.error("usage: set-owner-email <new address> [<the owner's address now>]");
      process.exit(2);
    }
    try {
      const r = await setOwnerEmail(db, { to: process.argv[3], from: process.argv[4] });
      console.log(
        r.outcome === "moved"
          ? `the owner signs in with ${r.to} now, not ${r.from}; every session of theirs was signed out`
          : r.outcome === "first_owner"
            ? `nobody has signed in yet: ${r.to} may create the first account`
            : "that is the owner's address already; nothing changed",
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
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
  } else if (command === "apply-plan") {
    // A setup plan (capabilities/plan.ts), applied as the inbox itself; the sentences say what it did.
    const planFile = process.argv.slice(3).find((a) => !a.startsWith("--"));
    if (!planFile) {
      console.error("usage: apply-plan <plan.json> [--dry-run]");
      process.exit(2);
    }
    const system: Caller = {
      actor: { kind: "system", id: "apply-plan", channel: "system" },
      tier: "verified_principal",
      sandbox: false,
    };
    try {
      // Checked against the plan's schema by the capability: the file is only parsed here.
      const plan = JSON.parse(readFileSync(planFile, "utf8")) as SetupPlanInput;
      const r = await new Capabilities(db, null, publicUrl).applySetupPlan(system, plan, {
        dryRun: process.argv.includes("--dry-run"),
      });
      for (const sentence of r.sentences) console.log(sentence);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  } else {
    console.error(
      `unknown command ${command}; use create-owner-key, set-owner-email, seed-demo, seed-showcase, seed-surfingdog, network-ping or apply-plan`,
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
// No mail provider: the whole message goes to stdout, so a sign-in link can be copied from the terminal.
const mailOut: MailOut =
  process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_EMAIL_TOKEN && from
    ? cloudflareEmailRestMailOut({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        token: process.env.CLOUDFLARE_EMAIL_TOKEN,
        from,
      })
    : process.env.RESEND_API_KEY
      ? resendMailOut(process.env.RESEND_API_KEY, undefined, from)
      : consoleMailOut();
const ownerEmails = listFrom(process.env.INBOX_OWNER_EMAIL);
const demo = flagOn(process.env.INBOX_DEMO);
// A range the operator meant to close and mistyped would be open without a word, so it stops here.
const deny = outboundDenyFrom(process.env.INBOX_OUTBOUND_DENY);
if (deny.bad.length > 0) {
  console.error(
    `INBOX_OUTBOUND_DENY: ${deny.bad.join(", ")} is not an address or a range (like 203.0.114.7 or 2a01:4f8::/32); fix it to start`,
  );
  process.exit(1);
}
const { app, runner, prepare } = createInbox({
  db,
  mailOut,
  baseUrl: publicUrl,
  ownerEmails,
  secretKey: secretKeyFrom(process.env.INBOX_SECRET_KEY),
  demo: demo ? { ownerEmails, from } : undefined,
  fetchImpl: pinnedFetch({ deny: deny.ranges }),
  // Only for a webhook the owner allowed onto a private address; the ranges above still hold.
  privateFetchImpl: pinnedFetch({ deny: deny.ranges, allowPrivate: true }),
  // The owner can download the inbox: a copy of this file, without who is signed in or any secret.
  snapshot: nodeSnapshot(client),
});
if (demo) {
  // A demo only starts on an empty database. Over anything else it would mute the instance's mail
  // and serve nothing, so it does not start at all: the operator sees why at once.
  try {
    await prepare();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  console.log("Demo mode: the shop is seeded, nobody but the owner is emailed, and it is wiped every night.");
}

/** The doors answer these first; everything else that is not a file is the app. Same list as vite.config.ts. */
const DOOR_PREFIXES = [
  "/v1",
  "/mcp",
  "/auth",
  "/oauth",
  "/openapi.json",
  "/healthz",
  "/.well-known",
  "/c",
  "/p",
  "/demo",
];
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

const port = Number(process.env.PORT ?? 8787);
// Timeouts a client that trickles its request cannot outlast (node-server.ts).
serve(
  { fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0", serverOptions: NODE_SERVER_OPTIONS },
  (info) => {
    console.log(`Surfing Dog Inbox listening on http://${info.address}:${info.port} (database ${file})`);
  },
);
