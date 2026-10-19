import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { ulid } from "../ids";

/**
 * What came attached to a customer's email (ADR-026 §7). Kept for the owner, within limits a small
 * inbox can carry; the rest is named on the conversation with why it was not kept, so the owner can
 * ask the customer for it another way. Nothing attached is ever sent on, shown to an agent, or opened
 * by the inbox.
 */

/** One file at most this large is kept. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** At most this much from one email, and at most this many files. */
export const EMAIL_ATTACHMENTS_MAX_BYTES = 15 * 1024 * 1024;
export const ATTACHMENTS_PER_EMAIL = 10;
/** All the attachments one inbox keeps; past this, new ones are named but not kept. */
export const INBOX_ATTACHMENTS_MAX_BYTES = 100 * 1024 * 1024;
/**
 * What one sender may leave in a day, and one sender's domain: a flood from addresses that change
 * fills nothing. A domain thousands of people write from (gmail.com, outlook.com) is counted by
 * sender only, or one customer's files would hold back the next one's.
 */
export const SENDER_ATTACHMENTS_PER_DAY = 20 * 1024 * 1024;
export const DOMAIN_ATTACHMENTS_PER_DAY = 20 * 1024 * 1024;
const SHARED_DOMAINS =
  /^(gmail\.com|googlemail\.com|outlook\.[a-z.]+|hotmail\.[a-z.]+|live\.[a-z.]+|msn\.com|icloud\.com|me\.com|mac\.com|yahoo\.[a-z.]+|ymail\.com|aol\.com|proton\.me|protonmail\.com|pm\.me|gmx\.[a-z.]+|web\.de|mail\.ru|yandex\.[a-z.]+|qq\.com|163\.com|126\.com|naver\.com|zoho\.com|fastmail\.com|sapo\.pt|libero\.it|orange\.fr|free\.fr|wanadoo\.fr|t-online\.de|seznam\.cz|wp\.pl|o2\.pl|interia\.pl|rediffmail\.com|uol\.com\.br|bol\.com\.br)$/;
/** Bytes per stored piece: well under any database's limit on one value (D1's is 2 MB). */
export const ATTACHMENT_CHUNK_BYTES = 256 * 1024;

/**
 * Files that run, or open as programs, when clicked: nobody needs one from a customer, and keeping
 * one would put it a click away from the owner. Named, never kept.
 */
const RUNS =
  /\.(exe|com|bat|cmd|scr|pif|msi|msp|msix|appx|appxbundle|msixbundle|jar|js|jse|vbs|vbe|wsf|wsh|wsc|ps1|psm1|psd1|msh|msh1|msh2|mshxml|hta|cpl|msc|lnk|url|reg|inf|scf|iso|img|vhd|vhdx|dmg|pkg|app|apk|sh|bash|command|docm|xlsm|pptm|dotm|xltm|xlam|ppam|xll|one|onepkg|chm|cab|appref-ms|settingcontent-ms|library-ms|gadget|application|xbap)$/i;

export type AttachmentState = "kept" | "too_large" | "refused" | "full" | "removed";

export interface AttachmentInput {
  readonly filename: string | null | undefined;
  readonly mimeType: string | null | undefined;
  /** The bytes, or base64 (as postal-mime gives them with `attachmentEncoding: "base64"`). */
  readonly content: ArrayBuffer | Uint8Array | string;
  /** Part of the HTML body (an inline logo, a signature's picture): not an attachment anyone sent. */
  readonly related?: boolean | undefined;
}

export interface AttachmentRef {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly state: AttachmentState;
}

function bytesOf(content: AttachmentInput["content"]): Uint8Array {
  if (typeof content === "string") {
    const bin = atob(content.replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

/**
 * A name that is only a name: in one Unicode form (NFKC, so a full-width `．ｅｘｅ` is `.exe`), no path,
 * no control or invisible characters (zero-width spaces, direction marks), no dots or spaces at its
 * end (Windows drops them, so `invoice.exe.` would be saved as `invoice.exe`), at most 200
 * characters. What is tested for a file that runs, and what is kept, is this name.
 */
export function safeFilename(name: string | null | undefined, contentType: string): string {
  const base = (name ?? "")
    .normalize("NFKC")
    .replace(/[\\/]+/g, "/")
    .split("/")
    .pop()
    ?.split("")
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      if (c < 0x20 || c === 0x7f || '"<>|*?:'.includes(ch)) return false;
      // Invisible: zero-width, direction marks and isolates, the byte-order mark, soft hyphen.
      return !(
        (c >= 0x200b && c <= 0x200f) ||
        (c >= 0x202a && c <= 0x202e) ||
        (c >= 0x2060 && c <= 0x2069) ||
        c === 0xfeff ||
        c === 0xad
      );
    })
    .join("")
    .trim()
    .replace(/[.\s]+$/, "")
    .slice(0, 200)
    .replace(/[.\s]+$/, "");
  if (base) return base;
  const ext =
    /^image\/(png|jpe?g|gif|webp|heic)$/.exec(contentType)?.[1] ?? (contentType === "application/pdf" ? "pdf" : "bin");
  return `attachment.${ext === "jpeg" ? "jpg" : ext}`;
}

/** A content type as stored: a plain `type/subtype`, else `application/octet-stream`. */
function cleanType(type: string | null | undefined): string {
  const t = (type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(t) ? t : "application/octet-stream";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function keptBytes(db: Db): Promise<number> {
  const { rows } = await db.client.query({
    sql: "SELECT COALESCE(SUM(size), 0) FROM mail_attachments WHERE state = 'kept'",
    params: [],
    method: "all",
  });
  return Number(rows[0]?.[0] ?? 0);
}

/**
 * Keeps an email's attachments on its item (and thread entry, when known), within the limits, and
 * says what became of each. One batch per file, so a large email never makes one huge write.
 */
export async function keepAttachments(
  db: Db,
  o: {
    readonly itemId: string;
    readonly entryId: string | null;
    readonly attachments: readonly AttachmentInput[];
    readonly now: number;
    /** The inbox's own limit, when its host keeps a smaller one. */
    readonly inboxMaxBytes?: number | undefined;
    /** Who sent them (their address): what one sender, and one sender's domain, may leave in a day. */
    readonly sender?: string | null | undefined;
  },
): Promise<AttachmentRef[]> {
  const out: AttachmentRef[] = [];
  const files = o.attachments.filter((a) => !a.related).slice(0, ATTACHMENTS_PER_EMAIL);
  let stored = await keptBytes(db);
  let thisEmail = 0;
  const cap = o.inboxMaxBytes ?? INBOX_ATTACHMENTS_MAX_BYTES;
  const who = o.sender ? o.sender.trim().toLowerCase() : "";
  const at = who.lastIndexOf("@");
  const senderKey = who ? (await sha256Hex(new TextEncoder().encode(`sdi-attach:${who}`))).slice(0, 32) : null;
  const senderDomain = at > 0 ? who.slice(at + 1) : null;
  const shared = senderDomain !== null && SHARED_DOMAINS.test(senderDomain);
  let bySender = senderKey ? await keptSince(db, "sender", senderKey, o.now) : 0;
  let byDomain = senderDomain && !shared ? await keptSince(db, "sender_domain", senderDomain, o.now) : 0;
  for (const file of files) {
    const contentType = cleanType(file.mimeType);
    const filename = safeFilename(file.filename, contentType);
    const bytes = bytesOf(file.content);
    const size = bytes.byteLength;
    const state: AttachmentState = RUNS.test(filename)
      ? "refused"
      : size > ATTACHMENT_MAX_BYTES || thisEmail + size > EMAIL_ATTACHMENTS_MAX_BYTES
        ? "too_large"
        : stored + size > cap ||
            bySender + size > SENDER_ATTACHMENTS_PER_DAY ||
            byDomain + size > DOMAIN_ATTACHMENTS_PER_DAY
          ? "full"
          : "kept";
    const id = ulid(o.now);
    const chunks = state === "kept" ? Math.max(1, Math.ceil(size / ATTACHMENT_CHUNK_BYTES)) : 0;
    const statements: Statement[] = [
      {
        sql: `INSERT INTO mail_attachments (id, item_id, entry_id, filename, content_type, size, sha256, state, chunks,
                sender, sender_domain, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          id,
          o.itemId,
          o.entryId,
          filename,
          contentType,
          size,
          state === "kept" ? await sha256Hex(bytes) : null,
          state,
          chunks,
          senderKey,
          senderDomain,
          o.now,
        ],
        method: "run",
      },
    ];
    for (let n = 0; n < chunks; n++) {
      statements.push({
        sql: "INSERT INTO mail_attachment_chunks (attachment_id, n, data) VALUES (?, ?, ?)",
        params: [id, n, bytes.slice(n * ATTACHMENT_CHUNK_BYTES, (n + 1) * ATTACHMENT_CHUNK_BYTES)],
        method: "run",
      });
    }
    await db.batch(statements);
    if (state === "kept") {
      stored += size;
      thisEmail += size;
      bySender += size;
      if (!shared) byDomain += size;
    }
    out.push({ id, filename, contentType, size, state });
  }
  if (o.entryId && out.length) {
    await db.client.query({
      sql: "UPDATE thread_entries SET attachments = ? WHERE id = ?",
      params: [JSON.stringify(out), o.entryId],
      method: "run",
    });
  }
  return out;
}

/** What was kept in the last day from one sender (`sender`) or one domain (`sender_domain`). */
async function keptSince(db: Db, column: "sender" | "sender_domain", value: string, now: number): Promise<number> {
  const { rows } = await db.client.query({
    sql: `SELECT COALESCE(SUM(size), 0) FROM mail_attachments WHERE ${column} = ? AND state = 'kept' AND created_at >= ?`,
    params: [value, now - 86_400_000],
    method: "all",
  });
  return Number(rows[0]?.[0] ?? 0);
}

/**
 * The owner deletes one kept file: its bytes go, and the conversation says it was removed. False when
 * there is no such file or it was not kept.
 */
export async function removeAttachment(db: Db, id: string): Promise<{ itemId: string } | null> {
  const { rows } = await db.client.query({
    sql: "SELECT item_id, entry_id, state FROM mail_attachments WHERE id = ?",
    params: [id],
    method: "all",
  });
  const r = rows[0];
  if (!r || String(r[2]) !== "kept") return null;
  const itemId = String(r[0]);
  const entryId = r[1] === null ? null : String(r[1]);
  await db.batch([
    { sql: "DELETE FROM mail_attachment_chunks WHERE attachment_id = ?", params: [id], method: "run" },
    { sql: "UPDATE mail_attachments SET state = 'removed', chunks = 0 WHERE id = ?", params: [id], method: "run" },
  ]);
  if (entryId) {
    const { rows: entry } = await db.client.query({
      sql: "SELECT attachments FROM thread_entries WHERE id = ?",
      params: [entryId],
      method: "all",
    });
    try {
      const list = JSON.parse(String(entry[0]?.[0] ?? "[]")) as AttachmentRef[];
      if (Array.isArray(list)) {
        const next = list.map((a) => (a.id === id ? { ...a, state: "removed" as const } : a));
        await db.client.query({
          sql: "UPDATE thread_entries SET attachments = ? WHERE id = ?",
          params: [JSON.stringify(next), entryId],
          method: "run",
        });
      }
    } catch {
      // The entry's list was not readable: the attachment's own row says it was removed.
    }
  }
  return { itemId };
}

/** An item's attachments, oldest first. */
export async function attachmentsOf(db: Db, itemId: string): Promise<(AttachmentRef & { entryId: string | null })[]> {
  const { rows } = await db.client.query({
    sql: `SELECT id, filename, content_type, size, state, entry_id FROM mail_attachments WHERE item_id = ?
           ORDER BY created_at, id`,
    params: [itemId],
    method: "all",
  });
  return rows.map((r) => ({
    id: String(r[0]),
    filename: String(r[1]),
    contentType: String(r[2]),
    size: Number(r[3]),
    state: String(r[4]) as AttachmentState,
    entryId: r[5] === null ? null : String(r[5]),
  }));
}

/** One kept attachment's bytes, or null. */
export async function readAttachment(
  db: Db,
  id: string,
): Promise<{ filename: string; contentType: string; itemId: string; bytes: Uint8Array } | null> {
  const { rows } = await db.client.query({
    sql: "SELECT filename, content_type, size, state, chunks, item_id FROM mail_attachments WHERE id = ?",
    params: [id],
    method: "all",
  });
  const r = rows[0];
  if (!r || String(r[3]) !== "kept") return null;
  const { rows: parts } = await db.client.query({
    sql: "SELECT data FROM mail_attachment_chunks WHERE attachment_id = ? ORDER BY n",
    params: [id],
    method: "all",
  });
  const size = Number(r[2]);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    const v = p[0];
    const chunk =
      v instanceof Uint8Array
        ? v
        : v instanceof ArrayBuffer
          ? new Uint8Array(v)
          : Array.isArray(v)
            ? Uint8Array.from(v as number[])
            : null;
    if (!chunk) return null;
    out.set(chunk.subarray(0, Math.max(0, size - at)), at);
    at += chunk.byteLength;
  }
  if (at < size) return null;
  return { filename: String(r[0]), contentType: String(r[1]), itemId: String(r[5]), bytes: out };
}
