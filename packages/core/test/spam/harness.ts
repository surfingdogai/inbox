import { LOCAL_SENDER, type MailOut, type OutboundMail, runMigrations } from "@surfingdog/platform";
import { Capabilities } from "../../src/capabilities/service";
import { createDb, type Db } from "../../src/db";
import { ulid } from "../../src/ids";
import { createRunner } from "../../src/jobs/index";
import { MIGRATIONS } from "../../src/schema/migrations.generated";
import { business, products, services } from "../../src/schema/tables";
import { createSecretBox } from "../../src/secrets/box";
import type { JudgePort, JudgeRequest, JudgeResult } from "../../src/spam/judge";
import type { SpamHostPolicy } from "../../src/spam/screen";
import type { Filter, FilterChoice } from "../../src/spam/types";
import type { Caller } from "../../src/write/caller";
import { confirming, makeClient, openAllWeek, resetTables } from "../harness";

/**
 * What the spam filter's tests share: a small business with a few services and products, the
 * runner every effect goes through, a clock, the callers at each door, and a model that answers
 * whatever a test tells it to (never a real one: no test calls anything outside this process).
 */

export const T0 = Date.parse("2026-10-26T09:00:00Z"); // a Monday
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const BASE = "https://inbox.kopisenja.example";

export interface RawAnswer {
  check: string;
  kind: string;
  certainty: string;
  customer_intent: boolean;
  talks_to_filter: boolean;
  topic: string;
  quotes: string[];
}

/** The check value the prompt asks the model to echo. */
export function nonceOf(req: JudgeRequest): string {
  return /Put this value in check, exactly as written: (\S+)/.exec(req.system)?.[1] ?? "";
}

/** The text between the two boundary lines of the user message: what the model was sent of the message. */
export function sentText(req: JudgeRequest): string {
  const lines = req.user.split("\n");
  const boundary = lines.find((l) => /^----- [A-Za-z0-9_-]{22} -----$/.test(l));
  if (!boundary) return "";
  const first = lines.indexOf(boundary);
  const last = lines.lastIndexOf(boundary);
  return lines.slice(first + 1, last).join("\n");
}

export type FakeJudge = JudgePort & { calls: JudgeRequest[] };

/**
 * A model that answers as the test says: an answer (the check value filled in for it), a function of
 * the request, or a failure. It records every request.
 */
export function fakeJudge(
  answer: Partial<RawAnswer> | ((req: JudgeRequest) => Partial<RawAnswer> | JudgeResult | Promise<JudgeResult>),
): FakeJudge {
  const calls: JudgeRequest[] = [];
  return {
    calls,
    async judge(req) {
      calls.push(req);
      const given = typeof answer === "function" ? await answer(req) : answer;
      if ("ok" in given) return given as JudgeResult;
      const raw: RawAnswer = {
        check: nonceOf(req),
        kind: "unclear",
        certainty: "low",
        customer_intent: false,
        talks_to_filter: false,
        topic: "none",
        quotes: [],
        ...(given as Partial<RawAnswer>),
      };
      return { ok: true, answer: raw, tokensIn: 1_800, tokensOut: 80, ms: 5 };
    },
  };
}

/** The mail that would have gone, kept for the test. */
export function memoryMail(): MailOut & { sent: OutboundMail[] } {
  const sent: OutboundMail[] = [];
  return {
    sent,
    sender: LOCAL_SENDER,
    async send(mail) {
      sent.push(mail);
      return { messageId: `m-${sent.length}-${crypto.randomUUID()}` };
    },
  };
}

export const owner = (t: number): Caller => ({
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
});

export const ownerAi = (t: number): Caller => ({
  actor: { kind: "owner_ai", id: "app_1", channel: "mcp_owner" },
  tier: "verified_principal",
  sandbox: false,
  principal: { via: "oauth", id: "app_1", name: "An assistant", scopes: ["*"], userId: "user_1" },
  now: () => t,
});

/**
 * An assistant on the agent doors: unsigned, signed with its own key, or signed with a platform's key
 * (`platform`: the directory the key came from, which signs for every one of the platform's users).
 */
export const agent = (
  t: number,
  o: { key?: string; level?: "self" | "vouched"; platform?: string; carriedFor?: string; idem?: string } = {},
): Caller => ({
  actor: { kind: "customer_agent", id: `agent:${o.key ?? "anon"}`, channel: "rest" },
  tier: o.key ? "signed_agent" : "anonymous",
  sandbox: false,
  ...(o.key
    ? { agent: { level: o.level ?? "self", thumbprint: o.key, ...(o.platform ? { platform: o.platform } : {}) } }
    : {}),
  ...(o.carriedFor ? { carriedFor: o.carriedFor, viaNetwork: true } : {}),
  ...(o.idem ? { idempotency: { scope: `agent:${o.key ?? "anon"}`, key: o.idem } } : {}),
  now: () => t,
});

export const visitor = (t: number): Caller => ({
  actor: { kind: "customer_human", id: `anon:${ulid(t)}`, channel: "form" },
  tier: "anonymous",
  sandbox: false,
  now: () => t,
});

export interface SpamSetup {
  readonly db: Db;
  readonly caps: Capabilities;
  readonly mail: MailOut & { sent: OutboundMail[] };
  readonly svc: string;
  readonly product: string;
  readonly drain: (t: number) => Promise<void>;
  readonly runOnce: (t: number) => Promise<number>;
  readonly q: (sql: string, params?: unknown[]) => Promise<unknown[][]>;
}

/**
 * A hosted inbox's spam policy (ADR-041 §15.3): Pro, its three filters, the host's AI reading, 150
 * checks a day and 1,500 a month, filters not switched on by the plan unless a test says so.
 */
export function hostPolicy(over: Partial<SpamHostPolicy> = {}): SpamHostPolicy {
  return {
    plan: "pro",
    ai: true,
    filters: ["pitches", "scams", "junk"],
    defaultOn: false,
    dayCap: 150,
    monthCap: 1_500,
    reader: null,
    ...over,
  };
}

export async function spamSetup(
  o: {
    readonly filters?: readonly Filter[];
    readonly choice?: FilterChoice;
    /** Leave the filters in their learning week (default: past it). */
    readonly learning?: boolean;
    /** Leave the free protection in its learning week (default: past it). */
    readonly basicLearning?: boolean;
    readonly judge?: JudgePort | null;
    readonly host?: SpamHostPolicy | null;
    readonly resolveMail?: ((domain: string) => Promise<boolean | null>) | null;
    readonly secrets?: boolean;
    readonly listeners?: boolean;
  } = {},
): Promise<SpamSetup> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const secrets = o.secrets === false ? null : createSecretBox(["spam-filter-test-secret-0123456789abcdef"]);
  const caps = confirming(new Capabilities(db, secrets, BASE));
  await db.orm.insert(business).values({
    id: "self",
    name: "Kopi Senja",
    domain: "kopisenja.example",
    timezone: "Asia/Jakarta",
    currency: "IDR",
    languages: ["id", "en"],
    createdAt: T0,
    updatedAt: T0,
  });
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Latte art class",
    durationMin: 60,
    capacity: 4,
    granularityMin: 30,
    price: { model: "fixed", value: 250_000_00, currency: "IDR" },
    createdAt: T0,
    updatedAt: T0,
  });
  const product = ulid();
  await db.orm.insert(products).values({
    id: product,
    name: "Toraja beans 250g",
    price: { value: 95_000_00, currency: "IDR" },
    createdAt: T0,
    updatedAt: T0,
  });
  // The filter is not about hours: the class takes bookings at any hour, so a test books when it likes.
  await openAllWeek(db);
  await caps.updateSettings(owner(T0), {
    doc: {
      business: { name: "Kopi Senja", timezone: "Asia/Jakarta" },
      notifications: { ownerEmail: "owner@kopisenja.example" },
      email: { fromAddress: "hello@kopisenja.example" },
      directory: { description: "A coffee roaster and café with classes.", url: "https://kopisenja.example" },
    },
  });
  // The free protection's learning week started when the database was made: past it, unless asked.
  if (!o.basicLearning) {
    await db.client.query({ sql: "UPDATE spam_filter_spans SET learning_until = 0 WHERE id = 'basic'", method: "run" });
  }
  for (const filter of o.filters ?? []) {
    await caps.spam.setFilter(
      owner(T0 - DAY),
      { filter, on: true, ...(o.choice ? { choice: o.choice } : {}) },
      T0 - 8 * DAY,
    );
  }
  if (!o.learning) {
    await db.client.query({
      sql: "UPDATE spam_filter_spans SET learning_until = 0 WHERE filter <> 'basic'",
      method: "run",
    });
  }
  caps.spam.attach({
    judge: o.judge ?? null,
    host: o.host ?? null,
    resolveMail: o.resolveMail ?? null,
  });
  if (o.listeners) {
    await db.client.query({
      sql: `INSERT INTO webhooks (id, url, events, secret_enc, active, created_at, updated_at)
            VALUES ('wh_1', 'https://hooks.kopisenja.example/in', '["*"]', 'sealed', 1, ?, ?)`,
      params: [T0, T0],
      method: "run",
    });
  }
  const mail = memoryMail();
  const runner = createRunner({ mailOut: mail, secrets, baseUrl: BASE, spam: caps.spam });
  // Webhooks fan out to nobody here: what matters is whether the job was written and what it did.
  runner.register("webhook_fanout", async () => ({ note: "fanned out" }));
  const drain = async (t: number) => {
    for (let i = 0; i < 20; i++) if ((await runner.runDue(db, { now: t, limit: 100 })).claimed === 0) return;
  };
  const runOnce = async (t: number) => (await runner.runDue(db, { now: t, limit: 100 })).claimed;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.client.query({ sql, params: params as never, method: "all" })).rows as unknown[][];
  return { db, caps, mail, svc, product, drain, runOnce, q };
}

/** The id of what a create door answered, whichever door it was. */
export const idOf = (r: unknown): string => (r as { view: { item: { id: string } } }).view.item.id;

/** A booking request's payload for the class, a few days out. */
export function classPayload(svc: string, at: number = T0 + 3 * DAY + HOUR) {
  return {
    reservationFor: { serviceId: svc, name: "Latte art class" },
    startTime: new Date(at).toISOString(),
    endTime: new Date(at + HOUR).toISOString(),
  };
}
