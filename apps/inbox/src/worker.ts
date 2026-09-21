import { createApp } from "./app";

const app = createApp();

/**
 * Cloudflare Workers entry. HTTP goes to the Hono app; the other handlers are the seams for the
 * platform adapters (jobs consumer, cron, inbound email) and do nothing yet.
 */
export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),

  async queue(batch) {
    for (const message of batch.messages) message.ack();
  },

  async scheduled() {
    // Cron tick: due jobs, digests, cleanup. Wired in the first release.
  },

  async email(message) {
    // Inbound MIME arrives here on the Cloudflare target. Rejected until email-in is configured.
    message.setReject("Inbound email is not configured on this instance yet.");
  },
} satisfies ExportedHandler<Env>;
