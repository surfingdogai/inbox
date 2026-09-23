import type { Context } from "hono";
import { matchedRoutes } from "hono/route";

/**
 * Which scopes let a caller through each owner operation (ADR-004): any one of the list will do.
 * One static map for the REST door and one for the owner MCP, checked through the one function,
 * `caps.access.requireScope`. A route or a tool that is missing here is a test failure, not a gap: the
 * tests walk every owner route and every owner tool and look each one up.
 *
 * Reading follows writing: a key that may change the catalogue may also read it, so the read
 * routes list the write scope beside `settings:read`.
 */
const READ_SETUP = "settings:read";

export const ROUTE_SCOPES: Readonly<Record<string, readonly string[]>> = {
  "GET /items": ["inbox:read"],
  "GET /items/:id": ["inbox:read"],
  "POST /items/:id/transitions": ["inbox:write"],
  "POST /items/:id/replies": ["inbox:write"],
  "GET /settings": [READ_SETUP],
  "PUT /settings": ["settings:write"],
  "GET /receipts": [READ_SETUP],
  "GET /networks": [READ_SETUP],
  "GET /profile": [READ_SETUP],
  "PUT /profile": ["settings:write"],
  "GET /services": [READ_SETUP, "catalogue:write"],
  "POST /services": ["catalogue:write"],
  "PATCH /services/:id": ["catalogue:write"],
  "DELETE /services/:id": ["catalogue:write"],
  "GET /products": [READ_SETUP, "catalogue:write"],
  "POST /products": ["catalogue:write"],
  "PATCH /products/:id": ["catalogue:write"],
  "DELETE /products/:id": ["catalogue:write"],
  "GET /availability": [READ_SETUP, "availability:write"],
  "PUT /availability": ["availability:write"],
  "DELETE /availability/:serviceId": ["availability:write"],
  "PUT /availability/closures": ["availability:write"],
  "GET /rules": [READ_SETUP, "setup:run"],
  "GET /rules/presets": [READ_SETUP, "setup:run"],
  "POST /rules/presets/:key": ["setup:run"],
  "POST /rules/test": [READ_SETUP, "setup:run"],
  "POST /rules": ["setup:run"],
  "PATCH /rules/:id": ["setup:run"],
  "DELETE /rules/:id": ["setup:run"],
  "GET /webhooks": [READ_SETUP, "integrations:write"],
  "POST /webhooks": ["integrations:write"],
  "PATCH /webhooks/:id": ["integrations:write"],
  "DELETE /webhooks/:id": ["integrations:write"],
  "POST /webhooks/:id/rotate-secret": ["integrations:write"],
  "POST /webhooks/:id/test": ["integrations:write"],
  "POST /webhooks/:id/replay": ["integrations:write"],
  "GET /webhooks/:id/deliveries": [READ_SETUP, "integrations:write"],
  "GET /deliveries": [READ_SETUP, "integrations:write"],
  "POST /deliveries/:id/replay": ["integrations:write"],
  "GET /feeds": [READ_SETUP, "integrations:write"],
  "POST /feeds": ["integrations:write"],
  "GET /feeds/:id": [READ_SETUP, "integrations:write"],
  "POST /feeds/:id/import": ["integrations:write"],
  "DELETE /feeds/:id": ["integrations:write"],
  "GET /events": ["events:read", "inbox:read"],
  "GET /api-keys": [READ_SETUP, "keys:write"],
  "POST /api-keys": ["keys:write"],
  "DELETE /api-keys/:id": ["keys:write"],
};

export const TOOL_SCOPES: Readonly<Record<string, readonly string[]>> = {
  list_items: ["inbox:read"],
  get_item: ["inbox:read"],
  transition_item: ["inbox:write"],
  reply: ["inbox:write"],
  get_profile: [READ_SETUP],
  update_profile: ["settings:write"],
  list_services: [READ_SETUP, "catalogue:write"],
  upsert_service: ["catalogue:write"],
  archive_service: ["catalogue:write"],
  list_products: [READ_SETUP, "catalogue:write"],
  upsert_product: ["catalogue:write"],
  archive_product: ["catalogue:write"],
  get_availability: [READ_SETUP, "availability:write"],
  set_opening_hours: ["availability:write"],
  clear_service_hours: ["availability:write"],
  set_closures: ["availability:write"],
  list_rules: [READ_SETUP, "setup:run"],
  list_rule_presets: [READ_SETUP, "setup:run"],
  apply_rule_preset: ["setup:run"],
  upsert_rule: ["setup:run"],
  delete_rule: ["setup:run"],
  test_rule: [READ_SETUP, "setup:run"],
  list_webhooks: [READ_SETUP, "integrations:write"],
  create_webhook: ["integrations:write"],
  update_webhook: ["integrations:write"],
  rotate_webhook_secret: ["integrations:write"],
  delete_webhook: ["integrations:write"],
  send_test_event: ["integrations:write"],
  list_webhook_deliveries: [READ_SETUP, "integrations:write"],
  replay_webhook_delivery: ["integrations:write"],
  replay_missing_webhook_deliveries: ["integrations:write"],
  list_events: ["events:read", "inbox:read"],
  list_feeds: [READ_SETUP, "integrations:write"],
  add_feed: ["integrations:write"],
  import_feed_now: ["integrations:write"],
  remove_feed: ["integrations:write"],
  get_settings: [READ_SETUP],
  get_networks: [READ_SETUP],
  update_settings: ["settings:write"],
  list_api_keys: [READ_SETUP, "keys:write"],
  create_api_key: ["keys:write"],
  revoke_api_key: ["keys:write"],
};

/** Where the owner REST door is mounted; the map above is keyed on paths below it. */
export const OWNER_BASE = "/v1/owner";

/**
 * The owner operation a request matched, as `METHOD /path` below `/v1/owner` — the key of
 * `ROUTE_SCOPES` — or null when it matched no owner route (a 404 is not an operation). Taken from
 * the router's own match, so it is the route pattern (`/items/:id`), never the concrete path.
 * Middleware (`ALL`) and catch-alls (a path with `*`, such as the Node host's static files, which
 * it registers after the doors) are not operations and are passed over.
 */
export function ownerOperation(c: Context): string | null {
  const routes = matchedRoutes(c);
  for (let i = routes.length - 1; i >= 0; i--) {
    const r = routes[i];
    if (!r || r.method === "ALL" || r.path.includes("*")) continue;
    const path = r.path.startsWith(OWNER_BASE) ? r.path.slice(OWNER_BASE.length) || "/" : r.path;
    return `${r.method} ${path}`;
  }
  return null;
}

/** The scopes for an operation; an owner route missing from the map needs the owner (`*`). */
export function routeScopes(operation: string): readonly string[] {
  return ROUTE_SCOPES[operation] ?? ["*"];
}
