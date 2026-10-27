import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Filter, SharedMatch, SharedPrint, SharedSpamPort } from "@surfingdog/core";
import { type PolicyPayload, planOf } from "./types";

/**
 * Known spam, shared between the inboxes this runtime hosts (ADR-041 §16), kept in the ledger every
 * shard opens. An inbox hands over a fingerprint of a message (MinHash bands of its masked text, and
 * its sender's company domain); everything is keyed here with the runtime's own secret (HMAC) before it
 * is kept or compared, so the store holds no words, no address and no name, and nothing in it can be
 * turned back into a message or matched without the runtime's key. Who reported is a keyed hash of the
 * owner's account; which item, a keyed hash of the inbox and the item.
 *
 * A fingerprint counts for an inbox only once three owners other than its own reported one like it
 * within a fortnight, from accounts at least a week old when they reported, less every owner whose
 * person said Not spam on a match of it. Everything is forgotten thirty days after it was reported.
 */

const DAY = 86_400_000;
/** How long a report is kept: a fingerprint nobody reports again is forgotten after it. */
export const SHARE_KEEP_MS = 30 * DAY;
/** The window three owners' reports must fall within for a fingerprint to count. */
export const SHARE_WINDOW_MS = 14 * DAY;
/** Owners, other than the reading inbox's own, whose reports make a fingerprint known spam. */
export const SHARE_OWNERS = 3;
/** How old an owner's account must be for its reports to count: one made yesterday counts for nothing. */
export const SHARE_ACCOUNT_AGE_MS = 7 * DAY;
/** Bands two fingerprints must share to be the same message: texts merely on one topic share none. */
export const SHARE_MATCH_BANDS = 2;

export const SHARE_SCHEMA = `
CREATE TABLE IF NOT EXISTS spam_share_owners (owner TEXT PRIMARY KEY, since INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS spam_share_reports (item TEXT PRIMARY KEY, owner TEXT NOT NULL, vote INTEGER NOT NULL, kind TEXT, domain TEXT, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS spam_share_reports_at ON spam_share_reports (at);
CREATE INDEX IF NOT EXISTS spam_share_reports_domain ON spam_share_reports (domain, at) WHERE domain IS NOT NULL;
CREATE TABLE IF NOT EXISTS spam_share_bands (band TEXT NOT NULL, item TEXT NOT NULL, PRIMARY KEY (band, item));
CREATE INDEX IF NOT EXISTS spam_share_bands_item ON spam_share_bands (item);
`;

export const SHARE_TABLES = ["spam_share_owners", "spam_share_reports", "spam_share_bands"] as const;

const NO_MATCH: SharedMatch = { known: false, owners: 0, kind: null, domain: false };
const KINDS = new Set<string>(["pitches", "scams", "junk"]);

interface Report {
  readonly owner: string;
  readonly vote: number;
  readonly kind: string | null;
  readonly at: number;
}

/**
 * What a set of reports says, for one reading owner: the most owners other than it whose reports of
 * spam fall within one fortnight, less the owners who said Not spam; and the kind most of them named.
 */
export function tally(
  reports: readonly Report[],
  reader: string,
): { readonly known: boolean; readonly owners: number; readonly kind: Filter | null } {
  const spam = reports.filter((r) => r.vote === 1 && r.owner !== reader).sort((a, b) => a.at - b.at);
  const inWindow = new Map<string, number>();
  let best = 0;
  for (let i = 0, j = 0; j < spam.length; j++) {
    const right = spam[j] as Report;
    inWindow.set(right.owner, (inWindow.get(right.owner) ?? 0) + 1);
    for (; i < j && right.at - (spam[i] as Report).at > SHARE_WINDOW_MS; i++) {
      const left = (spam[i] as Report).owner;
      const n = (inWindow.get(left) ?? 1) - 1;
      if (n === 0) inWindow.delete(left);
      else inWindow.set(left, n);
    }
    best = Math.max(best, inWindow.size);
  }
  const against = new Set(reports.filter((r) => r.vote === -1).map((r) => r.owner)).size;
  const owners = Math.max(0, best - against);
  const named = new Map<string, Set<string>>();
  for (const r of spam) {
    if (!r.kind || !KINDS.has(r.kind)) continue;
    const who = named.get(r.kind) ?? new Set<string>();
    who.add(r.owner);
    named.set(r.kind, who);
  }
  let kind: Filter | null = null;
  let most = 0;
  for (const [k, who] of named) {
    if (who.size > most) {
      most = who.size;
      kind = k as Filter;
    }
  }
  return { known: owners >= SHARE_OWNERS, owners, kind };
}

export class SharedPrints {
  private readonly key: Buffer;

  constructor(
    private readonly db: DatabaseSync,
    key: string | Buffer,
  ) {
    this.key = Buffer.isBuffer(key) ? key : Buffer.from(key, "utf8");
  }

  /** A keyed hash for one purpose (128 bits, hex): nothing kept here is a value as an inbox knew it. */
  hash(purpose: "owner" | "item" | "band" | "domain", value: string): string {
    return createHmac("sha256", this.key).update(`${purpose}\u0000${value}`).digest("hex").slice(0, 32);
  }

  /** The owner an inbox belongs to: the control plane's account when the policy names it, else its owner's address. */
  ownerOf(p: Pick<PolicyPayload, "owner_email" | "owner_account">): string {
    return p.owner_account?.id
      ? this.hash("owner", `account:${p.owner_account.id}`)
      : this.hash("owner", `email:${p.owner_email.trim().toLowerCase()}`);
  }

  /** Since when an owner is known here: the earliest of their account's creation and the first time it was seen. */
  seen(owner: string, since: number): void {
    this.db
      .prepare(
        "INSERT INTO spam_share_owners (owner, since) VALUES (?, ?) ON CONFLICT (owner) DO UPDATE SET since = MIN(since, excluded.since)",
      )
      .run(owner, since);
  }

  private bandsOf(print: SharedPrint): string[] {
    return [...new Set(print.bands)].slice(0, 16).map((b) => this.hash("band", b));
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
   * One inbox's word on one of its items, replacing any it gave before: known spam (`1`) or Not spam on
   * a match (`-1`). An owner whose account is younger than a week is not counted: nothing of theirs is
   * kept, and false is answered.
   */
  report(r: {
    readonly tenantId: string;
    readonly itemId: string;
    readonly owner: string;
    readonly print: SharedPrint;
    readonly vote: 1 | -1;
    readonly kind: Filter | null;
    readonly now: number;
  }): boolean {
    const item = this.hash("item", `${r.tenantId}:${r.itemId}`);
    const bands = this.bandsOf(r.print);
    return this.tx(() => {
      this.db.prepare("DELETE FROM spam_share_bands WHERE item = ?").run(item);
      this.db.prepare("DELETE FROM spam_share_reports WHERE item = ?").run(item);
      const owner = this.db.prepare("SELECT since FROM spam_share_owners WHERE owner = ?").get(r.owner) as
        | { since: number }
        | undefined;
      if (!owner || r.now - owner.since < SHARE_ACCOUNT_AGE_MS || bands.length === 0) return false;
      this.db
        .prepare("INSERT INTO spam_share_reports (item, owner, vote, kind, domain, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          item,
          r.owner,
          r.vote,
          r.vote === 1 ? r.kind : null,
          r.print.domain ? this.hash("domain", r.print.domain) : null,
          r.now,
        );
      const band = this.db.prepare("INSERT OR IGNORE INTO spam_share_bands (band, item) VALUES (?, ?)");
      for (const b of bands) band.run(b, item);
      return true;
    });
  }

  /** Takes back what an inbox said of one of its items. */
  withdraw(tenantId: string, itemId: string): void {
    const item = this.hash("item", `${tenantId}:${itemId}`);
    this.tx(() => {
      this.db.prepare("DELETE FROM spam_share_bands WHERE item = ?").run(item);
      this.db.prepare("DELETE FROM spam_share_reports WHERE item = ?").run(item);
    });
  }

  /** What the shared list says of a fingerprint, for an inbox of `owner`: a read, nothing is kept. */
  lookup(q: { readonly print: SharedPrint; readonly owner: string; readonly now: number }): SharedMatch {
    const bands = this.bandsOf(q.print);
    if (bands.length === 0) return NO_MATCH;
    const since = q.now - SHARE_KEEP_MS;
    const rows = this.db
      .prepare(
        `SELECT r.owner, r.vote, r.kind, r.at FROM spam_share_reports r
          WHERE r.at >= ? AND r.item IN (
            SELECT item FROM spam_share_bands WHERE band IN (${bands.map(() => "?").join(", ")})
             GROUP BY item HAVING COUNT(*) >= ?)
          ORDER BY r.at DESC LIMIT 2000`,
      )
      .all(since, ...bands, SHARE_MATCH_BANDS) as unknown as Report[];
    const text = tally(rows, q.owner);
    let domain = false;
    if (q.print.domain) {
      const byDomain = this.db
        .prepare(
          "SELECT owner, vote, kind, at FROM spam_share_reports WHERE domain = ? AND at >= ? ORDER BY at DESC LIMIT 2000",
        )
        .all(this.hash("domain", q.print.domain), since) as unknown as Report[];
      domain = tally(byDomain, q.owner).known;
    }
    return { known: text.known, owners: text.owners, kind: text.kind, domain };
  }

  /** Forgets every report past thirty days, and the bands that were only theirs. */
  prune(now: number): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM spam_share_reports WHERE at < ?").run(now - SHARE_KEEP_MS);
      this.db.prepare("DELETE FROM spam_share_bands WHERE item NOT IN (SELECT item FROM spam_share_reports)").run();
    });
  }
}

/**
 * The shared list as one inbox reaches it. Every hosted inbox reads it: a lookup costs no AI, and Free
 * keeps only labels from it. Only an inbox whose marks are hard to fake by the dozen counts for others:
 * on Pro, and live at the business's own domain. The owner is first seen as the inbox opens, or as old
 * as the control plane says their account is.
 */
export function tenantShare(o: {
  readonly prints: SharedPrints;
  readonly tenantId: string;
  readonly policy: PolicyPayload;
  readonly now: number;
}): SharedSpamPort {
  const p = o.policy;
  const owner = o.prints.ownerOf(p);
  const created = Date.parse(p.owner_account?.created_at ?? "");
  o.prints.seen(owner, Number.isFinite(created) ? Math.min(created, o.now) : o.now);
  const contributes = planOf(p) === "pro" && p.state === "live" && !p.read_only;
  return {
    contributes,
    lookup: (print, now) => o.prints.lookup({ print, owner, now }),
    report: (itemId, print, r) =>
      contributes
        ? o.prints.report({ tenantId: o.tenantId, itemId, owner, print, vote: r.vote, kind: r.kind, now: r.now })
        : false,
    withdraw: (itemId) => o.prints.withdraw(o.tenantId, itemId),
  };
}
