import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { type Caller, type Capabilities, copyFor, type Db, WriteError } from "@surfingdog/core";
import type { MailOut } from "@surfingdog/platform";
import type { Context, Hono } from "hono";
import { openAPIRouteHandler } from "hono-openapi";
import { callerFromRequest, scopeFor } from "./auth";
import { customerPage, pageLang, renderCustomerPage } from "./customer-page";
import { ingestEmail } from "./email";
import { agentFromRequest } from "./identity";
import {
  clientAddress,
  consume,
  EVERYONE,
  isCreateRoute,
  isNegotiateRoute,
  isVerifyRoute,
  LIMITS,
  type LimitClass,
  type LimitTable,
  mcpCosts,
} from "./limits";
import { createOwnerMcpHandler, createPublicMcpHandler } from "./mcp";
import { authorizationServerMetadata, type ClientMetadata, oauthRoutes, protectedResourceMetadata } from "./oauth";
import { publicOrigin } from "./origin";
import { forbidden, problemResponse, replayedSignature, tooManyRequests, unauthorized } from "./problem";
import { type CallerEnv, ownerRest, publicRest } from "./rest";
import { safeFetchJson } from "./safe-fetch";
import { authRoutes } from "./session";

export * from "./access";
export * from "./auth";
export * from "./customer-page";
export * from "./email";
export * from "./feeds/index";
export * from "./identity";
export * from "./limits";
export * from "./mcp";
export * from "./network";
export * from "./oauth";
export * from "./origin";
export * from "./problem";
export * from "./responses";
export * from "./rest";
export * from "./safe-fetch";
export * from "./session";
export * from "./untrusted";
export * from "./webhooks/index";

export interface DoorDeps {
  readonly db: Db;
  readonly caps: Capabilities;
  readonly version: string;
  readonly title?: string;
  /** Whether the instance is in test mode right now (every item becomes sandbox). */
  readonly sandbox?: () => Promise<boolean>;
  readonly mailOut: MailOut;
  readonly businessName: () => Promise<string>;
  /** Resolves Client ID Metadata Documents; defaults to the SSRF-safe fetcher. */
  readonly fetchClientMetadata?: ((url: string) => Promise<ClientMetadata | null>) | undefined;
  readonly now?: (() => number) | undefined;
  /** Shared secret for the raw-MIME inbound webhook; null disables it. */
  readonly inboundEmailSecret?: (() => Promise<string | null>) | undefined;
  /** The instance's public URL (INBOX_PUBLIC_URL); wins over the request URL behind a proxy. */
  readonly baseUrl?: string | undefined;
  /** Addresses that may create the first account by magic link. */
  readonly ownerEmails?: (() => Promise<readonly string[]>) | undefined;
  /** Outbound fetch for agents' key directories (tests inject a fake). */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Other numbers than `LIMITS` for some classes, per caller (a public demo sets `DEMO_LIMITS`). */
  readonly limits?: LimitTable | undefined;
  /** Buckets every caller shares, taken after the caller's own (a public demo sets `DEMO_SHARED`). */
  readonly sharedLimits?: LimitTable | undefined;
}

/** Cookie sessions only write from our own origin; keys and OAuth tokens carry no ambient authority. */
function sameOrigin(request: Request, baseUrl: string | undefined): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return true;
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  return origin === publicOrigin(request, baseUrl) || origin === new URL(request.url).origin;
}

/** The longest idempotency key a door accepts, header or field. */
const MAX_IDEMPOTENCY_KEY = 200;

/**
 * Whether a request carries an idempotency key, in the header or anywhere in its JSON body (a REST
 * field, or an MCP tool's argument): a repeated signature on such a request is a retry, answered
 * from what was stored; without one it is a replay (ADR-017 §2.4).
 */
async function carriesIdempotencyKey(request: Request, body?: string): Promise<boolean> {
  if (request.headers.get("idempotency-key")) return true;
  try {
    const text = body ?? (await request.clone().text());
    return /"idempotency_key"\s*:\s*"[^"]/.test(text);
  } catch {
    return false;
  }
}

/**
 * Who a retry must come from (ADR-017 §2.4): the caller's idempotency scope and the
 * `Idempotency-Key` header, kept with a signature the first time it is seen. A key in the body needs
 * no keeping: the body is covered by the signature's digest, so a copy carries the same one.
 */
function retryIdentity(caller: Caller, request: Request): string {
  return `${scopeFor(caller)}\n${request.headers.get("idempotency-key") ?? ""}`;
}

/**
 * A signature seen before: answered from the idempotency layer only when it is the first request's
 * retry — the same sender, the same idempotency key — and a copy (`401 replayed_signature`) otherwise.
 */
async function isCopy(
  seen: Awaited<ReturnType<typeof agentFromRequest>>,
  request: Request,
  body?: string,
): Promise<boolean> {
  return seen.replayed && !(seen.retry === true && (await carriesIdempotencyKey(request, body)));
}

/** An MCP request's body, read once: its bytes, as text, and parsed when it is JSON. */
interface McpBody {
  /** Null for a request without a body (a GET or a DELETE). */
  readonly bytes: Uint8Array | null;
  readonly text: string;
  /** The JSON-RPC message or batch; undefined when there is no body or it is not JSON. */
  readonly parsed: unknown;
}

/**
 * Reads an MCP request's body exactly once, or answers null when it cannot be read.
 *
 * Everything the door needs from the body — which tools it calls (for the limits), its bytes (for a
 * signature's digest), whether it carries an idempotency key — and the MCP handler itself work from
 * this one reading, so no copy of the body is ever made. Before, every POST was copied three times
 * for the limits and once more by the MCP handler, which on the 2026-07-28 path never read its copy:
 * a branch of the request's stream left open for as long as the request lived.
 */
async function readMcpBody(request: Request): Promise<McpBody | null> {
  if (request.method !== "POST" || request.body === null) return { bytes: null, text: "", parsed: undefined };
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return null;
  }
  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { bytes, text, parsed };
}

/** The JSON-RPC answer to a body that could not be read, as the MCP handler gives it. */
function unreadableBody(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32700, message: "Parse error: the request body could not be read" }, id: null },
    { status: 400 },
  );
}

/**
 * Hands a request to an MCP handler with the body the door already read. JSON goes as `parsedBody`,
 * so the handler neither copies nor reads the request; anything else (empty, or not JSON) goes as a
 * fresh request over the same bytes, for the handler to answer with its own parse error.
 */
function serveMcp(
  handler: McpHttpHandler,
  request: Request,
  body: McpBody,
  authInfo: NonNullable<NonNullable<Parameters<McpHttpHandler["fetch"]>[1]>["authInfo"]>,
): Promise<Response> {
  if (body.parsed !== undefined) return handler.fetch(request, { authInfo, parsedBody: body.parsed });
  if (body.bytes === null) return handler.fetch(request, { authInfo });
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  const again = new Request(request.url, { method: request.method, headers, body: body.bytes as BufferSource });
  return handler.fetch(again, { authInfo });
}

/** A caller as a signed agent's request makes it (ADR-017 §2.4): what the door verified, and `Sdi-Pass`. */
function withAgent<C extends Caller>(caller: C, seen: Awaited<ReturnType<typeof agentFromRequest>>): C {
  const signed = seen.agent.level !== "none";
  return {
    ...caller,
    agent: seen.agent,
    carried: seen.carried,
    ...(signed && caller.tier === "anonymous" ? { tier: "signed_agent" as const } : {}),
  };
}

/** The link page's own "too many attempts", in the customer's language, never a JSON problem. */
async function tooManyPage(c: Context, deps: DoorDeps): Promise<Response> {
  const lang = await pageLang(deps.caps, c.req.header("accept-language") ?? null);
  const business = await deps.businessName();
  const res = renderCustomerPage(c, {
    status: 429,
    lang,
    business,
    heading: copyFor(lang).page.tooMany,
    footer: business,
    help: "",
  });
  res.headers.set("Retry-After", "600");
  return res;
}

/** Mounts every door on the app: REST at /v1, the OpenAPI document, and MCP at /mcp and /mcp/owner. */
export function mountDoors(app: Hono<CallerEnv>, deps: DoorDeps): void {
  const sandbox = deps.sandbox ?? (async () => false);
  const clock = () => (deps.now ? deps.now() : Date.now());

  /**
   * Takes a token from each class in turn; the first refusal answers 429 (limits.ts). A caller with
   * a verified key is counted by its key, so an integration posting for many visitors from one
   * server is not lumped in with everyone else behind that address; everyone else, by address.
   * The wording is for anyone: it can reach a visitor through a website the business runs.
   */
  const limited = async (
    c: Context,
    classes: readonly LimitClass[],
    keyId?: string | undefined,
    costs: Partial<Record<LimitClass, number>> = {},
  ): Promise<Response | null> => {
    const who = keyId ? `key:${keyId}` : `ip:${clientAddress(c.req.raw)}`;
    for (const cls of classes) {
      const cost = costs[cls] ?? 1;
      const own = await consume(deps.db, cls, who, clock(), deps.limits?.[cls] ?? LIMITS[cls], cost);
      const shared = deps.sharedLimits?.[cls];
      const v = own.allowed && shared ? await consume(deps.db, cls, EVERYONE, clock(), shared, cost) : own;
      if (!v.allowed) {
        return tooManyRequests(c, "Too many requests right now; wait a few minutes and try again.", v.retryAfterSec);
      }
    }
    return null;
  };

  app.use("/v1/*", async (c, next) => {
    // The header is held to the same bound as the `idempotency_key` field every schema checks: it
    // is stored as the key, so an unbounded one is an unbounded row.
    if ((c.req.header("idempotency-key")?.length ?? 0) > MAX_IDEMPOTENCY_KEY) {
      return problemResponse(
        c,
        new WriteError("invalid_input", `Idempotency-Key is over ${MAX_IDEMPOTENCY_KEY} characters`, {
          fields: [
            { path: "Idempotency-Key", problem: "invalid", message: `at most ${MAX_IDEMPOTENCY_KEY} characters` },
          ],
        }),
      );
    }
    const caller = await callerFromRequest(deps.db, c.req.raw, { channel: "rest", sandbox: await sandbox() });
    if (
      caller.auth?.via === "session" &&
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      !sameOrigin(c.req.raw, deps.baseUrl)
    ) {
      return forbidden(c, "Cross-site writes with a session cookie are refused; call from the app or use an API key.");
    }
    // An integration key has a soft bucket of its own, on every call, so a loop between this inbox
    // and the system it is pasted into cannot run for ever. The owner's session and AI are not counted.
    if (caller.principal?.keyKind === "integration") {
      const refused = await limited(c, ["integration"], caller.principal.id);
      if (refused) return refused;
    }
    // Writes from anyone but the verified owner are limited. The inbound mail webhook is not: it is
    // authenticated by its own secret, and every message arrives from the one gateway address.
    const signed = c.req.header("signature-input") !== undefined;
    if (
      caller.auth?.kind !== "owner" &&
      (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) || signed) &&
      c.req.path !== "/v1/email/inbound"
    ) {
      // Tokens come before any signature work (ADR-017 §2.4), so a signed GET takes one too.
      const refused = await limited(
        c,
        isCreateRoute(c.req.method, c.req.path)
          ? ["public", "create"]
          : isVerifyRoute(c.req.method, c.req.path)
            ? ["public", "verify"]
            : isNegotiateRoute(c.req.method, c.req.path)
              ? ["public", "negotiate"]
              : ["public"],
        caller.auth?.id,
      );
      if (refused) return refused;
    }
    if (caller.auth?.kind === "owner" || c.req.path === "/v1/email/inbound") {
      c.set("caller", caller);
      await next();
      return;
    }
    const seen = await agentFromRequest(deps.db, c.req.raw, {
      baseUrl: deps.baseUrl,
      fetchImpl: deps.fetchImpl,
      now: clock(),
      retryAs: retryIdentity(caller, c.req.raw),
    });
    if (seen.header) c.header("Sdi-Signature", seen.header);
    if (await isCopy(seen, c.req.raw)) return replayedSignature(c);
    // A platform's key has a bucket of its own, recognised by a network or not; a self-held key never.
    if (seen.agent.platform) {
      const refused = await limited(c, ["platform"], `platform:${seen.agent.platform}`);
      if (refused) return refused;
    }
    c.set("caller", withAgent(caller, seen));
    await next();
  });
  // Sign-in links go to the owner's mailbox; nobody gets to fill it.
  app.use("/auth/*", async (c, next) => {
    if (c.req.method === "POST") {
      const refused = await limited(c, ["auth"]);
      if (refused) return refused;
    }
    await next();
  });
  // Client registration and token requests write rows; they get the flood guard.
  app.use("/oauth/*", async (c, next) => {
    if (c.req.method === "POST") {
      const refused = await limited(c, ["public"]);
      if (refused) return refused;
    }
    await next();
  });
  app.route(
    "/auth",
    authRoutes({
      db: deps.db,
      mailOut: deps.mailOut,
      businessName: deps.businessName,
      now: deps.now,
      baseUrl: deps.baseUrl,
      ownerEmails: deps.ownerEmails,
      rememberOrigin: (origin) => deps.caps.rememberInboxAddress(origin),
    }),
  );
  app.route(
    "/oauth",
    oauthRoutes({
      db: deps.db,
      fetchMetadata: deps.fetchClientMetadata ?? ((url) => safeFetchJson<ClientMetadata>(url)),
      now: deps.now,
      baseUrl: deps.baseUrl,
    }),
  );
  app.get("/.well-known/oauth-protected-resource/mcp/owner", (c) =>
    c.json(protectedResourceMetadata(publicOrigin(c.req.raw, deps.baseUrl)), 200, {
      "Cache-Control": "public, max-age=3600",
    }),
  );
  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json(authorizationServerMetadata(publicOrigin(c.req.raw, deps.baseUrl)), 200, {
      "Cache-Control": "public, max-age=3600",
    }),
  );
  // Raw-MIME inbound webhook (Mailgun routes, custom forwarders, the hosted Email Worker).
  app.post("/v1/email/inbound", async (c) => {
    const secret = deps.inboundEmailSecret ? await deps.inboundEmailSecret() : null;
    if (!secret || c.req.header("x-inbox-email-secret") !== secret) {
      return unauthorized(c, "Send the inbound email secret from Settings in X-Inbox-Email-Secret.");
    }
    const raw = await c.req.arrayBuffer();
    if (raw.byteLength === 0 || raw.byteLength > 25 * 1024 * 1024) {
      return c.json({ error: "invalid_input", detail: "raw MIME between 1 byte and 25 MiB" }, 422);
    }
    const result = await ingestEmail(
      deps.db,
      deps.caps,
      { raw, envelopeTo: c.req.header("x-envelope-to"), envelopeFrom: c.req.header("x-envelope-from") },
      { now: deps.now },
    );
    // Too many from this sender, or for the whole mailbox: a 429 the gateway answers the sending
    // server with as a temporary failure, so a real sender's mail arrives once the bucket refills.
    if (result.outcome === "limited") {
      return c.json(result, 429, { "Retry-After": String(Math.max(1, Math.ceil(result.retryAfterSec))) });
    }
    return c.json(result, result.outcome === "rejected" ? 422 : 200);
  });
  app.route("/v1/owner", ownerRest(deps.caps));
  app.route("/v1", publicRest(deps.caps));
  // The page a link in the business's email opens (ADR-018 §5): a GET shows, a POST acts. Anyone
  // holding the link can open it, so every request takes a token, and a POST one from its own class.
  app.use("/c/*", async (c, next) => {
    const refused = await limited(c, c.req.method === "POST" ? ["public", "link"] : ["public"]);
    if (refused) return tooManyPage(c, deps);
    await next();
  });
  app.route("/c", customerPage({ caps: deps.caps, now: deps.now }));

  app.get(
    "/openapi.json",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: deps.title ?? "Surfing Dog Inbox",
          version: deps.version,
          description:
            "Typed inbox for people and AI agents. Public routes need no auth; /v1/owner needs an owner API key.",
        },
        components: {
          securitySchemes: {
            ownerKey: {
              type: "http",
              scheme: "bearer",
              description:
                "An owner or integration key (sdi_own_…), an OAuth access token from /oauth, or the owner app's session.",
            },
          },
        },
      },
    }),
  );

  const mcpPublic = createPublicMcpHandler(deps);
  const mcpOwner = createOwnerMcpHandler(deps);
  const authInfo = (caller: { actor: { id: string } }) => ({
    token: "",
    clientId: caller.actor.id,
    scopes: [],
    extra: { caller },
  });

  app.all("/mcp/owner", async (c) => {
    const caller = await callerFromRequest(deps.db, c.req.raw, { channel: "mcp_owner", sandbox: await sandbox() });
    if (caller.auth?.kind !== "owner") {
      return unauthorized(
        c,
        "Connect with OAuth or send an owner API key.",
        `${publicOrigin(c.req.raw, deps.baseUrl)}/.well-known/oauth-protected-resource/mcp/owner`,
      );
    }
    if (caller.principal?.keyKind === "integration") {
      const refused = await limited(c, ["integration"], caller.principal.id);
      if (refused) return refused;
    }
    const body = await readMcpBody(c.req.raw);
    if (!body) return unreadableBody();
    // A batch is as many calls as it holds: the rest of them pay too (mcpCosts).
    const extra = caller.principal?.keyKind === "integration" ? (mcpCosts(body.parsed).public ?? 0) : 0;
    if (extra > 0) {
      const refused = await limited(c, ["integration"], caller.principal?.id, { integration: extra });
      if (refused) return refused;
    }
    return serveMcp(mcpOwner, c.req.raw, body, authInfo(caller));
  });
  app.all("/mcp", async (c) => {
    const caller = await callerFromRequest(deps.db, c.req.raw, { channel: "mcp_public", sandbox: await sandbox() });
    if (caller.principal?.keyKind === "integration") {
      const refused = await limited(c, ["integration"], caller.principal.id);
      if (refused) return refused;
    }
    // Every tool call is a POST, and a signed request of any method takes a token before any
    // signature work (ADR-017 §2.4), as on REST. The flood guard comes before the body is read or
    // parsed, so a refused caller costs no parsing; which tools it calls, and so which class of
    // token they also take, can only be known after.
    const counted =
      caller.auth?.kind !== "owner" && (c.req.method === "POST" || c.req.header("signature-input") !== undefined);
    if (counted) {
      const refused = await limited(c, ["public"], caller.auth?.id);
      if (refused) return refused;
    }
    // The body, read once for everything below (readMcpBody), within the size every route reads.
    const body = await readMcpBody(c.req.raw);
    if (!body) return unreadableBody();
    // The ones that create an item take a create token too; codes and counters, their own: one
    // for each such call, so a batch pays for everything in it (mcpCosts).
    const costs = mcpCosts(body.parsed);
    if (caller.principal?.keyKind === "integration" && costs.public) {
      const refused = await limited(c, ["integration"], caller.principal.id, { integration: costs.public });
      if (refused) return refused;
    }
    if (counted) {
      const classes = (["public", "create", "verify", "negotiate"] as const).filter((cls) => costs[cls]);
      const refused = classes.length ? await limited(c, classes, caller.auth?.id, costs) : null;
      if (refused) return refused;
    }
    if (caller.auth?.kind === "owner") return serveMcp(mcpPublic, c.req.raw, body, authInfo(caller));
    // An agent may sign its MCP calls too (ADR-017 §2.4): the POST's body is covered by its digest.
    const seen = await agentFromRequest(deps.db, c.req.raw, {
      baseUrl: deps.baseUrl,
      fetchImpl: deps.fetchImpl,
      now: clock(),
      retryAs: retryIdentity(caller, c.req.raw),
      body: body.bytes ?? undefined,
    });
    if (await isCopy(seen, c.req.raw, body.text)) return replayedSignature(c);
    // A platform's key has a bucket of its own, recognised by a network or not; a self-held key never.
    if (seen.agent.platform) {
      const refused = await limited(c, ["platform"], `platform:${seen.agent.platform}`);
      if (refused) return refused;
    }
    const res = await serveMcp(mcpPublic, c.req.raw, body, authInfo(withAgent(caller, seen)));
    if (!seen.header) return res;
    const out = new Response(res.body, res);
    out.headers.set("Sdi-Signature", seen.header);
    return out;
  });
}
