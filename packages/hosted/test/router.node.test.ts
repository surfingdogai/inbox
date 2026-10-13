import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { namesBusiness, PARENT, type Runtime, startRuntime } from "./harness";

/**
 * The router, end to end over its sockets, with shards behind it and a control plane that holds
 * tenants in memory: a slug host never serves agents in any state (acceptance 7), an own host serves
 * by its tenant's state (C1.4), and the router answers its own pages itself.
 */

/** Every agent path the slug host must refuse, whatever the state. */
const AGENT_PATHS: [string, string][] = [
  ["GET", "/.well-known/agent-inbox.json"],
  ["GET", "/.well-known/jwks.json"],
  ["GET", "/.well-known/oauth-authorization-server"],
  ["GET", "/v1/business"],
  ["GET", "/v1/services"],
  ["POST", "/v1/bookings"],
  ["POST", "/v1/messages"],
  ["POST", "/v1/email/inbound"],
  ["POST", "/mcp"],
  ["POST", "/mcp/owner"],
  ["GET", "/oauth/authorize"],
  ["POST", "/oauth/token"],
  ["GET", "/openapi.json"],
  ["GET", "/c/abc"],
  ["GET", "/p/message"],
  ["GET", "/demo/live"],
  ["GET", "/healthz"],
];

let rt: Runtime;
beforeAll(async () => {
  rt = await startRuntime();
});
afterAll(async () => {
  await rt.close();
});

describe("a slug host below level 2", () => {
  it("never serves an agent path, says noindex on every answer, and names nobody", async () => {
    const t = await rt.createTenant();
    for (const state of ["setup", "dns_pending", "cert_pending"] as const) {
      await rt.setState(t, state);
      for (const [method, path] of AGENT_PATHS) {
        const r = await rt.http(t.slugHost, method, path, {
          headers: { "content-type": "application/json", accept: "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect(r.status, `${state} ${method} ${path}`).toBe(404);
        expect(r.headers["x-robots-tag"]).toBe("noindex, nofollow");
        expect(namesBusiness(r.text)).toBe(false);
      }
      const robots = await rt.http(t.slugHost, "GET", "/robots.txt");
      expect(robots.text).toContain("Disallow: /");
      const home = await rt.http(t.slugHost, "GET", "/", { headers: { accept: "text/html" } });
      expect(home.status).toBe(200);
      expect(home.text).toContain("This inbox is being set up.");
      expect(home.text).toContain('content="noindex, nofollow"');
      expect(namesBusiness(home.text)).toBe(false);
      expect(home.headers["x-robots-tag"]).toBe("noindex, nofollow");
    }
  });

  it("serves the owner app, sign-in and the owner's API with a session, and a forged cookie gets the neutral page", async () => {
    const t = await rt.createTenant();
    const shell = await rt.http(t.slugHost, "GET", "/settings/services");
    expect(shell.status).toBe(200);
    expect(shell.text).toContain("Owner app");
    expect((await rt.http(t.slugHost, "GET", "/assets/app.js")).status).toBe(200);
    expect((await rt.http(t.slugHost, "GET", "/login")).status).toBe(200);
    // A cookie the router cannot judge reaches the shard, which shows the inbox only to a real session.
    const forged = await rt.http(t.slugHost, "GET", "/", { headers: { cookie: "__Host-sdi_session=forged" } });
    expect(forged.text).toContain("This inbox is being set up.");
    const cookie = await rt.signIn(t, t.slugHost);
    const app = await rt.http(t.slugHost, "GET", "/", { headers: { cookie } });
    expect(app.text).toContain("Owner app");
    const me = await rt.http(t.slugHost, "GET", "/auth/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    const services = await rt.http(t.slugHost, "GET", "/v1/owner/services", { headers: { cookie } });
    expect(services.status).toBe(200);
    expect(services.text).toContain("Corte");
    // The owner's API takes the browser's session only: with any Authorization header it is refused.
    const withKey = await rt.http(t.slugHost, "GET", "/v1/owner/services", {
      headers: { cookie, authorization: "Bearer sdi_own_anything" },
    });
    expect(withKey.status).toBe(404);
    expect((await rt.http(t.slugHost, "GET", "/v1/owner/services")).status).toBe(404);
  });

  it("refuses the agent paths at the shard too, with the router out of the way", async () => {
    const t = await rt.createTenant();
    const shard = rt.shards.indexOf(rt.shardOf(t));
    const base = { host: t.slugHost, "x-sd-tenant": t.tenantId, "x-sd-policy-version": String(t.version) };
    for (const kind of ["slug", "own"]) {
      for (const [method, path] of AGENT_PATHS) {
        const r = await rt.direct(
          shard,
          method,
          path,
          { ...base, "x-sd-host-kind": kind, "content-type": "application/json" },
          method === "POST" ? "{}" : undefined,
        );
        expect(r.status, `${kind} ${method} ${path}`).toBe(404);
        expect(namesBusiness(r.text)).toBe(false);
      }
    }
  });
});

describe("going live", () => {
  it("opens the doors at the own host only, and the slug host sends the owner there", async () => {
    const t = await rt.createTenant();
    // The record is seen; the certificate is being issued: a guard, no doors.
    await rt.setState(t, "cert_pending", { ownResolves: true });
    const issuing = await rt.http(t.ownHost ?? "", "GET", "/.well-known/agent-inbox.json");
    expect(issuing.status).toBe(503);
    expect(issuing.headers["retry-after"]).toBeTruthy();
    await rt.setState(t, "live");
    const manifest = await rt.http(t.ownHost ?? "", "GET", "/.well-known/agent-inbox.json");
    expect(manifest.status).toBe(200);
    const m = manifest.json as { instance: string; item_types: string[] };
    expect(m.instance).toBe(`https://${t.ownHost}`);
    expect(m.item_types).toEqual(expect.arrayContaining(["message", "quote_request", "booking"]));
    expect(manifest.headers["x-robots-tag"]).toBeUndefined();
    // The slug host serves no agent, and sends the owner's pages to the own host.
    const slugManifest = await rt.http(t.slugHost, "GET", "/.well-known/agent-inbox.json", {
      headers: { accept: "application/json" },
    });
    expect(slugManifest.status).toBe(404);
    expect(JSON.stringify(slugManifest.json)).toContain(`https://${t.ownHost}`);
    const page = await rt.http(t.slugHost, "GET", "/settings?tab=1");
    expect(page.status).toBe(308);
    expect(page.headers.location).toBe(`https://${t.ownHost}/settings?tab=1`);
    expect((await rt.http(t.slugHost, "GET", "/")).headers.location).toBe(`https://${t.ownHost}/`);
    const post = await rt.http(t.slugHost, "POST", "/auth/magic-link", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com" }),
    });
    expect(post.status).toBe(404);
    // A handoff is made only for the canonical origin, which is now the own host.
    const old = await rt.admin("POST", `/admin/v1/tenants/${t.tenantId}/handoff`, {
      email: "owner@example.com",
      origin: `https://${t.slugHost}`,
    });
    expect(old.status).toBe(409);
    expect((old.body as { code: string }).code).toBe("origin_not_canonical");
    const cookie = await rt.signIn(t, t.ownHost ?? "");
    expect((await rt.http(t.ownHost ?? "", "GET", "/v1/owner/services", { headers: { cookie } })).status).toBe(200);
  });

  it("closes the doors again when the record is lost for good, and owner-only is back at the own host", async () => {
    const t = await rt.createTenant();
    await rt.setState(t, "live", { ownResolves: true });
    expect((await rt.http(t.ownHost ?? "", "GET", "/v1/business")).status).toBe(200);
    await rt.setState(t, "dns_pending", { ownResolves: true });
    expect((await rt.http(t.ownHost ?? "", "GET", "/v1/business")).status).toBe(404);
    expect((await rt.http(t.ownHost ?? "", "GET", "/.well-known/agent-inbox.json")).status).toBe(404);
    const home = await rt.http(t.ownHost ?? "", "GET", "/", { headers: { accept: "text/html" } });
    expect(home.text).toContain("This inbox is being set up.");
  });
});

describe("suspended, closing and closed", () => {
  it("suspended from live: agents get 423, the owner still signs in", async () => {
    const t = await rt.createTenant();
    await rt.setState(t, "live", { ownResolves: true });
    await rt.setState(t, "suspended");
    const r = await rt.http(t.ownHost ?? "", "POST", "/v1/messages", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hello" }),
    });
    expect(r.status).toBe(423);
    expect((await rt.http(t.ownHost ?? "", "GET", "/.well-known/agent-inbox.json")).status).toBe(423);
    expect((await rt.http(t.ownHost ?? "", "GET", "/login")).status).toBe(200);
    const cookie = await rt.signIn(t, t.ownHost ?? "");
    expect((await rt.http(t.ownHost ?? "", "GET", "/auth/me", { headers: { cookie } })).status).toBe(200);
  });

  it("closing from live: read-only, the manifest still served, writes 423", async () => {
    const t = await rt.createTenant();
    await rt.setState(t, "live", { ownResolves: true });
    const cookie = await rt.signIn(t, t.ownHost ?? "");
    await rt.setState(t, "closing");
    const kept = await rt.http(t.ownHost ?? "", "GET", "/.well-known/agent-inbox.json");
    expect(kept.status, kept.text).toBe(200);
    const write = await rt.http(t.ownHost ?? "", "POST", "/v1/messages", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hello" }),
    });
    expect(write.status).toBe(423);
    const ownerWrite = await rt.http(t.ownHost ?? "", "PUT", "/v1/owner/settings", {
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ doc: { business: { name: "Other" } } }),
    });
    expect(ownerWrite.status).toBe(423);
    // Signing in still works while it closes.
    const ask = await rt.http(t.ownHost ?? "", "POST", "/auth/magic-link", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com" }),
    });
    expect(ask.status).toBeLessThan(400);
  });

  it("closed: 410 for the manifest and everything else, while the public keys keep serving", async () => {
    const t = await rt.createTenant();
    await rt.setState(t, "live", { ownResolves: true });
    const jwks = await rt.admin("GET", `/admin/v1/tenants/${t.tenantId}/jwks`);
    expect(jwks.status).toBe(200);
    await rt.setState(t, "closing");
    await rt.setState(t, "closed");
    // While it is not closed the file cannot be deleted; once closed, its keys come back with the delete.
    const removed = await rt.admin("DELETE", `/admin/v1/tenants/${t.tenantId}`);
    expect(removed.status).toBe(200);
    t.jwks = (removed.body as { jwks: { keys: Record<string, unknown>[] } }).jwks;
    await rt.admin("POST", "/admin/v1/cache/invalidate", { hosts: [t.ownHost, t.slugHost] });
    expect((await rt.http(t.ownHost ?? "", "GET", "/.well-known/agent-inbox.json")).status).toBe(410);
    expect((await rt.http(t.ownHost ?? "", "GET", "/v1/business")).status).toBe(410);
    const keys = await rt.http(t.ownHost ?? "", "GET", "/.well-known/jwks.json");
    expect(keys.status).toBe(200);
    expect(keys.json).toEqual(t.jwks);
    expect((await rt.http(t.slugHost, "GET", "/")).status).toBe(410);
  });
});

describe("what the router answers itself", () => {
  it("security.txt and the report page on both hosts, naming nobody", async () => {
    const t = await rt.createTenant();
    await rt.setState(t, "live", { ownResolves: true });
    for (const host of [t.slugHost, t.ownHost ?? ""]) {
      const sec = await rt.http(host, "GET", "/.well-known/security.txt");
      expect(sec.status).toBe(200);
      expect(sec.text).toContain("Contact: mailto:security@example.net");
      expect(sec.text).toContain(`Canonical: https://${host}/.well-known/security.txt`);
      const report = await rt.http(host, "GET", "/report-inbox");
      expect(report.status).toBe(200);
      expect(report.text).toContain("abuse@example.net");
      expect(namesBusiness(report.text)).toBe(false);
    }
  });

  it("400 for a Host that is not a name, 404 for names that are no tenant, and never /internal or /admin", async () => {
    const t = await rt.createTenant();
    await rt.setState(t, "live", { ownResolves: true });
    expect((await rt.http("127.0.0.1", "GET", "/")).status).toBe(400);
    expect((await rt.http("[::1]:443", "GET", "/")).status).toBe(400);
    expect((await rt.http("bad_name.example.com", "GET", "/")).status).toBe(400);
    const before = rt.cp.resolves;
    // The parent, a CNAME target, and a name under the parent that is not a slug are never asked about.
    for (const host of [PARENT, `k7m2qxpa.hosted.${PARENT}`, `www.${PARENT}`, `app.${PARENT}`]) {
      expect((await rt.http(host, "GET", "/")).status, host).toBe(404);
    }
    expect(rt.cp.resolves).toBe(before);
    expect((await rt.http("nobody.example.org", "GET", "/")).status).toBe(404);
    for (const path of ["/internal/v1/resolve?host=x", "/admin/v1/health"]) {
      expect((await rt.http(t.ownHost ?? "", "GET", path)).status).toBe(404);
    }
  });

  it("sets the tenant itself: an X-SD header from outside reaches nobody", async () => {
    const a = await rt.createTenant();
    const b = await rt.createTenant();
    await rt.setState(a, "live", { ownResolves: true });
    await rt.setState(b, "live", { ownResolves: true });
    const r = await rt.http(a.ownHost ?? "", "GET", "/.well-known/agent-inbox.json", {
      headers: { "x-sd-tenant": b.tenantId, "x-sd-host-kind": "own", "x-sd-policy-version": "999" },
    });
    expect(r.status).toBe(200);
    expect((r.json as { instance: string }).instance).toBe(`https://${a.ownHost}`);
  });

  it("resolves dot segments before it judges a path, and passes on the path it judged", async () => {
    const t = await rt.createTenant();
    for (const path of ["/assets/../v1/business", "/auth/%2e%2e/mcp", "/settings/../.well-known/agent-inbox.json"]) {
      const r = await rt.http(t.slugHost, "GET", path, { headers: { accept: "application/json" } });
      expect(r.status, path).toBe(404);
    }
  });

  it("answers 503, never a stale tenant, when the control plane cannot be reached", async () => {
    const t = await rt.createTenant();
    rt.resolver.invalidate([t.slugHost]);
    rt.cp.down = true;
    try {
      expect((await rt.http(t.slugHost, "GET", "/")).status).toBe(503);
    } finally {
      rt.cp.down = false;
    }
    expect((await rt.http(t.slugHost, "GET", "/")).status).toBe(200);
  });
});
