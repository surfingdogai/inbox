import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccentDots, LookPreview, ThemeSwatches } from "../client/src/components/Look";
import { RailHead } from "../client/src/components/Rail";
import { ThemeSwitch } from "../client/src/components/ThemeSwitch";

/**
 * Settings → Look and the rail, rendered: four named theme radios and seven named accent radios with
 * the chosen one checked, what customers see, the logo in the rail where the Inbox mark is, and the
 * theme switch as it always read while the theme is Standard.
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
    // On Dark each dot is the night tone, and Ink the theme's own ink, on Dark's own ground.
    expect(html).toContain("--d:#e29ad6");
    expect(html).toContain("--d:#ececec");
    expect(html).toContain('class="look-dots" style="--m-bg:#141414;--m-fg:#ececec;--m-rule:#2a2a2a"');
  });

  it("shows what customers see: the logo in place of the name, a button and a link in the accent", () => {
    const html = renderToStaticMarkup(
      createElement(LookPreview, { theme: "minimal", accent: "blue", business: "Studio Kalinda", logoUrl: "blob:x" }),
    );
    expect(html).toContain('<p class="biz"><img src="blob:x" alt="Studio Kalinda"/></p>');
    expect(html).toContain("--p-accent:#2357b5");
    expect(html).toContain('data-look="minimal"');
    expect(html).toContain("Emails stay light, whatever the theme.");
    const plain = renderToStaticMarkup(
      createElement(LookPreview, { theme: "standard", accent: "ink", business: "Studio Kalinda", logoUrl: null }),
    );
    expect(plain).not.toContain("<img");
    expect(plain).toContain('<p class="biz">Studio Kalinda</p>');
    expect(plain).toContain("--p-accent:#111111");
  });
});

describe("the rail's head", () => {
  const square = { url: "blob:x", waiting: false, width: 96, height: 96 };
  const head = (logo: Parameters<typeof RailHead>[0]["logo"]) =>
    renderToStaticMarkup(createElement(RailHead, { name: "Studio Kalinda", logo }));

  it("shows the business's logo where the Inbox mark is, its name kept for screen readers only", () => {
    const html = head(square);
    expect(html).toContain('<img class="rail-logo" src="blob:x" alt=""/>');
    expect(html).toContain('<span class="sr-only">Studio Kalinda</span>');
    expect(html).not.toContain('<span class="label">');
    expect(html).not.toContain("<svg");
    const plain = head(null);
    expect(plain).not.toContain("<img");
    expect(plain).toContain("<svg");
  });

  it("keeps the logo's place while it loads, and the Inbox mark ready for a wide one where the rail is icons only", () => {
    const waiting = head({ ...square, url: null, waiting: true });
    expect(waiting).toContain('<span class="rail-logo is-waiting" style="aspect-ratio:96 / 96"></span>');
    expect(waiting).not.toContain("<svg");
    // A wordmark: the mark is there, shown by the stylesheet only where the rail is icons only.
    const wide = head({ url: "blob:x", waiting: false, width: 360, height: 96 });
    expect(wide).toContain('<img class="rail-logo is-wide" src="blob:x" alt=""/>');
    expect(wide).toContain("rail-mark");
    // A logo that could not be fetched: the Inbox mark, as with none.
    expect(head({ ...square, url: null, waiting: false })).toContain("<svg");
  });
});

describe("the theme switch", () => {
  it("reads System, as it always did, while the business's theme is Standard", () => {
    const html = renderToStaticMarkup(createElement(ThemeSwitch, {}));
    expect(html).toContain('title="System"');
    expect(html).toContain("<span>System</span>");
    expect(html).not.toContain("Auto");
  });
});
