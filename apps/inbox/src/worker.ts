import { ensureNetworkPing, ingestEmail } from "@surfingdog/adapters";
import { createDb, ensureLifecycleSweep, MIGRATIONS } from "@surfingdog/core";
import {
  cloudflareEmailMailOut,
  consoleMailOut,
  ensureMigrated,
  type MailOut,
  resendMailOut,
} from "@surfingdog/platform";
import { d1Client } from "@surfingdog/platform/cloudflare";
import { createInbox, type Inbox } from "./app";
import { flagOn } from "./demo";
import {
  jobToolsFrom,
  listFrom,
  oauthFrom,
  posFrom,
  publicUrlFrom,
  secretKeyFrom,
  senderFrom,
  spamFrom,
  ucpLodgingFrom,
} from "./env";

type Bindings = Env & {
  EMAIL?: Parameters<typeof cloudflareEmailMailOut>[0];
  RESEND_API_KEY?: string;
  INBOX_OWNER_EMAIL?: string;
  /**
   * The receiving server's own Authentication-Results id (e.g. mx.cloudflare.net), set only once a
   * real delivery showed Email Routing puts its results on top of every message. Unset: no verdict is
   * read from a message (a sender can write such a field itself).
   */
  EMAIL_AUTHSERV_ID?: string;
  INBOX_SECRET_KEY?: string;
  /** The https URL this instance is reached at. Receipts name it as their issuer (ADR-016). */
  INBOX_PUBLIC_URL?: string;
  /** `1` makes this instance a public demo shop (demo.ts). */
  INBOX_DEMO?: string;
  /** `on` (or `1`, `true`, `yes`) opens UCP Lodging's booking sessions for a place to stay (a draft, off by default). */
  INBOX_UCP_LODGING?: string;
  /**
   * The address the owner's sign-in link and alerts go out from, on a domain onboarded to Email
   * Sending on this account. The EMAIL binding has no sender of its own.
   */
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
  /** Google Calendar's OAuth client (ADR-022); without both, Google shows as "set up". */
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REDIRECT_URI?: string;
  /** The push relay for the owner's phones (ADR-028): its address, or `off`. Absent, Surfing Dog's. */
  INBOX_PUSH_RELAY?: string;
  /** `1` while the Google client is in Google's Testing mode: Google says "Soon" (ADR-030 §6). */
  GOOGLE_OAUTH_TESTING?: string;
  /** One-click sign-ins beside a shop's or a till's own keys (ADR-030 §5); without them, "set up". */
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SQUARE_CLIENT_ID?: string;
  SQUARE_CLIENT_SECRET?: string;
  CALENDLY_CLIENT_ID?: string;
  CALENDLY_CLIENT_SECRET?: string;
  /** A job tool's sign-in through the server's own app (ADR-039 §5); without them, "set up". */
  SERVICEM8_CLIENT_ID?: string;
  SERVICEM8_CLIENT_SECRET?: string;
  JOBBER_CLIENT_ID?: string;
  JOBBER_CLIENT_SECRET?: string;
  /** The Jobber API version the app was checked against, and the job tools whose terms are cleared here. */
  JOBBER_API_VERSION?: string;
  JOB_TOOLS_CLEARED?: string;
  /** A kitchen's partner tills (ADR-040): without them, each says "Needs setup". */
  TOAST_CLIENT_ID?: string;
  TOAST_CLIENT_SECRET?: string;
  TOAST_API_HOST?: string;
  LIGHTSPEED_CLIENT_ID?: string;
  LIGHTSPEED_CLIENT_SECRET?: string;
  CLOVER_CLIENT_ID?: string;
  CLOVER_CLIENT_SECRET?: string;
  DELIVERECT_CLIENT_ID?: string;
  DELIVERECT_CLIENT_SECRET?: string;
  DELIVERECT_CHANNEL?: string;
  DELIVERECT_STAGING?: string;
  /**
   * The model the spam filter's AI check uses (ADR-041 §7.2), the operator's own: `messages` or
   * `chat`, the API's address, its key, the model's id and the name Settings shows. Unset, the filters
   * look for known phrases only.
   */
  SPAM_MODEL_API?: string;
  SPAM_MODEL_URL?: string;
  SPAM_MODEL_KEY?: string;
  SPAM_MODEL?: string;
  SPAM_MODEL_NAME?: string;
};

// One app per isolate; the D1 binding is stable for the isolate's life.
const inboxes = new WeakMap<object, Inbox>();
function inboxFor(env: Bindings): Inbox {
  let inbox = inboxes.get(env.DB);
  if (!inbox) {
    const from = senderFrom(env.MAIL_FROM, env.MAIL_FROM_NAME);
    // Resend when a key is set, else the EMAIL binding the Deploy button adds. With neither, every
    // email is written to the Worker's logs, sign-in links included, and the item says it was not sent.
    const mailOut: MailOut = env.RESEND_API_KEY
      ? resendMailOut(env.RESEND_API_KEY, undefined, from)
      : env.EMAIL
        ? cloudflareEmailMailOut(env.EMAIL, from)
        : consoleMailOut(console.log);
    const ownerEmails = listFrom(env.INBOX_OWNER_EMAIL);
    const secretKey = secretKeyFrom(env.INBOX_SECRET_KEY);
    inbox = createInbox({
      db: createDb(d1Client(env.DB)),
      mailOut,
      ownerEmails,
      secretKey,
      baseUrl: publicUrlFrom(env.INBOX_PUBLIC_URL),
      demo: flagOn(env.INBOX_DEMO) ? { ownerEmails, from } : undefined,
      ucpLodging: ucpLodgingFrom(env.INBOX_UCP_LODGING, secretKey),
      ...oauthFrom(env),
      ...spamFrom(env),
      pushRelay: env.INBOX_PUSH_RELAY,
      ...jobToolsFrom(env),
      ...posFrom(env),
      // `/` runs the worker first (the business's own page); a signed-in owner gets their app from the assets.
      appShell: (request) =>
        env.ASSETS.fetch(new Request(new URL("/index.html", request.url), { headers: request.headers })),
    });
    inboxes.set(env.DB, inbox);
  }
  return inbox;
}

/**
 * Cloudflare Workers entry. HTTP goes to the Hono app; cron and the queue drain the job outbox;
 * inbound email lands here once the email door is wired.
 */
export default {
  fetch: (request, env, ctx) => inboxFor(env).app.fetch(request, env, ctx),

  // Cron, the queue and email run jobs without an HTTP request, so each migrates first, as the
  // Node server does at boot: the first tick after a deploy must not meet a table that is missing.
  // Each awaits a run of its own (`join: false`): a run a request started belongs to that request,
  // and stops for good when the request's time runs out, so joining it could leave this waiting.
  async queue(batch, env) {
    const inbox = inboxFor(env);
    const db = createDb(d1Client(env.DB));
    await ensureMigrated(db.client, MIGRATIONS);
    await inbox.runner.runDue(db, { workerId: "queue", join: false });
    for (const message of batch.messages) message.ack();
  },

  async scheduled(_controller, env) {
    const db = createDb(d1Client(env.DB));
    await ensureMigrated(db.client, MIGRATIONS);
    await ensureNetworkPing(db);
    // Bookings that ended, payments that never came (ADR-017 §3.1): every quarter hour.
    await ensureLifecycleSweep(db);
    const inbox = inboxFor(env);
    // A demo seeds itself and queues its nightly wipe; anything else has nothing to prepare. A demo
    // refused over a database that holds other data says why, and the jobs still run.
    await inbox.prepare().catch((error) => console.error("demo:", error instanceof Error ? error.message : error));
    await inbox.runner.runDue(db, { workerId: "cron", limit: 100, join: false });
  },

  // Cloudflare Email Routing hands us the raw MIME. It forwards mail whose From fails DMARC under a
  // `p=none` policy — gmail.com's and outlook.com's among them — so a From address proves nothing
  // here, exactly as on the Node server's webhook: a sender the business knows is asked for a
  // one-time code, never joined to that customer on the From alone.
  async email(message, env) {
    const inbox = inboxFor(env);
    const db = createDb(d1Client(env.DB));
    await ensureMigrated(db.client, MIGRATIONS);
    const result = await ingestEmail(db, inbox.caps, {
      raw: message.raw,
      envelopeTo: message.to,
      envelopeFrom: message.from,
      authenticated: false,
      // What Email Routing found about the sender, read from the message's topmost results and only
      // once the operator confirmed whose they are: a second signal only (ADR-028 §7).
      ...(env.EMAIL_AUTHSERV_ID ? { authResultsFrom: env.EMAIL_AUTHSERV_ID.split(",") } : {}),
    });
    // Too many right now: a temporary failure, which the sending server retries, never a bounce.
    if (result.outcome === "limited") throw new Error(`inbound email limited: retry in ${result.retryAfterSec}s`);
    if (result.outcome === "rejected") message.setReject(result.reason);
    await inbox.runner.runDue(db, { workerId: "email", join: false });
  },
} satisfies ExportedHandler<Bindings>;
