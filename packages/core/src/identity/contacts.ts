import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import type { Contact } from "../domain/types";
import { ulid } from "../ids";
import { normaliseEmail } from "../protocol/email";

/**
 * A party's contacts, normalised (ADR-017 §8.2): an email exactly as the networks normalise it, a
 * phone as its digits when there are at least six. What cannot be normalised is not matched on.
 */
export type ContactKind = "email" | "phone";

export interface ContactValue {
  readonly kind: ContactKind;
  readonly value: string;
}

/** A phone as its digits, or null with fewer than six (too short to tell two customers apart). */
export function normalisePhone(phone: string): string | null {
  const digits = phone.replace(/[^0-9]/g, "");
  return digits.length >= 6 && digits.length <= 20 ? digits : null;
}

export function contactValues(contact: Contact | null | undefined): ContactValue[] {
  const out: ContactValue[] = [];
  const email = typeof contact?.email === "string" ? normaliseEmail(contact.email) : null;
  if (email) out.push({ kind: "email", value: email });
  const phone = typeof contact?.phone === "string" ? normalisePhone(contact.phone) : null;
  if (phone) out.push({ kind: "phone", value: phone });
  return out;
}

/**
 * The rows for a party's contacts, for the batch that creates or joins it. `verifiedEmail` marks
 * the email verified (authenticated mail, a one-time code), never the phone.
 */
export function contactStatements(
  partyId: string,
  values: readonly ContactValue[],
  now: number,
  opts: { verifiedEmail?: boolean } = {},
): Statement[] {
  const out: Statement[] = [];
  for (const v of values) {
    const verified = opts.verifiedEmail === true && v.kind === "email" ? now : null;
    out.push({
      sql: `INSERT OR IGNORE INTO party_contacts (id, party_id, kind, value, verified_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [ulid(now), partyId, v.kind, v.value, verified, now],
      method: "run",
    });
    if (verified !== null) {
      out.push({
        sql: "UPDATE party_contacts SET verified_at = ? WHERE party_id = ? AND kind = ? AND value = ? AND verified_at IS NULL",
        params: [now, partyId, v.kind, v.value],
        method: "run",
      });
    }
  }
  return out;
}

/**
 * The customer the business knows for a value: the oldest party with a network link or a verified
 * row for it, else the oldest party with it at all. Merged and erased parties never count.
 */
export async function knownPartyFor(db: Db, v: ContactValue): Promise<string | null> {
  const { rows } = await db.client.query({
    sql: `SELECT c.party_id FROM party_contacts c JOIN parties p ON p.id = c.party_id
           WHERE c.kind = ? AND c.value = ? AND p.merged_into IS NULL AND p.erased_at IS NULL
           ORDER BY CASE WHEN c.verified_at IS NOT NULL
                          OR EXISTS (SELECT 1 FROM person_links l WHERE l.party_id = c.party_id) THEN 0 ELSE 1 END,
                    p.created_at, p.id
           LIMIT 1`,
    params: [v.kind, v.value],
    method: "all",
  });
  const id = rows[0]?.[0];
  return id === undefined || id === null ? null : String(id);
}

/** The party a merged one ended up in (merges can chain), or the party itself. */
export async function rootParty(db: Db, partyId: string): Promise<string> {
  let id = partyId;
  for (let i = 0; i < 8; i++) {
    const { rows } = await db.client.query({
      sql: "SELECT merged_into FROM parties WHERE id = ?",
      params: [id],
      method: "all",
    });
    const next = rows[0]?.[0];
    if (next === undefined || next === null) return id;
    id = String(next);
  }
  return id;
}

/** The known party's email to send a code to: its verified address first, then any. */
export async function emailOf(db: Db, partyId: string): Promise<string | null> {
  const { rows } = await db.client.query({
    sql: `SELECT value FROM party_contacts WHERE party_id = ? AND kind = 'email'
           ORDER BY CASE WHEN verified_at IS NULL THEN 1 ELSE 0 END, created_at LIMIT 1`,
    params: [partyId],
    method: "all",
  });
  const v = rows[0]?.[0];
  return v === undefined || v === null ? null : String(v);
}

/** `ana.silva@example.pt` → `a•••@e•••.pt`: enough for the customer to recognise, too little to learn. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${Array.from(local)[0] ?? ""}•••@${Array.from(host)[0] ?? ""}•••${tld}`;
}

/** SHA-256 hex of a value, with its kind: how a destination is named in `customer_codes` and caches. */
export async function valueHash(kind: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${kind}:${value}`) as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The contacts backfill (0009): `party_contacts` from every party's `contact`, 200 parties a run
 * by id, each run queueing the next from where it stopped, so it resumes after any failure.
 */
export const PARTY_CONTACTS_BACKFILL_KIND = "party_contacts_backfill";
export const BACKFILL_BATCH = 200;

export async function backfillPartyContacts(
  db: Db,
  after: string,
  now: number,
  batch = BACKFILL_BATCH,
): Promise<{ done: number; last: string | null }> {
  const { rows } = await db.client.query({
    sql: "SELECT id, contact, created_at FROM parties WHERE id > ? ORDER BY id LIMIT ?",
    params: [after, batch],
    method: "all",
  });
  const statements: Statement[] = [];
  for (const r of rows) {
    let contact: Contact | null = null;
    try {
      contact = typeof r[1] === "string" ? (JSON.parse(r[1]) as Contact) : null;
    } catch {
      contact = null;
    }
    const at = Number(r[2] ?? now);
    for (const s of contactStatements(String(r[0]), contactValues(contact), at)) statements.push(s);
  }
  // D1 caps a batch's statements; a party has at most two rows, so this stays well under it.
  for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));
  const last = rows.length ? String(rows[rows.length - 1]?.[0]) : null;
  return { done: rows.length, last };
}
