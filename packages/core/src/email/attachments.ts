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
/** Bytes per stored piece: well under any database's limit on one value (D1's is 2 MB). */
export const ATTACHMENT_CHUNK_BYTES = 256 * 1024;

/**
 * Files that run, or open as programs, when clicked: nobody needs one from a customer, and keeping
 * one would put it a click away from the owner. Named, never kept.
 */
const RUNS =
  /\.(exe|com|bat|cmd|scr|pif|msi|msp|msix|appx|jar|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|hta|cpl|msc|lnk|reg|inf|scf|iso|img|vhd|vhdx|dmg|pkg|app|apk|sh|bash|command|docm|xlsm|pptm|dotm|xltm|xlam|ppam)$/i;

export type AttachmentState = "kept" | "too_large" | "refused" | "full";

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

/** A name that is only a name: no path, no control characters, at most 200 characters. */
export function safeFilename(name: string | null | undefined, contentType: string): string {
  const base = (name ?? "")
    .replace(/[\\/]+/g, "/")
    .split("/")
    .pop()
    ?.split("")
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f && !'"<>|*?:'.includes(ch))
    .join("")
    .trim()
    .slice(0, 200);
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
  },
): Promise<AttachmentRef[]> {
  const out: AttachmentRef[] = [];
  const files = o.attachments.filter((a) => !a.related).slice(0, ATTACHMENTS_PER_EMAIL);
  let stored = await keptBytes(db);
  let thisEmail = 0;
  const cap = o.inboxMaxBytes ?? INBOX_ATTACHMENTS_MAX_BYTES;
  for (const file of files) {
    const contentType = cleanType(file.mimeType);
    const filename = safeFilename(file.filename, contentType);
    const bytes = bytesOf(file.content);
    const size = bytes.byteLength;
    const state: AttachmentState = RUNS.test(filename)
      ? "refused"
      : size > ATTACHMENT_MAX_BYTES || thisEmail + size > EMAIL_ATTACHMENTS_MAX_BYTES
        ? "too_large"
        : stored + size > cap
          ? "full"
          : "kept";
    const id = ulid(o.now);
    const chunks = state === "kept" ? Math.max(1, Math.ceil(size / ATTACHMENT_CHUNK_BYTES)) : 0;
    const statements: Statement[] = [
      {
        sql: `INSERT INTO mail_attachments (id, item_id, entry_id, filename, content_type, size, sha256, state, chunks, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
