import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app";

/**
 * Node/Bun entry: the same app, plus static files from ./public. Runs with `pnpm dev`
 * (tsx watch) and, later, as a compiled single executable.
 */
const app = createApp();
app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Surfing Dog Inbox listening on http://localhost:${info.port}`);
});
