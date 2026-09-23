import { ensureNetworkPing, ingestEmail } from "@surfingdog/adapters";
import { createDb, ensureLifecycleSweep, MIGRATIONS } from "@surfingdog/core";
import { cloudflareEmailMailOut, ensureMigrated, logMailOut, type MailOut, resendMailOut } from "@surfingdog/platform";
import { d1Client } from "@surfingdog/platform/cloudflare";
import { createInbox, type Inbox } from "./app";

type Bindings = Env & {
  EMAIL?: Parameters<typeof cloudflareEmailMailOut>[0];
  RESEND_API_KEY?: string;
  INBOX_OWNER_EMAIL?: string;
  INBOX_SECRET_KEY?: string;
  /** The https URL this instance is reached at. Receipts name it as their issuer (ADR-016). */
  INBOX_PUBLIC_URL?: string;
};

// One app per isolate; the D1 binding is stable for the isolate's life.
const inboxes = new WeakMap<object, Inbox>();
function inboxFor(env: Bindings): Inbox {
  let inbox = inboxes.get(env.DB);
  if (!inbox) {
    const mailOut: MailOut = env.EMAIL
      ? cloudflareEmailMailOut(env.EMAIL)
      : env.RESEND_API_KEY
        ? resendMailOut(env.RESEND_API_KEY)
        : // No mail service: every email is written to the log, and the item says it was not sent.
          logMailOut(console.log, { delivers: false });
    inbox = createInbox({
      db: createDb(d1Client(env.DB)),
      mailOut,
      ownerEmails: (env.INBOX_OWNER_EMAIL ?? "")
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean),
      secretKey: env.INBOX_SECRET_KEY,
      baseUrl: env.INBOX_PUBLIC_URL,
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
  async queue(batch, env) {
    const inbox = inboxFor(env);
    const db = createDb(d1Client(env.DB));
    await ensureMigrated(db.client, MIGRATIONS);
    await inbox.runner.runDue(db, { workerId: "queue" });
    for (const message of batch.messages) message.ack();
  },

  async scheduled(_controller, env) {
    const db = createDb(d1Client(env.DB));
    await ensureMigrated(db.client, MIGRATIONS);
    await ensureNetworkPing(db);
    // Bookings that ended, payments that never came (ADR-017 §3.1): every quarter hour.
    await ensureLifecycleSweep(db);
    await inboxFor(env).runner.runDue(db, { workerId: "cron", limit: 100 });
  },

  // Cloudflare Email Routing hands us the raw MIME; DKIM/SPF were checked upstream.
  async email(message, env) {
    const inbox = inboxFor(env);
    const db = createDb(d1Client(env.DB));
    await ensureMigrated(db.client, MIGRATIONS);
    const result = await ingestEmail(db, inbox.caps, {
      raw: message.raw,
      envelopeTo: message.to,
      envelopeFrom: message.from,
      authenticated: true,
    });
    if (result.outcome === "rejected") message.setReject(result.reason);
    await inbox.runner.runDue(db, { workerId: "email" });
  },
} satisfies ExportedHandler<Bindings>;
