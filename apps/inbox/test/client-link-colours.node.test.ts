import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The colour of a link in what people wrote, by day and by night, in the owner app (`--text-link`,
 * @surfingdog/ui) and the phone app (`--link`): readable as text on every ground it sits on (WCAG AA,
 * 4.5:1), and never red: red says something went wrong, and nothing else. A business's accent, once
 * chosen, takes its place (`--link`), and the accents are held to the same (look-palette.test.ts).
 */
const read = (p: string) => readFileSync(path.resolve(import.meta.dirname, p), "utf8");

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** How far a colour's hue is from red, in degrees. */
function fromRed(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const hue = (h * 60 + 360) % 360;
  return Math.min(hue, 360 - hue);
}

/** The owner app's grounds by day (Standard, Minimal, Warm) and by night. */
const DAY = ["#f6f5ff", "#ffffff", "#f5efe4"];
const NIGHT = ["#0d0e26"];

describe("a link's colour", () => {
  it("in the owner app: blue until the business chooses an accent, AA by day and by night, never red", () => {
    const css = read("../../../packages/ui/src/index.css");
    const tones = [...css.matchAll(/--text-link: var\(--link, (#[0-9a-f]{6})\);/g)].map((m) => m[1] ?? "");
    // The day's, then the night's twice: as the device says, and as the owner chose.
    expect(tones).toHaveLength(3);
    const [day = "", night = "", chosen = ""] = tones;
    expect(chosen).toBe(night);
    for (const ground of DAY) expect(contrast(day, ground), `${day} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    for (const ground of NIGHT) expect(contrast(night, ground), `${night} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    for (const tone of tones) expect(fromRed(tone), tone).toBeGreaterThanOrEqual(30);
    // Links in what people wrote take it; the app's own buttons styled as links keep theirs.
    const app = read("../client/src/app.css");
    expect(app).toMatch(/\.msg-link \{\n {2}color: var\(--text-link\);/);
  });

  it("in the phone app: its own link blue, AA on its grounds and its cards, never red", () => {
    const css = read("../../mobile/src/app.css");
    const tones = [...css.matchAll(/--link: (#[0-9a-f]{6});/g)].map((m) => m[1] ?? "");
    expect(tones).toHaveLength(2);
    const [day = "", night = ""] = tones;
    for (const ground of ["#f6f5ff", "#ffffff", "#ede9ff"]) expect(contrast(day, ground)).toBeGreaterThanOrEqual(4.5);
    for (const ground of ["#0d0e26", "#17183a", "#2a2357"]) expect(contrast(night, ground)).toBeGreaterThanOrEqual(4.5);
    for (const tone of tones) expect(fromRed(tone), tone).toBeGreaterThanOrEqual(30);
    expect(css).toMatch(/\.msg-link \{\n {2}color: var\(--link\);/);
  });
});
