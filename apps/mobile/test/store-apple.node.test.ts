import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The App Store text (apps/mobile/store/apple): App Store Connect's limits, and the rules a review
 * rejects on, checked before anyone pastes it in.
 */
const dir = new URL("../store/apple/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

interface Listing {
  locale: string;
  name: string;
  subtitle: string;
  promotionalText: string;
  description: string[];
  keywords: string;
  supportUrl: string;
  marketingUrl: string;
  privacyPolicyUrl: string;
}

const listings = files.map((f) => [f, JSON.parse(readFileSync(new URL(f, dir), "utf8")) as Listing] as const);

describe("the App Store text", () => {
  it("is in English, Portuguese, Spanish and French", () => {
    expect(files.sort()).toEqual(["en-US.json", "es-ES.json", "fr-FR.json", "pt-PT.json"]);
  });

  for (const [file, l] of listings) {
    describe(file, () => {
      const description = l.description.join("\n");
      const all = [l.name, l.subtitle, l.promotionalText, description, l.keywords].join("\n");

      it("names its own locale", () => expect(`${l.locale}.json`).toBe(file));

      it("fits App Store Connect's limits", () => {
        expect(l.name).toBe("Surfing Dog Inbox");
        expect([...l.subtitle].length).toBeLessThanOrEqual(30);
        expect([...l.promotionalText].length).toBeLessThanOrEqual(170);
        expect([...description].length).toBeLessThanOrEqual(4000);
        expect(new TextEncoder().encode(l.keywords).length).toBeLessThanOrEqual(100);
      });

      it("spends no keyword on a space, a repeat or a word the name already has", () => {
        const words = l.keywords.split(",");
        expect(words.every((w) => w === w.trim() && w.length > 0)).toBe(true);
        expect(new Set(words).size).toBe(words.length);
        for (const w of words) expect(w).not.toMatch(/surfing|dog|inbox/i);
      });

      it("names no other platform or store (App Review 2.3.10)", () => {
        expect(all).not.toMatch(/android|google|play store|\bapk\b/i);
      });

      it("puts no price in the name, subtitle, promotional text or keywords (App Review 2.3.7)", () => {
        // "Free in your calendar" in the description is about a time, not a price.
        const short = [l.name, l.subtitle, l.promotionalText, l.keywords].join("\n");
        expect(short).not.toMatch(/\bfree\b|grátis|gratis|gratuit|€|\$/i);
      });

      it("links only to surfingdog.ai over https", () => {
        for (const u of [l.supportUrl, l.marketingUrl, l.privacyPolicyUrl])
          expect(u).toMatch(/^https:\/\/surfingdog\.ai\//);
      });
    });
  }
});
