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
  label: "€90 · Colour correction",
  amount: { value: 9000, currency: "EUR" },
  service: "Colour correction",
};
const sheet = (c: PriceChip | null, o: { quantity?: number; validHours?: number } = {}) =>
  createElement(PriceSheet, {
    what: "Colour correction",
    chip: c,
    currency: "EUR",
    busy: false,
    tz: "Europe/Lisbon",
    onClose: () => undefined,
    onSend: () => undefined,
    ...o,
  });

describe("the price sheet", () => {
  it("opens with the price a chip gave, and an optional note", () => {
    const html = draw(sheet(chip));
    expect(html).toContain("Send a price");
    expect(html).toContain("For Colour correction");
    expect(html).toContain("Price, in EUR");
    expect(html).toContain('value="90.00"');
    expect(html).toContain("Note (optional)");
    expect(html).toContain('placeholder="Anything they should know"');
    expect(html).toContain("Send · €90");
    expect(html).toContain("They can accept it, or their assistant can for them.");
    // Two fields: the amount and the note. Nothing to copy from elsewhere.
    expect(html.match(/<input/g)).toHaveLength(2);
    expect(html).toContain('inputMode="decimal"');
    // A dialog that says what it is.
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="price-sheet-h"');
  });

  it("says a from price is the least the list asks, and until when the price holds", () => {
    const html = draw(sheet({ ...chip, label: "From €90 · Colour correction", from: true }, { validHours: 48 }));
    expect(html).toContain("Your list says from €90: the least it costs.");
    expect(html).toMatch(/They can accept it until \w{3}, .+ \d{2}:\d{2}, or their assistant can for them\./);
  });

  it("prices every one asked for", () => {
    const html = draw(
      sheet(
        {
          ...chip,
          amount: { value: 27000, currency: "EUR" },
          each: { quantity: 3, price: { value: 9000, currency: "EUR" } },
        },
        { quantity: 3 },
      ),
    );
    expect(html).toContain("For 3 × Colour correction · 3 × €90");
    expect(html).toContain('value="270.00"');
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
    // A draft with its own words to the customer is read in full first; one without, sent as it is.
    expect(source).toMatch(
      /onSend=\{\(d\) => \(d\.terms\.notes\?\.trim\(\) \? setReview\(d\) : press\(\{ kind: "draft", draftId: d\.id \}\)\)\}/,
    );
    const review = source.slice(source.indexOf("<DraftReview"), source.indexOf("/>", source.indexOf("<DraftReview")));
    expect(review).toContain('press({ kind: "draft", draftId: d.id })');
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

  it("asks before keeping a typed reply, only for a message, and only for words of nobody's", () => {
    const send = source.slice(source.indexOf("const sendReply = async"), source.indexOf("const keepReply = async"));
    expect(send).toMatch(/item\.type === "message" &&\s+app\.replies &&\s+offerToSave\(typed, tracesOf\(detail\)\) &&/);
    expect(send).toContain("setAskSave(typed)");
    expect(source).toContain("Save as a quick reply?");
    // The Undo toast shows every word that goes.
    expect(source).toContain(["return `Sending “$", "{p.text}”`;"].join(""));
  });

  it("shows a draft's every term, and its words to the customer in full before it goes", () => {
    const card = source.slice(source.indexOf("function DraftCard("), source.indexOf("function useSheetFocus("));
    expect(card).toContain("draftDetails(d.terms, p.tz, d.created_at)");
    expect(card).toContain("Send as it is");
    expect(card).toContain("Read it and send");
    const review = source.slice(source.indexOf("function DraftReview("), source.indexOf("export function PriceSheet("));
    expect(review).toContain("Its words to the customer, which no person here wrote:");
    expect(review).toContain("{d.terms.notes.trim()}");
  });
});
