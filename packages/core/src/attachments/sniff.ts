import type { AttachmentType } from "@surfingdog/spec";

/**
 * What a file is, from its first bytes (ADR-039 §2): never from the type or the name a sender gave.
 * Only four kinds are taken; HEIC and AVIF (what phones often send) are named so the refusal can say
 * what to send instead, and everything else is `unknown`.
 */
export type Sniffed = AttachmentType | "heic" | "unknown";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** ISO base media brands of HEIF images (HEIC, and AVIF which shares the container). */
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "avif", "avis"]);

/** Bytes a PDF's header may come after. */
const PDF_LEAD = 16;

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let s = "";
  for (let i = at; i < at + length && i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
  return s;
}

export function sniff(bytes: Uint8Array): Sniffed {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  // A PDF starts with its header, after at most a few bytes (a byte-order mark, a stray newline), and
  // ends with %%EOF in its last kilobyte. Nothing longer may come first: a page of HTML with a PDF
  // header further in would be a file that is both.
  if (bytes.length >= 10) {
    const at = ascii(bytes, 0, PDF_LEAD + 5).indexOf("%PDF-");
    const tail = ascii(bytes, Math.max(0, bytes.length - 1024), 1024);
    if (at >= 0 && at <= PDF_LEAD && tail.includes("%%EOF")) return "application/pdf";
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const major = ascii(bytes, 8, 4);
    if (HEIF_BRANDS.has(major)) return "heic";
    // The compatible brands follow the minor version, four bytes each, to the end of the box.
    const boxSize =
      (((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>> 0;
    const end = Math.min(boxSize, bytes.length, 256);
    for (let at = 16; at + 4 <= end; at += 4) if (HEIF_BRANDS.has(ascii(bytes, at, 4))) return "heic";
  }
  return "unknown";
}

/** The extension a kind of file is saved with. */
export const EXTENSION: Readonly<Record<AttachmentType, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

/**
 * A file's name as it is kept and shown: the name it came with, without a path, control characters or
 * quotes, at most 120 characters, with the extension of what it really is.
 */
export function cleanName(name: string | undefined, type: AttachmentType, index: number): string {
  const base = (name ?? "")
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\p{Cc}\p{Cf}"'<>`]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .slice(0, 120);
  const stem = base && base !== "." && base !== ".." ? base : `file-${index + 1}`;
  return `${stem}${EXTENSION[type]}`;
}
