import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Google Play pack (apps/mobile/store/play): the store text keeps to Play's limits and says nothing
 * the app does not do, and the answers given to Play (Data safety, target API level) still match the
 * app. A new permission or a lower target SDK fails here first, before a form goes stale.
 */
const mobile = path.resolve(import.meta.dirname, "..");
const play = path.join(mobile, "store/play");
const listing = path.join(play, "listing");
const read = (...parts: string[]) => readFileSync(path.join(...parts), "utf8");
/** Play counts characters, not bytes, without the file's last newline. */
const length = (text: string) => [...text.replace(/\n$/, "")].length;

const LOCALES = ["en-US", "pt-PT", "pt-BR", "es-ES", "fr-FR"];
/** The versionCode of the app's version (major × 10000 + minor × 100 + patch), which names its release notes. */
const version = (JSON.parse(read(mobile, "package.json")) as { version: string }).version;
const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
const CODE = major * 10_000 + minor * 100 + patch;

describe("the Google Play listing", () => {
  it("has every locale, and nothing else", () => {
    expect(readdirSync(listing).sort()).toEqual([...LOCALES].sort());
  });

  for (const locale of LOCALES) {
    describe(locale, () => {
      const title = read(listing, locale, "title.txt");
      const short = read(listing, locale, "short_description.txt");
      const full = read(listing, locale, "full_description.txt");
      // fastlane `supply` reads a release's notes from changelogs/<its versionCode>.txt.
      const notes = read(listing, locale, "changelogs", `${CODE}.txt`);

      it("keeps to Play's limits", () => {
        expect(title.trim()).toBe("Surfing Dog Inbox");
        expect(length(title)).toBeLessThanOrEqual(30);
        expect(length(short)).toBeGreaterThan(0);
        expect(length(short)).toBeLessThanOrEqual(80);
        expect(length(full)).toBeGreaterThan(0);
        expect(length(full)).toBeLessThanOrEqual(4000);
        expect(length(notes)).toBeLessThanOrEqual(500);
      });

      it("makes no claim Play forbids or the app can't keep", () => {
        for (const text of [title, short, full, notes]) {
          // No emoji, no ranking words, no other platform: the app is Android-only today.
          expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
          expect(text).not.toMatch(/#1|\bbest\b|\btop\b|iphone|\bios\b|app store/i);
        }
        // Where to read what the app sends, in every language.
        expect(full).toContain("surfingdog.ai/privacy");
        expect(full).toContain("Android 7.0");
      });

      if (locale !== "en-US") {
        it("says the app itself is in English", () => {
          expect(full).toMatch(/inglês|inglés|anglais/);
        });
      }
    });
  }
});

describe("the answers given to Play still match the app", () => {
  it("asks for exactly the permissions data-safety.md covers", () => {
    const manifest = read(mobile, "android/app/src/main/AndroidManifest.xml");
    const asked = [...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map((m) => m[1]).sort();
    // A new one means new answers in Data safety (and maybe a declaration form): update data-safety.md
    // and technical.md, then this list.
    expect(asked).toEqual(
      [
        "android.permission.CAMERA",
        "android.permission.INTERNET",
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.USE_BIOMETRIC",
      ].sort(),
    );
    expect(manifest).toContain('android:allowBackup="false"');
  });

  it("targets at least the API level Play requires (36 since 31 August 2026)", () => {
    const vars = read(mobile, "android/variables.gradle");
    const target = Number(/targetSdkVersion = (\d+)/.exec(vars)?.[1]);
    expect(target).toBeGreaterThanOrEqual(36);
  });

  it("tells Play's reviewer how to get in, in a few lines", () => {
    const access = read(play, "app-access.txt");
    expect(access).toContain("Try the demo");
    expect(access).toContain("demo.surfingdog.ai");
    expect(length(access)).toBeLessThanOrEqual(500);
    // The button it names is on the first screen, and the demo it names is the app's.
    expect(read(mobile, "src/screens/Connect.tsx")).toContain("Try the demo");
    expect(read(mobile, "src/lib/client.ts")).toContain('"https://demo.surfingdog.ai"');
  });

  it("keeps every file the pack's README lists", () => {
    for (const f of [
      "README.md",
      "app-access.txt",
      "data-safety.md",
      "app-content.md",
      "privacy-policy.md",
      "technical.md",
      "signing.md",
      "screenshots.md",
      "phone-page.md",
    ]) {
      expect(existsSync(path.join(play, f)), f).toBe(true);
    }
  });
});
