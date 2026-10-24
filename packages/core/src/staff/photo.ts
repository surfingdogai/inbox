/**
 * A member of staff's photo (ADR-035): a small JPEG the owner app made from the picture they chose (at
 * most 320 pixels a side), kept as a data URL of at most 32 KB. It is read again before it is kept:
 * it must start and end as a JPEG does, and every segment that can carry metadata — where and when it
 * was taken, the camera, a thumbnail, comments — is taken out, so only the picture itself is published.
 * Pure: Web APIs only.
 */

export const PHOTO_MAX_BYTES = 32 * 1024;
const PREFIX = "data:image/jpeg;base64,";

/** Why a photo cannot be kept, in the owner's words; null when it can. */
export type PhotoProblem = "not_jpeg" | "too_large" | "unreadable";

function fromBase64(text: string): Uint8Array | null {
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * The JPEG with its metadata segments taken out: APP1 to APP15 (EXIF and its GPS block, XMP, ICC,
 * Photoshop, a thumbnail) and comments. Of APP0, only the JFIF header's own 14 bytes, with no thumbnail:
 * a JFIF thumbnail, or a JFXX extension's, can be of the picture before it was cropped. The tables, the
 * frame and the scan stay. Null when it is not a well-formed JPEG.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] ?? 0;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Start of scan: the rest is the picture, up to and with the end marker.
    if (marker === 0xda) {
      const end = bytes.length;
      if (bytes[end - 2] !== 0xff || bytes[end - 1] !== 0xd9) return null;
      kept.push(bytes.subarray(i, end));
      break;
    }
    // Markers with no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(bytes.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (marker === 0xd9) return null;
    const length = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    if (length < 2 || i + 2 + length > bytes.length) return null;
    const metadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (marker === 0xe0) {
      const header = jfifHeader(bytes.subarray(i + 4, i + 2 + length));
      if (header) kept.push(header);
    } else if (!metadata) kept.push(bytes.subarray(i, i + 2 + length));
    i += 2 + length;
  }
  const last = kept[kept.length - 1];
  if (last?.[0] !== 0xff || last[1] !== 0xda) return null;
  const size = kept.reduce((n, k) => n + k.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const k of kept) {
    out.set(k, at);
    at += k.length;
  }
  return out;
}

/** "JFIF\0": the identifier of the JFIF header; anything else in APP0 (JFXX, another's) is dropped. */
const JFIF = [0x4a, 0x46, 0x49, 0x46, 0x00];

/** A JFIF APP0 segment as it is kept: its version, units and density, and no thumbnail. */
function jfifHeader(body: Uint8Array): Uint8Array | null {
  if (body.length < 12 || !JFIF.every((b, k) => body[k] === b)) return null;
  const out = new Uint8Array(18);
  out.set([0xff, 0xe0, 0x00, 0x10]);
  out.set(body.subarray(0, 12), 4);
  // No thumbnail: zero wide, zero high.
  out[16] = 0;
  out[17] = 0;
  return out;
}

/** The photo as it is kept, or why it cannot be. */
export function cleanPhoto(dataUrl: string): { readonly photo: string } | { readonly problem: PhotoProblem } {
  if (!dataUrl.startsWith(PREFIX)) return { problem: "not_jpeg" };
  // A base64 text a little over the cap can still hold a picture under it once its metadata is gone.
  if (dataUrl.length > PREFIX.length + Math.ceil((PHOTO_MAX_BYTES * 4) / 3) * 2) return { problem: "too_large" };
  const bytes = fromBase64(dataUrl.slice(PREFIX.length));
  if (!bytes) return { problem: "unreadable" };
  const clean = stripJpegMetadata(bytes);
  if (!clean) return { problem: "not_jpeg" };
  if (clean.length > PHOTO_MAX_BYTES) return { problem: "too_large" };
  return { photo: `${PREFIX}${toBase64(clean)}` };
}

/** The photo's bytes, to serve. */
export function photoBytes(photo: string): Uint8Array | null {
  return photo.startsWith(PREFIX) ? fromBase64(photo.slice(PREFIX.length)) : null;
}
