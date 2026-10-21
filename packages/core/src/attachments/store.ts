import type { SqlInput, Statement } from "@surfingdog/platform";
import { ATTACHMENT_LIMITS, type AttachmentRef, type AttachmentType } from "@surfingdog/spec";
import type { Db } from "../db";
import type { JobHandler } from "../jobs/runner";
import { ensureJob } from "../jobs/schedule";

/**
 * Where a request's files are kept (ADR-034 §2): in the inbox's own database, in pieces of 512 KB,
 * so the same code keeps them on every runtime (D1, a Durable Object, a SQLite file) with no store of
 * its own to set up, and a database copy or an erasure takes them with everything else. `blobs` holds
 * one row per file (`kind = 'attachment'`), `attachment_chunks` its bytes.
 *
 * A file arrives before the request that names it: it is kept for an hour (`expires_at`), and a
 * request takes it by clearing that and naming its item. What no request took by then, and what an
 * erasure marked deleted, is removed by the sweep with its bytes.
 */

/** 512 KB a piece: under every runtime's largest value (D1 takes 2 MB a row). */
export const CHUNK_BYTES = 512 * 1024;
/** Pieces written in one batch: a 10 MB file goes in five batches. */
const CHUNKS_PER_BATCH = 4;

export const ATTACHMENT_SWEEP_KIND = "attachment_sweep";
const SWEEP_EVERY_MS = 30 * 60_000;

export interface StoredFile {
  readonly ref: AttachmentRef;
  readonly itemId: string | null;
  readonly partyId: string | null;
  readonly expiresAt: number | null;
  readonly createdAt: number;
}

/** A file, cleaned, about to be kept. */
export interface CleanFile {
  readonly id: string;
  readonly name: string;
  readonly contentType: AttachmentType;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/** Keeps a file's bytes and its row, unattached, for an hour. The row is written last: no row, no file. */
export async function putFile(db: Db, file: CleanFile, now: number): Promise<AttachmentRef> {
  const { id, bytes } = file;
  const count = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
  const pieces: Statement[] = [];
  for (let seq = 0; seq < count; seq++) {
    pieces.push({
      sql: "INSERT OR REPLACE INTO attachment_chunks (key, seq, data, created_at) VALUES (?, ?, ?, ?)",
      params: [id, seq, bytes.subarray(seq * CHUNK_BYTES, Math.min(bytes.byteLength, (seq + 1) * CHUNK_BYTES)), now],
      method: "run",
    });
  }
  for (let i = 0; i < pieces.length; i += CHUNKS_PER_BATCH) await db.batch(pieces.slice(i, i + CHUNKS_PER_BATCH));
  await db.batch([
    {
      sql: `INSERT INTO blobs (key, size, content_type, sha256, kind, item_id, party_id, name, expires_at, created_at)
            VALUES (?, ?, ?, ?, 'attachment', NULL, NULL, ?, ?, ?)`,
      params: [
        id,
        bytes.byteLength,
        file.contentType,
        file.sha256,
        file.name,
        now + ATTACHMENT_LIMITS.uploadTtlMs,
        now,
      ],
      method: "run",
    },
  ]);
  await ensureSweep(db, now);
  return { id, name: file.name, content_type: file.contentType, size: bytes.byteLength, sha256: file.sha256 };
}

/** The sweep, once per half hour, while files are kept at all. */
export async function ensureSweep(db: Db, now: number): Promise<void> {
  const slot = Math.floor(now / SWEEP_EVERY_MS);
  await ensureJob(db, ATTACHMENT_SWEEP_KIND, `attachment_sweep:${slot}`, {
    now,
    runAt: (slot + 1) * SWEEP_EVERY_MS + 60_000,
  });
}

function fileOf(r: readonly unknown[]): StoredFile {
  return {
    ref: {
      id: String(r[0]),
      size: Number(r[1]),
      content_type: String(r[2]) as AttachmentType,
      sha256: String(r[3] ?? ""),
      name: String(r[4] ?? r[0]),
    },
    itemId: r[5] === null || r[5] === undefined ? null : String(r[5]),
    partyId: r[6] === null || r[6] === undefined ? null : String(r[6]),
    expiresAt: r[7] === null || r[7] === undefined ? null : Number(r[7]),
    createdAt: Number(r[8]),
  };
}

const COLUMNS = "key, size, content_type, sha256, name, item_id, party_id, expires_at, created_at";

/** A file still kept: never one an erasure or the sweep took. */
export async function fileRow(db: Db, id: string): Promise<StoredFile | null> {
  const { rows } = await db.client.query({
    sql: `SELECT ${COLUMNS} FROM blobs WHERE key = ? AND kind = 'attachment' AND deleted_at IS NULL`,
    params: [id],
    method: "all",
  });
  return rows[0] ? fileOf(rows[0]) : null;
}

/** An item's files, in the order they came. */
export async function itemFiles(db: Db, itemId: string): Promise<StoredFile[]> {
  const { rows } = await db.client.query({
    sql: `SELECT ${COLUMNS} FROM blobs WHERE item_id = ? AND kind = 'attachment' AND deleted_at IS NULL ORDER BY created_at, key`,
    params: [itemId],
    method: "all",
  });
  return rows.map(fileOf);
}

/**
 * Hands files to an item, in the batch that writes the item: only files nobody took yet and still
 * within their hour. Answers the statements; the caller checks afterwards that each was taken.
 */
export function attachStatements(
  ids: readonly string[],
  itemId: string,
  partyId: string | null,
  now: number,
): Statement[] {
  return ids.map((id) => ({
    sql: `UPDATE blobs SET item_id = ?, party_id = ?, expires_at = NULL
           WHERE key = ? AND kind = 'attachment' AND item_id IS NULL AND deleted_at IS NULL AND expires_at > ?`,
    params: [itemId, partyId, id, now],
    method: "run" as const,
  }));
}

/** Whether a file can still be named by a request: kept, nobody's yet, within its hour. */
export async function isUnclaimed(db: Db, id: string, now: number): Promise<boolean> {
  const f = await fileRow(db, id);
  return f !== null && f.itemId === null && f.expiresAt !== null && f.expiresAt > now;
}

/** A file's bytes, whole; null when it is gone or a piece is missing. */
export async function readFile(db: Db, id: string): Promise<{ file: StoredFile; bytes: Uint8Array } | null> {
  const file = await fileRow(db, id);
  if (!file) return null;
  const { rows } = await db.client.query({
    sql: "SELECT seq, data FROM attachment_chunks WHERE key = ? ORDER BY seq",
    params: [id],
    method: "all",
  });
  const count = Math.max(1, Math.ceil(file.ref.size / CHUNK_BYTES));
  if (rows.length !== count) return null;
  const out = new Uint8Array(file.ref.size);
  let at = 0;
  for (const [i, r] of rows.entries()) {
    if (Number(r[0]) !== i) return null;
    const piece = toBytes(r[1]);
    if (!piece || at + piece.byteLength > out.byteLength) return null;
    out.set(piece, at);
    at += piece.byteLength;
  }
  return at === out.byteLength ? { file, bytes: out } : null;
}

/** A BLOB as each runtime hands it back: bytes, an ArrayBuffer, or numbers. */
function toBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return null;
}

/** Bytes the inbox's files take now, to hold a quota to. */
export async function filesBytes(db: Db): Promise<number> {
  const { rows } = await db.client.query({
    sql: "SELECT COALESCE(SUM(size), 0) FROM blobs WHERE kind = 'attachment' AND deleted_at IS NULL",
    params: [],
    method: "all",
  });
  return Number(rows[0]?.[0] ?? 0);
}

/**
 * Removes what nobody took within the hour, and the bytes of every file marked deleted (an erasure):
 * the rows of deleted files stay, as the erasure left them, without their bytes.
 */
export async function sweepFiles(db: Db, now: number): Promise<{ expired: number; erased: number }> {
  const expired = await db.client.query({
    sql: `UPDATE blobs SET deleted_at = ? WHERE kind = 'attachment' AND item_id IS NULL AND deleted_at IS NULL
           AND expires_at IS NOT NULL AND expires_at <= ?`,
    params: [now, now],
    method: "run",
  });
  const erased = await db.client.query({
    sql: `DELETE FROM attachment_chunks WHERE key IN (SELECT key FROM blobs WHERE kind = 'attachment' AND deleted_at IS NOT NULL)`,
    params: [],
    method: "run",
  });
  // Pieces no row names (a write that stopped before its row), older than the hour a file waits: a
  // file being written now has no row yet either.
  await db.client.query({
    sql: "DELETE FROM attachment_chunks WHERE created_at <= ? AND key NOT IN (SELECT key FROM blobs)",
    params: [now - ATTACHMENT_LIMITS.uploadTtlMs],
    method: "run",
  });
  return { expired: expired.changes, erased: erased.changes };
}

/**
 * The bytes of an erased customer's files, in the erasure's own batch (`eraseStatements`): the rows are
 * marked deleted there; this takes the pieces too, so nothing they sent is left to read.
 */
export function eraseFilesStatements(where: string, params: readonly SqlInput[]): Statement[] {
  return [
    {
      sql: `DELETE FROM attachment_chunks WHERE key IN (SELECT key FROM blobs WHERE kind = 'attachment' AND (${where}))`,
      params,
      method: "run",
    },
  ];
}

/** The sweep's job: it queues the next while any file waits. */
export function attachmentSweepHandler(): JobHandler {
  return async (_job, { db, now }) => {
    const r = await sweepFiles(db, now);
    const { rows } = await db.client.query({
      sql: "SELECT 1 FROM blobs WHERE kind = 'attachment' AND item_id IS NULL AND deleted_at IS NULL LIMIT 1",
      params: [],
      method: "all",
    });
    if (rows.length > 0) await ensureSweep(db, now);
    return { note: `${r.expired} unclaimed removed, ${r.erased} erased pieces removed` };
  };
}
