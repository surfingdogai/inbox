/**
 * Files as phones and laptops send them, built byte by byte for the tests (ADR-039 §2): a JPEG with
 * EXIF (orientation 6 and a GPS IFD), XMP, an MPF index, a comment and a phone's trailer after the
 * end; a PNG with tEXt and eXIf; a WebP with EXIF and XMP; a HEIC's and an AVIF's first box; a PDF.
 * None decodes as a picture, and none needs to: what is checked is what is left in them.
 */

const enc = new TextEncoder();
export const ascii = (s: string) => enc.encode(s);

export function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.byteLength, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.byteLength;
  }
  return out;
}

const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/** Where the test photo was taken, as its GPS IFD says: it must be in no cleaned file. */
export const SECRET_PLACE = "LAT-1.2921S-LNG36.8219E";

/** A little-endian TIFF: IFD0 with the orientation and a pointer to a GPS IFD naming `SECRET_PLACE`. */
export function exifTiff(orientation: number): Uint8Array {
  const place = ascii(`${SECRET_PLACE}\0`);
  // Header (8) + IFD0: count (2) + 2 entries (24) + next (4) = 38; the GPS IFD at 38: count (2) + 1 entry (12) + next (4) = 56; its data at 56.
  const gpsIfd = 38;
  const data = 56;
  return concat(
    ascii("II"),
    le16(42),
    le32(8),
    le16(2),
    // Orientation, SHORT, 1.
    le16(0x0112),
    le16(3),
    le32(1),
    [...le16(orientation), 0, 0],
    // GPSInfo, LONG, 1: where the GPS IFD is.
    le16(0x8825),
    le16(4),
    le32(1),
    le32(gpsIfd),
    le32(0),
    // The GPS IFD: one ASCII entry pointing at the place.
    le16(1),
    le16(0x0002),
    le16(2),
    le32(place.byteLength),
    le32(data),
    le32(0),
    place,
  );
}

const segment = (marker: number, body: Uint8Array) => concat([0xff, marker], be16(body.byteLength + 2), body);

/** A JPEG as a phone sends it: EXIF with GPS, XMP, an ICC profile, an MPF index, a comment, a trailer. */
export function phoneJpeg(orientation = 6): { bytes: Uint8Array; entropy: Uint8Array; icc: Uint8Array } {
  const icc = concat(ascii("ICC_PROFILE\0"), [1, 1], ascii("colour profile bytes"));
  // Entropy-coded data with a stuffed byte and a restart marker in it: both kept as they are.
  const entropy = Uint8Array.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]);
  const bytes = concat(
    [0xff, 0xd8],
    segment(0xe0, concat(ascii("JFIF\0"), [1, 1, 0, 0, 1, 0, 1, 0, 0])),
    segment(0xe1, concat(ascii("Exif\0\0"), exifTiff(orientation))),
    segment(0xe1, concat(ascii("http://ns.adobe.com/xap/1.0/\0"), ascii(`<x:xmpmeta>${SECRET_PLACE}</x:xmpmeta>`))),
    segment(0xe2, icc),
    segment(0xe2, concat(ascii("MPF\0"), ascii("second image index"))),
    segment(0xfe, ascii("Shot on a phone in the garden")),
    segment(0xdb, new Uint8Array(65)),
    segment(0xda, Uint8Array.from([1, 1, 0, 0, 0x3f, 0])),
    entropy,
    [0xff, 0xd9],
    // A phone's trailer after the end of the image: where it hides more about the picture.
    ascii(`SEFH${SECRET_PLACE}`),
  );
  return { bytes, entropy, icc };
}

let CRC: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const pngChunk = (type: string, data: Uint8Array) =>
  concat(be32(data.byteLength), ascii(type), data, be32(crc32(concat(ascii(type), data))));

/** A PNG with a text chunk and an eXIf chunk naming the place, and the time it was taken. */
export function textPng(orientation = 3): Uint8Array {
  return concat(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk("IHDR", Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    pngChunk("tEXt", ascii(`Comment\0${SECRET_PLACE}`)),
    pngChunk("tIME", Uint8Array.from([0x07, 0xea, 10, 21, 9, 30, 0])),
    pngChunk("eXIf", exifTiff(orientation)),
    pngChunk("IDAT", Uint8Array.from([0x78, 0x9c, 0x63, 0, 0, 0, 2, 0, 1])),
    pngChunk("IEND", new Uint8Array(0)),
  );
}

const riffChunk = (fourcc: string, data: Uint8Array) =>
  concat(ascii(fourcc), le32(data.byteLength), data, data.byteLength & 1 ? [0] : []);

/** An extended WebP with EXIF (orientation 8 and GPS) and XMP. */
export function metaWebp(orientation = 8): Uint8Array {
  const vp8x = Uint8Array.from([0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const body = concat(
    ascii("WEBP"),
    riffChunk("VP8X", vp8x),
    riffChunk("VP8 ", Uint8Array.from([1, 2, 3, 4, 5])),
    riffChunk("EXIF", concat(ascii("Exif\0\0"), exifTiff(orientation))),
    riffChunk("XMP ", ascii(`<x:xmpmeta>${SECRET_PLACE}</x:xmpmeta>`)),
  );
  return concat(ascii("RIFF"), le32(body.byteLength), body);
}

/** A HEIC photo's first box, as an iPhone writes it. */
export const heic = () => concat(be32(24), ascii("ftypheic"), be32(0), ascii("mif1heic"));
/** An AVIF's, whose major brand names it. */
export const avif = () => concat(be32(20), ascii("ftypavif"), be32(0), ascii("mif1"));
/** A small PDF. */
export const pdf = () => ascii("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
/** A PDF of about `size` bytes: zeros in its body, its %%EOF at the end. */
export const pdfOf = (size: number) =>
  concat(ascii("%PDF-1.7\n"), new Uint8Array(Math.max(0, size - 16)), ascii("\n%%EOF\n"));

export function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Whether `needle` appears anywhere in `hay`. */
export function contains(hay: Uint8Array, needle: string | Uint8Array): boolean {
  const n = typeof needle === "string" ? ascii(needle) : needle;
  outer: for (let i = 0; i + n.byteLength <= hay.byteLength; i++) {
    for (let j = 0; j < n.byteLength; j++) if (hay[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}
