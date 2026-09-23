import type { Db } from "@surfingdog/core";

/**
 * Rate limits for the doors anyone can open (ADR-007's `rate_limits` table, unused until 22 Sep
 * 2026). Without them one script could post ten thousand bookings, and every one of them mails the
 * owner: an email bill, a sender reputation, and an owner who cannot find the real customer in the
 * pile. The owner's own calls — a verified owner key, session or OAuth token — are never limited;
 * an integration key the owner minted for another system has a soft bucket of its own.
 *
 * A token bucket per client address and class, kept in SQLite as one row and moved by ONE
 * statement, so it holds on D1, node:sqlite and a Durable Object alike with no transaction:
 *
 *   tokens := max(-1, min(capacity, tokens + elapsed × rate) − 1); allowed ⇔ tokens ≥ 0
 *
 * The floor of −1 is deliberate. A client that keeps knocking after it was refused pins itself at
 * −1 with every request and never earns a token back; one that pauses recovers after two tokens'
 * worth of quiet instead of one. A burst is fine, a flood stays shut.
 *
 * The client address is Cloudflare's CF-Connecting-IP when present, which Cloudflare overwrites and
 * a client cannot forge — as long as the origin cannot be reached around Cloudflare. Behind any
 * other proxy it is the first X-Forwarded-For hop, which a client CAN forge; an instance exposed
 * directly should firewall its origin to its proxy, which is advice worth taking anyway.
 */
export interface Limit {
  readonly capacity: number;
  /** Tokens returned per millisecond. */
  readonly perMs: number;
}

/**
 * The classes, generous to a real agent and shut to a flood. An AI agent platform sends many of
 * its users' requests from a handful of shared addresses, so these are per address but sized for
 * that: a single small business does not take twenty bookings an hour from one agent platform.
 */
export const LIMITS = {
  /** Anything that writes or calls a tool, from anyone who is not the owner. A pure flood guard. */
  public: { capacity: 120, perMs: 2 / 1000 } satisfies Limit,
  /** Creating an item: a booking, order, quote request or message — the ones that mail the owner. */
  create: { capacity: 20, perMs: 20 / 3_600_000 } satisfies Limit,
  /** Asking for a sign-in link, so nobody can fill an owner's mailbox with them. */
  auth: { capacity: 5, perMs: 1 / 180_000 } satisfies Limit,
  /**
   * One integration key (a key the owner minted for Zapier, a shop, a till), every call it makes.
   * Soft: ten a second for as long as it likes, and a minute's burst on top. It is there to stop a
   * loop — a webhook that triggers a Zap that moves the item that fires the webhook — from running
   * for ever, not to meter a real integration. The owner's own session, key and AI are never counted.
   */
  integration: { capacity: 600, perMs: 600 / 60_000 } satisfies Limit,
  /**
   * One-time codes for customers the business knows (ADR-017 §8.2): asking for one and checking it,
   * 30 an hour per address. Each address a code goes to has its own limit besides (3 an hour).
   */
  verify: { capacity: 30, perMs: 30 / 3_600_000 } satisfies Limit,
  /** Every request a platform's agents sign (Web Bot Auth), together: wide, since a platform speaks for many people (§2.4). */
  platform: { capacity: 6_000, perMs: 100 / 1000 } satisfies Limit,
  /** A Web Bot Auth directory this inbox has not fetched before: one new origin a minute per address (§2.4). */
  directory: { capacity: 1, perMs: 1 / 60_000 } satisfies Limit,
} as const;

export type LimitClass = keyof typeof LIMITS;

export interface Verdict {
  readonly allowed: boolean;
  /** Seconds until a request would be allowed again; 0 when allowed. */
  readonly retryAfterSec: number;
}

export function clientAddress(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf.slice(0, 64);
  const xff = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff.slice(0, 64);
  return "unknown";
}

/** Takes one token for (class, address). One statement: atomic on every runtime. */
export async function consume(db: Db, cls: LimitClass, address: string, now: number): Promise<Verdict> {
  const { capacity, perMs } = LIMITS[cls];
  const bucket = `${cls}:${address}`;
  const { rows } = await db.client.query({
    sql: `INSERT INTO rate_limits (bucket, tokens, updated_at) VALUES (?, ?, ?)
          ON CONFLICT (bucket) DO UPDATE SET
            tokens = MAX(-1.0, MIN(?, rate_limits.tokens + (excluded.updated_at - rate_limits.updated_at) * ?) - 1.0),
            updated_at = excluded.updated_at
          RETURNING tokens`,
    params: [bucket, capacity - 1, now, capacity, perMs],
    method: "all",
  });
  const tokens = Number(rows[0]?.[0] ?? capacity - 1);
  if (tokens >= 0) return { allowed: true, retryAfterSec: 0 };
  // At −1, two tokens' worth of quiet brings the next request back to 0.
  return { allowed: false, retryAfterSec: (1 - tokens) / perMs / 1000 };
}

/** Buckets untouched for a day are full by now anyway; the hourly tick drops them. */
export async function pruneRateLimits(db: Db, now: number): Promise<void> {
  await db.client.query({
    sql: "DELETE FROM rate_limits WHERE updated_at < ?",
    params: [now - 24 * 3_600_000],
    method: "run",
  });
}

/** The one-time code routes (ADR-017 §8.2). */
export function isVerifyRoute(method: string, path: string): boolean {
  return method === "POST" && /^\/v1\/customers\/verify\/?$/.test(path);
}

/** Public REST routes that create an item, and so mail the owner. */
const CREATE_PATHS = /^\/v1\/(bookings|orders|quotes|messages)\/?$/;

export function isCreateRoute(method: string, path: string): boolean {
  return method === "POST" && CREATE_PATHS.test(path);
}

/** MCP tools that send or check a one-time code. */
export async function mcpVerifies(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  try {
    const body = (await request.clone().json()) as unknown;
    const calls = Array.isArray(body) ? body : [body];
    return calls.some((m) => {
      const msg = m as { method?: unknown; params?: { name?: unknown } };
      return msg.method === "tools/call" && msg.params?.name === "verify_customer";
    });
  } catch {
    return false;
  }
}

/** MCP tools that create an item. The body is JSON-RPC, a single call or a batch. */
const CREATE_TOOLS = new Set(["create_booking", "create_order", "request_quote", "send_message"]);

export async function mcpCreates(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  try {
    const body = (await request.clone().json()) as unknown;
    const calls = Array.isArray(body) ? body : [body];
    return calls.some((m) => {
      const msg = m as { method?: unknown; params?: { name?: unknown } };
      return msg.method === "tools/call" && typeof msg.params?.name === "string" && CREATE_TOOLS.has(msg.params.name);
    });
  } catch {
    return false;
  }
}
