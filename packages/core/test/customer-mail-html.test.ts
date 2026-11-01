import { describe, expect, it } from "vitest";
import { customerHtmlPart, customerMailHtml, mailLogoUrl } from "../src/customer/html";
import { ACCENT_TONES, DEFAULT_LOOK, type Look, logoBox, THEME_TONES } from "../src/look/palette";

/**
 * An email to a customer as HTML, in the business's look: its logo or its name, its words as it wrote
 * them, each link in its accent, always on a light page. Nothing in it runs, loads a font or styles
 * anything beyond itself; a default inbox sends no HTML at all.
 */
const BASE = "https://inbox.example.org";
const FILE = "0123456789abcdef.png";
const look = (o: Partial<Look> = {}): Look => ({ theme: "standard", accent: "teal", logo: null, ...o });
const withLogo = (width: number, height: number, o: Partial<Look> = {}) =>
  look({ logo: { file: FILE, width, height }, ...o });

const TEXT = [
  "Hello Rita,",
  "",
  'We propose Thursday at 10:00 for "Surf lesson".',
  "Price: €45.00",
  "",
  "Accept: https://inbox.example.org/c/AAAA.BBBB",
  "Decline: https://inbox.example.org/c/CCCC.DDDD",
  "",
  "Reference: 4F2K9Q",
  "Our menu is at https://oficinamare.example/menu.",
  "",
  "Oficina Maré",
].join("\n");

const html = (text: string, l: Look, logoUrl: string | null = mailLogoUrl(BASE, l)) =>
  customerMailHtml(text, { business: "Oficina Maré", lang: "en", look: l, logoUrl, subject: "A time for you" });

describe("a customer's email as HTML", () => {
  it("heads it with the logo from the inbox's own address, named for the business, at most 200 × 40", () => {
    const out = html(TEXT, withLogo(400, 80));
    expect(out).toContain(
      `<img src="${BASE}/p/logo/${FILE}" alt="Oficina Maré" width="200" height="40" style="display:block;`,
    );
    expect(html(TEXT, withLogo(120, 240))).toContain('width="20" height="40"');
    // A small one is never made larger.
    expect(html(TEXT, withLogo(32, 24))).toContain('width="32" height="24"');
    expect(logoBox(1000, 100, 200, 40)).toEqual({ width: 200, height: 20 });
  });

  it("heads it with the name, as text, with no address for the logo", () => {
    expect(mailLogoUrl(undefined, withLogo(160, 48))).toBeNull();
    expect(mailLogoUrl("", withLogo(160, 48))).toBeNull();
    expect(mailLogoUrl("javascript:alert(1)", withLogo(160, 48))).toBeNull();
    expect(mailLogoUrl(`${BASE}/`, withLogo(160, 48))).toBe(`${BASE}/p/logo/${FILE}`);
    const out = html(TEXT, withLogo(160, 48), null);
    expect(out).not.toContain("<img");
    expect(out).toContain(">Oficina Maré</span>");
  });

  it("makes each answer link a thin outlined button in the accent, and other addresses links", () => {
    const teal = ACCENT_TONES.teal.day;
    const out = html(TEXT, look());
    expect(out).toContain(
      `<a href="https://inbox.example.org/c/AAAA.BBBB" style="display:inline-block;padding:8px 14px;border:1px solid ${teal};border-radius:6px;color:${teal};font-weight:500;text-decoration:none">Accept</a>`,
    );
    expect(out).toContain(">Decline</a>");
    // An address in a sentence is a link, without the full stop after it.
    expect(out).toContain(
      `Our menu is at <a href="https://oficinamare.example/menu" style="color:${teal};text-decoration:underline">https://oficinamare.example/menu</a>.`,
    );
    // A label with a value that is not a link stays a line of text.
    expect(out).toContain("Price: €45.00");
    // The French way of writing it, with its no-break space before the colon, is a button too.
    expect(html("Accepter\u00a0: https://inbox.example.org/c/EEEE.FFFF", look())).toContain(">Accepter</a>");
  });

  it("keeps the business's words as written: paragraphs, line breaks, and markup shown as text", () => {
    const out = html('Hi,\nsee <script>alert("x")</script> & more\n\n\nBye', look());
    expect(out).toContain(
      '<p style="margin:0 0 14px">Hi,<br>see &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more</p>',
    );
    expect(out).toContain('<p style="margin:0 0 14px">Bye</p>');
    expect(out).not.toContain("<script");
    // A name with markup in it, as the alt and the header, is text.
    expect(
      customerMailHtml("Hi", {
        business: 'A"B <i>',
        lang: "en",
        look: withLogo(40, 40),
        logoUrl: `${BASE}/p/logo/${FILE}`,
      }),
    ).toContain('alt="A&quot;B &lt;i&gt;"');
  });

  it("is always light: Dark sends a white page, Warm its off-white, each with its day accent", () => {
    const dark = html(TEXT, look({ theme: "dark", accent: "plum" }));
    expect(dark).toContain('<body style="margin:0;padding:0;background:#ffffff;color:#111111">');
    expect(dark).toContain(`border:1px solid ${ACCENT_TONES.plum.day}`);
    expect(dark).not.toContain(THEME_TONES.dark.bg);
    expect(dark).toContain('<meta name="color-scheme" content="light only">');
    const warm = html(TEXT, look({ theme: "warm", accent: "ink" }));
    expect(warm).toContain(`background:${THEME_TONES.warm.bg};color:${THEME_TONES.warm.fg}`);
    // Ink is the theme's own ink.
    expect(warm).toContain(`border:1px solid ${THEME_TONES.warm.fg}`);
  });

  it("styles nothing beyond itself, runs nothing, and stays well under a mail app's clipping", () => {
    const long = Array.from({ length: 200 }, (_, i) => `Line ${i}: a few words of the business's own.`).join("\n");
    const out = html(`${TEXT}\n\n${long}`, withLogo(160, 48, { theme: "minimal" }));
    expect(out).not.toMatch(/<style|<script|@import|<link/i);
    expect(new TextEncoder().encode(out).byteLength).toBeLessThan(100 * 1024);
  });

  it("is sent only once the business chose a look", () => {
    const o = { business: "Oficina Maré", lang: "en", base: BASE, subject: "Hi" };
    expect(customerHtmlPart(TEXT, DEFAULT_LOOK, o)).toEqual({});
    expect(customerHtmlPart(TEXT, look({ accent: "ink", theme: "warm" }), o).html).toContain("<!doctype html>");
    expect(customerHtmlPart(TEXT, withLogo(160, 48, { accent: "ink" }), o).html).toContain(`/p/logo/${FILE}`);
  });
});
