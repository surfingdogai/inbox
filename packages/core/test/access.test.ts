import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { AccessCapabilities, mintApiKey } from "../src/access/keys";
import { OLD_AI_DEFAULT_SCOPES } from "../src/access/scopes";
import { Capabilities } from "../src/capabilities/service";
import { WebhookCapabilities } from "../src/capabilities/webhooks";
import { createDb, type Db } from "../src/db";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { oauthClients, oauthTokens } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import type { Caller, Principal } from "../src/write/index";
import { once, pruneIdempotencyKeys, withIdempotencyKey } from "../src/write/index";
import { makeClient, openWeekdays, resetTables } from "./harness";

/**
 * Keys, scopes, idempotency and attribution at the core (ADR-004; scopes refused out of the box). The
 * doors are covered in apps/inbox/test/integrations.test.ts; this is the policy underneath them, on
 * both runtimes.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const KEY = "2f8c1d0a6b4e37925c8f01ad6e3b47f0";

const principal = (p: Partial<Principal> & Pick<Principal, "via" | "id">): Principal => ({
  name: "p",
  scopes: ["*"],
  userId: null,
  ...p,
});

/** The owner in the owner app. */
const owner: Caller = {
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  principal: principal({ via: "session", id: "sess_1", name: "owner@example.com", userId: "user_1" }),
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
/** An integration key minted for Zapier with the automation scopes. */
const zapier: Caller = {
  actor: { kind: "integration", id: "key_zap", channel: "rest" },
  actsAs: "owner",
  principal: principal({
    via: "api_key",
    keyKind: "integration",
    id: "key_zap",
    name: "Zapier",
    scopes: ["inbox:read", "inbox:write", "events:read"],
  }),
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
/** The owner's AI over OAuth, with the default consent. */
const claude: Caller = {
  actor: { kind: "owner_ai", id: "client_claude", channel: "mcp_owner" },
  actsAs: "owner",
  principal: principal({
    via: "oauth",
    id: "client_claude",
    name: "Claude",
    scopes: ["inbox:read", "inbox:write", "settings:read", "offline_access"],
    userId: "user_1",
  }),
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};

async function setup(): Promise<{ db: Db; caps: Capabilities }> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await openWeekdays(db);
  return { db, caps: new Capabilities(db, createSecretBox([KEY])) };
}

/** The settings row as an inbox from before this release left it: a document, or none at all. */
async function storeSettings(db: Db, doc: Record<string, unknown> | null): Promise<void> {
  await db.client.query({ sql: "DELETE FROM settings", method: "run" });
  if (doc === null) return;
  await db.client.query({
    sql: "INSERT INTO settings (id, schema_version, doc, version, updated_at) VALUES ('singleton', 1, ?, 3, ?)",
    params: [JSON.stringify(doc), T0],
    method: "run",
  });
}

const refusalsOf = async (db: Db, id: string) =>
  (
    await db.client.query({
      sql: "SELECT principal_kind, operation, scope, count, enforced FROM scope_refusals WHERE principal_id = ?",
      params: [id],
      method: "all",
    })
  ).rows;

describe("the scope check (refused out of the box)", () => {
  it("refuses a call outside the scopes, says why in words its maker can act on, and records it", async () => {
    const { db, caps } = await setup();
    const refused = caps.access.requireScope(zapier, ["settings:write"], "PUT /settings");
    await expect(refused).rejects.toMatchObject({
      code: "not_allowed",
      details: {
        reason: "outside_scopes",
        required_scopes: ["settings:write"],
        held_scopes: ["inbox:read", "inbox:write", "events:read"],
        ask_owner: true,
        where: "Settings → Keys",
      },
    });
    await expect(refused).rejects.toThrow(
      'Refused: the key "Zapier" was not given the scope settings:write, which PUT /settings needs. Nothing was done. It holds inbox:read inbox:write events:read. The owner makes a key with settings:write in Settings → Keys, for this system to use instead.',
    );
    // An AI app is told how its owner grants more.
    await expect(caps.access.requireScope(claude, ["catalogue:write"], "mcp:upsert_service")).rejects.toThrow(
      'Refused: the AI app "Claude" was not granted the scope catalogue:write, which mcp:upsert_service needs. Nothing was done. It holds inbox:read inbox:write settings:read. The owner grants more in Settings → Keys: disconnect the app there, then connect it again and allow the scope.',
    );
    // What only the owner does names no scope to ask for; nor what no AI app is ever given.
    const ownerOnly = caps.access.requireScope(zapier, ["*"], "PUT /spam/ai");
    await expect(ownerOnly).rejects.toThrow(
      'Refused: the key "Zapier" cannot call PUT /spam/ai, which only the owner does, in person. Nothing was done.',
    );
    await expect(ownerOnly).rejects.toMatchObject({ details: { reason: "owner_only", required_scopes: ["*"] } });
    await expect(
      caps.access.requireScope(claude, ["customers:erase"], "POST /customers/:id/erase"),
    ).rejects.toMatchObject({
      message:
        'Refused: the AI app "Claude" cannot call POST /customers/:id/erase, which only the owner does, in person. Nothing was done.',
      details: { reason: "owner_only" },
    });
    // A key may be given it, and is told so.
    await expect(caps.access.requireScope(zapier, ["customers:erase"], "POST /customers/:id/erase")).rejects.toThrow(
      "The owner makes a key with customers:erase in Settings → Keys",
    );
    // Keys are the owner's in person, for a key and an AI app alike: no key can hold keys:write, and an
    // app that holds it is refused keys all the same, so neither is sent off to ask for it.
    for (const [who, operation] of [
      [zapier, "POST /api-keys"],
      [zapier, "DELETE /api-keys/:id"],
      [zapier, "DELETE /connected-apps/:id"],
      [claude, "mcp:create_api_key"],
      [claude, "mcp:revoke_api_key"],
    ] as const) {
      const refusal = (await caps.access
        .requireScope(who, ["keys:write"], operation)
        .catch((e: unknown) => e)) as Error;
      expect(refusal, operation).toMatchObject({
        code: "not_allowed",
        details: { reason: "owner_only", required_scopes: ["keys:write"], where: "the owner app" },
      });
      expect(refusal.message, operation).toContain(`cannot call ${operation}, which only the owner does, in person.`);
      expect(refusal.message, operation).not.toMatch(/keys:write|allow the scope/);
    }
    // In scope, and the owner in person, pass and leave nothing.
    await caps.access.requireScope(zapier, ["inbox:read"], "GET /items");
    await caps.access.requireScope(zapier, ["events:read", "inbox:read"], "GET /events");
    await caps.access.requireScope(owner, ["settings:write"], "PUT /settings");
    expect(await refusalsOf(db, "key_zap")).toEqual(
      expect.arrayContaining([
        ["integration", "PUT /settings", "settings:write", 1, 1],
        ["integration", "PUT /spam/ai", "*", 1, 1],
        ["integration", "POST /customers/:id/erase", "customers:erase", 1, 1],
      ]),
    );
    expect(await refusalsOf(db, "key_zap")).toHaveLength(6);
    expect(await refusalsOf(db, "sess_1")).toEqual([]);
    const list = await caps.access.listKeys(owner);
    expect(list.ai_clients).toContainEqual({
      kind: "owner_ai",
      id: "client_claude",
      name: "Claude",
      refusals: expect.arrayContaining([
        expect.objectContaining({ operation: "mcp:upsert_service", scope: "catalogue:write", enforced: true }),
        expect.objectContaining({ operation: "POST /customers/:id/erase", scope: "customers:erase", enforced: true }),
      ]),
    });
    expect(list.security).toEqual({ ai_may_create_keys: false, enforce_scopes: true });
  });

  it("gives the new default to every inbox that never touched the switch, and keeps the choice of one that did", async () => {
    const { db, caps } = await setup();
    const refusedHere = async () =>
      caps.access.requireScope(zapier, ["catalogue:write"], "POST /services").then(
        () => false,
        () => true,
      );
    // Never written; written without a security section; with only a security contact; with the retired
    // switch alone: each reads the default, and refuses.
    for (const doc of [
      null,
      { schemaVersion: 1, booking: { autoExpireHours: 48 } },
      { schemaVersion: 1, security: { contact: "security@example.com" } },
      { schemaVersion: 1, security: { aiMayCreateKeys: false } },
      // A value this version cannot read is left out, and its default applies.
      { schemaVersion: 1, security: { enforceScopes: "yes" } },
    ]) {
      await storeSettings(db, doc);
      expect(await refusedHere(), JSON.stringify(doc)).toBe(true);
      expect((await caps.access.listKeys(owner)).security.enforce_scopes, JSON.stringify(doc)).toBe(true);
    }
    // An owner who switched it on keeps it on; one who switched it off keeps logging first.
    await storeSettings(db, { schemaVersion: 1, security: { enforceScopes: true } });
    expect(await refusedHere()).toBe(true);
    await storeSettings(db, { schemaVersion: 1, security: { enforceScopes: false, contact: "security@example.com" } });
    expect(await refusedHere()).toBe(false);
    expect((await caps.access.listKeys(owner)).security.enforce_scopes).toBe(false);
    // Nothing was rewritten to get there.
    const { rows } = await db.client.query({ sql: "SELECT doc FROM settings", method: "all" });
    expect(JSON.parse(String(rows[0]?.[0]))).toEqual({
      schemaVersion: 1,
      security: { enforceScopes: false, contact: "security@example.com" },
    });
  });

  it("lets the owner loosen it: off, a call outside the scopes goes through and is only recorded", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { security: { enforceScopes: false } } });
    await caps.access.requireScope(zapier, ["catalogue:write"], "POST /services");
    await caps.access.requireScope(zapier, ["catalogue:write"], "POST /services");
    await caps.access.requireScope(claude, ["settings:write"], "mcp:update_settings");
    expect(await refusalsOf(db, "key_zap")).toEqual([["integration", "POST /services", "catalogue:write", 2, 0]]);
    expect(await refusalsOf(db, "client_claude")).toEqual([
      ["owner_ai", "mcp:update_settings", "settings:write", 1, 0],
    ]);
    expect((await caps.access.listKeys(owner)).security.enforce_scopes).toBe(false);
    // Back on, the same call is refused, and the record says so.
    await caps.updateSettings(owner, { doc: { security: { enforceScopes: true } } });
    await expect(caps.access.requireScope(zapier, ["catalogue:write"], "POST /services")).rejects.toMatchObject({
      code: "not_allowed",
      details: { reason: "outside_scopes", required_scopes: ["catalogue:write"] },
    });
    expect(await refusalsOf(db, "key_zap")).toEqual([["integration", "POST /services", "catalogue:write", 3, 1]]);
    // A website's forms key is refused everything else even while the switch is off.
    await caps.updateSettings(owner, { doc: { security: { enforceScopes: false } } });
    const forms: Caller = {
      ...zapier,
      actor: { kind: "integration", id: "key_forms", channel: "rest" },
      principal: principal({
        via: "api_key",
        keyKind: "integration",
        id: "key_forms",
        name: "Website",
        scopes: ["forms:submit"],
      }),
    };
    await expect(caps.access.requireScope(forms, ["inbox:read"], "GET /items")).rejects.toMatchObject({
      code: "not_allowed",
    });
  });

  it("never lets a key or the owner's AI loosen it, and takes an unchanged section back as no change", async () => {
    const { caps } = await setup();
    for (const who of [zapier, claude]) {
      await expect(caps.updateSettings(who, { doc: { security: { enforceScopes: false } } })).rejects.toMatchObject({
        code: "not_allowed",
        details: { reason: "owner_in_person" },
      });
      // The value it read, sent back: nothing to refuse, and nothing written for the owner.
      await caps.updateSettings(who, { doc: { security: { enforceScopes: true } } });
    }
    expect((await caps.access.listKeys(owner)).security.enforce_scopes).toBe(true);
  });

  it("never refuses because the record could not be written, and still refuses while scopes are enforced", async () => {
    const { db, caps } = await setup();
    // A database that takes every query but the refusal record.
    const client = new Proxy(db.client, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (q: Parameters<typeof target.query>[0]) =>
            q.sql.includes("scope_refusals") ? Promise.reject(new Error("disk I/O error")) : target.query(q);
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const access = new AccessCapabilities({ ...db, client });
    // Enforced, as out of the box, the refusal stands without its record.
    await expect(access.requireScope(zapier, ["catalogue:write"], "POST /services")).rejects.toMatchObject({
      code: "not_allowed",
    });
    // Switched off, the call goes through without it.
    await caps.updateSettings(owner, { doc: { security: { enforceScopes: false } } });
    await expect(access.requireScope(zapier, ["catalogue:write"], "POST /services")).resolves.toBeUndefined();
  });
});

describe("keys", () => {
  it("mints a named, scoped integration key, shows it once, lists it without it, and revokes it", async () => {
    const { db, caps } = await setup();
    const created = await caps.access.createKey(owner, { name: "Zapier", preset: "automation" });
    expect(created.key?.startsWith("sdi_own_")).toBe(true);
    expect(created).toMatchObject({
      name: "Zapier",
      kind: "integration",
      scopes: ["inbox:read", "inbox:write", "events:read"],
      active: true,
      created_by: "owner",
    });
    expect(created.hint.endsWith(created.key?.slice(-4) ?? "?")).toBe(true);

    const list = await caps.access.listKeys(owner);
    expect(list.items.map((k) => k.name)).toEqual(["Zapier"]);
    expect(JSON.stringify(list)).not.toContain(created.key);
    const { rows } = await db.client.query({ sql: "SELECT hash, rate_tier FROM api_keys", method: "all" });
    expect(String(rows[0]?.[0])).not.toContain(created.key);
    expect(rows[0]?.[1]).toBe("integration");

    const revoked = await caps.access.revokeKey(owner, { key_id: created.id });
    expect(revoked.active).toBe(false);
    expect(revoked.revoked_at).not.toBeNull();
  });

  it("never lets an integration key or the owner's AI mint or revoke a key, whatever the old switch says", async () => {
    const { db, caps } = await setup();
    await expect(caps.access.createKey(zapier, { name: "x", preset: "read_only" })).rejects.toMatchObject({
      code: "not_allowed",
    });
    await expect(caps.access.createKey(claude, { name: "Shop", preset: "shop_sync" })).rejects.toMatchObject({
      code: "not_allowed",
      details: { reason: "owner_in_person", ask_owner: true, where: "Settings → Keys" },
    });
    // The AI cannot change the security section at all.
    await expect(caps.updateSettings(claude, { doc: { security: { aiMayCreateKeys: true } } })).rejects.toMatchObject({
      code: "not_allowed",
    });
    await expect(caps.updateSettings(zapier, { doc: { security: { enforceScopes: false } } })).rejects.toMatchObject({
      code: "not_allowed",
    });
    // The retired switch, set by the owner, lets the AI in no more than before.
    await caps.updateSettings(owner, { doc: { security: { aiMayCreateKeys: true } } });
    await expect(caps.access.createKey(claude, { name: "Shop", preset: "shop_sync" })).rejects.toMatchObject({
      code: "not_allowed",
    });
    expect((await caps.access.listKeys(owner)).security.ai_may_create_keys).toBe(false);
    // Nor may it revoke any key: the command-line key, one the owner made, or one an AI made before.
    const cli = await mintApiKey(db, { kind: "owner", name: "cli", now: T0 });
    await expect(caps.access.revokeKey(claude, { key_id: cli.id })).rejects.toMatchObject({ code: "not_allowed" });
    const ownersZap = await caps.access.createKey(owner, { name: "Zapier", preset: "automation" });
    await expect(caps.access.revokeKey(claude, { key_id: ownersZap.id })).rejects.toMatchObject({
      code: "not_allowed",
    });
    const byAiBefore = await mintApiKey(db, {
      kind: "integration",
      name: "Shop",
      scopes: ["catalogue:write"],
      createdBy: "owner_ai:Claude",
      now: T0,
    });
    await expect(caps.access.revokeKey(claude, { key_id: byAiBefore.id })).rejects.toMatchObject({
      code: "not_allowed",
    });
    // The owner revokes it in person.
    expect((await caps.access.revokeKey(owner, { key_id: byAiBefore.id })).active).toBe(false);
  });

  it("asks for a scope, and refuses an expiry in the past", async () => {
    const { caps } = await setup();
    await expect(caps.access.createKey(owner, { name: "Empty" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      caps.access.createKey(owner, { name: "Old", preset: "read_only", expires_at: "2020-01-01T00:00:00Z" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const later = await caps.access.createKey(owner, {
      name: "Later",
      scopes: ["events:read"],
      expires_at: "2030-01-01T00:00:00Z",
    });
    expect(later.expires_at).toBe("2030-01-01T00:00:00.000Z");
  });

  it("marks an AI app still on the old default: it reads and answers, and cannot set the business up", async () => {
    const { db, caps } = await setup();
    const connect = async (id: string, name: string, scope: string) => {
      await db.orm
        .insert(oauthClients)
        .values({ id, name, redirectUris: [`https://${id}.example/cb`], kind: "cimd", createdAt: T0 });
      await db.orm.insert(oauthTokens).values({
        tokenHash: `hash_${id}`,
        kind: "refresh",
        clientId: id,
        userId: "user_1",
        scope,
        familyId: `family_${id}`,
        expiresAt: T0 + 30 * 86_400_000,
        createdAt: T0,
      });
    };
    // Connected before 2 November asking for nothing, so given the old default, in any order.
    await connect("client_old", "Claude", "settings:read offline_access inbox:read inbox:write");
    // Connected since, asking for nothing: offered every scope an AI app may hold but keys:write.
    await connect(
      "client_new",
      "ChatGPT",
      "inbox:read inbox:write events:read catalogue:write availability:write settings:read settings:write setup:run integrations:write offline_access",
    );
    // An app that asked for less than the old default chose it; nothing is said of it.
    await connect("client_narrow", "Reader", "inbox:read offline_access");
    expect(OLD_AI_DEFAULT_SCOPES).toEqual(["inbox:read", "inbox:write", "settings:read", "offline_access"]);
    const apps = (await caps.access.listKeys(owner)).apps;
    expect(Object.fromEntries(apps.map((a) => [a.name, a.old_default]))).toEqual({
      Claude: true,
      ChatGPT: false,
      Reader: false,
    });
    // And what it holds is refused as such, telling it how the owner gives it more.
    const claudeOld: Caller = {
      ...claude,
      principal: { ...(claude.principal as Principal), scopes: OLD_AI_DEFAULT_SCOPES },
    };
    await expect(caps.access.requireScope(claudeOld, ["catalogue:write"], "mcp:upsert_service")).rejects.toThrow(
      "disconnect the app there, then connect it again and allow the scope",
    );
  });
});

describe("settings: secrets out, security the owner's", () => {
  it("never returns the inbound secret, keeps it on a write that leaves it out, and says it is there", async () => {
    const { caps } = await setup();
    const saved = await caps.updateSettings(owner, { doc: { email: { inboundSecret: "s3cret-s3cret-s3cret" } } });
    // Masked, not removed: the key keeps its place for clients of the previous shape.
    expect(saved.doc.email.inboundSecret).toBe("(redacted)");
    expect(saved.redacted).toEqual(["email.inboundSecret"]);
    const read = await caps.getSettings(claude);
    expect(JSON.stringify(read)).not.toContain("s3cret");
    expect(read.redacted).toEqual(["email.inboundSecret"]);
    // Writing the document back as read keeps the secret: a write is a merge.
    await caps.updateSettings(owner, { doc: read.doc as unknown as Record<string, unknown> });
    expect((await caps.getSettings(owner)).redacted).toEqual(["email.inboundSecret"]);
  });
});

describe("idempotency for setup writes", () => {
  it("runs a write once per key, replays its answer, and refuses the key with another body", async () => {
    const { caps } = await setup();
    const keyed = withIdempotencyKey(claude, "svc-1");
    const input = {
      name: "Trim",
      duration_min: 30,
      buffer_before_min: 0,
      buffer_after_min: 0,
      capacity: 1,
      granularity_min: 15,
      active: true,
      sort: 0,
    };
    const first = await caps.once(keyed, "services.create", input, () => caps.setup.createService(keyed, input));
    const again = await caps.once(keyed, "services.create", input, () => caps.setup.createService(keyed, input));
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.result.id).toBe(first.result.id);
    expect(await caps.setup.listServices(owner)).toHaveLength(1);
    // The business shares one scope: the owner's app retrying the AI's key is the same request.
    const fromOwner = withIdempotencyKey(owner, "svc-1");
    expect(fromOwner.idempotency?.scope).toBe("business");
    expect(
      (await caps.once(fromOwner, "services.create", input, () => caps.setup.createService(owner, input))).replayed,
    ).toBe(true);
    await expect(
      caps.once(keyed, "services.create", { ...input, name: "Other" }, () => caps.setup.createService(keyed, input)),
    ).rejects.toMatchObject({ code: "idempotency_mismatch" });
  });

  it("tells a concurrent retry to wait, takes over an abandoned key, and releases a failed one", async () => {
    const { db } = await setup();
    const keyed = withIdempotencyKey(owner, "k-1");
    await db.client.query({
      sql: "INSERT INTO idempotency_keys (scope, key, request_hash, status, response, created_at) VALUES ('business', 'k-1', 'h', 0, 'null', ?)",
      params: [T0 - 1_000],
      method: "run",
    });
    // Another request holds the key, with the same body hash would be a wait; with another, a mismatch.
    await expect(once(db, keyed, "op", {}, async () => 1)).rejects.toMatchObject({ code: "idempotency_mismatch" });
    await db.client.query({
      sql: "UPDATE idempotency_keys SET request_hash = ?",
      params: [await hashOf("op", {})],
      method: "run",
    });
    await expect(once(db, keyed, "op", {}, async () => 1)).rejects.toMatchObject({
      code: "version_conflict",
      details: { idempotency: "in_progress" },
    });
    // Abandoned for longer than a few minutes: taken over.
    await db.client.query({
      sql: "UPDATE idempotency_keys SET created_at = ?",
      params: [T0 - 3_600_000],
      method: "run",
    });
    expect(await once(db, keyed, "op", {}, async () => 2)).toEqual({ result: 2, replayed: false });
    expect(await once(db, keyed, "op", {}, async () => 3)).toEqual({ result: 2, replayed: true });

    // A write that fails gives its key back.
    const k2 = withIdempotencyKey(owner, "k-2");
    await expect(
      once(db, k2, "op", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await once(db, k2, "op", {}, async () => 4)).toEqual({ result: 4, replayed: false });
  });

  it("seals an answer that carries a secret, and forgets keys after thirty days", async () => {
    const { db } = await setup();
    const box = createSecretBox([KEY]);
    const keyed = withIdempotencyKey(owner, "k-secret");
    const opts = { secret: { box, fields: ["secret"] } };
    const first = await once(db, keyed, "webhooks.create", {}, async () => ({ id: "w", secret: "whsec_abc" }), opts);
    const again = await once(db, keyed, "webhooks.create", {}, async () => ({ id: "x", secret: "no" }), opts);
    expect(again).toEqual({ result: first.result, replayed: true });
    const { rows } = await db.client.query({ sql: "SELECT response FROM idempotency_keys", method: "all" });
    expect(String(rows[0]?.[0])).not.toContain("whsec_abc");

    // Without a box the secret is left out of the record, and the replay says so.
    const bare = withIdempotencyKey(owner, "k-bare");
    const noBox = { secret: { box: null, fields: ["key"] } };
    await once(db, bare, "keys.create", {}, async () => ({ id: "k", key: "sdi_own_x" }), noBox);
    const replay = await once(db, bare, "keys.create", {}, async () => ({ id: "?", key: "?" }), noBox);
    expect(replay.result).toMatchObject({ id: "k", key: null });

    expect(await pruneIdempotencyKeys(db, T0 + 31 * 86_400_000)).toBe(2);
  });

  it("gives a secret back only to whoever asked for it, never to another key or app reusing the key", async () => {
    const { db } = await setup();
    const opts = { secret: { box: createSecretBox([KEY]), fields: ["key"] } };
    const input = { name: "Shop", scopes: ["catalogue:write"] };
    const mint = async () => ({ id: "k1", key: "sdi_own_the-real-key", key_note: "store it" });
    const first = await once(db, withIdempotencyKey(owner, "mint-1"), "keys.create", input, mint, opts);
    expect(first.result.key).toBe("sdi_own_the-real-key");
    // The owner in another session is still the owner who asked.
    const later: Caller = { ...owner, principal: principal({ via: "session", id: "sess_2", userId: "user_1" }) };
    const again = await once(db, withIdempotencyKey(later, "mint-1"), "keys.create", input, mint, opts);
    expect(again).toEqual({ result: first.result, replayed: true });

    const never = async (): Promise<{ id: string; key: string; key_note: string }> => {
      throw new Error("a replay must not run the write");
    };
    // The owner's AI shares the business's keys: it gets the answer, but not the key.
    const r = await once(db, withIdempotencyKey(claude, "mint-1"), "keys.create", input, never, opts);
    expect(r.replayed).toBe(true);
    expect(r.result).toMatchObject({ id: "k1", key: null, secret_note: expect.stringContaining("another key or app") });
    expect(JSON.stringify(r.result)).not.toContain("the-real-key");

    // An integration key's idempotency keys are its own: the same string is a new request of its own.
    const zapKeyed = withIdempotencyKey(zapier, "mint-1");
    expect(zapKeyed.idempotency?.scope).toBe("integration:key_zap");
    const own = await once(db, zapKeyed, "keys.create", input, async () => ({ id: "z", key: "z", key_note: "" }), opts);
    expect(own).toEqual({ result: { id: "z", key: "z", key_note: "" }, replayed: false });
  });
});

describe("idempotency for an automation's replies", () => {
  /**
   * Found running the n8n flow docs/webhooks.md describes (1 November 2026): the flow answers a new
   * message with the event's id as its idempotency key, and its retry, after the first reply had
   * answered the message, was refused `idempotency_mismatch` rather than given the first answer.
   */
  it("replays a reply retried with its key after the message it answered moved on", async () => {
    const { caps } = await setup();
    const started = (await caps.sendMessage(
      {
        actor: { kind: "customer_agent", id: "anon:1", channel: "rest" },
        tier: "anonymous",
        sandbox: false,
        now: () => T0,
      },
      { body: "Can you look at my gears this week?", contact: { name: "Marta" } },
    )) as { view: { item: { id: string } } };
    const id = started.view.item.id;
    const reply = {
      item_id: id,
      body: "Thank you: we will answer today.",
      internal: false,
      written_by: "automation" as const,
    };
    const first = (await caps.reply(zapier, { ...reply, idempotency_key: "evt_1" })) as {
      view: { item: { state: string; version: number } };
      replayed: boolean;
    };
    expect(first.view.item.state).toBe("answered");
    expect(first.replayed).toBe(false);
    const again = (await caps.reply(zapier, { ...reply, idempotency_key: "evt_1" })) as typeof first;
    expect(again.replayed).toBe(true);
    expect(again.view.item.version).toBe(first.view.item.version);
    // Another reply under that key is still another request.
    await expect(
      caps.reply(zapier, { ...reply, body: "Something else", idempotency_key: "evt_1" }),
    ).rejects.toMatchObject({ code: "idempotency_mismatch" });
    // A reply on the answered message (no transition) replays too, and the thread has each reply once.
    const note = { ...reply, body: "We have a slot on Thursday.", idempotency_key: "evt_2" };
    expect(await caps.reply(zapier, note)).not.toHaveProperty("replayed");
    expect(await caps.reply(zapier, note)).toMatchObject({ replayed: true });
    const detail = await caps.getItem(owner, { item_id: id });
    expect(detail.thread.filter((t) => t.direction === "out").map((t) => t.body)).toEqual([
      "Thank you: we will answer today.",
      "We have a slot on Thursday.",
    ]);
  });
});

describe("attribution", () => {
  it("names who caused each event in the history, the stream and its meta", async () => {
    const { db, caps } = await setup();
    const created = await caps.createBooking(
      {
        actor: { kind: "customer_agent", id: "anon:1", channel: "mcp_public" },
        tier: "anonymous",
        sandbox: false,
        now: () => T0,
      },
      {
        payload: {
          reservationFor: { serviceId: await serviceId(caps), name: "Trim" },
          startTime: "2026-09-24T09:00:00Z",
          endTime: "2026-09-24T09:30:00Z",
        },
        contact: { name: "Rita" },
      },
    );
    const itemId = created.view.item.id;
    await caps.transitionItem(zapier, { item_id: itemId, event: "confirm" });
    const detail = await caps.getItem(owner, { item_id: itemId });
    expect(detail.events.map((e) => e.by)).toEqual([
      { kind: "customer_agent", id: null },
      { kind: "integration", id: "key_zap", name: "Zapier" },
    ]);
    expect(detail.events.map((e) => e.channel)).toEqual(["mcp_public", "rest"]);

    const webhooks = new WebhookCapabilities(db, null, undefined, undefined, 0);
    const page = await webhooks.listEvents(owner, { limit: 50 });
    const confirm = page.events.find((e) => e.type === "booking.confirm");
    expect(confirm?.data).toMatchObject({
      actor: { kind: "integration", id: "key_zap", name: "Zapier" },
      channel: "rest",
      sandbox: false,
    });
  });
});

describe("webhook headers", () => {
  it("seals the values, lists only the names, merges changes, and sends them with a test delivery", async () => {
    const { db } = await setup();
    const box = createSecretBox([KEY]);
    const sent: Headers[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      sent.push(new Headers(init?.headers));
      return new Response(null, { status: 204 });
    };
    const hooks = new WebhookCapabilities(db, box, fetchImpl);
    const w = await hooks.createWebhook(owner, {
      url: "https://hooks.example.com/n8n",
      events: ["*"],
      payload_style: "thin",
      headers: { Authorization: "Bearer n8n-token", "X-Source": "inbox" },
    });
    expect(w.headers).toEqual(["Authorization", "X-Source"]);
    const { rows } = await db.client.query({ sql: "SELECT headers_enc, header_names FROM webhooks", method: "all" });
    expect(String(rows[0]?.[0])).not.toContain("n8n-token");
    expect(JSON.stringify(await hooks.listWebhooks(owner))).not.toContain("n8n-token");

    const updated = await hooks.updateWebhook(owner, {
      webhook_id: w.id,
      headers: { "x-source": null, "X-Tenant": "shop-1" },
    });
    expect(updated.headers).toEqual(["Authorization", "X-Tenant"]);

    const test = await hooks.sendTestEvent(owner, { webhook_id: w.id });
    expect(test.delivered).toBe(true);
    expect(sent[0]?.get("authorization")).toBe("Bearer n8n-token");
    expect(sent[0]?.get("x-tenant")).toBe("shop-1");
    expect(sent[0]?.get("x-source")).toBeNull();
    expect(sent[0]?.get("webhook-signature")).toMatch(/^v1,/);
    expect(test.event.data.actor).toEqual({ kind: "owner", id: "user_1" });

    await expect(
      hooks.updateWebhook(owner, {
        webhook_id: w.id,
        headers: { A1: "1", A2: "2", A3: "3", A4: "4" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

async function serviceId(caps: Capabilities): Promise<string> {
  const s = await caps.setup.createService(owner, {
    name: "Trim",
    duration_min: 30,
    buffer_before_min: 0,
    buffer_after_min: 0,
    capacity: 1,
    granularity_min: 15,
    active: true,
    sort: 0,
  });
  return s.id;
}

async function hashOf(op: string, input: unknown): Promise<string> {
  const { hashJson } = await import("../src/util/canonical");
  return hashJson({ op, input });
}
