import { describe, expect, it } from "vitest";
import { imageSize } from "../src/lib/image-size";

/** The header reader behind every <img> width and height the site prints from a file. */
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const le24 = (n: number) => le32(n).slice(0, 3);
const le16 = (n: number) => le32(n).slice(0, 2);
const pad = (bytes: number[]) => new Uint8Array([...bytes, ...new Array(16).fill(0)]);
const webp = (chunk: string, body: number[]) =>
  pad([
    ...ascii("RIFF"),
    ...le32(4 + 8 + body.length),
    ...ascii("WEBP"),
    ...ascii(chunk),
    ...le32(body.length),
    ...body,
  ]);

describe("imageSize", () => {
  it("reads a PNG", () => {
    const png = pad([0x89, ...ascii("PNG\r\n\x1a\n"), ...[0, 0, 0, 13], ...ascii("IHDR"), 0, 0, 3, 12, 0, 0, 6, 152]);
    expect(imageSize(png)).toEqual({ width: 780, height: 1688 });
  });

  it("reads a lossless WebP", () => {
    const bits = (780 - 1) | ((1688 - 1) << 14);
    expect(imageSize(webp("VP8L", [0x2f, ...le32(bits)]))).toEqual({ width: 780, height: 1688 });
  });

  it("reads a lossy WebP, leaving out the scaling bits", () => {
    const body = [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(780 | 0x4000), ...le16(1688 | 0x8000)];
    expect(imageSize(webp("VP8 ", body))).toEqual({ width: 780, height: 1688 });
  });

  it("reads an extended WebP, as with transparency", () => {
    const body = [0x10, 0, 0, 0, ...le24(780 - 1), ...le24(1688 - 1)];
    expect(imageSize(webp("VP8X", body))).toEqual({ width: 780, height: 1688 });
  });

  it("says nothing of a file it can't read", () => {
    expect(imageSize(webp("ALPH", [0, 0, 0, 0]))).toBeUndefined();
    expect(imageSize(pad([...ascii("RIFF"), ...le32(4), ...ascii("WAVEfmt ")]))).toBeUndefined();
    expect(imageSize(new Uint8Array([0x47, 0x49, 0x46]))).toBeUndefined();
  });
});
