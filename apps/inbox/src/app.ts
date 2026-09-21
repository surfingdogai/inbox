import {
  type CallerEnv,
  type ClientMetadata,
  mountDoors,
  NETWORK_PING_KIND,
  networkPingHandler,
  publicOrigin,
} from "@surfingdog/adapters";
import {
  buildManifest,
  Capabilities,
  createRunner,
  type Db,
  type JobRunner,
  MANIFEST_PATH,
  MIGRATIONS,
  readSettings,
  VERSION,
} from "@surfingdog/core";
import { ensureMigrated, logMailOut, type MailOut } from "@surfingdog/platform";
import { Hono } from "hono";

export interface AppDeps {
  readonly db: Db;
  /** Outbound mail; defaults to a logger, which is right for development and tests. */
  readonly mailOut?: MailOut | undefined;
  /** Public base URL for links in emails; derived from the request when absent. */
  readonly baseUrl?: string | undefined;
  /** Outbound fetch for the network ping (tests inject a fake). */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Runs work after the response. Workers pass `ctx.waitUntil`; Node lets the loop pick it up. */
  readonly background?: ((work: Promise<unknown>) => void) | undefined;
  /** Test seam for Client ID Metadata Documents. */
  readonly fetchClientMetadata?: ((url: string) => Promise<ClientMetadata | null>) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface Inbox {
  readonly app: Hono<CallerEnv>;
  readonly runner: JobRunner;
  readonly caps: Capabilities;
}

/**
 * The HTTP application, runtime-agnostic: the Worker and the Node server both mount this. Every
 * door (REST, OpenAPI, MCP) is registered by `mountDoors`; the manifest is generated from the
 * business profile so agents discover the doors from one small document. Mutating requests kick
 * the job runner so notifications and rules follow within the same second.
 */
export function createInbox(deps: AppDeps): Inbox {
  const app = new Hono<CallerEnv>();
  const caps = new Capabilities(deps.db);
  const mailOut = deps.mailOut ?? logMailOut();
  const runner = createRunner({ mailOut, baseUrl: deps.baseUrl }).register(
    NETWORK_PING_KIND,
    networkPingHandler({ baseUrl: deps.baseUrl, version: VERSION, fetchImpl: deps.fetchImpl }),
  );
  const background = deps.background ?? ((work) => void work.catch(() => {}));

  // Migrations run lazily on the first request after a deploy (ADR-007).
  app.use("*", async (c, next) => {
    await ensureMigrated(deps.db.client, MIGRATIONS);
    await next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.method !== "OPTIONS") {
      const work = runner.runDue(deps.db, { workerId: "request" });
      try {
        c.executionCtx.waitUntil(work);
      } catch {
        background(work);
      }
    }
  });

  app.get("/healthz", (c) => c.json({ ok: true, version: VERSION }));

  app.get(MANIFEST_PATH, async (c) => {
    const origin = publicOrigin(c.req.raw, deps.baseUrl);
    const profile = await caps.getBusinessProfile();
    const manifest = buildManifest({
      instanceUrl: origin,
      itemTypes: profile.item_types,
      profile: profile.name ? { name: profile.name, languages: [...profile.languages], categories: [] } : undefined,
    });
    return c.json(manifest, 200, { "Cache-Control": "public, max-age=300" });
  });

  mountDoors(app, {
    db: deps.db,
    caps,
    baseUrl: deps.baseUrl,
    version: VERSION,
    sandbox: async () => (await readSettings(deps.db)).testMode,
    mailOut,
    businessName: async () => (await caps.getBusinessProfile()).name,
    fetchClientMetadata: deps.fetchClientMetadata,
    now: deps.now,
    inboundEmailSecret: async () => (await readSettings(deps.db)).email.inboundSecret ?? null,
  });

  app.notFound((c) => c.json({ error: "not_found", path: new URL(c.req.url).pathname }, 404));
  return { app, runner, caps };
}

/** The app alone, for tests and simple hosts. */
export function createApp(deps: AppDeps): Hono<CallerEnv> {
  return createInbox(deps).app;
}

export type App = ReturnType<typeof createApp>;
