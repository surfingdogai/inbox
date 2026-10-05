import { serve } from "@hono/node-server";
import { createNetwork } from "./app.js";
import { httpManifestFetcher } from "./manifest.js";

/**
 * Runs the example network:
 *
 *   NETWORK_ORIGIN=https://network.example.org PORT=8080 NETWORK_DB=network.db npx tsx src/server.ts
 *
 * Put it behind a proxy that serves NETWORK_ORIGIN over https. NETWORK_TEST_MANIFESTS is for a
 * test on one machine only: `inbox-check.test=http://127.0.0.1:8788/.well-known/agent-inbox.json`
 * (comma-separated) reads those domains' manifests from those URLs, which is how
 * `network-check --flow` plays an inbox.
 */
const origin = process.env.NETWORK_ORIGIN ?? "https://network.localhost";
const port = Number(process.env.PORT ?? 8080);
const testManifests = Object.fromEntries(
  (process.env.NETWORK_TEST_MANIFESTS ?? "")
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf("=");
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
);

const network = createNetwork({
  origin,
  database: process.env.NETWORK_DB ?? "network.db",
  fetchManifest: httpManifestFetcher(testManifests),
});

// Every member's manifest is read again every six hours.
setInterval(() => void network.refresh().catch(() => undefined), 6 * 3_600_000).unref();

serve({ fetch: network.app.fetch, port }, () => {
  console.log(`network at ${origin}, listening on :${port}`);
  if (Object.keys(testManifests).length) console.log(`test manifests for: ${Object.keys(testManifests).join(", ")}`);
});
