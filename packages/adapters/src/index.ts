import type { Capabilities, Db } from "@surfingdog/core";
import type { Hono } from "hono";
import { openAPIRouteHandler } from "hono-openapi";
import { callerFromRequest } from "./auth";
import { createOwnerMcpHandler, createPublicMcpHandler } from "./mcp";
import { unauthorized } from "./problem";
import { type CallerEnv, ownerRest, publicRest } from "./rest";

export * from "./auth";
export * from "./mcp";
export * from "./problem";
export * from "./rest";

export interface DoorDeps {
  readonly db: Db;
  readonly caps: Capabilities;
  readonly version: string;
  readonly title?: string;
  /** Whether the instance is in test mode right now (every item becomes sandbox). */
  readonly sandbox?: () => Promise<boolean>;
}

/** Mounts every door on the app: REST at /v1, the OpenAPI document, and MCP at /mcp and /mcp/owner. */
export function mountDoors(app: Hono<CallerEnv>, deps: DoorDeps): void {
  const sandbox = deps.sandbox ?? (async () => false);

  app.use("/v1/*", async (c, next) => {
    c.set("caller", await callerFromRequest(deps.db, c.req.raw, { channel: "rest", sandbox: await sandbox() }));
    await next();
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
    if (caller.auth?.kind !== "owner") return unauthorized(c);
    return mcpOwner.fetch(c.req.raw, { authInfo: authInfo(caller) });
  });
  app.all("/mcp", async (c) => {
    const caller = await callerFromRequest(deps.db, c.req.raw, { channel: "mcp_public", sandbox: await sandbox() });
    return mcpPublic.fetch(c.req.raw, { authInfo: authInfo(caller) });
  });
}
