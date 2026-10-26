import type { ConnectorHttp } from "@surfingdog/core";
import { connectorHttp } from "../../src/connectors/http";

/**
 * A fake platform for connector tests (ADR-030 §8): no real platform is ever called. Routes answer by
 * method and URL with what a test hands them (fixtures written from each platform's documented
 * examples), every request is kept with its headers and body (to check auth, idempotency keys and what
 * was sent), and a route can be made to fail the way platforms do: 401, 429 with Retry-After, 5xx, a
 * timeout, or a redirect (to another host, a private one, plain http).
 *
 * `http` is the inbox's own connector client (`connectorHttp`) over the fake: https only, public hosts
 * only, redirects checked hop by hop, bounded size and time, exactly as in production, so a connector
 * test proves its SSRF refusals too. `fetch` is the fake alone, for a whole inbox (`createInbox`'s
 * `fetchImpl`). Web APIs only: it runs the same on Node and in workerd.
 */

export interface FakeRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string;
  /** What the route's `:name` parts matched. */
  readonly params: Readonly<Record<string, string>>;
}

export type FakeHandler = (req: FakeRequest) => Response | Promise<Response>;

/** How a route fails, once per request it is set for. */
export type FakeFailure =
  | 401
  | 403
  | 404
  | 429
  | 500
  | 502
  | 503
  | "timeout"
  | { readonly redirect: string; readonly status?: 301 | 302 | 303 | 307 | 308 };

interface Route {
  readonly method: string;
  readonly host: string;
  readonly path: RegExp;
  readonly names: readonly string[];
  readonly handler: FakeHandler;
}

export interface FakePlatform {
  /** Every request, in order, as the platform received it. */
  readonly seen: FakeRequest[];
  /** The fake alone: give it to `createInbox` (`fetchImpl`) or to `connectorHttp`. */
  readonly fetch: typeof fetch;
  /** The inbox's own connector client over the fake: every production check applies. */
  readonly http: ConnectorHttp;
  /**
   * Answers `method` requests to `url` (`https://host/path/:id`, `:name` parts captured; a trailing
   * `*` takes the rest). The first route that matches answers; an unmatched request gets 404.
   */
  on(method: string, url: string, handler: FakeHandler): FakePlatform;
  /** The next `times` requests to a route matching `method` and `url` fail as `failure` says. */
  fail(method: string, url: string, failure: FakeFailure, times?: number): FakePlatform;
  /** The requests to a host and a path that starts with `path`. */
  requests(method: string, url: string): FakeRequest[];
}

export function fakePlatform(): FakePlatform {
  const routes: Route[] = [];
  const failures: { method: string; host: string; path: RegExp; failure: FakeFailure; left: number }[] = [];
  const seen: FakeRequest[] = [];

  const compile = (url: string) => {
    const u = new URL(url.replace(/\*$/, "__rest__"));
    const names: string[] = [];
    const source = decodeURIComponent(u.pathname)
      .split("/")
      .map((part) => {
        if (part === "__rest__") {
          names.push("rest");
          return "(.*)";
        }
        if (part.startsWith(":")) {
          names.push(part.slice(1));
          return "([^/]+)";
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    return { host: u.host, path: new RegExp(`^${source}$`), names };
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    const path = decodeURIComponent(url.pathname);
    const failure = failures.find((f) => f.left > 0 && f.method === method && f.host === url.host && f.path.test(path));
    let params: Record<string, string> = {};
    const route = routes.find((r) => {
      if (r.method !== method || r.host !== url.host) return false;
      const m = r.path.exec(path);
      if (!m) return false;
      params = Object.fromEntries(r.names.map((n, i) => [n, m[i + 1] ?? ""]));
      return true;
    });
    const req: FakeRequest = { method, url, headers, body, params };
    seen.push(req);
    if (failure) {
      failure.left--;
      const f = failure.failure;
      if (f === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
      if (typeof f === "object")
        return new Response(null, { status: f.status ?? 302, headers: { location: f.redirect } });
      return new Response(JSON.stringify({ error: `fake ${f}` }), {
        status: f,
        headers: { "content-type": "application/json", ...(f === 429 ? { "retry-after": "7" } : {}) },
      });
    }
    if (!route) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    return route.handler(req);
  }) as typeof fetch;

  const platform: FakePlatform = {
    seen,
    fetch: fetchImpl,
    http: connectorHttp({ fetchImpl }),
    on(method, url, handler) {
      const c = compile(url);
      routes.push({ method: method.toUpperCase(), host: c.host, path: c.path, names: c.names, handler });
      return platform;
    },
    fail(method, url, failure, times = 1) {
      const c = compile(url);
      failures.push({ method: method.toUpperCase(), host: c.host, path: c.path, failure, left: times });
      return platform;
    },
    requests(method, url) {
      const u = new URL(url);
      return seen.filter(
        (r) => r.method === method.toUpperCase() && r.url.host === u.host && r.url.pathname.startsWith(u.pathname),
      );
    },
  };
  return platform;
}

/** A JSON answer, as platforms send them. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
