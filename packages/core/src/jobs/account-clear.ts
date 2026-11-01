import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import type { JobHandler } from "./runner";
import { ensureJob } from "./schedule";

/**
 * A code or a sign-in link for an account the business holds (`flags.account`) is the owner's for a
 * day. Twenty-four hours after each such email arrived, every code and every link in what the inbox
 * keeps of it is replaced with a short marker (`CLEARED`): its words on the thread, which the search
 * index follows; the item's own text; and the copy a second delivery of the same email is answered
 * from (`idempotency_keys`). The message stays, with its subject and the rest of its words. Nothing
 * else is cleared, and nothing of any other item.
 *
 * Each email is cleared by a job of its own, due a day after it came (`account_clear:<entry>`). The
 * lifecycle sweep queues it, for every such email of the last week that has none: a job done is kept
 * a week (`pruneJobs`), so none is queued twice, and an email written by any door is found. Clearing
 * the same text again changes nothing.
 */
export const ACCOUNT_CLEAR_KIND = "account_clear";
/** How long a code or a link is kept. */
export const ACCOUNT_KEPT_MS = 24 * 3_600_000;
/** What a code or a link reads as once it is removed. */
export const CLEARED = "[removed after 24 hours]";
/** How far back the sweep looks: within the week a job done is kept. */
const LOOKBACK_MS = 7 * 86_400_000;

/** An http(s) or www address, whole: a sign-in link's token is anywhere in it. */
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
/**
 * A code of capitals and digits: "X7K9Q2", "XK7-93Q", "G-482913". Only one with both: a word in
 * capitals stays.
 */
const MIXED =
  /(?<![\p{L}\p{N}_@-])(?:[A-Z]{1,4}-\d{4,10}|[A-Z0-9]{3,5}(?:-[A-Z0-9]{3,5}){1,3}|[A-Z0-9]{6,12})(?![\p{L}\p{N}_@]|-[\p{L}\p{N}])/gu;
/**
 * A code of digits: four to twelve in a row, or groups of three or four ("123 456", "4821-9375").
 * Never part of a word, an address, a date, a time or an amount ("2026-11-01", "10:30", "€45",
 * "1500.00"); a number that only looks like one goes too (a postcode, a phone number's end).
 */
const DIGITS =
  /(?<![\p{L}\p{N}\p{Sc}_@])(?<!\p{N}[-/.:,])(?:\d{3,4}(?:[ -]\d{3,4}){1,3}|\d{4,12})(?![\p{L}\p{N}\p{Sc}_@]|[-/.:,]\p{N})/gu;
/** A year stays: "© 2026" is no code. */
const YEAR = /^(?:19|20)\d\d$/;

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
    .replace(DIGITS, (code) => (YEAR.test(code) ? code : cleared()));
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
  return async (job, { db }) => {
    const p = (job.payload ?? {}) as { itemId?: unknown; entryId?: unknown };
    if (typeof p.itemId !== "string" || typeof p.entryId !== "string") return { note: "nothing named" };
    const removed = await clearAccountMail(db, p.itemId, p.entryId);
    if (removed === null) return { note: "not an account's email" };
    return { note: removed ? `${removed} removed` : "nothing to remove" };
  };
}

/**
 * One email of an account's item cleared, with the item's own text and the copies a retry is
 * answered from. Each write only replaces the text it read, so an erasure or another write that
 * lands meanwhile is never undone. Null when the item is not an account's, or the email is gone.
 */
export async function clearAccountMail(db: Db, itemId: string, entryId: string): Promise<number | null> {
  const { rows } = await db.client.query({
    sql: `SELECT e.body_text, json_extract(i.payload, '$.text') FROM thread_entries e JOIN items i ON i.id = e.item_id
           WHERE e.id = ? AND e.item_id = ? AND e.direction = 'in' AND json_extract(i.flags, '$.account') = 1`,
    params: [entryId, itemId],
    method: "all",
  });
  const row = rows[0];
  if (!row) return null;
  const statements: Statement[] = [];
  // The texts as they are kept, and as they will be: what any copy of them is replaced with.
  const cleared = new Map<string, string>();
  const body = typeof row[0] === "string" ? row[0] : "";
  const entry = clearCodes(body);
  if (entry.removed) {
    cleared.set(body, entry.text);
    statements.push({
      sql: "UPDATE thread_entries SET body_text = ? WHERE id = ? AND body_text = ?",
      params: [entry.text, entryId, body],
      method: "run",
    });
  }
  const text = typeof row[1] === "string" ? row[1] : null;
  const own = text === null ? null : clearCodes(text);
  if (text !== null && own?.removed) {
    cleared.set(text, own.text);
    statements.push({
      sql: "UPDATE items SET payload = json_set(payload, '$.text', ?) WHERE id = ? AND json_extract(payload, '$.text') = ?",
      params: [own.text, itemId, text],
      method: "run",
    });
  }
  if (cleared.size) {
    const { rows: kept } = await db.client.query({
      sql: "SELECT scope, key, response FROM idempotency_keys WHERE item_id = ?",
      params: [itemId],
      method: "all",
    });
    for (const [scope, key, response] of kept) {
      if (typeof response !== "string") continue;
      let again: string;
      try {
        again = JSON.stringify(replaceTexts(JSON.parse(response) as unknown, cleared));
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
  return entry.removed;
}

/** A stored answer with every string that is one of the texts replaced by its cleared copy; nothing else touched. */
function replaceTexts(value: unknown, cleared: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return cleared.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => replaceTexts(v, cleared));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceTexts(v, cleared)]));
  }
  return value;
}
