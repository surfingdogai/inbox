import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WhyHere } from "../client/src/components/SpamWhy";
import type { ItemDetail } from "../client/src/lib/types";

/**
 * Why it's here, rendered (ADR-029 §11.2): the passages the code found in a message are the sender's
 * words, and they reach the page as text, whatever they hold.
 */
function detail(spam: Partial<NonNullable<ItemDetail["spam"]>>): ItemDetail {
  return {
    item: { id: "i1", type: "message", state: "spam", payload: { text: "x" } },
    transitions: [{ event: "unspam", label: "Not spam" }],
    spam: {
      screen: "aside",
      verdict: "aside",
      chip: "Sales pitch",
      cause: "pitches",
      may_be_customer: false,
      certain: false,
      sender: { address: "a@example.org", company_domain: null, app: false },
      reasons: ["Sales pitch: SEO.", "It holds many links."],
      quotes: [],
      by: "ai_check",
      learning: false,
      released_by: null,
      at: "2026-10-26T09:00:00Z",
      ...spam,
    },
  } as unknown as ItemDetail;
}

const render = (d: ItemDetail) =>
  renderToStaticMarkup(createElement(WhyHere, { view: d, tz: "UTC", acts: ["not_spam"], onAct: () => undefined }));

describe("Why it's here, on the page", () => {
  it("shows a quote holding markup as text, never as markup", () => {
    const html = render(detail({ quotes: ['<script>alert("x")</script><img src=x onerror=alert(1)>'] }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("It says: “&lt;script&gt;");
  });

  it("leads with the strongest reason, the rest a tap away, then who decided and the one press", () => {
    const html = render(detail({}));
    expect(html).toContain("Why it&#x27;s here");
    expect(html).toContain("Sales pitch: SEO.");
    expect(html).toContain("and 1 more");
    expect(html).not.toContain("It holds many links.");
    expect(html).toContain("by the AI check");
    expect(html).toContain(">Not spam<");
  });

  it("says the sender confirmed it's them", () => {
    const html = render(detail({ screen: "released", released_by: "sender", reasons: ["Sales pitch: SEO."] }));
    expect(html).toContain("Confirmed by the sender");
    expect(html).toContain("The sender confirmed it&#x27;s them. Sales pitch: SEO.");
  });
});
