import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { classifyHost, isTenantId, normalizeHost, SLUG_LABEL, shardOf } from "./host";
import { RELAY_PATH, relayTarget } from "./oauth-relay";
import {
  type Answer,
  badHost,
  connectingPage,
  gonePage,
  lockedPage,
  neutralPage,
  notFound,
  reportPage,
  robotsTxt,
  securityTxt,
  unavailablePage,
  wantsHtml,
} from "./pages";
import { validatePlan } from "./plan";
import type { CachedResolver } from "./resolver";
import { decide, REPORT_PATH, ROBOTS_PATH, SECURITY_TXT_PATH } from "./rules";
import { MAX_SIGNED_BODY, NonceCache, signHeaders, verifySigned } from "./sign";
import { jsonOf, readBody, socketRequest } from "./sockets";
import { policyPayloadSchema } from "./types";

/** Raw inbound email, as large as Email Routing accepts. */
export const MAX_INBOUND_EMAIL = 25 * 1024 * 1024;

/**
 * The router: the one process every request for a hosted inbox reaches. It does no SQLite work. It
 * finds the tenant by the name asked for (C1), applies the host rules (C1.4), answers what is its
 * own to answer (security.txt, robots.txt on slug hosts, the report page, the pages that name
 * nobody), and passes the rest to the tenant's shard over that shard's socket, with headers it sets
 * itself (C1.5). On a slug host every answer says `noindex`.
 *
 * Its admin socket (C8.1) takes signed calls from the control plane: tenant calls go on to the
 * tenant's shard, signed again; a cache invalidation and the health count are its own.
 */

export interface RouterOptions {
  /** The parent name slug hosts sit one label under. */
  readonly parent: string;
  readonly resolver: CachedResolver;
  readonly shards: number;
  /** The socket a shard serves requests on. */
  readonly shardSocket: (shard: number) => string;
  /** The socket a shard takes admin calls on. */
  readonly shardAdminSocket: (shard: number) => string;
  /** Where a security problem with this service is reported (`mailto:` or https). */
  readonly securityContact: string;
  /** Where "Report this inbox" sends people: an email address. */
  readonly abuseContact: string;
  /** A report form the operator runs, linked from the report page with the host given (https). */
  readonly reportForm?: string | undefined;
  /** The key the control plane signs admin calls with (`HOSTED_ADMIN_KEY`); checked here, never sent on. */
  readonly adminKey: string;
  /** The key the router signs the calls it passes on to shards with (`HOSTED_SHARD_KEY`). */
  readonly shardKey: string;
  /**
   * The header the server in front puts the client's address in (default `cf-connecting-ip`). The
   * router trusts it as given: the server in front must overwrite it on every request, from the
   * edge's own CF-Connecting-IP, and take connections only from the edge's own pulls for the zone
   * (an origin-pull client certificate of the zone's own CA, nothing proxied over plain http), so
   * that no visitor, and no Worker sending from the edge's ranges, can choose it.
   */
  readonly clientAddressHeader?: string | undefined;
  /** The header the server in front says the visitor's scheme in, as `{"scheme":"http"}` (default `cf-visitor`). */
  readonly visitorSchemeHeader?: string | undefined;
  /**
   * The name Google sends every owner back to after signing in to connect a calendar
   * (`HOSTED_OAUTH_RELAY_HOST`, ADR-022): the router passes them on to their own inbox. Absent, no
   * name is treated so.
   */
  readonly oauthRelayHost?: string | undefined;
  /**
   * The name the email gateway delivers to (`HOSTED_INBOUND_HOST`, ADR-026 §1): `POST
   * /v1/inbound/<slug>` with the raw email, signed with `inboundKey` as the control plane signs its
   * calls (sign.ts), the envelope and what the receiving server found in the signed query. Nothing
   * else is served under it. Absent, no name is treated so.
   */
  readonly inboundHost?: string | undefined;
  /** The key the email gateway signs with (`HOSTED_INBOUND_KEY`); never sent on. */
  readonly inboundKey?: string | undefined;
  /** How long a shard may take to start answering (default 65 s, past the inbox's own minute). */
  readonly shardTimeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

/** https only, for a year, for the name that was asked for: never `includeSubDomains`. */
const HSTS = "max-age=31536000";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Whether the server in front says the visitor came over plain http (`{"scheme":"http"}`). */
export function overPlainHttp(visitor: string | string[] | undefined): boolean {
  const v = Array.isArray(visitor) ? visitor[0] : visitor;
  return typeof v === "string" && /"scheme"\s*:\s*"http"/.test(v);
}

/** The inbox's own cookies from a Cookie header (`sdi_*`, `__Host-sdi_*`), or "" when none. */
export function inboxCookies(header: string | string[]): string {
  const all = (Array.isArray(header) ? header.join("; ") : header).split(/;\s*/);
  return all.filter((c) => /^(__Host-)?sdi_[A-Za-z0-9_]*=/.test(c)).join("; ");
}

function send(res: ServerResponse, a: Answer, extra: Record<string, string> = {}, head = false): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(a.status, { ...a.headers, ...extra });
  res.end(head ? undefined : a.body);
}

export function createRouter(o: RouterOptions): {
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  admin: (req: IncomingMessage, res: ServerResponse) => void;
} {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((line: string) => console.log(line));
  const clientHeader = (o.clientAddressHeader ?? "cf-connecting-ip").toLowerCase();
  const visitorHeader = (o.visitorSchemeHeader ?? "cf-visitor").toLowerCase();

  const handlePublic = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? "GET").toUpperCase();
    const head = method === "HEAD";
    const html = wantsHtml(req.headers.accept);
    const host = normalizeHost(req.headers.host);
    const rawTarget = req.url ?? "/";
    if (!host || !rawTarget.startsWith("/")) return send(res, badHost(), {}, head);
    // Dot segments resolved here exactly as the inbox resolves them, and the path passed on as checked.
    const url = new URL(rawTarget, "http://router.invalid");
    const path = url.pathname;
    const target = `${path}${url.search}`;
    // The email gateway (ADR-026 §1): a signed delivery for one inbox, nothing else.
    if (o.inboundHost && host === o.inboundHost) return inbound(req, res, method, url);
    // The one address Google sends every owner back to: on to the inbox the state names, if it is one.
    if (o.oauthRelayHost && host === o.oauthRelayHost) {
      const hsts = { "strict-transport-security": HSTS };
      if (!(method === "GET" || method === "HEAD") || path !== RELAY_PATH) return send(res, notFound(html), hsts, head);
      const relay = relayTarget(url.search);
      let known = false;
      if (relay) {
        try {
          const found = await o.resolver.lookup(relay.host);
          known = found !== null && found.resolved.state !== "closed";
        } catch (error) {
          log(`router: relay resolve failed (${error instanceof Error ? error.message : error})`);
          return send(res, unavailablePage(html, "unreachable"), hsts, head);
        }
      }
      if (!relay || !known) {
        return send(
          res,
          {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" },
            body: "This sign-in is not for an inbox here.\n",
          },
          { ...hsts, "cache-control": "no-store" },
          head,
        );
      }
      return send(
        res,
        { status: 303, headers: { location: relay.location, "cache-control": "no-store" }, body: "" },
        { ...hsts, "referrer-policy": "no-referrer" },
        head,
      );
    }
    const cls = classifyHost(host, o.parent);
    // Headers every answer for this host carries: on a slug host, noindex and https from now on; on a
    // business's own name, https from now on. Each for that name alone, never its subdomains: the
    // rest of a business's domain is its own, and the parent's other names are not the router's.
    const noindex: Record<string, string> =
      cls.kind === "slug"
        ? { "x-robots-tag": "noindex, nofollow", "strict-transport-security": HSTS }
        : cls.kind === "own"
          ? { "strict-transport-security": HSTS }
          : {};
    // Never routed, through any name.
    if (cls.kind === "none" || path === "/internal" || path.startsWith("/internal/") || path.startsWith("/admin/")) {
      return send(res, notFound(html), noindex, head);
    }
    // Over https only: the server in front says how the visitor came. A read moves to https; a write
    // is refused, never sent on in the clear.
    if (overPlainHttp(req.headers[visitorHeader])) {
      if (method === "GET" || method === "HEAD") {
        return send(
          res,
          { status: 308, headers: { location: `https://${host}${target}`, "cache-control": "no-store" }, body: "" },
          noindex,
          head,
        );
      }
      return send(
        res,
        { status: 400, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Use https.\n" },
        noindex,
        head,
      );
    }
    let found: Awaited<ReturnType<CachedResolver["lookup"]>>;
    try {
      found = await o.resolver.lookup(host);
    } catch (error) {
      log(`router: resolve failed (${error instanceof Error ? error.message : error})`);
      return send(res, unavailablePage(html, "unreachable"), noindex, head);
    }
    if (!found) return send(res, notFound(html), noindex, head);
    const r = found.resolved;
    const reads = method === "GET" || method === "HEAD";
    if (reads && path === SECURITY_TXT_PATH) {
      return send(res, securityTxt({ host, contact: o.securityContact, now: now() }), noindex, head);
    }
    if (reads && path === REPORT_PATH)
      return send(res, reportPage({ host, abuse: o.abuseContact, form: o.reportForm }), noindex, head);
    if (reads && path === ROBOTS_PATH && r.kind === "slug") return send(res, robotsTxt(), noindex, head);
    const d = decide(r, {
      method,
      path,
      search: url.search,
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
    });
    switch (d.kind) {
      case "neutral":
        return send(res, neutralPage(), noindex, head);
      case "redirect":
        return send(
          res,
          { status: 308, headers: { location: d.location, "cache-control": "no-store" }, body: "" },
          noindex,
          head,
        );
      case "not_found":
        return send(res, notFound(html, d.movedTo), noindex, head);
      case "gone":
        return send(res, gonePage(html), noindex, head);
      case "jwks":
        if (!found.jwks) return send(res, gonePage(html), noindex, head);
        return send(
          res,
          {
            status: 200,
            headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
            body: JSON.stringify(found.jwks),
          },
          noindex,
          head,
        );
      case "locked":
        return send(res, lockedPage(html, d.why), noindex, head);
      case "connecting":
        return send(res, connectingPage(html), noindex, head);
      case "proxy":
        return proxy(req, res, {
          tenantId: r.tenantId,
          kind: r.kind,
          version: r.policyVersion,
          shard: r.shard,
          target,
          noindex,
          html,
        });
    }
  };

  const proxy = (
    req: IncomingMessage,
    res: ServerResponse,
    t: {
      tenantId: string;
      kind: "slug" | "own";
      version: number;
      shard: number;
      target: string;
      noindex: Record<string, string>;
      html: boolean;
    },
  ): void => {
    const connection = String(req.headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((h) => h.trim());
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const k = name.toLowerCase();
      if (value === undefined || HOP_BY_HOP.has(k) || connection.includes(k)) continue;
      // Nobody outside sets these: the router's own, and the proxy headers it writes itself.
      if (k.startsWith("x-sd-") || k.startsWith("x-forwarded-") || k === "forwarded" || k === "x-real-ip") continue;
      // Only the inbox's own cookies go on: the cookies a business's site (or another service under
      // the same parent) sets for its whole domain are none of the inbox's business.
      if (k === "cookie") {
        const kept = inboxCookies(value);
        if (kept) headers.cookie = kept;
        continue;
      }
      headers[k] = value;
    }
    // The caller's address, for the inbox's limits and its anonymous callers: whatever the server in
    // front wrote in this header, and only as good as that server makes it. It must come from the
    // edge's own CF-Connecting-IP (the edge overwrites what a visitor sends there), never from the
    // left end of X-Forwarded-For, which the edge appends to and the visitor writes; and only on a
    // connection that carried the zone's origin-pull certificate, since a Worker's subrequest comes
    // from the edge's ranges too and may set CF-Connecting-IP to anything (`clientAddressHeader`).
    const client = req.headers[clientHeader];
    const address = typeof client === "string" ? client.split(",")[0]?.trim() : undefined;
    delete headers["cf-connecting-ip"];
    if (address) {
      headers["cf-connecting-ip"] = address;
      headers["x-forwarded-for"] = address;
    }
    headers["x-forwarded-proto"] = "https";
    headers["x-sd-tenant"] = t.tenantId;
    headers["x-sd-host-kind"] = t.kind;
    headers["x-sd-policy-version"] = String(t.version);
    const head = req.method === "HEAD";
    const upstream = httpRequest({
      socketPath: o.shardSocket(t.shard),
      method: req.method,
      path: t.target,
      headers,
      timeout: o.shardTimeoutMs ?? 65_000,
    });
    upstream.on("response", (up) => {
      const out: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(up.headers)) {
        const k = name.toLowerCase();
        if (value === undefined || HOP_BY_HOP.has(k) || k.startsWith("x-sd-")) continue;
        out[k] = value;
      }
      res.writeHead(up.statusCode ?? 502, { ...out, ...t.noindex });
      up.pipe(res);
      up.on("error", () => res.destroy());
    });
    upstream.on("timeout", () => upstream.destroy(new Error("the shard did not answer in time")));
    upstream.on("error", (error) => {
      log(`router: shard ${t.shard} for ${t.tenantId}: ${error.message}`);
      if (!res.headersSent) send(res, unavailablePage(t.html, "unreachable"), t.noindex, head);
      else res.destroy();
    });
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  };

  // ---- email in (ADR-026 §1) ----------------------------------------------------------------------

  const mailNonces = new NonceCache();

  /** A plain answer the gateway reads by its status: 2xx taken, 4xx refused for good, 5xx and 429 later. */
  const mailAnswer = (res: ServerResponse, status: number, detail: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra });
    res.end(`${detail}\n`);
  };

  const inbound = async (req: IncomingMessage, res: ServerResponse, method: string, url: URL): Promise<void> => {
    const m = /^\/v1\/inbound\/([a-z0-9-]{1,63})$/.exec(url.pathname);
    if (method !== "POST" || !m || !o.inboundKey) return mailAnswer(res, 404, "Not here.");
    const slug = m[1] ?? "";
    const body = await readBody(req, MAX_INBOUND_EMAIL);
    if (!body) return mailAnswer(res, 413, "Too large.");
    const target = `${url.pathname}${url.search}`;
    const checked = verifySigned(
      o.inboundKey,
      mailNonces,
      { method, target, headers: { get: (n) => (req.headers[n] as string | undefined) ?? null }, body },
      now(),
    );
    if (!checked.ok) return mailAnswer(res, 401, `Not signed (${checked.why}).`);
    const to = url.searchParams.get("to") ?? "";
    // The address the email was for names the inbox, with or without a conversation's plus part.
    const local = to.toLowerCase().split("@")[0]?.split("+")[0] ?? "";
    if (!SLUG_LABEL.test(slug) || local !== slug || body.byteLength === 0) {
      return mailAnswer(res, 422, "No such address.");
    }
    let found: Awaited<ReturnType<CachedResolver["lookup"]>>;
    try {
      found = await o.resolver.lookup(`${slug}.${o.parent}`);
    } catch (error) {
      log(`router: inbound resolve failed (${error instanceof Error ? error.message : error})`);
      return mailAnswer(res, 503, "Try again later.");
    }
    // No inbox by that name, or one that closed: refused for good, so the sender is told.
    if (!found || found.resolved.state === "closed" || found.resolved.state === "closing") {
      return mailAnswer(res, 422, "No such address.");
    }
    // Suspended: held back, never bounced, until it is let out again (the sender retries for days).
    if (found.resolved.state === "suspended") return mailAnswer(res, 503, "Not taking email right now.");
    const r = found.resolved;
    const auth = url.searchParams.get("auth");
    try {
      const up = await socketRequest(o.shardSocket(r.shard), {
        method: "POST",
        target: "/v1/email/inbound",
        headers: {
          "content-type": "message/rfc822",
          "x-sd-tenant": r.tenantId,
          "x-sd-host-kind": "slug",
          "x-sd-policy-version": String(r.policyVersion),
          "x-sd-mail-in": "1",
          "x-envelope-to": to,
          "x-envelope-from": url.searchParams.get("from") ?? "",
          ...(auth ? { "x-inbox-email-auth": auth } : {}),
        },
        body,
        timeoutMs: o.shardTimeoutMs ?? 65_000,
        maxResponse: 64 * 1024,
      });
      const retry = up.headers["retry-after"];
      return mailAnswer(
        res,
        up.status,
        up.status < 300 ? "Taken." : "Not taken.",
        retry ? { "retry-after": retry } : {},
      );
    } catch (error) {
      log(`router: inbound email for ${r.tenantId}: ${error instanceof Error ? error.message : error}`);
      return mailAnswer(res, 503, "Try again later.");
    }
  };

  // ---- admin -------------------------------------------------------------------------------------

  const nonces = new NonceCache();

  const adminAnswer = (res: ServerResponse, status: number, body?: unknown): void => {
    if (status === 204 || body === undefined) {
      res.writeHead(status, { "cache-control": "no-store" });
      res.end();
      return;
    }
    const problemish = status >= 400;
    res.writeHead(status, {
      "content-type": problemish ? "application/problem+json" : "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
  };
  const problem = (code: string, status: number, detail: string, extra: Record<string, unknown> = {}) => ({
    type: `https://surfingdog.ai/problems/${code}`,
    title: code,
    status,
    code,
    detail,
    ...extra,
  });

  /** One admin call passed on to a shard, signed again with the shards' key, its answer passed back. */
  const toShard = async (shard: number, method: string, target: string, body: Uint8Array) => {
    const res = await socketRequest(o.shardAdminSocket(shard), {
      method,
      target,
      headers: {
        ...signHeaders(o.shardKey, method, target, body),
        ...(body.byteLength ? { "content-type": "application/json" } : {}),
      },
      body: body.byteLength ? body : undefined,
      timeoutMs: 120_000,
    });
    return { status: res.status, body: res.body.byteLength ? jsonOf(res.body) : undefined };
  };

  const handleAdmin = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? "GET").toUpperCase();
    const target = req.url ?? "/";
    const body = await readBody(req, MAX_SIGNED_BODY);
    if (!body) return adminAnswer(res, 413, problem("too_large", 413, "At most 1 MB."));
    const checked = verifySigned(
      o.adminKey,
      nonces,
      { method, target, headers: { get: (n) => (req.headers[n] as string | undefined) ?? null }, body },
      now(),
    );
    if (!checked.ok) return adminAnswer(res, 401, problem("unauthorized", 401, `Not signed (${checked.why}).`));
    const url = new URL(target, "http://router.invalid");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "admin" || parts[1] !== "v1")
      return adminAnswer(res, 404, problem("not_found", 404, "No such call."));
    const rest = parts.slice(2);
    const json = body.byteLength ? jsonOf(body) : undefined;

    if (rest[0] === "cache" && rest[1] === "invalidate" && rest.length === 2 && method === "POST") {
      const hosts = (json as { hosts?: unknown } | null)?.hosts;
      if (!Array.isArray(hosts) || hosts.length > 1000) {
        return adminAnswer(res, 422, problem("invalid_input", 422, "Send {hosts: [...]}."));
      }
      o.resolver.invalidate(
        hosts.map((h) => (typeof h === "string" ? normalizeHost(h) : null)).filter((h) => h !== null),
      );
      return adminAnswer(res, 204);
    }
    if (rest[0] === "plans" && rest[1] === "validate" && rest.length === 2 && method === "POST") {
      const v = validatePlan(json);
      return v.ok
        ? adminAnswer(res, 200, { ok: true })
        : adminAnswer(res, 422, problem("invalid_input", 422, "The plan is not valid.", { fields: v.fields }));
    }
    if (rest[0] === "health" && rest.length === 1 && method === "GET") {
      const shards = await Promise.all(
        Array.from({ length: o.shards }, async (_, shard) => {
          try {
            const r = await toShard(shard, "GET", "/admin/v1/health", new Uint8Array());
            return r.status === 200 ? { up: true, ...(r.body as Record<string, unknown>) } : { shard, up: false };
          } catch {
            return { shard, up: false };
          }
        }),
      );
      return adminAnswer(res, 200, { hosts_cached: o.resolver.size, shards });
    }
    if (rest[0] !== "tenants") return adminAnswer(res, 404, problem("not_found", 404, "No such call."));
    let id: string;
    if (rest.length === 1 && method === "POST") {
      const b = (json ?? {}) as { tenant_id?: unknown; slug_host?: unknown; policy?: unknown };
      const slug = typeof b.slug_host === "string" ? normalizeHost(b.slug_host) : null;
      const cls = slug ? classifyHost(slug, o.parent) : null;
      const fields = [
        ...(isTenantId(b.tenant_id) ? [] : [{ path: "tenant_id", problem: "invalid", message: "tn_ and a ULID" }]),
        ...(cls?.kind === "slug" && SLUG_LABEL.test(slug?.split(".")[0] ?? "")
          ? []
          : [{ path: "slug_host", problem: "invalid", message: `one slug label under ${o.parent}` }]),
        ...(policyPayloadSchema.safeParse(b.policy).success
          ? []
          : [{ path: "policy", problem: "invalid", message: "a policy (C8.3)" }]),
      ];
      if (fields.length > 0 || !isTenantId(b.tenant_id)) {
        return adminAnswer(
          res,
          422,
          problem("invalid_input", 422, "The tenant cannot be created as sent.", { fields }),
        );
      }
      id = b.tenant_id;
    } else {
      id = rest[1] ?? "";
      if (!isTenantId(id)) return adminAnswer(res, 404, problem("not_found", 404, "No such tenant."));
    }
    const shard = shardOf(id, o.shards);
    try {
      const answer = await toShard(shard, method, target, body);
      return adminAnswer(res, answer.status, answer.body);
    } catch (error) {
      log(`router: admin call to shard ${shard}: ${error instanceof Error ? error.message : error}`);
      return adminAnswer(res, 503, problem("unavailable", 503, `Shard ${shard} did not answer.`));
    }
  };

  const guard =
    (inner: (req: IncomingMessage, res: ServerResponse) => Promise<void>) =>
    (req: IncomingMessage, res: ServerResponse) => {
      inner(req, res).catch((error) => {
        log(`router: ${error instanceof Error ? error.message : error}`);
        if (!res.headersSent) send(res, unavailablePage(false, "unreachable"));
        else res.destroy();
      });
    };
  return { handle: guard(handlePublic), admin: guard(handleAdmin) };
}
