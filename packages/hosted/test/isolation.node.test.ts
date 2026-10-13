import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createApiKey, hashKey } from "@surfingdog/adapters";
import { createDb, ulid } from "@surfingdog/core";
import { nodeSqliteClient } from "@surfingdog/platform/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ControlPlane } from "../src/control-plane";
import { shardOf } from "../src/host";
import { tenantSecretKey } from "../src/keys";
import { Ledger } from "../src/ledger";
import { CachedResolver } from "../src/resolver";
import { createRouter } from "../src/router";
import { closeServer, listenSocket, socketRequest } from "../src/sockets";
import { PARENT, type Runtime, startRuntime } from "./harness";

/**
 * Isolation (acceptance 11): one inbox's cookie, key or AI app's token is nothing to another; a
 * stalled shard holds up only its own inboxes; a shard whose loop is stuck ends, and the inbox that
 * stuck it is put into maintenance after three times in an hour; jobs run only for inboxes with one
 * due; and no more inboxes are open at once than the cap.
 */

let rt: Runtime;
beforeAll(async () => {
  rt = await startRuntime({ maxOpen: 2 });
});
afterAll(async () => {
  await rt.close();
});

/** Mints an owner key and an AI app's access token in one inbox's own file, as its owner would. */
async function credentialsOf(path: string): Promise<{ key: string; token: string }> {
  const client = nodeSqliteClient(path);
  try {
    const db = createDb(client);
    const { key } = await createApiKey(db, { kind: "owner", name: "test" });
    const user = (await db.client.query({ sql: "SELECT id FROM users LIMIT 1", params: [], method: "all" })).rows[0];
    const token = `sdi_at_${ulid().toLowerCase()}${ulid().toLowerCase()}`;
    await db.client.query({
      sql: `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, family_id, expires_at, created_at)
            VALUES (?, 'access', 'https://app.example.org/client.json', ?, 'items:read', ?, ?, ?)`,
      params: [await hashKey(token), String(user?.[0]), ulid(), Date.now() + 3_600_000, Date.now()],
      method: "run",
    });
    return { key, token };
  } finally {
    client.close();
  }
}

describe("one inbox's credentials are nothing to another", () => {
  it("refuses tenant A's session, owner key and AI app's token at tenant B", async () => {
    const a = await rt.createTenant();
    const b = await rt.createTenant();
    await rt.setState(a, "live", { ownResolves: true });
    await rt.setState(b, "live", { ownResolves: true });
    const cookieA = await rt.signIn(a, a.ownHost ?? "");
    await rt.signIn(b, b.ownHost ?? "");
    const { key, token } = await credentialsOf(rt.shardOf(a).dbPath(a.tenantId));
    const at = (host: string | null, headers: Record<string, string>, path = "/v1/owner/items") =>
      rt.http(host ?? "", "GET", path, { headers: { accept: "application/json", ...headers } });
    // Each works where it was made.
    expect((await at(a.ownHost, { cookie: cookieA })).status).toBe(200);
    expect((await at(a.ownHost, { authorization: `Bearer ${key}` })).status).toBe(200);
    expect((await at(a.ownHost, { authorization: `Bearer ${token}` })).status).toBe(200);
    // And nowhere else.
    expect((await at(b.ownHost, { cookie: cookieA })).status).toBe(401);
    expect((await at(b.ownHost, { cookie: cookieA }, "/auth/me")).status).toBe(401);
    expect((await at(b.ownHost, { authorization: `Bearer ${key}` })).status).toBe(401);
    expect((await at(b.ownHost, { authorization: `Bearer ${token}` })).status).toBe(401);
    const mcp = await rt.http(b.ownHost ?? "", "POST", "/mcp/owner", {
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(401);
    // A's session is A's slug host's too, in name only: the slug host serves no key and no token.
    expect((await at(a.slugHost, { authorization: `Bearer ${key}` })).status).toBe(404);
  });

  it("derives each inbox's own secret key, the same every time, none shared", () => {
    const one = tenantSecretKey(["master-a".repeat(5)], "tn_01J00000000000000000000001");
    expect(tenantSecretKey(["master-a".repeat(5)], "tn_01J00000000000000000000001")).toBe(one);
    expect(tenantSecretKey(["master-a".repeat(5)], "tn_01J00000000000000000000002")).not.toBe(one);
    expect(one.length).toBeGreaterThanOrEqual(43);
    const rotated = tenantSecretKey(["master-b".repeat(5), "master-a".repeat(5)], "tn_01J00000000000000000000001");
    expect(rotated.split(",")).toHaveLength(2);
    expect(rotated.split(",")[1]).toBe(one);
  });
});

describe("a stalled shard holds up its own inboxes only", () => {
  it("answers the other shard's inboxes at their usual speed while one shard never answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdh-"));
    const fast: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    const stuck: Server = createServer(() => {
      // Never answers.
    });
    await listenSocket(fast, join(dir, "f.sock"), 0o600);
    await listenSocket(stuck, join(dir, "x.sock"), 0o600);
    // Two tenants, one on each shard.
    let onFast = "";
    let onStuck = "";
    while (!onFast || !onStuck) {
      const id = `tn_${ulid()}`;
      if (shardOf(id, 2) === 0 && !onFast) onFast = id;
      if (shardOf(id, 2) === 1 && !onStuck) onStuck = id;
    }
    const host = (id: string) => (id === onFast ? `brave-heron-aaaa.${PARENT}` : `misty-finch-bbbb.${PARENT}`);
    const cp: ControlPlane = {
      async resolve(h) {
        const id = h === host(onFast) ? onFast : onStuck;
        return {
          answer: {
            resolved: {
              tenantId: id,
              kind: "slug",
              state: "dns_pending",
              prevState: null,
              level: 1,
              slugHost: h,
              ownHost: null,
              canonicalHost: h,
              agents: "closed",
              policyVersion: 1,
              shard: shardOf(id, 2),
              ttlSeconds: 60,
            },
            policy: null,
            jwks: null,
          },
          ttlSeconds: 60,
        };
      },
      policy: async () => {
        throw new Error("unused");
      },
      event: async () => {},
    };
    const router = createRouter({
      parent: PARENT,
      resolver: new CachedResolver({ controlPlane: cp, parent: PARENT }),
      shards: 2,
      shardSocket: (n) => join(dir, n === 0 ? "f.sock" : "x.sock"),
      shardAdminSocket: () => join(dir, "none.sock"),
      securityContact: "security@example.net",
      abuseContact: "abuse@example.net",
      adminKey: "k".repeat(40),
      shardTimeoutMs: 2_000,
      log: () => {},
    });
    const front = createServer(router.handle);
    await listenSocket(front, join(dir, "r.sock"), 0o600);
    try {
      const ask = (id: string) =>
        socketRequest(join(dir, "r.sock"), {
          method: "GET",
          target: "/settings",
          headers: { host: host(id) },
          timeoutMs: 10_000,
        });
      const stalled = Array.from({ length: 20 }, () => ask(onStuck));
      const times: number[] = [];
      for (let i = 0; i < 40; i++) {
        const t0 = performance.now();
        expect((await ask(onFast)).status).toBe(200);
        times.push(performance.now() - t0);
      }
      times.sort((x, y) => x - y);
      expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(250);
      // The stalled shard's own inboxes get a 503 once it has had its time.
      for (const r of await Promise.all(stalled)) expect(r.status).toBe(503);
    } finally {
      await closeServer(front);
      await closeServer(fast);
      await closeServer(stuck);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the watchdog", () => {
  it("ends a shard whose loop is stuck, and records the inbox that was running", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdh-"));
    try {
      const ledgerPath = join(dir, "ledger.db");
      new Ledger(ledgerPath, { hashKey: "k" }).close();
      const watchdog = fileURLToPath(new URL("../src/watchdog.ts", import.meta.url));
      const script = join(dir, "stuck.mjs");
      writeFileSync(
        script,
        `import { startWatchdog } from ${JSON.stringify(watchdog)};
const w = startWatchdog({ thresholdMs: 300, ledgerPath: ${JSON.stringify(ledgerPath)} });
w.setCurrent("tn_01J00000000000000000000009");
setTimeout(() => { const end = Date.now() + 20000; while (Date.now() < end) {} console.log("still running"); }, 100);
`,
      );
      const started = Date.now();
      const run = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 15_000 });
      expect(run.signal).toBe("SIGKILL");
      expect(run.stdout).not.toContain("still running");
      expect(Date.now() - started).toBeLessThan(10_000);
      const db = new DatabaseSync(ledgerPath, { readOnly: true });
      const rows = db.prepare("SELECT tenant_id FROM blames").all() as { tenant_id: string }[];
      db.close();
      expect(rows.map((r) => r.tenant_id)).toEqual(["tn_01J00000000000000000000009"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("puts an inbox that stuck its shard three times in an hour into maintenance when the shard starts again", async () => {
    const t = await rt.createTenant();
    const other = await rt.createTenant();
    const shard = rt.shardOf(t);
    for (let i = 0; i < 3; i++) rt.ledger.blame(t.tenantId, Date.now() - i * 60_000);
    await shard.start();
    const r = await rt.http(t.slugHost, "GET", "/login");
    expect(r.status).toBe(503);
    expect((await rt.http(other.slugHost, "GET", "/login")).status).toBe(200);
    await shard.tick();
    const events = rt.cp.events.filter((e) => e.tenant_id === t.tenantId);
    expect(events.filter((e) => e.type === "blamed")).toHaveLength(3);
    expect(events.filter((e) => e.type === "maintenance")).toHaveLength(1);
    rt.ledger.clearMaintenance(t.tenantId);
    expect((await rt.http(t.slugHost, "GET", "/login")).status).toBe(200);
  });
});

describe("jobs and open inboxes", () => {
  it("runs jobs only for the inboxes that have one due, and keeps no more open than the cap", async () => {
    const tenants = [await rt.createTenant(), await rt.createTenant(), await rt.createTenant()];
    for (const t of tenants) await rt.setState(t, "live", { ownResolves: true });
    // Everything due now runs once; then nothing is due for a while.
    for (const shard of rt.shards) await shard.tick();
    for (const shard of rt.shards) await shard.tick();
    for (const shard of rt.shards) expect((await shard.tick()).ran).toEqual([]);
    const busy = tenants[0];
    if (!busy) throw new Error("no tenant");
    // A request to one inbox queues its jobs: only that one is opened for them.
    const sent = await rt.http(busy.ownHost ?? "", "POST", "/v1/messages", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Hello", contact: { name: "Rita", email: "rita@example.org" } }),
    });
    expect(sent.status).toBe(201);
    const shard = rt.shardOf(busy);
    shard.due.set(busy.tenantId, Date.now() - 1);
    const ran = (await Promise.all(rt.shards.map((s) => s.tick()))).flatMap((r) => r.ran);
    expect(ran).toEqual([busy.tenantId]);
    for (const s of rt.shards) expect(s.openCount).toBeLessThanOrEqual(2);
  });
});

describe("limits", () => {
  it("refuses new writes past an inbox's size cap, while reading and signing in still work", async () => {
    const small = await startRuntime({ maxTenantBytes: 1 });
    try {
      const t = await small.createTenant();
      await small.setState(t, "live", { ownResolves: true });
      const write = await small.http(t.ownHost ?? "", "POST", "/v1/messages", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "Hello" }),
      });
      expect(write.status).toBe(507);
      expect((await small.http(t.ownHost ?? "", "GET", "/.well-known/agent-inbox.json")).status).toBe(200);
      const cookie = await small.signIn(t, t.ownHost ?? "");
      expect(cookie).toContain("__Host-sdi_session=");
    } finally {
      await small.close();
    }
  });
});
