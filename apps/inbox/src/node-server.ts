import { existsSync } from "node:fs";
import type { ServerOptions } from "node:http";

/**
 * How long the Node host waits on a client. Node's own defaults let a request take five minutes
 * and look for one that overran only every thirty seconds, so a client that sends its body a byte
 * at a time holds a connection for that long, and a few thousand such clients hold the server.
 * A real client sends a megabyte — the 25 of a raw email from the mail gateway included — in far
 * less than a minute, so a request gets fifteen seconds for its headers and a minute in all.
 */
export const NODE_SERVER_OPTIONS = {
  headersTimeout: 15_000,
  requestTimeout: 60_000,
  keepAliveTimeout: 5_000,
  connectionsCheckingInterval: 2_000,
} as const satisfies ServerOptions;

/**
 * Where the Node server listens when HOST is not set: loopback, behind the proxy that terminates
 * TLS (the install guide's Caddy). Reachable around the proxy, a caller could set CF-Connecting-IP
 * itself and pass for anyone. The Docker image sets HOST=0.0.0.0 inside its container.
 */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * Why a command must not run against `file`, or null: without INBOX_DB (`inboxDb`), the default
 * ./data/inbox.db is the instance's only when it is already there. A command run from another
 * directory, without the instance's settings, would otherwise create a new, empty database there
 * and, say, print an owner key that opens nothing.
 */
export function commandDatabaseRefusal(file: string, inboxDb: string | undefined, command: string): string | null {
  if (inboxDb || existsSync(file)) return null;
  return [
    `No inbox database at ${file}, and INBOX_DB is not set: ${command} creates no new database.`,
    `Run it with the instance's settings, for example: node --env-file=/opt/inbox/.env /opt/inbox/server.mjs ${command}`,
  ].join("\n");
}
