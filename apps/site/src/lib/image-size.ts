/**
 * Width and height from a PNG, JPEG or WebP header, so <img> tags carry their size and never shift the
 * layout. Returns undefined for anything else; the caller then simply omits the attributes.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // PNG: signature, then IHDR with width and height at bytes 16 and 20.
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // WebP: RIFF, WEBP, then its first chunk at byte 12: VP8X (extended), VP8L (lossless) or VP8 (lossy).
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length >= 30 && tag(0) === "RIFF" && tag(8) === "WEBP") {
    const chunk = tag(12);
    // The canvas size less one, 24 bits each, little-endian.
    const u24 = (at: number) => view.getUint16(at, true) + ((bytes[at + 2] ?? 0) << 16);
    if (chunk === "VP8X") return { width: u24(24) + 1, height: u24(27) + 1 };
    // After the 0x2f signature, 14 bits each of width and height less one.
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    // After the frame tag and the start code 9d 01 2a, 14 bits each (the top two are scaling).
    if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    return undefined;
  }
  // JPEG: walk the markers to the first start-of-frame.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let pos = 2;
    while (pos + 9 < bytes.length) {
      if (bytes[pos] !== 0xff) return undefined;
      const marker = bytes[pos + 1] ?? 0;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
        pos += marker === 0xff ? 1 : 2;
        continue;
      }
      const length = view.getUint16(pos + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: view.getUint16(pos + 5), width: view.getUint16(pos + 7) };
      pos += 2 + length;
    }
  }
  return undefined;
}
