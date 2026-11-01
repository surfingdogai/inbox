import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccentDots, LookPreview, ThemeSwatches } from "../client/src/components/Look";
import { RailHead } from "../client/src/components/Rail";

/**
 * Settings → Look and the rail, rendered: four named theme radios and seven named accent radios with
 * the chosen one checked, what customers see, and the logo in the rail where the Inbox mark is.
 */

/** The radios of one group, in order: each one's value, and whether it is checked. */
const radios = (html: string, name: string) =>
  [...html.matchAll(/<input [^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes('type="radio"') && tag.includes(`name="${name}"`))
    .map((tag) => ({ value: /value="([a-z]+)"/.exec(tag)?.[1], checked: tag.includes('checked=""') }));

describe("Settings → Look, on the page", () => {
  it("offers four themes by name, the chosen one checked", () => {
    const html = renderToStaticMarkup(
      createElement(ThemeSwatches, { theme: "warm", accent: "teal", onChoose: () => undefined }),
    );
    expect(radios(html, "look-theme")).toEqual([
      { value: "standard", checked: false },
      { value: "minimal", checked: false },
      { value: "dark", checked: false },
      { value: "warm", checked: true },
    ]);
    for (const [name, line] of [
      ["Standard", "As it is today"],
      ["Minimal", "White, thin lines"],
      ["Dark", "Dark pages"],
      ["Warm", "Soft off-white"],
    ]) {
      expect(html).toContain(`>${name}</span><span class="look-line">${line}</span>`);
    }
    expect(html).toContain('role="radiogroup" aria-label="Theme"');
  });

  it("offers seven accents, each named for a screen reader, the chosen one checked and shown", () => {
    const html = renderToStaticMarkup(
      createElement(AccentDots, { theme: "dark", accent: "plum", onChoose: () => undefined }),
    );
    const all = radios(html, "look-accent");
    expect(all.map((r) => r.value)).toEqual(["ink", "blue", "teal", "green", "violet", "plum", "ochre"]);
    expect(all.filter((r) => r.checked).map((r) => r.value)).toEqual(["plum"]);
    for (const name of ["Ink", "Blue", "Teal", "Green", "Violet", "Plum", "Ochre"]) {
      expect(html).toContain(`<span class="sr-only">${name}</span>`);
    }
    expect(html).toContain('<span class="look-chosen" aria-hidden="true">Plum</span>');
    // On Dark each dot is the night tone, and Ink the theme's own ink.
    expect(html).toContain("--d:#e29ad6");
    expect(html).toContain("--d:#ececec");
  });

  it("shows what customers see: the logo above the name, a button and a link in the accent", () => {
    const html = renderToStaticMarkup(
      createElement(LookPreview, { theme: "minimal", accent: "blue", business: "Studio Kalinda", logoUrl: "blob:x" }),
    );
    expect(html).toContain('<p class="biz"><img src="blob:x" alt=""/>Studio Kalinda</p>');
    expect(html).toContain("--p-accent:#2357b5");
    expect(html).toContain('data-look="minimal"');
    expect(html).toContain("Emails stay light, whatever the theme.");
    const plain = renderToStaticMarkup(
      createElement(LookPreview, { theme: "standard", accent: "ink", business: "Studio Kalinda", logoUrl: null }),
    );
    expect(plain).not.toContain("<img");
    expect(plain).toContain("--p-accent:#111111");
  });
});

describe("the rail's head", () => {
  it("shows the business's logo where the Inbox mark is, and its name beside it", () => {
    const html = renderToStaticMarkup(createElement(RailHead, { name: "Studio Kalinda", logo: "blob:x" }));
    expect(html).toContain('<img class="rail-logo" src="blob:x" alt=""/>');
    expect(html).toContain('<span class="label">Studio Kalinda</span>');
    expect(html).not.toContain("<svg");
    const plain = renderToStaticMarkup(createElement(RailHead, { name: "Studio Kalinda", logo: null }));
    expect(plain).not.toContain("<img");
    expect(plain).toContain("<svg");
  });
});
