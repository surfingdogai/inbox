import type { Capabilities, Db } from "@surfingdog/core";
import type { MailOut } from "@surfingdog/platform";
import type { Context, Hono } from "hono";
import { openAPIRouteHandler } from "hono-openapi";
import { callerFromRequest } from "./auth";
import { ingestEmail } from "./email";
import { clientAddress, consume, isCreateRoute, type LimitClass, mcpCreates } from "./limits";
import { createOwnerMcpHandler, createPublicMcpHandler } from "./mcp";
import { authorizationServerMetadata, type ClientMetadata, oauthRoutes, protectedResourceMetadata } from "./oauth";
import { publicOrigin } from "./origin";
import { forbidden, tooManyRequests, unauthorized } from "./problem";
import { type CallerEnv, ownerRest, publicRest } from "./rest";
import { safeFetchJson } from "./safe-fetch";
import { authRoutes } from "./session";

export * from "./auth";
export * from "./email";
export * from "./feeds/index";
export * from "./limits";
export * from "./mcp";
export * from "./network";
export * from "./oauth";
export * from "./origin";
export * from "./problem";
export * from "./rest";
export * from "./safe-fetch";
export * from "./session";
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
}

/** Cookie sessions only write from our own origin; keys and OAuth tokens carry no ambient authority. */
function sameOrigin(request: Request, baseUrl: string | undefined): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return true;
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  return origin === publicOrigin(request, baseUrl) || origin === new URL(request.url).origin;
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
  ): Promise<Response | null> => {
    const who = keyId ? `key:${keyId}` : `ip:${clientAddress(c.req.raw)}`;
    for (const cls of classes) {
      const v = await consume(deps.db, cls, who, clock());
      if (!v.allowed) {
        return tooManyRequests(c, "Too many requests right now; wait a few minutes and try again.", v.retryAfterSec);
      }
    }
    return null;
  };

  app.use("/v1/*", async (c, next) => {
    const caller = await callerFromRequest(deps.db, c.req.raw, { channel: "rest", sandbox: await sandbox() });
    if (
      caller.auth?.via === "session" &&
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      !sameOrigin(c.req.raw, deps.baseUrl)
    ) {
      return forbidden(c, "Cross-site writes with a session cookie are refused; call from the app or use an API key.");
    }
    // Writes from anyone but the verified owner are limited. The inbound mail webhook is not: it is
    // authenticated by its own secret, and every message arrives from the one gateway address.
    if (
      caller.auth?.kind !== "owner" &&
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      c.req.path !== "/v1/email/inbound"
    ) {
      const refused = await limited(
        c,
        isCreateRoute(c.req.method, c.req.path) ? ["public", "create"] : ["public"],
        caller.auth?.id,
      );
      if (refused) return refused;
    }
    c.set("caller", caller);
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
    return c.json(result, result.outcome === "rejected" ? 422 : 200);
  });
  app.route("/v1/owner", ownerRest(deps.caps));
  app.route("/v1", publicRest(deps.caps));

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
          securitySchemes: { ownerKey: { type: "http", scheme: "bearer", description: "Owner API key (sdi_own_…)" } },
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
    return mcpOwner.fetch(c.req.raw, { authInfo: authInfo(caller) });
  });
  app.all("/mcp", async (c) => {
    const caller = await callerFromRequest(deps.db, c.req.raw, { channel: "mcp_public", sandbox: await sandbox() });
    // Every tool call is a POST; the ones that create an item also take a create token.
    if (caller.auth?.kind !== "owner" && c.req.method === "POST") {
      const refused = await limited(
        c,
        (await mcpCreates(c.req.raw)) ? ["public", "create"] : ["public"],
        caller.auth?.id,
      );
      if (refused) return refused;
    }
    return mcpPublic.fetch(c.req.raw, { authInfo: authInfo(caller) });
  });
}
