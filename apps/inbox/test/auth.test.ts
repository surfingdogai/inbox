import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { pkceChallenge } from "@surfingdog/adapters";
import { logMailOut, type MailOut, type OutboundMail } from "@surfingdog/platform";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const app = createApp({ db, mailOut: mail, ownerEmails: ["tiago@oficinamare.pt"] });
    const stranger0 = await app.request(`${ORIGIN}/auth/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "first@example.com" }),
    });
    expect(stranger0.status).toBeLessThan(500);
    expect(mail.sent).toHaveLength(0); // an empty instance does not hand itself to the first click
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

describe("the sign-in link on an instance deployed with one click", () => {
  const OWNER = "owner@oficinamare.pt";
  const ask = (app: App, email = OWNER) =>
    app.request(`${ORIGIN}/auth/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
  const logged = () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    return () => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("/auth/verify?token="));
  };
  afterEach(() => vi.restoreAllMocks());

  it("goes out from the mail service's own address (MAIL_FROM), never from localhost", async () => {
    const sent: OutboundMail[] = [];
    const mailOut: MailOut = {
      sender: { address: "inbox@oficinamare.pt" },
      async send(m) {
        sent.push(m);
        return { messageId: "m-1" };
      },
    };
    const app = createApp({ db: await freshDb(), mailOut, ownerEmails: [OWNER] });
    expect((await ask(app)).status).toBe(200);
    expect(sent.map((m) => m.from.address)).toEqual(["inbox@oficinamare.pt"]);
  });

  it("is written to the server's log when the email cannot be sent, and that link signs the owner in", async () => {
    const lines = logged();
    const mailOut: MailOut = {
      sender: { address: "inbox@not-onboarded.example" },
      async send() {
        throw new Error("E_SENDER_NOT_VERIFIED: sender domain not verified");
      },
    };
    const app = createApp({ db: await freshDb(), mailOut, ownerEmails: [OWNER] });
    const res = await ask(app);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "mail_failed", detail: expect.stringContaining("log") });
    const [line] = lines();
    expect(line).toContain("E_SENDER_NOT_VERIFIED");
    expect(line).toContain(OWNER);
    const link = /https:\/\/\S+\/auth\/verify\?token=\S+/.exec(line ?? "")?.[0];
    if (!link) throw new Error("no link in the log");
    const verify = await app.request(link);
    expect(verify.status).toBe(200);
    expect(await verify.json()).toMatchObject({ ok: true, user: { email: OWNER, role: "owner" } });
  });

  it("is written to the log when there is no address to send from, and the answer is the same as for anyone", async () => {
    const lines = logged();
    const sent: OutboundMail[] = [];
    const mailOut: MailOut = {
      async send(m) {
        sent.push(m);
        return { messageId: "m-1" };
      },
    };
    const app = createApp({ db: await freshDb(), mailOut, ownerEmails: [OWNER] });
    const owner = await ask(app);
    const stranger = await ask(app, "mallory@example.com");
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual(await stranger.json());
    expect(sent).toEqual([]);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("MAIL_FROM");
  });

  it("keeps the https address the owner first signed in at as the Inbox address", async () => {
    const mail = logMailOut();
    const app = createApp({ db: await freshDb(), mailOut: mail, ownerEmails: [OWNER] });
    const cookie = await signIn(app, mail, OWNER);
    const read = await app.request(`${ORIGIN}/v1/owner/settings`, { headers: { cookie } });
    const doc = ((await read.json()) as { doc: { notifications: { appUrl?: string } } }).doc;
    expect(doc.notifications.appUrl).toBe(ORIGIN);

    // With INBOX_PUBLIC_URL the host already knows its address, and Settings is left alone.
    const fixed = logMailOut();
    const pinned = createApp({
      db: await freshDb(),
      mailOut: fixed,
      ownerEmails: [OWNER],
      baseUrl: "https://inbox.oficinamare.pt",
    });
    const cookie2 = await signIn(pinned, fixed, OWNER);
    const read2 = await pinned.request("https://inbox.oficinamare.pt/v1/owner/settings", {
      headers: { cookie: cookie2 },
    });
    const doc2 = ((await read2.json()) as { doc: { notifications: { appUrl?: string } } }).doc;
    expect(doc2.notifications.appUrl).toBeUndefined();
  });

  it("says in the log why nobody got a link while no one has signed in yet, and stops once someone has", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const said = () => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("INBOX_OWNER_EMAIL"));
    const mail = logMailOut();
    const app = createApp({ db: await freshDb(), mailOut: mail, ownerEmails: [OWNER] });
    // A typo in the value typed into the deploy form: the owner would otherwise wait for nothing.
    const typo = await ask(app, "0wner@oficinamare.pt");
    const stranger = await ask(app, "mallory@example.com");
    expect(await typo.json()).toEqual(await stranger.json());
    expect(mail.sent).toEqual([]);
    expect(said()).toHaveLength(2);
    expect(said()[0]).toContain("not in INBOX_OWNER_EMAIL");
    // Whoever asked stays out of the log: on a public demo, which has no account, it is a stranger.
    expect(said().join("\n")).not.toMatch(/0wner@|mallory@|token=/);

    await signIn(app, mail, OWNER);
    spy.mockClear();
    expect((await ask(app, "mallory@example.com")).status).toBe(200);
    expect(said()).toEqual([]);

    // Nothing set at all: the log says that, too.
    const empty = createApp({ db: await freshDb(), mailOut: logMailOut() });
    spy.mockClear();
    expect((await ask(empty)).status).toBe(200);
    expect(said()).toHaveLength(1);
    expect(said()[0]).toMatch(/INBOX_OWNER_EMAIL is empty/);
  });
});

describe("where a sign-in link lands afterwards", () => {
  const OWNER = "owner@oficinamare.pt";
  // Browsers read `/\host` and `/<tab>/host` as `//host`: another site, not a path on this one.
  it.each(["/\\evil.example", "/\t/evil.example", "//evil.example", "https://evil.example/"])(
    "stays on this site when the link asks for %j",
    async (redirect) => {
      const mail = logMailOut();
      const app = createApp({ db: await freshDb(), mailOut: mail, ownerEmails: [OWNER] });
      const ask = await app.request(`${ORIGIN}/auth/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: OWNER, redirect }),
      });
      expect(ask.status).toBe(200);
      const link = /https?:\/\/\S+/.exec(mail.sent.at(-1)?.text ?? "")?.[0];
      if (!link) throw new Error("no link mailed");
      const res = await app.request(link, { headers: { accept: "text/html" } });
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location") ?? "", ORIGIN).origin).toBe(ORIGIN);
    },
  );

  it("keeps a path on this site as it was", async () => {
    const mail = logMailOut();
    const app = createApp({ db: await freshDb(), mailOut: mail, ownerEmails: [OWNER] });
    await app.request(`${ORIGIN}/auth/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: OWNER, redirect: "/items/01J?tab=timeline#reply" }),
    });
    const link = /https?:\/\/\S+/.exec(mail.sent.at(-1)?.text ?? "")?.[0];
    if (!link) throw new Error("no link mailed");
    const res = await app.request(link, { headers: { accept: "text/html" } });
    expect(res.headers.get("location")).toBe("/items/01J?tab=timeline#reply");
  });
});

describe("OAuth 2.1 for the owner MCP", () => {
  it("advertises discovery, registers a client, runs the code flow with PKCE, and refreshes with rotation", async () => {
    const db = await freshDb();
    const mail = logMailOut();
    const app = createApp({ db, mailOut: mail, ownerEmails: ["tiago@oficinamare.pt"] });
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
      ownerEmails: ["tiago@oficinamare.pt"],
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
