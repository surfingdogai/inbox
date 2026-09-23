import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { ulid } from "../ids";
import type { Settings } from "../settings/schema";
import { WriteError } from "../write/errors";
import { emailOf, maskEmail, rootParty, valueHash } from "./contacts";

/**
 * One-time codes (ADR-017 §8.2): the way a weak match — the same email as a customer the business
 * knows, and nothing that proves it — becomes a strong one. Six digits go to the known party's
 * address, never to one the caller typed; the code is stored hashed, works for `otp.ttlMinutes`,
 * for `otp.attempts` wrong tries, and an address gets at most `otp.sendsPerHour` of them an hour
 * and `otp.sendsPerDay` a day, and at most `otp.guessesPerDay` tries at them a day, right or
 * wrong. Every limit is counted in the statement that spends it, so requests sent together cannot
 * each see room for one more. The right code verifies every contact row with that address and
 * merges every party holding it into the known one, in one batch.
 *
 * The messages here reach the customer through their assistant, so they are the business speaking.
 */
export interface CodeRequest {
  readonly itemId: string;
  /** The known party the code proves the customer is. */
  readonly knownPartyId: string;
  readonly email: string;
  readonly code: string;
  readonly sentTo: string;
}

const HOUR = 3_600_000;
/** The daily limits are a rolling day; the hourly housekeeping deletes codes older than that. */
const DAY = 24 * HOUR;

const ALREADY = "We already recognise this customer; there is nothing to check.";
const NOTHING = "We have no earlier customer with these details, so there is nothing to check.";
const TOO_MANY_TRIES = "Too many wrong tries; ask for a new code.";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function codeHash(id: string, code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${id}:${code}`) as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Six digits, uniformly: rejection sampling, so no digit string is likelier than another. */
export function sixDigits(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0] as number;
    if (v < 4_294_000_000) return String(v % 1_000_000).padStart(6, "0");
  }
}

/** The item a code is asked for, and what it could prove. */
export interface VerifyTarget {
  readonly itemId: string;
  readonly partyId: string;
  readonly match: string | null;
  readonly possiblePartyId: string | null;
}

/**
 * Makes a code for the item's known party, or says why there is nothing to verify. The caller
 * sends it; nothing here touches mail.
 */
export async function createCode(db: Db, target: VerifyTarget, settings: Settings, now: number): Promise<CodeRequest> {
  if (target.match === "strong") throw new WriteError("already_verified", ALREADY);
  if (!target.possiblePartyId) throw new WriteError("nothing_to_verify", NOTHING);
  const known = await rootParty(db, target.possiblePartyId);
  const email = await emailOf(db, known);
  if (!email) {
    throw new WriteError(
      "nothing_to_verify",
      "We have no email address for this customer, so we cannot send a code; codes go by email only.",
    );
  }
  const otp = settings.customers.otp;
  const destination = await valueHash("email", email);
  const id = ulid(now);
  const code = sixDigits();
  // Counted and written in one statement, the hour's limit and the day's: requests sent together
  // cannot each see room for one more and all get a code.
  const inserted = await db.client.query({
    sql: `INSERT INTO customer_codes (id, destination_hash, item_id, party_id, code_hash, attempts, expires_at, created_at)
          SELECT ?, ?, ?, ?, ?, 0, ?, ?
           WHERE (SELECT COUNT(*) FROM customer_codes WHERE destination_hash = ? AND created_at > ?) < ?
             AND (SELECT COUNT(*) FROM customer_codes WHERE destination_hash = ? AND created_at > ?) < ?`,
    params: [
      id,
      destination,
      target.itemId,
      known,
      await codeHash(id, code),
      now + otp.ttlMinutes * 60_000,
      now,
      destination,
      now - HOUR,
      otp.sendsPerHour,
      destination,
      now - DAY,
      otp.sendsPerDay,
    ],
    method: "run",
  });
  if (inserted.changes === 0) {
    // Which limit it was, for the message only: the refusal itself was decided above.
    const today = await countSince(db, destination, now - DAY);
    throw new WriteError(
      "too_many_attempts",
      today >= otp.sendsPerDay
        ? `We have sent ${plural(otp.sendsPerDay, "code")} to this address today; please try again tomorrow.`
        : `We have sent ${plural(otp.sendsPerHour, "code")} to this address in the last hour; please try again later.`,
    );
  }
  return { itemId: target.itemId, knownPartyId: known, email, code, sentTo: maskEmail(email) };
}

/**
 * Checks a code for the item. Right: the known party's address is verified wherever it is held,
 * every party holding it is merged into the known one, and the item is recognised. Wrong: counted;
 * past `otp.attempts` the code stops working even when right.
 */
export async function checkCode(
  db: Db,
  target: VerifyTarget,
  code: string,
  settings: Settings,
  now: number,
): Promise<{ partyId: string }> {
  if (target.match === "strong") throw new WriteError("already_verified", ALREADY);
  if (!target.possiblePartyId) throw new WriteError("nothing_to_verify", NOTHING);
  const otp = settings.customers.otp;
  const { rows } = await db.client.query({
    sql: `SELECT id, party_id, attempts, expires_at, used_at, destination_hash FROM customer_codes
           WHERE item_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    params: [target.itemId],
    method: "all",
  });
  const row = rows[0];
  if (!row || row[4] !== null) {
    throw new WriteError("bad_code", "That is not the code; ask for a new one if it has not arrived.");
  }
  const id = String(row[0]);
  const destination = String(row[5]);
  const known = await rootParty(db, String(row[1]));
  if (Number(row[2]) >= otp.attempts) throw new WriteError("too_many_attempts", TOO_MANY_TRIES);
  if (Number(row[3]) <= now) throw new WriteError("code_expired", "That code has expired; ask for a new one.");
  // Every try is counted before the code is compared, in one statement that also checks there is a
  // try left — on this code (`otp.attempts`) and at this address today (`otp.guessesPerDay`, over
  // every code sent there): guesses sent together cannot all read the same count and exceed either.
  const reserved = await db.client.query({
    sql: `UPDATE customer_codes SET attempts = attempts + 1
           WHERE id = ? AND used_at IS NULL AND attempts < ? AND expires_at > ?
             AND (SELECT COALESCE(SUM(attempts), 0) FROM customer_codes WHERE destination_hash = ? AND created_at > ?) < ?`,
    params: [id, otp.attempts, now, destination, now - DAY, otp.guessesPerDay],
    method: "run",
  });
  if (reserved.changes === 0) {
    const today = await triesSince(db, destination, now - DAY);
    throw new WriteError(
      "too_many_attempts",
      today >= otp.guessesPerDay
        ? "Too many tries at a code for this address today; please try again tomorrow."
        : TOO_MANY_TRIES,
    );
  }
  if (!/^[0-9]{6}$/.test(code) || (await codeHash(id, code)) !== (await storedHash(db, id))) {
    throw new WriteError("bad_code", "That is not the code.");
  }
  const email = await emailOf(db, known);
  const statements: Statement[] = [
    { sql: "UPDATE customer_codes SET used_at = ? WHERE id = ? AND used_at IS NULL", params: [now, id], method: "run" },
  ];
  if (email) statements.push(...(await mergeStatements(db, known, "email", email, now)));
  statements.push(
    ...mergePartyStatements(known, target.partyId, now),
    {
      sql: "UPDATE items SET customer_match = 'strong', possible_party_id = NULL WHERE id = ?",
      params: [target.itemId],
      method: "run",
    },
    // The item's presentations are this customer's: their people are linked to the known party now.
    {
      sql: `INSERT OR IGNORE INTO person_links (party_id, network, ppid, pass_hash, person, created_at, updated_at)
            SELECT ?, network, ppid, NULL, person, ?, ? FROM item_presentations WHERE item_id = ? AND ppid IS NOT NULL`,
      params: [known, now, now, target.itemId],
      method: "run",
    },
  );
  await db.batch(statements);
  return { partyId: known };
}

/** Codes sent to an address since `since`. */
async function countSince(db: Db, destination: string, since: number): Promise<number> {
  const { rows } = await db.client.query({
    sql: "SELECT COUNT(*) FROM customer_codes WHERE destination_hash = ? AND created_at > ?",
    params: [destination, since],
    method: "all",
  });
  return Number(rows[0]?.[0] ?? 0);
}

/** Tries at the codes sent to an address since `since`. */
async function triesSince(db: Db, destination: string, since: number): Promise<number> {
  const { rows } = await db.client.query({
    sql: "SELECT COALESCE(SUM(attempts), 0) FROM customer_codes WHERE destination_hash = ? AND created_at > ?",
    params: [destination, since],
    method: "all",
  });
  return Number(rows[0]?.[0] ?? 0);
}

async function storedHash(db: Db, id: string): Promise<string> {
  const { rows } = await db.client.query({
    sql: "SELECT code_hash FROM customer_codes WHERE id = ?",
    params: [id],
    method: "all",
  });
  return String(rows[0]?.[0] ?? "");
}

/**
 * A code verifies an address everywhere it is held, and merges every party holding it into the
 * known one (R27's accepted cost: that may pull in items someone else made with the address).
 */
async function mergeStatements(db: Db, known: string, kind: string, value: string, now: number): Promise<Statement[]> {
  const out: Statement[] = [
    {
      sql: "UPDATE party_contacts SET verified_at = ? WHERE kind = ? AND value = ? AND verified_at IS NULL",
      params: [now, kind, value],
      method: "run",
    },
  ];
  const { rows } = await db.client.query({
    sql: `SELECT DISTINCT c.party_id FROM party_contacts c JOIN parties p ON p.id = c.party_id
           WHERE c.kind = ? AND c.value = ? AND c.party_id <> ? AND p.merged_into IS NULL LIMIT 50`,
    params: [kind, value, known],
    method: "all",
  });
  for (const r of rows) out.push(...mergePartyStatements(known, String(r[0]), now));
  return out;
}

/** One party folded into another: its items, thread entries, links and contacts move; it points there. */
export function mergePartyStatements(into: string, from: string, now: number): Statement[] {
  if (into === from) return [];
  return [
    // Not a transition: no version, no event, and `updated_at` stays, so no list reorders under a reader.
    { sql: "UPDATE items SET party_id = ? WHERE party_id = ?", params: [into, from], method: "run" },
    { sql: "UPDATE thread_entries SET party_id = ? WHERE party_id = ?", params: [into, from], method: "run" },
    // A person already linked on that network to the party it joins keeps its link; the other goes.
    {
      sql: "UPDATE OR IGNORE person_links SET party_id = ?, updated_at = ? WHERE party_id = ?",
      params: [into, now, from],
      method: "run",
    },
    { sql: "DELETE FROM person_links WHERE party_id = ?", params: [from], method: "run" },
    {
      sql: `INSERT OR IGNORE INTO party_contacts (id, party_id, kind, value, verified_at, created_at)
            SELECT id || ':' || ?, ?, kind, value, verified_at, created_at FROM party_contacts WHERE party_id = ?`,
      params: [into, into, from],
      method: "run",
    },
    {
      sql: "UPDATE items SET possible_party_id = NULL, customer_match = 'strong' WHERE party_id = ? AND possible_party_id = ?",
      params: [into, into],
      method: "run",
    },
    {
      sql: "UPDATE parties SET merged_into = ?, updated_at = ? WHERE id = ? AND merged_into IS NULL",
      params: [into, now, from],
      method: "run",
    },
  ];
}
