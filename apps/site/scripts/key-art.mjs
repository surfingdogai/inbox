// Cut the flat ground out of pixel art so it floats on the page in both themes, and clean it up.
//
//   node scripts/key-art.mjs public/art/hero.png public/art/tile-inbox.png …
//
// Input must be a real 8-bit PNG (the Gemini exports are JPEG bytes in .png files; convert first
// with `sips -s format png in.png --out out.png`). Steps:
//   1. the ground colour is the median of the border;
//   2. a flood fill from the border removes every connected pixel within KEY_TOL of it, then any
//      enclosed pocket of ground of at least KEY_POCKET pixels (a handle loop, the inside of a curl);
//   3. a halo pass removes JPEG ringing: pixels within KEY_REACH of the cut and within KEY_EDGE of
//      the ground;
//   4. the remaining pixels snap to a palette of the art's dominant colours, which removes JPEG
//      noise and lets the file shrink to an indexed PNG.
// Output overwrites the input as an 8-bit indexed PNG with one transparent entry.
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

const KEY_TOL = Number(process.env.KEY_TOL ?? 10);
const KEY_EDGE = Number(process.env.KEY_EDGE ?? 44);
const KEY_REACH = Number(process.env.KEY_REACH ?? 2);
const KEY_POCKET = Number(process.env.KEY_POCKET ?? 64);
const KEY_MERGE = Number(process.env.KEY_MERGE ?? 12);

function decode(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  let interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${bitDepth}, interlace ${interlace})`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgb = Buffer.alloc(width * height * 3);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const s = x * channels;
      if (channels >= 3) {
        rgb[o] = line[s];
        rgb[o + 1] = line[s + 1];
        rgb[o + 2] = line[s + 2];
      } else rgb[o] = rgb[o + 1] = rgb[o + 2] = line[s];
    }
    prev = line;
  }
  return { width, height, rgb };
}

const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c;
}
function crc32(bytes) {
  let c = -1;
  for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** Indexed PNG: palette entry 0 is fully transparent, the rest opaque. */
function encodeIndexed(width, height, indices, palette) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach(([r, g, b], i) => {
    plte[i * 3] = r;
    plte[i * 3 + 1] = g;
    plte[i * 3 + 2] = b;
  });
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    indices.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", plte),
    chunk("tRNS", Buffer.from([0])),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function key(file) {
  const { width, height, rgb } = decode(readFileSync(file));
  const n = width * height;
  const border = [[], [], []];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= 4 && x < width - 4 && y >= 4 && y < height - 4) continue;
      const o = (y * width + x) * 3;
      border[0].push(rgb[o]);
      border[1].push(rgb[o + 1]);
      border[2].push(rgb[o + 2]);
    }
  }
  const kr = median(border[0]);
  const kg = median(border[1]);
  const kb = median(border[2]);
  const dist = (i) => Math.hypot(rgb[i * 3] - kr, rgb[i * 3 + 1] - kg, rgb[i * 3 + 2] - kb);

  // 1 + 2: flood from the border, then enclosed pockets.
  const mask = new Uint8Array(n);
  const queue = new Int32Array(n);
  const fill = (seeds, mark) => {
    let head = 0;
    let tail = 0;
    const visit = (i) => {
      if (mark[i] || dist(i) > KEY_TOL) return;
      mark[i] = 1;
      queue[tail++] = i;
    };
    for (const s of seeds) visit(s);
    while (head < tail) {
      const i = queue[head++];
      const x = i % width;
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (i >= width) visit(i - width);
      if (i + width < n) visit(i + width);
    }
    return tail;
  };
  const edge = [];
  for (let x = 0; x < width; x++) edge.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y++) edge.push(y * width, y * width + width - 1);
  const cut = fill(edge, mask);
  let pockets = 0;
  const seen = new Uint8Array(mask);
  for (let i = 0; i < n; i++) {
    if (seen[i] || dist(i) > KEY_TOL) continue;
    const before = seen.slice();
    const size = fill([i], seen);
    if (size >= KEY_POCKET) {
      for (let j = 0; j < n; j++) if (seen[j] && !before[j]) mask[j] = 1;
      pockets += size;
    }
  }

  // 3: halo.
  const fringe = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] || dist(i) > KEY_EDGE) continue;
      let near = false;
      for (let dy = -KEY_REACH; dy <= KEY_REACH && !near; dy++) {
        for (let dx = -KEY_REACH; dx <= KEY_REACH; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          if (mask[yy * width + xx]) {
            near = true;
            break;
          }
        }
      }
      if (near) fringe[i] = 1;
    }
  }
  let halo = 0;
  for (let i = 0; i < n; i++) {
    if (fringe[i]) {
      mask[i] = 1;
      halo++;
    }
  }

  // 4: palette from the dominant colours of what remains (5 bits per channel buckets, merged).
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    if (mask[i]) continue;
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let e = buckets.get(k);
    if (!e) {
      e = { count: 0, r: 0, g: 0, b: 0 };
      buckets.set(k, e);
    }
    e.count++;
    e.r += r;
    e.g += g;
    e.b += b;
  }
  const candidates = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .map((e) => [Math.round(e.r / e.count), Math.round(e.g / e.count), Math.round(e.b / e.count), e.count]);
  const palette = [[kr, kg, kb]];
  for (const [r, g, b] of candidates) {
    if (palette.length >= 256) break;
    if (Math.hypot(r - kr, g - kg, b - kb) <= KEY_MERGE + 4) continue;
    if (palette.some(([pr, pg, pb], i) => i > 0 && Math.hypot(r - pr, g - pg, b - pb) <= KEY_MERGE)) continue;
    palette.push([r, g, b]);
  }
  const indices = Buffer.alloc(n);
  const cache = new Map();
  for (let i = 0; i < n; i++) {
    if (mask[i]) continue;
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    const k = (r << 16) | (g << 8) | b;
    let best = cache.get(k);
    if (best === undefined) {
      let d = Number.POSITIVE_INFINITY;
      best = 1;
      for (let j = 1; j < palette.length; j++) {
        const [pr, pg, pb] = palette[j];
        const dj = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
        if (dj < d) {
          d = dj;
          best = j;
        }
      }
      cache.set(k, best);
    }
    indices[i] = best;
  }

  const out = encodeIndexed(width, height, indices, palette);
  writeFileSync(file, out);
  const hex = `#${[kr, kg, kb].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  console.log(
    `${file}: ${width}x${height}, ground ${hex}, cut ${((100 * cut) / n).toFixed(1)}% + pockets ${((100 * pockets) / n).toFixed(2)}% + halo ${((100 * halo) / n).toFixed(2)}%, ${palette.length - 1} colours, ${(out.length / 1024).toFixed(0)} KB`,
  );
}

for (const file of process.argv.slice(2)) key(file);
