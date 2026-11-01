import type { Statement } from "@surfingdog/platform";
import { sha256Hex } from "@surfingdog/platform";
import { sniff } from "../attachments/sniff";
import { CHUNK_BYTES, readChunks } from "../attachments/store";
import { StripError, stripMetadata } from "../attachments/strip";
import type { Db } from "../db";
import { randomToken } from "../ids";
import { WriteError } from "../write/errors";
import { imageSize, type PictureType } from "./size";

/**
 * The business's logo, kept in the inbox's own database as a request's files are (`attachments/store.ts`):
 * one `blobs` row of `kind = 'logo'` and its bytes in `attachment_chunks`, so it is there on every
 * runtime with nothing to set up. It never runs out and belongs to no request or customer; the
 * settings name it (`look.logo`), and only one is kept.
 *
 * What is taken is checked from its first bytes, never from its name or the type it was sent as:
 * a PNG, JPEG or WebP picture (an SVG can carry a script, so it is never one), within a size, with
 * its metadata taken out.
 */

/** One piece: a logo is small. */
export const LOGO_MAX_BYTES = CHUNK_BYTES;
export const LOGO_MIN_PX = 16;
export const LOGO_MAX_PX = 2048;

export const LOGO_WORDS = {
  empty: "The picture is empty.",
  tooLarge: `A logo is at most ${LOGO_MAX_BYTES / 1024} KB.`,
  heic: "That picture is HEIC: send it as PNG or JPEG.",
  type: "A logo is a PNG, JPEG or WebP picture.",
  unreadable: "This picture can't be read.",
  size: `Between ${LOGO_MIN_PX} and ${LOGO_MAX_PX} pixels a side.`,
  damaged: "This picture is damaged.",
} as const;

/** A logo checked and cleaned, about to be kept. */
export interface CleanLogo {
  readonly type: PictureType;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

const EXTENSION: Readonly<Record<PictureType, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

function refused(message: string, reason?: string): WriteError {
  return new WriteError("invalid_input", message, {
    fields: [{ path: "body", problem: "invalid", message }],
    ...(reason ? { details: { reason } } : {}),
  });
}

/** Whether a refusal was for the size of the file (`too_large`): the doors answer 413 then. */
export function isTooLarge(error: unknown): boolean {
  return error instanceof WriteError && error.details?.reason === "too_large";
}

/** The picture's bytes in, checked and cleaned; throws the refusal that says what to send instead. */
export async function prepareLogo(bytes: Uint8Array): Promise<CleanLogo> {
  if (bytes.byteLength === 0) throw refused(LOGO_WORDS.empty);
  if (bytes.byteLength > LOGO_MAX_BYTES) throw refused(LOGO_WORDS.tooLarge, "too_large");
  const kind = sniff(bytes);
  if (kind === "heic") throw refused(LOGO_WORDS.heic);
  if (kind !== "image/png" && kind !== "image/jpeg" && kind !== "image/webp") throw refused(LOGO_WORDS.type);
  const size = imageSize(kind, bytes);
  if (!size) throw refused(LOGO_WORDS.unreadable);
  const fits = (n: number) => n >= LOGO_MIN_PX && n <= LOGO_MAX_PX;
  if (!fits(size.width) || !fits(size.height)) throw refused(LOGO_WORDS.size);
  let clean: Uint8Array;
  try {
    clean = stripMetadata(kind, bytes).bytes;
  } catch (error) {
    if (error instanceof StripError) throw refused(LOGO_WORDS.damaged);
    throw error;
  }
  return { type: kind, bytes: clean, sha256: await sha256Hex(clean), width: size.width, height: size.height };
}

/** Keeps a logo's bytes, then its row: no row, no logo. Answers its id. */
export async function putLogo(db: Db, logo: CleanLogo, now: number): Promise<string> {
  const id = `logo_${randomToken(18)}`;
  await db.batch([
    {
      sql: "INSERT OR REPLACE INTO attachment_chunks (key, seq, data, created_at) VALUES (?, 0, ?, ?)",
      params: [id, logo.bytes, now],
      method: "run",
    },
  ]);
  await db.batch([
    {
      sql: `INSERT INTO blobs (key, size, content_type, sha256, kind, item_id, party_id, name, expires_at, sent_by, created_at)
            VALUES (?, ?, ?, ?, 'logo', NULL, NULL, ?, NULL, NULL, ?)`,
      params: [id, logo.bytes.byteLength, logo.type, logo.sha256, `logo${EXTENSION[logo.type]}`, now],
      method: "run",
    },
  ]);
  return id;
}

/** A logo's bytes; null when it is gone, or a piece of it is. */
export async function readLogo(db: Db, id: string): Promise<Uint8Array | null> {
  const { rows } = await db.client.query({
    sql: "SELECT size FROM blobs WHERE key = ? AND kind = 'logo' AND deleted_at IS NULL",
    params: [id],
    method: "all",
  });
  const row = rows[0];
  return row ? readChunks(db, id, Number(row[0])) : null;
}

function dropStatements(where: string, params: readonly (string | number)[]): Statement[] {
  return [
    {
      sql: `DELETE FROM attachment_chunks WHERE key IN (SELECT key FROM blobs WHERE kind = 'logo' AND ${where})`,
      params,
      method: "run",
    },
    { sql: `DELETE FROM blobs WHERE kind = 'logo' AND ${where}`, params, method: "run" },
  ];
}

/** Removes one logo, rows and bytes: one whose settings write did not go through. */
export async function dropLogo(db: Db, id: string): Promise<void> {
  await db.batch(dropStatements("key = ?", [id]));
}

/**
 * Removes every logo kept up to `upTo` but `keep`: the one replaced, and any a write that stopped
 * half way left behind. One kept later is another upload's, still on its way, and is left to it.
 */
export async function dropLogos(db: Db, upTo: number, keep?: string): Promise<void> {
  await db.batch(
    keep === undefined
      ? dropStatements("created_at <= ?", [upTo])
      : dropStatements("key <> ? AND created_at <= ?", [keep, upTo]),
  );
}
