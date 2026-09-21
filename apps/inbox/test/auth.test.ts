import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { pkceChallenge } from "@surfingdog/adapters";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { type App, createApp } from "../src/app";
import { freshDb } from "./harness";

const ORIGIN = "https://inbox.test";

async function signIn(app: App, mail: ReturnType<typeof logMailOut>, email: string): Promise<string> {
  const ask = await app.request(`${ORIGIN}/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(ask.status).toBe(200);
  const link = /https?:\/\/\S+/.exec(mail.sent.at(-1)?.text ?? "")?.[0];
  if (!link) throw new Error("no link mailed");
  const verify = await app.request(link);
  expect(verify.status).toBe(200);
  const cookie = verify.headers.get("set-cookie") ?? "";
  const token = /sdi_session=([^;]+)/.exec(cookie)?.[1];
  if (!token) throw new Error("no session cookie");
  return `sdi_session=${token}`;
}

describe("owner sign-in", () => {
  it("bootstraps the first owner by magic link, then only known addresses get links", async () => {
    const db = await freshDb();
    const mail = logMailOut();
    const app = createApp({ db, mailOut: mail });
    const cookie = await signIn(app, mail, "tiago@oficinamare.pt");
    const me = await app.request(`${ORIGIN}/auth/me`, { headers: { cookie } });
    expect(await me.json()).toMatchObject({ email: "tiago@oficinamare.pt", role: "owner" });

    const stranger = await app.request(`${ORIGIN}/auth/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "mallory@example.com" }),
    });
    expect(stranger.status).toBe(200); // same answer either way
    expect(mail.sent.map((m) => m.to[0])).toEqual(["tiago@oficinamare.pt"]);

    // A session drives the owner API, but only from our own origin.
    const denied = await app.request(`${ORIGIN}/v1/owner/settings`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", origin: "https://evil.test" },
      body: JSON.stringify({ doc: {} }),
    });
    expect(denied.status).toBe(403);
    const ok = await app.request(`${ORIGIN}/v1/owner/settings`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ doc: { business: { name: "Oficina Maré" } } }),
    });
    expect(ok.status).toBe(200);
    const read = await app.request(`${ORIGIN}/v1/owner/settings`, { headers: { cookie } });
    expect(((await read.json()) as { doc: { business: { name: string } } }).doc.business.name).toBe("Oficina Maré");

    const out = await app.request(`${ORIGIN}/auth/logout`, { method: "POST", headers: { cookie } });
    expect(out.status).toBe(200);
    expect((await app.request(`${ORIGIN}/auth/me`, { headers: { cookie } })).status).toBe(401);
  });
});

describe("OAuth 2.1 for the owner MCP", () => {
  it("advertises discovery, registers a client, runs the code flow with PKCE, and refreshes with rotation", async () => {
    const db = await freshDb();
    const mail = logMailOut();
    const app = createApp({ db, mailOut: mail });
    const cookie = await signIn(app, mail, "tiago@oficinamare.pt");

    const challenge401 = await app.request(`${ORIGIN}/mcp/owner`, { method: "POST" });
    expect(challenge401.status).toBe(401);
    expect(challenge401.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/owner"`,
    );
    const prm = (await (await app.request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/owner`)).json()) as {
      authorization_servers: string[];
    };
    expect(prm.authorization_servers).toEqual([ORIGIN]);
    const as = (await (await app.request(`${ORIGIN}/.well-known/oauth-authorization-server`)).json()) as {
      code_challenge_methods_supported: string[];
      client_id_metadata_document_supported: boolean;
    };
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.client_id_metadata_document_supported).toBe(true);

    const reg = await app.request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };

    const verifier = "v".repeat(43);
    const params = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      scope: "inbox:read inbox:write offline_access",
      state: "xyz",
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
      resource: `${ORIGIN}/mcp/owner`,
    });
    const anon = await app.request(`${ORIGIN}/oauth/authorize?${params}`);
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toContain("/login?redirect=");
    const consent = await app.request(`${ORIGIN}/oauth/authorize?${params}`, { headers: { cookie } });
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain("Allow Claude to work your inbox?");

    const form = new URLSearchParams({ ...Object.fromEntries(params), decision: "allow" });
    const decided = await app.request(`${ORIGIN}/oauth/authorize/decision`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(decided.status).toBe(302);
    const back = new URL(decided.headers.get("location") ?? "");
    expect(back.searchParams.get("state")).toBe("xyz");
    expect(back.searchParams.get("iss")).toBe(ORIGIN);
    const code = back.searchParams.get("code") ?? "";

    const badPkce = await app.request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_verifier: "w".repeat(43),
      }).toString(),
    });
    expect(badPkce.status).toBe(400);
    const token = await app.request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.status).toBe(200);
    const tokens = (await token.json()) as { access_token: string; refresh_token: string; scope: string };
    expect(tokens.scope).toBe("inbox:read inbox:write offline_access");

    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp/owner`), {
      fetch: async (input, init) => {
        const h = new Headers(init?.headers);
        h.set("authorization", `Bearer ${tokens.access_token}`);
        return app.request(String(input), { ...init, headers: h });
      },
    });
    const client = new Client({ name: "claude", version: "0" });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("list_items");

    const refreshed = await app.request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }),
    });
    expect(refreshed.status).toBe(200);
    const reuse = await app.request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }),
    });
    expect(reuse.status).toBe(400);
    const second = (await refreshed.json()) as { access_token: string };
    const afterReuse = await app.request(`${ORIGIN}/mcp/owner`, {
      method: "POST",
      headers: { authorization: `Bearer ${second.access_token}` },
    });
    expect(afterReuse.status).toBe(401); // the family was revoked on reuse
  });

  it("accepts a Client ID Metadata Document as the client", async () => {
    const db = await freshDb();
    const mail = logMailOut();
    const app = createApp({
      db,
      mailOut: mail,
      fetchClientMetadata: async (url) =>
        url === "https://claude.ai/oauth/claude-code-client-metadata"
          ? { client_id: url, client_name: "Claude Code", redirect_uris: ["http://localhost/callback"] }
          : null,
    });
    const cookie = await signIn(app, mail, "tiago@oficinamare.pt");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "https://claude.ai/oauth/claude-code-client-metadata",
      redirect_uri: "http://localhost/callback",
      code_challenge: await pkceChallenge("v".repeat(43)),
      code_challenge_method: "S256",
    });
    const consent = await app.request(`${ORIGIN}/oauth/authorize?${params}`, { headers: { cookie } });
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain("Claude Code");
    const unknown = await app.request(
      `${ORIGIN}/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(params), client_id: "https://nobody.example/meta" })}`,
      { headers: { cookie } },
    );
    expect(unknown.status).toBe(400);
  });
});
