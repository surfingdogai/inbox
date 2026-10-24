import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger";
import { redact } from "../src/redact";
import { hostedModelFrom, spamHostPolicy, tenantJudge } from "../src/spam";
import { type PolicyPayload, policyPayloadSchema } from "../src/types";
import { type FakeTenant, type Runtime, startRuntime } from "./harness";

/**
 * The spam filter on hosted inboxes (ADR-029 §7.2, §15.3). We pay for the AI: the model is ours, its
 * key lives in the shard's environment only — never in a tenant's settings, status, download or a log
 * line — and every check an inbox makes is reserved in the shared ledger before it is made, within the
 * inbox's caps and the runtime's own daily budget, whatever the inbox's own file says it spent. A
 * policy without a `spam` block asks no model at all, and a filter its host withdraws is switched off.
 */

const KEY = "sk-ant-hosted-test-key-0123456789abcdefghij";

/** Our model's API, recorded: it answers every check as a sales pitch, and counts what it was asked. */
const model = {
  calls: [] as { headers: Headers; body: string }[],
  fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    model.calls.push({ headers: new Headers(init?.headers), body });
    const req = JSON.parse(body) as { system: string; messages: { content: string }[] };
    const check = /Put this value in check, exactly as written: (\S+)/.exec(req.system)?.[1] ?? "";
    const quote = /first page of Google|top of Google|page one on Google/.exec(req.messages[0]?.content ?? "")?.[0];
    const answer = {
      check,
      kind: "sales_pitch",
      certainty: "high",
      customer_intent: false,
      talks_to_filter: false,
      topic: "seo",
      quotes: quote ? [quote] : [],
    };
    return new Response(
      JSON.stringify({
        id: "msg_hosted",
        type: "message",
        role: "assistant",
        model: "our-model",
        content: [{ type: "text", text: JSON.stringify(answer) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 700, output_tokens: 50 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch,
};

const ENV = {
  HOSTED_SPAM_MODEL_API: "messages",
  HOSTED_SPAM_MODEL: "our-model",
  HOSTED_SPAM_MODEL_KEY: KEY,
  HOSTED_SPAM_DAILY_TOKENS: "1000000",
};

const SPAM: NonNullable<PolicyPayload["spam"]> = {
  ai: true,
  filters: ["pitches", "scams"],
  day_cap: 2,
  month_cap: 100,
  reader: null,
  billing: "off",
  price: null,
};

/** Pitches in different words, so none is counted as a wave of the same text. */
const PITCHES = [
  "Hello, we will get your salon to the first page of Google within 30 days. Shall I send a free audit of your website?",
  "Good morning! Our agency puts small businesses at the top of Google. We have a special offer this month only, reply for prices.",
  "Dear owner, I noticed your site is not page one on Google yet. Our team fixes that in weeks; may I call you tomorrow?",
];

let rt: Runtime;
const lines: string[] = [];
beforeAll(async () => {
  rt = await startRuntime({ spamModel: hostedModelFrom(ENV, model.fetch), log: (line) => lines.push(line) });
});
afterAll(async () => {
  await rt.close();
});

async function liveInbox(spam: PolicyPayload["spam"] | undefined) {
  const t = await rt.createTenant();
  t.spam = spam;
  await rt.setState(t, "live", { ownResolves: true });
  const host = t.ownHost ?? "";
  const cookie = await rt.signIn(t, host);
  const owner = { cookie, "content-type": "application/json", origin: `https://${host}` };
  return { t, host, cookie, owner };
}

async function switchOn(host: string, owner: Record<string, string>, filter: string) {
  const r = await rt.http(host, "PUT", `/v1/owner/spam/filters/${filter}`, {
    headers: owner,
    body: JSON.stringify({ on: true }),
  });
  expect(r.status, r.text).toBe(200);
  // Past its learning week, so what it decides is acted on.
  expect((await rt.http(host, "POST", `/v1/owner/spam/filters/${filter}/start`, { headers: owner })).status).toBe(200);
}

const send = (host: string, body: string) =>
  rt.http(host, "POST", "/v1/messages", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, contact: { name: "Growth Team", email: `growth@agency-${body.length}.example` } }),
  });

const verdictsOf = (t: FakeTenant) => {
  const file = new DatabaseSync(rt.shardOf(t).dbPath(t.tenantId));
  try {
    return file.prepare("SELECT verdict, ai, cause FROM spam_verdicts ORDER BY created_at").all() as {
      verdict: string;
      ai: string;
      cause: string | null;
    }[];
  } finally {
    file.close();
  }
};

/**
 * Until every check the inbox has to make is made: a shard's own tick may be running already, and a
 * second one then does nothing, so this asks again until nothing waits.
 */
async function settle(t: FakeTenant) {
  for (let i = 0; i < 100; i++) {
    await rt.shardOf(t).tick();
    if (!verdictsOf(t).some((v) => v.verdict === "pending")) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the inbox's checks never finished");
}

describe("our model", () => {
  it("is read from the shard's environment, and is none until it is complete", () => {
    expect(hostedModelFrom({})).toBeNull();
    expect(hostedModelFrom({ ...ENV, HOSTED_SPAM_MODEL_KEY: "" })).toBeNull();
    expect(hostedModelFrom({ ...ENV, HOSTED_SPAM_MODEL_API: "chat" })).toBeNull();
    expect(hostedModelFrom({ ...ENV, HOSTED_SPAM_DAILY_TOKENS: "lots" })?.dailyTokens).toBe(50_000_000);
    // What is kept of it says nothing of its key.
    expect(JSON.stringify(hostedModelFrom(ENV))).not.toContain(KEY);
  });

  it("is asked only where the policy lets our AI read for the inbox", () => {
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "sdh-spam-")), "ledger.db"), { hashKey: "k" });
    const ours = hostedModelFrom(ENV, model.fetch);
    expect(tenantJudge({ model: ours, ledger, tenantId: "tn_a", policy: null })).toBeNull();
    expect(
      tenantJudge({
        model: ours,
        ledger,
        tenantId: "tn_a",
        policy: spamHostPolicy({ spam: { ...SPAM, ai: false } } as PolicyPayload),
      }),
    ).toBeNull();
    expect(
      tenantJudge({ model: null, ledger, tenantId: "tn_a", policy: spamHostPolicy({ spam: SPAM } as PolicyPayload) }),
    ).toBeNull();
    expect(
      tenantJudge({ model: ours, ledger, tenantId: "tn_a", policy: spamHostPolicy({ spam: SPAM } as PolicyPayload) }),
    ).not.toBeNull();
    ledger.close();
  });

  it("is a policy's to give: the block is checked, and an inbox without one has none", () => {
    expect(policyPayloadSchema.shape.spam.safeParse({ ...SPAM, filters: ["everything"] }).success).toBe(false);
    expect(policyPayloadSchema.shape.spam.safeParse({ ...SPAM, day_cap: -1 }).success).toBe(false);
    expect(spamHostPolicy({ spam: SPAM } as PolicyPayload)).toEqual({
      ai: true,
      filters: ["pitches", "scams"],
      dayCap: 2,
      monthCap: 100,
      reader: null,
      billing: "off",
      price: null,
    });
    expect(spamHostPolicy({} as PolicyPayload)).toBeNull();
  });

  it("never writes a model key into a log line", () => {
    for (const line of [
      `judge failed: 401 {"error":"invalid x-api-key ${KEY}"}`,
      "config HOSTED_SPAM_MODEL_KEY=gsk_abcdefghijklmnopqrstuvwx",
      'request headers {"x-api-key": "abcdefghijklmnop0123"}',
      "key AIzaSyA-abcdefghijklmnopqrstuvwxyz012345",
    ]) {
      const out = redact(line);
      expect(out).not.toMatch(/sk-ant-hosted|gsk_abcdef|abcdefghijklmnop0123|AIzaSyA-abc/);
    }
  });
});

describe("the ledger's count of AI checks", () => {
  it("holds each inbox to its day and month across every shard, and tells the control plane once", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdh-spam-"));
    let now = Date.parse("2026-10-26T10:00:00Z");
    const a = new Ledger(join(dir, "ledger.db"), { hashKey: "k", now: () => now });
    const b = new Ledger(join(dir, "ledger.db"), { hashKey: "k", now: () => now });
    const caps = { day: 3, month: 4, dailyTokens: 1_000_000 };
    expect([a.reserveJudge("tn_1", caps), b.reserveJudge("tn_1", caps), a.reserveJudge("tn_1", caps)]).toEqual([
      "ok",
      "ok",
      "ok",
    ]);
    expect(b.reserveJudge("tn_1", caps)).toBe("tenant");
    expect(a.reserveJudge("tn_1", caps)).toBe("tenant");
    // Another inbox has its own.
    expect(b.reserveJudge("tn_2", caps)).toBe("ok");
    // The next day: one more, and then the month is spent.
    now += 86_400_000;
    expect(a.reserveJudge("tn_1", caps)).toBe("ok");
    expect(b.reserveJudge("tn_1", caps)).toBe("tenant");
    expect(a.judged("tn_1", "2026-10").n).toBe(4);
    const told = new DatabaseSync(join(dir, "ledger.db"));
    const events = told.prepare("SELECT tenant_id, type FROM events ORDER BY id").all();
    told.close();
    expect(events).toEqual([
      { tenant_id: "tn_1", type: "spam_cap_reached" },
      { tenant_id: "tn_1", type: "spam_cap_reached" },
    ]);
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stops every inbox's checks once the runtime's own day is spent", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdh-spam-"));
    const l = new Ledger(join(dir, "ledger.db"), { hashKey: "k", now: () => Date.parse("2026-10-26T10:00:00Z") });
    const caps = { day: 1000, month: 10_000, dailyTokens: 2_000 };
    expect(l.reserveJudge("tn_1", caps)).toBe("ok");
    l.recordJudge("tn_1", 1_900, 150);
    expect(l.reserveJudge("tn_2", caps)).toBe("breaker");
    expect(l.reserveJudge("tn_1", caps)).toBe("breaker");
    expect(l.judged("tn_1", "2026-10")).toEqual({ n: 1, tokens_in: 1_900, tokens_out: 150 });
    l.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("a hosted inbox's spam filter", () => {
  it("asks no model where the policy has no spam block: the filters look for known phrases only", async () => {
    const { t, host, owner } = await liveInbox(undefined);
    await switchOn(host, owner, "pitches");
    const before = model.calls.length;
    expect((await send(host, PITCHES[0] as string)).status).toBe(201);
    await settle(t);
    expect(model.calls.length).toBe(before);
    expect(verdictsOf(t).map((v) => v.ai)).toEqual(["skipped"]);
  });

  it("counts each check in the ledger before it is made, within the inbox's caps, whatever its own file says", async () => {
    const { t, host, owner } = await liveInbox(SPAM);
    await switchOn(host, owner, "pitches");
    const before = model.calls.length;
    for (const text of PITCHES.slice(0, 2)) {
      expect((await send(host, text)).status).toBe(201);
      await settle(t);
    }
    expect(model.calls.length - before).toBe(2);
    expect(verdictsOf(t).map((v) => [v.ai, v.verdict])).toEqual([
      ["judged", "aside"],
      ["judged", "aside"],
    ]);
    expect(rt.ledger.judged(t.tenantId, new Date().toISOString().slice(0, 7))).toMatchObject({
      n: 2,
      tokens_in: 1_400,
      tokens_out: 100,
    });
    // A copy of the inbox's file that forgot its checks gets no more from the ledger.
    const file = new DatabaseSync(rt.shardOf(t).dbPath(t.tenantId));
    file.prepare("DELETE FROM spam_days").run();
    file.close();
    expect((await send(host, PITCHES[2] as string)).status).toBe(201);
    await settle(t);
    expect(model.calls.length - before).toBe(2);
    expect(verdictsOf(t).at(-1)?.ai).toBe("capped");
    const told = () => rt.cp.events.filter((e) => e.tenant_id === t.tenantId && e.type === "spam_cap_reached");
    for (let i = 0; i < 50 && told().length === 0; i++) {
      await settle(t);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(told()).toHaveLength(1);
  });

  it("switches a filter off when its host withdraws it", async () => {
    const { t, host, owner, cookie } = await liveInbox(SPAM);
    await switchOn(host, owner, "pitches");
    t.spam = { ...SPAM, filters: ["scams"] };
    await rt.setState(t, "live", { ownResolves: true });
    // Read again as the inbox opens with the new policy.
    const status = (await rt.http(host, "GET", "/v1/owner/spam", { headers: { cookie } })).json as {
      filters: { filter: string; on: boolean; allowed: boolean }[];
    };
    expect(status.filters.find((f) => f.filter === "pitches")).toMatchObject({ on: false, allowed: false });
    expect(
      (
        await rt.http(host, "PUT", "/v1/owner/spam/filters/pitches", {
          headers: owner,
          body: JSON.stringify({ on: true }),
        })
      ).status,
    ).toBe(403);
  });

  it("reports the month's filter-days, checks and tokens in usage", async () => {
    const { t, host, owner } = await liveInbox(SPAM);
    await switchOn(host, owner, "pitches");
    await switchOn(host, owner, "scams");
    await send(host, PITCHES[0] as string);
    await settle(t);
    const month = new Date().toISOString().slice(0, 7);
    const usage = (await rt.admin("GET", `/admin/v1/tenants/${t.tenantId}/usage?month=${month}`)).body as {
      items: number;
      spam: {
        filter_days: Record<string, number>;
        judged: number;
        tokens_in: number;
        tokens_out: number;
        aside: number;
      };
    };
    expect(usage.spam.filter_days).toMatchObject({ pitches: 1, scams: 1, junk: 0 });
    expect(usage.spam).toMatchObject({ judged: 1, tokens_in: 700, tokens_out: 50, aside: 1 });
    // What was put aside is not a request.
    expect(usage.items).toBe(0);
  });

  it("keeps our key out of everything an inbox shows, keeps or logs", async () => {
    const { host, cookie } = await liveInbox(SPAM);
    for (const path of ["/v1/owner/settings", "/v1/owner/spam", "/v1/owner/download"]) {
      const r = await rt.http(host, "GET", path, { headers: { cookie } });
      expect(r.text, path).not.toContain(KEY);
      expect(r.text, path).not.toContain("our-model");
    }
    for (const call of model.calls) {
      expect(call.headers.get("x-api-key")).toBe(KEY);
      expect(call.body).not.toContain(KEY);
    }
    expect(lines.join("\n")).not.toContain(KEY);
    // Every check our model was sent named only domains, never a sender's address.
    for (const call of model.calls) expect(call.body).not.toMatch(/growth@agency/);
  });
});
