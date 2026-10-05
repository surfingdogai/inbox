#!/usr/bin/env -S npx tsx
import { createServer } from "node:http";
import { type CheckResult, checkNetwork } from "./index.js";

/**
 *   network-check <network origin> [--base <url>] [--flow] [--flow-domain <domain>] [--flow-port <port>] [--json]
 *
 * Without --flow: safe reads and refusals, against any network.
 *
 * With --flow: plays an inbox. It serves its manifest at http://127.0.0.1:<flow-port>/.well-known/agent-inbox.json
 * for <flow-domain> (inbox-check.test by default), so the network must be in a test mode that reads that
 * domain's manifest from there. For the example network:
 *
 *   NETWORK_ORIGIN=https://network.localhost PORT=8080 \
 *   NETWORK_TEST_MANIFESTS=inbox-check.test=http://127.0.0.1:8788/.well-known/agent-inbox.json \
 *   npx tsx examples/network/src/server.ts
 *
 *   npx tsx packages/network-check/src/cli.ts https://network.localhost --base http://127.0.0.1:8080 --flow
 *
 * Exits 0 when every "must" passed, 1 otherwise.
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const network = args.find(
  (a, i) => !a.startsWith("--") && !["--base", "--flow-domain", "--flow-port"].includes(args[i - 1] ?? ""),
);
if (!network) {
  console.error(
    "usage: network-check <network origin> [--base <url>] [--flow] [--flow-domain <domain>] [--flow-port <port>] [--json]",
  );
  process.exit(2);
}

const json = flag("--json");
const mark: Record<CheckResult["outcome"], string> = { pass: "✓", fail: "✗", skip: "–" };

let manifest = "{}";
let server: ReturnType<typeof createServer> | undefined;
if (flag("--flow")) {
  const port = Number(value("--flow-port") ?? 8788);
  server = createServer((req, res) => {
    if (req.url === "/.well-known/agent-inbox.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(manifest);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server?.listen(port, "127.0.0.1", resolve));
}

const report = await checkNetwork({
  network,
  base: value("--base"),
  ...(flag("--flow")
    ? {
        flow: {
          domain: value("--flow-domain") ?? "inbox-check.test",
          publishManifest: (m) => {
            manifest = JSON.stringify(m);
          },
        },
      }
    : {}),
  onResult: (r) => {
    if (!json)
      console.log(
        `${mark[r.outcome]} ${r.id.padEnd(28)} ${r.requirement.padEnd(6)} ${r.section.padEnd(12)} ${r.detail}`,
      );
  },
});
server?.close();

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const failed = report.results.filter((r) => r.outcome === "fail");
  const level = report.protocol
    ? `${report.protocol.level} level, claims ${report.protocol.claims}`
    : "rules unreadable";
  console.log(
    `\n${report.network}: ${level}. ${report.results.filter((r) => r.outcome === "pass").length} passed, ${failed.length} failed (${failed.filter((r) => r.requirement === "must").length} must), ${report.results.filter((r) => r.outcome === "skip").length} skipped.`,
  );
}
process.exit(report.passed ? 0 : 1);
