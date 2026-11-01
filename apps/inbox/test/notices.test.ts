import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey, hashKey, ingestEmail } from "@surfingdog/adapters";
import { type Db, NOTICE_WITHHELD, schema, ulid } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { type App, createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * Notices: emails from systems that answer no conversation, kept for the owner, always. A person at
 * the business reads them under Notices (the owner app, or the owner's own key): out of every other
 * list, alerting nobody. The owner's AI and a key handed to another system learn nothing of them, over
 * REST or the owner MCP, and cannot answer one; the owner moves one to the inbox or deletes it.
 */
const INBOX = "https://inbox.example.com";
const SECRET_KEY = "2f8c1d0a6b4e37925c8f01ad6e3b47f0";
const INBOUND = "oficina-mare@in.example.net";
const T0 = Date.parse("2026-11-01T09:00:00Z");
const DUNS = "D-U-N-S Number is 123456789";

const req = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  new Request(`${INBOX}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const raw = (headers: Record<string, string>, text: string) =>
  `${Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n")}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`;

async function setup() {
  const db = await freshDb();
  const pending: Promise<unknown>[] = [];
  const mailOut = logMailOut();
  const inbox = createInbox({
    db,
    secretKey: SECRET_KEY,
    baseUrl: INBOX,
    mailOut,
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
  });
  const owner = { authorization: `Bearer ${(await createApiKey(db, { kind: "owner", name: "cli" })).key}` };
  const ingest = (message: string) =>
    ingestEmail(db, inbox.caps, { raw: message, envelopeTo: INBOUND, auth: { dmarc: "pass" } }, { now: () => T0 });
  const dnb = await ingest(
    raw(
      {
        From: "D&B <donotreply@iresearch.dnb.com>",
        To: "support@oficinamare.example",
        Subject: "Resolved Inquiry # 11086202 (Case # 11144730)",
        "Message-ID": "<case11144730@iresearch.dnb.com>",
        "Auto-Submitted": "auto-generated",
      },
      `Your inquiry is resolved. Your ${DUNS}.`,
    ),
  );
  const news = await ingest(
    raw(
      {
        From: "Shop News <news@supplier.example>",
        To: "support@oficinamare.example",
        Subject: "October offers",
        "Message-ID": "<n1@supplier.example>",
        "List-Unsubscribe": "<https://supplier.example/u>",
      },
      "Big sale this week.",
    ),
  );
  const customer = await ingest(
    raw(
      {
        From: "Rita Amaral <rita@example.com>",
        To: "support@oficinamare.example",
        Subject: "Wheel rebuild",
        "Message-ID": "<c1@example.com>",
      },
      "Could you rebuild my rear wheel this week?",
    ),
  );
  if (dnb.outcome !== "notice" || news.outcome !== "notice" || customer.outcome !== "created") {
    throw new Error(`not as expected: ${JSON.stringify([dnb, news, customer])}`);
  }
  const drain = async () => {
    await Promise.allSettled(pending.splice(0));
    for (let i = 0; i < 20; i++) if ((await inbox.runner.runDue(db, { workerId: "t" })).claimed === 0) break;
  };
  await drain();
  const [row] = await db.orm.select().from(schema.items).where(eq(schema.items.id, dnb.itemId));
  return {
    db,
    app: inbox.app,
    owner,
    mailOut,
    drain,
    notice: dnb.itemId,
    newsletter: news.itemId,
    other: customer.itemId,
    party: row?.partyId ?? "",
  };
}

async function mintKey(app: App, owner: Record<string, string>, preset: string) {
  const res = await app.request(req("POST", "/v1/owner/api-keys", owner, { name: preset, preset }));
  expect(res.status, await res.clone().text()).toBe(201);
  return { authorization: `Bearer ${((await res.json()) as { key: string }).key}` };
}

/** An OAuth access token for an AI app the owner connected, with every read and write it could ask for. */
async function aiToken(db: Db): Promise<string> {
  const token = `sdi_at_${ulid()}${ulid()}`;
  await db.orm
    .insert(schema.oauthClients)
    .values({
      id: "client_ai",
      name: "An assistant",
      redirectUris: ["https://ai.example/cb"],
      kind: "cimd",
      createdAt: T0,
    })
    .onConflictDoNothing();
  await db.orm.insert(schema.oauthTokens).values({
    tokenHash: await hashKey(token),
    kind: "access",
    clientId: "client_ai",
    userId: "user_1",
    scope: "inbox:read inbox:write events:read settings:read offline_access",
    familyId: ulid(),
    expiresAt: Date.now() + 3_600_000,
    createdAt: T0,
  });
  return token;
}

async function connectOwner(app: App, authorization: string) {
  const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const merged = new Headers(init?.headers);
    merged.set("authorization", authorization);
    return app.request(String(input), { ...init, headers: merged });
  };
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${INBOX}/mcp/owner`), { fetch: fetchLike }));
  return client;
}

const read = async (res: Response) => {
  expect(res.status, await res.clone().text()).toBe(200);
  return res.text();
};

describe("notices", () => {
  it("are listed under Notices alone, for a person at the business, and alert nobody", async () => {
    const s = await setup();
    const get = (path: string, who: Record<string, string>) => s.app.request(req("GET", path, who));
    const main = await read(await get("/v1/owner/items?open_only=false", s.owner));
    expect(main).toContain(s.other);
    expect(main).not.toContain(s.notice);
    expect(main).not.toContain(s.newsletter);
    const notices = await read(await get("/v1/owner/items?notices=true&open_only=false", s.owner));
    expect(notices).toContain(s.notice);
    expect(notices).toContain(s.newsletter);
    expect(notices).not.toContain(s.other);
    expect(await read(await get(`/v1/owner/items/${s.notice}`, s.owner))).toContain(DUNS);
    // An alert was written for Rita's email, and for nothing else.
    const alerted = async (id: string) =>
      (
        await s.db.client.query({
          sql: "SELECT 1 FROM outbound_mail WHERE item_id = ? AND recipient = 'owner'",
          params: [id],
          method: "all",
        })
      ).rows.length;
    expect(await alerted(s.other)).toBe(1);
    expect(await alerted(s.notice)).toBe(0);
    expect(await alerted(s.newsletter)).toBe(0);
  }, 60_000);

  it("are read by no AI and no key handed to another system, and answered by neither", async () => {
    const s = await setup();
    const get = (path: string, who: Record<string, string>) => s.app.request(req("GET", path, who));
    for (const key of [await mintKey(s.app, s.owner, "automation"), await mintKey(s.app, s.owner, "read_only")]) {
      for (const path of [
        "/v1/owner/items",
        "/v1/owner/items?notices=true&open_only=false",
        "/v1/owner/items?q=D-U-N-S",
      ]) {
        const list = await read(await get(path, key));
        expect(list).not.toContain(s.notice);
        expect(list).not.toContain(s.newsletter);
      }
      const events = await read(await get("/v1/owner/events", key));
      expect(events).toContain(s.other);
      expect(events).not.toContain(s.notice);
      for (const path of [`/v1/owner/items/${s.notice}`, `/v1/owner/customers/${s.party}/export`]) {
        const said = await read(await get(path, key));
        expect(said).not.toContain(DUNS);
        expect(said).not.toContain("Resolved Inquiry");
      }
      expect(await read(await get(`/v1/owner/items/${s.notice}`, key))).toContain(NOTICE_WITHHELD);
    }
    const zap = await mintKey(s.app, s.owner, "automation");
    const answered = await s.app.request(
      req("POST", `/v1/owner/items/${s.notice}/replies`, zap, { body: "Thanks!", internal: false }),
    );
    expect(answered.status).toBe(403);

    // The owner's AI, and Zapier's key, over the owner MCP.
    for (const auth of [`Bearer ${await aiToken(s.db)}`, zap.authorization]) {
      const mcp = await connectOwner(s.app, auth);
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await mcp.callTool({ name, arguments: args });
        expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
        return JSON.stringify(r);
      };
      for (const args of [{}, { notices: true, open_only: false }]) {
        const list = await call("list_items", args);
        expect(list).not.toContain(s.notice);
        expect(list).not.toContain(s.newsletter);
      }
      expect(await call("list_events", {})).not.toContain(s.notice);
      const said = await call("get_item", { item_id: s.notice });
      expect(said).not.toContain(DUNS);
      expect(said).not.toContain("Resolved Inquiry");
      const reply = await mcp.callTool({ name: "reply", arguments: { item_id: s.notice, body: "Thanks!" } });
      expect(reply.isError).toBe(true);
      await mcp.close();
    }
    await s.drain();
    const entries = await s.db.orm.select().from(schema.threadEntries).where(eq(schema.threadEntries.itemId, s.notice));
    expect(entries.map((e) => e.direction)).toEqual(["in"]);
  }, 60_000);

  it("are moved to the inbox, still the owner's alone, or deleted, by a person at the business only", async () => {
    const s = await setup();
    const get = (path: string, who: Record<string, string>) => s.app.request(req("GET", path, who));
    const zap = await mintKey(s.app, s.owner, "automation");
    // Another system can neither move nor delete one: there is no such notice, as far as it knows.
    expect((await s.app.request(req("POST", `/v1/owner/items/${s.notice}/move-to-inbox`, zap, {}))).status).toBe(404);
    expect((await s.app.request(req("DELETE", `/v1/owner/items/${s.newsletter}/notice`, zap))).status).toBe(404);

    const moved = await s.app.request(req("POST", `/v1/owner/items/${s.notice}/move-to-inbox`, s.owner, {}));
    expect(await read(moved)).toContain('"moved":true');
    expect(await read(await get("/v1/owner/items", s.owner))).toContain(s.notice);
    expect(await read(await get("/v1/owner/items?notices=true&open_only=false", s.owner))).not.toContain(s.notice);
    // Still nobody else's to read.
    expect(await read(await get("/v1/owner/items", zap))).not.toContain(s.notice);
    expect(await read(await get(`/v1/owner/items/${s.notice}`, zap))).not.toContain(DUNS);

    const deleted = await s.app.request(req("DELETE", `/v1/owner/items/${s.newsletter}/notice`, s.owner));
    expect(await read(deleted)).toContain('"deleted":true');
    expect((await get(`/v1/owner/items/${s.newsletter}`, s.owner)).status).toBe(404);
    const left = await s.db.client.query({
      sql: "SELECT (SELECT COUNT(*) FROM thread_entries WHERE item_id = ?) + (SELECT COUNT(*) FROM item_events WHERE item_id = ?)",
      params: [s.newsletter, s.newsletter],
      method: "all",
    });
    expect(Number(left.rows[0]?.[0])).toBe(0);
    // A notice moved to the inbox is a conversation now: it is not deleted as a notice.
    const kept = await s.app.request(req("DELETE", `/v1/owner/items/${s.notice}/notice`, s.owner));
    expect(await read(kept)).toContain('"deleted":false');
    await s.drain();
    const { rows } = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM outbound_mail WHERE item_id = ?",
      params: [s.notice],
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBe(0);
  }, 60_000);
});
