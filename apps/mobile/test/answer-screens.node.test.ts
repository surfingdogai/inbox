import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../../../packages/core/src/phones/prefs";
import { type App, AppContext } from "../src/context";
import type { PriceChip } from "../src/lib/chips";
import { PriceSheet } from "../src/screens/Item";
import { Settings } from "../src/screens/Settings";

/**
 * The screens of answering fast (ADR-028 Amendment 5), drawn as the app first draws them: the price
 * sheet, Settings → Answers, and the item screen's one-tap answers, which wait for Undo like any press.
 */
const app = (o: Partial<App> = {}) =>
  ({
    native: { platform: "android" },
    me: {
      phone: { id: "d1", name: "Pixel 8", push: "on", confirmed: true },
      notify: DEFAULT_PREFS,
      business: { name: "Oficina Maré", timezone: "Europe/Lisbon" },
      push_available: true,
    },
    active: { alias: "ib_1", origin: "https://inbox.oficinamare.pt", name: "Oficina Maré", deviceId: "d1", addedAt: 0 },
    client: null,
    spam: null,
    demo: false,
    appInfo: null,
    update: { kind: "none" },
    replies: { list: async () => [] },
    go: () => undefined,
    ...o,
  }) as unknown as App;

const draw = (el: ReturnType<typeof createElement>, value: App = app()) =>
  renderToString(createElement(AppContext.Provider, { value }, el)).replace(/<!-- -->/g, "");

const chip: PriceChip = {
  serviceId: "colour",
  label: "From €90 · Colour correction",
  amount: { value: 9000, currency: "EUR" },
  service: "Colour correction",
};
const sheet = (c: PriceChip | null) =>
  createElement(PriceSheet, {
    what: "Colour correction",
    chip: c,
    currency: "EUR",
    busy: false,
    onClose: () => undefined,
    onSend: () => undefined,
  });

describe("the price sheet", () => {
  it("opens with the price a chip gave, and an optional note", () => {
    const html = draw(sheet(chip));
    expect(html).toContain("Send a price");
    expect(html).toContain("For Colour correction");
    expect(html).toContain("Price, in EUR");
    expect(html).toContain('value="90.00"');
    expect(html).toContain("Note (optional)");
    expect(html).toContain("Send · €90");
    expect(html).toContain("They can accept it, or their assistant can for them.");
    // Two fields: the amount and the note. Nothing to copy from elsewhere.
    expect(html.match(/<input/g)).toHaveLength(2);
    expect(html).toContain('inputMode="decimal"');
  });

  it("says how a price per person was worked out", () => {
    const html = draw(
      sheet({
        serviceId: "tasting",
        label: "€12 a person · Tasting menu",
        amount: { value: 4800, currency: "EUR" },
        service: "Tasting menu",
        each: { quantity: 4, price: { value: 1200, currency: "EUR" } },
      }),
    );
    expect(html).toContain("For Colour correction · 4 × €12");
    expect(html).toContain('value="48.00"');
  });

  it("asks for an amount when no chip gave one, and sends nothing without it", () => {
    const html = draw(sheet(null));
    expect(html).toContain('value=""');
    expect(html).toMatch(/<button type="button" class="btn primary" disabled="">Send<\/button>/);
  });
});

describe("Settings → Answers", () => {
  it("lists the owner's quick replies, kept on this phone, for the inbox in front", () => {
    const html = draw(createElement(Settings));
    expect(html).toContain(">Answers<");
    expect(html).toContain("No quick replies yet");
    expect(html).toContain("Quick replies stay on this phone, for Oficina Maré. They go only when you tap one.");
  });

  it("has none in the demo, which keeps nothing on the phone", () => {
    const html = draw(createElement(Settings), app({ demo: true, replies: null }));
    expect(html).not.toContain(">Answers<");
  });
});

describe("the item screen's one-tap answers", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "../src/screens/Item.tsx"), "utf8");

  it("send a quick reply, a price and a draft through the six seconds' Undo, never at once", () => {
    expect(source).toMatch(/onClick=\{\(\) => press\(\{ kind: "reply", text: c\.text \}\)\}/);
    expect(source).toMatch(/onSend=\{\(d\) => press\(\{ kind: "draft", draftId: d\.id \}\)\}/);
    const priced = source.slice(source.indexOf("<PriceSheet"), source.indexOf("/>", source.indexOf("<PriceSheet")));
    expect(priced).toMatch(/press\(\{ kind: "offer", input: priceOffer\(amount, note\), amount \}\)/);
    expect(priced).not.toContain("app.act(");
    // The sheet itself sends nothing: it hands its amount and note back.
    const sheetCode = source.slice(
      source.indexOf("export function PriceSheet"),
      source.indexOf("/** Propose another time"),
    );
    expect(sheetCode).not.toMatch(/useApp\(|\.act\(|client\./);
  });

  it("sends what waited through the outbox, under the key it is kept with", () => {
    const send = source.slice(source.indexOf("const send = async (p: Press)"), source.indexOf("const act = p.act;"));
    expect(send).toContain('a.act(d.item.id, "reply"');
    expect(send).toMatch(/a\.act\(\s*d\.item\.id,\s*"offer"/);
    expect(send).toContain('a.act(d.item.id, "draft"');
  });

  it("asks before keeping a typed reply, and only for a message", () => {
    const send = source.slice(source.indexOf("const sendReply = async"), source.indexOf("const keepReply = async"));
    expect(send).toMatch(
      /item\.type === "message" && app\.replies && !\(await app\.replies\.has\(typed\)\)\) setAskSave\(typed\)/,
    );
    expect(source).toContain("Save as a quick reply?");
  });
});
