import { ascii, concat, pngChunk, SECRET_PLACE } from "./trades-files";

/**
 * Logos built byte by byte for the tests: a PNG with a text chunk naming where it was made, a
 * progressive JPEG, and a WebP of each kind. None decodes as a picture; only the header is read.
 */

const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/** A PNG of `w` × `h` with a text chunk naming where it was made. */
export function logoPng(w: number, h: number): Uint8Array {
  return concat(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk("IHDR", Uint8Array.from([...be32(w), ...be32(h), 8, 6, 0, 0, 0])),
    pngChunk("tEXt", ascii(`Comment\0${SECRET_PLACE}`)),
    pngChunk("IDAT", Uint8Array.from([0x78, 0x9c, 0x63, 0, 0, 0, 2, 0, 1])),
    pngChunk("IEND", new Uint8Array(0)),
  );
}

export const segment = (marker: number, body: number[] | Uint8Array) =>
  concat([0xff, marker], be16(body.length + 2), body instanceof Uint8Array ? body : Uint8Array.from(body));

/** A progressive JPEG whose Huffman table (C4, not a frame) comes before its frame (C2). */
export function jpeg(w: number, h: number): Uint8Array {
  return concat(
    [0xff, 0xd8],
    segment(0xe0, concat(ascii("JFIF\0"), [1, 1, 0, 0, 1, 0, 1, 0, 0])),
    segment(0xc4, new Uint8Array(20)),
    segment(0xc2, [8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    segment(0xda, [1, 1, 0, 0, 0x3f, 0]),
    [0x12, 0x34, 0x56],
    [0xff, 0xd9],
  );
}

export const riff = (...chunks: Uint8Array[]) => {
  const body = concat(ascii("WEBP"), ...chunks);
  return concat(ascii("RIFF"), le32(body.byteLength), body);
};
export const webpChunk = (fourcc: string, data: number[]) =>
  concat(ascii(fourcc), le32(data.length), data, data.length & 1 ? [0] : []);

export const vp8 = (w: number, h: number) =>
  riff(webpChunk("VP8 ", [0x50, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0, 0, 0]));
export const vp8l = (w: number, h: number) => {
  const bits = (w - 1) | ((h - 1) << 14);
  return riff(webpChunk("VP8L", [0x2f, ...le32(bits), 0, 0, 0, 0, 0]));
};
export const vp8x = (w: number, h: number) =>
  riff(webpChunk("VP8X", [0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]), webpChunk("VP8 ", [1, 2, 3, 4, 5, 6]));
