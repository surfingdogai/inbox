import type { AttachmentType } from "@surfingdog/spec";

/**
 * Image metadata out (ADR-039 §2), in pure TypeScript: a photo of a leak carries where and when it was
 * taken, the phone, and often a thumbnail of what it showed before it was cropped. All of it goes; only
 * which way up the picture is (the EXIF orientation) is kept, written again as a record of one tag.
 *
 * - **JPEG**: every APP1 (EXIF and XMP, the extended XMP too), APP13 (IPTC), the MPF index (APP2 `MPF`)
 *   whose other images were appended after the end, and comments go; ICC colour profiles and the
 *   JFIF and Adobe markers stay. Anything after the image's end (a phone's trailer, appended images) is
 *   cut off.
 * - **PNG**: `eXIf`, `tEXt`, `zTXt`, `iTXt` and `tIME` go; the image and its colour chunks stay.
 * - **WebP**: the `EXIF` and `XMP ` chunks go, and the extended header's flags say so.
 * - **PDF**: kept as sent. A PDF is a document, shown only as a download, never inline.
 *
 * A file that is not what its first bytes promised (cut short, a length that runs past its end) is
 * refused: `StripError`.
 */

export class StripError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripError";
  }
}

export interface Stripped {
  readonly bytes: Uint8Array;
  /** The EXIF orientation kept (2–8), when the picture is not the right way up as stored. */
  readonly orientation: number | null;
  /** How many metadata blocks were taken out. */
  readonly removed: number;
}

export function stripMetadata(type: AttachmentType, bytes: Uint8Array): Stripped {
  switch (type) {
    case "image/jpeg":
      return stripJpeg(bytes);
    case "image/png":
      return stripPng(bytes);
    case "image/webp":
      return stripWebp(bytes);
    case "application/pdf":
      return { bytes, orientation: null, removed: 0 };
  }
}

/* --- shared ------------------------------------------------------------------ */

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u32be = (b: Uint8Array, at: number) =>
  (((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)) >>> 0;
const u32le = (b: Uint8Array, at: number) =>
  ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16) | ((b[at + 3] ?? 0) << 24)) >>> 0;

/**
 * The orientation in a TIFF structure (the body of an EXIF block, after `Exif\0\0`): IFD0's tag 0x0112.
 * Null when there is none, or it is 1 (as stored), or the structure cannot be read.
 */
export function tiffOrientation(tiff: Uint8Array): number | null {
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return null;
  const r16 = little ? u16le : u16be;
  const r32 = little ? u32le : u32be;
  if (r16(tiff, 2) !== 42) return null;
  const ifd = r32(tiff, 4);
  if (ifd + 2 > tiff.length) return null;
  const count = r16(tiff, ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return null;
    if (r16(tiff, entry) !== 0x0112) continue;
    const type = r16(tiff, entry + 2);
    if (type !== 3) return null;
    const value = r16(tiff, entry + 8);
    return value >= 2 && value <= 8 ? value : null;
  }
  return null;
}

/** A TIFF structure that says only which way up the picture is: big-endian, one entry, no other IFD. */
export function orientationTiff(orientation: number): Uint8Array {
  return new Uint8Array([
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08,
    // IFD0: one entry.
    0x00,
    0x01,
    // Orientation (0x0112), SHORT (3), count 1, the value in the first two bytes of the four.
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation & 0xff,
    0x00,
    0x00,
    // No next IFD.
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
}

const EXIF_HEADER = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);

/* --- JPEG -------------------------------------------------------------------- */

function stripJpeg(src: Uint8Array): Stripped {
  if (src.length < 4 || src[0] !== 0xff || src[1] !== 0xd8) throw new StripError("not a JPEG");
  const keep: Uint8Array[] = [src.subarray(0, 2)];
  let orientation: number | null = null;
  let removed = 0;
  let at = 2;
  let insertAt = 1; // after SOI, or after JFIF/EXIF-position APP0 when there is one
  let ended = false;
  while (at < src.length) {
    if (src[at] !== 0xff) throw new StripError("a JPEG marker was expected");
    // Fill bytes before a marker.
    while (at < src.length && src[at] === 0xff && src[at + 1] === 0xff) at++;
    const marker = src[at + 1];
    if (marker === undefined) throw new StripError("a JPEG cut short");
    if (marker === 0xd9) {
      keep.push(src.subarray(at, at + 2));
      ended = true;
      break;
    }
    // Markers with no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      keep.push(src.subarray(at, at + 2));
      at += 2;
      continue;
    }
    if (at + 4 > src.length) throw new StripError("a JPEG cut short");
    const length = u16be(src, at + 2);
    if (length < 2) throw new StripError("a JPEG segment with no length");
    const end = at + 2 + length;
    if (end > src.length) throw new StripError("a JPEG segment runs past the file");
    const body = src.subarray(at + 4, end);
    const drop =
      marker === 0xe1 || marker === 0xed || marker === 0xfe || (marker === 0xe2 && startsWith(body, 0, "MPF\0"));
    if (drop) {
      if (marker === 0xe1 && startsWith(body, 0, "Exif\0\0") && orientation === null) {
        orientation = tiffOrientation(body.subarray(6));
      }
      removed++;
      at = end;
      continue;
    }
    keep.push(src.subarray(at, end));
    if (marker === 0xe0) insertAt = keep.length;
    at = end;
    if (marker === 0xda) {
      // Entropy-coded data until the next marker that is not a stuffed byte or a restart marker.
      let scan = at;
      while (scan < src.length) {
        if (src[scan] === 0xff) {
          const next = src[scan + 1];
          if (next === undefined) throw new StripError("a JPEG cut short");
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
            scan += next === 0xff ? 1 : 2;
            continue;
          }
          break;
        }
        scan++;
      }
      keep.push(src.subarray(at, scan));
      at = scan;
    }
  }
  if (!ended) throw new StripError("a JPEG with no end");
  if (orientation !== null) {
    const tiff = orientationTiff(orientation);
    const length = 2 + EXIF_HEADER.length + tiff.length;
    const app1 = concat([new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff]), EXIF_HEADER, tiff]);
    keep.splice(insertAt, 0, app1);
  }
  return { bytes: concat(keep), orientation, removed };
}

/* --- PNG --------------------------------------------------------------------- */

const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

let CRC_TABLE: Uint32Array | null = null;
function crc32(parts: readonly Uint8Array[]): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const p of parts) for (const b of p) crc = (CRC_TABLE[(crc ^ b) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function be32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function stripPng(src: Uint8Array): Stripped {
  if (src.length < 8) throw new StripError("not a PNG");
  const keep: Uint8Array[] = [src.subarray(0, 8)];
  let orientation: number | null = null;
  let removed = 0;
  let at = 8;
  let sawEnd = false;
  let afterHeader = 1;
  while (at + 12 <= src.length) {
    const length = u32be(src, at);
    const end = at + 12 + length;
    if (end > src.length) throw new StripError("a PNG chunk runs past the file");
    const type = String.fromCharCode(src[at + 4] ?? 0, src[at + 5] ?? 0, src[at + 6] ?? 0, src[at + 7] ?? 0);
    if (PNG_DROP.has(type)) {
      if (type === "eXIf" && orientation === null) {
        let tiff = src.subarray(at + 8, at + 8 + length);
        if (startsWith(tiff, 0, "Exif\0\0")) tiff = tiff.subarray(6);
        orientation = tiffOrientation(tiff);
      }
      removed++;
    } else {
      keep.push(src.subarray(at, end));
      if (type === "IHDR") afterHeader = keep.length;
    }
    at = end;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) throw new StripError("a PNG with no end");
  if (orientation !== null) {
    const tiff = orientationTiff(orientation);
    const type = new Uint8Array([0x65, 0x58, 0x49, 0x66]);
    keep.splice(afterHeader, 0, concat([be32(tiff.length), type, tiff, be32(crc32([type, tiff]))]));
  }
  return { bytes: concat(keep), orientation, removed };
}

/* --- WebP -------------------------------------------------------------------- */

function le32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

function stripWebp(src: Uint8Array): Stripped {
  if (src.length < 12 || !startsWith(src, 0, "RIFF") || !startsWith(src, 8, "WEBP")) throw new StripError("not a WebP");
  const riffEnd = Math.min(src.length, 8 + u32le(src, 4));
  const chunks: Uint8Array[] = [];
  let orientation: number | null = null;
  let removed = 0;
  let vp8x: number | null = null;
  let at = 12;
  while (at + 8 <= riffEnd) {
    const fourcc = String.fromCharCode(src[at] ?? 0, src[at + 1] ?? 0, src[at + 2] ?? 0, src[at + 3] ?? 0);
    const size = u32le(src, at + 4);
    const end = at + 8 + size + (size & 1);
    if (at + 8 + size > riffEnd) throw new StripError("a WebP chunk runs past the file");
    if (fourcc === "EXIF" || fourcc === "XMP ") {
      if (fourcc === "EXIF" && orientation === null) {
        let tiff = src.subarray(at + 8, at + 8 + size);
        if (startsWith(tiff, 0, "Exif\0\0")) tiff = tiff.subarray(6);
        orientation = tiffOrientation(tiff);
      }
      removed++;
    } else {
      // A copy, so the extended header's flags can be written without touching what was sent.
      const chunk = src.slice(at, Math.min(end, riffEnd));
      if (fourcc === "VP8X") vp8x = chunks.length;
      chunks.push(chunk);
    }
    at = end;
  }
  if (vp8x !== null) {
    const header = chunks[vp8x];
    if (header && header.length > 8) {
      // Flags: bit 3 EXIF, bit 2 XMP. XMP is gone; EXIF only if the orientation is written again.
      let flags = (header[8] ?? 0) & ~0x0c;
      if (orientation !== null) flags |= 0x08;
      header[8] = flags;
    }
  }
  // The orientation goes back only where the format has a place for it (the extended header); a
  // simple WebP has no EXIF, and the picture is shown as stored.
  if (orientation !== null && vp8x !== null) {
    const tiff = orientationTiff(orientation);
    const body = concat([EXIF_HEADER, tiff]);
    const pad = body.length & 1 ? new Uint8Array([0]) : new Uint8Array(0);
    chunks.push(concat([new Uint8Array([0x45, 0x58, 0x49, 0x46]), le32(body.length), body, pad]));
  } else if (orientation !== null) {
    orientation = null;
  }
  const payload = concat(chunks);
  const out = concat([
    new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    le32(4 + payload.length),
    src.subarray(8, 12),
    payload,
  ]);
  return { bytes: out, orientation, removed };
}
