import type { Statement } from "@surfingdog/platform";
import { oneLine } from "../customer/format";
import type { Db } from "../db";
import { jobStatement } from "../write/common";
import type { JobHandler } from "./runner";
import { ensureJob } from "./schedule";

/**
 * A code or a sign-in link for an account the business holds (`flags.account`) is the owner's for a
 * day. Twenty-four hours after each such email arrived, every code and every link in what the inbox
 * keeps of it is replaced with a short marker (`CLEARED`): its words and its subject on the thread,
 * which the search index follows; the item's own text and subject; the words a reply that reopened
 * the item left in its history; the subject as the owner's alerts and the hour's digest said it; and
 * the copy a second delivery of the same email is answered from (`idempotency_keys`). The message
 * stays, with its subject and the rest of its words. Nothing else is cleared, and nothing of any
 * other item.
 *
 * Each email is cleared by a job of its own, due a day after it came (`account_clear:<entry>`). The
 * lifecycle sweep queues it, for every such email of the last week that has none: a job done is kept
 * a week (`pruneJobs`), so none is queued twice, and an email written by any door is found. Clearing
 * the same text again changes nothing. The search index forgets the old words only when its segments
 * are merged: once a quarter hour that cleared any (`ACCOUNT_CLEAR_INDEX_KIND`).
 */
export const ACCOUNT_CLEAR_KIND = "account_clear";
/** The search index merged after a quarter hour's clearing, so the old words leave its pages too. */
export const ACCOUNT_CLEAR_INDEX_KIND = "account_clear_index";
/** How long a code or a link is kept. */
export const ACCOUNT_KEPT_MS = 24 * 3_600_000;
/** What a code or a link reads as once it is removed. */
export const CLEARED = "[removed after 24 hours]";
/** How far back the sweep looks: within the week a job done is kept. */
const LOOKBACK_MS = 7 * 86_400_000;
/** At most one index merge in this long, at its end. */
const MERGE_PERIOD_MS = 15 * 60_000;

/** An http(s) or www address, whole: a sign-in link's token is anywhere in it. */
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
/**
 * What follows a word that names a code ("code", "PIN", "OTP", "passcode", "código",
 * "Sicherheitscode"), after "is" or a colon or neither: a code whatever its case, when it holds a
 * digit ("abc123", "x7k9q2"), or digits one by one ("4 8 1 5 1 6"). A word stays ("is valid").
 */
const NAMED =
  /(?<![\p{L}\p{N}])((?:\p{L}*(?:code|kode|codice|c[oó]digo)|kod|pin|passcode|otp)(?!\p{L})(?:\s+(?:is|es|est|ist|é|è|är|er|jest|lautet)(?!\p{L}))?\s*[:：]?\s*)(?:\d(?: \d){3,11}|(?=[\p{L}\p{N}-]*\d)[\p{L}\p{N}][\p{L}\p{N}-]{2,30}[\p{L}\p{N}])(?![\p{L}\p{N}])/giu;
/**
 * A code of capitals and digits: "F4K7J", "X7K9Q2", "XK7-93Q", "G-482913". Only one with both: a
 * word in capitals stays.
 */
const MIXED =
  /(?<![\p{L}\p{N}_@-])(?:[A-Z]{1,4}-\d{4,10}|[A-Z0-9]{3,5}(?:-[A-Z0-9]{3,5}){1,3}|[A-Z0-9]{5,12})(?![\p{L}\p{N}_@]|-[\p{L}\p{N}])/gu;
/** A line that is only letters and digits mixed, in any case ("x7k9q2"): a code set apart. */
const LONE = /^([^\S\n]*)([\p{L}\p{N}][\p{L}\p{N}-]{2,14}[\p{L}\p{N}])([^\S\n]*)$/gmu;
/** A currency, as a symbol or a code, beside an amount. */
const CURRENCY =
  "\\p{Sc}|(?:EUR|USD|GBP|CHF|BRL|CAD|AUD|JPY|SEK|NOK|DKK|PLN|CZK|HUF|RON|INR|MXN|ZAR|CNY|AED)(?![\\p{L}])";
/**
 * A code of digits: four or more in a row, or groups of three or four ("123 456", "4821-9375").
 * Never part of a word, an address, a date, a time, or an amount with its currency before or after it
 * ("2026-11-01", "10:30", "€45", "1500.00", "1500 €", "EUR 1500"). A number that only looks like one
 * goes too: a postcode, a phone number's end, an invoice's number.
 */
const DIGITS = new RegExp(
  `(?<![\\p{L}\\p{N}\\p{Sc}_@])(?<!\\p{N}[-/.:,])(?<!(?:${CURRENCY})[^\\S\\n])(?:\\d{3,4}(?:[ -]\\d{3,4}){1,3}|\\d{4,})(?![\\p{L}\\p{N}\\p{Sc}_@]|[-/.:,]\\p{N}|[^\\S\\n](?:${CURRENCY}))`,
  "gu",
);
/** A year stays where it reads as one: after a © or in a date ("© 2026", "1 November 2026"). */
const YEAR = /^(?:19|20)\d\d$/;
/** What, on its line, comes before a year that reads as one. */
const DATED =
  /(?:©|\(c\)|copyright|(?<!\p{L})(?:jan|ene|gen|fe[bv]|fév|m[aä]r|apr|abr|avr|ma[yi]|mag|ju[nil]|giu|lug|aug|ago|ao[uû]|se[pt]|o[cku]t|ott|nov|de[cz]|dic|déc)\p{L}*\.?(?:[^\S\n]+\d{1,2}(?:st|nd|rd|th)?,?)?[^\S\n]+(?:de[^\S\n]+)?$)/iu;

/**
 * The text with each code and link replaced by `CLEARED`, and how many went. A run of lines that are
 * each only a link (the links an email carried, under its words) reads as one marker.
 */
export function clearCodes(text: string): { readonly text: string; readonly removed: number } {
  let removed = 0;
  const cleared = () => {
    removed++;
    return CLEARED;
  };
  const out = text
    .replace(LINK, (link) => `${cleared()}${/[.,;:!?)\]}]+$/.exec(link)?.[0] ?? ""}`)
    .replace(MIXED, (code) => (/\d/.test(code) && /[A-Z]/.test(code) ? cleared() : code))
    .replace(DIGITS, (code: string, at: number, whole: string) =>
      YEAR.test(code) && DATED.test(whole.slice(whole.lastIndexOf("\n", at) + 1, at)) ? code : cleared(),
    )
    .replace(NAMED, (_, lead: string) => `${lead}${cleared()}`)
    .replace(LONE, (all, a: string, code: string, b: string) =>
      /\d/.test(code) && /\p{L}/u.test(code) ? `${a}${cleared()}${b}` : all,
    );
  const lines = out.split("\n");
  const kept = lines.filter((line, i) => !(line.trim() === CLEARED && lines[i - 1]?.trim() === CLEARED));
  return { text: kept.join("\n"), removed };
}

/**
 * Queues the clearing of every email on an account's item that came in the last week and has none
 * queued, due a day after it came. Answers how many it queued.
 */
export async function queueAccountClears(db: Db, now: number, batch: number): Promise<number> {
  const since = now - LOOKBACK_MS;
  // An item's `updated_at` is never before its latest email: the index on it finds the week's items.
  const { rows } = await db.client.query({
    sql: `SELECT e.id, e.item_id, e.created_at FROM items i JOIN thread_entries e ON e.item_id = i.id
           WHERE i.type = 'message' AND i.updated_at > ? AND json_extract(i.flags, '$.account') = 1
             AND e.direction = 'in' AND e.created_at > ?
             AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.dedupe_key = ? || e.id)
           ORDER BY e.created_at, e.id LIMIT ?`,
    params: [since, since, `${ACCOUNT_CLEAR_KIND}:`, batch],
    method: "all",
  });
  for (const r of rows) {
    await ensureJob(db, ACCOUNT_CLEAR_KIND, `${ACCOUNT_CLEAR_KIND}:${String(r[0])}`, {
      now,
      runAt: Number(r[2]) + ACCOUNT_KEPT_MS,
      payload: { itemId: String(r[1]), entryId: String(r[0]) },
    });
  }
  return rows.length;
}

/** The job: one email's codes and links removed, wherever the inbox keeps them. */
export function accountClearHandler(): JobHandler {
  return async (job, { db, now }) => {
    const p = (job.payload ?? {}) as { itemId?: unknown; entryId?: unknown };
    if (typeof p.itemId !== "string" || typeof p.entryId !== "string") return { note: "nothing named" };
    const removed = await clearAccountMail(db, p.itemId, p.entryId, now);
    if (removed === null) return { note: "not an account's email" };
    return { note: removed ? `${removed} removed` : "nothing to remove" };
  };
}

/** The job: the search index's segments merged, so a cleared email's old words leave its pages. */
export function accountClearIndexHandler(): JobHandler {
  return async (_job, { db }) => {
    await db.client.query({ sql: "INSERT INTO search_fts(search_fts) VALUES ('optimize')", params: [], method: "run" });
    return { note: "search index merged" };
  };
}

/**
 * One email of an account's item cleared, with the item's own text and subject, its history and the
 * copies a retry is answered from. Each write only replaces the text it read, so an erasure or
 * another write that lands meanwhile is never undone. Answers how many codes and links went; null
 * when the item is not an account's, or the email is gone.
 */
export async function clearAccountMail(db: Db, itemId: string, entryId: string, now: number): Promise<number | null> {
  const { rows } = await db.client.query({
    sql: `SELECT e.body_text, e.subject, i.subject, json_extract(i.payload, '$.text'), json_extract(i.payload, '$.subject')
            FROM thread_entries e JOIN items i ON i.id = e.item_id
           WHERE e.id = ? AND e.item_id = ? AND e.direction = 'in' AND json_extract(i.flags, '$.account') = 1`,
    params: [entryId, itemId],
    method: "all",
  });
  const row = rows[0];
  if (!row) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const [body, subject, itemSubject, text, payloadSubject] = [row[0], row[1], row[2], row[3], row[4]].map(str);
  const statements: Statement[] = [];
  // The texts as they are kept, and as they will be: what any copy of them is replaced with.
  const cleared = new Map<string, string>();
  let removed = 0;
  /** The text with its codes and links out, or null when it holds none. */
  const clear = (was: string | null | undefined): string | null => {
    if (typeof was !== "string") return null;
    const known = cleared.get(was);
    if (known !== undefined) return known;
    const c = clearCodes(was);
    if (!c.removed) return null;
    removed += c.removed;
    cleared.set(was, c.text);
    return c.text;
  };

  // Its words and its subject on the thread. The search index follows them, and forgets the old ones
  // when its segments are merged: once a quarter hour that cleared any, at its end.
  const words = clear(body);
  const said = clear(subject);
  if (words !== null || said !== null) {
    statements.push({
      sql: "UPDATE thread_entries SET body_text = ?, subject = ? WHERE id = ? AND body_text IS ? AND subject IS ?",
      params: [words ?? body, said ?? subject, entryId, body, subject],
      method: "run",
    });
    const period = Math.floor(now / MERGE_PERIOD_MS);
    statements.push(
      jobStatement(ACCOUNT_CLEAR_INDEX_KIND, {}, now, {
        dedupeKey: `${ACCOUNT_CLEAR_INDEX_KIND}:${period}`,
        runAt: (period + 1) * MERGE_PERIOD_MS,
      }),
    );
  }
  // The item's own text and subject, its first email's: that email is the first cleared.
  for (const [path, was] of [
    ["$.text", text],
    ["$.subject", payloadSubject],
  ] as const) {
    const next = clear(was);
    if (next === null) continue;
    statements.push({
      sql: `UPDATE items SET payload = json_set(payload, '${path}', ?) WHERE id = ? AND json_extract(payload, '${path}') = ?`,
      params: [next, itemId, was],
      method: "run",
    });
  }
  const titled = clear(itemSubject);
  if (titled !== null) {
    statements.push({
      sql: "UPDATE items SET subject = ? WHERE id = ? AND subject = ?",
      params: [titled, itemId, itemSubject],
      method: "run",
    });
  }
  // A reply that reopened the item left its words in the item's history too, as the note it moved on.
  if (body?.trim()) {
    const { rows: events } = await db.client.query({
      sql: "SELECT id, json_extract(meta, '$.input.note') FROM item_events WHERE item_id = ? AND json_type(meta, '$.input.note') = 'text'",
      params: [itemId],
      method: "all",
    });
    for (const [id, note] of events) {
      if (typeof note !== "string" || note.trim() !== body.trim()) continue;
      const again = clear(note);
      if (again === null) continue;
      statements.push({
        sql: "UPDATE item_events SET meta = json_set(meta, '$.input.note', ?) WHERE id = ? AND json_extract(meta, '$.input.note') = ?",
        params: [again, String(id), note],
        method: "run",
      });
    }
  }
  // A subject is also said inside other words ("New message from Acme: <subject>"): each subject
  // cleared, as it was kept and on one line, is replaced wherever it is said.
  const subjects = new Map<string, string>();
  for (const [was, next] of [
    [itemSubject, titled],
    [subject, said],
  ] as const) {
    if (!was || next === null) continue;
    subjects.set(was, next);
    if (oneLine(was)) subjects.set(oneLine(was), oneLine(next));
  }
  const swap = (t: string) => [...subjects].reduce((out, [from, to]) => out.replaceAll(from, to), t);
  // The subject as the owner's alerts said it, and as the hour's digest named an alert it held back.
  if (subjects.size) {
    const { rows: mails } = await db.client.query({
      sql: "SELECT id, subject, body_text, skip_reason FROM outbound_mail WHERE item_id = ?",
      params: [itemId],
      method: "all",
    });
    for (const [id, was, wrote, skip] of mails) {
      if (typeof was !== "string" || typeof wrote !== "string") continue;
      const [line, text] = [swap(was), swap(wrote)];
      if (line === was && text === wrote) continue;
      statements.push({
        sql: "UPDATE outbound_mail SET subject = ?, body_text = ? WHERE id = ? AND subject = ? AND body_text = ?",
        params: [line, text, String(id), was, wrote],
        method: "run",
      });
      if (skip !== "alert_limit" || line === was) continue;
      const [from, to] = [`- ${oneLine(was)}`, `- ${oneLine(line)}`];
      statements.push({
        sql: "UPDATE outbound_mail SET body_text = replace(body_text, ?, ?) WHERE template = 'owner.digest' AND instr(body_text, ?) > 0",
        params: [from, to, from],
        method: "run",
      });
    }
  }
  // The copies a second delivery of the same email is answered from.
  if (cleared.size) {
    const { rows: kept } = await db.client.query({
      sql: "SELECT scope, key, response FROM idempotency_keys WHERE item_id = ?",
      params: [itemId],
      method: "all",
    });
    const copy = (t: string) => cleared.get(t) ?? swap(t);
    for (const [scope, key, response] of kept) {
      if (typeof response !== "string") continue;
      let again: string;
      try {
        again = JSON.stringify(replaceTexts(JSON.parse(response) as unknown, copy));
      } catch {
        continue;
      }
      if (again === response) continue;
      statements.push({
        sql: "UPDATE idempotency_keys SET response = ? WHERE scope = ? AND key = ? AND response = ?",
        params: [again, String(scope), String(key), response],
        method: "run",
      });
    }
  }
  if (statements.length) await db.batch(statements);
  return removed;
}

/** A stored answer with each of its strings as `copy` gives it; nothing else touched. */
function replaceTexts(value: unknown, copy: (text: string) => string): unknown {
  if (typeof value === "string") return copy(value);
  if (Array.isArray(value)) return value.map((v) => replaceTexts(v, copy));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceTexts(v, copy)]));
  }
  return value;
}
