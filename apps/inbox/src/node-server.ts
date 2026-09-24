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
