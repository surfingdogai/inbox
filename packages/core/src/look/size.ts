/**
 * A picture's size in pixels, read from its header alone: the logo is shown at its own proportions
 * and refused when it is too small or too large, with nothing decoded.
 *
 * - **PNG**: the IHDR chunk, which comes first.
 * - **JPEG**: the first start-of-frame marker (SOF0–SOF15, but C4, C8 and CC, which are not frames).
 * - **WebP**: the first chunk, `VP8 ` (lossy), `VP8L` (lossless) or `VP8X` (extended).
 *
 * Null when the header cannot be read: cut short, or not what its first bytes promised.
 */

export type PictureType = "image/png" | "image/jpeg" | "image/webp";

const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, at: number) =>
  (((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)) >>> 0;

function ascii(b: Uint8Array, at: number, length: number): string {
  let s = "";
  for (let i = at; i < at + length && i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return s;
}

export interface PictureSize {
  readonly width: number;
  readonly height: number;
}

export function imageSize(type: PictureType, bytes: Uint8Array): PictureSize | null {
  const size = type === "image/png" ? pngSize(bytes) : type === "image/jpeg" ? jpegSize(bytes) : webpSize(bytes);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

function pngSize(b: Uint8Array): PictureSize | null {
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegSize(b: Uint8Array): PictureSize | null {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1] ?? 0;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Markers with no length: TEM and the restart markers.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // The end of the image, or its data, before any frame: no size to read.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(b, at + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > b.length) return null;
      return { height: u16be(b, at + 5), width: u16be(b, at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

function webpSize(b: Uint8Array): PictureSize | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  switch (ascii(b, 12, 4)) {
    case "VP8 ":
      // A key frame's start code, then two 14-bit sizes (the top two bits are a scale).
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    case "VP8L": {
      if (b[20] !== 0x2f) return null;
      const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case "VP8X":
      return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    default:
      return null;
  }
}
