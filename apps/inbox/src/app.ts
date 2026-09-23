import {
  type CallerEnv,
  type ClientMetadata,
  FEED_IMPORT_KIND,
  feedImportHandler,
  mountDoors,
  NETWORK_PING_KIND,
  NETWORK_PING_ONE_KIND,
  NETWORK_PUBLISH_KIND,
  NETWORK_RECEIPT_KIND,
  networkPingHandler,
  networkPingOneHandler,
  networkPublishHandler,
  networkReceiptHandler,
  publicOrigin,
  WEBHOOK_DELIVERY_KIND,
  WEBHOOK_FANOUT_KIND,
  webhookDeliverHandler,
  webhookFanoutHandler,
} from "@surfingdog/adapters";
import {
  buildManifest,
  Capabilities,
  createRunner,
  createSecretBox,
  type Db,
  enabledNetworks,
  type JobRunner,
  MANIFEST_PATH,
  MIGRATIONS,
  networkLane,
  parseSecretKeys,
  readSettings,
  VERSION,
} from "@surfingdog/core";
import { ensureMigrated, logMailOut, type MailOut } from "@surfingdog/platform";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

export interface AppDeps {
  readonly db: Db;
  /** Outbound mail; defaults to a logger, which is right for development and tests. */
  readonly mailOut?: MailOut | undefined;
  /** Public base URL for links in emails; derived from the request when absent. */
  readonly baseUrl?: string | undefined;
  /** Outbound fetch for the network ping (tests inject a fake). */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Addresses that may create the first account by magic link (INBOX_OWNER_EMAIL). */
  readonly ownerEmails?: readonly string[] | undefined;
  /**
   * INBOX_SECRET_KEY: one key, or several comma-separated and newest first, that seal connector
   * credentials and webhook secrets. Absent, the instance runs as it does today and refuses to
   * store a secret (ADR-015 §2).
   */
  readonly secretKey?: string | undefined;
  /** Runs work after the response. Workers pass `ctx.waitUntil`; Node lets the loop pick it up. */
  readonly background?: ((work: Promise<unknown>) => void) | undefined;
  /** Test seam for Client ID Metadata Documents. */
  readonly fetchClientMetadata?: ((url: string) => Promise<ClientMetadata | null>) | undefined;
  readonly now?: (() => number) | undefined;
  /**
   * How far behind live `GET /v1/owner/events` reads, in milliseconds (default `EVENT_SETTLE_MS`).
   * Only a test that writes an event and polls for it in the same tick ever passes zero.
   */
  readonly eventSettleMs?: number | undefined;
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
  const caps = new Capabilities(
    deps.db,
    createSecretBox(parseSecretKeys(deps.secretKey)),
    deps.baseUrl,
    deps.eventSettleMs,
  );
  const mailOut = deps.mailOut ?? logMailOut();
  const network = { baseUrl: deps.baseUrl, version: VERSION, fetchImpl: deps.fetchImpl };
  const runner = createRunner({ mailOut, baseUrl: deps.baseUrl, receipts: caps.receipts })
    // Networks (ADR-017 §8.1): the hourly tick does the housekeeping and queues the rest; every
    // call to a network runs in that network's own lane, so a slow one never delays another.
    .register(NETWORK_PING_KIND, networkPingHandler(network))
    .register(NETWORK_PING_ONE_KIND, networkPingOneHandler(network), { lane: networkLane })
    .register(NETWORK_PUBLISH_KIND, networkPublishHandler(network), { lane: networkLane })
    .register(NETWORK_RECEIPT_KIND, networkReceiptHandler(network), { lane: networkLane })
    // Outbound webhooks (ADR-015): fanout is gated on there being an active endpoint, so these two
    // handlers cost an instance with no integrations nothing but their registration.
    .register(WEBHOOK_FANOUT_KIND, webhookFanoutHandler())
    .register(
      WEBHOOK_DELIVERY_KIND,
      webhookDeliverHandler({
        secrets: caps.secrets,
        version: VERSION,
        baseUrl: deps.baseUrl,
        fetchImpl: deps.fetchImpl,
      }),
    )
    // Product feeds (ADR-015 §7.3). An instance with no feed connected never enqueues one.
    .register(FEED_IMPORT_KIND, feedImportHandler({ caps, fetchImpl: deps.fetchImpl }));
  const background = deps.background ?? ((work) => void work.catch(() => {}));

  // Security headers on every response, owner app and API alike, set here rather than in a proxy
  // so every self-hoster gets them whatever sits in front. Each one is chosen, not defaulted: Hono's
  // defaults include Cross-Origin-Resource-Policy: same-origin, which blocks legitimate cross-origin
  // loads, and Cross-Origin-Opener-Policy, which can break the OAuth window Claude and ChatGPT open
  // to connect to the owner MCP. The CSP carries only frame-ancestors, so it forbids framing — the
  // clickjacking defence for the owner app — and cannot break a single script or style.
  app.use(
    "*",
    secureHeaders({
      strictTransportSecurity: "max-age=15552000",
      xFrameOptions: "DENY",
      contentSecurityPolicy: { frameAncestors: ["'none'"] },
      xContentTypeOptions: "nosniff",
      referrerPolicy: "strict-origin-when-cross-origin",
      crossOriginResourcePolicy: false,
      crossOriginOpenerPolicy: false,
      crossOriginEmbedderPolicy: false,
      originAgentCluster: false,
      xDnsPrefetchControl: false,
      xDownloadOptions: false,
      xPermittedCrossDomainPolicies: false,
      xXssProtection: "0",
    }),
  );

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
    const [profile, jwks, settings] = await Promise.all([
      caps.getBusinessProfile(),
      caps.receipts.jwks(),
      readSettings(deps.db),
    ]);
    const manifest = buildManifest({
      instanceUrl: origin,
      itemTypes: profile.item_types,
      profile: profile.name ? { name: profile.name, languages: [...profile.languages], categories: [] } : undefined,
      receiptKeys: jwks.keys as unknown as Record<string, unknown>[],
      // The services this instance publishes receipts to: every network switched on that takes them.
      reviewServices: enabledNetworks(settings, "receipts"),
    });
    return c.json(manifest, 200, { "Cache-Control": "public, max-age=300" });
  });

  // The receipt-signing keys as a plain JWKS (ADR-016), for anything that verifies a JWS the
  // usual way. The same keys sit in the manifest under `receipt_keys`; this is the shorter path.
  app.get("/.well-known/jwks.json", async (c) =>
    c.json(await caps.receipts.jwks(), 200, { "Cache-Control": "public, max-age=300" }),
  );

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
    ownerEmails: async () => {
      const fromSettings = (await readSettings(deps.db)).notifications.ownerEmail;
      return [...(deps.ownerEmails ?? []), ...(fromSettings ? [fromSettings] : [])];
    },
  });

  app.notFound((c) => c.json({ error: "not_found", path: new URL(c.req.url).pathname }, 404));
  return { app, runner, caps };
}

/** The app alone, for tests and simple hosts. */
export function createApp(deps: AppDeps): Hono<CallerEnv> {
  return createInbox(deps).app;
}

export type App = ReturnType<typeof createApp>;
