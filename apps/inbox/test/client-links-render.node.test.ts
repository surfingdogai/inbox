import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Linked } from "../client/src/components/Linked";
import { LINKS_HEADING, linkDisplay } from "../client/src/lib/links";

/**
 * Links in what people wrote, drawn (the founder, 8 November 2026: "make the links look like links
 * with proper ux"): each a link that opens in a new tab, its host on screen, the whole address in
 * the text for a copy, and the links an email carried as a small titled list.
 */
const VERIFY = `https://my.example.pt/modules/addons/domain_contact_verification/public/verify.php?action=verify&token=${"9f3c1a7e".repeat(8)}&lang=portuguese-pt`;

const render = (text: string) => renderToStaticMarkup(createElement(Linked, { text }));
const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
/** The text a copy of it holds: every character in the page, tags left out. */
const textOf = (html: string) => decode(html.replace(/<[^>]*>/g, ""));
/** What the screen shows: the text without what is folded, and what is drawn in its place. */
const shownOf = (html: string) =>
  decode(
    html
      .replace(/<span class="msg-link-gone">[^<]*<\/span>/g, "")
      .replace(/<span class="msg-link-as[^"]*" data-as="([^"]*)">/g, "$1")
      .replace(/<[^>]*>/g, "")
      .replaceAll("\u2060", "")
      .replaceAll("\u200b", ""),
  );
/** What is drawn bold: the domain of each link's host. */
const boldOf = (html: string) =>
  [...html.matchAll(/<span class="(?:msg-link-as )?msg-link-domain[^"]*"(?: data-as="([^"]*)")?>([^<]*)/g)].map((m) =>
    decode(`${m[1] ?? ""}${m[2] ?? ""}`).replaceAll("\u2060", ""),
  );
const anchors = (html: string) => [...html.matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);

describe("a link in a message", () => {
  it("is a link: it opens in a new tab, tells nothing of where it came from, and names its address in full", () => {
    const html = render(`Please confirm: ${VERIFY}. Thanks`);
    const [a] = anchors(html);
    const href = VERIFY.replace(/&/g, "&amp;");
    expect(a).toContain(`href="${href}"`);
    expect(a).toContain('target="_blank"');
    expect(a).toContain('rel="noopener noreferrer nofollow"');
    expect(a).toContain(`title="${href}"`);
    expect(a).toContain(`aria-label="${href}"`);
    expect(a).toContain('class="msg-link"');
    // Left to right, whatever the words around it.
    expect(a).toContain('dir="ltr"');
    // The full stop after it stays text.
    expect(textOf(html)).toBe(`Please confirm: ${VERIFY}. Thanks`);
  });

  it("shows its host, then a short path, and keeps the whole address in the text for a copy", () => {
    const html = render(`Confirm here: ${VERIFY}`);
    const [a = ""] = anchors(html);
    // The names before its domain plain, wrapping after a dot; the domain its owner registered bold, on one line.
    expect(a).toContain(
      '<span class="msg-link-sub"><span class="msg-link-keep">my.</span><wbr/></span><span class="msg-link-domain msg-link-keep">example.pt</span>',
    );
    expect(boldOf(a)).toEqual(["example.pt"]);
    expect(shownOf(a)).toBe("my.example.pt/modules/addons/…/verify.php?…");
    // An ellipsis holds on to what follows it: the line wraps before a "/" instead.
    expect(a).toContain('data-as="?…\u2060"');
    expect(a.match(/<wbr\/>/g)?.length).toBeGreaterThan(0);
    expect(textOf(a)).toBe(VERIFY);
    expect(shownOf(html)).toBe(`Confirm here: ${linkDisplay(VERIFY)}`);
  });

  it("draws the host the link reaches where the written one could pass for another, and is named by it", () => {
    const html = render("Log in: https://www.paypal.com@evil.example/login");
    expect(shownOf(html)).toBe("Log in: evil.example/login");
    expect(textOf(html)).toBe("Log in: https://www.paypal.com@evil.example/login");
    expect(boldOf(html)).toEqual(["evil.example"]);
    // On hover and to a screen reader: where it goes. Its href: exactly as written.
    const [a = ""] = anchors(html);
    expect(a).toContain('href="https://www.paypal.com@evil.example/login"');
    expect(a).toContain('title="https://evil.example/login"');
    expect(a).toContain('aria-label="https://evil.example/login"');
    expect(a).not.toMatch(/(?:title|aria-label)="[^"]*paypal/);
    // Letters that look like others: named in the form the browser reaches.
    const [cyrillic = ""] = anchors(render("https://\u0430pple.com/account"));
    expect(cyrillic).toContain('aria-label="https://xn--pple-43d.com/account"');
    expect(cyrillic).toContain('title="https://xn--pple-43d.com/account"');
    expect(shownOf(cyrillic)).toBe("xn--pple-43d.com/account");
  });

  it("never draws a long host as the one it starts with: its names plain, wrapping after a dot, its domain bold", () => {
    const lookalike = "https://my.example.pt.account-verify-security-session-refresh.evil-example.net/clientarea.php";
    const [a = ""] = anchors(render(`Pague aqui: ${lookalike}`));
    expect(boldOf(a)).toEqual(["evil-example.net"]);
    const sub = a.slice(a.indexOf('<span class="msg-link-sub">'), a.indexOf('<span class="msg-link-domain'));
    // Each name its own piece, a place to wrap after its dot; a name too long for a phone's line may wrap inside.
    expect(sub.match(/<wbr\/>/g)).toHaveLength(4);
    for (const name of ["my.", "example.", "pt."])
      expect(sub).toContain(`<span class="msg-link-keep">${name}</span><wbr/>`);
    expect(sub).toContain("<span>account-verify-security-session-refresh.</span><wbr/>");
    expect(textOf(a)).toBe(lookalike);
    // Drawn in place of a written host: the same, in what CSS draws.
    const [drawn = ""] = anchors(render("https://www.paypal.com.secure-login-session.example.net@evil-example.net/x"));
    expect(boldOf(drawn)).toEqual(["evil-example.net"]);
    expect(drawn).toContain('data-as="evil-\u2060example.\u2060net"');
  });

  it("turns nothing around: a character that reorders text is drawn only inside a folded piece, which CSS isolates", () => {
    // A U+202E in the name before an "@": it opens php.nigol.example, and drawn plain it would read
    // "php.https://paypal.com/elpmaxe.login".
    const spoofs = [
      "https://a\u202e@php.nigol.example/moc.lapyap//:sptth",
      "https://a\u202e@paypal.com/",
      "https://evil.example/\u202emoc.elgoog/x",
      "https://evil.example/?q=\u2067x",
    ];
    const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
    for (const href of spoofs) {
      const [a = ""] = anchors(render(href));
      // Every one is still there for a copy, but only ever inside a folded piece.
      expect(textOf(a), href).toBe(href);
      const unfolded = textOf(a.replace(/<span class="msg-link-gone">[^<]*<\/span>/g, ""));
      expect(unfolded, href).not.toMatch(BIDI);
      expect(shownOf(a), href).not.toMatch(BIDI);
    }
    expect(shownOf(render(spoofs[0] ?? ""))).toBe("php.nigol.example/moc.lapyap//:sptth");
    // A folded piece is its own island to the bidi algorithm, in the owner app and the phone app, and two
    // hyphens are drawn as two (`xn--`), never as the one dash the font's ligature makes of them.
    for (const sheet of ["../client/src/app.css", "../../mobile/src/app.css"]) {
      const css = readFileSync(path.resolve(import.meta.dirname, sheet), "utf8");
      const rule = (selector: string) =>
        css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)));
      expect(rule(".msg-link-gone"), sheet).toContain("unicode-bidi: isolate;");
      expect(rule(".msg-link"), sheet).toContain("font-variant-ligatures: none;");
      expect(rule(".msg-link"), sheet).toContain("unicode-bidi: isolate;");
    }
    expect(shownOf(render("https://xn--pypal-4ve.com/"))).toBe("xn--pypal-4ve.com");
  });

  it("is never made of what is not http(s), and what the sender wrote stays text", () => {
    const html = render('javascript:alert(1) <img src=x onerror=alert(1)> "quoted"');
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<img");
    expect(textOf(html)).toBe('javascript:alert(1) <img src=x onerror=alert(1)> "quoted"');
  });
});

describe("the links an email carried", () => {
  const text = `Your invoice is ready.\n\n${LINKS_HEADING}\n${VERIFY}\nhttps://www.example.pt/faturas/2026-118.pdf`;

  it("are a small titled list under its words, each its host and short path, opening in a new tab", () => {
    const html = render(text);
    // The list is named by its title, as a screen reader's list of lists says it.
    expect(html).toContain(
      '<div class="msg-links"><div class="msg-links-title">Links in this email</div><ul class="msg-links-list" aria-label="Links in this email">',
    );
    expect(html.match(/<li class="msg-links-item">/g)).toHaveLength(2);
    const links = anchors(html);
    expect(links).toHaveLength(2);
    expect(links.map(shownOf)).toEqual([
      "my.example.pt/modules/addons/…/verify.php?…",
      "www.example.pt/faturas/2026-118.pdf",
    ]);
    for (const a of links) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('class="msg-link-out"');
    }
    // The heading's own line is not left in the words.
    expect(shownOf(html).startsWith("Your invoice is ready.Links in this email")).toBe(true);
  });

  it("keep every address whole for a copy, as the plain email has them", () => {
    const html = render(text);
    const copied = textOf(html);
    expect(copied).toContain(VERIFY);
    expect(copied).toContain("https://www.example.pt/faturas/2026-118.pdf");
    expect(copied.startsWith("Your invoice is ready.")).toBe(true);
  });

  it("leave out a link its words already show, and are not drawn when none is left", () => {
    const invoice = `A sua fatura: https://my.example.pt/viewinvoice.php?id=118.\n\n${LINKS_HEADING}\nhttps://my.example.pt/viewinvoice.php?id=118\nhttps://my.example.pt/clientarea.php`;
    const html = render(invoice);
    const links = anchors(html);
    expect(links.map(shownOf)).toEqual(["my.example.pt/viewinvoice.php?id=118", "my.example.pt/clientarea.php"]);
    expect(html.match(/<li class="msg-links-item">/g)).toHaveLength(1);
    // Every address is still in a copy.
    expect(textOf(html)).toContain("https://my.example.pt/viewinvoice.php?id=118");
    expect(textOf(html)).toContain("https://my.example.pt/clientarea.php");
    const once = render(
      `Entregue: https://www.ctt.pt/feapl_2/app/open/objectSearch/objectSearch.jspx?objects=RR1\n\n${LINKS_HEADING}\nhttps://www.ctt.pt/feapl_2/app/open/objectSearch/objectSearch.jspx?objects=RR1`,
    );
    expect(once).not.toContain("msg-links");
    expect(anchors(once)).toHaveLength(1);
  });

  it("are words like any others in a message that only names the heading", () => {
    const html = render(`We put a note: ${LINKS_HEADING} see below\nhttps://a.example/x`);
    expect(html).not.toContain("msg-links");
    expect(anchors(html)).toHaveLength(1);
  });
});

describe("on a phone", () => {
  it("their words are drawn with the owner app's links, which never widen the screen", () => {
    const screen = readFileSync(path.resolve(import.meta.dirname, "../../mobile/src/screens/Item.tsx"), "utf8");
    expect(screen).toContain('import { Linked } from "../../../inbox/client/src/components/Linked";');
    expect(screen).toContain("<Linked text={first} />");
    expect(screen).toContain("<Linked text={t.body} />");
    const css = readFileSync(path.resolve(import.meta.dirname, "../../mobile/src/app.css"), "utf8");
    const bubble = css.slice(css.indexOf(".bubble {"), css.indexOf("}", css.indexOf(".bubble {")));
    expect(bubble).toContain("overflow-wrap: anywhere;");
    for (const rule of [".msg-link {", ".msg-link-gone {", ".msg-link-as::before {", ".msg-links-title {"]) {
      expect(css, rule).toContain(rule);
    }
  });
});
