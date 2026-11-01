import { ACCENT_TONES } from "@surfingdog/core/look";
import { describe, expect, it } from "vitest";
import { accentTone, accentVars, logoProblem, readLookCache } from "../client/src/lib/look";
import { resolveTheme } from "../client/src/lib/theme";

/**
 * The business's look in the owner app, as pure functions: what Auto resolves to for each theme, the
 * tones an accent sets, and a kept look read back however it was left.
 */

describe("Auto, by the business's theme", () => {
  it("is night for Dark, day for Minimal and Warm, and the device's for Standard", () => {
    expect(resolveTheme("system", "dark")).toBe("dark");
    expect(resolveTheme("system", "minimal")).toBe("light");
    expect(resolveTheme("system", "warm")).toBe("light");
    expect(resolveTheme("system", null)).toBeNull();
    expect(resolveTheme("system", "standard")).toBeNull();
  });

  it("gives way to the owner's own Day or Night", () => {
    expect(resolveTheme("light", "dark")).toBe("light");
    expect(resolveTheme("dark", "warm")).toBe("dark");
    expect(resolveTheme("dark", null)).toBe("dark");
  });
});

describe("an accent's tones", () => {
  it("are its day and night tones with their labels; Ink sets none", () => {
    expect(accentVars("teal")).toEqual({
      "--accent-day": ACCENT_TONES.teal.day,
      "--accent-day-fg": "#ffffff",
      "--accent-night": ACCENT_TONES.teal.night,
      "--accent-night-fg": "#111111",
    });
    expect(accentVars("ink")).toBeNull();
  });

  it("show as the theme shows them: night on Dark, day otherwise, Ink the theme's ink", () => {
    expect(accentTone("dark", "plum").accent).toBe(ACCENT_TONES.plum.night);
    expect(accentTone("warm", "plum").accent).toBe(ACCENT_TONES.plum.day);
    expect(accentTone("dark", "ink")).toEqual({ accent: "#ececec", label: "#141414" });
    expect(accentTone("warm", "ink")).toEqual({ accent: "#2b2420", label: "#faf6ef" });
  });
});

describe("the kept look", () => {
  it("reads back what was kept, and the default for anything else", () => {
    expect(readLookCache(JSON.stringify({ theme: "warm", accent: "green" }))).toEqual({
      theme: "warm",
      accent: "green",
    });
    expect(readLookCache(null)).toEqual({ theme: "standard", accent: "ink" });
    expect(readLookCache("{not json")).toEqual({ theme: "standard", accent: "ink" });
    expect(readLookCache('"dark"')).toEqual({ theme: "standard", accent: "ink" });
    expect(readLookCache(JSON.stringify({ theme: "neon", accent: "red" }))).toEqual({
      theme: "standard",
      accent: "ink",
    });
    expect(readLookCache(JSON.stringify({ theme: "dark", accent: 7 }))).toEqual({ theme: "dark", accent: "ink" });
  });
});

describe("a picture chosen for the logo", () => {
  it("is said to be wrong at once when the inbox would refuse it", () => {
    expect(logoProblem({ type: "image/png", size: 20_000 })).toBeNull();
    expect(logoProblem({ type: "image/svg+xml", size: 2_000 })).toBe("A logo is a PNG, JPEG or WebP picture.");
    expect(logoProblem({ type: "image/heic", size: 2_000 })).toBe("A logo is a PNG, JPEG or WebP picture.");
    expect(logoProblem({ type: "image/jpeg", size: 512 * 1024 + 1 })).toBe("A logo is at most 512 KB.");
  });
});
