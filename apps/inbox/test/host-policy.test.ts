import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey, hashKey } from "@surfingdog/adapters";
import { type Db, hostPolicyFor, readSettings, schema, ulid } from "@surfingdog/core";
import {
  type CloudflareEmailBinding,
  type CustomerMailKind,
  cloudflareEmailMailOut,
  type MailOut,
  pinnedMailOut,
} from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { type App, createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * An inbox run under a host's policy, through its doors. Before any site links to it: the owner
 * with a full owner key, a key with settings:write and the owner's AI cannot switch a network on,
 * list the inbox, or change the sender, Reply-To, the Inbox address, private targets or extra
 * authorities; every email goes from the sender the host pinned, whatever Settings held before; and
 * a customer is sent nothing automatic. Runs on Node and in workerd.
 */
const ADDRESS = "https://oficina-mare.example.net";
const PIN = { address: "oficina-mare@mail.example.net", name: "Oficina Maré" };
const SECRET_KEY = "5c0e7b1a9d3f48e2a6c1b7d04f9e3a21";
const T0 = Date.parse("2026-10-12T10:00:00Z");

/** No site links to the inbox yet. */
const L1 = hostPolicyFor({ address: ADDRESS, site: null });

/** What a person at the business does in person goes to a customer; nothing automatic does. */
const personOnly = (kind: CustomerMailKind) => kind === "person";

async function setup() {
  const db = await freshDb();
  // Before the host held anything, the owner had set a sender, a name and a Reply-To of their own.
  await createInbox({ db }).caps.updateSettings(
    { actor: { kind: "owner", id: "u1", channel: "owner_ui" }, tier: "verified_principal", sandbox: false },
    {
      doc: {
        business: { name: "Oficina Maré" },
        notifications: { ownerEmail: "owner@oficinamare.pt" },
        email: { fromAddress: "owner@personal.example", fromName: "Someone else", replyTo: "reply@personal.example" },
      },
    },
  );
  const seen: Parameters<CloudflareEmailBinding["send"]>[0][] = [];
  const binding: CloudflareEmailBinding = {
    async send(m) {
      seen.push(m);
      return { messageId: `m-${seen.length}` };
    },
  };
  const mailOut: MailOut = {
    ...pinnedMailOut(cloudflareEmailMailOut(binding), { from: PIN }),
    allowCustomerMail: personOnly,
  };
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    baseUrl: ADDRESS,
    secretKey: SECRET_KEY,
    mailOut,
    policy: L1,
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
  });
  const ownerKey = (await createApiKey(db, { kind: "owner", name: "cli" })).key;
  const zapierKey = (
    await createApiKey(db, { kind: "integration", name: "Zapier", scopes: ["settings:read", "settings:write"] })
  ).key;
  const drain = async () => {
    await Promise.allSettled(pending.splice(0));
    const later = Date.now() + 10 * 60_000;
    for (let i = 0; i < 20; i++)
      if ((await inbox.runner.runDue(db, { workerId: "t", now: later })).claimed === 0) break;
  };
  return { db, app: inbox.app, inbox, seen, ownerKey, zapierKey, drain };
}

const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ADDRESS}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** An OAuth access token for an AI app called Claude, granted every settings scope. */
async function claudeToken(db: Db): Promise<string> {
  const token = `sdi_at_${ulid()}${ulid()}`;
  await db.orm
    .insert(schema.oauthClients)
    .values({
      id: "client_claude",
      name: "Claude",
      redirectUris: ["https://claude.ai/cb"],
      kind: "cimd",
      createdAt: T0,
    })
    .onConflictDoNothing();
  await db.orm.insert(schema.oauthTokens).values({
    tokenHash: await hashKey(token),
    kind: "access",
    clientId: "client_claude",
    userId: "user_1",
    scope: "inbox:read inbox:write settings:read settings:write offline_access",
    familyId: ulid(),
    expiresAt: Date.now() + 3_600_000,
    createdAt: T0,
  });
  return token;
}

async function connectOwner(app: App, bearer: string) {
  const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const merged = new Headers(init?.headers);
    merged.set("authorization", `Bearer ${bearer}`);
    return app.request(String(input), { ...init, headers: merged });
  };
  const client = new Client({ name: "claude", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ADDRESS}/mcp/owner`), { fetch: fetchLike }));
  return client;
}

/** Every change the policy holds: networks, the listing, the sender, Reply-To, the address, trust. */
const HELD: Record<string, unknown>[] = [
  { networks: { "https://network.surfingdog.ai": { enabled: true } } },
  { networks: { "https://people.example.org": { enabled: true } } },
  { directory: { listed: true } },
  { email: { fromAddress: "someone@personal.example" } },
  { email: { replyTo: "someone@personal.example" } },
  { notifications: { appUrl: "https://evil.example" } },
  { integrations: { webhooks: { allowPrivateTargets: true } } },
  { identity: { extraAuthorities: ["evil.example"] } },
];

describe("an inbox under a host's policy", () => {
  it("is unlisted and calls no network from its first request", async () => {
    const { db, app } = await setup();
    const manifest = (await (await app.request(req("GET", "/.well-known/agent-inbox.json"))).json()) as {
      directory?: { listed?: boolean };
    };
    expect(manifest.directory?.listed).toBe(false);
    const s = await readSettings(db);
    expect(s.notifications.appUrl).toBe(ADDRESS);
    expect(Object.values(s.networks).every((n) => !n.enabled)).toBe(true);
  });

  it("refuses what the host holds from the owner's key and a settings:write key, saying it is set by the host", async () => {
    const { db, app, ownerKey, zapierKey } = await setup();
    for (const key of [ownerKey, zapierKey]) {
      const auth = { authorization: `Bearer ${key}` };
      const read = (await (await app.request(req("GET", "/v1/owner/settings", undefined, auth))).json()) as {
        locked: string[];
      };
      expect(read.locked).toEqual(expect.arrayContaining(["email", "networks", "directory.listed"]));
      for (const doc of HELD) {
        const res = await app.request(req("PUT", "/v1/owner/settings", { doc }, auth));
        const text = await res.text();
        expect(res.status, `${JSON.stringify(doc)}: ${text}`).toBe(403);
        expect(text).toContain("set by your host");
      }
    }
    const s = await readSettings(db);
    expect(s.directory.listed).toBe(false);
    expect(s.notifications.appUrl).toBe(ADDRESS);
    expect(s.integrations.webhooks.allowPrivateTargets).toBe(false);
    expect(s.identity.extraAuthorities).toEqual([]);
    expect(Object.values(s.networks).every((n) => !n.enabled)).toBe(true);
    // Nor does the profile name a domain the host has not seen link to the inbox.
    for (const key of [ownerKey, zapierKey]) {
      const res = await app.request(
        req("PUT", "/v1/owner/profile", { domain: "nhs.uk" }, { authorization: `Bearer ${key}` }),
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("set by your host");
    }
    expect(await (await app.request(req("GET", "/v1/business"))).json()).toMatchObject({ domain: null });
    // What the host does not hold is still the owner's.
    const ok = await app.request(
      req(
        "PUT",
        "/v1/owner/settings",
        { doc: { booking: { cancellationWindowMin: 90 } } },
        { authorization: `Bearer ${ownerKey}` },
      ),
    );
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  it("refuses the same from the owner's AI, which is told nobody can change it", async () => {
    const { db, app } = await setup();
    const claude = await connectOwner(app, await claudeToken(db));
    for (const doc of HELD) {
      const r = await claude.callTool({ name: "update_settings", arguments: { doc } });
      expect(r.isError, JSON.stringify(doc)).toBe(true);
      expect((r.content as { text: string }[])[0]?.text).toContain("set by your host");
    }
    await claude.close();
    expect((await readSettings(db)).directory.listed).toBe(false);
  });

  it("sends every email from the pinned sender, and a customer nothing automatic", async () => {
    const { app, seen, ownerKey, drain } = await setup();
    const created = await app.request(
      req("POST", "/v1/quotes", {
        payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel" },
        contact: { name: "Rita", email: "rita@example.com" },
      }),
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { view: { item: { id: string } } }).view.item.id;
    await drain();
    // The owner hears of it; the customer gets no acknowledgement.
    expect(seen.map((m) => m.to)).toEqual([["owner@oficinamare.pt"]]);
    // The owner answers in person: that goes.
    const replied = await app.request(
      req(
        "POST",
        `/v1/owner/items/${id}/replies`,
        { body: "We can do it on Thursday." },
        { authorization: `Bearer ${ownerKey}` },
      ),
    );
    expect(replied.status, await replied.clone().text()).toBe(200);
    await drain();
    expect(seen.map((m) => m.to)).toEqual([["owner@oficinamare.pt"], ["rita@example.com"]]);
    for (const mail of seen) {
      expect(mail.from).toEqual({ email: PIN.address, name: PIN.name });
      expect(mail.replyTo).toBeUndefined();
      expect(JSON.stringify(mail)).not.toContain("personal.example");
    }
  });
});
