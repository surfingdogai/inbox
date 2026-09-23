import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { shortError } from "../network/index";
import type { SecretBox } from "../secrets/box";
import { itemPresentationStatement, linkStatements } from "./match";
import type { IssueResult } from "./types";

/**
 * A first contact's answers (ADR-017 §2.1), per network, in `pending_identity`. On `201` the key
 * and the first pass are sealed by the secret box: the pass so the status door can hand it back,
 * the key until it rides on the first email to the customer — or, within a day, an email of one
 * line — and then it is gone. Every row is deleted seven days after it was made.
 *
 * The customer most often does not know any of this exists: they wrote to a business. So the key
 * reaches them as the business's own quiet line, a code for their assistant, and nothing else, and
 * only while the business keeps it on (`customers.emailKey`).
 */
export const KEY_LINE = "If you use an assistant, it can show this code next time so we recognise you:";
const KEYS_LINE = "If you use an assistant, it can show these codes next time so we recognise you:";

/** The one line an email to the customer ends with: the key, or with several networks each of them. */
export function keyLine(keys: readonly string[]): string {
  return `${keys.length > 1 ? KEYS_LINE : KEY_LINE} ${keys.join(" ")}`;
}
/** A key waits this long for an email to the customer to ride on, then goes in one of its own. */
export const KEY_ALONE_AFTER_MS = 24 * 3_600_000;
/** Nothing of a first contact is kept longer than this (§2.1, the network's own replay window). */
export const PENDING_TTL_MS = 7 * 24 * 3_600_000;

export type PendingState = "asking" | "issued" | "exists" | "limited" | "refused" | "gave_up";

const sealId = (itemId: string, network: string, what: "key" | "pass") => `${itemId}|${network}|${what}`;

/**
 * The second batch of a first contact: each network's answer, and on `201` the sealed secrets, the
 * item's presentation there and the person's link to the item's party (unless the item is a weak
 * match). An answer that is not final (no answer, a limit) leaves the row asking, and its job asks again.
 */
export async function issuanceStatements(
  box: SecretBox,
  itemId: string,
  /** The item's party, to link the new person to; null on a weak match, which waits for a code (§8.2). */
  partyId: string | null,
  results: readonly IssueResult[],
  now: number,
): Promise<Statement[]> {
  const out: Statement[] = [];
  for (const r of results) {
    switch (r.outcome) {
      case "issued": {
        const keyEnc = await box.seal("person-secret", sealId(itemId, r.network, "key"), r.key);
        const passEnc = await box.seal("person-secret", sealId(itemId, r.network, "pass"), r.pass);
        out.push({
          sql: `INSERT INTO pending_identity (item_id, network, state, key_enc, pass_enc, attempts, last_error, created_at, updated_at)
                VALUES (?, ?, 'issued', ?, ?, 1, NULL, ?, ?)
                ON CONFLICT (item_id, network) DO UPDATE SET state = 'issued', key_enc = excluded.key_enc,
                  pass_enc = excluded.pass_enc, attempts = pending_identity.attempts + 1, last_error = NULL,
                  updated_at = excluded.updated_at
                WHERE pending_identity.state <> 'issued'`,
          params: [itemId, r.network, keyEnc, passEnc, now, now],
          method: "run",
        });
        out.push(itemPresentationStatement(itemId, r.presentation, now));
        if (partyId !== null) out.push(...linkStatements(partyId, r.presentation, now));
        break;
      }
      case "person_exists":
        out.push(stateStatement(itemId, r.network, "exists", null, now));
        break;
      case "rate_limited":
        out.push(stateStatement(itemId, r.network, "limited", "the network's issuance limit for today", now));
        break;
      case "refused":
        out.push(stateStatement(itemId, r.network, "refused", r.error, now));
        break;
      case "unreachable":
        out.push(stateStatement(itemId, r.network, "asking", r.error, now));
        break;
    }
  }
  return out;
}

function stateStatement(itemId: string, network: string, state: PendingState, error: string | null, now: number) {
  return {
    sql: `INSERT INTO pending_identity (item_id, network, state, attempts, last_error, created_at, updated_at)
          VALUES (?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT (item_id, network) DO UPDATE SET state = excluded.state, last_error = excluded.last_error,
            attempts = pending_identity.attempts + 1, updated_at = excluded.updated_at
          WHERE pending_identity.state IN ('asking', 'limited')`,
    params: [itemId, network, state, error === null ? null : shortError(error), now, now],
    method: "run" as const,
  };
}

export interface PendingRow {
  readonly network: string;
  readonly state: PendingState;
  readonly attempts: number;
  readonly createdAt: number;
  readonly hasKey: boolean;
  readonly hasPass: boolean;
}

export async function pendingFor(db: Db, itemId: string): Promise<PendingRow[]> {
  const { rows } = await db.client.query({
    sql: `SELECT network, state, attempts, created_at, key_enc IS NOT NULL, pass_enc IS NOT NULL
            FROM pending_identity WHERE item_id = ? ORDER BY network`,
    params: [itemId],
    method: "all",
  });
  return rows.map((r) => ({
    network: String(r[0]),
    state: String(r[1]) as PendingState,
    attempts: Number(r[2] ?? 0),
    createdAt: Number(r[3] ?? 0),
    hasKey: Number(r[4]) === 1,
    hasPass: Number(r[5]) === 1,
  }));
}

/** The first passes a first contact got, opened, for the answer that hands them back. */
export async function passesFor(
  db: Db,
  box: SecretBox | null,
  itemId: string,
): Promise<{ network: string; pass: string }[]> {
  if (!box) return [];
  const { rows } = await db.client.query({
    sql: "SELECT network, pass_enc FROM pending_identity WHERE item_id = ? AND pass_enc IS NOT NULL ORDER BY network",
    params: [itemId],
    method: "all",
  });
  const out: { network: string; pass: string }[] = [];
  for (const r of rows) {
    try {
      out.push({
        network: String(r[0]),
        pass: await box.open("person-secret", sealId(itemId, String(r[0]), "pass"), String(r[1])),
      });
    } catch {
      // Sealed under a key this instance no longer has: nothing to hand back.
    }
  }
  return out;
}

/** The keys still waiting for the customer, opened, one per network. */
export async function keysFor(
  db: Db,
  box: SecretBox | null,
  itemId: string,
): Promise<{ network: string; key: string }[]> {
  if (!box) return [];
  const { rows } = await db.client.query({
    sql: `SELECT network, key_enc FROM pending_identity
           WHERE item_id = ? AND key_enc IS NOT NULL AND delivered_at IS NULL ORDER BY network`,
    params: [itemId],
    method: "all",
  });
  const out: { network: string; key: string }[] = [];
  for (const r of rows) {
    try {
      out.push({
        network: String(r[0]),
        key: await box.open("person-secret", sealId(itemId, String(r[0]), "key"), String(r[1])),
      });
    } catch {
      // As above: a key nobody can open is a key nobody can deliver.
    }
  }
  return out;
}

/** The key went out: it is deleted, and the row remembers when. */
export function keysDeliveredStatement(itemId: string, networks: readonly string[], now: number): Statement {
  return {
    sql: `UPDATE pending_identity SET key_enc = NULL, delivered_at = ?, updated_at = ?
           WHERE item_id = ? AND network IN (${networks.map(() => "?").join(", ")}) AND delivered_at IS NULL`,
    params: [now, now, itemId, ...networks],
    method: "run",
  };
}

/** Items whose keys have waited a day for an email to ride on. */
export async function keysDueAlone(db: Db, now: number, limit: number): Promise<string[]> {
  const { rows } = await db.client.query({
    sql: `SELECT DISTINCT item_id FROM pending_identity
           WHERE key_enc IS NOT NULL AND delivered_at IS NULL AND created_at <= ? ORDER BY item_id LIMIT ?`,
    params: [now - KEY_ALONE_AFTER_MS, limit],
    method: "all",
  });
  return rows.map((r) => String(r[0]));
}

/** Seven days on, a first contact leaves nothing behind but its presentation and link. */
export async function prunePending(db: Db, now: number): Promise<number> {
  const r = await db.client.query({
    sql: "DELETE FROM pending_identity WHERE created_at < ?",
    params: [now - PENDING_TTL_MS],
    method: "run",
  });
  return r.changes;
}

/** Whether the item is still waiting for a network's first answer: its promise waits for it (§3.2). */
export async function identityPending(db: Db, itemId: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM pending_identity WHERE item_id = ? AND state = 'asking' LIMIT 1",
    params: [itemId],
    method: "all",
  });
  return rows.length > 0;
}
