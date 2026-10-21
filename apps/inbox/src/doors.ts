/**
 * The paths the server answers itself, before the owner app: every door (REST, MCP, OAuth, the
 * customer's pages) and the documents agents read. On Node anything else that is not a file gets the
 * app shell. Same list as vite.config.ts, which proxies these to the server in development. A host
 * that puts the inbox behind rules of its own checks them against this list, so a door added here is
 * one it has to decide about.
 */
export const DOOR_PREFIXES = [
  "/v1",
  "/mcp",
  "/auth",
  "/oauth",
  "/openapi.json",
  "/healthz",
  "/.well-known",
  "/c",
  "/p",
  "/demo",
  // The phone app (ADR-028): the page a QR code or a sign-in link opens, and an item's own address.
  "/phone",
  "/i",
] as const;

/** Whether the server answers `path` itself rather than the owner app. */
export const isDoor = (path: string): boolean =>
  DOOR_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
