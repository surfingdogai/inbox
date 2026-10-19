import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { dirname } from "node:path";

/**
 * Everything here listens on local sockets, never on a TCP port: who may connect is a question of
 * file permissions, and nothing on the network can reach a socket by accident.
 */

/** Listens on `path`, replacing a socket left by an earlier run, and sets its mode before anyone connects. */
export async function listenSocket(server: Server, path: string, mode: number): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    // Only ever a socket: a file someone put there by mistake is left alone, and the start fails.
    if (!lstatSync(path).isSocket()) throw new Error(`${path} exists and is not a socket`);
    unlinkSync(path);
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // The socket is made with no permissions for anyone else, then given its mode.
    const umask = process.umask(0o177);
    try {
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    } finally {
      process.umask(umask);
    }
  });
  chmodSync(path, mode);
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** Reads a request body, refusing more than `max` bytes. */
export async function readBody(req: IncomingMessage, max: number): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) return null;
    chunks.push(buf);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * A body of exactly `length` bytes, read into one buffer made for it (no copies of copies); null when
 * the request sends more or less than it said.
 */
export async function readBodyExact(req: IncomingMessage, length: number): Promise<Uint8Array | null> {
  const buf = Buffer.allocUnsafe(length);
  let at = 0;
  for await (const chunk of req) {
    const c = chunk as Buffer;
    if (at + c.length > length) return null;
    c.copy(buf, at);
    at += c.length;
  }
  return at === length ? new Uint8Array(buf.buffer, buf.byteOffset, at) : null;
}

export interface SocketResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

/** One HTTP/1.1 request over a local socket, its answer read whole (calls between our own processes only). */
export async function socketRequest(
  socketPath: string,
  o: {
    readonly method: string;
    readonly target: string;
    readonly headers?: Record<string, string> | undefined;
    readonly body?: Uint8Array | undefined;
    readonly timeoutMs?: number | undefined;
    readonly maxResponse?: number | undefined;
  },
): Promise<SocketResponse> {
  const max = o.maxResponse ?? 8 * 1024 * 1024;
  return await new Promise<SocketResponse>((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        method: o.method,
        path: o.target,
        headers: {
          host: "localhost",
          ...(o.body ? { "content-length": String(o.body.byteLength) } : {}),
          ...(o.headers ?? {}),
        },
        timeout: o.timeoutMs ?? 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > max) {
            res.destroy(new Error("response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(", ");
          }
          resolve({ status: res.statusCode ?? 0, headers, body: new Uint8Array(Buffer.concat(chunks)) });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`no answer from ${socketPath} in time`)));
    req.on("error", reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}

export function jsonOf(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}
