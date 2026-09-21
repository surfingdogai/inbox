import { ingestEmail } from "@surfingdog/adapters";
import { createDb } from "@surfingdog/core";
import { cloudflareEmailMailOut, logMailOut, type MailOut, resendMailOut } from "@surfingdog/platform";
import { d1Client } from "@surfingdog/platform/cloudflare";
import { createInbox, type Inbox } from "./app";

type Bindings = Env & { EMAIL?: Parameters<typeof cloudflareEmailMailOut>[0]; RESEND_API_KEY?: string };

// One app per isolate; the D1 binding is stable for the isolate's life.
const inboxes = new WeakMap<object, Inbox>();
function inboxFor(env: Bindings): Inbox {
  let inbox = inboxes.get(env.DB);
  if (!inbox) {
    const mailOut: MailOut = env.EMAIL
      ? cloudflareEmailMailOut(env.EMAIL)
      : env.RESEND_API_KEY
        ? resendMailOut(env.RESEND_API_KEY)
        : logMailOut(console.log);
    inbox = createInbox({ db: createDb(d1Client(env.DB)), mailOut });
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

  async queue(batch, env) {
    const inbox = inboxFor(env);
    await inbox.runner.runDue(createDb(d1Client(env.DB)), { workerId: "queue" });
    for (const message of batch.messages) message.ack();
  },

  async scheduled(_controller, env) {
    await inboxFor(env).runner.runDue(createDb(d1Client(env.DB)), { workerId: "cron", limit: 100 });
  },

  // Cloudflare Email Routing hands us the raw MIME; DKIM/SPF were checked upstream.
  async email(message, env) {
    const inbox = inboxFor(env);
    const result = await ingestEmail(createDb(d1Client(env.DB)), inbox.caps, {
      raw: message.raw,
      envelopeTo: message.to,
      envelopeFrom: message.from,
      authenticated: true,
    });
    if (result.outcome === "rejected") message.setReject(result.reason);
    await inbox.runner.runDue(createDb(d1Client(env.DB)), { workerId: "email" });
  },
} satisfies ExportedHandler<Bindings>;
