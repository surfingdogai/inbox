import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ulid } from "@surfingdog/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ControlPlane } from "../src/control-plane";
import { CachedResolver } from "../src/resolver";
import { NonceCache, SKEW_SECONDS, signature, signHeaders, verifySigned } from "../src/sign";
import { socketRequest } from "../src/sockets";
import type { ResolveAnswer } from "../src/types";
import { ADMIN_KEY, newSlug, OWNER, PARENT, policyOf, type Runtime, SHARD_KEY, salon, startRuntime } from "./harness";

/** The admin API (C8.1), signed calls (C8.0), and the resolver's cache (C1.3). */

describe("signed calls (C8.0)", () => {
  const key = "k".repeat(40);
  const body = new TextEncoder().encode('{"a":1}');
  const req = (h: Record<string, string>, b = body, target = "/admin/v1/health?x=1") => ({
    method: "POST",
    target,
    headers: { get: (n: string) => h[n] ?? null },
    body: b,
  });

  it("signs byte for byte as the other side does, with the configured string as the key", () => {
    // Fixed vectors: whoever calls this API keeps the same ones in its own tests.
    const vectorKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const nonce = "00112233445566778899aabbccddeeff";
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(
      signature(vectorKey, "GET", "/internal/v1/resolve?host=inbox.salon.example", "1760346000", nonce, enc("")),
    ).toBe("v1=81cf3fb585a641548f716452a5e0c62c72700fb3208038670014368a99d5f7b2");
    expect(
      signature(
        vectorKey,
        "PUT",
        "/internal/v1/hosted-hosts/inbox.salon.example",
        "1760346000",
        nonce,
        enc('{"domain":"salon.example"}'),
      ),
    ).toBe("v1=b5e77f5ed811709d4ade4b5da8c2f1d4cf89eba4e00c3a241883bae36f25098b");
  });

  it("takes a request signed over its method, target, time, nonce and body, once", () => {
    const nonces = new NonceCache();
    const now = Date.now();
    const h = signHeaders(key, "POST", "/admin/v1/health?x=1", body, now);
    expect(verifySigned(key, nonces, req(h), now)).toEqual({ ok: true });
    expect(verifySigned(key, nonces, req(h), now)).toEqual({ ok: false, why: "replayed" });
  });

  it("refuses another body, target, key, an old time, and a missing header; a forged one burns no nonce", () => {
    const now = Date.now();
    const nonces = new NonceCache();
    const h = signHeaders(key, "POST", "/admin/v1/health?x=1", body, now);
    expect(verifySigned(key, nonces, req(h, new TextEncoder().encode("{}")), now).ok).toBe(false);
    expect(verifySigned(key, nonces, req(h, body, "/admin/v1/health"), now).ok).toBe(false);
    expect(verifySigned("x".repeat(40), nonces, req(h), now).ok).toBe(false);
    expect(verifySigned(key, nonces, req(h), now + (SKEW_SECONDS + 2) * 1000)).toEqual({ ok: false, why: "stale" });
    expect(verifySigned(key, nonces, req({ ...h, "x-sd-sig": "" }), now)).toEqual({ ok: false, why: "unsigned" });
    // None of the refusals above spent the nonce.
    expect(verifySigned(key, nonces, req(h), now)).toEqual({ ok: true });
  });

  it("names the exact bytes it signs, so another implementation can match them", async () => {
    const { createHash, createHmac } = await import("node:crypto");
    const h = signHeaders(key, "get", "/internal/v1/resolve?host=a.example.com", new Uint8Array(), 1_791_000_000_000);
    const material = `GET\n/internal/v1/resolve?host=a.example.com\n1791000000\n${h["x-sd-nonce"]}\n${createHash("sha256").update("").digest("hex")}`;
    expect(h["x-sd-sig"]).toBe(`v1=${createHmac("sha256", key).update(material).digest("hex")}`);
  });
});

describe("the resolver's cache (C1.3)", () => {
  const answer = (host: string): ResolveAnswer => ({
    resolved: {
      tenantId: "tn_01J00000000000000000000000",
      kind: "slug",
      state: "setup",
      prevState: null,
      level: 1,
      slugHost: host,
      ownHost: null,
      canonicalHost: host,
      agents: "closed",
      policyVersion: 1,
      shard: 0,
      ttlSeconds: 30,
    },
    policy: null,
    jwks: null,
  });

  it("keeps a tenant for its TTL, no tenant for 10 s, asks once for many, and drops what it is told to", async () => {
    let clock = 1_000_000;
    let asked = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const cp: ControlPlane = {
      async resolve(host) {
        asked++;
        await gate;
        return host.startsWith("quiet") ? { answer: answer(host), ttlSeconds: 30 } : { answer: null, ttlSeconds: 10 };
      },
      policy: async () => {
        throw new Error("unused");
      },
      event: async () => {},
    };
    const r = new CachedResolver({ controlPlane: cp, parent: PARENT, now: () => clock });
    const host = `quiet-otter-7k2m.${PARENT}`;
    const many = Promise.all([r.resolve(host), r.resolve(host), r.resolve(host)]);
    release();
    expect((await many).every((x) => x?.tenantId === "tn_01J00000000000000000000000")).toBe(true);
    expect(asked).toBe(1);
    clock += 29_000;
    await r.resolve(host);
    expect(asked).toBe(1);
    clock += 2_000;
    await r.resolve(host);
    expect(asked).toBe(2);
    r.invalidate([host]);
    await r.resolve(host);
    expect(asked).toBe(3);
    expect(await r.resolve("inbox.nobody.example.org")).toBeNull();
    await r.resolve("inbox.nobody.example.org");
    expect(asked).toBe(4);
    clock += 10_001;
    await r.resolve("inbox.nobody.example.org");
    expect(asked).toBe(5);
    expect(await r.resolve(`www.${PARENT}`)).toBeNull();
    expect(asked).toBe(5);
  });
});

let rt: Runtime;
beforeAll(async () => {
  rt = await startRuntime();
});
afterAll(async () => {
  await rt.close();
});

describe("the admin API (C8.1)", () => {
  it("refuses a call that is not signed, is replayed, or is signed with the other direction's key", async () => {
    const socket = join(rt.dir, "a.sock");
    const target = "/admin/v1/health";
    expect((await socketRequest(socket, { method: "GET", target })).status).toBe(401);
    const headers = signHeaders(ADMIN_KEY, "GET", target);
    expect((await socketRequest(socket, { method: "GET", target, headers })).status).toBe(200);
    expect((await socketRequest(socket, { method: "GET", target, headers })).status).toBe(401);
    const other = signHeaders("test-cp-key-0123456789abcdef0123456789abcd", "GET", target);
    expect((await socketRequest(socket, { method: "GET", target, headers: other })).status).toBe(401);
    // A shard's own admin socket checks the signature too, with the shards' key: the control
    // plane's admin key, which no shard holds, is refused there.
    const shardAdmin = join(rt.dir, "s0a.sock");
    expect((await socketRequest(shardAdmin, { method: "GET", target })).status).toBe(401);
    const asControlPlane = signHeaders(ADMIN_KEY, "GET", target);
    expect((await socketRequest(shardAdmin, { method: "GET", target, headers: asControlPlane })).status).toBe(401);
    const asRouter = signHeaders(SHARD_KEY, "GET", target);
    expect((await socketRequest(shardAdmin, { method: "GET", target, headers: asRouter })).status).toBe(200);
    // And the router takes nothing signed with the shards' key.
    const fromShard = signHeaders(SHARD_KEY, "GET", target);
    expect((await socketRequest(socket, { method: "GET", target, headers: fromShard })).status).toBe(401);
  });

  it("creates a tenant once: the same call again is 200, another slug for it is 409", async () => {
    const id = `tn_${ulid()}`;
    const slug = `${newSlug()}.${PARENT}`;
    const t = {
      tenantId: id,
      slugHost: slug,
      ownHost: null,
      ownResolves: false,
      state: "setup" as const,
      prevState: null,
      version: 1,
      domain: "salaorosa.pt",
      jwks: null,
    };
    const body = { tenant_id: id, slug_host: slug, policy: policyOf(t) };
    const first = await rt.admin("POST", "/admin/v1/tenants", body);
    expect(first.status).toBe(201);
    expect((first.body as { shard: number }).shard).toBe(rt.shards.indexOf(rt.shardOf(t)));
    expect((await rt.admin("POST", "/admin/v1/tenants", body)).status).toBe(200);
    const other = await rt.admin("POST", "/admin/v1/tenants", { ...body, slug_host: `${newSlug()}.${PARENT}` });
    expect(other.status).toBe(409);
    expect((other.body as { code: string }).code).toBe("slug_mismatch");
    const bad = await rt.admin("POST", "/admin/v1/tenants", { ...body, slug_host: `www.${PARENT}` });
    expect(bad.status).toBe(422);
    expect((await rt.admin("GET", `/admin/v1/tenants/tn_${ulid()}/usage`)).status).toBe(404);
  });

  it("checks a plan before any inbox exists, naming what to fix", async () => {
    expect((await rt.admin("POST", "/admin/v1/plans/validate", salon)).body).toEqual({ ok: true });
    const bad = await rt.admin("POST", "/admin/v1/plans/validate", { ...salon, products: [{ name: "x" }] });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toContain("products");
    const tz = await rt.admin("POST", "/admin/v1/plans/validate", {
      profile: { name: "x", timezone: "Mars/Olympus" },
    });
    expect(tz.status).toBe(422);
  });

  it("applies a plan (a dry run changes nothing), tests the doors as an agent and keeps one example", async () => {
    const t = await rt.createTenant({ plan: null });
    const dry = await rt.admin("POST", `/admin/v1/tenants/${t.tenantId}/plan?dry_run=1`, salon);
    expect(dry.status).toBe(200);
    expect((dry.body as { dry_run: boolean; changed: boolean }).changed).toBe(true);
    const applied = await rt.admin("POST", `/admin/v1/tenants/${t.tenantId}/plan?dry_run=0`, salon);
    expect((applied.body as { doors: { on: string[] } }).doors.on).toEqual(
      expect.arrayContaining(["message", "quote_request", "booking"]),
    );
    const again = await rt.admin("POST", `/admin/v1/tenants/${t.tenantId}/plan?dry_run=0`, salon);
    expect((again.body as { changed: boolean }).changed).toBe(false);
    const probe = await rt.admin("POST", `/admin/v1/tenants/${t.tenantId}/probe`, {
      doors: ["booking", "quote_request", "message"],
    });
    expect(probe.status).toBe(200);
    const results = (probe.body as { results: { door: string; ok: boolean; detail: string }[] }).results;
    expect(results.map((r) => [r.door, r.ok, r.detail])).toEqual([
      ["booking", true, "passed"],
      ["quote_request", true, "passed"],
      ["message", true, "passed"],
    ]);
    // The doors stay shut to everyone else: the test ran in the shard.
    expect((await rt.http(t.slugHost, "GET", "/v1/services")).status).toBe(404);
    const archived = await rt.admin("POST", `/admin/v1/tenants/${t.tenantId}/sandbox/archive`, { keep: "example" });
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ archived: 2 });
    const kept = (archived.body as { kept_id: string }).kept_id;
    const cookie = await rt.signIn(t, t.slugHost);
    const items = await rt.http(t.slugHost, "GET", "/v1/owner/items?sandbox=true", { headers: { cookie } });
    const all = (items.json as { items: { item: { id: string; type: string } }[] }).items.map((i) => i.item);
    expect(all.find((i) => i.id === kept)?.type).toBe("booking");
    const db = new DatabaseSync(rt.shardOf(t).dbPath(t.tenantId), { readOnly: true });
    const flags = db.prepare("SELECT type, flags FROM items ORDER BY type").all() as { type: string; flags: string }[];
    db.close();
    expect(
      flags.map((f) => [f.type, JSON.parse(f.flags).archived ?? false, JSON.parse(f.flags).example ?? false]),
    ).toEqual([
      ["booking", false, true],
      ["message", true, false],
      ["quote_request", true, false],
    ]);
    const none = await rt.admin("POST", `/admin/v1/tenants/${t.tenantId}/sandbox/archive`, { keep: "none" });
    expect(none.body).toEqual({ archived: 1, kept_id: null });
    // Nobody was written to: the tests were tests, and no customer is written to below level 2.
    expect(rt.mail.filter((m) => !m.mail.to.includes(OWNER))).toEqual([]);
  });

  it("refuses a policy older than the one in place, and builds the inbox again on a newer one", async () => {
    const t = await rt.createTenant();
    const stale = await rt.admin("PUT", `/admin/v1/tenants/${t.tenantId}/policy`, {
      ...policyOf(t),
      policy_version: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "stale_version", policy_version: t.version });
    const other = await rt.admin("PUT", `/admin/v1/tenants/${t.tenantId}/policy`, {
      ...policyOf(t),
      tenant_id: `tn_${ulid()}`,
    });
    expect(other.status).toBe(422);
    const same = await rt.admin("PUT", `/admin/v1/tenants/${t.tenantId}/policy`, policyOf(t));
    expect(same.body).toEqual({ policy_version: t.version });
  });

  it("makes a handoff for the owner at the canonical origin only", async () => {
    const t = await rt.createTenant();
    const wrong = await rt.admin("POST", `/admin/v1/tenants/${t.tenantId}/handoff`, {
      email: OWNER,
      origin: `https://${t.ownHost}`,
    });
    expect(wrong.status).toBe(409);
    const stranger = await rt.admin("POST", `/admin/v1/tenants/${t.tenantId}/handoff`, {
      email: "someone@else.example",
      origin: `https://${t.slugHost}`,
    });
    expect(stranger.status).toBe(409);
    expect((stranger.body as { code: string }).code).toBe("not_owner");
    const ok = await rt.admin("POST", `/admin/v1/tenants/${t.tenantId}/handoff`, {
      email: OWNER,
      origin: `https://${t.slugHost}`,
    });
    expect(ok.status).toBe(200);
    const body = ok.body as { url: string; expires_at: string };
    expect(body.url.startsWith(`https://${t.slugHost}/auth/handoff?token=`)).toBe(true);
    expect(Date.parse(body.expires_at) - Date.now()).toBeLessThanOrEqual(60_000);
    // A GET on it changes nothing: the page asks for a POST.
    const token = new URL(body.url).searchParams.get("token") ?? "";
    const page = await rt.http(t.slugHost, "GET", `/auth/handoff?token=${token}`);
    expect(page.status).toBe(200);
    expect(page.headers["set-cookie"]).toBeUndefined();
  });

  it("counts a month's usage: items, agent items, confirmed items, mail and the file's size; test items never", async () => {
    const t = await rt.createTenant();
    await rt.admin("POST", `/admin/v1/tenants/${t.tenantId}/probe`, { doors: ["message", "booking"] });
    await rt.setState(t, "live", { ownResolves: true });
    const sent = await rt.http(t.ownHost ?? "", "POST", "/v1/messages", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Do you cut curly hair?", contact: { name: "Rita" } }),
    });
    expect(sent.status).toBe(201);
    const month = new Date().toISOString().slice(0, 7);
    const usage = await rt.admin("GET", `/admin/v1/tenants/${t.tenantId}/usage?month=${month}`);
    expect(usage.status).toBe(200);
    expect(usage.body).toMatchObject({ items: 1, agent_items: 1, confirmed_items: 0 });
    expect((usage.body as { db_bytes: number }).db_bytes).toBeGreaterThan(0);
    expect((await rt.admin("GET", `/admin/v1/tenants/${t.tenantId}/usage?month=2026-13`)).status).toBe(422);
    const last = await rt.admin("GET", `/admin/v1/tenants/${t.tenantId}/usage?month=2020-01`);
    expect(last.body).toMatchObject({ items: 0, agent_items: 0, confirmed_items: 0, mail_sent: 0 });
    // The first real item an agent made is told to the control plane, once.
    await rt.shardOf(t).tick();
    expect(rt.cp.events.filter((e) => e.tenant_id === t.tenantId && e.type === "first_agent_item")).toHaveLength(1);
  });

  it("deletes only a closed inbox, its file gone, its public keys handed back", async () => {
    const t = await rt.createTenant();
    const early = await rt.admin("DELETE", `/admin/v1/tenants/${t.tenantId}`);
    expect(early.status).toBe(409);
    await rt.setState(t, "closing");
    await rt.setState(t, "closed");
    const shard = rt.shardOf(t);
    expect(existsSync(shard.dbPath(t.tenantId))).toBe(true);
    const done = await rt.admin("DELETE", `/admin/v1/tenants/${t.tenantId}`);
    expect(done.status).toBe(200);
    expect(Array.isArray((done.body as { jwks: { keys: unknown[] } }).jwks.keys)).toBe(true);
    expect(existsSync(shard.dbPath(t.tenantId))).toBe(false);
    expect((await rt.admin("DELETE", `/admin/v1/tenants/${t.tenantId}`)).status).toBe(404);
  });

  it("counts for its health, and drops cached hosts when told", async () => {
    const health = await rt.admin("GET", "/admin/v1/health");
    expect(health.status).toBe(200);
    const h = health.body as { shards: { up: boolean; tenants: number }[] };
    expect(h.shards).toHaveLength(2);
    expect(h.shards.every((s) => s.up && typeof s.tenants === "number")).toBe(true);
    expect(JSON.stringify(h)).not.toMatch(/tn_|@/);
    expect((await rt.admin("POST", "/admin/v1/cache/invalidate", { hosts: "x" })).status).toBe(422);
  });
});
