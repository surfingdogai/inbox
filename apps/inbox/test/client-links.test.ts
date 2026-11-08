import { linksOf } from "@surfingdog/adapters";
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
  trimLink,
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

  it("ends a link where the sentence's punctuation starts: a closing quote or a bracket it did not open is text", () => {
    const hrefs = (text: string) => linkParts(text).flatMap((p) => (p.href ? [p.href] : []));
    // A bracket the link opened is its own.
    expect(hrefs("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    expect(linkParts("(see https://en.wikipedia.org/wiki/Foo_(bar)).")).toEqual([
      { at: 0, text: "(see " },
      { at: 5, text: "https://en.wikipedia.org/wiki/Foo_(bar)", href: "https://en.wikipedia.org/wiki/Foo_(bar)" },
      { at: 44, text: ")." },
    ]);
    expect(hrefs("[https://a.example/x] {https://a.example/y}")).toEqual([
      "https://a.example/x",
      "https://a.example/y",
    ]);
    // Closing quotes, in the languages the inbox reads: never inside the address a link opens.
    expect(linkParts("«https://my.example.pt/clientarea.php»")).toEqual([
      { at: 0, text: "«" },
      { at: 1, text: "https://my.example.pt/clientarea.php", href: "https://my.example.pt/clientarea.php" },
      { at: 37, text: "»" },
    ]);
    for (const [open, close] of [
      ["“", "”"],
      ["‘", "’"],
      ["", "…"],
      ["", "。"],
      ["", "，"],
      ["", "、"],
      ["（", "）"],
      ["「", "」"],
      ["`", "`"],
      ["", "\uFEFF"],
    ]) {
      expect(hrefs(`${open}https://a.example/x${close} next`), close).toEqual(["https://a.example/x"]);
    }
    expect(trimLink("https://a.example/x)].,;:!?'\"")).toBe("https://a.example/x");
  });

  it("finds where a link ends in time that grows with its length, however much punctuation follows it", () => {
    for (const run of [".".repeat(20_000), ")".repeat(20_000), "»".repeat(20_000), ".)".repeat(10_000)]) {
      const started = performance.now();
      expect(linkParts(`https://a.example/${run}x`)).toHaveLength(1);
      expect(linkParts(`see https://a.example/${run}`)[1]?.href).toBe("https://a.example/");
      expect(performance.now() - started, run.slice(0, 2)).toBeLessThan(1_000);
    }
  });

  it("keeps a U+FEFF inside a link: a host it splits is the one host the browser reaches, never a shorter one", () => {
    const hrefs = (text: string) => linkParts(text).flatMap((p) => (p.href ? [p.href] : []));
    const split = "https://secure-login.net\uFEFF.paypal.com/signin";
    expect(hrefs(`Sign in: ${split} today`)).toEqual([split]);
    expect(linkDisplay(split)).toBe("secure-login.net.paypal.com/signin");
    expect(linkName(split)).toBe("https://secure-login.net.paypal.com/signin");
    expect(hrefs("https://login\uFEFF.paypal.com/")).toEqual(["https://login\uFEFF.paypal.com/"]);
    expect(linkDisplay("https://login\uFEFF.paypal.com/")).toBe("login.paypal.com");
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
    expect(linkDisplay("http://[::1]:8080/a")).toBe("[::1]:8080/a");
  });

  it("draws a host written in capitals as the browser reaches it, in small letters: a capital I is never read as an l", () => {
    // `PaypaI.com`, with a capital i, looks like `Paypal.com` in many fonts, and opens paypai.com.
    expect(linkDisplay("https://PaypaI.com/signin")).toBe("paypai.com/signin");
    expect(linkDisplay("HTTPS://WWW.Example.COM/Path")).toBe("www.example.com/Path");
    const runs = linkRuns("https://PaypaI.com/signin");
    expect(runs.filter((r) => r.host).map((r) => (r.hidden ? r.shows : r.text))).toEqual(["", "paypai.com"]);
    // Still copied as written.
    expect(runs.map((r) => r.text).join("")).toBe("https://PaypaI.com/signin");
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

  it("draws a platform's user's name bold with the platform's, so a page of theirs never reads as the platform's own", () => {
    const bold = (host: string) => host.slice(domainAt(host));
    const users = [
      "paypal-login.github.io",
      "apple-id.pages.dev",
      "x.workers.dev",
      "x.vercel.app",
      "x.netlify.app",
      "x.herokuapp.com",
      "x.blogspot.com",
      "x.myshopify.com",
      "x.wixsite.com",
      "x.azurewebsites.net",
      "x.web.app",
      "x.firebaseapp.com",
      "x.appspot.com",
      "x.s3.amazonaws.com",
      "x.cloudfront.net",
      "x.sharepoint.com",
      "x.ngrok-free.app",
    ];
    for (const host of users) expect(bold(host), host).toBe(host);
    expect(bold("paypal.com.secure-login.github.io")).toBe("secure-login.github.io");
    expect(bold("docs.paypal-login.github.io")).toBe("paypal-login.github.io");
    expect(bold("acct.blob.core.windows.net")).toBe("acct.blob.core.windows.net");
    // An S3 bucket's, in any region: its name and the region's endpoint.
    for (const host of [
      "bucket.s3.eu-west-1.amazonaws.com",
      "bucket.s3-eu-west-1.amazonaws.com",
      "bucket.s3.dualstack.eu-west-1.amazonaws.com",
      "bucket.s3-website-us-east-1.amazonaws.com",
      "bucket.s3-website.eu-west-2.amazonaws.com",
      "bucket.s3.cn-north-1.amazonaws.com.cn",
    ]) {
      expect(bold(host), host).toBe(host);
    }
    expect(bold("paypal.com.s3.amazonaws.com")).toBe("com.s3.amazonaws.com");
    // The platform's own: its name alone, and nothing that only ends like one.
    expect(bold("github.io")).toBe("github.io");
    expect(bold("pages.github.io")).toBe("pages.github.io");
    expect(bold("x.amazonaws.com")).toBe("amazonaws.com");
    expect(bold("x.s3x.amazonaws.com")).toBe("amazonaws.com");
    expect(bold("x.s3.amazonaws.com.evil.example")).toBe("evil.example");
    expect(bold("paypal.github.io.evil.example")).toBe("evil.example");
    expect(linkDisplay("https://paypal-login.github.io/signin")).toBe("paypal-login.github.io/signin");
  });

  it("draws three names bold under a country's ending only where it registers domains under the second", () => {
    const bold = (host: string) => host.slice(domainAt(host));
    // No such second level: the second name is the domain, whoever holds the name before it.
    for (const host of [
      "paypal.com.ch",
      "paypal.gov.de",
      "paypal.com.ie",
      "paypal.co.ie",
      "paypal.ltd.eu",
      "paypal.com.ca",
      "paypal.com.be",
      "paypal.co.de",
    ]) {
      expect(bold(host), host).toBe(host.slice("paypal.".length));
    }
    // Where it does: three names.
    for (const host of [
      "x.com.au",
      "x.co.jp",
      "x.co.nz",
      "x.com.mx",
      "x.org.uk",
      "x.ac.uk",
      "x.gov.uk",
      "x.com.br",
      "x.co.za",
      "x.com.tr",
      "x.co.in",
      "x.com.pt",
      "x.gov.pt",
      "x.gob.es",
      "x.gouv.fr",
      "x.go.jp",
      "x.govt.nz",
    ]) {
      expect(bold(`www.${host}`), host).toBe(host);
    }
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
    // Kept before the door trimmed a closing quote: the link its words show, not listed again.
    const kept = splitLinksBlock(
      `Pague em «https://my.example.pt/clientarea.php».\n\n${LINKS_HEADING}\nhttps://my.example.pt/clientarea.php»`,
    );
    expect(linksToList(kept ?? { body: "", links: ["x"] })).toEqual([]);
  });
});

describe("the links the email door keeps of an email's text", () => {
  it("are the links the owner app draws in it, so the list under its words leaves out each one they show", () => {
    const texts = [
      "Pay here: https://my.example.pt/viewinvoice.php?id=118. Thanks!",
      "«https://my.example.pt/clientarea.php» e “https://my.example.pt/cart.php”",
      "See (https://a.example/x), https://en.wikipedia.org/wiki/Foo_(bar) and [https://a.example/y].",
      "'https://a.example/q' `https://a.example/code` https://a.example/it's https://a.example/z…",
      "请看 https://a.example/a。 https://a.example/b， https://a.example/c、 （https://a.example/d） 「https://a.example/e」",
      '<https://a.example/angle> "https://a.example/quoted" https://a.example/x?y=1&z=2#top!',
      `https://a.example/${".".repeat(5_000)}`,
    ];
    for (const text of texts) {
      const drawn = linkParts(text).flatMap((p) => (p.href ? [p.href] : []));
      expect(linksOf({ text }), text.slice(0, 60)).toEqual([...new Set(drawn)]);
      const block = splitLinksBlock(`${text}\n\n${LINKS_HEADING}\n${linksOf({ text }).join("\n")}`);
      expect(block && linksToList(block), text.slice(0, 60)).toEqual([]);
    }
  });

  it("are found in time that grows with an email's length, however much punctuation follows a link", () => {
    const started = performance.now();
    // The first is too long to be an address to open; the second ends where its brackets start.
    const text = `https://a.example/${".".repeat(20_000)}x https://b.example/${")".repeat(20_000)}`;
    expect(linksOf({ text })).toEqual(["https://b.example/"]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
