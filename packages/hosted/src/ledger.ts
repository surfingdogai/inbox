import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { MailAbout, MailHold, OutboundMail } from "@surfingdog/platform";

/**
 * What no single inbox can see alone, kept for all of them on this machine in one SQLite file that
 * every shard opens: how much email each recipient had today across every inbox, how much each
 * inbox wrote to customers today, the addresses nobody writes to again, which inboxes may not send,
 * the email each inbox sent this month, which inboxes stalled a shard (and those put in maintenance
 * for it), and the events still to be told to the control plane.
 *
 * Recipients are kept as keyed hashes, never as addresses.
 */

/** At most this many emails to one recipient a day, from all the inboxes here together. */
export const RECIPIENT_DAILY_CAP = 5;

/**
 * Forwarding checks one inbox may send in a day (ADR-026 §2): each goes to an address its owner typed,
 * so it is counted here too, whatever the inbox counts, and each counts against its recipient's daily
 * cap as an email to a customer does.
 */
export const CHECKS_DAILY_CAP = 12;

/** Three stalls within an hour put an inbox in maintenance. */
export const BLAMES_FOR_MAINTENANCE = 3;
export const BLAME_WINDOW_MS = 3_600_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS recipient_day (day TEXT NOT NULL, rcpt TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, rcpt));
CREATE TABLE IF NOT EXISTS tenant_day (day TEXT NOT NULL, tenant_id TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, tenant_id));
CREATE TABLE IF NOT EXISTS check_day (day TEXT NOT NULL, tenant_id TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, tenant_id));
CREATE TABLE IF NOT EXISTS suppressed (rcpt TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mail_paused (tenant_id TEXT PRIMARY KEY, reason TEXT NOT NULL, since INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage_month (month TEXT NOT NULL, tenant_id TEXT NOT NULL, mail_sent INTEGER NOT NULL, PRIMARY KEY (month, tenant_id));
CREATE TABLE IF NOT EXISTS blames (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, at INTEGER NOT NULL, reported INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS blames_tenant ON blames (tenant_id, at);
CREATE TABLE IF NOT EXISTS maintenance (tenant_id TEXT PRIMARY KEY, reason TEXT NOT NULL, since INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS events_due ON events (next_at);
CREATE TABLE IF NOT EXISTS judge_day (day TEXT NOT NULL, tenant_id TEXT NOT NULL, n INTEGER NOT NULL, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, tenant_id));
CREATE TABLE IF NOT EXISTS judge_total_day (day TEXT PRIMARY KEY, tokens INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS judge_told (day TEXT NOT NULL, tenant_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (day, tenant_id, type));
`;

export const LEDGER_TABLES = [
  "recipient_day",
  "tenant_day",
  "check_day",
  "suppressed",
  "mail_paused",
  "usage_month",
  "blames",
  "maintenance",
  "events",
  "judge_day",
  "judge_total_day",
  "judge_told",
] as const;

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
export const monthOf = (now: number) => new Date(now).toISOString().slice(0, 7);

export interface QueuedEvent {
  readonly id: number;
  readonly tenant_id: string;
  readonly type: string;
  readonly at: string;
  readonly data: Record<string, unknown>;
  readonly tries: number;
}

export class Ledger {
  readonly db: DatabaseSync;
  private readonly key: Buffer;
  private readonly now: () => number;

  constructor(
    readonly path: string,
    o: { readonly hashKey: string; readonly now?: (() => number) | undefined },
  ) {
    this.db = new DatabaseSync(path, { timeout: 5000 });
    // Every shard opens this file as it starts, at much the same moment: the first to set it up
    // holds a lock the others wait out here, rather than failing to start.
    for (let attempt = 0; ; attempt++) {
      try {
        const mode = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
        if (mode?.journal_mode !== "wal") this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
        this.db.exec(SCHEMA);
        break;
      } catch (error) {
        if (attempt >= 100 || !/locked|busy/i.test(error instanceof Error ? error.message : String(error))) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 + Math.floor(Math.random() * 30));
      }
    }
    this.key = Buffer.from(o.hashKey, "utf8");
    this.now = o.now ?? Date.now;
  }

  close(): void {
    this.db.close();
  }

  private rcpt(address: string): string {
    return createHmac("sha256", this.key).update(address.trim().toLowerCase()).digest("hex");
  }

  private tx<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = work();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw error;
    }
  }

  /**
   * Whether one email may go now, and if so, counted: a paused inbox sends nothing, a suppressed
   * address gets nothing, and an email to a customer stays within the inbox's daily cap and the
   * recipient's daily cap across every inbox here. Owner email is counted, not capped here: the
   * inbox already folds alerts past the hour's cap into a digest.
   */
  hold(tenantId: string, mail: OutboundMail, about: MailAbout, customerDailyCap: number): MailHold | null {
    const now = this.now();
    const day = dayOf(now);
    const recipients = mail.to.map((a) => this.rcpt(a));
    return this.tx(() => {
      if (this.db.prepare("SELECT 1 FROM mail_paused WHERE tenant_id = ?").get(tenantId)) return "paused";
      for (const r of recipients) {
        if (this.db.prepare("SELECT 1 FROM suppressed WHERE rcpt = ?").get(r)) return "suppressed";
      }
      // A forwarding check is an email to an address the owner typed: capped per inbox, and per
      // recipient across every inbox here, as an email to a customer is.
      if (about.template === "forward.check") {
        const checks = this.db.prepare("SELECT n FROM check_day WHERE day = ? AND tenant_id = ?").get(day, tenantId) as
          | { n: number }
          | undefined;
        if ((checks?.n ?? 0) >= CHECKS_DAILY_CAP) return "daily_limit";
        for (const r of recipients) {
          const had = this.db.prepare("SELECT n FROM recipient_day WHERE day = ? AND rcpt = ?").get(day, r) as
            | { n: number }
            | undefined;
          if ((had?.n ?? 0) >= RECIPIENT_DAILY_CAP) return "recipient_limit";
        }
        this.db
          .prepare(
            "INSERT INTO check_day (day, tenant_id, n) VALUES (?, ?, 1) ON CONFLICT (day, tenant_id) DO UPDATE SET n = n + 1",
          )
          .run(day, tenantId);
        for (const r of recipients) {
          this.db
            .prepare(
              "INSERT INTO recipient_day (day, rcpt, n) VALUES (?, ?, 1) ON CONFLICT (day, rcpt) DO UPDATE SET n = n + 1",
            )
            .run(day, r);
        }
      }
      if (about.recipient === "customer") {
        const sent = this.db.prepare("SELECT n FROM tenant_day WHERE day = ? AND tenant_id = ?").get(day, tenantId) as
          | { n: number }
          | undefined;
        if ((sent?.n ?? 0) >= customerDailyCap) return "daily_limit";
        for (const r of recipients) {
          const had = this.db.prepare("SELECT n FROM recipient_day WHERE day = ? AND rcpt = ?").get(day, r) as
            | { n: number }
            | undefined;
          if ((had?.n ?? 0) >= RECIPIENT_DAILY_CAP) return "recipient_limit";
        }
        this.db
          .prepare(
            "INSERT INTO tenant_day (day, tenant_id, n) VALUES (?, ?, 1) ON CONFLICT (day, tenant_id) DO UPDATE SET n = n + 1",
          )
          .run(day, tenantId);
        for (const r of recipients) {
          this.db
            .prepare(
              "INSERT INTO recipient_day (day, rcpt, n) VALUES (?, ?, 1) ON CONFLICT (day, rcpt) DO UPDATE SET n = n + 1",
            )
            .run(day, r);
        }
      }
      this.db
        .prepare(
          "INSERT INTO usage_month (month, tenant_id, mail_sent) VALUES (?, ?, 1) ON CONFLICT (month, tenant_id) DO UPDATE SET mail_sent = mail_sent + 1",
        )
        .run(monthOf(now), tenantId);
      return null;
    });
  }

  /**
   * Whether this inbox may make one more AI check for the spam filter now (ADR-029 §15.3), and if so,
   * counted before the call: within its day's and its month's caps, and the runtime's own token budget
   * for the day across every inbox here. What a copied tenant file says it spent changes nothing here.
   * `tenant` and `breaker` say which cap refused it, told to the control plane once a day each.
   */
  reserveJudge(
    tenantId: string,
    caps: { readonly day: number; readonly month: number; readonly dailyTokens: number },
  ): "ok" | "tenant" | "breaker" {
    const now = this.now();
    const day = dayOf(now);
    const month = monthOf(now);
    return this.tx(() => {
      const total = this.db.prepare("SELECT tokens FROM judge_total_day WHERE day = ?").get(day) as
        | { tokens: number }
        | undefined;
      if ((total?.tokens ?? 0) >= caps.dailyTokens) {
        this.tellOnce(tenantId, "spam_breaker", day, { day });
        return "breaker";
      }
      const today = this.db.prepare("SELECT n FROM judge_day WHERE day = ? AND tenant_id = ?").get(day, tenantId) as
        | { n: number }
        | undefined;
      const thisMonth = this.db
        .prepare("SELECT COALESCE(SUM(n), 0) AS n FROM judge_day WHERE day LIKE ? AND tenant_id = ?")
        .get(`${month}-%`, tenantId) as { n: number };
      if ((today?.n ?? 0) >= caps.day || thisMonth.n >= caps.month) {
        this.tellOnce(tenantId, "spam_cap_reached", day, { cap: (today?.n ?? 0) >= caps.day ? "day" : "month" });
        return "tenant";
      }
      this.db
        .prepare(
          "INSERT INTO judge_day (day, tenant_id, n) VALUES (?, ?, 1) ON CONFLICT (day, tenant_id) DO UPDATE SET n = n + 1",
        )
        .run(day, tenantId);
      return "ok";
    });
  }

  /** The tokens one AI check used, for the inbox and for the runtime's own day. */
  recordJudge(tenantId: string, tokensIn: number, tokensOut: number): void {
    const day = dayOf(this.now());
    this.tx(() => {
      this.db
        .prepare(
          "UPDATE judge_day SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ? WHERE day = ? AND tenant_id = ?",
        )
        .run(tokensIn, tokensOut, day, tenantId);
      this.db
        .prepare(
          "INSERT INTO judge_total_day (day, tokens) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET tokens = tokens + excluded.tokens",
        )
        .run(day, tokensIn + tokensOut);
    });
  }

  /**
   * An attempt that was sent and came back without its usage (it timed out, the connection was cut):
   * what it may have cost, against the runtime's day only, so a provider's slowdown still trips the
   * breaker. No inbox's own count of tokens takes it.
   */
  recordJudgeEstimate(tokens: number): void {
    this.db
      .prepare(
        "INSERT INTO judge_total_day (day, tokens) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET tokens = tokens + excluded.tokens",
      )
      .run(dayOf(this.now()), Math.max(0, Math.ceil(tokens)));
  }

  /** The AI checks one inbox made in a month, and their tokens, as the ledger counted them. */
  judged(
    tenantId: string,
    month: string,
  ): { readonly n: number; readonly tokens_in: number; readonly tokens_out: number } {
    const r = this.db
      .prepare(
        "SELECT COALESCE(SUM(n), 0) AS n, COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout FROM judge_day WHERE day LIKE ? AND tenant_id = ?",
      )
      .get(`${month}-%`, tenantId) as { n: number; tin: number; tout: number };
    return { n: r.n, tokens_in: r.tin, tokens_out: r.tout };
  }

  /**
   * One event to the control plane per kind, inbox and day: marked told apart from the queue, which
   * forgets each event once it is delivered.
   */
  private tellOnce(tenantId: string, type: string, day: string, data: Record<string, unknown>): void {
    const first = this.db
      .prepare("INSERT OR IGNORE INTO judge_told (day, tenant_id, type) VALUES (?, ?, ?)")
      .run(day, tenantId, type);
    if (Number(first.changes) === 0) return;
    this.db
      .prepare("INSERT INTO events (tenant_id, type, at, data, tries, next_at) VALUES (?, ?, ?, ?, 0, ?)")
      .run(tenantId, type, new Date(this.now()).toISOString(), JSON.stringify(data), this.now());
  }

  suppress(address: string, reason: string): void {
    this.db
      .prepare(
        "INSERT INTO suppressed (rcpt, reason, at) VALUES (?, ?, ?) ON CONFLICT (rcpt) DO UPDATE SET reason = excluded.reason",
      )
      .run(this.rcpt(address), reason, this.now());
  }

  unsuppress(address: string): void {
    this.db.prepare("DELETE FROM suppressed WHERE rcpt = ?").run(this.rcpt(address));
  }

  pauseMail(tenantId: string, reason: string): boolean {
    const r = this.db
      .prepare("INSERT INTO mail_paused (tenant_id, reason, since) VALUES (?, ?, ?) ON CONFLICT (tenant_id) DO NOTHING")
      .run(tenantId, reason, this.now());
    return Number(r.changes) > 0;
  }

  resumeMail(tenantId: string): void {
    this.db.prepare("DELETE FROM mail_paused WHERE tenant_id = ?").run(tenantId);
  }

  mailPaused(tenantId: string): boolean {
    return this.db.prepare("SELECT 1 FROM mail_paused WHERE tenant_id = ?").get(tenantId) !== undefined;
  }

  mailSent(tenantId: string, month: string): number {
    const row = this.db
      .prepare("SELECT mail_sent FROM usage_month WHERE month = ? AND tenant_id = ?")
      .get(month, tenantId) as { mail_sent: number } | undefined;
    return row?.mail_sent ?? 0;
  }

  blame(tenantId: string, at: number = this.now()): void {
    this.db.prepare("INSERT INTO blames (tenant_id, at) VALUES (?, ?)").run(tenantId, at);
  }

  /** Blames not yet told to the control plane. */
  unreportedBlames(): { id: number; tenant_id: string; at: number }[] {
    return (
      this.db.prepare("SELECT id, tenant_id, at FROM blames WHERE reported = 0 ORDER BY id").all() as {
        id: number;
        tenant_id: string;
        at: number;
      }[]
    ).map((r) => ({ id: r.id, tenant_id: r.tenant_id, at: r.at }));
  }

  markBlamesReported(ids: readonly number[]): void {
    const mark = this.db.prepare("UPDATE blames SET reported = 1 WHERE id = ?");
    this.tx(() => {
      for (const id of ids) mark.run(id);
    });
  }

  blamesSince(tenantId: string, since: number): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM blames WHERE tenant_id = ? AND at >= ?")
      .get(tenantId, since) as {
      n: number;
    };
    return row.n;
  }

  /** True when this put the inbox in maintenance (it was not already). */
  setMaintenance(tenantId: string, reason: string): boolean {
    const r = this.db
      .prepare("INSERT INTO maintenance (tenant_id, reason, since) VALUES (?, ?, ?) ON CONFLICT (tenant_id) DO NOTHING")
      .run(tenantId, reason, this.now());
    return Number(r.changes) > 0;
  }

  clearMaintenance(tenantId: string): void {
    this.db.prepare("DELETE FROM maintenance WHERE tenant_id = ?").run(tenantId);
  }

  maintenance(tenantId: string): { reason: string; since: number } | null {
    const row = this.db.prepare("SELECT reason, since FROM maintenance WHERE tenant_id = ?").get(tenantId) as
      | { reason: string; since: number }
      | undefined;
    return row ? { reason: row.reason, since: row.since } : null;
  }

  countMaintenance(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM maintenance").get() as { n: number }).n;
  }

  queueEvent(e: { tenant_id: string; type: string; at: string; data: Record<string, unknown> }): void {
    this.db
      .prepare("INSERT INTO events (tenant_id, type, at, data, next_at) VALUES (?, ?, ?, ?, ?)")
      .run(e.tenant_id, e.type, e.at, JSON.stringify(e.data), this.now());
  }

  /**
   * Events due to be told, each taken for a minute: every shard passes events on, and none passes
   * on one another has taken. One that is told is deleted (`eventDone`); one that is not is tried
   * again later (`eventRetry`), or after the minute if its shard went away.
   */
  claimEvents(limit = 50): QueuedEvent[] {
    const now = this.now();
    const rows = this.db
      .prepare(
        `UPDATE events SET next_at = ? WHERE id IN (SELECT id FROM events WHERE next_at <= ? ORDER BY id LIMIT ?)
         RETURNING id, tenant_id, type, at, data, tries`,
      )
      .all(now + 60_000, now, limit) as {
      id: number;
      tenant_id: string;
      type: string;
      at: string;
      data: string;
      tries: number;
    }[];
    return rows.sort((a, b) => a.id - b.id).map((r) => ({ ...r, data: JSON.parse(r.data) as Record<string, unknown> }));
  }

  eventDone(id: number): void {
    this.db.prepare("DELETE FROM events WHERE id = ?").run(id);
  }

  /** Tried again later, backing off to an hour; dropped after a day of trying. */
  eventRetry(id: number, tries: number): void {
    if (tries >= 30) {
      this.db.prepare("DELETE FROM events WHERE id = ?").run(id);
      return;
    }
    const wait = Math.min(3_600_000, 2 ** tries * 5_000);
    this.db.prepare("UPDATE events SET tries = ?, next_at = ? WHERE id = ?").run(tries + 1, this.now() + wait, id);
  }

  /** Days older than a week are of no use to a daily cap. */
  prune(): void {
    const before = dayOf(this.now() - 7 * 86_400_000);
    this.db.prepare("DELETE FROM recipient_day WHERE day < ?").run(before);
    this.db.prepare("DELETE FROM tenant_day WHERE day < ?").run(before);
    this.db.prepare("DELETE FROM check_day WHERE day < ?").run(before);
    this.db.prepare("DELETE FROM judge_told WHERE day < ?").run(before);
    this.db.prepare("DELETE FROM blames WHERE at < ? AND reported = 1").run(this.now() - 7 * 86_400_000);
  }
}
