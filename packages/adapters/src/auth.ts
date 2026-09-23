import {
  AGENT_KEY_PREFIX,
  type ApiKeyKind,
  type Caller,
  type Channel,
  type Db,
  hashApiKey,
  mintApiKey,
  OWNER_KEY_PREFIX,
  type Principal,
  schema,
  type TrustTier,
} from "@surfingdog/core";
import { sha256Hex } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { resolveAccessToken } from "./oauth";
import { userFromCookie } from "./session";

/**
 * Turns a request into a Caller. Owner keys (`sdi_own_…`, the owner's own and the integration keys
 * minted in the product) and agent keys (`sdi_agent_…`) are looked up by SHA-256; OAuth access
 * tokens and the owner app's session cookie resolve to the owner's AI and the owner; everything
 * else is anonymous with a stable per-client idempotency scope (ADR-004).
 */
export const OWNER_PREFIX = OWNER_KEY_PREFIX;
export const AGENT_PREFIX = AGENT_KEY_PREFIX;

export interface ApiKeyInfo {
  readonly id: string;
  /** The door the key opens: the owner's (owner and integration keys) or a customer agent's. */
  readonly kind: "owner" | "agent";
  /** For an owner-door key: the owner's own key, or an integration key minted in the product. */
  readonly keyKind?: "owner" | "integration" | undefined;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly userId: string | null;
  readonly partyId: string | null;
  /** How the principal proved itself. Cookie sessions need same-origin checks on writes. */
  readonly via: "api_key" | "session" | "oauth";
}

export async function hashKey(key: string): Promise<string> {
  return hashApiKey(key);
}

/** Mints a key; the command line and tests call this. Integration keys come from `caps.access.createKey`. */
export async function createApiKey(
  db: Db,
  input: {
    kind: ApiKeyKind;
    name: string;
    scopes?: readonly string[];
    userId?: string;
    partyId?: string;
    expiresAt?: number;
    now?: number;
  },
): Promise<{ id: string; key: string }> {
  return mintApiKey(db, {
    ...input,
    createdBy: input.kind === "owner" ? "cli" : null,
  });
}

/** `last_used_at` is written at most this often per key, so a busy integration is not a write per call. */
const TOUCH_EVERY_MS = 60_000;

export async function resolveApiKey(db: Db, key: string, now = Date.now()): Promise<ApiKeyInfo | null> {
  if (!key.startsWith(OWNER_PREFIX) && !key.startsWith(AGENT_PREFIX)) return null;
  const [row] = await db.orm
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.hash, await hashKey(key)));
  if (!row || row.revokedAt) return null;
  if (row.expiresAt !== null && row.expiresAt <= now) return null;
  if (row.lastUsedAt === null || now - row.lastUsedAt >= TOUCH_EVERY_MS) {
    await db.client.query({
      sql: "UPDATE api_keys SET last_used_at = ? WHERE id = ?",
      params: [now, row.id],
      method: "run",
    });
  }
  const integration = row.kind === "integration";
  return {
    id: row.id,
    kind: row.kind === "agent" ? "agent" : "owner",
    ...(row.kind === "agent" ? {} : { keyKind: integration ? "integration" : "owner" }),
    name: row.name,
    scopes: row.scopes,
    userId: row.userId,
    partyId: row.partyId,
    via: "api_key",
  };
}

export interface CallerOptions {
  readonly channel: Channel;
  /** The instance is in test mode: every item is sandbox. */
  readonly sandbox?: boolean;
  readonly now?: () => number;
}

/** Who is knocking, from the headers alone. Never throws: an unknown key is simply anonymous. */
export async function callerFromRequest(
  db: Db,
  request: Request,
  opts: CallerOptions,
): Promise<Caller & { auth: ApiKeyInfo | null }> {
  const now = opts.now ?? (() => Date.now());
  const header = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  const url = new URL(request.url);
  const sandbox =
    opts.sandbox === true || request.headers.get("x-sandbox") === "1" || url.hostname.startsWith("sandbox.");
  let key = bearer ? await resolveApiKey(db, bearer, now()) : null;
  if (!key && bearer) {
    const grant = await resolveAccessToken(db, bearer, now());
    if (grant)
      key = {
        id: grant.clientId,
        kind: "owner",
        name: grant.clientName ?? `oauth:${grant.clientId}`,
        scopes: grant.scopes,
        userId: grant.userId,
        partyId: null,
        via: "oauth",
      };
  }
  if (!key && !bearer) {
    const user = await userFromCookie(db, request, now());
    if (user)
      key = {
        id: user.sessionId,
        kind: "owner",
        name: user.email,
        scopes: ["*"],
        userId: user.id,
        partyId: null,
        via: "session",
      };
  }
  if (key?.kind === "owner") {
    const principal: Principal = {
      via: key.via,
      id: key.id,
      name: key.name,
      scopes: key.scopes,
      userId: key.userId,
      ...(key.keyKind ? { keyKind: key.keyKind } : {}),
    };
    // Who the history says did it. The owner's AI and an integration key are their own actors,
    // so a two-way sync can recognise its own echo; both still act with the owner's rights on the
    // state machines (`actsAs`), and it is their scopes that narrow them.
    const actor =
      key.via === "oauth"
        ? ({ kind: "owner_ai", id: key.id } as const)
        : key.keyKind === "integration"
          ? ({ kind: "integration", id: key.id } as const)
          : ({ kind: "owner", id: key.userId ?? key.id } as const);
    return {
      auth: key,
      actor: { ...actor, channel: opts.channel },
      ...(actor.kind === "owner" ? {} : { actsAs: "owner" as const }),
      principal,
      tier: "verified_principal",
      sandbox,
      now,
    };
  }
  if (key?.kind === "agent") {
    return {
      auth: key,
      actor: {
        kind: "customer_agent",
        id: key.id,
        channel: opts.channel,
        ...(key.partyId ? { partyId: key.partyId } : {}),
      },
      tier: "verified_principal" satisfies TrustTier,
      sandbox,
      now,
    };
  }
  const ip =
    request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ua = request.headers.get("user-agent") ?? "";
  const anon = (await sha256Hex(new TextEncoder().encode(`${ip}|${ua}`))).slice(0, 16);
  const kind = opts.channel === "form" || opts.channel === "email" ? "customer_human" : "customer_agent";
  return {
    auth: null,
    actor: { kind, id: `anon:${anon}`, channel: opts.channel },
    tier: "anonymous",
    sandbox,
    now,
  };
}

/** The idempotency scope for a caller on a door: principal first, else the anonymous fingerprint. */
export function scopeFor(caller: Caller): string {
  return `${caller.actor.kind}:${caller.actor.partyId ?? caller.actor.id}:${caller.actor.channel}`;
}
