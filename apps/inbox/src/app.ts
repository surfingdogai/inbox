import {
  type CallerEnv,
  type ClientMetadata,
  createIdentityPort,
  DEMO_LIMITS,
  DEMO_SHARED,
  FEED_IMPORT_KIND,
  feedImportHandler,
  identityIssueHandler,
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
  IDENTITY_ISSUE_KIND,
  type JobRunner,
  MANIFEST_PATH,
  MIGRATIONS,
  networkLane,
  parseSecretKeys,
  readSettings,
  VERSION,
} from "@surfingdog/core";
import { ensureMigrated, logMailOut, type MailOut } from "@surfingdog/platform";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import {
  DEMO_MAX_BODY,
  DEMO_NIGHTLY_KIND,
  DEMO_REFUSED,
  type DemoOptions,
  demoNightlyHandler,
  demoRoutes,
  ensureDemo,
  noNetworkFetch,
  noNetworkHandler,
  noWebhookHandler,
  ownerOnlyMailOut,
  silentMailOut,
} from "./demo";

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
  /**
   * A public demo shop (INBOX_DEMO=1, demo.ts): no customer is ever emailed, no network is ever
   * called, rules confirm bookings and accept small orders, limits are tighter, the shop is wiped
   * and seeded every night, and `/demo/live` shows what is happening. Absent, none of this exists.
   */
  readonly demo?: DemoOptions | undefined;
}

export interface Inbox {
  readonly app: Hono<CallerEnv>;
  readonly runner: JobRunner;
  readonly caps: Capabilities;
  /**
   * Gets the instance ready before it serves: in a demo, seeds the shop when the database is empty
   * and queues the nightly run. Nothing to do otherwise. Safe to call on every boot and every cron
   * tick. In a demo over a database that already holds anything, it throws `DEMO_REFUSED`.
   */
  readonly prepare: () => Promise<void>;
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
  const demo = deps.demo;
  const transport = deps.mailOut ?? logMailOut();
  // A demo emails nobody but its owner (demo.ts): every customer email, reply, code and per-item
  // alert goes to a transport that delivers nothing, and a sign-in link only ever to the owner.
  const mailOut = demo ? silentMailOut() : transport;
  const ownerMail = demo ? ownerOnlyMailOut(transport, demo.ownerEmails, console.log, demo.from) : transport;
  const network = {
    baseUrl: deps.baseUrl,
    version: VERSION,
    // A demo speaks to no network, whatever its settings say.
    fetchImpl: demo ? noNetworkFetch : deps.fetchImpl,
    // The hourly ping is signed with the receipt key when there is one (ADR-017 §7.3), and is then
    // answered with the business's own standing at each network.
    instanceKey: async () => (caps.secrets ? caps.receipts.keys.active() : null),
  };
  // People (ADR-017 §2, §8): the network calls a create makes about its customer, and the mail a
  // one-time code goes out by. Without INBOX_SECRET_KEY the port cannot sign, and nothing is asked.
  const identity = { db: deps.db, caps, ...network };
  const port = createIdentityPort(identity);
  caps.people.attachPort(port);
  caps.attachMail(mailOut);
  const runner = createRunner({ mailOut, baseUrl: deps.baseUrl, receipts: caps.receipts, secrets: caps.secrets })
    // Networks (ADR-017 §8.1): the hourly tick does the housekeeping and queues the rest; every
    // call to a network runs in that network's own lane, so a slow one never delays another.
    .register(NETWORK_PING_KIND, networkPingHandler(network))
    .register(NETWORK_PING_ONE_KIND, networkPingOneHandler(network), { lane: networkLane })
    .register(NETWORK_PUBLISH_KIND, networkPublishHandler(network), { lane: networkLane })
    .register(NETWORK_RECEIPT_KIND, networkReceiptHandler(network), { lane: networkLane })
    // A first contact the request could not finish is asked again, in that network's lane.
    .register(IDENTITY_ISSUE_KIND, identityIssueHandler({ ...identity, port }), { lane: networkLane })
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
  if (demo) {
    for (const kind of [NETWORK_PING_ONE_KIND, NETWORK_PUBLISH_KIND, NETWORK_RECEIPT_KIND, IDENTITY_ISSUE_KIND]) {
      runner.register(kind, noNetworkHandler);
    }
    // Nor does anything a tester typed leave by a webhook, whoever set one up.
    for (const kind of [WEBHOOK_FANOUT_KIND, WEBHOOK_DELIVERY_KIND]) runner.register(kind, noWebhookHandler);
    runner.register(
      DEMO_NIGHTLY_KIND,
      demoNightlyHandler({ mailOut: transport, demo, baseUrl: deps.baseUrl, seed: { receipts: caps.receipts } }),
    );
  }
  const background = deps.background ?? ((work) => void work.catch(() => {}));
  // Whether this instance is the demo shop, decided once per process: an empty database becomes it,
  // anything else is refused (demo.ts) and said so once. Only the answer is kept, never a check in
  // progress: on Workers a check belongs to the request that started it and stops for good if that
  // request is cancelled, so a request that waited on another's check could wait for ever. Requests
  // that arrive before the first answer each ask for themselves: ensureDemo is safe to run at once,
  // since only one of them can claim an empty database for the shop (seedShowcase).
  let demoAnswer: boolean | null = null;
  const demoActive = async (): Promise<boolean> => {
    if (!demo) return false;
    if (demoAnswer !== null) return demoAnswer;
    const r = await ensureDemo(deps.db, deps.now ? deps.now() : Date.now(), { receipts: caps.receipts });
    if (demoAnswer === null && !r.active) console.error(`demo: ${DEMO_REFUSED}`);
    demoAnswer = r.active;
    return r.active;
  };
  const prepare = async (): Promise<void> => {
    if (demo && !(await demoActive())) throw new Error(DEMO_REFUSED);
  };

  // Security headers on every response, owner app and API alike, set here rather than in a proxy
  // so every self-hoster gets them whatever sits in front. Each one is chosen, not defaulted: Hono's
  // defaults include Cross-Origin-Resource-Policy: same-origin, which blocks legitimate cross-origin
  // loads, and Cross-Origin-Opener-Policy, which can break the OAuth window Claude and ChatGPT open
  // to connect to the owner MCP. The CSP carries only frame-ancestors, so it forbids framing — the
  // clickjacking defence for the owner app — and cannot break a single script or style.
  const common = {
    strictTransportSecurity: "max-age=15552000",
    xFrameOptions: "DENY",
    xContentTypeOptions: "nosniff",
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
    originAgentCluster: false,
    xDnsPrefetchControl: false,
    xDownloadOptions: false,
    xPermittedCrossDomainPolicies: false,
    xXssProtection: "0",
  } as const;
  const appHeaders = secureHeaders({
    ...common,
    contentSecurityPolicy: { frameAncestors: ["'none'"] },
    referrerPolicy: "strict-origin-when-cross-origin",
  });
  // The page a link in the business's email opens (`/c/…`) is stricter: nothing but its own inline
  // style, forms only to itself, and no Referer, so the link's token never reaches another site.
  const pageHeaders = secureHeaders({
    ...common,
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      styleSrc: ["'unsafe-inline'"],
      formAction: ["'self'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
    },
    referrerPolicy: "no-referrer",
  });
  // The demo's live view runs one script of its own and reads only its own feed.
  const demoHeaders = secureHeaders({
    ...common,
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      styleSrc: ["'unsafe-inline'"],
      imgSrc: ["'self'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      frameAncestors: ["'none'"],
    },
    referrerPolicy: "no-referrer",
  });
  app.use("*", (c, next) =>
    c.req.path.startsWith("/c/")
      ? pageHeaders(c, next)
      : demo && c.req.path.startsWith("/demo/")
        ? demoHeaders(c, next)
        : appHeaders(c, next),
  );

  // Every route reads a bounded body, checked before anything reads or parses it: the declared
  // length first, then the bytes as they stream, for a body sent without one. A megabyte is far
  // above anything a booking, an order, a rule or the settings need; raw inbound email may be as
  // large as Email Routing accepts.
  const readsAny = bodyLimit({ maxSize: MAX_BODY, onError: (c) => tooLarge(c, MAX_BODY, "This inbox") });
  const readsMail = bodyLimit({
    maxSize: MAX_EMAIL_BODY,
    onError: (c) => tooLarge(c, MAX_EMAIL_BODY, "Inbound email"),
  });
  app.use("*", (c, next) => (c.req.path === "/v1/email/inbound" ? readsMail(c, next) : readsAny(c, next)));

  // Migrations run lazily on the first request after a deploy (ADR-007).
  app.use("*", async (c, next) => {
    await ensureMigrated(deps.db.client, MIGRATIONS);
    // A demo seeds itself on its first request, so a fresh Worker has a shop before its first cron.
    if (demo)
      await demoActive().catch((error) => console.error("demo:", error instanceof Error ? error.message : error));
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

  // A demo reads small bodies only: nobody's AI books with a megabyte, and a stranger's megabytes
  // would sit in the database until the night.
  if (demo) {
    app.use("*", bodyLimit({ maxSize: DEMO_MAX_BODY, onError: (c) => tooLarge(c, DEMO_MAX_BODY, "This demo") }));
  }

  // Healthy means the database answers too, not only the process: a monitor that asks this learns
  // of a database that went away, which a fixed answer never told it.
  app.get("/healthz", async (c) => {
    try {
      await deps.db.client.query({ sql: "SELECT 1", params: [], method: "all" });
      return c.json({ ok: true, version: VERSION, db: "ok" }, 200, { "Cache-Control": "no-store" });
    } catch {
      return c.json({ ok: false, version: VERSION, db: "unreachable" }, 503, { "Cache-Control": "no-store" });
    }
  });

  // Where to report a security problem with this inbox (RFC 9116): the address the owner set in
  // Settings (`security.contact`), else hello@ this inbox's own host. It expires in a year and is
  // written afresh on every request, so it never goes stale.
  app.get("/.well-known/security.txt", async (c) => {
    const origin = publicOrigin(c.req.raw, deps.baseUrl);
    const set = (await readSettings(deps.db)).security.contact;
    return c.text(securityTxt({ origin, contact: set, now: deps.now ? deps.now() : Date.now() }), 200, {
      "Cache-Control": "public, max-age=86400",
    });
  });

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
      // Whose people it recognises (ADR-017 §8.4): every network switched on, when it can sign.
      identity: { passes: await port.canSign(), networks: enabledNetworks(settings) },
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
    // The doors send one kind of mail, the owner's sign-in link.
    mailOut: ownerMail,
    limits: demo ? DEMO_LIMITS : undefined,
    sharedLimits: demo ? DEMO_SHARED : undefined,
    businessName: async () => (await caps.getBusinessProfile()).name,
    fetchClientMetadata: deps.fetchClientMetadata,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    inboundEmailSecret: async () => (await readSettings(deps.db)).email.inboundSecret ?? null,
    ownerEmails: async () => {
      const fromSettings = (await readSettings(deps.db)).notifications.ownerEmail;
      return [...(deps.ownerEmails ?? []), ...(fromSettings ? [fromSettings] : [])];
    },
  });

  // The live view exists only in a demo; anywhere else /demo/* is a 404 like any unknown path.
  if (demo) app.route("/demo", demoRoutes({ db: deps.db, now: deps.now, active: demoActive }));

  app.notFound((c) => c.json({ error: "not_found", path: new URL(c.req.url).pathname }, 404));
  return { app, runner, caps, prepare };
}

/** The largest request body any route reads, but raw inbound email's. */
export const MAX_BODY = 1024 * 1024;
/** Raw inbound email, as large as Email Routing accepts (and `POST /v1/email/inbound` checks). */
export const MAX_EMAIL_BODY = 25 * 1024 * 1024;

/** The 413 every body limit answers with, as a problem document. */
function tooLarge(c: Context, max: number, who: string): Response {
  const size = max >= 1024 * 1024 ? `${max / (1024 * 1024)} MB` : `${max / 1024} KB`;
  return c.json(
    {
      type: "https://surfingdog.ai/problems/too_large",
      title: "Too large",
      status: 413,
      code: "too_large",
      detail: `${who} reads request bodies of up to ${size}.`,
    },
    413,
    { "Content-Type": "application/problem+json" },
  );
}

/**
 * `/.well-known/security.txt` (RFC 9116): a contact — an email address becomes a `mailto:` — the
 * canonical address of the file itself, and an expiry a year out, as the RFC asks.
 */
export function securityTxt(o: { origin: string; contact?: string | undefined; now: number }): string {
  const host = new URL(o.origin).hostname;
  const contact = o.contact
    ? o.contact.startsWith("https://")
      ? o.contact
      : `mailto:${o.contact}`
    : `mailto:hello@${host}`;
  const expires = new Date(o.now + 365 * 86_400_000);
  expires.setUTCHours(0, 0, 0, 0);
  return [
    `Contact: ${contact}`,
    `Expires: ${expires.toISOString()}`,
    "Preferred-Languages: en",
    `Canonical: ${o.origin}/.well-known/security.txt`,
    "",
  ].join("\n");
}

/** The app alone, for tests and simple hosts. */
export function createApp(deps: AppDeps): Hono<CallerEnv> {
  return createInbox(deps).app;
}

export type App = ReturnType<typeof createApp>;
