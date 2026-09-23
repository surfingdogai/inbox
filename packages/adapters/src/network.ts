import {
  canonicalNetworkOrigin,
  type Db,
  enabledNetworks,
  ensureJob,
  isNetworkDown,
  type JobHandler,
  type JobRow,
  NETWORK_PING_KIND,
  NETWORK_PING_ONE_KIND,
  NETWORK_PUBLISH_KIND,
  NETWORK_RECEIPT_KIND,
  type NetworkJobPayload,
  type NetworkReceiptPayload,
  networkFailureStatement,
  networkPublicationStatement,
  networkReceiptStatements,
  networkStartStatements,
  networkSuccessStatement,
  PING_PERIOD_MS,
  type PublishPayload,
  pingDedupeKey,
  pruneIdempotencyKeys,
  pruneJobs,
  publishKey,
  type ReceiptStage,
  type Registration,
  readNetworkStatus,
  readSettings,
  reportsTo,
  type Settings,
  shortError,
} from "@surfingdog/core";
import type { Statement } from "@surfingdog/platform";
import { pruneRateLimits } from "./limits";
import { isPublicHost, readCapped } from "./safe-fetch";
import { pruneWebhookDeliveries, webhookSettings } from "./webhooks/deliver";

/**
 * Membership of Surfing Dog networks (ADR-013, ADR-017 §8.1). An inbox reports to every network
 * switched on in `settings.networks`, a map keyed by origin, and each one gets the same three
 * calls: the instance registers its domain (`POST /v1/instances`), pings every hour with its
 * version, runtime and the counts of items created in the last 24 h
 * (`POST /v1/instances/{domain}/ping`), and publishes every receipt and acknowledgement
 * (`POST /v1/receipts`). Nothing about customers leaves: a receipt names them by pseudonym only.
 *
 * Each network has its own jobs and its own lane in the runner, so one that is slow or down
 * retries on its own schedule and never delays another, or any request. Every call is time-boxed,
 * every outcome is written to `network_status` for the owner, and nothing a network answers is
 * ever thrown into a request.
 */
export {
  NETWORK_PING_KIND,
  NETWORK_PING_ONE_KIND,
  NETWORK_PUBLISH_KIND,
  NETWORK_RECEIPT_KIND,
  PING_PERIOD_MS,
  pingDedupeKey,
};

const PRUNE_AFTER_MS = 7 * 24 * 3_600_000;
/** One call to a network: connection, answer and body, all inside this. */
const CALL_TIMEOUT_MS = 5_000;
/** Registering again while the network has not verified us yet: at most once a day. */
const REGISTER_EVERY_MS = 24 * 3_600_000;
/** A ping or a publisher that keeps failing gives up after this many tries; the next hour tries again. */
const TRIES_PER_HOUR = 3;
/** Receipts one publisher run posts, and the wall-clock time it may take. */
const PUBLISH_BATCH = 25;
const PUBLISH_TIME_BOX_MS = 10_000;
/** Receipts queued and posted per network per hour, at most (ADR-017 §3.3). */
const PUBLISH_PER_HOUR = 1_000;
const MAX_BODY = 16 * 1024;

export interface NetworkDeps {
  /**
   * This instance's public URL; its hostname is the domain registered with each network. Optional
   * because a Workers deploy has no env var to put it in, so the ping falls back to the Inbox
   * address the owner already types into Settings.
   */
  readonly baseUrl?: string | undefined;
  readonly version: string;
  readonly fetchImpl?: typeof fetch | undefined;
  /** Per call; defaults to five seconds. */
  readonly timeoutMs?: number | undefined;
  /** Receipts per publisher run (25) and per network per hour (1000); smaller only in tests. */
  readonly publishBatch?: number | undefined;
  readonly publishPerHour?: number | undefined;
}

export interface PingCounts {
  bookings: number;
  orders: number;
  quotes: number;
  messages: number;
}

/** Makes sure the hourly tick is queued for the current period; safe on every boot and cron tick. */
export async function ensureNetworkPing(db: Db, now = Date.now()): Promise<void> {
  await ensureJob(db, NETWORK_PING_KIND, pingDedupeKey(now), { now });
}

/** Queues a tick now that pings every network that is on, whatever was already sent this hour. */
export async function pingNetworksNow(db: Db, now = Date.now()): Promise<void> {
  await ensureJob(db, NETWORK_PING_KIND, `${NETWORK_PING_KIND}:manual:${now}`, { now, payload: { force: true } });
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

// ---- the hourly tick ----------------------------------------------------------------------

/**
 * The tick: schedules its successor first, does the instance's housekeeping once, then queues one
 * ping and one publisher for every network that is switched on. It calls no network itself.
 */
export function networkPingHandler(_deps?: NetworkDeps): JobHandler {
  return async (job, { db, now }) => {
    await ensureJob(db, NETWORK_PING_KIND, pingDedupeKey(now + PING_PERIOD_MS), {
      now,
      runAt: (Math.floor(now / PING_PERIOD_MS) + 1) * PING_PERIOD_MS + Math.floor(Math.random() * 120_000),
    });
    await pruneJobs(db, PRUNE_AFTER_MS, now);
    // A dead network job owes nothing: what it was carrying is still queued in network_publications.
    await db.client.query({
      sql: "DELETE FROM jobs WHERE status = 'dead' AND kind IN (?, ?, ?) AND created_at < ?",
      params: [NETWORK_RECEIPT_KIND, NETWORK_PUBLISH_KIND, NETWORK_PING_ONE_KIND, now - PRUNE_AFTER_MS],
      method: "run",
    });
    const settings = await readSettings(db);
    // The hourly tick is the instance's only housekeeping: an unbounded delivery log is how a
    // database reaches its size cap (ADR-015).
    await pruneWebhookDeliveries(db, webhookSettings(settings).retainDeliveryDays * 86_400_000, now);
    // Rate-limit buckets untouched for a day are full again; keeping them is only a table that grows.
    await pruneRateLimits(db, now);
    // Idempotency keys are for retries, not a record: thirty days is long past any retry.
    await pruneIdempotencyKeys(db, now);
    const force = (job.payload as { force?: unknown } | null)?.force === true;
    const on = Object.entries(settings.networks).filter(([, entry]) => reportsTo(entry));
    if (on.length === 0) return { note: "no network is switched on; add or switch one on in Settings → Networks" };
    await db.batch(on.flatMap(([origin, entry]) => networkStartStatements(origin, entry, now, { force })));
    return { note: `reporting to ${on.map(([origin]) => new URL(origin).host).join(", ")}` };
  };
}

// ---- one network's ping -------------------------------------------------------------------

/**
 * One network's hourly ping. A network that does not know this instance yet (404) gets a
 * registration, at most once a day while it has not verified us, and then the ping again. Any 2xx
 * is a ping taken: an unsigned ping gets 204 and a signed one 200 with a body (ADR-017 §7.1).
 */
export function networkPingOneHandler(deps: NetworkDeps): JobHandler {
  return async (job, { db, now }) => {
    const { network } = job.payload as NetworkJobPayload;
    const settings = await readSettings(db);
    const entry = settings.networks[network];
    if (!reportsTo(entry)) return { note: `${network} is switched off; nothing sent` };
    const host = hostOf(network);
    if (canonicalNetworkOrigin(network) !== network) return { note: `${network} is not a network origin` };

    const instance = instanceDomain(deps, settings);
    if ("problem" in instance) {
      await db.client.query(networkFailureStatement(network, now, instance.problem, { down: false }));
      return { note: instance.problem };
    }
    const domain = instance.domain;
    const body = JSON.stringify({
      version: deps.version,
      runtime: runtimeName(db),
      ...(entry.share.counts ? { counts: await countLast24h(db, now) } : {}),
    });
    const pingUrl = `${network}/v1/instances/${encodeURIComponent(domain)}/ping`;

    const first = await call(deps, pingUrl, body);
    if (isOk(first)) {
      await db.client.query(networkSuccessStatement(network, now, { registration: "registered", pinged: true }));
      return { note: `pinged ${host} as ${domain}` };
    }
    if (!("status" in first) || first.status !== 404) return fail(db, job, network, now, "ping", first);

    const status = await readNetworkStatus(db, network);
    if (status?.registeredAt && now - status.registeredAt < REGISTER_EVERY_MS) {
      await db.client.query(networkSuccessStatement(network, now, { registration: "pending" }));
      return {
        note: `${host} has not verified ${domain} yet; registered ${new Date(status.registeredAt).toISOString()}`,
      };
    }
    const reg = await call(deps, `${network}/v1/instances`, JSON.stringify({ domain }));
    // 409: it knows the domain already, which is as good as a registration.
    if (!isOk(reg) && !("status" in reg && reg.status === 409)) return fail(db, job, network, now, "register", reg);
    const second = await call(deps, pingUrl, body);
    if (isOk(second)) {
      await db.client.query(
        networkSuccessStatement(network, now, { registration: "registered", registeredAt: now, pinged: true }),
      );
      return { note: `registered ${domain} at ${host} and pinged` };
    }
    await db.client.query(networkSuccessStatement(network, now, { registration: "pending", registeredAt: now }));
    return {
      note: `registered ${domain} at ${host}; verification pending (ping ${"status" in second ? `HTTP ${second.status}` : second.error})`,
    };
  };
}

// ---- publishing ---------------------------------------------------------------------------

/**
 * One receipt at one stage for one network, the moment it is issued or acknowledged. What this job
 * does not deliver stays queued in `network_publications`, and the hourly publisher sends it, so
 * a job that dies loses nothing. While the network has stopped answering (the circuit breaker),
 * the job does not call it at all.
 */
export function networkReceiptHandler(deps: NetworkDeps): JobHandler {
  return async (job, { db, now }) => {
    const p = job.payload as NetworkReceiptPayload;
    if (typeof p.network !== "string") {
      // Queued before there were several networks: hand it to every network that takes receipts.
      const networks = enabledNetworks(await readSettings(db), "receipts");
      if (networks.length) {
        await db.batch(networks.flatMap((n) => networkReceiptStatements(n, p.stage, now, { id: p.receiptId })));
      }
      return { note: `handed ${p.stage} receipt ${p.receiptId} to ${networks.length} network(s)` };
    }
    const network = p.network;
    const entry = (await readSettings(db)).networks[network];
    if (!entry?.enabled || !entry.share.receipts) {
      return { note: `${network} is switched off; the receipt stays queued for it` };
    }
    // The row normally exists already (it is written with the receipt); this covers any that do not.
    await db.client.query(networkPublicationStatement(network, p.stage, now, { id: p.receiptId }));
    const { rows } = await db.client.query({
      sql: `SELECT p.state, r.jws, r.ack_jws FROM network_publications p JOIN receipts r ON r.id = p.receipt_id
             WHERE p.receipt_id = ? AND p.network = ? AND p.stage = ?`,
      params: [p.receiptId, network, p.stage],
      method: "all",
    });
    const row = rows[0];
    if (!row) return { note: `receipt ${p.receiptId} is gone; nothing published` };
    if (String(row[0]) !== "queued") return { note: `${p.stage} receipt ${p.receiptId} already ${String(row[0])}` };
    if (isNetworkDown(await readNetworkStatus(db, network), now)) {
      throw new Error(`deferred: ${hostOf(network)} is not answering; the hourly publisher will send it`);
    }
    const receipt = { id: p.receiptId, jws: String(row[1]), ackJws: row[2] === null ? null : String(row[2]) };
    const outcome = await publishOne(deps, db, network, receipt, p.stage, now);
    if (outcome.kind === "published")
      return { note: `published ${p.stage} receipt ${p.receiptId} to ${hostOf(network)}` };
    if (outcome.kind === "refused")
      return { note: `${hostOf(network)} refused receipt ${p.receiptId}: ${outcome.error}` };
    throw new Error(`publish to ${hostOf(network)}: ${outcome.error}`);
  };
}

/**
 * One network's publisher for one hour: queues a row for every receipt that has none for this
 * network yet (the backfill when a network is switched on, and anything a job never reached),
 * then posts what is queued, oldest first, in short time-boxed runs that chain until the hour's
 * share is sent. The first answer that is not a verdict on a receipt (no answer, 5xx, 429, 404)
 * stops the run: the network is the problem, not the receipt. What has been tried fewer times goes
 * first, so a receipt the network keeps putting off (one signed under an address it has no
 * verified instance for, say) is tried after the others rather than in front of them every hour.
 */
export function networkPublishHandler(deps: NetworkDeps): JobHandler {
  return async (job, { db, now }) => {
    const { network, hour, link } = job.payload as PublishPayload;
    const entry = (await readSettings(db)).networks[network];
    if (!entry?.enabled || !entry.share.receipts) {
      return { note: `${network} is switched off; its receipts stay queued` };
    }
    const batch = deps.publishBatch ?? PUBLISH_BATCH;
    const perHour = deps.publishPerHour ?? PUBLISH_PER_HOUR;
    let queuedNow = 0;
    if (link === 0) queuedNow = await backfill(db, network, now, perHour);

    const started = Date.now();
    const { rows } = await db.client.query({
      sql: `SELECT p.receipt_id, p.stage, r.jws, r.ack_jws
              FROM network_publications p JOIN receipts r ON r.id = p.receipt_id
             WHERE p.network = ? AND p.state = 'queued'
               AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.dedupe_key = ? || ':' || p.network || ':' || p.receipt_id || ':' || p.stage
                                AND j.status IN ('queued', 'running'))
             ORDER BY p.attempts, p.receipt_id, CASE p.stage WHEN 'issued' THEN 0 ELSE 1 END
             LIMIT ?`,
      params: [network, NETWORK_RECEIPT_KIND, batch],
      method: "all",
    });
    let published = 0;
    let refused = 0;
    let handled = 0;
    const delivered = new Set<string>();
    for (const r of rows) {
      if (Date.now() - started > PUBLISH_TIME_BOX_MS) break;
      handled++;
      const receipt = { id: String(r[0]), jws: String(r[2]), ackJws: r[3] === null ? null : String(r[3]) };
      const stage = String(r[1]) as ReceiptStage;
      // An acknowledged receipt went out whole, acknowledgement included, with its issued row.
      if (delivered.has(receipt.id) && receipt.ackJws) continue;
      const outcome = await publishOne(deps, db, network, receipt, stage, now);
      if (outcome.kind === "retry") {
        const note = `stopped after ${published} published: ${outcome.error}`;
        if (job.attempts < TRIES_PER_HOUR) throw new Error(`${hostOf(network)} ${note}`);
        return { note: `${note}; trying again next hour` };
      }
      if (outcome.kind === "published") {
        delivered.add(receipt.id);
        published++;
      } else {
        refused++;
      }
    }
    const more = rows.length === batch || handled < rows.length;
    const nextLink = link + 1;
    if (more && nextLink * batch < perHour) {
      await ensureJob(db, NETWORK_PUBLISH_KIND, publishKey(network, hour, nextLink), {
        now,
        payload: { network, hour, link: nextLink } satisfies PublishPayload,
      });
    }
    return {
      note: `${hostOf(network)}: ${queuedNow ? `${queuedNow} queued, ` : ""}${published} published, ${refused} refused${more ? ", more to send" : ""}`,
    };
  };
}

/** Rows for receipts this network has none for yet, oldest first, at most the hour's share. */
async function backfill(db: Db, network: string, now: number, perHour: number): Promise<number> {
  const issued = await db.client.query({
    sql: `INSERT OR IGNORE INTO network_publications (receipt_id, network, stage, state, attempts, last_error, updated_at)
          SELECT r.id, ?, 'issued', 'queued', 0, NULL, ? FROM receipts r
           WHERE NOT EXISTS (SELECT 1 FROM network_publications p WHERE p.receipt_id = r.id AND p.network = ? AND p.stage = 'issued')
           ORDER BY r.id LIMIT ?`,
    params: [network, now, network, perHour],
    method: "run",
  });
  const left = perHour - issued.changes;
  if (left <= 0) return issued.changes;
  const acked = await db.client.query({
    sql: `INSERT OR IGNORE INTO network_publications (receipt_id, network, stage, state, attempts, last_error, updated_at)
          SELECT r.id, ?, 'acknowledged', 'queued', 0, NULL, ? FROM receipts r
           WHERE r.ack_at IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM network_publications p WHERE p.receipt_id = r.id AND p.network = ? AND p.stage = 'acknowledged')
           ORDER BY r.id LIMIT ?`,
    params: [network, now, network, left],
    method: "run",
  });
  return issued.changes + acked.changes;
}

type Outcome =
  | { readonly kind: "published" }
  | { readonly kind: "refused"; readonly error: string }
  | { readonly kind: "retry"; readonly error: string };

/**
 * Posts one receipt (and its acknowledgement, once there is one) and writes what came of it: the
 * publication row, and the network's status. A post that carried the acknowledgement delivered
 * both stages, so both rows are marked.
 */
async function publishOne(
  deps: NetworkDeps,
  db: Db,
  network: string,
  receipt: { id: string; jws: string; ackJws: string | null },
  stage: ReceiptStage,
  now: number,
): Promise<Outcome> {
  const body = JSON.stringify({ receipt: receipt.jws, ...(receipt.ackJws ? { ack: receipt.ackJws } : {}) });
  const res = await call(deps, `${network}/v1/receipts`, body);
  const verdict = classifyPublish(res);
  const statements: Statement[] = [];
  if (verdict.kind === "published") {
    const stages = receipt.ackJws ? ["issued", "acknowledged"] : [stage];
    statements.push({
      sql: `UPDATE network_publications SET state = 'published', attempts = attempts + 1, last_error = NULL, updated_at = ?
             WHERE receipt_id = ? AND network = ? AND state = 'queued' AND stage IN (${stages.map(() => "?").join(", ")})`,
      params: [now, receipt.id, network, ...stages],
      method: "run",
    });
    statements.push(networkSuccessStatement(network, now));
  } else {
    statements.push({
      sql: `UPDATE network_publications SET state = ?, attempts = attempts + 1, last_error = ?, updated_at = ?
             WHERE receipt_id = ? AND network = ? AND stage = ? AND state = 'queued'`,
      params: [
        verdict.kind === "refused" ? "refused" : "queued",
        shortError(verdict.error),
        now,
        receipt.id,
        network,
        stage,
      ],
      method: "run",
    });
    if (verdict.kind === "retry") {
      statements.push(networkFailureStatement(network, now, `publishing: ${verdict.error}`, { down: verdict.down }));
    }
  }
  await db.batch(statements);
  return verdict.kind === "retry" ? { kind: "retry", error: verdict.error } : verdict;
}

/** Codes in a problem document that are the network's own state, not a verdict on the receipt. */
const RETRY_CODES = new Set(["unknown_key", "unknown_ref", "unknown_instance", "unknown_issuer"]);

function classifyPublish(
  res: CallResult,
): { kind: "published" } | { kind: "refused"; error: string } | { kind: "retry"; error: string; down: boolean } {
  if (!("status" in res)) return { kind: "retry", error: res.error, down: true };
  if (res.status >= 200 && res.status < 300) return { kind: "published" };
  const error = describeAnswer(res);
  // No answer worth the name: a redirect (this is no longer where the network is), a server
  // error, a rate limit or a timeout. The network is down as far as this inbox can tell.
  if ((res.status >= 300 && res.status < 400) || res.status >= 500 || res.status === 429 || res.status === 408) {
    return { kind: "retry", error, down: true };
  }
  // The network does not know us or our key yet, or wants the receipt a later one refers to.
  const code = problemCode(res.text);
  if (res.status === 404 || res.status === 425 || (code !== null && RETRY_CODES.has(code))) {
    return { kind: "retry", error, down: false };
  }
  return { kind: "refused", error };
}

// ---- calls --------------------------------------------------------------------------------

type CallResult = { readonly status: number; readonly text: string } | { readonly error: string };

function isOk(r: CallResult): boolean {
  return "status" in r && r.status >= 200 && r.status < 300;
}

/**
 * One POST, time-boxed end to end (the body read included), never following a redirect, and only
 * ever to a network origin: the host rule is checked here, on every call, and not only where the
 * address came from, so no caller can hand this a URL that was never checked.
 */
async function call(deps: NetworkDeps, url: string, body: string): Promise<CallResult> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { error: "not a URL" };
  }
  if (target.username || target.password || canonicalNetworkOrigin(target.origin) !== target.origin) {
    return { error: `${target.origin} is not a network origin; nothing sent` };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? CALL_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(target.href, {
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
    const text = (await readCapped(res, MAX_BODY)) ?? "";
    return { status: res.status, text };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        error: `no answer within ${timeoutMs < 1_000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1_000)} s`}`,
      };
    }
    return { error: `could not connect: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Records a failed ping or registration. A network that is down is retried with the job's backoff
 * a couple of times within the hour, then left for the next hour's ping; an answer that says no
 * is recorded for the owner and not retried, since asking again would get the same answer.
 */
async function fail(
  db: Db,
  job: JobRow,
  network: string,
  now: number,
  what: "ping" | "register",
  res: CallResult,
): Promise<{ note: string }> {
  const down =
    !("status" in res) ||
    res.status >= 500 ||
    res.status === 429 ||
    res.status === 408 ||
    (res.status >= 300 && res.status < 400);
  const error = `${what}: ${"status" in res ? describeAnswer(res) : res.error}`;
  const registration: Registration | undefined = what === "register" ? "unregistered" : undefined;
  await db.client.query(
    networkFailureStatement(network, now, error, { down, ...(registration ? { registration } : {}) }),
  );
  const note = `${hostOf(network)} ${error}`;
  if (down && job.attempts < TRIES_PER_HOUR) throw new Error(note);
  return { note };
}

function describeAnswer(res: { status: number; text: string }): string {
  const code = problemCode(res.text);
  let detail = "";
  try {
    const body = JSON.parse(res.text) as { detail?: unknown; title?: unknown };
    detail = typeof body.detail === "string" ? body.detail : typeof body.title === "string" ? body.title : "";
  } catch {
    detail = "";
  }
  return shortError(`HTTP ${res.status}${code ? ` ${code}` : ""}${detail ? `: ${detail}` : ""}`);
}

/** The `code` member of an RFC 9457 problem document, or null. */
function problemCode(text: string): string | null {
  try {
    const body = JSON.parse(text) as { code?: unknown };
    return typeof body.code === "string" && body.code.length <= 64 ? body.code : null;
  } catch {
    return null;
  }
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * The domain each network registers: the host of `INBOX_PUBLIC_URL`, else of the Inbox address in
 * Settings. A network verifies it by fetching the manifest over https on port 443, so anything
 * else would only ever be refused; saying so here is kinder than a failure every hour.
 */
function instanceDomain(deps: NetworkDeps, settings: Settings): { domain: string } | { problem: string } {
  const base = deps.baseUrl ?? settings.notifications.appUrl;
  if (!base) return { problem: "no public address: set the Inbox address in Settings (or INBOX_PUBLIC_URL)" };
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return { problem: `the inbox address ${base} is not a URL` };
  }
  if (url.protocol !== "https:" || !isPublicHost(url.hostname)) {
    return { problem: `the inbox address ${url.origin} is not a public https origin; a network cannot verify it` };
  }
  if (url.port) {
    return { problem: `the inbox address ${url.origin} has a port; a network verifies https on port 443 only` };
  }
  return { domain: url.hostname };
}
