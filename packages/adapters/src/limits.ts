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
  /**
   * Asking for another time than the one the business proposed (ADR-018 §6): each one mails the
   * owner and puts the item back on their desk, so ten an hour per address, which no real customer meets.
   */
  negotiate: { capacity: 10, perMs: 10 / 3_600_000 } satisfies Limit,
  /** A POST from the page a link in the business's email opens: thirty an hour per address. */
  link: { capacity: 30, perMs: 30 / 3_600_000 } satisfies Limit,
  /**
   * Inbound email from one sender address (the envelope sender, else the From), whatever door it
   * came in by: ten at once and twenty an hour. A real customer writes a handful; a loop or a
   * script writes hundreds, and every one of them is an item and an email to the owner.
   */
  emailSender: { capacity: 10, perMs: 20 / 3_600_000 } satisfies Limit,
  /**
   * All inbound email together, the business's whole mailbox (kept under `EVERYONE`): two hundred
   * at once and four hundred an hour, so senders that rotate their address are bounded as well.
   */
  email: { capacity: 200, perMs: 400 / 3_600_000 } satisfies Limit,
} as const;

export type LimitClass = keyof typeof LIMITS;

/** Limits by class, for a host that wants other numbers than `LIMITS` for some of them. */
export type LimitTable = { readonly [K in LimitClass]?: Limit };

/**
 * A public demo (INBOX_DEMO): anyone's AI can book there and nobody is behind it to clean up, so
 * every caller together shares one more bucket per class (`DEMO_SHARED`), on top of one per address.
 *
 * The per-address buckets for booking and for calling at all are wider than `LIMITS`, not tighter.
 * An assistant like Claude or ChatGPT calls from its own servers, so everyone trying the demo
 * through it arrives from a handful of shared addresses; and those calls are not signed, so the
 * demo cannot tell one person from another behind them. Twenty bookings an hour per address would
 * throttle a launch day's worth of people as if they were one. So an address may book 60 at once
 * and 300 an hour, and call 240 at once and 4 a second; the shared buckets below, which no address
 * can get round, are the real guard against a flood.
 */
export const DEMO_LIMITS: LimitTable = {
  public: { capacity: 240, perMs: 4 / 1000 },
  create: { capacity: 60, perMs: 300 / 3_600_000 },
  verify: { capacity: 5, perMs: 5 / 3_600_000 },
  negotiate: { capacity: 5, perMs: 5 / 3_600_000 },
  link: { capacity: 10, perMs: 10 / 3_600_000 },
};

/**
 * What every caller of a demo shares, whoever they are: at most about six hundred new items an hour,
 * and ten sign-in links, which only ever go to the owner, so a crowd of addresses cannot fill the
 * owner's mailbox with them.
 */
export const DEMO_SHARED: LimitTable = {
  public: { capacity: 2_000, perMs: 20 / 1000 },
  create: { capacity: 300, perMs: 600 / 3_600_000 },
  auth: { capacity: 10, perMs: 10 / 3_600_000 },
};

/** The address a shared bucket is kept under. No client address or key id can take this form. */
export const EVERYONE = "*";

export interface Verdict {
  readonly allowed: boolean;
  /** Seconds until a request would be allowed again; 0 when allowed. */
  readonly retryAfterSec: number;
}

/**
 * The address a bucket is kept under. An IPv6 client is counted by its /64: one subscriber, one
 * cloud machine or one home network is routinely handed a whole /64 and can send from any of its
 * 2^64 addresses, so a bucket per full address would be no bucket at all. IPv4, and IPv6 that
 * carries an IPv4 address (`::ffff:1.2.3.4`), are counted by the address.
 */
export function clientAddress(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return bucketAddress(cf.slice(0, 64));
  const xff = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return bucketAddress(xff.slice(0, 64));
  return "unknown";
}

/** An address as a bucket names it: IPv6 as its /64 (`2001:db8:1:2::/64`), anything else as it came. */
export function bucketAddress(address: string): string {
  const v6 = expandIpv6(address);
  if (!v6) return address;
  // An IPv4-mapped address is the IPv4 client it carries.
  if (v6.slice(0, 5).every((h) => h === 0) && v6[5] === 0xffff) {
    const [a = 0, b = 0] = v6.slice(6);
    return `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`;
  }
  return `${v6
    .slice(0, 4)
    .map((h) => h.toString(16))
    .join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address, or null for anything that is not one. */
function expandIpv6(input: string): number[] | null {
  let s = input.trim().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(":") || !/^[0-9a-fA-F:.]+$/.test(s)) return null;
  // A trailing dotted IPv4 (`::ffff:1.2.3.4`) is two groups.
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const o = dotted.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = o;
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return groups.map((g) => Number.parseInt(g, 16));
}

/**
 * Takes `cost` tokens (one, unless a request does several things at once, like a JSON-RPC batch
 * of tool calls) for (class, address). One statement: atomic on every runtime. `limit` replaces
 * the class's numbers from `LIMITS`, for a host that sets its own (a demo). A cost the bucket
 * cannot cover is refused and empties it, as a flood should.
 */
export async function consume(
  db: Db,
  cls: LimitClass,
  address: string,
  now: number,
  limit: Limit = LIMITS[cls],
  cost = 1,
): Promise<Verdict> {
  const { capacity, perMs } = limit;
  const take = Math.max(1, Math.ceil(cost));
  const bucket = `${cls}:${address}`;
  const { rows } = await db.client.query({
    sql: `INSERT INTO rate_limits (bucket, tokens, updated_at) VALUES (?, ?, ?)
          ON CONFLICT (bucket) DO UPDATE SET
            tokens = MAX(-1.0, MIN(?, rate_limits.tokens + (excluded.updated_at - rate_limits.updated_at) * ?) - ?),
            updated_at = excluded.updated_at
          RETURNING tokens`,
    params: [bucket, Math.max(-1, capacity - take), now, capacity, perMs, take],
    method: "all",
  });
  const tokens = Number(rows[0]?.[0] ?? capacity - take);
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

/** Asking for another time than the one proposed: `POST /v1/items/{id}/counter`. */
export function isNegotiateRoute(method: string, path: string): boolean {
  return method === "POST" && /^\/v1\/items\/[^/]+\/counter\/?$/.test(path);
}

/**
 * The tools a JSON-RPC body calls, a single call or a batch. It takes the body the MCP door has
 * already read and parsed, once: the door reads a request's body exactly once and hands the parsed
 * value to everything that needs it, so no copy of the body is ever left unread (index.ts).
 */
export function mcpToolNames(body: unknown): string[] {
  const calls = Array.isArray(body) ? body : [body];
  return calls.flatMap((m) => {
    if (typeof m !== "object" || m === null) return [];
    const msg = m as { method?: unknown; params?: { name?: unknown } | null };
    return msg.method === "tools/call" && typeof msg.params?.name === "string" ? [msg.params.name] : [];
  });
}

/** MCP tools that send or check a one-time code. */
export function mcpVerifies(body: unknown): boolean {
  return mcpToolNames(body).includes("verify_customer");
}

/** MCP tools that ask for another time than the one proposed. */
export function mcpNegotiates(body: unknown): boolean {
  return mcpToolNames(body).includes("suggest_time");
}

/** MCP tools that create an item. The body is JSON-RPC, a single call or a batch. */
const CREATE_TOOLS = new Set(["create_booking", "create_order", "request_quote", "send_message"]);

export function mcpCreates(body: unknown): boolean {
  return mcpToolNames(body).some((name) => CREATE_TOOLS.has(name));
}

/**
 * The tokens a JSON-RPC body costs, per class: one for each tool call that creates an item, sends
 * or checks a code, or asks for another time, and one `public` for every message past the first
 * (the first paid for the request before its body was read). A batch of a thousand bookings is a
 * thousand bookings, not one: counted by the request, a single POST would get round every bucket.
 */
export function mcpCosts(body: unknown): Partial<Record<LimitClass, number>> {
  const names = mcpToolNames(body);
  const count = (pick: (n: string) => boolean) => names.filter(pick).length;
  const messages = Array.isArray(body) ? body.length : body === undefined ? 0 : 1;
  const costs: Partial<Record<LimitClass, number>> = {
    create: count((n) => CREATE_TOOLS.has(n)),
    verify: count((n) => n === "verify_customer"),
    negotiate: count((n) => n === "suggest_time"),
    public: Math.max(0, messages - 1),
  };
  for (const k of Object.keys(costs) as LimitClass[]) if (!costs[k]) delete costs[k];
  return costs;
}
