import { crc32 } from "../src/util/zip";

/**
 * Reads a zip the way an unzip tool does, for tests: from the central directory at its end, each
 * entry's local header, its data stored or deflated, and its CRC-32 checked.
 */
export interface Unzipped {
  readonly name: string;
  readonly method: number;
  readonly data: Uint8Array;
}

export async function unzip(bytes: Uint8Array): Promise<Unzipped[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error("no end of central directory");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out: Unzipped[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (view.getUint32(offset, true) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const body = bytes.subarray(start, start + packed);
    const data = method === 8 ? await inflate(body) : body.slice();
    if (data.length !== size) throw new Error(`${name}: ${data.length} bytes, not ${size}`);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC-32 does not match`);
    out.push({ name, method, data });
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
