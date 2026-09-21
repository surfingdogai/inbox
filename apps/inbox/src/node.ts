import { mkdirSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createDb } from "@surfingdog/core";
import { nodeSqliteClient } from "@surfingdog/platform/node";
import { createApp } from "./app";

/**
 * Node/Bun entry: the same app over the built-in SQLite, plus static files from ./public.
 * INBOX_DB points at the database file (default ./data/inbox.db).
 */
const file = process.env.INBOX_DB ?? path.join(process.cwd(), "data", "inbox.db");
mkdirSync(path.dirname(file), { recursive: true });
const app = createApp({ db: createDb(nodeSqliteClient(file)) });
app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Surfing Dog Inbox listening on http://localhost:${info.port} (database ${file})`);
});
