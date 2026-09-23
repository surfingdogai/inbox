import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { ulid } from "../ids";
import type { NetworkEntry, Settings } from "../settings/schema";
import { jobStatement } from "../write/common";

/**
 * Several networks (ADR-017 §8.1, R23): the job kinds, their dedupe keys, the rows that say what
 * each network has been sent, and what the owner is shown per network. The handlers live in
 * `@surfingdog/adapters` (`network.ts`), which makes the calls; everything that has to be written
 * in the same batch as a receipt, or read by the owner's doors, is here, below both.
 *
 * Every network gets its own jobs, so one that is slow or down retries on its own schedule and
 * never holds up another: the hourly tick (`network_ping`) does the housekeeping once and then
 * queues, per network that is switched on, one ping (`network_ping_one`) and one publisher
 * (`network_publish`). A receipt queues one `network_receipt` job per network the moment it is
 * issued or acknowledged; the publisher catches up on whatever those did not deliver.
 */
export const NETWORK_PING_KIND = "network_ping";
export const NETWORK_PING_ONE_KIND = "network_ping_one";
export const NETWORK_PUBLISH_KIND = "network_publish";
export const NETWORK_RECEIPT_KIND = "network_receipt";

export const PING_PERIOD_MS = 60 * 60_000;

export type ReceiptStage = "issued" | "acknowledged";

export const hourOf = (now: number): number => Math.floor(now / PING_PERIOD_MS);

/** The hourly tick: `network_ping:<hour>`. The kind and key are what they were with one network. */
export const pingDedupeKey = (now: number): string => `${NETWORK_PING_KIND}:${hourOf(now)}`;
/** One network's ping for one hour: `network_ping:<origin>:<hour>`. */
export const pingOneKey = (origin: string, hour: number): string => `${NETWORK_PING_KIND}:${origin}:${hour}`;
/** One network's publisher for one hour, and the links it chains while there is more to send. */
export const publishKey = (origin: string, hour: number, link = 0): string =>
  `${NETWORK_PUBLISH_KIND}:${origin}:${hour}${link ? `:${link}` : ""}`;
/** One receipt at one stage for one network: `network_receipt:<origin>:<receipt id>:<stage>`. */
export const receiptJobKey = (origin: string, receiptId: string, stage: ReceiptStage): string =>
  `${NETWORK_RECEIPT_KIND}:${origin}:${receiptId}:${stage}`;

export interface NetworkJobPayload {
  readonly network: string;
}
export interface PublishPayload extends NetworkJobPayload {
  readonly hour: number;
  readonly link: number;
}
export interface NetworkReceiptPayload {
  readonly receiptId: string;
  readonly stage: ReceiptStage;
  /** Absent on jobs queued before there were several networks. */
  readonly network?: string;
}

/**
 * What the runner uses to give each network a lane of its own: jobs for one network run one after
 * another, jobs for different networks side by side.
 */
export function networkLane(payload: unknown): string | undefined {
  const network = (payload as { network?: unknown } | null)?.network;
  return typeof network === "string" ? `network:${network}` : undefined;
}

/**
 * The ping and the publisher for one network for the current hour. The tick queues these for
 * every network that is on; switching one on queues them at once, so a new network hears from
 * this inbox within seconds rather than at the top of the next hour. Same hour, same keys, so the
 * two can never both run.
 */
export function networkStartStatements(
  origin: string,
  entry: NetworkEntry,
  now: number,
  opts: { force?: boolean } = {},
): Statement[] {
  const hour = hourOf(now);
  const statements = [
    jobStatement(NETWORK_PING_ONE_KIND, { network: origin } satisfies NetworkJobPayload, now, {
      dedupeKey: opts.force ? `${NETWORK_PING_KIND}:${origin}:manual:${now}` : pingOneKey(origin, hour),
    }),
  ];
  if (entry.share.receipts) {
    statements.push(
      jobStatement(NETWORK_PUBLISH_KIND, { network: origin, hour, link: 0 } satisfies PublishPayload, now, {
        dedupeKey: publishKey(origin, hour),
      }),
    );
  }
  return statements;
}

/**
 * The publication row and the job for one receipt, one stage, one network, for the batch that
 * writes the receipt or its acknowledgement. Both are inserted from a SELECT on `receipts`, so the
 * receipt id is always the one that is really there: an issue that lost the race to a second
 * writer queues the winner's receipt, not an id that was never stored.
 */
export function networkReceiptStatements(
  network: string,
  stage: ReceiptStage,
  now: number,
  receipt: ReceiptRef,
): Statement[] {
  const { where, params } = receiptWhere(receipt);
  return [
    networkPublicationStatement(network, stage, now, receipt),
    {
      sql: `INSERT OR IGNORE INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at)
            SELECT ?, ?, json_object('receiptId', id, 'stage', ?, 'network', ?), ?, 'queued', 0, 8,
                   ? || ':' || ? || ':' || id || ':' || ?, ?
              FROM receipts WHERE ${where}`,
      params: [
        ulid(now),
        NETWORK_RECEIPT_KIND,
        stage,
        network,
        now,
        NETWORK_RECEIPT_KIND,
        network,
        stage,
        now,
        ...params,
      ],
      method: "run",
    },
  ];
}

/** The publication row alone: queued, unless the network already has one for this receipt and stage. */
export function networkPublicationStatement(
  network: string,
  stage: ReceiptStage,
  now: number,
  receipt: ReceiptRef,
): Statement {
  const { where, params } = receiptWhere(receipt);
  return {
    sql: `INSERT OR IGNORE INTO network_publications (receipt_id, network, stage, state, attempts, last_error, updated_at)
          SELECT id, ?, ?, 'queued', 0, NULL, ? FROM receipts WHERE ${where}`,
    params: [network, stage, now, ...params],
    method: "run",
  };
}

type ReceiptRef = { readonly id: string } | { readonly itemId: string; readonly kind: string };

function receiptWhere(receipt: ReceiptRef): { where: string; params: string[] } {
  return "id" in receipt
    ? { where: "id = ?", params: [receipt.id] }
    : { where: "item_id = ? AND kind = ?", params: [receipt.itemId, receipt.kind] };
}

// ---- status -------------------------------------------------------------------------------

export type Registration = "unregistered" | "pending" | "registered";

/** After this many calls in a row fail with no answer, the network's jobs stop calling it for a while. */
export const BREAKER_FAILURES = 3;
export const BREAKER_MS = 5 * 60_000;

/**
 * An error as the owner reads it: one line, at most 200 characters, nothing but printable text.
 * Part of it can be a network's own words, so control and format characters go too — C1 controls,
 * bidi overrides, zero-width characters, lone surrogates — which could otherwise reorder or hide
 * what the owner is shown.
 */
export function shortError(text: string): string {
  const one = text
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(one);
  return chars.length > 200 ? `${chars.slice(0, 199).join("")}…` : one;
}

/** A call the network answered with a yes: clears the failure run, and records what it says. */
export function networkSuccessStatement(
  network: string,
  now: number,
  r: { registration?: Registration; registeredAt?: number; pinged?: boolean } = {},
): Statement {
  const registration = r.registration ?? null;
  const registeredAt = r.registeredAt ?? null;
  const pingedAt = r.pinged ? now : null;
  return {
    sql: `INSERT INTO network_status (network, registration, registered_at, last_ping_at, last_error, last_error_at, failing_since, failures, updated_at)
          VALUES (?, COALESCE(?, 'unregistered'), ?, ?, NULL, NULL, NULL, 0, ?)
          ON CONFLICT (network) DO UPDATE SET
            registration = COALESCE(?, network_status.registration),
            registered_at = COALESCE(?, network_status.registered_at),
            last_ping_at = COALESCE(?, network_status.last_ping_at),
            last_error = NULL, last_error_at = NULL, failing_since = NULL, failures = 0, updated_at = ?`,
    params: [network, registration, registeredAt, pingedAt, now, registration, registeredAt, pingedAt, now],
    method: "run",
  };
}

/**
 * A call that did not go through. `down` means no usable answer at all (no connection, a timeout,
 * a server error, a rate limit): it starts or continues the "not reachable since" run and counts
 * toward the circuit breaker. Anything else is an answer the owner should read, and only that.
 */
export function networkFailureStatement(
  network: string,
  now: number,
  error: string,
  opts: { down: boolean; registration?: Registration },
): Statement {
  const registration = opts.registration ?? null;
  const down = opts.down ? 1 : 0;
  return {
    sql: `INSERT INTO network_status (network, registration, last_error, last_error_at, failing_since, failures, updated_at)
          VALUES (?, COALESCE(?, 'unregistered'), ?, ?, CASE WHEN ? THEN ? END, ?, ?)
          ON CONFLICT (network) DO UPDATE SET
            registration = COALESCE(?, network_status.registration),
            last_error = excluded.last_error, last_error_at = excluded.last_error_at,
            failing_since = CASE WHEN ? THEN COALESCE(network_status.failing_since, excluded.last_error_at)
                                 ELSE network_status.failing_since END,
            failures = network_status.failures + ?, updated_at = excluded.updated_at`,
    params: [network, registration, shortError(error), now, down, now, down, now, registration, down, down],
    method: "run",
  };
}

export interface NetworkStatusRow {
  readonly registration: Registration;
  readonly registeredAt: number | null;
  readonly lastPingAt: number | null;
  readonly lastError: string | null;
  readonly lastErrorAt: number | null;
  readonly failingSince: number | null;
  readonly failures: number;
}

export async function readNetworkStatus(db: Db, network: string): Promise<NetworkStatusRow | undefined> {
  const { rows } = await db.client.query({
    sql: "SELECT registration, registered_at, last_ping_at, last_error, last_error_at, failing_since, failures FROM network_status WHERE network = ?",
    params: [network],
    method: "all",
  });
  const r = rows[0];
  return r ? statusOf(r) : undefined;
}

/** The breaker: open while the last few calls in a row got no answer, for a few minutes after the last. */
export function isNetworkDown(status: NetworkStatusRow | undefined, now: number): boolean {
  return (
    !!status &&
    status.failures >= BREAKER_FAILURES &&
    status.lastErrorAt !== null &&
    now - status.lastErrorAt < BREAKER_MS
  );
}

function statusOf(r: readonly unknown[]): NetworkStatusRow {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    registration: String(r[0]) as Registration,
    registeredAt: n(r[1]),
    lastPingAt: n(r[2]),
    lastError: r[3] === null || r[3] === undefined ? null : String(r[3]),
    lastErrorAt: n(r[4]),
    failingSince: n(r[5]),
    failures: Number(r[6] ?? 0),
  };
}

// ---- what the owner sees ---------------------------------------------------------------------

/** One network as the owner app and the owner's AI see it: the setting, how it is going, what it has. */
export interface NetworkView {
  readonly origin: string;
  readonly enabled: boolean;
  readonly issue: boolean;
  readonly share: NetworkEntry["share"];
  readonly registration: Registration;
  /** When this instance last registered with the network. */
  readonly registered_at: string | null;
  /** The last ping the network accepted. */
  readonly last_ping_at: string | null;
  /** The last thing that went wrong, in a few words, or null since the last success. */
  readonly last_error: string | null;
  readonly last_error_at: string | null;
  /** Since when calls to it get no answer; null while it answers. */
  readonly failing_since: string | null;
  readonly receipts: { readonly published: number; readonly queued: number; readonly refused: number };
}

export async function networkViews(db: Db, settings: Settings): Promise<NetworkView[]> {
  const origins = Object.keys(settings.networks);
  if (origins.length === 0) return [];
  const marks = origins.map(() => "?").join(", ");
  const [status, counts] = await Promise.all([
    db.client.query({
      sql: `SELECT network, registration, registered_at, last_ping_at, last_error, last_error_at, failing_since, failures
              FROM network_status WHERE network IN (${marks})`,
      params: origins,
      method: "all",
    }),
    db.client.query({
      sql: `SELECT network, state, COUNT(*) FROM network_publications WHERE network IN (${marks}) GROUP BY network, state`,
      params: origins,
      method: "all",
    }),
  ]);
  const byNetwork = new Map(status.rows.map((r) => [String(r[0]), statusOf(r.slice(1))]));
  const tally = new Map<string, { published: number; queued: number; refused: number }>();
  for (const r of counts.rows) {
    const t = tally.get(String(r[0])) ?? { published: 0, queued: 0, refused: 0 };
    const state = String(r[1]);
    if (state === "published" || state === "queued" || state === "refused") t[state] = Number(r[2]);
    tally.set(String(r[0]), t);
  }
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return origins.map((origin) => {
    const entry = settings.networks[origin] as NetworkEntry;
    const s = byNetwork.get(origin);
    return {
      origin,
      enabled: entry.enabled,
      issue: entry.issue,
      share: entry.share,
      registration: s?.registration ?? "unregistered",
      registered_at: iso(s?.registeredAt ?? null),
      last_ping_at: iso(s?.lastPingAt ?? null),
      last_error: s?.lastError ?? null,
      last_error_at: iso(s?.lastErrorAt ?? null),
      failing_since: iso(s?.failingSince ?? null),
      receipts: tally.get(origin) ?? { published: 0, queued: 0, refused: 0 },
    };
  });
}
