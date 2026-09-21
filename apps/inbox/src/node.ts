import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApiKey, ensureNetworkPing, NETWORK_PING_KIND } from "@surfingdog/adapters";
import { createDb, ensureJob, MIGRATIONS } from "@surfingdog/core";
import { ensureMigrated, logMailOut, resendMailOut } from "@surfingdog/platform";
import { nodeSqliteClient } from "@surfingdog/platform/node";
import { createInbox } from "./app";
import { seedDemo, seedSurfingDog } from "./seed";

/**
 * Node/Bun entry: the same app over the built-in SQLite, the owner app Vite builds into
 * ../dist/client (or INBOX_STATIC), and a one-second job loop. Any path that is neither a door nor
 * a file gets the app shell, like the Worker's `not_found_handling: "single-page-application"`.
 * INBOX_DB points at the database file (default ./data/inbox.db); RESEND_API_KEY turns on real
 * email, otherwise mail is logged.
 *
 *   node server.mjs                    serve
 *   node server.mjs create-owner-key   print a new owner API key (first sign-in without email)
 *   node server.mjs seed-demo          add the demo bike shop if the instance is empty
 *   node server.mjs seed-surfingdog    add Surfing Dog itself if the instance is empty
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
  } else if (command === "seed-surfingdog") {
    const r = await seedSurfingDog(db);
    console.log(r.seeded ? "seeded Surfing Dog's own inbox" : "an instance business already exists; nothing changed");
  } else if (command === "network-ping") {
    await ensureJob(db, NETWORK_PING_KIND, `${NETWORK_PING_KIND}:manual:${Date.now()}`);
    console.log("queued a network ping; the running server sends it within a second");
  } else {
    console.error(`unknown command ${command}; use create-owner-key, seed-demo, seed-surfingdog or network-ping`);
    process.exit(2);
  }
  process.exit(0);
}

// Migrate before the job loop starts, so a fresh database never sees a query for a missing table.
await ensureMigrated(db.client, MIGRATIONS);
await ensureNetworkPing(db);
const mailOut = process.env.RESEND_API_KEY ? resendMailOut(process.env.RESEND_API_KEY) : logMailOut(console.log);
const { app, runner } = createInbox({ db, mailOut, baseUrl: process.env.INBOX_PUBLIC_URL });

/** The doors answer these first; everything else that is not a file is the app. Same list as vite.config.ts. */
const DOOR_PREFIXES = ["/v1", "/mcp", "/auth", "/oauth", "/openapi.json", "/healthz", "/.well-known"];
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
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, (info) => {
  console.log(`Surfing Dog Inbox listening on http://${info.address}:${info.port} (database ${file})`);
});
