import { sha256Hex } from "@surfingdog/platform";
import { desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { randomToken, ulid } from "../ids";
import { apiKeys, scopeRefusals } from "../schema/tables";
import { readSettings } from "../settings/schema";
import { type Caller, isCustomer, isOwnerInPerson, nowOf } from "../write/caller";
import { WriteError } from "../write/errors";
import {
  type CreateApiKeyInput,
  holdsScope,
  KEY_PRESETS,
  KEY_SCOPES,
  OWNER_ONLY_KEY_SCOPES,
  type RevokeApiKeyInput,
  SCOPES,
  type Scope,
} from "./scopes";

/** Owner-side keys (the owner's own, and integration keys) start with this; customer agents' keys differ. */
export const OWNER_KEY_PREFIX = "sdi_own_";
export const AGENT_KEY_PREFIX = "sdi_agent_";

export type ApiKeyKind = "owner" | "integration" | "agent";

export async function hashApiKey(key: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(key));
}

/**
 * Mints a key and stores only its hash. The key itself is returned once, here, and nowhere else.
 * `owner` keys (the command line) hold every scope; `integration` keys hold what they were given.
 */
export async function mintApiKey(
  db: Db,
  input: {
    kind: ApiKeyKind;
    name: string;
    scopes?: readonly string[] | undefined;
    userId?: string | null | undefined;
    partyId?: string | null | undefined;
    expiresAt?: number | null | undefined;
    createdBy?: string | null | undefined;
    now?: number | undefined;
  },
): Promise<{ id: string; key: string }> {
  const now = input.now ?? Date.now();
  const id = ulid(now);
  const key = `${input.kind === "agent" ? AGENT_KEY_PREFIX : OWNER_KEY_PREFIX}${randomToken(24)}`;
  await db.orm.insert(apiKeys).values({
    id,
    prefix: key.slice(0, 12),
    hash: await hashApiKey(key),
    name: input.name,
    kind: input.kind,
    scopes: [...(input.scopes ?? (input.kind === "agent" ? ["public"] : ["*"]))],
    partyId: input.partyId ?? null,
    userId: input.userId ?? null,
    rateTier: input.kind === "integration" ? "integration" : null,
    expiresAt: input.expiresAt ?? null,
    createdBy: input.createdBy ?? null,
    last4: key.slice(-4),
    createdAt: now,
  });
  return { id, key };
}

export interface RefusalView {
  /** What was called: `POST /v1/owner/services`, or `mcp:upsert_service`. */
  readonly operation: string;
  /** The scope it would have needed (the first of those that let a caller through). */
  readonly scope: string;
  readonly count: number;
  /** Whether the last such call was refused (scopes enforced) or only recorded. */
  readonly enforced: boolean;
  readonly first_at: string;
  readonly last_at: string;
}

export interface KeyView {
  readonly id: string;
  readonly name: string;
  /** `owner`: a full owner key from the command line. `integration`: named and scoped, minted in the product. */
  readonly kind: "owner" | "integration";
  /** The first characters and the last four, to tell keys apart. Never the key. */
  readonly hint: string;
  readonly scopes: readonly string[];
  readonly active: boolean;
  readonly created_at: string;
  readonly created_by: string | null;
  readonly last_used_at: string | null;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
  /** Calls this key made outside its scopes, per operation. */
  readonly refusals: readonly RefusalView[];
}

export interface CreatedKey extends KeyView {
  /** The key itself. In this answer and in no other: store it now. */
  readonly key: string | null;
  readonly key_note: string;
}

export interface PrincipalRefusals {
  readonly kind: string;
  readonly id: string;
  readonly name: string | null;
  readonly refusals: readonly RefusalView[];
}

export interface KeyList {
  readonly items: readonly KeyView[];
  /** The owner's AI apps (OAuth clients) that called outside the scopes they were granted. */
  readonly ai_clients: readonly PrincipalRefusals[];
  readonly scopes: readonly { scope: string; label: string }[];
  readonly presets: typeof KEY_PRESETS;
  /** The two switches in `settings.security`, as they stand. */
  readonly security: { readonly ai_may_create_keys: boolean; readonly enforce_scopes: boolean };
}

type KeyRow = typeof apiKeys.$inferSelect;
type RefusalRow = typeof scopeRefusals.$inferSelect;

const KEY_NOTE = "Store this key now. It is shown once and never again; if it is lost, revoke it and create another.";

/**
 * Keys and scopes (ADR-004): the owner, and with the owner's leave the owner's AI, mints a named,
 * scoped, revocable key per system it connects; every owner route and tool checks the caller's
 * scopes through `requireScope`, which records a call outside them and, when `security.enforceScopes` is
 * on, refuses it.
 */
export class AccessCapabilities {
  constructor(private readonly db: Db) {}

  /**
   * The one scope check. Passes when the caller holds any of `anyOf` (or `*`), or is an internal
   * caller with no principal. Otherwise the call is recorded against its key or AI app, and refused
   * only when the owner has switched enforcement on.
   */
  async requireScope(caller: Caller, anyOf: readonly string[], operation: string): Promise<void> {
    const p = caller.principal;
    if (!p || isCustomer(caller) || anyOf.length === 0 || holdsScope(p.scopes, anyOf)) return;
    const enforce = (await readSettings(this.db)).security.enforceScopes;
    const now = nowOf(caller);
    const scope = anyOf[0] ?? "*";
    // Recording is the point of log-first, but never itself a reason to refuse: a record that
    // cannot be written leaves the call as the setting says, allowed while scopes are only logged.
    await this.db.client
      .query({
        sql: `INSERT INTO scope_refusals (principal_id, operation, principal_kind, principal_name, scope, count, enforced, first_at, last_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
            ON CONFLICT (principal_id, operation) DO UPDATE SET
              count = scope_refusals.count + 1, enforced = excluded.enforced, scope = excluded.scope,
              principal_name = excluded.principal_name, last_at = excluded.last_at`,
        params: [
          p.id,
          operation.slice(0, 120),
          caller.actor.kind,
          p.name.slice(0, 120),
          scope,
          enforce ? 1 : 0,
          now,
          now,
        ],
        method: "run",
      })
      .catch(() => undefined);
    if (enforce) {
      throw new WriteError(
        "not_allowed",
        `${p.via === "oauth" ? "This AI app was" : "This key was"} not given the scope ${scope}, which ${operation} needs. The owner can grant it in Settings → Keys${p.via === "oauth" ? " by connecting the app again with that scope" : ", on a new key"}.`,
        { details: { required_scopes: anyOf, held_scopes: p.scopes } },
      );
    }
  }

  async listKeys(caller: Caller): Promise<KeyList> {
    requireBusiness(caller);
    const rows = await this.db.orm
      .select()
      .from(apiKeys)
      .where(inArray(apiKeys.kind, ["owner", "integration"]))
      .orderBy(desc(apiKeys.createdAt));
    const refusals = await this.db.orm.select().from(scopeRefusals).orderBy(desc(scopeRefusals.lastAt));
    const byPrincipal = new Map<string, RefusalRow[]>();
    for (const r of refusals) byPrincipal.set(r.principalId, [...(byPrincipal.get(r.principalId) ?? []), r]);
    const now = nowOf(caller);
    const items = rows
      .map((r) => keyView(r, byPrincipal.get(r.id) ?? [], now))
      .sort((a, b) => Number(b.active) - Number(a.active));
    const keyIds = new Set(rows.map((r) => r.id));
    const aiClients: PrincipalRefusals[] = [];
    for (const [id, list] of byPrincipal) {
      if (keyIds.has(id)) continue;
      const first = list[0];
      aiClients.push({
        kind: first?.principalKind ?? "owner_ai",
        id,
        name: first?.principalName ?? null,
        refusals: list.map(refusalView),
      });
    }
    const security = (await readSettings(this.db)).security;
    return {
      items,
      ai_clients: aiClients,
      scopes: Object.entries(SCOPES).map(([scope, label]) => ({ scope, label })),
      presets: KEY_PRESETS,
      security: { ai_may_create_keys: security.aiMayCreateKeys, enforce_scopes: security.enforceScopes },
    };
  }

  /**
   * A new integration key, shown once. The owner in person may always mint one; their AI only once
   * the owner has switched `security.aiMayCreateKeys` on, and never one with `settings:write`; an
   * integration key never mints keys. The caller has to hold each scope it hands out — recorded,
   * and refused when scopes are enforced, like every other scope.
   */
  async createKey(caller: Caller, input: CreateApiKeyInput): Promise<CreatedKey> {
    requireBusiness(caller);
    const ai = await this.assertMayManageKeys(caller, "create");
    const now = nowOf(caller);
    const preset = input.preset ? KEY_PRESETS.find((p) => p.key === input.preset) : undefined;
    const scopes = [...new Set<Scope>([...(preset?.scopes ?? []), ...(input.scopes ?? [])])].sort(
      (a, b) => KEY_SCOPES.indexOf(a) - KEY_SCOPES.indexOf(b),
    );
    if (scopes.length === 0) {
      throw new WriteError("invalid_input", "give the key a preset or at least one scope", {
        fields: [{ path: "scopes", problem: "missing", message: `pick from ${KEY_SCOPES.join(", ")}` }],
      });
    }
    const ownerOnly = scopes.filter((s) => OWNER_ONLY_KEY_SCOPES.includes(s));
    if (ai && ownerOnly.length) {
      throw new WriteError("not_allowed", `only the owner can create a key with ${ownerOnly.join(", ")}`, {
        fields: [{ path: "scopes", problem: "invalid", message: `leave out ${ownerOnly.join(", ")}` }],
      });
    }
    let expiresAt: number | null = null;
    if (input.expires_at) {
      expiresAt = Date.parse(input.expires_at);
      if (!(expiresAt > now)) {
        throw new WriteError("invalid_input", "expires_at is in the past", {
          fields: [{ path: "expires_at", problem: "invalid", message: "use an instant in the future" }],
        });
      }
    }
    for (const scope of scopes) await this.requireScope(caller, [scope], `create_api_key:${scope}`);
    const createdBy = ai ? `owner_ai:${caller.principal?.name ?? caller.actor.id}` : "owner";
    const { id, key } = await mintApiKey(this.db, {
      kind: "integration",
      name: input.name,
      scopes,
      userId: caller.principal?.userId ?? null,
      expiresAt,
      createdBy,
      now,
    });
    return { ...(await this.view(id, now)), key, key_note: KEY_NOTE };
  }

  /**
   * Revoked at once, for good. The owner's AI may revoke only keys an AI made, and only with leave:
   * the owner's own keys — the command-line key and every key the owner made in Settings → Keys —
   * are the owner's to revoke, so an AI talked into it cannot cut off the owner's integrations.
   */
  async revokeKey(caller: Caller, input: RevokeApiKeyInput): Promise<KeyView> {
    requireBusiness(caller);
    const ai = await this.assertMayManageKeys(caller, "revoke");
    const now = nowOf(caller);
    const row = await this.row(input.key_id);
    if (ai && !(row.kind === "integration" && row.createdBy?.startsWith("owner_ai:"))) {
      throw new WriteError(
        "not_allowed",
        "only the owner can revoke a key the owner made, in Settings → Keys; the AI may revoke only keys an AI made",
      );
    }
    await this.db.client.query({
      sql: "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      params: [now, row.id],
      method: "run",
    });
    return this.view(row.id, now);
  }

  /** Whether a caller is the owner's AI (true) or the owner (false); throws for anyone else. */
  private async assertMayManageKeys(caller: Caller, what: "create" | "revoke"): Promise<boolean> {
    if (caller.actor.kind === "integration" || caller.principal?.keyKind === "integration") {
      throw new WriteError(
        "not_allowed",
        `an integration key cannot ${what} keys; the owner does that in Settings → Keys`,
      );
    }
    // Everything that comes through the owner MCP is an AI working for the owner, whatever it signed in with.
    const ai = !isOwnerInPerson(caller) || caller.actor.channel === "mcp_owner";
    if (ai && !(await readSettings(this.db)).security.aiMayCreateKeys) {
      throw new WriteError(
        "not_allowed",
        `The owner has not let their AI ${what} keys. Ask them to switch on "Let my AI create keys" in Settings → Keys, or to ${what} the key there themselves.`,
        { details: { setting: "security.aiMayCreateKeys" } },
      );
    }
    return ai;
  }

  private async row(id: string): Promise<KeyRow> {
    const [row] = await this.db.orm.select().from(apiKeys).where(eq(apiKeys.id, id));
    if (!row || (row.kind !== "owner" && row.kind !== "integration")) {
      throw new WriteError("invalid_input", "unknown key", {
        fields: [{ path: "key_id", problem: "invalid", message: "no such key" }],
      });
    }
    return row;
  }

  private async view(id: string, now: number): Promise<KeyView> {
    const row = await this.row(id);
    const refusals = await this.db.orm.select().from(scopeRefusals).where(eq(scopeRefusals.principalId, id));
    return keyView(row, refusals, now);
  }
}

function keyView(row: KeyRow, refusals: readonly RefusalRow[], now: number): KeyView {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const expired = row.expiresAt !== null && row.expiresAt <= now;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === "integration" ? "integration" : "owner",
    hint: `${row.prefix}…${row.last4 ?? ""}`,
    scopes: row.scopes,
    active: row.revokedAt === null && !expired,
    created_at: new Date(row.createdAt).toISOString(),
    created_by: row.createdBy ?? (row.kind === "owner" ? "cli" : null),
    last_used_at: iso(row.lastUsedAt),
    expires_at: iso(row.expiresAt),
    revoked_at: iso(row.revokedAt),
    refusals: [...refusals].sort((a, b) => b.lastAt - a.lastAt).map(refusalView),
  };
}

function refusalView(r: RefusalRow): RefusalView {
  return {
    operation: r.operation,
    scope: r.scope,
    count: r.count,
    enforced: r.enforced === 1,
    first_at: new Date(r.firstAt).toISOString(),
    last_at: new Date(r.lastAt).toISOString(),
  };
}

function requireBusiness(caller: Caller): void {
  if (isCustomer(caller)) throw new WriteError("not_allowed", "keys need an owner or staff principal");
}
