import { buildManifest, MANIFEST_PATH, VERSION } from "@surfingdog/core";
import { Hono } from "hono";

/**
 * The HTTP application. Runtime-agnostic: the same Hono app is mounted by the Cloudflare Worker
 * (`worker.ts`) and by the Node/Bun server (`node.ts`). Anything that needs a platform service
 * (database, blobs, jobs, mail) goes through `@surfingdog/platform`, never through a runtime API.
 */
export function createApp() {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true, version: VERSION }));

  // Discovery: the instance manifest agents read first. Content is generated from settings
  // later; for now it describes what the scaffold can do (nothing) with the final shape.
  app.get(MANIFEST_PATH, (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(buildManifest({ instanceUrl: origin }), 200, {
      "Cache-Control": "public, max-age=300",
    });
  });

  app.notFound((c) => c.json({ error: "not_found", path: new URL(c.req.url).pathname }, 404));

  return app;
}

export type App = ReturnType<typeof createApp>;
