import { LINKS_HEADING as SERVER_HEADING } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { LINK_ROOM, LINKS_HEADING, linkDisplay, linkParts, linkRuns, splitLinksBlock } from "../client/src/lib/links";

/** Dominios.PT's own verification link, as its email carried it (the token made up). */
const VERIFY = `https://my.dominios.pt/modules/addons/domain_contact_verification/public/verify.php?action=verify&token=${"9f3c1a7e".repeat(8)}&lang=portuguese-pt`;

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
});

describe("a link on screen", () => {
  const LINKS = [
    VERIFY,
    "https://claude.example/magic-link?t=abc&s=1",
    "https://www.paypal.com@evil.example/login",
    "https://\u0430pple.com/account",
    "HTTPS://WWW.Example.COM/Path",
    "https://a.example:443/x",
    "https://my.dominios.pt/",
    "https://example.com/a/b/c?utm_source=newsletter&utm_medium=email&utm_campaign=autumn-sale-2026",
    "https://app.example.com/auth/reset/3f9a8c7e6d5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f",
    "https://files.example.com/d/invoice-2026-11-oficina-mare-final-version.pdf",
    "https://files.example.com/d/a-long-token-like-last-part-that-ends-in-a-slash/",
    "https://example.com/#/very/long/single/page/route/that/goes/on/and/on/and/on",
    "https://evil.example/‮moc.elgoog/x",
    "https://a-very-long-subdomain.another-long-part.example.co.uk/path/to/the/invoice.pdf?x=1",
    "https://docs.example.org/guides/getting-started/installation/linux/ubuntu/",
    "https://example.com\\@evil.example/",
    "http://[::1]:8080/a",
    "https://",
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

  it("shows Dominios.PT's verification link by its host, then a path shortened in the middle", () => {
    expect(linkDisplay(VERIFY)).toBe("my.dominios.pt/modules/addons/…/verify.php?…");
    const runs = linkRuns(VERIFY);
    expect(runs[0]).toEqual({ text: "https://", hidden: true });
    expect(runs[1]).toEqual({ text: "my.dominios.pt", host: true });
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
    expect(linkDisplay("https://my.dominios.pt/")).toBe("my.dominios.pt");
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
    expect(linkDisplay("https://evil.example/‮moc.elgoog/x")).toBe("evil.example/…");
    // A long host is shown whole, however long: only the path gives way.
    expect(
      linkDisplay("https://a-very-long-subdomain.another-long-part.example.co.uk/path/to/the/invoice.pdf?x=1"),
    ).toBe("a-very-long-subdomain.another-long-part.example.co.uk/…/invoice.pdf?…");
    for (const href of [VERIFY, "https://www.paypal.com@evil.example/login", "https://\u0430pple.com/account"]) {
      const host = new URL(href).host;
      expect(linkDisplay(href).startsWith(host), href).toBe(true);
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
      const host = linkRuns(href).find((r) => r.host);
      const room = Math.max(LINK_ROOM, (host?.shows ?? host?.text ?? "").length + 40);
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
    const text = `Please confirm your contact details.\n\n${LINKS_HEADING}\n${VERIFY}\nhttps://www.dominios.pt/`;
    expect(splitLinksBlock(text)).toEqual({
      body: "Please confirm your contact details.",
      links: [VERIFY, "https://www.dominios.pt/"],
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
    // A heading quoted higher up in a reply: only the last one, at the end, is the block.
    const quoted = `Earlier:\n\n${LINKS_HEADING}\nhttps://old.example/\n\nNew words.\n\n${LINKS_HEADING}\nhttps://new.example/`;
    expect(splitLinksBlock(quoted)?.links).toEqual(["https://new.example/"]);
    expect(splitLinksBlock(quoted)?.body).toContain("https://old.example/");
  });
});
