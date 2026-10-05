import {
  type Db,
  NOT_FOR_AI_SCOPES,
  randomToken,
  readSettings,
  SCOPE_NAMES,
  SCOPES,
  schema,
  ulid,
} from "@surfingdog/core";
import { type MailOut, sha256Hex } from "@surfingdog/platform";
import { and, eq, gt, isNull } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { hashKey } from "./auth";
import { publicOrigin, sameOrigin } from "./origin";
import type { CallerEnv } from "./rest";
import { userFromCookie } from "./session";

/**
 * A minimal OAuth 2.1 authorization server, so the owner's own AI (Claude, ChatGPT, …) can connect
 * to the owner MCP with a login instead of a pasted key (ADR-004). Authorization code + PKCE S256
 * only, public clients, opaque hashed tokens, rotating refresh tokens, Client ID Metadata
 * Documents first with dynamic registration as the fallback.
 */
/**
 * Every owner scope (core's `SCOPES`) an AI app may be granted; a client may ask for any of them, and
 * the owner sees each on the consent page. Erasing a customer is not among them: it is never the AI's.
 */
export const OWNER_SCOPES: readonly string[] = SCOPE_NAMES.filter(
  (s) => !(NOT_FOR_AI_SCOPES as readonly string[]).includes(s),
);
export const ACCESS_TTL_MS = 3_600_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;
export const CODE_TTL_MS = 10 * 60_000;
/** A self-registered app nobody has signed in with is forgotten after this long. */
export const UNUSED_CLIENT_TTL_MS = 7 * 86_400_000;
export const ACCESS_PREFIX = "sdi_at_";
export const REFRESH_PREFIX = "sdi_rt_";

export interface OAuthDeps {
  readonly baseUrl?: string | undefined;
  readonly db: Db;
  /** Tells the owner by email each time they let an app in, so one they didn't mean to is noticed. */
  readonly mailOut?: MailOut | undefined;
  readonly businessName?: (() => Promise<string>) | undefined;
  /** Resolves a Client ID Metadata Document; must refuse private hosts. */
  readonly fetchMetadata?: ((url: string) => Promise<ClientMetadata | null>) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface ClientMetadata {
  readonly client_id?: string;
  readonly client_name?: string;
  readonly redirect_uris: string[];
  readonly client_uri?: string;
  readonly logo_uri?: string;
}

export interface OAuthGrant {
  readonly userId: string;
  readonly clientId: string;
  readonly scopes: string[];
  /** The AI app's name as it registered, for the history. Only on a resolved access token. */
  readonly clientName?: string | null;
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp/owner`,
    authorization_servers: [origin],
    scopes_supported: [...OWNER_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Surfing Dog Inbox owner MCP",
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    scopes_supported: [...OWNER_SCOPES],
  };
}

/** Bearer resolution for opaque access tokens; null when unknown, expired or revoked. */
export async function resolveAccessToken(db: Db, token: string, now = Date.now()): Promise<OAuthGrant | null> {
  if (!token.startsWith(ACCESS_PREFIX)) return null;
  const [row] = await db.orm
    .select()
    .from(schema.oauthTokens)
    .where(
      and(
        eq(schema.oauthTokens.tokenHash, await hashKey(token)),
        eq(schema.oauthTokens.kind, "access"),
        isNull(schema.oauthTokens.revokedAt),
        gt(schema.oauthTokens.expiresAt, now),
      ),
    );
  if (!row) return null;
  const [client] = await db.orm
    .select({ name: schema.oauthClients.name })
    .from(schema.oauthClients)
    .where(eq(schema.oauthClients.id, row.clientId));
  return {
    userId: row.userId,
    clientId: row.clientId,
    scopes: row.scope.split(" ").filter(Boolean),
    clientName: client?.name ?? null,
  };
}

export function oauthRoutes(deps: OAuthDeps): Hono<CallerEnv> {
  const app = new Hono<CallerEnv>();
  const now = deps.now ?? (() => Date.now());
  const err = (c: Context, status: 400 | 401 | 403, error: string, description: string) =>
    c.json({ error, error_description: description }, status, { "Cache-Control": "no-store" });

  // RFC 7591 dynamic registration: public clients, https redirect URIs (loopback allowed for CLIs).
  app.post("/register", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | (Partial<ClientMetadata> & { token_endpoint_auth_method?: string })
      | null;
    const uris = Array.isArray(body?.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string" && validRedirect(u))
      : [];
    if (!body || uris.length === 0 || uris.length > 5)
      return err(
        c,
        400,
        "invalid_redirect_uri",
        "Send 1 to 5 https redirect_uris (http://127.0.0.1 or http://localhost allowed).",
      );
    // Registration is open by design (assistants register themselves), so registrations nobody ever
    // signed in with are cleared after a week rather than kept for ever.
    await deps.db.client.query({
      sql: `DELETE FROM oauth_clients WHERE kind = 'dcr' AND created_at < ?
        AND id NOT IN (SELECT client_id FROM oauth_codes) AND id NOT IN (SELECT client_id FROM oauth_tokens)`,
      params: [now() - UNUSED_CLIENT_TTL_MS],
      method: "run",
    });
    const id = ulid();
    await deps.db.orm.insert(schema.oauthClients).values({
      id,
      name: typeof body.client_name === "string" ? body.client_name.slice(0, 100) : null,
      redirectUris: uris,
      clientUri: typeof body.client_uri === "string" ? body.client_uri : null,
      logoUri: typeof body.logo_uri === "string" ? body.logo_uri : null,
      kind: "dcr",
      metadata: body,
      createdAt: now(),
    });
    return c.json(
      {
        client_id: id,
        client_name: body.client_name ?? null,
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
      { "Cache-Control": "no-store" },
    );
  });

  // Authorization: needs an owner session; renders a consent page, or records the decision.
  app.get("/authorize", async (c) => {
    const q = c.req.query();
    const check = await validateAuthorize(deps, q, now());
    if (!check.ok) return err(c, 400, check.error, check.description);
    const user = await userFromCookie(deps.db, c.req.raw, now());
    if (!user) {
      const back = `/oauth/authorize?${new URLSearchParams(q).toString()}`;
      return c.redirect(`/login?redirect=${encodeURIComponent(back)}`);
    }
    return c.html(consentPage(check.client, check.scopes, q, check.redirectUri));
  });

  app.post("/authorize/decision", async (c) => {
    // Only our own consent page may answer it: another site can't post an Allow for a signed-in owner.
    if (!sameOrigin(c.req.raw, deps.baseUrl)) return err(c, 403, "access_denied", "Answer from the consent page.");
    const form = await c.req.parseBody();
    const q = Object.fromEntries(Object.entries(form).filter(([, v]) => typeof v === "string")) as Record<
      string,
      string
    >;
    const check = await validateAuthorize(deps, q, now());
    if (!check.ok) return err(c, 400, check.error, check.description);
    const user = await userFromCookie(deps.db, c.req.raw, now());
    if (!user) return err(c, 401, "login_required", "Sign in first.");
    const redirect = new URL(check.redirectUri);
    if (q.decision !== "allow") {
      redirect.searchParams.set("error", "access_denied");
      if (q.state) redirect.searchParams.set("state", q.state);
      return c.redirect(redirect.toString());
    }
    const code = randomToken(32);
    await deps.db.orm.insert(schema.oauthCodes).values({
      codeHash: await hashKey(code),
      clientId: check.client.id,
      userId: user.id,
      redirectUri: check.redirectUri,
      scope: check.scopes.join(" "),
      codeChallenge: q.code_challenge ?? "",
      resource: q.resource ?? null,
      expiresAt: now() + CODE_TTL_MS,
      createdAt: now(),
    });
    redirect.searchParams.set("code", code);
    if (q.state) redirect.searchParams.set("state", q.state);
    const origin = publicOrigin(c.req.raw, deps.baseUrl);
    redirect.searchParams.set("iss", origin);
    await tellOwner(deps, user.email, check.client, check.redirectUri, origin, now());
    return c.redirect(redirect.toString());
  });

  app.post("/token", async (c) => {
    const ct = c.req.header("content-type") ?? "";
    const body = (
      ct.includes("application/json")
        ? await c.req.json().catch(() => ({}))
        : Object.fromEntries(new URLSearchParams(await c.req.text()))
    ) as Record<string, string>;
    if (body.grant_type === "authorization_code") {
      const [row] = await deps.db.orm
        .select()
        .from(schema.oauthCodes)
        .where(
          and(
            eq(schema.oauthCodes.codeHash, await hashKey(body.code ?? "")),
            isNull(schema.oauthCodes.usedAt),
            gt(schema.oauthCodes.expiresAt, now()),
          ),
        );
      if (!row) return err(c, 400, "invalid_grant", "Unknown, used or expired code.");
      if (row.clientId !== body.client_id) return err(c, 400, "invalid_grant", "client_id does not match the code.");
      if (row.redirectUri !== body.redirect_uri)
        return err(c, 400, "invalid_grant", "redirect_uri does not match the code.");
      if (!(await pkceMatches(body.code_verifier ?? "", row.codeChallenge)))
        return err(c, 400, "invalid_grant", "PKCE verification failed.");
      await deps.db.client.query({
        sql: "UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?",
        params: [now(), row.codeHash],
        method: "run",
      });
      return c.json(
        await issueTokens(
          deps,
          { userId: row.userId, clientId: row.clientId, scopes: row.scope.split(" ").filter(Boolean) },
          ulid(),
          row.resource,
          now(),
        ),
        200,
        { "Cache-Control": "no-store" },
      );
    }
    if (body.grant_type === "refresh_token") {
      const [row] = await deps.db.orm
        .select()
        .from(schema.oauthTokens)
        .where(
          and(
            eq(schema.oauthTokens.tokenHash, await hashKey(body.refresh_token ?? "")),
            eq(schema.oauthTokens.kind, "refresh"),
          ),
        );
      if (!row || row.expiresAt <= now()) return err(c, 400, "invalid_grant", "Unknown or expired refresh token.");
      if (row.revokedAt) {
        // A rotated token used twice: someone else has it. Kill the whole family.
        await deps.db.client.query({
          sql: "UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
          params: [now(), row.familyId],
          method: "run",
        });
        return err(c, 400, "invalid_grant", "Refresh token reuse detected; sign in again.");
      }
      if (body.client_id && body.client_id !== row.clientId)
        return err(c, 400, "invalid_grant", "client_id does not match.");
      await deps.db.client.query({
        sql: "UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?",
        params: [now(), row.tokenHash],
        method: "run",
      });
      return c.json(
        await issueTokens(
          deps,
          { userId: row.userId, clientId: row.clientId, scopes: row.scope.split(" ").filter(Boolean) },
          row.familyId,
          row.resource,
          now(),
          row.tokenHash,
        ),
        200,
        { "Cache-Control": "no-store" },
      );
    }
    return err(c, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
  });

  app.post("/revoke", async (c) => {
    const body = Object.fromEntries(new URLSearchParams(await c.req.text()));
    const hash = await hashKey(body.token ?? "");
    const [row] = await deps.db.orm
      .select({ familyId: schema.oauthTokens.familyId })
      .from(schema.oauthTokens)
      .where(eq(schema.oauthTokens.tokenHash, hash));
    if (row)
      await deps.db.client.query({
        sql: "UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
        params: [now(), row.familyId],
        method: "run",
      });
    return c.body(null, 200);
  });

  return app;
}

async function validateAuthorize(
  deps: OAuthDeps,
  q: Record<string, string>,
  now: number,
): Promise<
  | {
      ok: true;
      client: OAuthClientView;
      redirectUri: string;
      scopes: string[];
    }
  | { ok: false; error: string; description: string }
> {
  if (q.response_type !== "code")
    return { ok: false, error: "unsupported_response_type", description: "Only response_type=code is supported." };
  if (!q.code_challenge || q.code_challenge_method !== "S256")
    return { ok: false, error: "invalid_request", description: "PKCE with code_challenge_method=S256 is required." };
  const client = await resolveClient(deps, q.client_id ?? "", now);
  if (!client)
    return {
      ok: false,
      error: "invalid_client",
      description: "Unknown client_id. Register first, or use a Client ID Metadata Document URL.",
    };
  const redirectUri = q.redirect_uri ?? client.redirectUris[0] ?? "";
  if (!client.redirectUris.includes(redirectUri))
    return { ok: false, error: "invalid_request", description: "redirect_uri is not registered for this client." };
  const requested = (q.scope ?? "").split(/\s+/).filter(Boolean);
  const scopes = requested.length
    ? requested.filter((s) => (OWNER_SCOPES as readonly string[]).includes(s))
    : ["inbox:read", "inbox:write", "settings:read", "offline_access"];
  if (scopes.length === 0)
    return { ok: false, error: "invalid_scope", description: `Scopes must be among ${OWNER_SCOPES.join(", ")}.` };
  return { ok: true, client, redirectUri, scopes };
}

/**
 * A client as the consent page shows it. `kind` says how much its name can be trusted: a "cimd"
 * client's details are published at its own URL, a "dcr" one chose its name when it registered.
 */
export interface OAuthClientView {
  readonly id: string;
  readonly name: string | null;
  readonly redirectUris: string[];
  readonly kind: string;
}

async function resolveClient(deps: OAuthDeps, clientId: string, now: number): Promise<OAuthClientView | null> {
  if (!clientId) return null;
  const [row] = await deps.db.orm.select().from(schema.oauthClients).where(eq(schema.oauthClients.id, clientId));
  if (row) return { id: row.id, name: row.name, redirectUris: row.redirectUris, kind: row.kind };
  if (/^https:\/\//.test(clientId) && deps.fetchMetadata) {
    const meta = await deps.fetchMetadata(clientId);
    if (!meta || (meta.client_id && meta.client_id !== clientId)) return null;
    const uris = meta.redirect_uris.filter(validRedirect);
    if (uris.length === 0) return null;
    await deps.db.orm.insert(schema.oauthClients).values({
      id: clientId,
      name: meta.client_name?.slice(0, 100) ?? null,
      redirectUris: uris,
      clientUri: meta.client_uri ?? null,
      logoUri: meta.logo_uri ?? null,
      kind: "cimd",
      metadata: meta,
      createdAt: now,
    });
    return { id: clientId, name: meta.client_name ?? null, redirectUris: uris, kind: "cimd" };
  }
  return null;
}

async function issueTokens(
  deps: OAuthDeps,
  grant: OAuthGrant,
  familyId: string,
  resource: string | null,
  now: number,
  rotatedFrom?: string,
) {
  const access = `${ACCESS_PREFIX}${randomToken(32)}`;
  const refresh = `${REFRESH_PREFIX}${randomToken(32)}`;
  const scope = grant.scopes.join(" ");
  await deps.db.orm.insert(schema.oauthTokens).values([
    {
      tokenHash: await hashKey(access),
      kind: "access",
      clientId: grant.clientId,
      userId: grant.userId,
      scope,
      resource,
      familyId,
      expiresAt: now + ACCESS_TTL_MS,
      createdAt: now,
    },
    {
      tokenHash: await hashKey(refresh),
      kind: "refresh",
      clientId: grant.clientId,
      userId: grant.userId,
      scope,
      resource,
      familyId,
      expiresAt: now + REFRESH_TTL_MS,
      rotatedFrom: rotatedFrom ?? null,
      createdAt: now,
    },
  ]);
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refresh,
    scope,
  };
}

export function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    return (
      u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (verifier.length < 43 || verifier.length > 128) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return b64 === challenge;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * Assistants people are likely to connect, and the hosts their sign-in comes back to. An app that
 * calls itself one of them but sends access elsewhere is the consent-phishing case: anyone can
 * register an app with any name, so the page says so, and says where access really goes.
 */
const KNOWN_APPS: readonly { name: string; pattern: RegExp; hosts: readonly string[] }[] = [
  { name: "Claude", pattern: /\bclaude\b|anthropic/i, hosts: ["claude.ai", "claude.com", "anthropic.com"] },
  { name: "ChatGPT", pattern: /chat\s*gpt|openai/i, hosts: ["chatgpt.com", "openai.com"] },
  { name: "Gemini", pattern: /gemini/i, hosts: ["google.com"] },
  { name: "Grok", pattern: /\bgrok\b|\bxai\b/i, hosts: ["x.ai", "grok.com", "x.com"] },
  { name: "Copilot", pattern: /copilot/i, hosts: ["microsoft.com", "microsoftonline.com", "azure-apim.net"] },
  { name: "Meta Muse", pattern: /\bmuse\b|meta ai/i, hosts: ["muse.ai", "meta.ai", "meta.com"] },
];

/**
 * An email to the owner each time they let an app in: what it is, where its access goes, and where to
 * take it back. A consent they were tricked into is then noticed the same day. Never blocks the
 * sign-in: when there is nobody to send as, or the send fails, the app is still connected.
 */
async function tellOwner(
  deps: OAuthDeps,
  to: string,
  client: OAuthClientView,
  redirectUri: string,
  origin: string,
  now: number,
): Promise<void> {
  if (!deps.mailOut || !to) return;
  try {
    const address = deps.mailOut.sender?.address ?? (await readSettings(deps.db)).email.fromAddress;
    if (!address) return;
    const business = (await deps.businessName?.()) ?? "";
    const dest = destinationOf(redirectUri);
    const app = client.name ? `"${client.name}"` : "An app";
    const when = new Date(now).toISOString().replace("T", " ").slice(0, 16);
    const trust =
      client.kind === "cimd"
        ? `Its details are published at ${(() => {
            try {
              return new URL(client.id).host;
            } catch {
              return client.id;
            }
          })()}.`
        : "Its name is the one it gave itself when it registered.";
    await deps.mailOut.send({
      from: { address, name: business || deps.mailOut.sender?.name || "Surfing Dog Inbox" },
      to: [to],
      subject: `An app was connected to ${business || "your inbox"}`,
      text: `${app} can now work your inbox. You allowed it at ${when} UTC.\n\nAccess goes to: ${dest.local ? "an app on your own computer" : dest.host}\n${trust}\n\nIf this wasn't you, disconnect it now in Settings → Keys:\n${origin}/settings/keys\n`,
    });
  } catch {
    // The owner sees every connected app in Settings → Keys whether or not this arrives.
  }
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** Where a sign-in goes back to, as a person reads it. */
export function destinationOf(redirectUri: string): { host: string; local: boolean } {
  try {
    const u = new URL(redirectUri);
    return { host: u.host, local: isLoopback(u.hostname) };
  } catch {
    return { host: redirectUri, local: false };
  }
}

/** The assistant an app's name claims to be, when its sign-in goes somewhere that assistant isn't. */
export function impersonates(name: string | null, redirectUri: string): string | null {
  if (!name) return null;
  const { host, local } = destinationOf(redirectUri);
  if (local) return null; // an app on the owner's own computer: nobody else receives the code
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  const claim = KNOWN_APPS.find((a) => a.pattern.test(name));
  if (!claim) return null;
  return claim.hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`)) ? null : claim.name;
}

function consentPage(
  client: OAuthClientView,
  scopes: string[],
  q: Record<string, string>,
  redirectUri: string,
): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
  const hidden = Object.entries(q)
    .filter(([k]) =>
      [
        "response_type",
        "client_id",
        "redirect_uri",
        "scope",
        "state",
        "code_challenge",
        "code_challenge_method",
        "resource",
      ].includes(k),
    )
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  const dest = destinationOf(redirectUri);
  const claim = impersonates(client.name, redirectUri);
  const name = client.name ? `“${esc(client.name)}”` : "this app";
  const published = (() => {
    try {
      return client.kind === "cimd" ? new URL(client.id).host : null;
    } catch {
      return null;
    }
  })();
  const trust = published
    ? `<p class="note">Its details are published at <b>${esc(published)}</b>.</p>`
    : `<p class="note">Name not verified: the app chose it when it registered.</p>`;
  const warn = claim
    ? `<p class="warn">This app calls itself ${esc(claim)}, but access would go to ${esc(dest.host)}, which isn’t ${esc(claim)}’s. Don’t allow it unless you are sure.</p>`
    : "";
  const where = dest.local ? "an app on this computer" : esc(dest.host);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Allow access</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Manrope,ui-sans-serif,system-ui,sans-serif;background:#f6f5ff;color:#14163c}@media(prefers-color-scheme:dark){body{background:#0d0e26;color:#f2f1ff}}
.card{width:min(460px,92vw);padding:28px 24px;border-radius:20px;background:rgba(255,255,255,.44);border:1px solid rgba(255,255,255,.6);backdrop-filter:blur(26px) saturate(150%);box-shadow:0 8px 24px -16px rgba(20,90,140,.22)}@media(prefers-color-scheme:dark){.card{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.14)}}
h1{font-size:20px;margin:0 0 6px;overflow-wrap:anywhere}p{margin:0 0 14px;opacity:.8}ul{margin:0 0 18px;padding-left:18px}li{margin:4px 0}.note{font-size:13px;opacity:.7}
.dest{opacity:1;margin:0 0 14px;padding:12px 14px;border-radius:14px;border:1px solid rgba(20,22,60,.12);font-size:13px}.dest b{display:block;margin-top:4px;font:600 17px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}@media(prefers-color-scheme:dark){.dest{border-color:rgba(255,255,255,.16)}}
.warn{opacity:1;padding:12px 14px;border-radius:14px;background:rgba(255,207,92,.18);border:1px solid rgba(255,207,92,.7);font-size:14px}
.row{display:flex;gap:8px}button{flex:1;height:44px;border-radius:9999px;border:1px solid transparent;font:600 15px Manrope,system-ui,sans-serif;cursor:pointer}.primary{background:#14163c;color:#fff}.quiet{background:rgba(255,255,255,.34);border-color:rgba(255,255,255,.62);color:inherit}@media(prefers-color-scheme:dark){.primary{background:#f2f1ff;color:#0d0e26}}</style></head>
<body><form class="card" method="post" action="/oauth/authorize/decision">${hidden}
<h1>Allow ${name} to work your inbox?</h1>${trust}
<p class="dest">Access goes to<b>${where}</b></p>${warn}
<p>It may:</p>
<ul>${scopes.map((s) => `<li>${esc(scopeLabel(s))}</li>`).join("")}</ul>
<p class="note">Allow only an app you are connecting yourself, right now. You can disconnect it at any time in Settings → Keys.</p>
<div class="row"><button class="${claim ? "primary" : "quiet"}" name="decision" value="deny">Don't allow</button><button class="${claim ? "quiet" : "primary"}" name="decision" value="allow">Allow</button></div></form></body></html>`;
}

function scopeLabel(scope: string): string {
  return (SCOPES as Record<string, string>)[scope] ?? scope;
}

export { sha256Hex };
