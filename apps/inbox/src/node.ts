import { mkdirSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createDb } from "@surfingdog/core";
import { logMailOut, resendMailOut } from "@surfingdog/platform";
import { nodeSqliteClient } from "@surfingdog/platform/node";
import { createInbox } from "./app";

/**
 * Node/Bun entry: the same app over the built-in SQLite, plus static files from ./public and a
 * one-second job loop. INBOX_DB points at the database file (default ./data/inbox.db);
 * RESEND_API_KEY turns on real email, otherwise mail is logged.
 */
const file = process.env.INBOX_DB ?? path.join(process.cwd(), "data", "inbox.db");
mkdirSync(path.dirname(file), { recursive: true });
const db = createDb(nodeSqliteClient(file));
const mailOut = process.env.RESEND_API_KEY ? resendMailOut(process.env.RESEND_API_KEY) : logMailOut(console.log);
const { app, runner } = createInbox({ db, mailOut, baseUrl: process.env.INBOX_PUBLIC_URL });
app.use("/*", serveStatic({ root: "./public" }));

const loop = setInterval(() => {
  runner.runDue(db, { workerId: `node:${process.pid}` }).catch((error) => console.error("jobs:", error));
}, 1_000);
loop.unref();

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Surfing Dog Inbox listening on http://localhost:${info.port} (database ${file})`);
});
