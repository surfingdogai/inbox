import { describe, expect, it } from "vitest";
import { linkParts } from "../client/src/lib/links";

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
