import { type Caller, type Channel, type Db, randomToken, schema, type TrustTier, ulid } from "@surfingdog/core";
import { sha256Hex } from "@surfingdog/platform";
import { eq } from "drizzle-orm";

/**
 * Turns a request into a Caller. Owner keys (`sdi_own_…`) and agent keys (`sdi_agent_…`) are
 * looked up by SHA-256; everything else is anonymous with a stable per-client idempotency scope.
 * Passkeys, sessions and OAuth tokens plug into the same resolver later (ADR-004).
 */
export const OWNER_PREFIX = "sdi_own_";
export const AGENT_PREFIX = "sdi_agent_";

export interface ApiKeyInfo {
  readonly id: string;
  readonly kind: "owner" | "agent";
  readonly name: string;
  readonly scopes: readonly string[];
  readonly userId: string | null;
  readonly partyId: string | null;
}

export async function hashKey(key: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(key));
}

export async function createApiKey(
  db: Db,
  input: {
    kind: "owner" | "agent";
    name: string;
    scopes?: readonly string[];
    userId?: string;
    partyId?: string;
    now?: number;
  },
): Promise<{ id: string; key: string }> {
  const id = ulid();
  const key = `${input.kind === "owner" ? OWNER_PREFIX : AGENT_PREFIX}${randomToken(24)}`;
  await db.orm.insert(schema.apiKeys).values({
    id,
    prefix: key.slice(0, 12),
    hash: await hashKey(key),
    name: input.name,
    kind: input.kind,
    scopes: [...(input.scopes ?? (input.kind === "owner" ? ["*"] : ["public"]))],
    partyId: input.partyId ?? null,
    userId: input.userId ?? null,
    createdAt: input.now ?? Date.now(),
  });
  return { id, key };
}

export async function resolveApiKey(db: Db, key: string): Promise<ApiKeyInfo | null> {
  if (!key.startsWith(OWNER_PREFIX) && !key.startsWith(AGENT_PREFIX)) return null;
  const [row] = await db.orm
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.hash, await hashKey(key)));
  if (!row || row.revokedAt) return null;
  return {
    id: row.id,
    kind: row.kind as "owner" | "agent",
    name: row.name,
    scopes: row.scopes,
    userId: row.userId,
    partyId: row.partyId,
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
  const key = bearer ? await resolveApiKey(db, bearer) : null;
  if (key?.kind === "owner") {
    return {
      auth: key,
      actor: { kind: "owner", id: key.userId ?? key.id, channel: opts.channel },
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
