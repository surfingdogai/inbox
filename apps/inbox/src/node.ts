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
  importReceiptKeys,
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
import { isDoor } from "./doors";
import {
  jobToolsFrom,
  listFrom,
  oauthFrom,
  outboundDenyFrom,
  posFrom,
  publicUrlFrom,
  secretKeyFrom,
  senderFrom,
} from "./env";
import { commandDatabaseRefusal, DEFAULT_HOST, NODE_SERVER_OPTIONS } from "./node-server";
import { seedDemo, seedShowcase, seedSurfingDog } from "./seed";

/**
 * Node/Bun entry: the same app over the built-in SQLite, the owner app Vite builds into
 * ../dist/client (or INBOX_STATIC), and a one-second job loop. Any path that is neither a door nor
 * a file gets the app shell, like the Worker's `not_found_handling: "single-page-application"`.
 * It listens on HOST (default 127.0.0.1: behind the proxy that terminates TLS, never around it;
 * the Docker image sets 0.0.0.0) and PORT (default 8787).
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
 *
 * A command runs against the instance's database and says which one, on stderr. Run it with the
 * instance's settings (`node --env-file=/opt/inbox/.env server.mjs <command>`), so INBOX_DB names
 * that database: without INBOX_DB it uses ./data/inbox.db only when that file already exists, and
 * never creates a new one there, where a key it printed would open nothing.
 *
 *   node server.mjs create-owner-key   print a new owner API key (first sign-in without email)
 *   node server.mjs set-owner-email <new> [<old>]
 *                                      the address the owner signs in with, for one who lost the old one
 *   node server.mjs seed-demo          add the demo bike shop if the instance is empty
 *   node server.mjs seed-showcase      the demo bike shop with a week of items, rules and hours (screenshots)
 *   node server.mjs seed-surfingdog    add Surfing Dog itself if the instance is empty
 *   node server.mjs network-ping       report to every network now instead of at the next hour
 *   node server.mjs apply-plan <file>  apply a setup plan (JSON); --dry-run says what it would do
 *   node server.mjs import-receipt-keys <file>
 *                                      take in the receipt-keys.json of a download, sealed with this
 *                                      instance's INBOX_SECRET_KEY, so receipts are signed as before
 */
const file = process.env.INBOX_DB ?? path.join(process.cwd(), "data", "inbox.db");
const command = process.argv[2];
if (command) {
  const refusal = commandDatabaseRefusal(file, process.env.INBOX_DB, command);
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }
  console.error(`database: ${file}`);
}
mkdirSync(path.dirname(file), { recursive: true });
const client = nodeSqliteClient(file);
const db = createDb(client);
const publicUrl = publicUrlFrom(process.env.INBOX_PUBLIC_URL);
const from = senderFrom(process.env.MAIL_FROM, process.env.MAIL_FROM_NAME);

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
  } else if (command === "import-receipt-keys") {
    const keyFile = process.argv[3];
    if (!keyFile) {
      console.error("usage: import-receipt-keys <receipt-keys.json>");
      process.exit(2);
    }
    const box = createSecretBox(parseSecretKeys(process.env.INBOX_SECRET_KEY));
    if (!box) {
      console.error("set INBOX_SECRET_KEY first: the key is sealed with it, and is never stored in the clear");
      process.exit(2);
    }
    try {
      const r = await importReceiptKeys(db, box, JSON.parse(readFileSync(keyFile, "utf8")));
      const n = (list: readonly string[]) => `${list.length} key${list.length === 1 ? "" : "s"}`;
      console.log(
        [
          r.imported.length ? `took in ${n(r.imported)}` : "no key was new here",
          r.already.length ? `${n(r.already)} already here` : "",
          r.active ? `receipts are signed with ${r.active} from now on` : "",
          r.retired.length ? `retired ${r.retired.join(", ")} (its receipts still verify)` : "",
        ]
          .filter(Boolean)
          .join("; "),
      );
      console.log(`${keyFile} can be deleted now: the key is sealed in the database.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  } else {
    console.error(
      `unknown command ${command}; use create-owner-key, set-owner-email, seed-demo, seed-showcase, seed-surfingdog, network-ping, apply-plan or import-receipt-keys`,
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
  // The platforms' OAuth clients of whoever runs this server (Google's, and a one-click sign-in beside a
  // shop's own keys): "set up" without one.
  ...oauthFrom({
    GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    GOOGLE_OAUTH_TESTING: process.env.GOOGLE_OAUTH_TESTING,
    SHOPIFY_CLIENT_ID: process.env.SHOPIFY_CLIENT_ID,
    SHOPIFY_CLIENT_SECRET: process.env.SHOPIFY_CLIENT_SECRET,
    SQUARE_CLIENT_ID: process.env.SQUARE_CLIENT_ID,
    SQUARE_CLIENT_SECRET: process.env.SQUARE_CLIENT_SECRET,
    CALENDLY_CLIENT_ID: process.env.CALENDLY_CLIENT_ID,
    CALENDLY_CLIENT_SECRET: process.env.CALENDLY_CLIENT_SECRET,
    SERVICEM8_CLIENT_ID: process.env.SERVICEM8_CLIENT_ID,
    SERVICEM8_CLIENT_SECRET: process.env.SERVICEM8_CLIENT_SECRET,
    JOBBER_CLIENT_ID: process.env.JOBBER_CLIENT_ID,
    JOBBER_CLIENT_SECRET: process.env.JOBBER_CLIENT_SECRET,
  }),
  ...jobToolsFrom({
    JOBBER_API_VERSION: process.env.JOBBER_API_VERSION,
    JOB_TOOLS_CLEARED: process.env.JOB_TOOLS_CLEARED,
  }),
  ...posFrom({
    TOAST_CLIENT_ID: process.env.TOAST_CLIENT_ID,
    TOAST_CLIENT_SECRET: process.env.TOAST_CLIENT_SECRET,
    TOAST_API_HOST: process.env.TOAST_API_HOST,
    LIGHTSPEED_CLIENT_ID: process.env.LIGHTSPEED_CLIENT_ID,
    LIGHTSPEED_CLIENT_SECRET: process.env.LIGHTSPEED_CLIENT_SECRET,
    CLOVER_CLIENT_ID: process.env.CLOVER_CLIENT_ID,
    CLOVER_CLIENT_SECRET: process.env.CLOVER_CLIENT_SECRET,
    DELIVERECT_CLIENT_ID: process.env.DELIVERECT_CLIENT_ID,
    DELIVERECT_CLIENT_SECRET: process.env.DELIVERECT_CLIENT_SECRET,
    DELIVERECT_CHANNEL: process.env.DELIVERECT_CHANNEL,
    DELIVERECT_STAGING: process.env.DELIVERECT_STAGING,
  }),
  // Only for a webhook the owner allowed onto a private address; the ranges above still hold.
  privateFetchImpl: pinnedFetch({ deny: deny.ranges, allowPrivate: true }),
  // The owner can download the inbox: a copy of this file, without who is signed in or any secret,
  // made beside it, on a disk known to have room for it (the system's temporary directory is often
  // a small tmpfs held in memory).
  snapshot: nodeSnapshot(client, path.dirname(file)),
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
// Timeouts a client that trickles its request cannot outlast (node-server.ts). Loopback unless HOST
// says otherwise: a server reachable around its proxy would take a client's own CF-Connecting-IP.
serve(
  { fetch: app.fetch, port, hostname: process.env.HOST || DEFAULT_HOST, serverOptions: NODE_SERVER_OPTIONS },
  (info) => {
    console.log(`Surfing Dog Inbox listening on http://${info.address}:${info.port} (database ${file})`);
  },
);
