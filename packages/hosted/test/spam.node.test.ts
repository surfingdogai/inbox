import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger";
import { redact } from "../src/redact";
import { HOSTED_SPAM_MODEL, hostedModelFrom, modelName, spamHostPolicy, tenantJudge } from "../src/spam";
import { type PolicyPayload, planOf, policyPayloadSchema } from "../src/types";
import { type FakeTenant, type Runtime, startRuntime } from "./harness";

/**
 * The spam filter on hosted inboxes (ADR-041 §7.2, §15.3). Pro includes the three filters, on from the
 * start, read by our AI: Claude Haiku, on our own Anthropic key, which lives in the shard's environment
 * only — never in a tenant's settings, status, download or a log line. Every check an inbox makes is
 * reserved in the shared ledger before it is made, within the inbox's caps and the runtime's own daily
 * budget, whatever the inbox's own file says it spent. Free keeps basic protection, with no filters and
 * no AI; without our key no model is asked at all.
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
  HOSTED_SPAM_ANTHROPIC_KEY: KEY,
  HOSTED_SPAM_DAILY_TOKENS: "1000000",
};

const PRO = { plan: "pro" } as const;
const SPAM: NonNullable<PolicyPayload["spam"]> = { day_cap: 2, month_cap: 100 };

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

async function liveInbox(plan: PolicyPayload["plan"] | undefined, spam?: PolicyPayload["spam"]) {
  const t = await rt.createTenant();
  t.plan = plan;
  t.spam = spam;
  await rt.setState(t, "live", { ownResolves: true });
  const host = t.ownHost ?? "";
  const cookie = await rt.signIn(t, host);
  const owner = { cookie, "content-type": "application/json", origin: `https://${host}` };
  return { t, host, cookie, owner };
}

interface Status {
  plan: string;
  reader: string;
  reader_name: string | null;
  filters: { filter: string; on: boolean; allowed: boolean; learning_until: string | null }[];
  checks: { day_cap: number | null; month_cap: number | null };
}

const statusOf = async (host: string, cookie: string) =>
  (await rt.http(host, "GET", "/v1/owner/spam", { headers: { cookie } })).json as Status;

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
  it("is Claude Haiku on our Anthropic key, read from the shard's environment, and none without the key", () => {
    expect(hostedModelFrom({})).toBeNull();
    expect(hostedModelFrom({ ...ENV, HOSTED_SPAM_ANTHROPIC_KEY: " " })).toBeNull();
    expect(HOSTED_SPAM_MODEL).toBe("claude-haiku-5-5");
    expect(hostedModelFrom(ENV)?.name).toBe("Claude Haiku, by Anthropic");
    expect(modelName("claude-sonnet-5-5")).toBe("Claude Sonnet, by Anthropic");
    expect(hostedModelFrom({ ...ENV, HOSTED_SPAM_DAILY_TOKENS: "lots" })?.dailyTokens).toBe(50_000_000);
    // What is kept of it says nothing of its key.
    expect(JSON.stringify(hostedModelFrom(ENV))).not.toContain(KEY);
  });

  it("is asked only where the plan lets our AI read for the inbox", () => {
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "sdh-spam-")), "ledger.db"), { hashKey: "k" });
    const ours = hostedModelFrom(ENV, model.fetch);
    const judgeFor = (p: Partial<PolicyPayload>, m = ours) =>
      tenantJudge({ model: m, ledger, tenantId: "tn_a", policy: spamHostPolicy(p as PolicyPayload, m) });
    expect(tenantJudge({ model: ours, ledger, tenantId: "tn_a", policy: null })).toBeNull();
    expect(judgeFor({})).toBeNull();
    expect(judgeFor({ plan: "free" })).toBeNull();
    expect(judgeFor({ ...PRO, spam: { ai: false } })).toBeNull();
    expect(judgeFor(PRO, null)).toBeNull();
    expect(judgeFor(PRO)).not.toBeNull();
    ledger.close();
  });

  it("reads the plan from the policy: Free unless it says Pro, and a plan it does not know as Free", () => {
    expect(planOf({})).toBe("free");
    expect(planOf({ plan: "free" })).toBe("free");
    expect(planOf({ plan: "pro" })).toBe("pro");
    expect(policyPayloadSchema.shape.plan.parse("pro")).toBe("pro");
    expect(policyPayloadSchema.shape.plan.parse("team")).toBeUndefined();
    expect(policyPayloadSchema.shape.spam.safeParse({ day_cap: -1 }).success).toBe(false);
  });

  it("gives Pro the three filters, on from the start, read by Claude Haiku; Free none of them, and no AI", () => {
    const ours = hostedModelFrom(ENV, model.fetch);
    expect(spamHostPolicy({} as PolicyPayload, ours)).toEqual({
      plan: "free",
      ai: false,
      filters: [],
      defaultOn: false,
      dayCap: 150,
      monthCap: 1_500,
      reader: null,
      aiByOwner: false,
      ownerReader: null,
      giftUntil: null,
    });
    expect(spamHostPolicy(PRO as PolicyPayload, ours)).toEqual({
      plan: "pro",
      ai: true,
      filters: ["pitches", "scams", "junk"],
      defaultOn: true,
      dayCap: 150,
      monthCap: 1_500,
      reader: "Claude Haiku, by Anthropic",
      aiByOwner: false,
      ownerReader: null,
      giftUntil: null,
    });
    // Without our key the filters are Pro's all the same, and nothing says an AI reads.
    expect(spamHostPolicy(PRO as PolicyPayload, null)).toMatchObject({ plan: "pro", ai: false, reader: null });
    expect(spamHostPolicy({ ...PRO, spam: SPAM } as PolicyPayload, ours)).toMatchObject({ dayCap: 2, monthCap: 100 });
  });

  it("never writes a model key into a log line", () => {
    for (const line of [
      `judge failed: 401 {"error":"invalid x-api-key ${KEY}"}`,
      "config HOSTED_SPAM_ANTHROPIC_KEY=gsk_abcdefghijklmnopqrstuvwx",
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

  it("tells the control plane once a day, even after the first was delivered", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdh-spam-"));
    let now = Date.parse("2026-10-26T10:00:00Z");
    const l = new Ledger(join(dir, "ledger.db"), { hashKey: "k", now: () => now });
    const caps = { day: 1, month: 100, dailyTokens: 2_000 };
    expect(l.reserveJudge("tn_1", caps)).toBe("ok");
    l.recordJudge("tn_1", 1_900, 150);
    // What the shards pass on: each event told is gone from the queue.
    const told = () => {
      const events = l.claimEvents();
      for (const e of events) l.eventDone(e.id);
      return events.map((e) => `${e.tenant_id} ${e.type}`);
    };
    expect([l.reserveJudge("tn_1", caps), l.reserveJudge("tn_2", caps)]).toEqual(["breaker", "breaker"]);
    expect(told()).toEqual(["tn_1 spam_breaker", "tn_2 spam_breaker"]);
    // The next refusals today tell nothing more.
    for (let i = 0; i < 5; i++) expect(l.reserveJudge("tn_1", caps)).toBe("breaker");
    expect(told()).toEqual([]);
    // The next day is a new one.
    now += 86_400_000;
    expect(l.reserveJudge("tn_1", caps)).toBe("ok");
    expect(l.reserveJudge("tn_1", caps)).toBe("tenant");
    expect(told()).toEqual(["tn_1 spam_cap_reached"]);
    l.close();
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

describe("checks that time out", () => {
  it("still count against the runtime's day, so a provider's slowdown trips the breaker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdh-spam-"));
    const ledger = new Ledger(join(dir, "ledger.db"), { hashKey: "k", now: () => Date.parse("2026-10-26T10:00:00Z") });
    let sent = 0;
    const slow = {
      judge: {
        async judge() {
          sent++;
          return { ok: false as const, why: "timeout" as const };
        },
      },
      dailyTokens: 4_000,
      name: "Claude Haiku, by Anthropic",
    };
    const judge = tenantJudge({
      model: slow,
      ledger,
      tenantId: "tn_1",
      policy: spamHostPolicy({ ...PRO, spam: { day_cap: 1_000 } } as PolicyPayload, slow),
    });
    const request = { system: "s".repeat(3_000), user: "u".repeat(3_000), schema: {}, maxTokens: 300 };
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await judge?.judge(request, new AbortController().signal);
      outcomes.push(r && !r.ok ? r.why : "ok");
    }
    // Each attempt sent may have cost about its prompt and its answer: two of them spend the day.
    expect(sent).toBe(2);
    expect(outcomes).toEqual(["timeout", "timeout", "capped", "capped", "capped"]);
    // The inbox's own count of tokens is what came back, none of the estimate.
    expect(ledger.judged("tn_1", "2026-10")).toEqual({ n: 2, tokens_in: 0, tokens_out: 0 });
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("a hosted inbox's spam filter", () => {
  it("on Free keeps basic protection: no filters to switch on, no AI and no owner's own key", async () => {
    const { t, host, owner, cookie } = await liveInbox(undefined);
    const status = await statusOf(host, cookie);
    expect(status.plan).toBe("free");
    expect(status.reader).toBe("hosted_phrases");
    expect(status.reader_name).toBeNull();
    expect(status.filters.map((f) => [f.filter, f.on, f.allowed])).toEqual([
      ["pitches", false, false],
      ["scams", false, false],
      ["junk", false, false],
    ]);
    const on = await rt.http(host, "PUT", "/v1/owner/spam/filters/pitches", {
      headers: owner,
      body: JSON.stringify({ on: true }),
    });
    expect(on.status).toBe(403);
    expect(on.text).toContain("The filters come with Pro.");
    const card = await rt.http(host, "GET", "/v1/owner/spam/model", { headers: { cookie } });
    expect(card.json).toMatchObject({ offered: false, not_offered: "hosted", own: null, can_change: false });
    const put = await rt.http(host, "PUT", "/v1/owner/spam/model", {
      headers: owner,
      body: JSON.stringify({ provider: "openai", model: "gpt-x", key: "sk-proj-hosted-tenant-0123456789" }),
    });
    expect(put.status).toBe(403);
    // A pitch from a stranger is screened by basic protection alone: no model is asked.
    const before = model.calls.length;
    expect((await send(host, PITCHES[0] as string)).status).toBe(201);
    await settle(t);
    expect(model.calls.length).toBe(before);
  });

  it("on Pro has the three filters on from the start, learning for a week, read by Claude Haiku", async () => {
    const { t, host, cookie } = await liveInbox("pro");
    const status = await statusOf(host, cookie);
    expect(status.plan).toBe("pro");
    expect(status.reader).toBe("hosted_ai");
    expect(status.reader_name).toBe("Claude Haiku, by Anthropic");
    expect(status.checks).toMatchObject({ day_cap: 150, month_cap: 1_500 });
    for (const f of status.filters) {
      expect(f).toMatchObject({ on: true, allowed: true });
      const week = Date.parse(f.learning_until ?? "") - Date.now();
      expect(week).toBeGreaterThan(6.9 * 86_400_000);
      expect(week).toBeLessThanOrEqual(7 * 86_400_000);
    }
    // In its learning week a filter labels what it would put aside, and puts nothing aside.
    const before = model.calls.length;
    expect((await send(host, PITCHES[0] as string)).status).toBe(201);
    await settle(t);
    expect(model.calls.length - before).toBe(1);
    expect(verdictsOf(t).map((v) => [v.ai, v.verdict])).toEqual([["judged", "warn"]]);
    // What our AI is sent: Claude Haiku, thinking off, the answer held to the schema, no sampling settings.
    const sent = JSON.parse(model.calls.at(-1)?.body ?? "{}") as Record<string, unknown>;
    expect(sent).toMatchObject({
      model: "claude-haiku-5-5",
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    expect(sent).not.toHaveProperty("temperature");
    expect(sent).not.toHaveProperty("top_p");
    expect(sent).not.toHaveProperty("top_k");
  });

  it("keeps a filter a person switched off off, and brings back what a lapsed plan switched off", async () => {
    const { t, host, owner, cookie } = await liveInbox("pro");
    const off = await rt.http(host, "PUT", "/v1/owner/spam/filters/junk", {
      headers: owner,
      body: JSON.stringify({ on: false }),
    });
    expect(off.status, off.text).toBe(200);
    // The plan lapses: every filter is switched off, by the system.
    t.plan = "free";
    await rt.setState(t, "live", { ownResolves: true });
    expect((await statusOf(host, cookie)).filters.map((f) => f.on)).toEqual([false, false, false]);
    // Pro again: the two the plan switched off come back; the one the owner switched off stays off.
    t.plan = "pro";
    await rt.setState(t, "live", { ownResolves: true });
    expect((await statusOf(host, cookie)).filters.map((f) => [f.filter, f.on])).toEqual([
      ["pitches", true],
      ["scams", true],
      ["junk", false],
    ]);
  });

  it("counts each check in the ledger before it is made, within the inbox's caps, whatever its own file says", async () => {
    const { t, host, owner } = await liveInbox("pro", SPAM);
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

  it("asks no model where the control plane stops our AI for the inbox", async () => {
    const { t, host, owner, cookie } = await liveInbox("pro", { ai: false });
    await switchOn(host, owner, "pitches");
    expect((await statusOf(host, cookie)).reader).toBe("hosted_phrases");
    const before = model.calls.length;
    expect((await send(host, PITCHES[1] as string)).status).toBe(201);
    await settle(t);
    expect(model.calls.length).toBe(before);
    expect(verdictsOf(t).map((v) => v.ai)).toEqual(["skipped"]);
  });

  it("reports the month's filter-days, checks and tokens in usage", async () => {
    const { t, host, owner } = await liveInbox("pro", SPAM);
    const off = await rt.http(host, "PUT", "/v1/owner/spam/filters/junk", {
      headers: owner,
      body: JSON.stringify({ on: false }),
    });
    expect(off.status).toBe(200);
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
    expect(usage.spam.filter_days).toMatchObject({ pitches: 1, scams: 1, junk: 1 });
    expect(usage.spam).toMatchObject({ judged: 1, tokens_in: 700, tokens_out: 50, aside: 1 });
    // What was put aside is not a request.
    expect(usage.items).toBe(0);
  });

  it("keeps our key out of everything an inbox shows, keeps or logs", async () => {
    const { host, cookie } = await liveInbox("pro", SPAM);
    for (const path of ["/v1/owner/settings", "/v1/owner/spam", "/v1/owner/download"]) {
      const r = await rt.http(host, "GET", path, { headers: { cookie } });
      expect(r.text, path).not.toContain(KEY);
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

/**
 * A Pro given for free (a beta tester's month, ADR-041 §15.3): the filters' known phrases and the shared
 * list work from the start, and our AI reads only once the owner turned it on in Settings → Spam. The
 * owner's switch is kept in the inbox (who, when) and told to the control plane, which decides: the AI
 * reads from the policy that says so, and a runtime that does not know `ai_owner` keeps it off.
 */
describe("a Pro given for free", () => {
  const UNTIL = "2026-11-27T00:00:00.000Z";
  const GIFT = { plan: "pro", gift: { until: UNTIL } } as const;

  it("keeps our AI off until the control plane says the owner chose it, and says until when Pro is free", () => {
    const ours = hostedModelFrom(ENV, model.fetch);
    const waiting = spamHostPolicy({ ...GIFT, spam: { ai: false, ai_owner: true } } as PolicyPayload, ours);
    expect(waiting).toMatchObject({
      plan: "pro",
      ai: false,
      filters: ["pitches", "scams", "junk"],
      defaultOn: true,
      reader: null,
      aiByOwner: true,
      ownerReader: "Claude Haiku, by Anthropic",
      giftUntil: UNTIL,
    });
    // Waiting for the owner, an `ai` left out is no.
    expect(spamHostPolicy({ ...GIFT, spam: { ai_owner: true } } as PolicyPayload, ours).ai).toBe(false);
    expect(spamHostPolicy({ ...GIFT, spam: { ai: true, ai_owner: true } } as PolicyPayload, ours)).toMatchObject({
      ai: true,
      reader: "Claude Haiku, by Anthropic",
      aiByOwner: true,
    });
    // Without our key there is nothing to switch on.
    expect(spamHostPolicy({ ...GIFT, spam: { ai: false, ai_owner: true } } as PolicyPayload, null)).toMatchObject({
      ai: false,
      aiByOwner: false,
      giftUntil: UNTIL,
    });
    // On Free, no gift is read and nothing is switched.
    expect(spamHostPolicy({ gift: { until: UNTIL }, spam: { ai_owner: true } } as PolicyPayload, ours)).toMatchObject({
      plan: "free",
      ai: false,
      aiByOwner: false,
      giftUntil: null,
    });
    expect(policyPayloadSchema.shape.gift.parse({ until: "soon" })).toBeUndefined();
    const judge = tenantJudge({
      model: ours,
      ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "sdh-spam-")), "ledger.db"), { hashKey: "k" }),
      tenantId: "tn_a",
      policy: waiting,
    });
    expect(judge).toBeNull();
  });

  it("asks no model until the owner turns it on; their switch is kept and told, and the policy decides", async () => {
    const { t, host, owner, cookie } = await liveInbox("pro", { ai: false, ai_owner: true });
    t.gift = { until: UNTIL };
    await rt.setState(t, "live", { ownResolves: true });
    type Gifted = Status & {
      gift_until: string | null;
      owner_ai: { on: boolean; chosen: boolean; chosen_at: string | null; can_switch: boolean; reader: string | null };
    };
    const status = async () => (await statusOf(host, cookie)) as Gifted;
    const first = await status();
    expect(first.gift_until).toBe(UNTIL);
    expect(first.reader).toBe("hosted_phrases");
    expect(first.owner_ai).toEqual({
      on: false,
      chosen: false,
      chosen_at: null,
      can_switch: true,
      reader: "Claude Haiku, by Anthropic",
    });
    // The filters are on, and read known phrases: no model is asked.
    expect(first.filters.every((f) => f.on)).toBe(true);
    await switchOn(host, owner, "pitches");
    const before = model.calls.length;
    expect((await send(host, PITCHES[0] as string)).status).toBe(201);
    await settle(t);
    expect(model.calls.length).toBe(before);

    // The owner turns it on: kept here, told to the control plane, and nothing read yet.
    const on = await rt.http(host, "PUT", "/v1/owner/spam/ai", { headers: owner, body: JSON.stringify({ on: true }) });
    expect(on.status, on.text).toBe(200);
    expect((on.json as Gifted).owner_ai).toMatchObject({ on: false, chosen: true, can_switch: true });
    const spans = new DatabaseSync(rt.shardOf(t).dbPath(t.tenantId));
    const kept = spans.prepare("SELECT by_kind, to_at FROM spam_filter_spans WHERE filter = 'ai'").all();
    spans.close();
    expect(kept).toEqual([{ by_kind: "owner", to_at: null }]);
    const told = () => rt.cp.events.filter((e) => e.tenant_id === t.tenantId && e.type === "spam_ai");
    for (let i = 0; i < 50 && told().length === 0; i++) {
      await rt.shardOf(t).tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(told().map((e) => e.data)).toEqual([{ on: true }]);
    expect((await send(host, PITCHES[1] as string)).status).toBe(201);
    await settle(t);
    expect(model.calls.length).toBe(before);

    // The control plane takes it: from its policy on, our AI reads.
    t.spam = { ai: true, ai_owner: true };
    await rt.setState(t, "live", { ownResolves: true });
    const after = await status();
    expect(after.reader).toBe("hosted_ai");
    expect(after.owner_ai).toMatchObject({ on: true, chosen: true });
    expect((await send(host, PITCHES[2] as string)).status).toBe(201);
    await settle(t);
    expect(model.calls.length - before).toBe(1);

    // Off again the same way.
    const off = await rt.http(host, "PUT", "/v1/owner/spam/ai", {
      headers: owner,
      body: JSON.stringify({ on: false }),
    });
    expect(off.status, off.text).toBe(200);
    expect((off.json as Gifted).owner_ai).toMatchObject({ on: true, chosen: false });
  });

  it("is not switched where the plan decides: paid Pro, Free, or a control plane that keeps it off", async () => {
    for (const [plan, spam] of [
      ["pro", undefined],
      [undefined, undefined],
      ["pro", { ai: false }],
    ] as const) {
      const { host, owner, cookie } = await liveInbox(plan, spam);
      expect(((await statusOf(host, cookie)) as Status & { owner_ai: unknown }).owner_ai).toBeNull();
      const r = await rt.http(host, "PUT", "/v1/owner/spam/ai", { headers: owner, body: JSON.stringify({ on: true }) });
      expect(r.status).toBe(403);
    }
  });
});
