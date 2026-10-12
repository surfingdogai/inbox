/**
 * A zip file from a few files held in memory, with web-standard APIs only, so it is the same on
 * every runtime: each file deflated by `CompressionStream("deflate-raw")` when that makes it smaller
 * (and stored as it is when not, or where the runtime cannot deflate), its CRC-32, and the central
 * directory every unzip tool reads. Names are UTF-8. No zip64: a file, or the whole zip, of 4 GB or
 * more is refused rather than written wrong.
 */
export interface ZipFile {
  readonly name: string;
  readonly data: Uint8Array;
}

const LIMIT = 0xffff_ffff;

export async function zip(files: readonly ZipFile[], modified: Date = new Date()): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const { time, date } = dosTime(modified);
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    if (file.data.length >= LIMIT) throw new Error(`${file.name} is too large to zip (4 GB or more)`);
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const deflated = await deflate(file.data);
    const body = deflated && deflated.length < file.data.length ? deflated : file.data;
    const method = body === file.data ? 0 : 8;

    const header = new Uint8Array(30 + name.length);
    const h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true); // version needed: 2.0
    h.setUint16(6, 0x0800, true); // the name is UTF-8
    h.setUint16(8, method, true);
    h.setUint16(10, time, true);
    h.setUint16(12, date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, body.length, true);
    h.setUint32(22, file.data.length, true);
    h.setUint16(26, name.length, true);
    header.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const e = new DataView(entry.buffer);
    e.setUint32(0, 0x02014b50, true);
    e.setUint16(4, 0x031e, true); // made by: Unix, 3.0
    e.setUint16(6, 20, true);
    e.setUint16(8, 0x0800, true);
    e.setUint16(10, method, true);
    e.setUint16(12, time, true);
    e.setUint16(14, date, true);
    e.setUint32(16, crc, true);
    e.setUint32(20, body.length, true);
    e.setUint32(24, file.data.length, true);
    e.setUint16(28, name.length, true);
    e.setUint32(38, 0o100644 * 0x10000, true); // a plain file, rw-r--r--
    e.setUint32(42, offset, true);
    entry.set(name, 46);

    local.push(header, body);
    central.push(entry);
    offset += header.length + body.length;
    if (offset >= LIMIT) throw new Error("the zip would be 4 GB or more");
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const d = new DataView(end.buffer);
  d.setUint32(0, 0x06054b50, true);
  d.setUint16(8, files.length, true);
  d.setUint16(10, files.length, true);
  d.setUint32(12, size, true);
  d.setUint32(16, offset, true);
  return concat([...local, ...central, end]);
}

/** Raw deflate, or null where the runtime has no `deflate-raw`: the file is then stored as it is. */
async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** An MS-DOS time and date, in UTC: what a zip entry carries. */
function dosTime(at: Date): { time: number; date: number } {
  const year = Math.min(Math.max(at.getUTCFullYear(), 1980), 2107);
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

let table: Uint32Array | null = null;

/** CRC-32 (IEEE 802.3), as zip uses it. */
export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = (table[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
