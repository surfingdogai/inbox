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
  // The webhook's endpoint, answered here: what reached it, by the item each call was about.
  const hooked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname !== "hooks.example.com") return fetch(input, init);
    hooked.push(input instanceof Request ? await input.text() : String(init?.body ?? ""));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const inbox = createInbox({
    db,
    secretKey: SECRET_KEY,
    baseUrl: INBOX,
    mailOut,
    fetchImpl,
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
  });
  const owner = { authorization: `Bearer ${(await createApiKey(db, { kind: "owner", name: "cli" })).key}` };
  const ingest = (message: string) =>
    ingestEmail(db, inbox.caps, { raw: message, envelopeTo: INBOUND, auth: { dmarc: "pass" } }, { now: () => T0 });
  // D&B's statement, with its file: a notice too.
  const filed = await ingest(
    [
      "From: D&B <donotreply@iresearch.dnb.com>",
      "To: support@oficinamare.example",
      "Subject: Your D&B statement",
      "Message-ID: <statement@iresearch.dnb.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Your statement is attached.",
      "--b1",
      'Content-Type: application/pdf; name="statement.pdf"',
      'Content-Disposition: attachment; filename="statement.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      btoa("%PDF-1.4 statement"),
      "--b1--",
      "",
    ].join("\r\n"),
  );
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
  if (
    dnb.outcome !== "notice" ||
    news.outcome !== "notice" ||
    filed.outcome !== "notice" ||
    customer.outcome !== "created"
  ) {
    throw new Error(`not as expected: ${JSON.stringify([dnb, news, filed, customer])}`);
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
    ingest,
    hooked,
    notice: dnb.itemId,
    newsletter: news.itemId,
    statement: filed.itemId,
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

  it("are acted on, and their files opened, by a person at the business only: a key or the AI may only put one aside", async () => {
    const s = await setup();
    const get = (path: string, who: Record<string, string>) => s.app.request(req("GET", path, who));
    const zap = await mintKey(s.app, s.owner, "automation");
    const reader = await mintKey(s.app, s.owner, "read_only");
    for (const event of [
      { event: "answer", input: { note: "AI answer via transition" } },
      { event: "close" },
      { event: "ask_info", input: { note: "Which case?" } },
    ]) {
      const res = await s.app.request(req("POST", `/v1/owner/items/${s.notice}/transitions`, zap, event));
      const said = await res.text();
      expect(res.status, said).toBe(403);
      expect(said).toContain("person_only");
      expect(said).not.toContain(DUNS);
      expect(said).not.toContain("Resolved Inquiry");
    }
    // A note is a person's to write on one too.
    expect(
      (
        await s.app.request(
          req("POST", `/v1/owner/items/${s.notice}/replies`, zap, { body: "Filed under D&B.", internal: true }),
        )
      ).status,
    ).toBe(403);
    // Its files: named to nobody else, opened by nobody else.
    const files = await read(await get(`/v1/owner/items/${s.statement}/attachments`, s.owner));
    const fileId = (JSON.parse(files) as { attachments: { id: string; filename: string }[] }).attachments[0]?.id ?? "";
    expect(files).toContain("statement.pdf");
    expect((await get(`/v1/owner/attachments/${fileId}`, s.owner)).status).toBe(200);
    for (const key of [zap, reader]) {
      expect((await get(`/v1/owner/items/${s.statement}/attachments`, key)).status).toBe(403);
      expect((await get(`/v1/owner/attachments/${fileId}`, key)).status).toBe(403);
      expect(await read(await get(`/v1/owner/items/${s.statement}`, key))).not.toContain("statement.pdf");
    }
    // The owner's AI, over the owner MCP: refused as well.
    const mcp = await connectOwner(s.app, `Bearer ${await aiToken(s.db)}`);
    const moved = await mcp.callTool({
      name: "transition_item",
      arguments: { item_id: s.notice, event: "answer", input: { note: "Done." } },
    });
    expect(moved.isError).toBe(true);
    expect(JSON.stringify(moved)).not.toContain(DUNS);
    await mcp.close();
    // Putting one aside is all another system may do, and it reads nothing of it in the answer.
    const aside = await s.app.request(
      req("POST", `/v1/owner/items/${s.newsletter}/transitions`, zap, { event: "mark_spam" }),
    );
    const asideSaid = await read(aside);
    expect(asideSaid).not.toContain("Big sale");
    await s.drain();
    const { rows } = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM outbound_mail WHERE item_id IN (?, ?)",
      params: [s.notice, s.statement],
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBe(0);
  }, 60_000);

  it("are never answered under Notices, a person told so at once; moved to the inbox, only a person answers one", async () => {
    const s = await setup();
    const reply = (who: Record<string, string>, internal: boolean) =>
      s.app.request(req("POST", `/v1/owner/items/${s.notice}/replies`, who, { body: "Thanks!", internal }));
    const refused = await reply(s.owner, false);
    const said = await refused.text();
    expect(refused.status, said).toBe(409);
    expect(said).toContain("Move it to the inbox to answer it");
    const viaTransition = await s.app.request(
      req("POST", `/v1/owner/items/${s.notice}/transitions`, s.owner, { event: "answer", input: { note: "Thanks!" } }),
    );
    expect(viaTransition.status).toBe(409);
    // A note for the team is kept.
    expect((await reply(s.owner, true)).status).toBe(200);
    await s.drain();
    expect(s.mailOut.sent.filter((m) => m.to.some((t) => t.includes("dnb.com")))).toEqual([]);

    await read(await s.app.request(req("POST", `/v1/owner/items/${s.notice}/move-to-inbox`, s.owner, {})));
    const zap = await mintKey(s.app, s.owner, "automation");
    const keyed = await s.app.request(
      req("POST", `/v1/owner/items/${s.notice}/transitions`, zap, { event: "answer", input: { note: "Auto" } }),
    );
    expect(keyed.status).toBe(403);
    await s.drain();
    expect(s.mailOut.sent.filter((m) => m.to.some((t) => t.includes("dnb.com")))).toEqual([]);
  }, 60_000);

  it("from one sender are deleted together, in one press, by a person at the business; another sender's stay", async () => {
    const s = await setup();
    const zap = await mintKey(s.app, s.owner, "automation");
    expect((await s.app.request(req("DELETE", `/v1/owner/items/${s.notice}/notices-from-sender`, zap))).status).toBe(
      404,
    );
    const done = await s.app.request(req("DELETE", `/v1/owner/items/${s.notice}/notices-from-sender`, s.owner));
    expect(JSON.parse(await read(done))).toEqual({ deleted: 2, more: false, sender: "dnb.com" });
    const left = await read(await s.app.request(req("GET", "/v1/owner/items?notices=true&open_only=false", s.owner)));
    expect(left).not.toContain(s.notice);
    expect(left).not.toContain(s.statement);
    expect(left).toContain(s.newsletter);
    expect(await read(await s.app.request(req("GET", "/v1/owner/items?open_only=false", s.owner)))).toContain(s.other);
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

  it("put aside, and brought back with Not spam, are in the inbox where the owner looks, still the owner's alone", async () => {
    const s = await setup();
    const get = (path: string, who: Record<string, string>) => s.app.request(req("GET", path, who));
    // A rule that answers every message, run as one arrives and as one changes state, and a webhook for
    // every event, from now on: neither may touch it. A customer's message, put aside and brought back
    // the same way, is answered by the one and carried by the other, so both are live.
    await s.db.orm.insert(schema.rules).values({
      id: ulid(),
      name: "Answer every message",
      priority: 5,
      enabled: 1,
      definition: {
        on: ["item.created", "item.transitioned"],
        if: { path: "item.type", op: "eq", value: "message" },
        actions: [{ action: "reply", template: "Thanks, we read every message within a day." }],
        stop: false,
        maxRunsPerItem: 5,
      },
      createdAt: T0,
      updatedAt: T0,
    });
    const hook = await s.app.request(
      req("POST", "/v1/owner/webhooks", s.owner, { url: "https://hooks.example.com/all", events: ["*"] }),
    );
    expect(hook.status, await hook.clone().text()).toBe(201);
    // Dominios.PT's invoice, put aside as it arrived: a mail server marked it. And a customer's, the same way.
    const asideBy = async (from: string, subject: string, id: string, text: string, notice: boolean) => {
      const got = await s.ingest(
        raw(
          {
            From: from,
            To: "support@oficinamare.example",
            Subject: subject,
            "Message-ID": `<${id}>`,
            ...(notice ? { "Auto-Submitted": "auto-generated" } : {}),
            "X-Spam-Flag": "YES",
          },
          text,
        ),
      );
      expect(got.outcome).toBe("spam");
      return "itemId" in got ? (got.itemId ?? "") : "";
    };
    const id = await asideBy(
      "Dominios.PT <no-reply@dominios.pt>",
      "Fatura FT 2026/118",
      "ft2026-118@dominios.pt",
      "A sua fatura FT 2026/118 está disponível. https://my.dominios.pt/viewinvoice.php?id=118",
      true,
    );
    const ines = await asideBy(
      "Inês Costa <ines@example.net>",
      "Front wheel",
      "w1@example.net",
      "Could you true my front wheel this week?",
      false,
    );
    expect(await read(await get("/v1/owner/items?state=spam&open_only=false", s.owner))).toContain(id);
    await s.drain();

    // The owner says Not spam: it is in the inbox, out of Spam and out of Notices, where they looked.
    const zap = await mintKey(s.app, s.owner, "automation");
    expect(
      (await s.app.request(req("POST", `/v1/owner/items/${id}/transitions`, zap, { event: "unspam" }))).status,
    ).toBe(403);
    const unspam = (item: string, key: string) =>
      s.app.request(
        req("POST", `/v1/owner/items/${item}/transitions`, { ...s.owner, "idempotency-key": key }, { event: "unspam" }),
      );
    // Pressed four times at once, as a slow connection retries, then once more: moved once.
    const backs = await Promise.all([1, 2, 3, 4].map(() => unspam(id, "unspam-1")));
    for (const back of backs) {
      const said = JSON.parse(await read(back)) as { view: { item: { state: string; flags: object } } };
      expect(said.view.item.state).toBe("open");
      expect(said.view.item.flags).toMatchObject({ notice: true, inInbox: true });
    }
    await read(await unspam(id, "unspam-1"));
    expect(await read(await get("/v1/owner/items", s.owner))).toContain(id);
    expect(await read(await get("/v1/owner/items?notices=true&open_only=false", s.owner))).not.toContain(id);
    expect(await read(await get("/v1/owner/items?state=spam&open_only=false", s.owner))).not.toContain(id);
    const events = await s.db.client.query({
      sql: "SELECT event, reason FROM item_events WHERE item_id = ? ORDER BY seq",
      params: [id],
      method: "all",
    });
    expect(events.rows.map((r) => [String(r[0]), r[1] === null ? null : String(r[1])])).toEqual([
      ["create", null],
      ["unspam", null],
      ["flags", "Not spam: moved to the inbox"],
    ]);

    // Still nobody else's to read, list or answer: a key, a reader, the owner's AI.
    for (const key of [zap, await mintKey(s.app, s.owner, "read_only")]) {
      expect(await read(await get("/v1/owner/items", key))).not.toContain(id);
      const said = await read(await get(`/v1/owner/items/${id}`, key));
      expect(said).toContain(NOTICE_WITHHELD);
      expect(said).not.toContain("FT 2026/118");
      expect(await read(await get("/v1/owner/events", key))).not.toContain(id);
    }
    expect(
      (await s.app.request(req("POST", `/v1/owner/items/${id}/replies`, zap, { body: "Paid", internal: false })))
        .status,
    ).toBe(403);
    const mcp = await connectOwner(s.app, `Bearer ${await aiToken(s.db)}`);
    const listed = await mcp.callTool({ name: "list_items", arguments: {} });
    expect(JSON.stringify(listed)).not.toContain(id);
    const seen = await mcp.callTool({ name: "get_item", arguments: { item_id: id } });
    expect(JSON.stringify(seen)).not.toContain("FT 2026/118");
    await mcp.close();

    // The customer's message, brought back the same way.
    await read(await unspam(ines, "unspam-ines"));
    await s.drain();
    const answers = async (item: string) =>
      (await s.db.orm.select().from(schema.threadEntries).where(eq(schema.threadEntries.itemId, item))).filter(
        (e) => e.direction === "out",
      ).length;
    const deliveries = async (item: string) =>
      Number(
        (
          await s.db.client.query({
            sql: "SELECT COUNT(*) FROM webhook_deliveries d JOIN item_events e ON e.id = d.event_id WHERE e.item_id = ?",
            params: [item],
            method: "all",
          })
        ).rows[0]?.[0],
      );
    // The rule answered the customer and the webhook carried their message: both are live.
    expect(await answers(ines)).toBeGreaterThan(0);
    expect(await deliveries(ines)).toBeGreaterThan(0);
    expect(s.hooked.some((body) => body.includes(ines))).toBe(true);
    // No rule answered the notice, no webhook carried it, and nobody was alerted.
    expect(await answers(id)).toBe(0);
    expect(await deliveries(id)).toBe(0);
    expect(s.hooked.some((body) => body.includes(id))).toBe(false);
    const sent = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM outbound_mail WHERE item_id = ?",
      params: [id],
      method: "all",
    });
    expect(Number(sent.rows[0]?.[0])).toBe(0);

    // Marked as spam again from the inbox, and brought back again: still the owner's alone, moved no more.
    await read(await s.app.request(req("POST", `/v1/owner/items/${id}/transitions`, s.owner, { event: "mark_spam" })));
    await read(await unspam(id, "unspam-2"));
    await s.drain();
    expect(await answers(id)).toBe(0);
    expect(await deliveries(id)).toBe(0);
    const again = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM item_events WHERE item_id = ? AND event = 'flags'",
      params: [id],
      method: "all",
    });
    expect(Number(again.rows[0]?.[0])).toBe(1);
    expect(await read(await get("/v1/owner/items", s.owner))).toContain(id);

    // A customer's message brought back with Not spam is in the inbox as it always was: no notice flag.
    const customer = JSON.parse(await read(await unspam(ines, "unspam-ines"))) as {
      view: { item: { flags: Record<string, unknown> } };
    };
    expect(customer.view.item.flags.inInbox).toBeUndefined();
    expect(await read(await get("/v1/owner/items", s.owner))).toContain(ines);
  }, 60_000);

  it("put in Spam by the owner, are listed under Spam alone: not under Notices, nor counted there", async () => {
    const s = await setup();
    const get = (path: string) => s.app.request(req("GET", path, s.owner));
    await read(
      await s.app.request(req("POST", `/v1/owner/items/${s.newsletter}/transitions`, s.owner, { event: "mark_spam" })),
    );
    expect(await read(await get("/v1/owner/items?state=spam&open_only=false"))).toContain(s.newsletter);
    const notices = await read(await get("/v1/owner/items?notices=true&open_only=false"));
    expect(notices).not.toContain(s.newsletter);
    expect(notices).toContain(s.notice);
    expect(await read(await get("/v1/owner/items?open_only=false"))).not.toContain(s.newsletter);
  }, 60_000);
});
