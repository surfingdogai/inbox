import {
  builtInConnectors,
  type CallerEnv,
  type ClientMetadata,
  connectorHttp,
  createIdentityPort,
  DEMO_LIMITS,
  DEMO_SHARED,
  FEED_IMPORT_KIND,
  feedImportHandler,
  hasOwnerSession,
  identityIssueHandler,
  type JobToolSwitches,
  mountDoors,
  NETWORK_CATALOGUE_KIND,
  NETWORK_LISTING_KIND,
  NETWORK_PING_KIND,
  NETWORK_PING_ONE_KIND,
  NETWORK_PUBLISH_KIND,
  NETWORK_RECEIPT_KIND,
  networkCatalogueHandler,
  networkListingHandler,
  networkPingHandler,
  networkPingOneHandler,
  networkPublishHandler,
  networkReceiptHandler,
  type OAuthClients,
  type OwnerEmailChange,
  publicOrigin,
  WEBHOOK_DELIVERY_KIND,
  WEBHOOK_FANOUT_KIND,
  webhookDeliverHandler,
  webhookFanoutHandler,
} from "@surfingdog/adapters";
import {
  ATTACHMENT_SWEEP_KIND,
  ariSyncHandler,
  attachmentSweepHandler,
  buildManifest,
  Capabilities,
  CONNECTOR_CATALOGUE_KIND,
  CONNECTOR_HOOK_KIND,
  CONNECTOR_NOTICE_KIND,
  CONNECTOR_PUSH_KIND,
  CONNECTOR_SYNC_KIND,
  CONNECTOR_WRITE_RESOLVE_KIND,
  type ConnectorDefinition,
  connectorCatalogueHandler,
  connectorHookHandler,
  connectorLane,
  connectorNoticeHandler,
  connectorPushHandler,
  connectorSyncHandler,
  createRunner,
  createSecretBox,
  type Db,
  directoryProfile,
  enabledNetworks,
  FRONT_PATHS,
  type HostPolicy,
  httpRelay,
  IDENTITY_ISSUE_KIND,
  type JobRunner,
  MANIFEST_PATH,
  MIGRATIONS,
  networkLane,
  PAY_CLOSE_KIND,
  PAY_LINK_KIND,
  PAY_NOTICE_KIND,
  parseSecretKeys,
  payCloseHandler,
  payLane,
  payLinkHandler,
  payNoticeHandler,
  type RelayRegistrar,
  readSettings,
  relayAddress,
  type Settings,
  STAY_ARI_SYNC_KIND,
  STAY_MESSAGE_KIND,
  STAY_SWEEP_KIND,
  STAY_WRITE_KIND,
  stayDoorOf,
  stayMessageHandler,
  staySweepHandler,
  stayWriteHandler,
  VERSION,
  WORK_PUSH_KIND,
  workAttributes,
  workPushHandler,
  writeResolveHandler,
} from "@surfingdog/core";
import { ensureMigrated, logMailOut, type MailOut, type SqliteSnapshot } from "@surfingdog/platform";
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
  /** The owner app's page, where the runtime serves it only on request (Workers: the assets binding). */
  readonly appShell?: ((request: Request) => Promise<Response>) | undefined;
  /**
   * Outbound fetch for every call to an address someone else chose: networks, webhooks, product
   * feeds, Client ID Metadata Documents and agents' key directories. The Node server passes
   * `pinnedFetch` (resolve, refuse what is not public, connect to what was checked); tests a fake.
   */
  readonly fetchImpl?: typeof fetch | undefined;
  /**
   * Outbound fetch for a webhook the owner allowed onto a private address
   * (`integrations.webhooks.allowPrivateTargets`). Absent, `fetchImpl`, which refuses one.
   */
  readonly privateFetchImpl?: typeof fetch | undefined;
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
  /**
   * The settings whoever runs this inbox sets for it, and the ones nobody changes through it, the
   * owner included (core `settings/policy.ts`). What it sets is written before the first request is
   * served and again on every `prepare`. Absent, every setting is the owner's.
   */
  readonly policy?: HostPolicy | undefined;
  /**
   * Told each time the owner's sign-in address changes or is put back, after it has: a host that
   * keeps its own record of who owns each inbox updates it here. It cannot stop the change.
   */
  readonly onOwnerEmailChange?: ((change: OwnerEmailChange) => unknown) | undefined;
  /**
   * Copies the database for the owner to download (`POST /v1/owner/download`): Node passes
   * `nodeSnapshot`. Absent (D1), a download answers 501 and says how to copy the database instead.
   */
  readonly snapshot?: SqliteSnapshot | undefined;
  /**
   * The inbox is closing (a hosted inbox its owner is leaving): the owner's download starts with the
   * key receipts are signed with taken along.
   */
  readonly leaving?: boolean | undefined;
  /**
   * The OAuth clients this inbox signs owners in to platforms with (GOOGLE_OAUTH_CLIENT_ID and
   * GOOGLE_OAUTH_CLIENT_SECRET). Without one, Google shows as "Soon" on a hosted inbox and "set up" on one's own server.
   */
  readonly oauth?: OAuthClients | undefined;
  /**
   * One redirect address for every sign-in with a platform, when the host keeps one for all its
   * inboxes (GOOGLE_OAUTH_REDIRECT_URI on hosted). Absent, each inbox's own
   * `/oauth/connect/<kind>/callback`.
   */
  readonly oauthRedirect?: ((kind: string) => string | undefined) | undefined;
  /**
   * The push relay the owner's phones are reached through (INBOX_PUSH_RELAY, ADR-028): an https
   * address, `off` for none, absent for Surfing Dog's own. It is handed only ciphertext.
   */
  readonly pushRelay?: string | undefined;
  /**
   * How a hosted inbox registers its owner's phones with the relay: through its host's control plane,
   * which vouches for it. Absent, the inbox signs the registration itself with its receipt key.
   */
  readonly pushRegistrar?: RelayRegistrar | undefined;
  /**
   * The Google client is still in Google's Testing mode (GOOGLE_OAUTH_TESTING=1): only its test users
   * can sign in, so Google says "Soon" rather than offering a sign-in that fails (ADR-030 §6).
   */
  readonly googleTesting?: boolean | undefined;
  /** What the server switched on of the job tools (JOBBER_API_VERSION, JOB_TOOLS_CLEARED; ADR-034 §5). */
  readonly jobTools?: JobToolSwitches | undefined;
  /**
   * Connectors of the host's own, offered beside the ones this release ships (ADR-014): anyone can
   * write one against the connector SDK. One with the kind of a built-in one takes its place.
   */
  readonly connectors?: readonly ConnectorDefinition[] | undefined;
  /**
   * UCP Lodging's booking sessions for a place to stay (INBOX_UCP_LODGING=on): the protocol is a draft,
   * so they are off unless whoever runs the inbox turns them on.
   */
  readonly ucpLodging?: boolean | undefined;
}

export interface Inbox {
  readonly app: Hono<CallerEnv>;
  readonly runner: JobRunner;
  readonly caps: Capabilities;
  /**
   * Gets the instance ready before it serves: writes what the host's policy sets, when it has one;
   * in a demo, seeds the shop when the database is empty and queues the nightly run. Nothing to do
   * otherwise. Safe to call on every boot and every cron tick. In a demo over a database that
   * already holds anything, it throws `DEMO_REFUSED`.
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
    // A demo asks no network anything, the discovery check's included.
    {
      fetch: deps.fetchImpl,
      privateFetch: deps.privateFetchImpl,
      discovery: deps.demo ? noNetworkFetch : deps.fetchImpl,
    },
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
    // The manifest exactly as this inbox serves it at that origin, read from its own door: the ping
    // carries its SHA-256 (protocol §4.1), so a network that holds another reads it again at once.
    manifest: async (origin: string) => {
      const res = await app.request(new Request(`${origin}${MANIFEST_PATH}`));
      if (!res.ok) throw new Error(`the manifest answered ${res.status}`);
      return res.text();
    },
    // What the signed ping says of the business's products (ADR-029): their count and rev, so a
    // network that holds another reads the signed feed again.
    catalogue: (settings: Settings) => caps.catalogue.pingMember(settings),
  };
  // People (ADR-017 §2, §8): the network calls a create makes about its customer, and the mail a
  // one-time code goes out by. Without INBOX_SECRET_KEY the port cannot sign, and nothing is asked.
  const identity = { db: deps.db, caps, ...network };
  const port = createIdentityPort(identity);
  caps.people.attachPort(port);
  caps.attachMail(mailOut);
  // Connected platforms (ADR-022): every call leaves through the host's outbound fetch, and a demo
  // calls none, whoever connected what. An inbox that signs owners in through the host's one relay
  // is a hosted one: Google without a client is "Soon" there, and "set up" on one's own server.
  const extra = deps.connectors ?? [];
  caps.connectors.attach({
    definitions: [
      ...builtInConnectors({
        oauth: deps.oauth,
        hosted: Boolean(deps.oauthRedirect?.("google_calendar")),
        googleTesting: deps.googleTesting,
        jobTools: deps.jobTools,
      }).filter((d) => !extra.some((e) => e.kind === d.kind)),
      ...extra,
    ],
    http: connectorHttp({ fetchImpl: demo ? noNetworkFetch : deps.fetchImpl }),
    redirectUri: deps.oauthRedirect,
  });
  // The owner's phones (ADR-028): notifications go through the relay, encrypted for each phone. A demo
  // reaches no phone.
  const relay = demo ? null : relayAddress(deps.pushRelay);
  caps.phones.attachRelay(
    relay
      ? httpRelay(relay, deps.fetchImpl, {
          registrar: deps.pushRegistrar,
          // sdi-instance/1 with the receipt key, as the networks are called: the relay reads the key
          // from this inbox's manifest. Without INBOX_SECRET_KEY there is no key, and no push.
          signer: async () => (caps.secrets ? caps.receipts.keys.active() : null),
        })
      : null,
    { hosted: deps.pushRegistrar !== undefined },
  );
  // Throws here, as the inbox is built, on a policy that names something that is not a setting.
  caps.attachPolicy(deps.policy ?? null);
  const runner = createRunner({
    mailOut,
    baseUrl: deps.baseUrl,
    receipts: caps.receipts,
    secrets: caps.secrets,
    phones: caps.phones,
  })
    // Networks (ADR-017 §8.1): the hourly tick does the housekeeping and queues the rest; every
    // call to a network runs in that network's own lane, so a slow one never delays another.
    .register(NETWORK_PING_KIND, networkPingHandler(network))
    .register(NETWORK_PING_ONE_KIND, networkPingOneHandler(network), { lane: networkLane })
    .register(NETWORK_LISTING_KIND, networkListingHandler(network), { lane: networkLane })
    .register(NETWORK_CATALOGUE_KIND, networkCatalogueHandler(network), { lane: networkLane })
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
        privateFetchImpl: deps.privateFetchImpl,
      }),
    )
    // Product feeds (ADR-015 §7.3). An instance with no feed connected never enqueues one.
    .register(FEED_IMPORT_KIND, feedImportHandler({ caps, fetchImpl: deps.fetchImpl }))
    // Connected calendars (ADR-022): a sync every five minutes, a push after every booking event,
    // one connection's jobs one after another, and one email to the owner when one stops syncing.
    // An instance with nothing connected enqueues none of them.
    .register(CONNECTOR_SYNC_KIND, connectorSyncHandler(caps.connectors), { lane: connectorLane })
    .register(CONNECTOR_PUSH_KIND, connectorPushHandler(caps.connectors), { lane: connectorLane })
    .register(CONNECTOR_NOTICE_KIND, connectorNoticeHandler(caps.connectors, mailOut, { baseUrl: deps.baseUrl }))
    // What a platform's webhook named, read back with the business's key (ADR-030 §4), and a shop's
    // catalogue read on its own: in the connection's lane, so neither meets its sync.
    .register(CONNECTOR_HOOK_KIND, connectorHookHandler(caps.connectors.hooks), { lane: connectorLane })
    .register(CONNECTOR_CATALOGUE_KIND, connectorCatalogueHandler(caps.connectors), { lane: connectorLane })
    // Pay links (ADR-023): an order's link made, kept or closed after each of its events, one order's
    // jobs one after another, and an email to the owner about a payment that needs them. An inbox with
    // no payment platform connected enqueues none of them.
    .register(PAY_LINK_KIND, payLinkHandler(caps.connectors), { lane: payLane })
    .register(PAY_NOTICE_KIND, payNoticeHandler(caps.connectors, mailOut, { baseUrl: deps.baseUrl }))
    .register(PAY_CLOSE_KIND, payCloseHandler(caps.connectors), { lane: connectorLane })
    // Write first (ADR-036): a write to a business's own system whose answer never came is looked for
    // again until it is found or its few minutes are up. An inbox with no such system enqueues none.
    .register(CONNECTOR_WRITE_RESOLVE_KIND, writeResolveHandler())
    // Stays (ADR-037): the minute sweep while any stay is open, the guest's scheduled messages, and a
    // property's own system — written to first, one stay's writes one after another, and read into the
    // availability cache. An inbox that is not a place to stay enqueues none of them.
    .register(STAY_SWEEP_KIND, staySweepHandler())
    .register(STAY_MESSAGE_KIND, stayMessageHandler())
    .register(STAY_WRITE_KIND, stayWriteHandler(caps.connectors), { lane: payLane })
    .register(STAY_ARI_SYNC_KIND, ariSyncHandler(caps.connectors))
    // Trades (ADR-034): a request the owner takes on, written into their job tool, one request at a time;
    // and the sweep that removes files no request took within the hour. An inbox with neither enqueues none.
    .register(WORK_PUSH_KIND, workPushHandler(caps.connectors), { lane: payLane })
    .register(ATTACHMENT_SWEEP_KIND, attachmentSweepHandler());
  if (demo) {
    for (const kind of [
      NETWORK_PING_ONE_KIND,
      NETWORK_LISTING_KIND,
      NETWORK_CATALOGUE_KIND,
      NETWORK_PUBLISH_KIND,
      NETWORK_RECEIPT_KIND,
      IDENTITY_ISSUE_KIND,
    ]) {
      runner.register(kind, noNetworkHandler);
    }
    // Nor does anything a tester typed leave by a webhook, reach a calendar or make a pay link, whoever set one up.
    for (const kind of [
      WEBHOOK_FANOUT_KIND,
      WEBHOOK_DELIVERY_KIND,
      CONNECTOR_SYNC_KIND,
      CONNECTOR_PUSH_KIND,
      CONNECTOR_NOTICE_KIND,
      CONNECTOR_HOOK_KIND,
      CONNECTOR_CATALOGUE_KIND,
      PAY_LINK_KIND,
      PAY_NOTICE_KIND,
      PAY_CLOSE_KIND,
      CONNECTOR_WRITE_RESOLVE_KIND,
      STAY_WRITE_KIND,
      STAY_ARI_SYNC_KIND,
      WORK_PUSH_KIND,
    ])
      runner.register(kind, noWebhookHandler);
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
  // What the host's policy sets is in place before anything is served: written once per process on
  // the first request, as the migrations are, and on every `prepare`. Only the answer is kept, never
  // a write in progress, for the same reason as the demo's: a request on Workers may be cancelled.
  let policyApplied = !deps.policy;
  const applyPolicy = async (): Promise<void> => {
    await caps.applyHostPolicy(deps.now ? deps.now() : Date.now());
    policyApplied = true;
  };
  const prepare = async (): Promise<void> => {
    if (deps.policy) {
      await ensureMigrated(deps.db.client, MIGRATIONS);
      await applyPolicy();
    }
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
  // A file a customer sent with a request (ADR-034 §2), through the owner's short-lived link: nothing
  // runs, nothing loads, it frames nowhere, and no Referer carries the link's signature anywhere.
  const fileHeaders = secureHeaders({
    ...common,
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      imgSrc: ["'self'"],
      styleSrc: ["'unsafe-inline'"],
      frameAncestors: ["'none'"],
      sandbox: [],
    },
    crossOriginResourcePolicy: "same-origin",
    referrerPolicy: "no-referrer",
  });
  // The customer's pages set their own headers: the ones behind an email's links, and the business's
  // own page (`/p/*`, and `/` for anyone but the owner signed in, who gets their app there).
  // So do the addresses a platform sends the owner back to after signing in (`/oauth/connect/…`),
  // which carry a code: no Referer, nothing loaded.
  const customerPage = (path: string, request: Request) =>
    path.startsWith("/c/") ||
    path.startsWith("/p/") ||
    path.startsWith("/oauth/connect/") ||
    (path === "/" && !hasOwnerSession(request));
  app.use("*", (c, next) =>
    customerPage(c.req.path, c.req.raw)
      ? pageHeaders(c, next)
      : c.req.path.startsWith("/v1/files/")
        ? fileHeaders(c, next)
        : demo && c.req.path.startsWith("/demo/")
          ? demoHeaders(c, next)
          : appHeaders(c, next),
  );

  // Every route reads a bounded body, checked before anything reads or parses it: the declared
  // length first, then the bytes as they stream, for a body sent without one. A megabyte is far
  // above anything a booking, an order, a rule or the settings need; raw inbound email may be as
  // large as Email Routing accepts.
  const readsAny = bodyLimit({ maxSize: MAX_BODY, onError: (c) => tooLarge(c, MAX_BODY, "This inbox") });
  // A request's files (ADR-034 §2): an upload is one file of up to 10 MB; a customer's agent may send up
  // to 8 MB of files inline in one MCP call, base64, which is a third larger.
  const readsUpload = bodyLimit({
    maxSize: MAX_UPLOAD_BODY,
    onError: (c) => tooLarge(c, MAX_UPLOAD_BODY, "An upload"),
  });
  const readsFiles = bodyLimit({
    maxSize: MAX_MCP_FILES_BODY,
    onError: (c) => tooLarge(c, MAX_MCP_FILES_BODY, "This inbox"),
  });
  const readsMail = bodyLimit({
    maxSize: MAX_EMAIL_BODY,
    onError: (c) => tooLarge(c, MAX_EMAIL_BODY, "Inbound email"),
  });
  app.use("*", (c, next) =>
    c.req.path === "/v1/email/inbound"
      ? readsMail(c, next)
      : c.req.path === "/v1/uploads"
        ? readsUpload(c, next)
        : c.req.path === "/mcp" ||
            c.req.path === "/v1/quotes" ||
            c.req.path === "/v1/bookings" ||
            c.req.path === "/v1/orders"
          ? readsFiles(c, next)
          : readsAny(c, next),
  );

  // Migrations run lazily on the first request after a deploy (ADR-007).
  app.use("*", async (c, next) => {
    await ensureMigrated(deps.db.client, MIGRATIONS);
    // A policy that cannot be written fails the request: nothing is served with settings the host
    // has not set. The next request tries again.
    if (!policyApplied) await applyPolicy();
    // A demo seeds itself on its first request, so a fresh Worker has a shop before its first cron.
    if (demo)
      await demoActive().catch((error) => console.error("demo:", error instanceof Error ? error.message : error));
    await next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.method !== "OPTIONS") {
      // On the inbox's own clock, as every other run of its jobs (a host may keep one of its own).
      const work = runner.runDue(deps.db, { workerId: "request", ...(deps.now ? { now: deps.now() } : {}) });
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
    // Out of every directory when the owner says so, or when every network it reports to is kept
    // from the listing. With one network sharing it and another not, the manifest cannot say both:
    // it says listed, and the signed `POST /v1/instances/{domain}/listing` tells the other (that is
    // the one way to say it per network, and an inbox that cannot sign cannot say it at all).
    const on = Object.values(settings.networks).filter((n) => n.enabled);
    const unlisted = !settings.directory.listed || (on.length > 0 && on.every((n) => !n.share.listing));
    const manifest = buildManifest({
      instanceUrl: origin,
      itemTypes: profile.item_types,
      profile: await directoryProfile(deps.db, {
        name: profile.name,
        languages: profile.languages,
        timezone: profile.timezone,
        directory: settings.directory,
        payments: settings.payments.accepted,
        // What a trade says of itself as a network's attributes (ADR-034): free estimates, emergencies.
        attributes: workAttributes(settings),
        now: deps.now ? deps.now() : Date.now(),
      }),
      receiptKeys: jwks.keys as unknown as Record<string, unknown>[],
      // The services this instance publishes receipts to: every network switched on that takes them.
      reviewServices: enabledNetworks(settings, "receipts"),
      // Whose people it recognises (ADR-017 §8.4): every network switched on, when it can sign.
      identity: { passes: await port.canSign(), networks: enabledNetworks(settings) },
      ...(unlisted ? { directory: { listed: false } } : {}),
      // Where an agent goes for a kind the business takes somewhere else: a booking platform, its own checkout.
      doorsElsewhere: profile.doors_elsewhere,
      // Whether a network may carry an assistant's request here: said either way, so the owner's
      // switch reaches every network within minutes.
      carried: settings.carried,
      // Where a network reads the business's products, while it lists them and this inbox can sign
      // the feed (ADR-029): a business out of every directory lists none.
      catalogue: !unlisted && caps.catalogue.served(settings) && caps.catalogue.canSign(),
      // A place to stay's door (ADR-037): how it confirms, how soon it answers, how a stay is secured.
      stay: await stayDoorOf(deps.db),
    });
    // A minute: a network reads it again within five, and an owner's switch must not wait on a cache.
    return c.json(manifest, 200, { "Cache-Control": "public, max-age=60" });
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
    // The doors send only the owner's own mail: sign-in, step-up codes and address changes.
    mailOut: ownerMail,
    limits: demo ? DEMO_LIMITS : undefined,
    sharedLimits: demo ? DEMO_SHARED : undefined,
    // A demo is wiped every night and holds strangers' requests: nobody downloads it.
    snapshot: demo ? undefined : deps.snapshot,
    leaving: deps.leaving,
    businessName: async () => (await caps.getBusinessProfile()).name,
    appShell: deps.appShell,
    fetchClientMetadata: deps.fetchClientMetadata,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    inboundEmailSecret: async () => (await readSettings(deps.db)).email.inboundSecret ?? null,
    ownerEmails: async () => {
      const fromSettings = (await readSettings(deps.db)).notifications.ownerEmail;
      return [...(deps.ownerEmails ?? []), ...(fromSettings ? [fromSettings] : [])];
    },
    onOwnerEmailChange: deps.onOwnerEmailChange,
    ucpLodging: deps.ucpLodging,
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
/** One file uploaded for a request (ADR-034 §2): up to 10 MB, and a little for the request around it. */
export const MAX_UPLOAD_BODY = 10 * 1024 * 1024 + 64 * 1024;
/** A request with its files inline, base64 (8 MB of files is about 10.7 MB of text), and its JSON. */
export const MAX_MCP_FILES_BODY = 12 * 1024 * 1024;

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
 * canonical address of the file itself, and an expiry a year out, as the RFC asks. With no contact
 * set, it is this inbox's own message form: an address made up from the host (hello@inbox.…) has
 * nobody behind it on most instances, and a report sent there bounces.
 */
export function securityTxt(o: { origin: string; contact?: string | undefined; now: number }): string {
  const contact = o.contact
    ? o.contact.startsWith("https://")
      ? o.contact
      : `mailto:${o.contact}`
    : `${o.origin}${FRONT_PATHS.message}`;
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
