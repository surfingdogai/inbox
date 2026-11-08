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
const VERIFY = `https://my.dominios.pt/modules/addons/domain_contact_verification/public/verify.php?action=verify&token=${"9f3c1a7e".repeat(8)}&lang=portuguese-pt`;

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
      .replaceAll("\u2060", ""),
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
    // The full stop after it stays text.
    expect(textOf(html)).toBe(`Please confirm: ${VERIFY}. Thanks`);
  });

  it("shows its host, then a short path, and keeps the whole address in the text for a copy", () => {
    const html = render(`Confirm here: ${VERIFY}`);
    const [a = ""] = anchors(html);
    expect(a).toContain('<span class="msg-link-host">my.dominios.pt</span>');
    expect(shownOf(a)).toBe("my.dominios.pt/modules/addons/…/verify.php?…");
    // An ellipsis holds on to what follows it: the line wraps before a "/" instead.
    expect(a).toContain('data-as="?…\u2060"');
    expect(a.match(/<wbr\/>/g)?.length).toBeGreaterThan(0);
    expect(textOf(a)).toBe(VERIFY);
    expect(shownOf(html)).toBe(`Confirm here: ${linkDisplay(VERIFY)}`);
  });

  it("draws the host the link reaches where the written one could pass for another", () => {
    const html = render("Log in: https://www.paypal.com@evil.example/login");
    expect(shownOf(html)).toBe("Log in: evil.example/login");
    expect(textOf(html)).toBe("Log in: https://www.paypal.com@evil.example/login");
    expect(html).toContain('data-as="evil.example"');
  });

  it("is never made of what is not http(s), and what the sender wrote stays text", () => {
    const html = render('javascript:alert(1) <img src=x onerror=alert(1)> "quoted"');
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<img");
    expect(textOf(html)).toBe('javascript:alert(1) <img src=x onerror=alert(1)> "quoted"');
  });
});

describe("the links an email carried", () => {
  const text = `Your invoice is ready.\n\n${LINKS_HEADING}\n${VERIFY}\nhttps://www.dominios.pt/faturas/2026-118.pdf`;

  it("are a small titled list under its words, each its host and short path, opening in a new tab", () => {
    const html = render(text);
    expect(html).toContain(
      '<div class="msg-links"><div class="msg-links-title">Links in this email</div><ul class="msg-links-list">',
    );
    expect(html.match(/<li class="msg-links-item">/g)).toHaveLength(2);
    const links = anchors(html);
    expect(links).toHaveLength(2);
    expect(links.map(shownOf)).toEqual([
      "my.dominios.pt/modules/addons/…/verify.php?…",
      "www.dominios.pt/faturas/2026-118.pdf",
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
    expect(copied).toContain("https://www.dominios.pt/faturas/2026-118.pdf");
    expect(copied.startsWith("Your invoice is ready.")).toBe(true);
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
