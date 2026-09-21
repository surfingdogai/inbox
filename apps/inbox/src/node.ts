import { mkdirSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApiKey, ensureNetworkPing, NETWORK_PING_KIND } from "@surfingdog/adapters";
import { createDb, ensureJob, MIGRATIONS } from "@surfingdog/core";
import { ensureMigrated, logMailOut, resendMailOut } from "@surfingdog/platform";
import { nodeSqliteClient } from "@surfingdog/platform/node";
import { createInbox } from "./app";
import { seedDemo } from "./seed";

/**
 * Node/Bun entry: the same app over the built-in SQLite, plus static files from ./public and a
 * one-second job loop. INBOX_DB points at the database file (default ./data/inbox.db);
 * RESEND_API_KEY turns on real email, otherwise mail is logged.
 *
 *   node server.mjs                    serve
 *   node server.mjs create-owner-key   print a new owner API key (first sign-in without email)
 *   node server.mjs seed-demo          add the demo business if the instance is empty
 *   node server.mjs network-ping       report to the network now instead of at the next hour
 */
const file = process.env.INBOX_DB ?? path.join(process.cwd(), "data", "inbox.db");
mkdirSync(path.dirname(file), { recursive: true });
const db = createDb(nodeSqliteClient(file));

const command = process.argv[2];
if (command) {
  await ensureMigrated(db.client, MIGRATIONS);
  if (command === "create-owner-key") {
    const { key } = await createApiKey(db, { kind: "owner", name: process.argv[3] ?? "cli" });
    console.log(key);
  } else if (command === "seed-demo") {
    const r = await seedDemo(db);
    console.log(r.seeded ? "seeded the demo business" : "an instance business already exists; nothing changed");
  } else if (command === "network-ping") {
    await ensureJob(db, NETWORK_PING_KIND, `${NETWORK_PING_KIND}:manual:${Date.now()}`);
    console.log("queued a network ping; the running server sends it within a second");
  } else {
    console.error(`unknown command ${command}; use create-owner-key, seed-demo or network-ping`);
    process.exit(2);
  }
  process.exit(0);
}

// Migrate before the job loop starts, so a fresh database never sees a query for a missing table.
await ensureMigrated(db.client, MIGRATIONS);
await ensureNetworkPing(db);
const mailOut = process.env.RESEND_API_KEY ? resendMailOut(process.env.RESEND_API_KEY) : logMailOut(console.log);
const { app, runner } = createInbox({ db, mailOut, baseUrl: process.env.INBOX_PUBLIC_URL });
app.use("/*", serveStatic({ root: process.env.INBOX_STATIC ?? "./public" }));

const loop = setInterval(() => {
  runner.runDue(db, { workerId: `node:${process.pid}` }).catch((error) => console.error("jobs:", error));
}, 1_000);
loop.unref();

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, (info) => {
  console.log(`Surfing Dog Inbox listening on http://${info.address}:${info.port} (database ${file})`);
});
