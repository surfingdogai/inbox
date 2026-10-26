/**
 * What an inbox that is closed to agents answers at all: its owner's app and sign-in, and nothing
 * an agent or a customer could use. The list names what is allowed, so a door the inbox gains later
 * is refused here until someone decides otherwise (a test holds it against the inbox's own list of
 * doors).
 *
 * - Files of the owner app: `/assets/*`, `/favicon.svg`.
 * - The owner app's pages: `/login`, `/setup`, `/settings` and the pages under it, `/items/*`, and
 *   `/services`, `/availability`, `/rules`, `/networks`, `/integrations`, `/keys`.
 * - Sign-in: `/auth/*`.
 * - The owner's own API, `/v1/owner/*`, with a session cookie and no `Authorization` header: no key,
 *   no AI app's token, only the owner in the browser; or with one of the owner's phones' tokens
 *   (`sdi_pa_`, ADR-028), which the inbox holds to reading and answering items.
 * - The owner's phone (ADR-028): its own API, `/v1/phone` and below (pairing with a code from
 *   Settings → Phone, the emailed sign-in link, refreshing its token: each needs a secret the owner
 *   holds or the phone's own key), with no `Authorization` header or a phone's token only; the page a
 *   QR code opens, `GET /phone`, which names nobody; and an item's link, `GET /i/<id>`, which only
 *   leads to the owner app's own page for it.
 * - Coming back from signing in to a calendar (`GET /oauth/connect/<kind>/callback`), with a session
 *   cookie: the owner's own browser, sent back by the platform.
 * - `GET /`: the app for someone with a session cookie, else a neutral page that names nobody.
 *
 * Everything else is refused: the manifest and every other `/.well-known` document, the rest of
 * `/v1` (inbound email included), `/mcp` and `/mcp/owner`, `/oauth/*`, `/openapi.json`, the
 * customer's pages (`/c/*`, `/p/*`), `/demo/*` and `/healthz`. A platform's webhook
 * (`/v1/hooks/*`) and a calendar link to share (`GET /v1/feeds/<kind>/*`) are among them: they reach
 * the inbox only once it is live at its own name, and the inbox makes no link before then
 * (`hooksLive`), so none is ever handed out at a setup address.
 */

export const OWNER_FILES = ["/favicon.svg"] as const;
export const OWNER_FILE_PREFIXES = ["/assets/"] as const;
export const OWNER_PAGES = [
  "/login",
  "/setup",
  "/settings",
  "/services",
  "/availability",
  "/rules",
  "/networks",
  "/integrations",
  "/keys",
] as const;
/** Pages with something after them: an item, a section of the settings. */
export const OWNER_PAGE_PREFIXES = ["/items/", "/settings/"] as const;
export const OWNER_AUTH_PREFIX = "/auth/";
export const OWNER_API_PREFIX = "/v1/owner/";
/** The owner's phone's own API, its landing page and an item's link (ADR-028). */
export const PHONE_API = "/v1/phone";
export const PHONE_PAGE = "/phone";
export const ITEM_LINK_PREFIX = "/i/";
/** A phone's access token: the only bearer the owner's doors take here. */
const PHONE_TOKEN = /^Bearer\s+sdi_pa_[A-Za-z0-9_-]+$/;
/** Where a platform sends the owner back after they signed in to connect it (ADR-022). */
export const OWNER_CONNECT_RETURN = /^\/oauth\/connect\/[a-z][a-z0-9_]{0,39}\/callback$/;

/** The session cookie's names (the `__Host-` one over https, the plain one over http). */
const SESSION = /(?:^|;\s*)(?:__Host-)?sdi_session=[^;\s]/;

export function hasSessionCookie(cookie: string | null | undefined): boolean {
  return typeof cookie === "string" && SESSION.test(cookie);
}

export interface OwnerRequest {
  readonly method: string;
  readonly path: string;
  readonly cookie?: string | null | undefined;
  readonly authorization?: string | null | undefined;
}

/**
 * - `allow`: pass it to the inbox.
 * - `neutral`: `GET /` from someone without a session: the neutral page, not the inbox.
 * - `refuse`: 404.
 */
export type OwnerVerdict = "allow" | "neutral" | "refuse";

const reads = (method: string) => method === "GET" || method === "HEAD";

/** Whether a page of the owner app (not its API, not sign-in) is at `path`. */
export function isOwnerPage(path: string): boolean {
  return (
    (OWNER_PAGES as readonly string[]).includes(path) ||
    (OWNER_FILES as readonly string[]).includes(path) ||
    OWNER_FILE_PREFIXES.some((p) => path.startsWith(p) && path.length > p.length) ||
    OWNER_PAGE_PREFIXES.some((p) => path.startsWith(p) && path.length > p.length)
  );
}

export function ownerVerdict(r: OwnerRequest): OwnerVerdict {
  const method = r.method.toUpperCase();
  const path = r.path;
  if (path === "/") {
    if (!reads(method)) return "refuse";
    return hasSessionCookie(r.cookie) ? "allow" : "neutral";
  }
  if (isOwnerPage(path)) return reads(method) ? "allow" : "refuse";
  if (path.startsWith(OWNER_AUTH_PREFIX)) return "allow";
  if (OWNER_CONNECT_RETURN.test(path)) return reads(method) && hasSessionCookie(r.cookie) ? "allow" : "refuse";
  const auth = typeof r.authorization === "string" ? r.authorization.trim() : "";
  if (path.startsWith(OWNER_API_PREFIX)) {
    if (PHONE_TOKEN.test(auth)) return "allow";
    return hasSessionCookie(r.cookie) && auth === "" ? "allow" : "refuse";
  }
  if (path === PHONE_API || path.startsWith(`${PHONE_API}/`))
    return auth === "" || PHONE_TOKEN.test(auth) ? "allow" : "refuse";
  if (path === PHONE_PAGE || (path.startsWith(ITEM_LINK_PREFIX) && path.length > ITEM_LINK_PREFIX.length))
    return reads(method) ? "allow" : "refuse";
  return "refuse";
}

/**
 * What a read-only inbox (closing) still takes besides reads: signing in, the step-up code, and the
 * owner's download of everything in it.
 */
export function readOnlyAllows(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return true;
  return m === "POST" && (path.startsWith(OWNER_AUTH_PREFIX) || path === `${OWNER_API_PREFIX}download`);
}
