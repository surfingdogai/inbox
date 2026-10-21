import { sha256Hex } from "@surfingdog/platform";
import { ATTACHMENT_LIMITS, type AttachmentRef, type AttachmentType } from "@surfingdog/spec";
import { z } from "zod";
import type { Db } from "../db";
import { randomToken } from "../ids";
import { type FieldProblem, WriteError } from "../write/errors";
import { FileFetchError, fetchFile } from "./fetch";
import { cleanName, sniff } from "./sniff";
import { fileRow, filesBytes, isUnclaimed, putFile } from "./store";
import { StripError, stripMetadata } from "./strip";

export * from "./fetch";
export * from "./links";
export * from "./sniff";
export * from "./store";
export * from "./strip";

/**
 * Files on a request (ADR-034 §2). A customer's agent sends each file one of three ways:
 *
 * - `{upload_id}`: uploaded first (`POST /v1/uploads`, the bytes as the body), within the hour;
 * - `{data_base64, name?}`: inline, over MCP, up to 4 MB each and 8 MB in one call;
 * - `{url, name?}`: an https address on a public host, fetched by the inbox (`fetchFile`).
 *
 * Every file is told apart by its first bytes (JPEG, PNG, WebP or PDF; a HEIC photo is refused with
 * "send it as a JPEG"), has its metadata taken out (`stripMetadata`: where a photo was taken goes),
 * and is kept in the inbox's own database for the business alone. Words here are read by an agent
 * and relayed to its person: they never name the software.
 */

const UPLOAD_ID = /^upl_[A-Za-z0-9_-]{16,48}$/;
const ATTACHMENT_ID = /^att_[A-Za-z0-9_-]{16,48}$/;
/** The base64 of the largest inline file, with room for padding. */
const MAX_BASE64 = Math.ceil(ATTACHMENT_LIMITS.inlineBytes / 3) * 4 + 4;

export const fileInputSchema = z.union([
  z.object({
    upload_id: z.string().regex(UPLOAD_ID).describe("What POST /v1/uploads answered, within its hour."),
  }),
  z.object({
    data_base64: z
      .string()
      .min(4)
      .max(MAX_BASE64)
      .describe("The file's bytes in base64: JPEG, PNG, WebP or PDF, up to 4 MB (8 MB in one call)."),
    name: z.string().max(200).optional().describe("The file's name, for the business to recognise it."),
  }),
  z.object({
    url: z
      .url({ protocol: /^https$/ })
      .max(2048)
      .describe("An https address the file can be fetched from, up to 10 MB."),
    name: z.string().max(200).optional(),
  }),
]);
export type FileInput = z.infer<typeof fileInputSchema>;

/** A request's files: at most six. */
export const filesInputSchema = z
  .array(fileInputSchema)
  .max(ATTACHMENT_LIMITS.perRequest)
  .optional()
  .describe(
    "Photos or plans of the job: JPEG, PNG, WebP or PDF, at most six of 10 MB each. Inline up to 4 MB each (8 MB a call), else by https address or upload_id. HEIC photos: send them as JPEG.",
  );

export const FILE_WORDS = {
  heic: "That photo is HEIC. Send it as a JPEG: most phones can share a photo as JPEG.",
  type: "Files are taken as JPEG, PNG, WebP or PDF only.",
  tooLarge: `A file is at most ${ATTACHMENT_LIMITS.maxBytes / (1024 * 1024)} MB.`,
  inlineTooLarge: `A file sent inline is at most ${ATTACHMENT_LIMITS.inlineBytes / (1024 * 1024)} MB: send a larger one by its https address, or upload it first.`,
  inlineCall: `Files sent inline come to at most ${ATTACHMENT_LIMITS.inlinePerCall / (1024 * 1024)} MB in one call: send the others by address, or upload them first.`,
  tooMany: `At most ${ATTACHMENT_LIMITS.perRequest} files on a request.`,
  upload: "That upload_id is unknown, taken already, or older than an hour: upload the file again.",
  broken: "The file could not be read as what its first bytes say it is.",
  base64: "data_base64 is not base64.",
  quota: "The business has no room for more files just now: describe the job in words, or send fewer files.",
  noFiles: "The business does not take files here: describe the job in words.",
  empty: "The file is empty.",
} as const;

function decodeBase64(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) return null;
  try {
    const binary = atob(clean.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** How one door may take files: from where, and how much this inbox may still keep. */
export interface FileIntake {
  readonly db: Db;
  /** The host's outbound fetch for `{url}` files (`pinnedFetch` on Node). */
  readonly fetchImpl?: typeof fetch | undefined;
  /** What the inbox may keep in files at most, in bytes; null for no limit (a self-hosted inbox's own). */
  readonly quotaBytes: number | null;
  /** False where files cannot be kept or shown (no `INBOX_SECRET_KEY` to make the links): none are taken. */
  readonly enabled: boolean;
  readonly now: number;
}

/** The checked, cleaned file, before it is kept. */
interface Prepared {
  readonly name: string;
  readonly type: AttachmentType;
  readonly bytes: Uint8Array;
}

/**
 * One file's bytes in, checked and cleaned: the kind its first bytes show, within the size, its
 * metadata out. Throws the refusal for the field it was sent in.
 */
export function prepareFile(bytes: Uint8Array, name: string | undefined, index: number, path: string): Prepared {
  const problem = (message: string) =>
    new WriteError("invalid_input", message, { fields: [{ path, problem: "invalid", message }] });
  if (bytes.byteLength === 0) throw problem(FILE_WORDS.empty);
  if (bytes.byteLength > ATTACHMENT_LIMITS.maxBytes) throw problem(FILE_WORDS.tooLarge);
  const kind = sniff(bytes);
  if (kind === "heic") throw problem(FILE_WORDS.heic);
  if (kind === "unknown") throw problem(FILE_WORDS.type);
  let clean: Uint8Array;
  try {
    clean = stripMetadata(kind, bytes).bytes;
  } catch (error) {
    if (error instanceof StripError) throw problem(FILE_WORDS.broken);
    throw error;
  }
  return { name: cleanName(name, kind, index), type: kind, bytes: clean };
}

/** Keeps a prepared file, under the quota. */
async function keep(intake: FileIntake, prepared: Prepared, path: string): Promise<AttachmentRef> {
  if (intake.quotaBytes !== null) {
    // Every file kept counts, those a request has not taken yet too.
    const used = await filesBytes(intake.db);
    if (used + prepared.bytes.byteLength > intake.quotaBytes) {
      throw new WriteError("not_allowed", FILE_WORDS.quota, {
        fields: [{ path, problem: "invalid", message: FILE_WORDS.quota }],
        details: { reason: "files_quota" },
      });
    }
  }
  return putFile(
    intake.db,
    {
      id: `att_${randomToken(18)}`,
      name: prepared.name,
      contentType: prepared.type,
      bytes: prepared.bytes,
      sha256: await sha256Hex(prepared.bytes),
    },
    intake.now,
  );
}

/** `POST /v1/uploads`: one file as the body, kept for an hour for a request to name. */
export async function uploadFile(
  intake: FileIntake,
  bytes: Uint8Array,
  name: string | undefined,
): Promise<{ upload_id: string; attachment: AttachmentRef; expires_at: string }> {
  if (!intake.enabled) throw new WriteError("not_allowed", FILE_WORDS.noFiles);
  const prepared = prepareFile(bytes, name, 0, "body");
  const ref = await keep(intake, prepared, "body");
  return {
    upload_id: `upl_${ref.id.slice(4)}`,
    attachment: ref,
    expires_at: new Date(intake.now + ATTACHMENT_LIMITS.uploadTtlMs).toISOString(),
  };
}

/**
 * A request's files, each checked, cleaned and kept, unattached: the item's batch then takes them
 * (`attachStatements`). Refuses the whole request on the first file that is not taken, naming its
 * field (`attachments.2`), so the agent fixes it and sends the request again.
 */
export async function takeFiles(
  intake: FileIntake,
  files: readonly FileInput[] | undefined,
  field = "attachments",
): Promise<AttachmentRef[]> {
  if (!files || files.length === 0) return [];
  if (!intake.enabled) {
    throw new WriteError("not_allowed", FILE_WORDS.noFiles, {
      fields: [{ path: field, problem: "invalid", message: FILE_WORDS.noFiles }],
    });
  }
  if (files.length > ATTACHMENT_LIMITS.perRequest) {
    throw new WriteError("invalid_input", FILE_WORDS.tooMany, {
      fields: [{ path: field, problem: "invalid", message: FILE_WORDS.tooMany }],
    });
  }
  const out: AttachmentRef[] = [];
  const seen = new Set<string>();
  let inline = 0;
  for (const [i, file] of files.entries()) {
    const path = `${field}.${i}`;
    const fail = (message: string): never => {
      const fields: FieldProblem[] = [{ path, problem: "invalid", message }];
      throw new WriteError("invalid_input", message, { fields });
    };
    if ("upload_id" in file) {
      const id = `att_${file.upload_id.slice(4)}`;
      if (!ATTACHMENT_ID.test(id) || seen.has(id) || !(await isUnclaimed(intake.db, id, intake.now)))
        fail(FILE_WORDS.upload);
      const row = await fileRow(intake.db, id);
      if (!row) fail(FILE_WORDS.upload);
      seen.add(id);
      if (row) out.push(row.ref);
      continue;
    }
    let bytes: Uint8Array;
    if ("data_base64" in file) {
      const decoded = decodeBase64(file.data_base64);
      if (!decoded) fail(FILE_WORDS.base64);
      bytes = decoded as Uint8Array;
      if (bytes.byteLength > ATTACHMENT_LIMITS.inlineBytes) fail(FILE_WORDS.inlineTooLarge);
      inline += bytes.byteLength;
      if (inline > ATTACHMENT_LIMITS.inlinePerCall) fail(FILE_WORDS.inlineCall);
    } else {
      try {
        bytes = await fetchFile(file.url, { fetchImpl: intake.fetchImpl, maxBytes: ATTACHMENT_LIMITS.maxBytes });
      } catch (error) {
        if (error instanceof FileFetchError) {
          fail(error.reason === "too_large" ? FILE_WORDS.tooLarge : error.message);
        }
        throw error;
      }
    }
    const prepared = prepareFile(bytes, file.name, i, path);
    out.push(await keep(intake, prepared, path));
  }
  return out;
}
