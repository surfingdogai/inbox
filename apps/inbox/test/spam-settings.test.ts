import { createApiKey } from "@surfingdog/adapters";
import { schema } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * Settings → Spam and Your AI model through the whole app (ADR-041 §11.4, §11.5): who may change what,
 * removing a list entry, and an owner's own model on their own server — the provider's list, the key
 * kept sealed and never sent back, and Test with two samples — against recorded provider answers. No
 * test reaches a real provider. Runs on Node and in workerd.
 */

const BASE = "https://inbox.example.org";
const T = Date.parse("2026-10-26T09:00:00Z");

/** A provider that answers as recorded: its model list, and a chat answer that echoes the check value. */
function provider() {
  const seen: { url: string; auth: string | null; body: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    seen.push({ url, auth: headers.get("authorization"), body });
    if (url === "https://api.openai.com/v1/models") {
      if (headers.get("authorization") !== "Bearer sk-test-openai-0001") return new Response("{}", { status: 401 });
      return Response.json({
        data: [
          { id: "gpt-text-small" },
          { id: "text-embedding-small" },
          { id: "gpt-image-1" },
          { id: "gpt-text-large" },
        ],
      });
    }
    if (url === "https://api.openai.com/v1/chat/completions") {
      const req = JSON.parse(body) as { messages: { role: string; content: string }[] };
      const system = req.messages.find((m) => m.role === "system")?.content ?? "";
      const user = req.messages.find((m) => m.role === "user")?.content ?? "";
      const nonce = /exactly as written: (\S+)/.exec(system)?.[1] ?? "";
      const pitch = user.includes("backlinks");
      const answer = {
        check: nonce,
        kind: pitch ? "sales_pitch" : "customer",
        certainty: "high",
        customer_intent: !pitch,
        talks_to_filter: false,
        topic: pitch ? "seo" : "none",
        quotes: [],
      };
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer) } }],
        usage: { prompt_tokens: 900, completion_tokens: 40 },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

async function setup() {
  const db = await freshDb();
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Studio Kalinda",
    domain: "studiokalinda.example",
    timezone: "Australia/Darwin",
    currency: "AUD",
    languages: ["en"],
    createdAt: T,
    updatedAt: T,
  });
  const p = provider();
  const inbox = createInbox({
    db,
    mailOut: logMailOut(() => {}),
    baseUrl: BASE,
    secretKey: "spam-settings-test-secret-0123456789abcd",
    background: () => {},
    now: () => T,
    fetchImpl: p.fetchImpl,
  });
  const owner = await createApiKey(db, { kind: "owner", name: "t" });
  const crm = await createApiKey(db, { kind: "integration", name: "CRM", scopes: ["*"] });
  const call = (method: string, path: string, key: string, body?: unknown) =>
    inbox.app.request(
      new Request(`${BASE}/v1/owner${path}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
  return { db, call, owner: owner.key, crm: crm.key, seen: p.seen };
}

describe("Settings → Spam", () => {
  it("reads the same for a key, which may change nothing", async () => {
    const s = await setup();
    const asOwner = (await (await s.call("GET", "/spam", s.owner)).json()) as { can_change: boolean };
    expect(asOwner.can_change).toBe(true);
    const asKey = (await (await s.call("GET", "/spam", s.crm)).json()) as { can_change: boolean };
    expect(asKey.can_change).toBe(false);
    const refused = await s.call("PUT", "/spam/filters/pitches", s.crm, { on: true });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { detail: string }).detail).toBe("Only you can change this, signed in.");
    const on = await s.call("PUT", "/spam/filters/pitches", s.owner, { on: true });
    expect(on.status).toBe(200);
    const status = (await on.json()) as { filters: { filter: string; on: boolean; learning_until: string | null }[] };
    expect(status.filters.find((f) => f.filter === "pitches")).toMatchObject({ on: true });
    expect(status.filters.find((f) => f.filter === "pitches")?.learning_until).not.toBeNull();
  });

  it("removes a row from a list, and only a person may", async () => {
    const s = await setup();
    await s.db.client.query({
      sql: `INSERT INTO spam_lists (list, kind, value, party_id, item_id, by_user, created_at)
            VALUES ('block', 'address', 'offers@rankboost.example', NULL, NULL, 'owner', ?)`,
      params: [T],
      method: "run",
    });
    const entry = { list: "block", kind: "address", value: "offers@rankboost.example" };
    expect((await s.call("DELETE", "/spam/lists", s.crm, entry)).status).toBe(403);
    expect(await (await s.call("DELETE", "/spam/lists", s.owner, entry)).json()).toEqual({ removed: true });
    const after = (await (await s.call("GET", "/spam", s.owner)).json()) as { lists: { block: unknown[] } };
    expect(after.lists.block).toEqual([]);
  });
});

describe("Your AI model", () => {
  it("lists the provider's text models for a key, keeps the key sealed, and tests two samples", async () => {
    const s = await setup();
    expect(await (await s.call("GET", "/spam/model", s.owner)).json()).toMatchObject({
      offered: true,
      own: null,
      set_by_server: null,
      providers: [
        { id: "anthropic", name: "Anthropic" },
        { id: "openai", name: "OpenAI" },
        { id: "gemini", name: "Google Gemini" },
      ],
    });
    const wrong = await s.call("POST", "/spam/model/models", s.owner, { provider: "openai", key: "sk-wrong-key-01" });
    expect(wrong.status).toBe(422);
    expect(((await wrong.json()) as { detail: string }).detail).toBe(
      "OpenAI didn't accept this key. Copy it again from your OpenAI account.",
    );
    const listed = await s.call("POST", "/spam/model/models", s.owner, {
      provider: "openai",
      key: "sk-test-openai-0001",
    });
    // The small ones first: the owner pays for each check, and a small model is enough here.
    expect(await listed.json()).toEqual({
      models: [
        { id: "gpt-text-small", name: "gpt-text-small" },
        { id: "gpt-text-large", name: "gpt-text-large" },
      ],
    });
    const saved = await s.call("PUT", "/spam/model", s.owner, {
      provider: "openai",
      model: "gpt-text-small",
      key: "sk-test-openai-0001",
    });
    const card = await saved.text();
    expect(card).not.toContain("sk-test-openai-0001");
    expect(JSON.parse(card)).toMatchObject({ own: { provider: "openai", model: "gpt-text-small", tested: null } });
    // Without the key again, the kept one lists the models.
    expect((await s.call("POST", "/spam/model/models", s.owner, { provider: "openai" })).status).toBe(200);
    const test = await s.call("POST", "/spam/model/test", s.owner);
    expect(await test.json()).toEqual({ ok: true, pitch: true, customer: true });
    const chats = s.seen.filter((x) => x.url.endsWith("/chat/completions"));
    expect(chats).toHaveLength(2);
    expect(chats.every((x) => x.auth === "Bearer sk-test-openai-0001")).toBe(true);
    // The key is in no answer and in no table in the clear.
    for (const path of ["/spam/model", "/spam", "/settings"]) {
      expect(await (await s.call("GET", path, s.owner)).text()).not.toContain("sk-test-openai-0001");
    }
    expect(
      JSON.stringify((await s.db.client.query({ sql: "SELECT * FROM spam_model", method: "all" })).rows),
    ).not.toContain("sk-test-openai-0001");
    const status = (await (await s.call("GET", "/spam", s.owner)).json()) as { reader: string; model: unknown };
    expect(status).toMatchObject({ reader: "own_model", model: { provider: "OpenAI", model: "gpt-text-small" } });
    // A key handed to another system changes nothing here.
    expect((await s.call("DELETE", "/spam/model", s.crm)).status).toBe(403);
    expect(await (await s.call("DELETE", "/spam/model", s.owner)).json()).toMatchObject({ own: null });
  });
});
