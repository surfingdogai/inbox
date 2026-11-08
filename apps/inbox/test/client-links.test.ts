import { LINKS_HEADING as SERVER_HEADING } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  domainAt,
  LINK_ROOM,
  LINKS_HEADING,
  linkDisplay,
  linkName,
  linkParts,
  linkRuns,
  linksToList,
  splitLinksBlock,
} from "../client/src/lib/links";

/** A domain registrar's contact verification link, as its email carries it (the token made up). */
const VERIFY = `https://my.example.pt/modules/addons/domain_contact_verification/public/verify.php?action=verify&token=${"9f3c1a7e".repeat(8)}&lang=portuguese-pt`;

describe("linkParts", () => {
  it("makes each http(s) link its own part, written as it is, and keeps the rest as text", () => {
    const text = "Links in this email:\nhttps://claude.example/magic-link?t=abc&s=1\nhttp://shop.example/a.";
    expect(linkParts(text)).toEqual([
      { at: 0, text: "Links in this email:\n" },
      {
        at: 21,
        text: "https://claude.example/magic-link?t=abc&s=1",
        href: "https://claude.example/magic-link?t=abc&s=1",
      },
      { at: 64, text: "\n" },
      { at: 65, text: "http://shop.example/a", href: "http://shop.example/a" },
      { at: 86, text: "." },
    ]);
  });

  it("leaves anything that is not http(s) as text", () => {
    expect(linkParts("javascript:alert(1) mailto:a@b.example ftp://x.example")).toEqual([
      { at: 0, text: "javascript:alert(1) mailto:a@b.example ftp://x.example" },
    ]);
    expect(linkParts("")).toEqual([]);
    expect(linkParts("see (https://a.example/x)")).toEqual([
      { at: 0, text: "see (" },
      { at: 5, text: "https://a.example/x", href: "https://a.example/x" },
      { at: 24, text: ")" },
    ]);
  });

  it("leaves an address no browser opens as text: never a link drawn from its raw, reversed letters", () => {
    const reversed = "Pay at https://paypal.com\u202e.elpmaxe/ today";
    expect(linkParts(reversed)).toEqual([{ at: 0, text: reversed }]);
    expect(linkParts("https://[::1/ https://exa^mple.com/ https://a.example/ok")).toEqual([
      { at: 0, text: "https://[::1/ https://exa^mple.com/ " },
      { at: 36, text: "https://a.example/ok", href: "https://a.example/ok" },
    ]);
  });
});

describe("a link on screen", () => {
  const LINKS = [
    VERIFY,
    "https://claude.example/magic-link?t=abc&s=1",
    "https://www.paypal.com@evil.example/login",
    "https://\u0430pple.com/account",
    "HTTPS://WWW.Example.COM/Path",
    "https://a.example:443/x",
    "https://my.example.pt/",
    "https://example.com/a/b/c?utm_source=newsletter&utm_medium=email&utm_campaign=autumn-sale-2026",
    "https://app.example.com/auth/reset/3f9a8c7e6d5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f",
    "https://files.example.com/d/invoice-2026-11-oficina-mare-final-version.pdf",
    "https://files.example.com/d/a-long-token-like-last-part-that-ends-in-a-slash/",
    "https://example.com/#/very/long/single/page/route/that/goes/on/and/on/and/on",
    "https://evil.example/\u202emoc.elgoog/x",
    "https://a-very-long-subdomain.another-long-part.example.co.uk/path/to/the/invoice.pdf?x=1",
    "https://docs.example.org/guides/getting-started/installation/linux/ubuntu/",
    "https://example.com\\@evil.example/",
    "http://[::1]:8080/a",
    "https://",
    "https://my.example.pt.account-verify-security-session-refresh.evil-example.net/clientarea.php",
    "https://login.microsoftonline.com.secure-signin.example.net/common/oauth2",
    "https://evil.example\\@paypal.com/",
    "https://evil.example?@paypal.com",
    "https://evil.example/@paypal.com/login",
    "https:///evil.example/",
    "https:///evil.example/login?x=1",
    "https://www.portaldasfinancas.gov.pt/pt/main.jsp",
    "https://192.168.1.20:8443/admin",
  ];

  it("keeps the whole link, as written, in its pieces: a copy of the message holds every address", () => {
    for (const href of LINKS)
      expect(
        linkRuns(href)
          .map((r) => r.text)
          .join(""),
        href,
      ).toBe(href);
  });

  it("shows a registrar's verification link by its host, then a path shortened in the middle", () => {
    expect(linkDisplay(VERIFY)).toBe("my.example.pt/modules/addons/…/verify.php?…");
    const runs = linkRuns(VERIFY);
    expect(runs[0]).toEqual({ text: "https://", hidden: true });
    // The names before its domain plain, the domain its owner registered bold.
    expect(runs[1]).toEqual({ text: "my.", host: "sub" });
    expect(runs[2]).toEqual({ text: "example.pt", host: "domain" });
    expect(runs.find((r) => r.shows === "/…")?.text).toBe("/domain_contact_verification/public");
    expect(runs.at(-1)).toEqual({
      text: VERIFY.slice(VERIFY.indexOf("?")),
      hidden: true,
      shows: "?…",
    });
  });

  it("shows a short link as written, without its scheme", () => {
    expect(linkDisplay("https://claude.example/magic-link?t=abc&s=1")).toBe("claude.example/magic-link?t=abc&s=1");
    expect(linkDisplay("http://shop.example/a")).toBe("shop.example/a");
    expect(linkDisplay("https://my.example.pt/")).toBe("my.example.pt");
    expect(linkDisplay("https://shop.example/a/b/")).toBe("shop.example/a/b/");
    expect(linkDisplay("HTTPS://WWW.Example.COM/Path")).toBe("WWW.Example.COM/Path");
    expect(linkDisplay("http://[::1]:8080/a")).toBe("[::1]:8080/a");
  });

  it("never hides the host, and never shows one that is not where the link goes", () => {
    // A name before an "@" is not the host: the host reached is shown, and the rest never.
    expect(linkDisplay("https://www.paypal.com@evil.example/login")).toBe("evil.example/login");
    // Letters that look like others: the host as the browser reaches it.
    expect(linkDisplay("https://\u0430pple.com/account")).toBe("xn--pple-43d.com/account");
    expect(linkDisplay("https://a.example:443/x")).toBe("a.example/x");
    // A path that turns the text around, or hides characters, is never drawn.
    expect(linkDisplay("https://evil.example/\u202emoc.elgoog/x")).toBe("evil.example/…");
    // A long host is shown whole, however long: only the path gives way.
    expect(
      linkDisplay("https://a-very-long-subdomain.another-long-part.example.co.uk/path/to/the/invoice.pdf?x=1"),
    ).toBe("a-very-long-subdomain.another-long-part.example.co.uk/…/invoice.pdf?…");
    for (const href of [VERIFY, "https://www.paypal.com@evil.example/login", "https://\u0430pple.com/account"]) {
      const host = new URL(href).host;
      expect(linkDisplay(href).startsWith(host), href).toBe(true);
    }
  });

  it("draws in bold only the domain its owner registered, so a long host never reads as the one it starts with", () => {
    const bold = (href: string) =>
      linkRuns(href)
        .filter((r) => r.host === "domain")
        .map((r) => (r.hidden ? r.shows : r.text))
        .join("");
    const plain = (href: string) =>
      linkRuns(href)
        .filter((r) => r.host === "sub")
        .map((r) => (r.hidden ? r.shows : r.text))
        .join("");
    const lookalike = "https://my.example.pt.account-verify-security-session-refresh.evil-example.net/clientarea.php";
    expect(bold(lookalike)).toBe("evil-example.net");
    expect(plain(lookalike)).toBe("my.example.pt.account-verify-security-session-refresh.");
    expect(bold("https://login.microsoftonline.com.secure-signin.example.net/common/oauth2")).toBe("example.net");
    expect(bold(VERIFY)).toBe("example.pt");
    expect(bold("https://example.pt/")).toBe("example.pt");
    expect(bold("https://www.paypal.com@evil.example/login")).toBe("evil.example");
    expect(plain("https://www.paypal.com@evil.example/login")).toBe("");
    // Under a country's ending, the names it registers under are part of the domain.
    expect(bold("https://a-very-long-subdomain.another-long-part.example.co.uk/path/to/the/invoice.pdf?x=1")).toBe(
      "example.co.uk",
    );
    expect(bold("https://www.portaldasfinancas.gov.pt/pt/main.jsp")).toBe("portaldasfinancas.gov.pt");
    expect(bold("https://loja.exemplo.com.br/")).toBe("exemplo.com.br");
    expect(bold("https://paypal.com.evil.co.uk/")).toBe("evil.co.uk");
    // Not a country's ending, or a name it does not register under: the last two names, never more.
    expect(bold("https://paypal.uk.com/")).toBe("uk.com");
    expect(bold("https://joao.nome.pt/")).toBe("nome.pt");
    // An address, a name on its own, a port.
    expect(bold("https://192.168.1.20:8443/admin")).toBe("192.168.1.20");
    expect(linkDisplay("https://192.168.1.20:8443/admin")).toBe("192.168.1.20:8443/admin");
    expect(bold("http://[::1]:8080/a")).toBe("[::1]");
    expect(bold("http://localhost:3000/")).toBe("localhost");
    expect(domainAt("www.paypal.com.")).toBe(4);
    expect(domainAt("paypal.com.")).toBe(0);
  });

  it("never draws a path or a query that could be read as the host, nor a path not where the link goes", () => {
    // A "\" is a "/" to the browser: what follows it is the path, never a name before an "@".
    expect(linkDisplay("https://evil.example\\@paypal.com/")).toBe("evil.example/…");
    expect(linkDisplay("https://example.com\\@evil.example/")).toBe("example.com/…");
    // An "@" before a dotted name, as an address is written.
    expect(linkDisplay("https://evil.example?@paypal.com")).toBe("evil.example?…");
    expect(linkDisplay("https://evil.example#@paypal.com")).toBe("evil.example#…");
    expect(linkDisplay("https://evil.example/@paypal.com/login")).toBe("evil.example/…");
    expect(linkDisplay("https://evil.example/x\uFF20paypal.com")).toBe("evil.example/…");
    expect(linkDisplay("https://shop.example/unsubscribe?email=pat@example.org")).toBe("shop.example/unsubscribe?…");
    // A profile's "@name" is a path like any other.
    expect(linkDisplay("https://mastodon.social/@oficinamare")).toBe("mastodon.social/@oficinamare");
    // No host written before the path: the browser goes to the host drawn, and to its path, not what is written.
    expect(linkDisplay("https:///evil.example/")).toBe("evil.example");
    expect(linkDisplay("https:///evil.example/login?x=1")).toBe("evil.example/…");
  });

  it("is named, on hover and to a screen reader, by the address the browser reaches", () => {
    expect(linkName(VERIFY)).toBe(VERIFY);
    expect(linkName("https://www.paypal.com@evil.example/login")).toBe("https://evil.example/login");
    expect(linkName("https://user:secret@evil.example/")).toBe("https://evil.example/");
    expect(linkName("https://\u0430pple.com/account")).toBe("https://xn--pple-43d.com/account");
    expect(linkName("https:///evil.example/")).toBe("https://evil.example/");
    expect(linkName("HTTPS://WWW.Example.COM/Path")).toBe("https://www.example.com/Path");
    // A path that turns the text around is named as the browser sends it.
    expect(linkName("https://evil.example/\u202emoc.elgoog/x")).toBe("https://evil.example/%E2%80%AEmoc.elgoog/x");
    for (const href of [VERIFY, "https://www.paypal.com@evil.example/login", "https://\u0430pple.com/account"]) {
      expect(linkName(href).startsWith(`https://${linkDisplay(href).split("/")[0]}`), href).toBe(true);
    }
  });

  it("keeps a long path to the room there is: first parts, then the last, a query or fragment folded", () => {
    expect(
      linkDisplay("https://example.com/a/b/c?utm_source=newsletter&utm_medium=email&utm_campaign=autumn-sale-2026"),
    ).toBe("example.com/a/b/c?…");
    expect(linkDisplay("https://docs.example.org/guides/getting-started/installation/linux/ubuntu/")).toBe(
      "docs.example.org/guides/…/ubuntu/",
    );
    expect(linkDisplay("https://example.com/#/very/long/single/page/route/that/goes/on/and/on/and/on")).toBe(
      "example.com/#…",
    );
    // A long last part keeps its start: a token says no more than it must, a file still names its kind.
    expect(linkDisplay("https://app.example.com/auth/reset/3f9a8c7e6d5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f")).toBe(
      "app.example.com/auth/reset/3f9a8c7e6d5b…",
    );
    expect(linkDisplay("https://files.example.com/d/invoice-2026-11-oficina-mare-final-version.pdf")).toBe(
      "files.example.com/d/invoice-2026…sion.pdf",
    );
    expect(
      linkDisplay(
        "https://photos.example.com/share/album/7f3c9a2e1b8d4f6a9c0e2d4b6a8c0e1f?key=Qm9zY2hiaWtlLXBob3Rvcy0yMDI2&ref=email",
      ),
    ).toBe("photos.example.com/share/album/7f3c9a2e1b8d…?…");
    for (const href of LINKS) {
      const host = linkRuns(href)
        .filter((r) => r.host)
        .map((r) => (r.hidden ? (r.shows ?? "") : r.text))
        .join("");
      const room = Math.max(LINK_ROOM, host.length + 40);
      expect(linkDisplay(href).length, href).toBeLessThanOrEqual(room);
    }
  });

  it("shows what is not a link it can read as it is written", () => {
    expect(linkRuns("https://")).toEqual([{ text: "https://" }]);
    expect(linkDisplay("https://")).toBe("https://");
  });
});

describe("the links an email carried", () => {
  it("are found under the heading the server writes, and only there", () => {
    expect(LINKS_HEADING).toBe(SERVER_HEADING);
    const text = `Please confirm your contact details.\n\n${LINKS_HEADING}\n${VERIFY}\nhttps://www.example.pt/`;
    expect(splitLinksBlock(text)).toEqual({
      body: "Please confirm your contact details.",
      links: [VERIFY, "https://www.example.pt/"],
    });
    // An email with no words of its own: the links alone.
    expect(splitLinksBlock(`${LINKS_HEADING}\nhttps://a.example/x`)).toEqual({
      body: "",
      links: ["https://a.example/x"],
    });
  });

  it("are not a message that only names the heading, or anything after it that is not one link a line", () => {
    expect(splitLinksBlock("Hello")).toBeNull();
    expect(splitLinksBlock(`See the ${LINKS_HEADING}\nhttps://a.example/x`)).toBeNull();
    expect(splitLinksBlock(`Hi\n\n${LINKS_HEADING}\nhttps://a.example/x\nand some words`)).toBeNull();
    expect(splitLinksBlock(`Hi\n\n${LINKS_HEADING}\njavascript:alert(1)`)).toBeNull();
    expect(splitLinksBlock(`Hi\n\n${LINKS_HEADING}`)).toBeNull();
    expect(splitLinksBlock(`Hi\n\n${LINKS_HEADING} https://a.example/x`)).toBeNull();
    // A line no browser opens: not the block the inbox writes.
    expect(splitLinksBlock(`Hi\n\n${LINKS_HEADING}\nhttps://paypal.com\u202e.elpmaxe/`)).toBeNull();
    // A heading quoted higher up in a reply: only the last one, at the end, is the block.
    const quoted = `Earlier:\n\n${LINKS_HEADING}\nhttps://old.example/\n\nNew words.\n\n${LINKS_HEADING}\nhttps://new.example/`;
    expect(splitLinksBlock(quoted)?.links).toEqual(["https://new.example/"]);
    expect(splitLinksBlock(quoted)?.body).toContain("https://old.example/");
  });
});

describe("the links listed under an email", () => {
  it("are those its words do not already show, so none is drawn twice", () => {
    const invoice = `A sua fatura está disponível: https://my.example.pt/viewinvoice.php?id=118.\n\n${LINKS_HEADING}\nhttps://my.example.pt/viewinvoice.php?id=118\nhttps://my.example.pt/clientarea.php`;
    const block = splitLinksBlock(invoice);
    expect(block).not.toBeNull();
    expect(linksToList(block ?? { body: "", links: [] })).toEqual(["https://my.example.pt/clientarea.php"]);
    // Every link already in its words: no list at all.
    const all = splitLinksBlock(`See https://a.example/x\n\n${LINKS_HEADING}\nhttps://a.example/x`);
    expect(linksToList(all ?? { body: "", links: ["x"] })).toEqual([]);
    // An email with no words of its own: every link is listed.
    const bare = splitLinksBlock(`${LINKS_HEADING}\nhttps://a.example/x\nhttps://b.example/y`);
    expect(linksToList(bare ?? { body: "", links: [] })).toEqual(["https://a.example/x", "https://b.example/y"]);
  });
});
