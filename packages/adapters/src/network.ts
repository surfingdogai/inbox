import {
  type Db,
  ensureJob,
  type JobHandler,
  NETWORK_RECEIPT_KIND,
  pruneJobs,
  readSettings,
  schema,
} from "@surfingdog/core";
import { eq } from "drizzle-orm";
import { pruneRateLimits } from "./limits";
import { isPublicHost } from "./safe-fetch";
import { pruneWebhookDeliveries, webhookSettings } from "./webhooks/deliver";

/**
 * Membership of a Surfing Dog network (ADR-013): the instance registers its domain once and then
 * reports counts-only telemetry every hour — how many bookings, orders, quotes and messages were
 * created in the last 24 h, its software version and runtime. Nothing about customers leaves the
 * instance. The network is a setting (`network.url`), so any directory that speaks the same two
 * endpoints works; `network.join` is the switch.
 */
export const NETWORK_PING_KIND = "network_ping";
export { NETWORK_RECEIPT_KIND };
export const PING_PERIOD_MS = 60 * 60_000;
const PRUNE_AFTER_MS = 7 * 24 * 3_600_000;

export interface NetworkDeps {
  /**
   * This instance's public URL; its hostname is the domain registered with the network. Optional
   * because a Workers deploy has no env var to put it in, so the ping falls back to the Inbox
   * address the owner already types into Settings.
   */
  readonly baseUrl?: string | undefined;
  readonly version: string;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface PingCounts {
  bookings: number;
  orders: number;
  quotes: number;
  messages: number;
}

export function pingDedupeKey(now: number): string {
  return `${NETWORK_PING_KIND}:${Math.floor(now / PING_PERIOD_MS)}`;
}

/** Makes sure a ping is queued for the current period; safe to call on every boot and cron tick. */
export async function ensureNetworkPing(db: Db, now = Date.now()): Promise<void> {
  await ensureJob(db, NETWORK_PING_KIND, pingDedupeKey(now), { now });
}

export async function countLast24h(db: Db, now: number): Promise<PingCounts> {
  const { rows } = await db.client.query({
    sql: "SELECT type, COUNT(*) FROM items WHERE sandbox = 0 AND created_at >= ? GROUP BY type",
    params: [now - 24 * 3_600_000],
    method: "all",
  });
  const counts: PingCounts = { bookings: 0, orders: 0, quotes: 0, messages: 0 };
  for (const r of rows) {
    const n = Number(r[1]);
    switch (String(r[0])) {
      case "booking":
        counts.bookings = n;
        break;
      case "order":
        counts.orders = n;
        break;
      case "quote_request":
        counts.quotes = n;
        break;
      case "message":
        counts.messages = n;
        break;
      default:
        break;
    }
  }
  return counts;
}

export function runtimeName(db: Db): string {
  const kind = db.client.kind;
  return kind === "d1" ? "workers" : kind;
}

/** The job: schedules its successor first, then registers if needed and pings. */
export function networkPingHandler(deps: NetworkDeps): JobHandler {
  return async (_job, { db, now }) => {
    await ensureJob(db, NETWORK_PING_KIND, pingDedupeKey(now + PING_PERIOD_MS), {
      now,
      runAt: (Math.floor(now / PING_PERIOD_MS) + 1) * PING_PERIOD_MS + Math.floor(Math.random() * 120_000),
    });
    await pruneJobs(db, PRUNE_AFTER_MS, now);
    const settings = await readSettings(db);
    // The hourly tick is the instance's only housekeeping: an unbounded delivery log is how a
    // database reaches its size cap (ADR-015).
    await pruneWebhookDeliveries(db, webhookSettings(settings).retainDeliveryDays * 86_400_000, now);
    // Rate-limit buckets untouched for a day are full again; keeping them is only a table that grows.
    await pruneRateLimits(db, now);
    if (!settings.network.join) return { note: "not joined; enable network.join in Settings" };
    const base = deps.baseUrl ?? settings.notifications.appUrl;
    if (!base) return { note: "no public URL; set the Inbox address in Settings (or INBOX_PUBLIC_URL)" };
    const instance = new URL(base);
    const network = new URL(settings.network.url);
    if (instance.protocol !== "https:" || !isPublicHost(instance.hostname)) {
      return { note: `instance URL ${instance.origin} is not a public https origin; the network cannot verify it` };
    }
    if (network.protocol !== "https:" || !isPublicHost(network.hostname)) {
      return { note: `network URL ${network.origin} is not a public https origin` };
    }
    const result = await ping(deps, db, instance.hostname, network, now);
    return { note: result };
  };
}

async function ping(deps: NetworkDeps, db: Db, domain: string, network: URL, now: number): Promise<string> {
  const body = JSON.stringify({ version: deps.version, runtime: runtimeName(db), counts: await countLast24h(db, now) });
  const first = await post(deps, `${network.origin}/v1/instances/${encodeURIComponent(domain)}/ping`, body);
  if (first.status === 204) return `pinged ${network.host} as ${domain}`;
  if (first.status !== 404) throw new Error(`ping ${network.host}: HTTP ${first.status} ${first.text.slice(0, 200)}`);
  const reg = await post(deps, `${network.origin}/v1/instances`, JSON.stringify({ domain }));
  if (reg.status >= 300)
    throw new Error(`register ${domain} at ${network.host}: HTTP ${reg.status} ${reg.text.slice(0, 200)}`);
  const second = await post(deps, `${network.origin}/v1/instances/${encodeURIComponent(domain)}/ping`, body);
  if (second.status === 204) return `registered ${domain} at ${network.host} and pinged`;
  return `registered ${domain} at ${network.host}; verification pending (ping HTTP ${second.status})`;
}

async function post(deps: NetworkDeps, url: string, body: string): Promise<{ status: number; text: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      body,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": `surfingdog-inbox/${deps.version}`,
      },
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Publishes one receipt to the joined network (ADR-016): `POST <network>/v1/receipts` with the
 * receipt and, once there is one, the acknowledgement. The network verifies both against the
 * keys in our own manifest, so there is nothing to authenticate here beyond the signatures.
 *
 * What retries and what does not: the network not knowing us yet (404: registration and
 * verification happen on the hourly ping), a stale copy of our keys on its side (422 unknown_key:
 * it refreshes on its own), rate limits and server errors all retry with the job's backoff. Any
 * other refusal is the network's verdict on the receipt itself, and is recorded once.
 */
export function networkReceiptHandler(deps: NetworkDeps): JobHandler {
  return async (job, { db }) => {
    const p = job.payload as { receiptId: string; stage: string };
    const [row] = await db.orm.select().from(schema.receipts).where(eq(schema.receipts.id, p.receiptId));
    if (!row) return { note: `receipt ${p.receiptId} is gone; nothing published` };
    const settings = await readSettings(db);
    if (!settings.network.join) return { note: "not joined; nothing published" };
    const network = new URL(settings.network.url);
    if (network.protocol !== "https:" || !isPublicHost(network.hostname)) {
      return { note: `network URL ${network.origin} is not a public https origin` };
    }
    const body = JSON.stringify({ receipt: row.jws, ...(row.ackJws ? { ack: row.ackJws } : {}) });
    const res = await post(deps, `${network.origin}/v1/receipts`, body);
    if (res.status >= 200 && res.status < 300) {
      return { note: `published ${p.stage} receipt ${row.id} to ${network.host}` };
    }
    const retry =
      res.status === 404 ||
      res.status === 429 ||
      res.status >= 500 ||
      (res.status === 422 && res.text.includes("unknown_key"));
    if (retry) throw new Error(`publish to ${network.host}: HTTP ${res.status} ${res.text.slice(0, 200)}`);
    return { note: `${network.host} refused receipt ${row.id}: HTTP ${res.status} ${res.text.slice(0, 200)}` };
  };
}
