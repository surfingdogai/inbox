import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { pipeline, Readable } from "node:stream";
import zlib from "node:zlib";
import { type AddressRange, addressOfHost, refusedAddress, refusedAddressText } from "../addresses";

/**
 * A `fetch` for every call this instance makes to an address someone else chose: webhooks, product
 * feeds, OAuth Client ID Metadata Documents, platforms' key directories and networks. Each of those
 * checks the name first (`isPublicHost` in `@surfingdog/core`); this checks what the name resolves
 * to, and connects to the address it checked.
 *
 * A name is resolved once, every address it has is held to `refusedAddress` (one bad address and
 * the call is refused, so a name cannot hide a private address behind a public one), and the socket
 * is handed exactly those addresses through Node's `lookup` hook. Nothing resolves the name a second
 * time between the check and the connection, which is the gap a rebinding name answers differently
 * in. An address written into the URL is checked the same way, and every redirect it follows is a
 * new call, checked again. TLS still verifies the certificate against the name.
 *
 * It speaks HTTP/1.1 over `node:http`, without keep-alive, and decodes gzip, deflate and brotli as
 * fetch does. A Worker has nothing like it: the runtime resolves names itself and lets no code pin
 * an address, so there the name rules are what holds (see docs: Security and privacy).
 */
export interface PinnedFetchOptions {
  /** Ranges refused besides the built-in ones: the host's own public addresses, say (INBOX_OUTBOUND_DENY). */
  readonly deny?: readonly AddressRange[] | undefined;
  /**
   * Lifts the built-in ranges, for a webhook the owner pointed at a machine of their own
   * (`integrations.webhooks.allowPrivateTargets`). `deny` still holds.
   */
  readonly allowPrivate?: boolean | undefined;
  /** How a name is resolved: every address it has. Tests pass their own; the default asks the system resolver. */
  readonly resolve?: ((hostname: string) => Promise<readonly ResolvedAddress[]>) | undefined;
  /** The most redirects a call that asks to follow them is taken through. Default 5. */
  readonly maxRedirects?: number | undefined;
  /**
   * How long a connection may sit with nothing moving before it is closed, in milliseconds: a server
   * that stops half-way, or a body nobody reads, never holds a socket for good. Default 60 s.
   */
  readonly idleTimeoutMs?: number | undefined;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** A call refused before anything was sent: the address it would reach is not one this instance calls. */
export class OutboundRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundRefused";
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function pinnedFetch(opts: PinnedFetchOptions = {}): typeof fetch {
  const resolve = opts.resolve ?? systemResolve;
  const idle = opts.idleTimeoutMs ?? 60_000;
  const why = (address: string): string | null => {
    const kind = refusedAddress(address, opts);
    return kind ? refusedAddressText(kind) : null;
  };

  // Node's socket asks this for the addresses to connect to, and connects only to what it answers.
  const lookup: LookupFunction = (hostname, options, callback) => {
    const want =
      options.family === 4 || options.family === "IPv4" ? 4 : options.family === 6 || options.family === "IPv6" ? 6 : 0;
    resolve(hostname)
      .then((all) => {
        for (const a of all) {
          const refused = why(a.address);
          if (refused) throw new OutboundRefused(`${hostname} resolves to ${a.address}, ${refused}: not called`);
        }
        const fit = all.filter((a) => !want || a.family === want);
        if (!fit[0]) throw Object.assign(new Error(`${hostname} has no address`), { code: "ENOTFOUND" });
        return fit;
      })
      .then(
        (fit) => {
          const first = fit[0] as ResolvedAddress;
          if (options.all)
            callback(
              null,
              fit.map((a) => ({ address: a.address, family: a.family })),
            );
          else callback(null, first.address, first.family);
        },
        (error: NodeJS.ErrnoException) => callback(error, ""),
      );
  };

  const once = (url: URL, method: string, headers: Headers, body: Uint8Array | null, signal: AbortSignal) =>
    new Promise<Response>((done, fail) => {
      const literal = addressOfHost(url.hostname);
      const refused = literal ? why(literal) : null;
      if (refused) {
        fail(new OutboundRefused(`${url.hostname} is ${refused}: not called`));
        return;
      }
      const out: Record<string, string> = {};
      headers.forEach((value, key) => {
        out[key] = value;
      });
      out["accept-encoding"] ??= "gzip, deflate, br";
      if (body) out["content-length"] = String(body.byteLength);
      const req = (url.protocol === "https:" ? https : http).request(
        url,
        { method, headers: out, lookup, agent: false, signal, timeout: idle },
        (res) => {
          try {
            done(toResponse(res, method));
          } catch (error) {
            res.destroy();
            fail(error);
          }
        },
      );
      req.on("timeout", () => req.destroy(new Error(`${url.host} sent nothing for ${idle / 1000} s`)));
      req.on("error", fail);
      req.end(body ?? undefined);
    });

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const signal = request.signal;
    if (signal.aborted) throw signal.reason;
    let url = new URL(request.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError(`${url.protocol} is not fetched`);
    let method = request.method;
    let body = method === "GET" || method === "HEAD" ? null : new Uint8Array(await request.arrayBuffer());
    const headers = new Headers(request.headers);
    const max = opts.maxRedirects ?? 5;
    for (let hop = 0; ; hop++) {
      const res = await once(url, method, headers, body, signal);
      const location = res.headers.get("location");
      if (!REDIRECTS.has(res.status) || location === null || request.redirect === "manual") return res;
      await res.body?.cancel();
      if (request.redirect === "error") throw new TypeError(`${url.host} redirected, and this call follows none`);
      if (hop >= max) throw new TypeError(`more than ${max} redirects from ${request.url}`);
      const next = new URL(location, url);
      if (next.protocol !== "https:" && next.protocol !== "http:")
        throw new TypeError(`a redirect to ${next.protocol}`);
      if (res.status === 303 ? method !== "HEAD" : (res.status === 301 || res.status === 302) && method === "POST") {
        method = "GET";
        body = null;
        for (const h of ["content-type", "content-encoding", "content-language", "content-location"]) headers.delete(h);
      }
      // What proves who the caller is stays with the origin it was meant for.
      if (next.origin !== url.origin)
        for (const h of ["authorization", "cookie", "proxy-authorization"]) headers.delete(h);
      url = next;
    }
  }) as typeof fetch;
}

function systemResolve(hostname: string): Promise<readonly ResolvedAddress[]> {
  return new Promise((done, fail) => {
    dnsLookup(hostname, { all: true, order: "verbatim" }, (error, addresses) =>
      error ? fail(error) : done(addresses),
    );
  });
}

/** Node's answer as a web Response: the headers as sent, the body decoded as fetch would and streamed. */
function toResponse(res: http.IncomingMessage, method: string): Response {
  const status = res.statusCode ?? 0;
  const headers = new Headers();
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
    headers.append(res.rawHeaders[i] as string, res.rawHeaders[i + 1] as string);
  }
  const init = { status, statusText: res.statusMessage ?? "", headers };
  if (method === "HEAD" || status === 204 || status === 205 || status === 304) {
    res.resume();
    return new Response(null, init);
  }
  const encoding = String(res.headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  const flush = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? zlib.createGunzip(flush)
      : encoding === "deflate"
        ? zlib.createInflate(flush)
        : encoding === "br"
          ? zlib.createBrotliDecompress()
          : null;
  const stream: Readable = decoder ? pipeline(res, decoder, () => {}) : res;
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, init);
}
