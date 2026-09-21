import type { Capabilities, Db } from "@surfingdog/core";
import type { MailOut } from "@surfingdog/platform";
import type { Hono } from "hono";
import { openAPIRouteHandler } from "hono-openapi";
import { callerFromRequest } from "./auth";
import { ingestEmail } from "./email";
import { createOwnerMcpHandler, createPublicMcpHandler } from "./mcp";
import { authorizationServerMetadata, type ClientMetadata, oauthRoutes, protectedResourceMetadata } from "./oauth";
import { forbidden, unauthorized } from "./problem";
import { type CallerEnv, ownerRest, publicRest } from "./rest";
import { safeFetchJson } from "./safe-fetch";
import { authRoutes } from "./session";

export * from "./auth";
export * from "./email";
export * from "./mcp";
export * from "./oauth";
export * from "./problem";
export * from "./rest";
export * from "./safe-fetch";
export * from "./session";

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
}

/** Cookie sessions only write from our own origin; keys and OAuth tokens carry no ambient authority. */
function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return true;
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

/** Mounts every door on the app: REST at /v1, the OpenAPI document, and MCP at /mcp and /mcp/owner. */
export function mountDoors(app: Hono<CallerEnv>, deps: DoorDeps): void {
  const sandbox = deps.sandbox ?? (async () => false);

  app.use("/v1/*", async (c, next) => {
    const caller = await callerFromRequest(deps.db, c.req.raw, { channel: "rest", sandbox: await sandbox() });
    if (
      caller.auth?.via === "session" &&
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      !sameOrigin(c.req.raw)
    ) {
      return forbidden(c, "Cross-site writes with a session cookie are refused; call from the app or use an API key.");
    }
    c.set("caller", caller);
    await next();
  });
  app.route(
    "/auth",
    authRoutes({ db: deps.db, mailOut: deps.mailOut, businessName: deps.businessName, now: deps.now }),
  );
  app.route(
    "/oauth",
    oauthRoutes({
      db: deps.db,
      fetchMetadata: deps.fetchClientMetadata ?? ((url) => safeFetchJson<ClientMetadata>(url)),
      now: deps.now,
    }),
  );
  app.get("/.well-known/oauth-protected-resource/mcp/owner", (c) =>
    c.json(protectedResourceMetadata(new URL(c.req.url).origin), 200, { "Cache-Control": "public, max-age=3600" }),
  );
  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json(authorizationServerMetadata(new URL(c.req.url).origin), 200, { "Cache-Control": "public, max-age=3600" }),
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
        `${new URL(c.req.url).origin}/.well-known/oauth-protected-resource/mcp/owner`,
      );
    }
    return mcpOwner.fetch(c.req.raw, { authInfo: authInfo(caller) });
  });
  app.all("/mcp", async (c) => {
    const caller = await callerFromRequest(deps.db, c.req.raw, { channel: "mcp_public", sandbox: await sandbox() });
    return mcpPublic.fetch(c.req.raw, { authInfo: authInfo(caller) });
  });
}
