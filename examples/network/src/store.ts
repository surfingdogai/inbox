import { DatabaseSync } from "node:sqlite";

/**
 * Everything the network keeps, in one SQLite file (or in memory, for a test): the businesses and
 * what their manifests said, the receipts they published, and the signatures already used.
 */

export interface Business {
  readonly domain: string;
  /** `pending` until its manifest is read; `verified`; `unreachable` once a verified one stops answering. */
  readonly status: "pending" | "verified" | "unreachable";
  readonly manifest: Record<string, unknown> | null;
  /** The manifest's `receipt_keys.keys`, as fetched. */
  readonly keys: readonly Record<string, unknown>[];
  readonly verifiedAt: number | null;
  readonly lastCheckedAt: number | null;
  readonly lastPingAt: number | null;
  readonly failCount: number;
  readonly listed: boolean;
  readonly delistedAt: number | null;
  readonly software: { readonly version?: string; readonly runtime?: string } | null;
  readonly lastError: string | null;
}

export interface StoredReceipt {
  readonly iss: string;
  readonly nonce: string;
  readonly jws: string;
  readonly kind: string;
  readonly typ: string;
  readonly out: string | null;
  readonly sub: string;
  readonly acknowledged: boolean;
  readonly arrivedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  domain TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  manifest TEXT,
  keys TEXT NOT NULL DEFAULT '[]',
  verified_at INTEGER,
  last_checked_at INTEGER,
  last_ping_at INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0,
  listed INTEGER NOT NULL DEFAULT 1,
  delisted_at INTEGER,
  listing_changes TEXT NOT NULL DEFAULT '[]',
  software TEXT,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS receipts (
  iss TEXT NOT NULL,
  nonce TEXT NOT NULL,
  jws TEXT NOT NULL,
  kind TEXT NOT NULL,
  typ TEXT NOT NULL,
  out TEXT,
  sub TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  arrived_at INTEGER NOT NULL,
  PRIMARY KEY (iss, nonce)
);
CREATE TABLE IF NOT EXISTS used_signatures (
  key TEXT PRIMARY KEY,
  until INTEGER NOT NULL
);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  business(domain: string): Business | null {
    const r = this.db.prepare("SELECT * FROM businesses WHERE domain = ?").get(domain) as Row | undefined;
    return r ? businessOf(r) : null;
  }

  /** Registers a domain once; registering it again changes nothing. */
  register(domain: string): void {
    this.db.prepare("INSERT OR IGNORE INTO businesses (domain, status) VALUES (?, 'pending')").run(domain);
  }

  /** A manifest that verified: what it says replaces what the network held. */
  verified(domain: string, manifest: Record<string, unknown>, keys: readonly unknown[], now: number): void {
    const directory = (manifest.directory as { listed?: unknown } | undefined)?.listed;
    this.db
      .prepare(
        `UPDATE businesses SET status = 'verified', manifest = ?, keys = ?, verified_at = COALESCE(verified_at, ?),
           last_checked_at = ?, fail_count = 0, last_error = NULL,
           listed = CASE WHEN ? = 0 THEN 0 ELSE listed END,
           delisted_at = CASE WHEN ? = 0 AND listed = 1 THEN ? ELSE delisted_at END
         WHERE domain = ?`,
      )
      .run(
        JSON.stringify(manifest),
        JSON.stringify(keys),
        now,
        now,
        directory === false ? 0 : 1,
        directory === false ? 0 : 1,
        now,
        domain,
      );
  }

  /** A fetch that failed: a pending business stays pending, a verified one becomes unreachable. */
  failed(domain: string, error: string, now: number): void {
    this.db
      .prepare(
        `UPDATE businesses SET fail_count = fail_count + 1, last_checked_at = ?, last_error = ?,
           status = CASE WHEN verified_at IS NULL THEN 'pending' ELSE 'unreachable' END
         WHERE domain = ?`,
      )
      .run(now, error.slice(0, 200), domain);
  }

  pinged(domain: string, software: { version?: string; runtime?: string }, now: number): void {
    this.db
      .prepare("UPDATE businesses SET last_ping_at = ?, software = ? WHERE domain = ?")
      .run(now, JSON.stringify(software), domain);
  }

  /** Leaves or rejoins the directory. Returns false over the day's ten changes. */
  setListed(domain: string, listed: boolean, now: number): boolean {
    const b = this.business(domain);
    if (!b || b.listed === listed) return true;
    const row = this.db.prepare("SELECT listing_changes FROM businesses WHERE domain = ?").get(domain) as {
      listing_changes: string;
    };
    const recent = (JSON.parse(row.listing_changes) as number[]).filter((t) => t > now - 86_400_000);
    if (recent.length >= 10) return false;
    this.db
      .prepare("UPDATE businesses SET listed = ?, delisted_at = ?, listing_changes = ? WHERE domain = ?")
      .run(listed ? 1 : 0, listed ? null : now, JSON.stringify([...recent, now]), domain);
    return true;
  }

  /** Listed members, newest verified first, after the cursor `{v, d}` when given. */
  listed(after: { v: number; d: string } | null, limit: number): Business[] {
    const rows = (
      after
        ? this.db
            .prepare(
              `SELECT * FROM businesses WHERE listed = 1 AND verified_at IS NOT NULL
                 AND (verified_at < ? OR (verified_at = ? AND domain > ?))
               ORDER BY verified_at DESC, domain ASC LIMIT ?`,
            )
            .all(after.v, after.v, after.d, limit)
        : this.db
            .prepare(
              `SELECT * FROM businesses WHERE listed = 1 AND verified_at IS NOT NULL
               ORDER BY verified_at DESC, domain ASC LIMIT ?`,
            )
            .all(limit)
    ) as Row[];
    return rows.map(businessOf);
  }

  /** Every member, for the six-hourly manifest refresh. */
  members(): string[] {
    return (
      this.db.prepare("SELECT domain FROM businesses WHERE verified_at IS NOT NULL").all() as { domain: string }[]
    ).map((r) => r.domain);
  }

  receipt(iss: string, nonce: string): StoredReceipt | null {
    const r = this.db.prepare("SELECT * FROM receipts WHERE iss = ? AND nonce = ?").get(iss, nonce) as
      | ReceiptRow
      | undefined;
    return r ? receiptOf(r) : null;
  }

  keepReceipt(r: Omit<StoredReceipt, "acknowledged" | "arrivedAt">, acknowledged: boolean, now: number): void {
    this.db
      .prepare(
        "INSERT INTO receipts (iss, nonce, jws, kind, typ, out, sub, acknowledged, arrived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(r.iss, r.nonce, r.jws, r.kind, r.typ, r.out, r.sub, acknowledged ? 1 : 0, now);
  }

  acknowledge(iss: string, nonce: string): void {
    this.db.prepare("UPDATE receipts SET acknowledged = 1 WHERE iss = ? AND nonce = ?").run(iss, nonce);
  }

  /** Promises issued and acknowledged, customers, the last one's time, and each outcome's count. */
  tally(iss: string): {
    issued: number;
    acknowledged: number;
    customers: number;
    lastAt: number | null;
    outcomes: Record<string, number>;
  } {
    const t = this.db
      .prepare(
        `SELECT COUNT(*) AS issued, COALESCE(SUM(acknowledged), 0) AS acknowledged, COUNT(DISTINCT sub) AS customers,
                MAX(arrived_at) AS last_at
           FROM receipts WHERE iss = ? AND kind IN ('confirmed', 'paid', 'accepted')`,
      )
      .get(iss) as { issued: number; acknowledged: number; customers: number; last_at: number | null };
    const outcomes: Record<string, number> = {};
    for (const r of this.db
      .prepare("SELECT out, COUNT(*) AS n FROM receipts WHERE iss = ? AND kind = 'outcome' GROUP BY out")
      .all(iss) as { out: string; n: number }[]) {
      outcomes[r.out] = r.n;
    }
    return {
      issued: Number(t.issued),
      acknowledged: Number(t.acknowledged),
      customers: Number(t.customers),
      lastAt: t.last_at,
      outcomes,
    };
  }

  /** Records a signature as used; false when it was already (a replay). */
  useSignature(key: string, until: number, now: number): boolean {
    this.db.prepare("DELETE FROM used_signatures WHERE until < ?").run(Math.floor(now / 1000));
    const r = this.db.prepare("INSERT OR IGNORE INTO used_signatures (key, until) VALUES (?, ?)").run(key, until);
    return Number(r.changes) === 1;
  }
}

type Row = {
  domain: string;
  status: string;
  manifest: string | null;
  keys: string;
  verified_at: number | null;
  last_checked_at: number | null;
  last_ping_at: number | null;
  fail_count: number;
  listed: number;
  delisted_at: number | null;
  software: string | null;
  last_error: string | null;
};

type ReceiptRow = {
  iss: string;
  nonce: string;
  jws: string;
  kind: string;
  typ: string;
  out: string | null;
  sub: string;
  acknowledged: number;
  arrived_at: number;
};

function businessOf(r: Row): Business {
  return {
    domain: r.domain,
    status: r.status as Business["status"],
    manifest: r.manifest ? (JSON.parse(r.manifest) as Record<string, unknown>) : null,
    keys: JSON.parse(r.keys) as Record<string, unknown>[],
    verifiedAt: r.verified_at,
    lastCheckedAt: r.last_checked_at,
    lastPingAt: r.last_ping_at,
    failCount: r.fail_count,
    listed: r.listed === 1,
    delistedAt: r.delisted_at,
    software: r.software ? (JSON.parse(r.software) as Business["software"]) : null,
    lastError: r.last_error,
  };
}

function receiptOf(r: ReceiptRow): StoredReceipt {
  return {
    iss: r.iss,
    nonce: r.nonce,
    jws: r.jws,
    kind: r.kind,
    typ: r.typ,
    out: r.out,
    sub: r.sub,
    acknowledged: r.acknowledged === 1,
    arrivedAt: r.arrived_at,
  };
}
