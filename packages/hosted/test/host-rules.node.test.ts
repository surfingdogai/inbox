import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DOOR_PREFIXES, isDoor } from "@surfingdog/inbox/doors";
import { describe, expect, it } from "vitest";
import { isOwnerPage, OWNER_PAGES, ownerVerdict, readOnlyAllows } from "../src/allowlist";
import { readConfig, shardAdminSocket, shardSocket } from "../src/config";
import { classifyHost, fnv1a32, normalizeHost, shardOf } from "../src/host";
import { decide } from "../src/rules";
import { levelOf, normalizePolicy, parseResolveAnswer, type Resolved, type TenantState } from "../src/types";
import { policyOf } from "./harness";

describe("host names (C1.2, C1.3)", () => {
  it("normalises a Host header and refuses what is not a DNS name", () => {
    expect(normalizeHost("Quiet-Otter-7K2M.Example.NET.")).toBe("quiet-otter-7k2m.example.net");
    expect(normalizeHost("inbox.example.com:443")).toBe("inbox.example.com");
    for (const bad of [
      "",
      "127.0.0.1",
      "10.0.0.1:80",
      "[::1]",
      "[2001:db8::1]:443",
      "under_score.example.com",
      "-lead.example.com",
      "trail-.example.com",
      "a..b.example.com",
      "inbox.example.com:http",
      `${"a".repeat(64)}.example.com`,
      `${"a.".repeat(127)}com`,
      "café.example.com",
    ]) {
      expect(normalizeHost(bad), bad).toBeNull();
    }
  });

  it("knows a slug host, an own host, and the names that are never a tenant", () => {
    const parent = "example.net";
    expect(classifyHost("quiet-otter-7k2m.example.net", parent)).toEqual({
      kind: "slug",
      host: "quiet-otter-7k2m.example.net",
    });
    expect(classifyHost("inbox.salaorosa.pt", parent)).toEqual({ kind: "own", host: "inbox.salaorosa.pt" });
    for (const none of [
      "example.net",
      "www.example.net",
      "app.example.net",
      "k7m2qxpa.hosted.example.net",
      "quiet-otter-7k2m.hosted.example.net",
      "quiet-otter-7k21.example.net",
      "quiet-otter.example.net",
      "a.quiet-otter-7k2m.example.net",
      "localhost",
    ]) {
      expect(classifyHost(none, parent).kind, none).toBe("none");
    }
  });

  it("places a tenant on a shard by FNV-1a", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 400; i++) {
      const shard = shardOf(`tn_01J${String(i).padStart(23, "0")}`, 4);
      counts[shard] = (counts[shard] ?? 0) + 1;
    }
    for (const c of counts) expect(c).toBeGreaterThan(50);
  });
});

describe("the owner allowlist (C1.4)", () => {
  const cookie = "__Host-sdi_session=abc";

  it("refuses every door the inbox has, but sign-in and the owner's own API, so a new door is refused by default", () => {
    for (const prefix of DOOR_PREFIXES) {
      for (const path of [prefix, `${prefix}/a-door-added-later`]) {
        for (const method of ["GET", "POST"]) {
          const verdict = ownerVerdict({ method, path, cookie });
          const allowed = path.startsWith("/auth/");
          expect(verdict, `${method} ${path}`).toBe(allowed ? "allow" : "refuse");
        }
      }
    }
    expect(ownerVerdict({ method: "GET", path: "/v1/owner/items", cookie })).toBe("allow");
    expect(ownerVerdict({ method: "POST", path: "/v1/owner/download", cookie })).toBe("allow");
  });

  it("refuses each agent path the spec names", () => {
    for (const path of [
      "/v1/bookings",
      "/v1/email/inbound",
      "/v1/owner",
      "/mcp",
      "/mcp/owner",
      "/oauth/authorize",
      "/oauth/token",
      "/openapi.json",
      "/.well-known/agent-inbox.json",
      "/.well-known/jwks.json",
      "/.well-known/security.txt",
      "/c/token",
      "/p/message",
      "/demo/live",
      "/healthz",
    ]) {
      for (const method of ["GET", "POST"]) expect(ownerVerdict({ method, path, cookie }), path).toBe("refuse");
    }
  });

  it("takes the owner's API with a session cookie and no Authorization header only", () => {
    expect(ownerVerdict({ method: "GET", path: "/v1/owner/items" })).toBe("refuse");
    expect(ownerVerdict({ method: "GET", path: "/v1/owner/items", cookie: "sdi_session=x" })).toBe("allow");
    expect(ownerVerdict({ method: "GET", path: "/v1/owner/items", cookie, authorization: "Bearer sdi_own_x" })).toBe(
      "refuse",
    );
    expect(ownerVerdict({ method: "GET", path: "/v1/owner/items", cookie: "other=1; sdi_session=" })).toBe("refuse");
  });

  it("shows the app at / to a session cookie and the neutral page to anyone else; pages are read only", () => {
    expect(ownerVerdict({ method: "GET", path: "/", cookie })).toBe("allow");
    expect(ownerVerdict({ method: "GET", path: "/" })).toBe("neutral");
    expect(ownerVerdict({ method: "POST", path: "/" })).toBe("refuse");
    expect(ownerVerdict({ method: "POST", path: "/settings" })).toBe("refuse");
    expect(ownerVerdict({ method: "GET", path: "/assets/" })).toBe("refuse");
    expect(ownerVerdict({ method: "GET", path: "/items/" })).toBe("refuse");
    expect(ownerVerdict({ method: "HEAD", path: "/assets/index-abc.js" })).toBe("allow");
  });

  it("allows every page of the owner app as it is built, and none of them is a door", () => {
    const routes = fileURLToPath(new URL("../../../apps/inbox/client/src/routes", import.meta.url));
    const files = readdirSync(routes).filter((f) => f.endsWith(".tsx") && !f.startsWith("__root"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      // TanStack's file names: dots are slashes, `_layout.` segments are not in the URL, `$id` is a parameter.
      const path = `/${file
        .replace(/\.tsx$/, "")
        .split(".")
        .filter((part) => !part.startsWith("_") && part !== "index")
        .map((part) => (part.startsWith("$") ? "x" : part))
        .join("/")}`;
      expect(ownerVerdict({ method: "GET", path, cookie }), `${file} → ${path}`).toBe("allow");
      expect(isDoor(path), path).toBe(false);
    }
    for (const page of OWNER_PAGES) expect(isDoor(page), page).toBe(false);
  });

  it("lets a read-only inbox be read, signed in to and downloaded, nothing else", () => {
    expect(readOnlyAllows("GET", "/v1/owner/items")).toBe(true);
    expect(readOnlyAllows("POST", "/auth/magic-link")).toBe(true);
    expect(readOnlyAllows("POST", "/v1/owner/download")).toBe(true);
    expect(readOnlyAllows("POST", "/v1/messages")).toBe(false);
    expect(readOnlyAllows("PUT", "/v1/owner/settings")).toBe(false);
    expect(readOnlyAllows("DELETE", "/v1/owner/items/x")).toBe(false);
    expect(isOwnerPage("/settings/keys")).toBe(true);
  });
});

const base = (o: Partial<Resolved> & { state: TenantState; kind: "slug" | "own" }): Resolved => {
  const prevState = o.prevState ?? null;
  const level = levelOf(o.state, prevState);
  return {
    tenantId: "tn_01J00000000000000000000000",
    prevState,
    level,
    slugHost: "quiet-otter-7k2m.example.net",
    ownHost: "inbox.salaorosa.pt",
    canonicalHost: level === 2 ? "inbox.salaorosa.pt" : "quiet-otter-7k2m.example.net",
    agents: o.state === "live" ? "open" : "closed",
    policyVersion: 1,
    shard: 0,
    ttlSeconds: 60,
    ...o,
  };
};
const req = (method: string, path: string, o: { cookie?: string; search?: string } = {}) => ({
  method,
  path,
  search: o.search ?? "",
  cookie: o.cookie,
});

describe("the host rules (C1.4)", () => {
  it("slug host below level 2: owner only, read-only while closing", () => {
    for (const state of ["setup", "dns_pending", "cert_pending"] as const) {
      const r = base({ kind: "slug", state });
      expect(decide(r, req("GET", "/.well-known/agent-inbox.json")).kind).toBe("not_found");
      expect(decide(r, req("GET", "/"))).toEqual({ kind: "neutral" });
      expect(decide(r, req("GET", "/settings"))).toEqual({ kind: "proxy", readOnly: false });
    }
    const closing = base({ kind: "slug", state: "closing", prevState: "dns_pending" });
    expect(decide(closing, req("GET", "/settings"))).toEqual({ kind: "proxy", readOnly: true });
    expect(decide(closing, req("PUT", "/v1/owner/settings", { cookie: "sdi_session=a" }))).toEqual({
      kind: "locked",
      why: "read_only",
    });
    const suspended = base({ kind: "slug", state: "suspended", prevState: "setup" });
    expect(decide(suspended, req("GET", "/v1/business")).kind).toBe("not_found");
    expect(decide(suspended, req("GET", "/login")).kind).toBe("proxy");
  });

  it("slug host at level 2: the owner's pages go to the own host (308), everything else is 404 with where it is", () => {
    for (const r of [
      base({ kind: "slug", state: "live" }),
      base({ kind: "slug", state: "suspended", prevState: "live" }),
      base({ kind: "slug", state: "closing", prevState: "live" }),
    ]) {
      expect(decide(r, req("GET", "/settings/keys", { search: "?a=1" }))).toEqual({
        kind: "redirect",
        location: "https://inbox.salaorosa.pt/settings/keys?a=1",
      });
      expect(decide(r, req("HEAD", "/"))).toEqual({ kind: "redirect", location: "https://inbox.salaorosa.pt/" });
      for (const [m, p] of [
        ["POST", "/settings"],
        ["GET", "/auth/handoff"],
        ["GET", "/v1/owner/items"],
        ["GET", "/.well-known/agent-inbox.json"],
        ["POST", "/mcp"],
      ] as const) {
        expect(decide(r, req(m, p, { cookie: "sdi_session=a" })), `${m} ${p}`).toEqual({
          kind: "not_found",
          movedTo: "https://inbox.salaorosa.pt",
        });
      }
    }
  });

  it("own host: a guard while the certificate is issued, everything when live, owner only after the record is lost", () => {
    expect(decide(base({ kind: "own", state: "cert_pending" }), req("GET", "/")).kind).toBe("connecting");
    expect(decide(base({ kind: "own", state: "live" }), req("POST", "/mcp"))).toEqual({
      kind: "proxy",
      readOnly: false,
    });
    const lost = base({ kind: "own", state: "dns_pending" });
    expect(decide(lost, req("GET", "/.well-known/agent-inbox.json")).kind).toBe("not_found");
    expect(decide(lost, req("GET", "/")).kind).toBe("neutral");
  });

  it("own host suspended from live: agents 423, the owner's allowlist passes", () => {
    const r = base({ kind: "own", state: "suspended", prevState: "live" });
    expect(decide(r, req("POST", "/v1/bookings"))).toEqual({ kind: "locked", why: "suspended" });
    expect(decide(r, req("GET", "/"))).toEqual({ kind: "locked", why: "suspended" });
    expect(decide(r, req("GET", "/login")).kind).toBe("proxy");
    expect(decide(r, req("GET", "/v1/owner/items", { cookie: "sdi_session=a" })).kind).toBe("proxy");
  });

  it("own host closing from live: reads and the manifest, no writes", () => {
    const r = base({ kind: "own", state: "closing", prevState: "live" });
    expect(decide(r, req("GET", "/.well-known/agent-inbox.json"))).toEqual({ kind: "proxy", readOnly: true });
    expect(decide(r, req("POST", "/v1/bookings"))).toEqual({ kind: "locked", why: "read_only" });
    expect(decide(r, req("POST", "/auth/magic-link")).kind).toBe("proxy");
  });

  it("closed: 410 everywhere but the own host's public keys", () => {
    expect(decide(base({ kind: "own", state: "closed" }), req("GET", "/.well-known/jwks.json")).kind).toBe("jwks");
    expect(decide(base({ kind: "own", state: "closed" }), req("GET", "/.well-known/agent-inbox.json")).kind).toBe(
      "gone",
    );
    expect(decide(base({ kind: "slug", state: "closed" }), req("GET", "/.well-known/jwks.json")).kind).toBe("gone");
  });
});

describe("what the control plane says, checked", () => {
  const t = {
    tenantId: "tn_01J00000000000000000000000",
    slugHost: "quiet-otter-7k2m.example.net",
    ownHost: "inbox.salaorosa.pt",
    ownResolves: true,
    state: "dns_pending" as TenantState,
    prevState: null,
    version: 3,
    domain: "salaorosa.pt",
    jwks: null,
  };
  const opts = { shards: 4, shardOf: (id: string) => shardOf(id, 4) };

  it("works out level, agents and the canonical host from the state, and takes camelCase too", () => {
    const wire = {
      tenantId: t.tenantId,
      kind: "own",
      state: "live",
      prevState: null,
      slugHost: t.slugHost,
      ownHost: t.ownHost,
      level: 1,
      agents: "closed",
      policyVersion: 9,
      ttlSeconds: 600,
    };
    const a = parseResolveAnswer(t.ownHost, wire, opts);
    expect(a?.resolved).toMatchObject({ level: 2, agents: "open", canonicalHost: t.ownHost, ttlSeconds: 60 });
    expect(a?.resolved.shard).toBe(shardOf(t.tenantId, 4));
  });

  it("is no answer when the host is not the tenant's", () => {
    const wire = { tenant_id: t.tenantId, kind: "slug", state: "setup", slug_host: t.slugHost, policy_version: 1 };
    expect(parseResolveAnswer("brave-heron-abcd.example.net", wire, opts)).toBeNull();
    expect(parseResolveAnswer(t.slugHost, { ...wire, tenant_id: "tn_bad" }, opts)).toBeNull();
    expect(parseResolveAnswer(t.ownHost, { ...wire, kind: "own", own_host: "inbox.other.pt" }, opts)).toBeNull();
    // Level 2 with no own host does not hold together.
    expect(parseResolveAnswer(t.slugHost, { ...wire, state: "live" }, opts)).toBeNull();
  });

  it("never opens doors, names a site or writes to customers below level 2, whatever the payload says", () => {
    const p = { ...policyOf(t), agents: "open" as const, site: "https://salaorosa.pt" };
    p.mail = { ...p.mail, customer_mail: true, customer_daily_cap: 200, reply_to: "owner@salaorosa.pt" };
    const n = normalizePolicy(p);
    expect(n).toMatchObject({ agents: "closed", site: null, level: 1 });
    expect(n.mail).toMatchObject({ customer_mail: false, customer_daily_cap: 0, reply_to: null });
    const closing = normalizePolicy({ ...policyOf({ ...t, state: "closing", prevState: "live" }), read_only: false });
    expect(closing).toMatchObject({ read_only: true, agents: "open", level: 2 });
    expect(normalizePolicy({ ...policyOf({ ...t, state: "live" }), agents: "closed" }).agents).toBe("closed");
  });
});

describe("settings from the environment", () => {
  const env = {
    HOSTED_SLUG_PARENT: "Example.NET",
    HOSTED_ROUTER_SOCKET: "/run/x/router.sock",
    HOSTED_ADMIN_SOCKET: "/run/x/admin.sock",
    HOSTED_CP_SOCKET: "/run/x/cp.sock",
    HOSTED_ADMIN_KEY: "a".repeat(40),
    HOSTED_CP_KEY: "b".repeat(40),
    HOSTED_MASTER_KEY: `${"c".repeat(40)},${"d".repeat(40)}`,
    HOSTED_DATA_DIR: "/var/lib/x",
    HOSTED_SECURITY_CONTACT: "security@example.net",
    HOSTED_ABUSE_CONTACT: "abuse@example.net",
  };

  it("reads them with their defaults, the shards' sockets beside the router's", () => {
    const c = readConfig(env);
    expect(c).toMatchObject({ parent: "example.net", shards: 4, openPerShard: 64, maxTenantBytes: 200 * 1024 * 1024 });
    expect(c.masterKeys).toHaveLength(2);
    expect(shardSocket(c, 3)).toBe("/run/x/shard-3.sock");
    expect(shardAdminSocket(c, 0)).toBe("/run/x/shard-0-admin.sock");
  });

  it("refuses to start on a missing setting, one key for both directions, a short key or a mistyped range", () => {
    expect(() => readConfig({ ...env, HOSTED_SLUG_PARENT: "" })).toThrow(/HOSTED_SLUG_PARENT is not set/);
    expect(() => readConfig({ ...env, HOSTED_CP_KEY: env.HOSTED_ADMIN_KEY })).toThrow(/one key per direction/);
    expect(() => readConfig({ ...env, HOSTED_MASTER_KEY: "short" })).toThrow(/HOSTED_MASTER_KEY/);
    expect(() => readConfig({ ...env, INBOX_OUTBOUND_DENY: "203.0.113.300" })).toThrow(/INBOX_OUTBOUND_DENY/);
    expect(() => readConfig({ ...env, HOSTED_SHARDS: "0" })).toThrow(/HOSTED_SHARDS/);
  });
});
