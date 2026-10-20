import { existsSync } from "node:fs";
import type { ServerOptions } from "node:http";
import type { Http2Bindings, HttpBindings } from "@hono/node-server";

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

/** Where the caller's address comes from, as INBOX_CLIENT_ADDRESS_HEADER names it. */
export type ClientAddressSource = { readonly kind: "header"; readonly name: string } | { readonly kind: "socket" };

/**
 * INBOX_CLIENT_ADDRESS_HEADER: unset, the inbox reads CF-Connecting-IP, then the first
 * X-Forwarded-For, as a proxy in front left them (Caddy drops the first and sets the second from the
 * connection). On a platform whose proxy passes a CF-Connecting-IP the caller wrote straight through,
 * it names the header that proxy sets itself (`fly-client-ip` on Fly.io, `x-real-ip` behind Traefik
 * or Railway's edge), or `socket` for the connection's own address, for a server reached directly.
 * A value that is neither is `bad`, and the server does not start: a limit the operator meant to
 * close and mistyped would be open without a word.
 */
export function clientAddressFrom(value: string | undefined): {
  readonly source: ClientAddressSource | null;
  readonly bad: string | null;
} {
  const typed = value?.trim().toLowerCase() ?? "";
  if (!typed) return { source: null, bad: null };
  if (typed === "socket") return { source: { kind: "socket" }, bad: null };
  if (/^[a-z0-9-]{1,64}$/.test(typed)) return { source: { kind: "header", name: typed }, bad: null };
  return { source: null, bad: value?.trim() ?? "" };
}

/**
 * The caller's address, from `source`, put where the inbox's limits read it: CF-Connecting-IP, and
 * X-Forwarded-For with that one address. Whatever the caller sent in either is gone first; with no
 * address to be had, both stay empty, and such callers share one bucket instead of choosing their own.
 */
export function setClientAddress(
  headers: Headers,
  source: ClientAddressSource,
  remoteAddress: string | undefined,
): void {
  const raw = source.kind === "socket" ? remoteAddress : headers.get(source.name)?.split(",")[0];
  const address = raw?.trim().slice(0, 64);
  headers.delete("cf-connecting-ip");
  headers.delete("x-forwarded-for");
  if (address) {
    headers.set("cf-connecting-ip", address);
    headers.set("x-forwarded-for", address);
  }
}

type NodeFetch = (request: Request, env: HttpBindings | Http2Bindings) => Response | Promise<Response>;

/** `fetch`, with each caller's address taken from `source` first; `fetch` itself when there is none. */
export function withClientAddress(fetch: NodeFetch, source: ClientAddressSource | null): NodeFetch {
  if (!source) return fetch;
  return (request, env) => {
    setClientAddress(request.headers, source, env.incoming.socket?.remoteAddress);
    return fetch(request, env);
  };
}
