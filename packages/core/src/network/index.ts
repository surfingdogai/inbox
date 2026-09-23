import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { ulid } from "../ids";
import { enabledNetworks, type NetworkEntry, type Settings } from "../settings/schema";
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
  opts: { force?: boolean; owed?: boolean } = {},
): Statement[] {
  const hour = hourOf(now);
  const statements = [
    jobStatement(NETWORK_PING_ONE_KIND, { network: origin } satisfies NetworkJobPayload, now, {
      dedupeKey: opts.force ? `${NETWORK_PING_KIND}:${origin}:manual:${now}` : pingOneKey(origin, hour),
    }),
  ];
  // A network that stopped taking receipts still gets the outcomes of the promises it was sent
  // (ADR-017 §3.2): `owed` says there are some queued for it.
  if (entry.share.receipts || opts.owed) {
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

/** A receipt by id, or by what makes it unique: its item, kind and outcome ('' for a promise). */
export type ReceiptRef =
  | { readonly id: string }
  | { readonly itemId: string; readonly kind: string; readonly outcome?: string | undefined };

function receiptWhere(receipt: ReceiptRef): { where: string; params: string[] } {
  return "id" in receipt
    ? { where: "id = ?", params: [receipt.id] }
    : {
        where: "item_id = ? AND kind = ? AND outcome = ?",
        params: [receipt.itemId, receipt.kind, receipt.outcome ?? ""],
      };
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
  /** The rules version the network applies, and the next it announced, as `/v1/ranking` last said. */
  readonly rulesVersion: number | null;
  readonly rulesNextVersion: number | null;
  readonly rulesNextAt: number | null;
  readonly rulesCheckedAt: number | null;
  /** The business's own standing there, as the network's answer to a signed ping last said it. */
  readonly standing: BusinessStanding | null;
  readonly standingAt: number | null;
  /** What became of the last ping's signature (`PingSignature`), or null before the first ping. */
  readonly pingSignature: string | null;
  /** The hosts of the platforms the network recognises, as `/v1/ranking` last said; null before it did. */
  readonly recognisedPlatforms: readonly string[] | null;
  readonly platformsCheckedAt: number | null;
}

/**
 * A business's standing at one network (ADR-017 §5.3, §7.3): its score, tier and whether it sorts
 * before the newcomers. Only a ping signed by the business's own key is answered with it.
 */
export interface BusinessStanding {
  readonly tier: "new" | "building" | "trusted";
  readonly score: number;
  readonly ranked: boolean;
}

/**
 * What became of a ping's signature: `verified` (the network answered 200 with the business's
 * standing), `unsigned` (this inbox cannot sign: no INBOX_SECRET_KEY), `ignored` (the network
 * answered as to an unsigned ping, saying nothing about the signature: it does not read them yet),
 * `refused` (it answered 401 and took the ping unsigned), or `invalid: <reason>` from the network's
 * `Sdi-Signature` header.
 */
export type PingSignature = "verified" | "unsigned" | "ignored" | "refused" | `invalid: ${string}`;

const STATUS_COLUMNS =
  "registration, registered_at, last_ping_at, last_error, last_error_at, failing_since, failures, rules_version, rules_next_version, rules_next_at, rules_checked_at, standing, standing_at, ping_signature, recognised_platforms, platforms_checked_at";

export async function readNetworkStatus(db: Db, network: string): Promise<NetworkStatusRow | undefined> {
  const { rows } = await db.client.query({
    sql: `SELECT ${STATUS_COLUMNS} FROM network_status WHERE network = ?`,
    params: [network],
    method: "all",
  });
  const r = rows[0];
  return r ? statusOf(r) : undefined;
}

// ---- which receipts a network takes ------------------------------------------------------

/** The first rules version that scores receipt claims v2 (ADR-017 §2.5, §7.3). */
export const V2_RULES_VERSION = 3;

/** Receipt kinds only claims v2 have: a network below `V2_RULES_VERSION` is sent none of them. */
export const V2_ONLY_KINDS: readonly string[] = ["accepted", "outcome"];

/**
 * Whether a network takes receipt claims v2: its rules in force, or the ones it has announced, are
 * version 3 or later. The announced version counts because a network gives notice before its
 * rules change (§11) and already stores v2 receipts meanwhile; waiting for the switch would leave
 * every promise made during the notice without its outcome. Unknown (never asked, or it never
 * answered) is no: such a network gets v1 promises, as every network always has.
 */
export function takesV2(status: Pick<NetworkStatusRow, "rulesVersion" | "rulesNextVersion"> | undefined): boolean {
  return Math.max(status?.rulesVersion ?? 0, status?.rulesNextVersion ?? 0) >= V2_RULES_VERSION;
}

/**
 * What `/v1/ranking` said, for the network's status row: the rules, and — from the document itself,
 * not from a ping's answer, which does not carry them — the platforms it recognises (`platforms`,
 * hosts; `undefined` leaves what was stored). Unanswered (`rules` null), only the times move, so it
 * is asked again at `checkedAt` plus a day.
 */
export function networkRulesStatement(
  network: string,
  now: number,
  rules: { version: number; next: number | null; nextAt: number | null } | null,
  checkedAt: number = now,
  platforms?: readonly string[],
): Statement {
  if (!rules) {
    return {
      sql: `INSERT INTO network_status (network, registration, rules_checked_at, platforms_checked_at, failures, updated_at)
            VALUES (?, 'unregistered', ?, ?, 0, ?)
            ON CONFLICT (network) DO UPDATE SET rules_checked_at = excluded.rules_checked_at,
              platforms_checked_at = excluded.platforms_checked_at`,
      params: [network, checkedAt, checkedAt, now],
      method: "run",
    };
  }
  if (platforms !== undefined) {
    return {
      sql: `INSERT INTO network_status (network, registration, rules_version, rules_next_version, rules_next_at, rules_checked_at,
              recognised_platforms, platforms_checked_at, failures, updated_at)
            VALUES (?, 'unregistered', ?, ?, ?, ?, ?, ?, 0, ?)
            ON CONFLICT (network) DO UPDATE SET
              rules_version = excluded.rules_version, rules_next_version = excluded.rules_next_version,
              rules_next_at = excluded.rules_next_at, rules_checked_at = excluded.rules_checked_at,
              recognised_platforms = excluded.recognised_platforms, platforms_checked_at = excluded.platforms_checked_at`,
      params: [network, rules.version, rules.next, rules.nextAt, checkedAt, JSON.stringify(platforms), checkedAt, now],
      method: "run",
    };
  }
  return {
    sql: `INSERT INTO network_status (network, registration, rules_version, rules_next_version, rules_next_at, rules_checked_at, failures, updated_at)
          VALUES (?, 'unregistered', ?, ?, ?, ?, 0, ?)
          ON CONFLICT (network) DO UPDATE SET
            rules_version = excluded.rules_version, rules_next_version = excluded.rules_next_version,
            rules_next_at = excluded.rules_next_at, rules_checked_at = excluded.rules_checked_at`,
    params: [network, rules.version, rules.next, rules.nextAt, checkedAt, now],
    method: "run",
  };
}

/**
 * A platform as a network's `recognised_platforms` names it — an origin (`https://agents.example`)
 * or a bare host — reduced to the host it is compared by; null for anything that is neither.
 */
export function platformHost(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  const text = entry.trim().toLowerCase();
  if (!text || text.length > 300) return null;
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.host.replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * Whether a network this inbox reports to recognises the platform at `origin` (ADR-017 §4): its
 * host is in the `recognised_platforms` a switched-on network last published. Nothing is asked of
 * a network here — a request never waits on one — so a list not read yet recognises nobody.
 */
export async function platformRecognised(db: Db, settings: Settings, origin: string): Promise<boolean> {
  const host = platformHost(origin);
  const on = enabledNetworks(settings);
  if (!host || on.length === 0) return false;
  const { rows } = await db.client.query({
    sql: `SELECT recognised_platforms FROM network_status
           WHERE recognised_platforms IS NOT NULL AND network IN (${on.map(() => "?").join(", ")})`,
    params: on,
    method: "all",
  });
  return rows.some((r) => platformsOf(r[0])?.includes(host) === true);
}

function platformsOf(text: unknown): string[] | null {
  if (typeof text !== "string") return null;
  try {
    const list = JSON.parse(text) as unknown;
    return Array.isArray(list) ? list.filter((h): h is string => typeof h === "string") : null;
  } catch {
    return null;
  }
}

/**
 * What a ping's signature came to, and the standing a signed ping was answered with. A ping that
 * brought no standing keeps the last one, with the time it was said, so the owner sees what the
 * network last said rather than nothing.
 */
export function networkPingSignatureStatement(
  network: string,
  now: number,
  signature: PingSignature,
  standing: BusinessStanding | null = null,
): Statement {
  const json = standing
    ? JSON.stringify({ tier: standing.tier, score: standing.score, ranked: standing.ranked })
    : null;
  return {
    sql: `UPDATE network_status SET ping_signature = ?,
            standing = COALESCE(?, standing),
            standing_at = CASE WHEN ? IS NULL THEN standing_at ELSE ? END
           WHERE network = ?`,
    params: [shortError(signature), json, json, now, network],
    method: "run",
  };
}

/** A stored standing, read leniently: anything that does not parse is no standing. */
export function standingOf(text: unknown): BusinessStanding | null {
  if (typeof text !== "string") return null;
  let v: { tier?: unknown; score?: unknown; ranked?: unknown };
  try {
    v = JSON.parse(text) as typeof v;
  } catch {
    return null;
  }
  const tier = v?.tier === "building" || v?.tier === "trusted" || v?.tier === "new" ? v.tier : null;
  const score = typeof v?.score === "number" && v.score >= 0 && v.score <= 1 ? v.score : null;
  if (tier === null || score === null) return null;
  return { tier, score, ranked: v.ranked === true };
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
    rulesVersion: n(r[7]),
    rulesNextVersion: n(r[8]),
    rulesNextAt: n(r[9]),
    rulesCheckedAt: n(r[10]),
    standing: standingOf(r[11]),
    standingAt: n(r[12]),
    pingSignature: r[13] === null || r[13] === undefined ? null : String(r[13]),
    recognisedPlatforms: platformsOf(r[14]),
    platformsCheckedAt: n(r[15]),
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
  /**
   * The rules the network applies (`/v1/ranking`), and whether it is sent receipt claims v2 —
   * acceptances and outcomes — which it is from rules version 3, in force or announced.
   */
  readonly rules: {
    readonly version: number | null;
    readonly next: number | null;
    readonly next_at: string | null;
    readonly v2: boolean;
    readonly checked_at: string | null;
  };
  /**
   * The business's own standing at the network (ADR-017 §7.3), as its answer to the last signed
   * ping said it, and when: null until a signed ping has been answered.
   */
  readonly standing: (BusinessStanding & { readonly at: string }) | null;
  /** What became of the last ping's signature (`PingSignature`); null before the first ping. */
  readonly ping_signature: string | null;
  /**
   * What it has been sent. `held` are queued acceptances and outcomes waiting for the network to
   * take claims v2; `queued` counts them too.
   */
  readonly receipts: {
    readonly published: number;
    readonly queued: number;
    readonly refused: number;
    readonly held: number;
  };
}

export async function networkViews(db: Db, settings: Settings): Promise<NetworkView[]> {
  const origins = Object.keys(settings.networks);
  if (origins.length === 0) return [];
  const marks = origins.map(() => "?").join(", ");
  const [status, counts] = await Promise.all([
    db.client.query({
      sql: `SELECT network, ${STATUS_COLUMNS} FROM network_status WHERE network IN (${marks})`,
      params: origins,
      method: "all",
    }),
    db.client.query({
      sql: `SELECT p.network, p.state, r.kind IN ('accepted', 'outcome'), COUNT(*)
              FROM network_publications p JOIN receipts r ON r.id = p.receipt_id
             WHERE p.network IN (${marks}) GROUP BY 1, 2, 3`,
      params: origins,
      method: "all",
    }),
  ]);
  const byNetwork = new Map(status.rows.map((r) => [String(r[0]), statusOf(r.slice(1))]));
  const tally = new Map<string, { published: number; queued: number; refused: number; held: number }>();
  for (const r of counts.rows) {
    const network = String(r[0]);
    const t = tally.get(network) ?? { published: 0, queued: 0, refused: 0, held: 0 };
    const state = String(r[1]);
    const n = Number(r[3]);
    if (state === "published" || state === "queued" || state === "refused") t[state] += n;
    if (state === "queued" && Number(r[2]) === 1 && !takesV2(byNetwork.get(network))) t.held += n;
    tally.set(network, t);
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
      rules: {
        version: s?.rulesVersion ?? null,
        next: s?.rulesNextVersion ?? null,
        next_at: iso(s?.rulesNextAt ?? null),
        v2: takesV2(s),
        checked_at: iso(s?.rulesCheckedAt ?? null),
      },
      standing:
        s?.standing && s.standingAt !== null ? { ...s.standing, at: new Date(s.standingAt).toISOString() } : null,
      ping_signature: s?.pingSignature ?? null,
      receipts: tally.get(origin) ?? { published: 0, queued: 0, refused: 0, held: 0 },
    };
  });
}
