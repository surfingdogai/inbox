import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import type { CachedResolver } from "./resolver";
import { createRouter, type RouterOptions } from "./router";
import type { Shard } from "./shard";
import { MAX_SIGNED_BODY, NonceCache, verifySigned } from "./sign";
import { closeServer, jsonOf, listenSocket, readBody } from "./sockets";

/** How long a connection may take: a request's headers in 15 s, all of it in 70 s. */
const SERVER_OPTIONS = {
  headersTimeout: 15_000,
  requestTimeout: 70_000,
  keepAliveTimeout: 5_000,
  connectionsCheckingInterval: 2_000,
} as const;

export interface Listening {
  close(): Promise<void>;
}

/**
 * A shard on its two sockets: requests the router passes on, and admin calls the router passes on,
 * each checked as signed with the shards' key (the router signs again with it; a shard never holds
 * the control plane's admin key). Both sockets are for this runtime's own user only (0600).
 */
export async function serveShard(
  shard: Shard,
  o: {
    readonly socket: string;
    readonly adminSocket: string;
    readonly shardKey: string;
    readonly now?: (() => number) | undefined;
  },
): Promise<Listening> {
  const publicServer = createAdaptorServer({
    fetch: (request: Request) => shard.handle(request),
    serverOptions: SERVER_OPTIONS,
  }) as Server;
  const nonces = new NonceCache();
  const now = o.now ?? Date.now;
  const adminServer = createServer(SERVER_OPTIONS, (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = (req.method ?? "GET").toUpperCase();
      const target = req.url ?? "/";
      const body = await readBody(req, MAX_SIGNED_BODY);
      const reply = (status: number, value?: unknown) => {
        res.writeHead(status, {
          "content-type": status >= 400 ? "application/problem+json" : "application/json",
          "cache-control": "no-store",
        });
        res.end(value === undefined ? undefined : JSON.stringify(value));
      };
      if (!body) return reply(413, { code: "too_large", status: 413, detail: "At most 1 MB." });
      const checked = verifySigned(
        o.shardKey,
        nonces,
        { method, target, headers: { get: (n) => (req.headers[n] as string | undefined) ?? null }, body },
        now(),
      );
      if (!checked.ok) return reply(401, { code: "unauthorized", status: 401, detail: `Not signed (${checked.why}).` });
      const a = await shard.admin(method, target, body.byteLength ? jsonOf(body) : undefined);
      reply(a.status, a.body);
    })().catch((error) => {
      console.error(`shard admin: ${error instanceof Error ? error.message : error}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/problem+json" });
        res.end(JSON.stringify({ code: "internal", status: 500, detail: "Something failed here." }));
      } else res.destroy();
    });
  });
  await listenSocket(publicServer, o.socket, 0o600);
  await listenSocket(adminServer, o.adminSocket, 0o600);
  return {
    async close() {
      await Promise.all([closeServer(publicServer), closeServer(adminServer)]);
    },
  };
}

/**
 * The router on its two sockets: the public one the web server in front connects to, and the admin
 * one the control plane connects to. Their modes are the operator's (both 0660 by default: the web
 * server and the control plane reach them through a group).
 */
export async function serveRouter(
  o: RouterOptions & {
    readonly resolver: CachedResolver;
    readonly socket: string;
    readonly adminSocket: string;
    readonly socketMode?: number | undefined;
    readonly adminSocketMode?: number | undefined;
  },
): Promise<Listening> {
  const router = createRouter(o);
  const publicServer = createServer(SERVER_OPTIONS, router.handle);
  const adminServer = createServer(SERVER_OPTIONS, router.admin);
  await listenSocket(publicServer, o.socket, o.socketMode ?? 0o660);
  await listenSocket(adminServer, o.adminSocket, o.adminSocketMode ?? 0o660);
  return {
    async close() {
      await Promise.all([closeServer(publicServer), closeServer(adminServer)]);
    },
  };
}
