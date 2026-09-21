import { createDb } from "@surfingdog/core";
import { d1Client } from "@surfingdog/platform/cloudflare";
import { type App, createApp } from "./app";

// One app per isolate; the D1 binding is stable for the isolate's life.
const apps = new WeakMap<object, App>();
function appFor(env: Env): App {
  let app = apps.get(env.DB);
  if (!app) {
    app = createApp({ db: createDb(d1Client(env.DB)) });
    apps.set(env.DB, app);
  }
  return app;
}

/**
 * Cloudflare Workers entry. HTTP goes to the Hono app; the other handlers are the seams for the
 * platform adapters (jobs consumer, cron, inbound email).
 */
export default {
  fetch: (request, env, ctx) => appFor(env).fetch(request, env, ctx),

  async queue(batch) {
    for (const message of batch.messages) message.ack();
  },

  async scheduled() {
    // Cron tick: due jobs, digests, cleanup. Wired with the job runner.
  },

  async email(message) {
    message.setReject("Inbound email is not configured on this instance yet.");
  },
} satisfies ExportedHandler<Env>;
