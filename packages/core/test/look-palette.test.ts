import { describe, expect, it } from "vitest";
import {
  ACCENT_LABELS,
  ACCENT_TONES,
  accentIn,
  LOOK_ACCENTS,
  LOOK_THEMES,
  STANDARD_NIGHT,
  THEME_LABELS,
  THEME_TONES,
} from "../src/look/palette";
import { settingsSchema } from "../src/settings/schema";

/**
 * The palettes, checked as the founder asked: every accent passes WCAG AA (4.5:1) as text on every
 * ground it sits on, and as a button's label; the themes read well; nothing but an error is red.
 */

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

function hue(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** The grounds a day tone sits on: customer pages (white, warm) and the owner app (day, warm). */
const DAY_GROUNDS = ["#ffffff", "#f6f5ff", "#faf6ef", "#f5efe4"];
/** The grounds a night tone sits on: Standard at night, Dark, and the owner app's night. */
const NIGHT_GROUNDS = ["#111111", "#141414", "#0d0e26"];

describe("the accents", () => {
  for (const [name, tones] of Object.entries(ACCENT_TONES)) {
    it(`${name} passes AA, day and night, as text and as a button`, () => {
      for (const ground of DAY_GROUNDS)
        expect(contrast(tones.day, ground), `${name} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tones.dayFg, tones.day)).toBeGreaterThanOrEqual(4.5);
      for (const ground of NIGHT_GROUNDS)
        expect(contrast(tones.night, ground), `${name} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tones.nightFg, tones.night)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("are never red, and none is an error's colour", () => {
    const errors = [...Object.values(THEME_TONES), STANDARD_NIGHT].map((t) => t.err);
    for (const tones of Object.values(ACCENT_TONES)) {
      for (const tone of [tones.day, tones.night]) {
        const h = hue(tone);
        expect(Math.min(h, 360 - h), tone).toBeGreaterThanOrEqual(30);
        expect(errors).not.toContain(tone);
      }
    }
  });

  it("Ink is the theme's own ink on its own ground", () => {
    for (const tones of [...Object.values(THEME_TONES), STANDARD_NIGHT]) {
      expect(accentIn("ink", tones)).toEqual({ accent: tones.fg, label: tones.bg });
    }
    expect(accentIn("teal", THEME_TONES.dark)).toEqual({ accent: "#5cd0d8", label: "#111111" });
    expect(accentIn("teal", THEME_TONES.warm)).toEqual({ accent: "#0b6e75", label: "#ffffff" });
  });
});

describe("the themes", () => {
  for (const [name, t] of [...Object.entries(THEME_TONES), ["standard at night", STANDARD_NIGHT] as const]) {
    it(`${name} reads well: text, muted text and errors`, () => {
      expect(contrast(t.fg, t.bg)).toBeGreaterThanOrEqual(7);
      expect(contrast(t.muted, t.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.err, t.bg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("are the setting's own choices, each with its name", () => {
    expect(settingsSchema.parse({}).look).toMatchObject({ theme: "standard", accent: "ink" });
    for (const theme of LOOK_THEMES) expect(settingsSchema.parse({ look: { theme } }).look.theme).toBe(theme);
    for (const accent of LOOK_ACCENTS) expect(settingsSchema.parse({ look: { accent } }).look.accent).toBe(accent);
    expect(settingsSchema.safeParse({ look: { theme: "neon" } }).success).toBe(false);
    expect(settingsSchema.safeParse({ look: { accent: "red" } }).success).toBe(false);
    expect(Object.keys(THEME_TONES)).toEqual([...LOOK_THEMES]);
    expect(Object.keys(THEME_LABELS)).toEqual([...LOOK_THEMES]);
    expect(["ink", ...Object.keys(ACCENT_TONES)]).toEqual([...LOOK_ACCENTS]);
    expect(Object.keys(ACCENT_LABELS)).toEqual([...LOOK_ACCENTS]);
  });
});
