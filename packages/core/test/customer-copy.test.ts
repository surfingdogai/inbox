import { describe, expect, it } from "vitest";
import { COPY, copyFor, vars } from "../src/customer/copy";
import { statusSentence } from "../src/customer/describe";
import { moneyIn, shortRef, whenText, zoneName } from "../src/customer/format";
import { customerLang, langFromHeader } from "../src/customer/lang";
import type { Item } from "../src/domain/types";

/**
 * Every word the business says to a customer, in every language it writes: the business's voice,
 * and nothing else's. A customer wrote to the business; the software, a network, an offer, a key or
 * an id have no place in what they read. Runs on Node and in workerd, whose Intl data differ.
 */
const SAMPLE = vars({
  what: '"Full service"',
  when: "Wednesday, 23 September 2026 at 14:00 (Western European Time)",
  newWhen: "Thursday, 24 September 2026 at 10:00 (Western European Time)",
  deadline: "Wednesday, 23 September 2026 at 13:00 (Western European Time)",
  total: "€45.00",
  validThrough: "Monday, 28 September 2026 at 19:00 (Western European Time)",
  ref: "7K3QXA",
  zone: "Western European Time",
  question: "Which bike is it?",
  status: "Your booking is confirmed.",
  summary: "Our quote: €45.00.",
  priceLine: "Price: €45.00.",
  yourNoun: "your booking",
  business: "Oficina Maré",
  name: "Rita",
  askedWhen: "Wednesday, 23 September 2026 at 09:00 (Western European Time)",
  cutoff: "Tuesday, 22 September 2026 at 14:00 (Western European Time)",
  amount: "€45.00",
  url: "https://pay.example/1",
  subject: "Full service",
  code: "482913",
  minutes: "10",
});

/** Every string the copy holds, every function called with the sample, recursively. */
function strings(value: unknown, path = ""): { path: string; text: string }[] {
  if (typeof value === "string") return [{ path, text: value }];
  if (typeof value === "function") {
    const out = (value as (v: unknown) => unknown)({ ...SAMPLE, phrase: "is confirmed", booking: true });
    return strings(out, path);
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  }
  return [];
}

const FORBIDDEN_EN = [
  /surfing/i,
  /\binbox\b/i,
  /network/i,
  /\bpass\b/i,
  /\bkey\b/i,
  /receipt/i,
  /\boffer/i,
  /the business/i,
];
const FORBIDDEN_PT = [/surfing/i, /\binbox\b/i, /\brede\b/i, /\bpasse\b/i, /\bchave\b/i, /recibo/i, /\boferta/i];
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;

describe("the customer's words", () => {
  for (const lang of ["en", "pt"] as const) {
    it(`in ${lang}: every entry is the business speaking, and names nothing else`, () => {
      const all = strings(COPY[lang]);
      expect(all.length).toBeGreaterThan(150);
      for (const { path, text } of all) {
        expect(text.trim().length, path).toBeGreaterThan(0);
        for (const word of lang === "en" ? FORBIDDEN_EN : FORBIDDEN_PT)
          expect(text, `${path}: ${text}`).not.toMatch(word);
        expect(text, path).not.toMatch(ULID);
      }
    });
  }

  it("has the same entries in every language", () => {
    // Portuguese says some states twice, once for each gender.
    const keys = (lang: "en" | "pt") =>
      [...new Set(strings(COPY[lang]).map((s) => s.path.replace(/\.(f|m)$/, "")))].sort();
    expect(keys("pt")).toEqual(keys("en"));
  });

  it("names the zone with every time, and writes money and references the customer's way", () => {
    const at = "2026-10-01T09:00:00Z";
    expect(whenText(at, "Europe/Lisbon", "en")).toMatch(/1 October 2026 at 10:00 \(.+\)$/);
    expect(whenText(at, "Europe/Lisbon", "pt")).toMatch(/1 de outubro de 2026,? às 10:00 \(.+\)$/);
    expect(whenText(at, "UTC", "en")).toMatch(/\(UTC\)$/);
    expect(whenText(at, "Not/AZone", "en")).toMatch(/\(UTC\)$/);
    expect(zoneName("Europe/Lisbon", "en").length).toBeGreaterThan(2);
    expect(zoneName("Europe/Lisbon", "pt").charAt(0)).toBe(zoneName("Europe/Lisbon", "pt").charAt(0).toLowerCase());
    expect(moneyIn({ value: 4550, currency: "EUR" }, "en")).toBe("€45.50");
    expect(moneyIn({ value: 4550, currency: "EUR" }, "pt").replace(/\s/g, " ")).toBe("45,50 €");
    expect(shortRef("01K5ABCDEFGHJKMNPQRSTVWXYZ")).toBe("TVWXYZ");
  });

  it("picks the customer's language, else the business's first, else English", () => {
    expect(customerLang("pt-PT", ["en"])).toBe("pt");
    expect(customerLang(null, ["pt", "en"])).toBe("pt");
    expect(customerLang("de", ["fr", "en"])).toBe("en");
    expect(customerLang(undefined, [])).toBe("en");
    expect(langFromHeader("pt-BR,pt;q=0.9,en;q=0.8")).toBe("pt");
    expect(langFromHeader("de-DE, en;q=0.5")).toBe("en");
    expect(langFromHeader("de-DE")).toBeNull();
  });

  it("says every state of every item without an id, and with the zone for a booking", () => {
    const base = {
      id: "01K5ABCDEFGHJKMNPQRSTVWXYZ",
      version: 1,
      partyId: "p",
      locationId: null,
      channel: "rest",
      subject: "Full service",
      flags: { needsHuman: false, sandbox: false, priority: 0 },
      linkedItemId: null,
      createdAt: "2026-09-21T10:00:00Z",
      updatedAt: "2026-09-21T10:00:00Z",
      closedAt: null,
    };
    const payloads: Record<string, unknown> = {
      booking: {
        reservationFor: { serviceId: "s", name: "Full service" },
        startTime: "2026-09-23T13:00:00Z",
        endTime: "2026-09-23T14:30:00Z",
        proposed: { startTime: "2026-09-24T13:00:00Z", endTime: "2026-09-24T14:30:00Z" },
      },
      order: {
        orderedItem: [{ name: "Saddle", quantity: 1, price: { value: 100, currency: "EUR" } }],
        totalPrice: { value: 100, currency: "EUR" },
      },
      quote_request: {
        itemOffered: { name: "Wheel" },
        description: "x",
        quote: {
          totalPrice: { value: 100, currency: "EUR" },
          validThrough: "2026-09-28T00:00:00Z",
          lines: [],
          creates: "order",
        },
      },
      message: { text: "hi" },
      refund: { orderItemId: "o", amount: { value: 100, currency: "EUR" }, reason: "x" },
    };
    const states: Record<string, string[]> = {
      booking: [
        "requested",
        "needs_info",
        "proposed",
        "confirmed",
        "completed",
        "no_show",
        "cancelled_by_customer",
        "cancelled_by_business",
        "declined",
        "expired",
      ],
      order: [
        "received",
        "needs_info",
        "accepted",
        "awaiting_payment",
        "payment_failed",
        "paid",
        "fulfilling",
        "fulfilled",
        "completed",
        "declined",
        "cancelled",
        "charged_back",
      ],
      quote_request: ["received", "needs_info", "quoted", "accepted", "declined", "expired"],
      message: ["open", "answered", "closed", "spam"],
      refund: ["requested", "approved", "rejected", "refunded"],
    };
    for (const lang of ["en", "pt"] as const) {
      for (const [type, list] of Object.entries(states)) {
        for (const state of list) {
          const item = { ...base, type, state, payload: payloads[type] } as unknown as Item;
          const text = statusSentence(item, { lang, timezone: "Europe/Lisbon", minNoticeMin: 0 });
          expect(text, `${lang} ${type} ${state}`).not.toMatch(ULID);
          expect(text, `${lang} ${type} ${state}`).not.toContain("_");
          expect(text, `${lang} ${type} ${state}`).toContain(
            lang === "en" ? "Reference TVWXYZ." : "Referência TVWXYZ.",
          );
          if (type === "booking") expect(text, `${lang} ${state}`).toMatch(/\(.+\)/);
          for (const word of lang === "en" ? FORBIDDEN_EN : FORBIDDEN_PT) expect(text).not.toMatch(word);
        }
      }
    }
  });

  it("asks the assistant, and only the assistant, to confirm in English", () => {
    expect(copyFor("pt").labels.accept).toBe("Aceitar");
    expect(copyFor("en").page.acceptTime.buttonPriced).toBe("Order with obligation to pay");
    expect(copyFor("pt").page.acceptTime.buttonPriced).toBe("Encomenda com obrigação de pagar");
  });
});
