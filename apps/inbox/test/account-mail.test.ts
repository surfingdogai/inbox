import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey, hashKey, ingestEmail } from "@surfingdog/adapters";
import { ACCOUNT_WITHHELD, type Db, schema, ulid } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { type App, createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * Mail for an account the business holds (a code, a sign-in link, a password reset) is read by a person
 * at the business: in the owner app, or with the owner's own key. The owner's AI and a key handed to
 * another system (Zapier's, a read-only dashboard's) learn nothing of what it says, over REST or the
 * owner MCP: it is in no list of items and no event stream, and read by its id it says only that it came.
 */
const INBOX = "https://inbox.example.com";
const SECRET_KEY = "2f8c1d0a6b4e37925c8f01ad6e3b47f0";
const INBOUND = "oficina-mare@in.example.net";
const T0 = Date.parse("2026-11-01T09:00:00Z");
const LINK = "https://app.acmecloud.example/magic-link#t0k3n-9f2c";

const req = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  new Request(`${INBOX}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** An email as a mail program sends it: a text part, and an HTML part when there is one. */
function raw(headers: Record<string, string>, text: string, html?: string): string {
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  if (!html) return `${head}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`;
  return `${head}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="alt"\r\n\r\n--alt\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n--alt\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--alt--\r\n`;
}

async function setup() {
  const db = await freshDb();
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    secretKey: SECRET_KEY,
    baseUrl: INBOX,
    mailOut: logMailOut(),
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
  });
  const owner = { authorization: `Bearer ${(await createApiKey(db, { kind: "owner", name: "cli" })).key}` };
  const ingest = (message: string) =>
    ingestEmail(db, inbox.caps, { raw: message, envelopeTo: INBOUND, auth: { dmarc: "pass" } }, { now: () => T0 });
  const notice = await ingest(
    raw(
      {
        From: "Acme <no-reply-wJOazRuV1tbG@mail.acmecloud.example>",
        To: "support@oficinamare.example",
        Subject: "Your secure link to Acme is here",
        "Message-ID": "<s1@mail.acmecloud.example>",
        "List-Unsubscribe": "<https://mail.acmecloud.example/u>",
      },
      "Click the button below to sign in to Acme.",
      `<a href="${LINK}">Sign in to Acme</a>`,
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
  if (notice.outcome !== "created" || customer.outcome !== "created") throw new Error("not created");
  await Promise.allSettled(pending.splice(0));
  for (let i = 0; i < 20; i++) if ((await inbox.runner.runDue(db, { workerId: "t" })).claimed === 0) break;
  const [row] = await db.orm.select().from(schema.items).where(eq(schema.items.id, notice.itemId));
  if (!row || !(row.flags as { account?: boolean }).account) throw new Error("not an account's mail");
  return { db, app: inbox.app, owner, account: notice.itemId, other: customer.itemId, party: row.partyId };
}

async function mintKey(app: App, owner: Record<string, string>, preset: string) {
  const res = await app.request(req("POST", "/v1/owner/api-keys", owner, { name: preset, preset }));
  expect(res.status, await res.clone().text()).toBe(201);
  return { authorization: `Bearer ${((await res.json()) as { key: string }).key}` };
}

/** An OAuth access token for an AI app the owner connected, with every read it could ask for. */
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

/** Everything a caller read, as one text: what it must and must not hold. */
const read = async (res: Response) => {
  expect(res.status, await res.clone().text()).toBe(200);
  return res.text();
};

describe("mail for an account the business holds", () => {
  it("is read by a person at the business, whole, and by no AI or key handed to another system", async () => {
    const s = await setup();
    const get = (path: string, who: Record<string, string>) => s.app.request(req("GET", path, who));

    // The owner, with their own key: listed, read whole, in the stream.
    expect(await read(await get("/v1/owner/items", s.owner))).toContain(s.account);
    expect(await read(await get(`/v1/owner/items/${s.account}`, s.owner))).toContain(LINK);
    expect(await read(await get("/v1/owner/events", s.owner))).toContain(s.account);

    // Zapier's key and a read-only one, over REST.
    for (const key of [await mintKey(s.app, s.owner, "automation"), await mintKey(s.app, s.owner, "read_only")]) {
      const list = await read(await get("/v1/owner/items", key));
      expect(list).toContain(s.other);
      expect(list).not.toContain(s.account);
      expect(await read(await get("/v1/owner/items?q=magic", key))).not.toContain(s.account);
      const events = await read(await get("/v1/owner/events", key));
      expect(events).toContain(s.other);
      expect(events).not.toContain(s.account);
      for (const path of [
        `/v1/owner/items/${s.account}`,
        `/v1/items/${s.account}`,
        `/v1/owner/customers/${s.party}/export`,
      ]) {
        const said = await read(await get(path, key));
        expect(said).not.toContain("t0k3n");
        expect(said).not.toContain("button below");
        expect(said).not.toContain("Your secure link");
      }
      expect(await read(await get(`/v1/owner/items/${s.account}`, key))).toContain(ACCOUNT_WITHHELD);
    }

    // The owner's AI, and Zapier's key, over the owner MCP.
    const zap = await mintKey(s.app, s.owner, "automation");
    for (const auth of [`Bearer ${await aiToken(s.db)}`, zap.authorization]) {
      const mcp = await connectOwner(s.app, auth);
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await mcp.callTool({ name, arguments: args });
        expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
        return JSON.stringify(r);
      };
      const list = await call("list_items", {});
      expect(list).toContain(s.other);
      expect(list).not.toContain(s.account);
      expect(await call("list_events", {})).not.toContain(s.account);
      for (const said of [
        await call("get_item", { item_id: s.account }),
        await call("export_customer", { party_id: s.party }),
      ]) {
        expect(said).not.toContain("t0k3n");
        expect(said).not.toContain("button below");
        expect(said).not.toContain("Your secure link");
      }
      await mcp.close();
    }
  }, 60_000);
});
