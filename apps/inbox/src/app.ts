import { type CallerEnv, mountDoors } from "@surfingdog/adapters";
import {
  buildManifest,
  Capabilities,
  type Db,
  MANIFEST_PATH,
  MIGRATIONS,
  readSettings,
  VERSION,
} from "@surfingdog/core";
import { ensureMigrated } from "@surfingdog/platform";
import { Hono } from "hono";

export interface AppDeps {
  readonly db: Db;
}

/**
 * The HTTP application, runtime-agnostic: the Worker and the Node server both mount this. Every
 * door (REST, OpenAPI, MCP) is registered by `mountDoors`; the manifest is generated from the
 * business profile so agents discover the doors from one small document.
 */
export function createApp(deps: AppDeps) {
  const app = new Hono<CallerEnv>();
  const caps = new Capabilities(deps.db);

  // Migrations run lazily on the first request after a deploy (ADR-007).
  app.use("*", async (_c, next) => {
    await ensureMigrated(deps.db.client, MIGRATIONS);
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true, version: VERSION }));

  app.get(MANIFEST_PATH, async (c) => {
    const origin = new URL(c.req.url).origin;
    const profile = await caps.getBusinessProfile();
    const manifest = buildManifest({
      instanceUrl: origin,
      itemTypes: profile.item_types,
      profile: profile.name ? { name: profile.name, languages: [...profile.languages], categories: [] } : undefined,
    });
    return c.json(manifest, 200, { "Cache-Control": "public, max-age=300" });
  });

  mountDoors(app, { db: deps.db, caps, version: VERSION, sandbox: async () => (await readSettings(deps.db)).testMode });

  app.notFound((c) => c.json({ error: "not_found", path: new URL(c.req.url).pathname }, 404));
  return app;
}

export type App = ReturnType<typeof createApp>;
