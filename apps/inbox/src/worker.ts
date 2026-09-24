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
import { listFrom, publicUrlFrom, secretKeyFrom, senderFrom } from "./env";

type Bindings = Env & {
  EMAIL?: Parameters<typeof cloudflareEmailMailOut>[0];
  RESEND_API_KEY?: string;
  INBOX_OWNER_EMAIL?: string;
  INBOX_SECRET_KEY?: string;
  /** The https URL this instance is reached at. Receipts name it as their issuer (ADR-016). */
  INBOX_PUBLIC_URL?: string;
  /** `1` makes this instance a public demo shop (demo.ts). */
  INBOX_DEMO?: string;
  /**
   * The address the owner's sign-in link and alerts go out from, on a domain onboarded to Email
   * Sending on this account. The EMAIL binding has no sender of its own.
   */
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
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
    inbox = createInbox({
      db: createDb(d1Client(env.DB)),
      mailOut,
      ownerEmails,
      secretKey: secretKeyFrom(env.INBOX_SECRET_KEY),
      baseUrl: publicUrlFrom(env.INBOX_PUBLIC_URL),
      demo: flagOn(env.INBOX_DEMO) ? { ownerEmails, from } : undefined,
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
    });
    // Too many right now: a temporary failure, which the sending server retries, never a bounce.
    if (result.outcome === "limited") throw new Error(`inbound email limited: retry in ${result.retryAfterSec}s`);
    if (result.outcome === "rejected") message.setReject(result.reason);
    await inbox.runner.runDue(db, { workerId: "email", join: false });
  },
} satisfies ExportedHandler<Bindings>;
