import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_PRODUCTS,
  decodeXmlText,
  FeedParseError,
  parseAvailability,
  parseDelimited,
  parseFeed,
  parsePrice,
} from "../src/feeds/parse";

describe("parsePrice", () => {
  it("reads the shapes a feed actually writes", () => {
    expect(parsePrice("12.99 EUR", "EUR")).toEqual({ value: 1299, currency: "EUR" });
    expect(parsePrice("EUR 12.99", "GBP")).toEqual({ value: 1299, currency: "EUR" });
    expect(parsePrice("€12,99", "GBP")).toEqual({ value: 1299, currency: "EUR" });
    expect(parsePrice("£9", "EUR")).toEqual({ value: 900, currency: "GBP" });
    expect(parsePrice("9.5", "EUR")).toEqual({ value: 950, currency: "EUR" });
    expect(parsePrice("  7 ", "USD")).toEqual({ value: 700, currency: "USD" });
  });

  it("reads the European decimal comma without turning 1.234,56 into one and a bit", () => {
    expect(parsePrice("1.234,56 EUR", "EUR")).toEqual({ value: 123_456, currency: "EUR" });
    expect(parsePrice("1,234.56 USD", "USD")).toEqual({ value: 123_456, currency: "USD" });
    // Three digits after the separator is a thousands mark, not a fraction.
    expect(parsePrice("1.234", "EUR")).toEqual({ value: 123_400, currency: "EUR" });
    expect(parsePrice("1,234", "EUR")).toEqual({ value: 123_400, currency: "EUR" });
  });

  it("gives no price in a currency not counted in hundredths, as no door here takes one", () => {
    // Yen, won, pesos: no minor unit. Dinars: thousandths, so 12.500 is twelve and a half, not 12,500.
    for (const raw of [
      "500 JPY",
      "¥4,980",
      "1500.00 JPY",
      "₩12000 KRW",
      "15000 CLP",
      "12.500 KWD",
      "1.250 BHD",
      "0.750 BHD",
      "3.500 OMR",
      "7.250 JOD",
    ]) {
      expect(parsePrice(raw, "EUR"), raw).toBeNull();
    }
    // Nor is a bare amount priced in one by default.
    expect(parsePrice("4980", "JPY")).toBeNull();
    // Forints are counted in hundredths, as euros are.
    expect(parsePrice("2500 HUF", "EUR")).toEqual({ value: 250_000, currency: "HUF" });
    expect(parsePrice("2.500,50 HUF", "EUR")).toEqual({ value: 250_050, currency: "HUF" });
  });

  it("gives no price for such a currency written with its own sign, nor reads the sign as the default", () => {
    // Dinars, won, yen and dong by their signs were read as euros or dollars, at a hundred or a
    // thousand times the amount: 12.500 د.ك was €12,500.00.
    for (const [raw, fallback] of [
      ["12.500 د.ك", "EUR"],
      ["1.250 د.ب", "EUR"],
      ["3.500 ر.ع.", "EUR"],
      ["₩12,000", "EUR"],
      ["4,980円", "USD"],
      ["₫50.000", "USD"],
      ["₲ 150.000", "USD"],
    ] as const) {
      expect(parsePrice(raw, fallback), raw).toBeNull();
    }
    // A sign it cannot name is no price either, rather than the business's currency: 99¢ is not €99.
    for (const raw of ["99¢", "₿0.01", "₨ 250", "250 ﷼"]) expect(parsePrice(raw, "EUR"), raw).toBeNull();
    // A currency's own sign is read in that currency.
    expect(parsePrice("₹250.00", "EUR")).toEqual({ value: 25_000, currency: "INR" });
    expect(parsePrice("₺120,00", "EUR")).toEqual({ value: 12_000, currency: "TRY" });
    expect(parsePrice("25.00 د.إ", "EUR")).toEqual({ value: 2_500, currency: "AED" });
    // And a sign several currencies write is the business's, when it is one of them.
    expect(parsePrice("₨ 250", "PKR")).toEqual({ value: 25_000, currency: "PKR" });
    expect(parsePrice("250 ﷼", "SAR")).toEqual({ value: 25_000, currency: "SAR" });
  });

  it("reads a sign the business's currency writes as the business's currency", () => {
    // `$` is the Australian, Canadian and Mexican sign as much as the American, and `kr` the
    // Norwegian and Danish as much as the Swedish: a shop in Sydney was stored in US dollars.
    expect(parsePrice("$25.00", "AUD")).toEqual({ value: 2_500, currency: "AUD" });
    expect(parsePrice("$25.00", "CAD")).toEqual({ value: 2_500, currency: "CAD" });
    expect(parsePrice("$249.00", "MXN")).toEqual({ value: 24_900, currency: "MXN" });
    expect(parsePrice("199,00 kr", "NOK")).toEqual({ value: 19_900, currency: "NOK" });
    expect(parsePrice("199,00 kr", "DKK")).toEqual({ value: 19_900, currency: "DKK" });
    expect(parsePrice("¥98.00", "CNY")).toEqual({ value: 9_800, currency: "CNY" });
    // In a feed priced in none of them, the sign is what it means most often, as before.
    expect(parsePrice("$25.00", "EUR")).toEqual({ value: 2_500, currency: "USD" });
    expect(parsePrice("199,00 kr", "EUR")).toEqual({ value: 19_900, currency: "SEK" });
    // A sign with its country's letters names that one currency, whatever the business's.
    expect(parsePrice("A$25.00", "EUR")).toEqual({ value: 2_500, currency: "AUD" });
    expect(parsePrice("C$25.00", "EUR")).toEqual({ value: 2_500, currency: "CAD" });
    expect(parsePrice("NZ$25.00", "EUR")).toEqual({ value: 2_500, currency: "NZD" });
    expect(parsePrice("US$25.00", "AUD")).toEqual({ value: 2_500, currency: "USD" });
    expect(parsePrice("HK$25.00", "EUR")).toEqual({ value: 2_500, currency: "HKD" });
    expect(parsePrice("S$25.00", "EUR")).toEqual({ value: 2_500, currency: "SGD" });
  });

  it("reads any currency counted in hundredths by its code, not only those of a short list", () => {
    // A code missing from the list was priced in the business's currency instead: 45.00 QAR was €45.00.
    expect(parsePrice("45.00 QAR", "EUR")).toEqual({ value: 4_500, currency: "QAR" });
    expect(parsePrice("1,299.50 PKR", "EUR")).toEqual({ value: 129_950, currency: "PKR" });
    expect(parsePrice("KES 1,500.00", "EUR")).toEqual({ value: 150_000, currency: "KES" });
    expect(parsePrice("25.00 GEL", "EUR")).toEqual({ value: 2_500, currency: "GEL" });
    expect(parsePrice("4 500,00 KZT", "EUR")).toEqual({ value: 450_000, currency: "KZT" });
    expect(parsePrice("TTD 25.00", "EUR")).toEqual({ value: 2_500, currency: "TTD" });
  });

  it("refuses what is not a price", () => {
    expect(parsePrice("", "EUR")).toBeNull();
    expect(parsePrice("on request", "EUR")).toBeNull();
    expect(parsePrice("   ", "EUR")).toBeNull();
  });

  it("gives no price of nothing or less: a placeholder is not a price to sell at", () => {
    for (const raw of ["0", "0.00 USD", "0,00 €", "-5.00 USD", "-0.01"]) expect(parsePrice(raw, "USD"), raw).toBeNull();
  });
});

describe("a row priced in a currency we do not count, or at nothing", () => {
  it("is no product on sale, in either format, and says so", () => {
    const csv = parseFeed(
      ["id,title,price", "K1,Dates,12.500 KWD", "J1,Record,4980 JPY", "Z1,Gift card,0.00 USD", "E1,Mug,8.50 EUR"].join(
        "\n",
      ),
      { defaultCurrency: "EUR" },
    ).products;
    expect(csv.map((p) => [p.externalId, p.price, p.available])).toEqual([
      ["K1", null, false],
      ["J1", null, false],
      // Nothing is a price, but none to sell at: kept off sale, at the price it last had.
      ["Z1", null, false],
      ["E1", { value: 850, currency: "EUR" }, null],
    ]);
    const xml = parseFeed(
      `<rss xmlns:g="http://base.google.com/ns/1.0"><channel><item><g:id>K1</g:id><title>Dates</title><g:price>12.500 KWD</g:price></item></channel></rss>`,
      { defaultCurrency: "EUR" },
    ).products[0];
    expect([xml?.price, xml?.available]).toEqual([null, false]);
  });

  it("sells at the regular price when the sale's is nothing", () => {
    const rows = parseFeed(["id,title,price,sale_price", "B1,Bell,12.99 USD,0.00 USD"].join("\n")).products;
    expect(rows[0]?.price).toEqual({ value: 1299, currency: "USD" });
  });
});

describe("parseAvailability", () => {
  it("reads every spelling a platform uses", () => {
    for (const yes of ["in stock", "in_stock", "InStock", "available", "yes", "1", "https://schema.org/InStock"]) {
      expect(parseAvailability(yes), yes).toBe(true);
    }
    for (const no of ["out of stock", "out_of_stock", "OutOfStock", "no", "0", "sold out", "preorder", "backorder"]) {
      expect(parseAvailability(no), no).toBe(false);
    }
    expect(parseAvailability("")).toBeNull();
    expect(parseAvailability("ask us")).toBeNull();
  });
});

describe("parseDelimited", () => {
  it("handles quotes, embedded delimiters and embedded newlines", () => {
    const rows = parseDelimited('a,b\n"one, two","line\nbreak"\n', ",");
    expect(rows).toEqual([
      ["a", "b"],
      ["one, two", "line\nbreak"],
    ]);
  });

  it("handles a doubled quote and a final row with no newline", () => {
    expect(parseDelimited('x\n"he said ""hi"""', ",")).toEqual([["x"], ['he said "hi"']]);
  });

  it("does not invent a row from a trailing newline", () => {
    expect(parseDelimited("a,b\n1,2\n", ",")).toHaveLength(2);
  });
});

describe("parseFeed, comma separated", () => {
  const csv = [
    "id,title,description,price,quantity,link,image_link",
    '1001,Chain lube,"Wet weather, 100ml",8.50,12,https://shop.example/lube,https://shop.example/lube.jpg',
    "1002,Inner tube,700x25c,4.99,0,https://shop.example/tube,",
  ].join("\n");

  it("reads a plain export", () => {
    const result = parseFeed(csv, { defaultCurrency: "EUR" });
    expect(result.format).toBe("csv");
    expect(result.products).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.truncated).toBe(false);
    const [first, second] = result.products;
    expect(first).toEqual({
      externalId: "1001",
      name: "Chain lube",
      description: "Wet weather, 100ml",
      sku: null,
      price: { value: 850, currency: "EUR" },
      stock: 12,
      available: true,
      url: "https://shop.example/lube",
      imageUrl: "https://shop.example/lube.jpg",
    });
    // Nothing said it was unavailable, but nothing is in stock either.
    expect(second?.available).toBe(false);
    expect(second?.imageUrl).toBeNull();
  });

  it("names the columns it mapped, so Settings can show the mapping", () => {
    expect(parseFeed(csv).mapped.name).toBe("title");
    expect(parseFeed(csv).mapped.price).toBe("price");
  });

  it("eats a byte order mark and CRLF line endings", () => {
    const result = parseFeed(`﻿id,title,price\r\n7,Bell,3.00\r\n`);
    expect(result.products[0]?.externalId).toBe("7");
    expect(result.products[0]?.name).toBe("Bell");
  });

  it("finds a semicolon-separated export whose descriptions are full of commas", () => {
    const semi = [
      "id;title;description;price",
      "5;Bidon;Holds 750ml, fits most cages, blue;6,50",
      "6;Pump;Small, light, alloy;18,00",
    ].join("\n");
    const result = parseFeed(semi);
    expect(result.products).toHaveLength(2);
    expect(result.products[0]?.description).toBe("Holds 750ml, fits most cages, blue");
    expect(result.products[0]?.price).toEqual({ value: 650, currency: "EUR" });
  });

  it("reads headers in another language", () => {
    const pt = ["referencia;nome;preco;stock", "A1;Selim;24,90;3"].join("\n");
    const product = parseFeed(pt).products[0];
    expect(product?.name).toBe("Selim");
    expect(product?.price).toEqual({ value: 2490, currency: "EUR" });
    expect(product?.stock).toBe(3);
  });

  it("falls back to the sku when there is no id column", () => {
    const result = parseFeed("sku,name,price\nWID-9,Widget,3.00");
    expect(result.products[0]?.externalId).toBe("WID-9");
    expect(result.products[0]?.sku).toBe("WID-9");
  });

  it("keeps every skipped row with a reason rather than dropping it", () => {
    const messy = [
      "id,title,price",
      ",No id here,1.00",
      "9,,2.00",
      "10,Fine,3.00",
      "10,Same id again,4.00",
      "",
      "   ,  ,  ",
    ].join("\n");
    const result = parseFeed(messy);
    expect(result.products.map((p) => p.externalId)).toEqual(["10"]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["no_id", "no_name", "duplicate_id"]);
    // Row numbers match what a spreadsheet shows, header included.
    expect(result.skipped[0]?.row).toBe(2);
    expect(result.skipped[2]?.row).toBe(5);
  });

  it("stops at the limit and says so", () => {
    const many = ["id,title,price", ...Array.from({ length: 50 }, (_, i) => `${i},Item ${i},1.00`)].join("\n");
    const result = parseFeed(many, { maxProducts: 10 });
    expect(result.products).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  it("refuses a feed it cannot read at all", () => {
    expect(() => parseFeed("")).toThrow(FeedParseError);
    expect(() => parseFeed("just one line of prose")).toThrow(/header row and nothing under it/);
    expect(() => parseFeed("alpha,beta\n1,2")).toThrow(/no column here looks like an id or a name/);
  });
});

describe("parseFeed, Google Merchant XML", () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Shop</title>
    <item>
      <g:id>SKU-1</g:id>
      <title><![CDATA[Handlebar tape & plugs]]></title>
      <description>Cork, 2 rolls</description>
      <g:price>14.00 EUR</g:price>
      <g:availability>in stock</g:availability>
      <link>https://shop.example/tape</link>
      <g:image_link>https://shop.example/tape.jpg</g:image_link>
      <g:mpn>TAPE-CORK</g:mpn>
    </item>
    <item>
      <g:id>SKU-2</g:id>
      <title>Bar ends</title>
      <g:sale_price>9.99 EUR</g:sale_price>
      <g:price>12.99 EUR</g:price>
      <g:availability>out of stock</g:availability>
    </item>
  </channel>
</rss>`;

  it("reads namespaced fields, CDATA and entities", () => {
    const result = parseFeed(xml);
    expect(result.format).toBe("xml");
    expect(result.products).toHaveLength(2);
    const [first] = result.products;
    expect(first?.externalId).toBe("SKU-1");
    expect(first?.name).toBe("Handlebar tape & plugs");
    expect(first?.price).toEqual({ value: 1400, currency: "EUR" });
    expect(first?.available).toBe(true);
    expect(first?.sku).toBe("TAPE-CORK");
    expect(first?.url).toBe("https://shop.example/tape");
  });

  it("prefers the sale price, which is what the shop is actually selling at", () => {
    expect(parseFeed(xml).products[1]?.price).toEqual({ value: 999, currency: "EUR" });
    expect(parseFeed(xml).products[1]?.available).toBe(false);
  });

  it("reads an Atom feed whose link is an attribute", () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <id>a-1</id>
        <title>Saddle</title>
        <link href="https://shop.example/saddle"/>
        <price>30.00 GBP</price>
      </entry>
    </feed>`;
    const product = parseFeed(atom).products[0];
    expect(product?.name).toBe("Saddle");
    expect(product?.url).toBe("https://shop.example/saddle");
    expect(product?.price).toEqual({ value: 3000, currency: "GBP" });
  });

  it("refuses XML with no items", () => {
    expect(() => parseFeed("<rss><channel><title>Empty</title></channel></rss>")).toThrow(/no <item>/);
  });

  it("decodes numeric and named entities", () => {
    expect(decodeXmlText("Caf&#233; &amp; bar &#x2014; open")).toBe("Café & bar — open");
  });
});

describe("the price a feed sells at", () => {
  // 20 October 2026, 10:00 in Toronto.
  const NOW = Date.parse("2026-10-20T14:00:00Z");
  const csv = (window: string) =>
    ["id,title,price,sale_price,sale_price_effective_date", `B1,Bell,12.99 CAD,9.99 CAD,${window}`].join("\n");
  const xml = (window: string) => `<rss xmlns:g="http://base.google.com/ns/1.0"><channel><item>
      <g:id>B1</g:id><title>Bell</title>
      <g:sale_price>9.99 CAD</g:sale_price><g:price>12.99 CAD</g:price>
      ${window ? `<g:sale_price_effective_date>${window}</g:sale_price_effective_date>` : ""}
    </item></channel></rss>`;
  const both = (window: string, timezone = "America/Toronto") =>
    [csv(window), xml(window)].map((body) => parseFeed(body, { now: NOW, timezone }).products[0]?.price?.value);

  it("is the sale price in both formats when the sale has no dates", () => {
    expect(both("")).toEqual([999, 999]);
  });

  it("is the sale price only inside its dates, and the regular price before and after", () => {
    expect(both("2026-10-01T00:00-04:00/2026-10-31T23:59-04:00")).toEqual([999, 999]);
    // Google's own spelling of an offset, without the colon.
    expect(both("2026-10-01T00:00-0400/2026-10-31T23:59-0400")).toEqual([999, 999]);
    // Ended: the sale is over, whatever the sale_price column still says.
    expect(both("2026-09-01T00:00Z/2026-09-30T23:59Z")).toEqual([1299, 1299]);
    // Not started yet.
    expect(both("2026-11-27/2026-11-30")).toEqual([1299, 1299]);
    // A window nobody can read is not known to be on.
    expect(both("Black Friday")).toEqual([1299, 1299]);
  });

  it("reads dates without an offset on the business's own clock", () => {
    // 21 October, 02:00 UTC: still the 20th in Vancouver, already the 21st in Tokyo.
    const late = Date.parse("2026-10-21T02:00:00Z");
    const window = "2026-10-01/2026-10-20";
    const at = (timezone: string) =>
      [csv(window), xml(window)].map((body) => parseFeed(body, { now: late, timezone }).products[0]?.price?.value);
    expect(at("America/Vancouver")).toEqual([999, 999]);
    expect(at("Asia/Tokyo")).toEqual([1299, 1299]);
    // A bound with its own offset is that instant, wherever the business is.
    const fixed = "2026-10-01T00:00+09:00/2026-10-21T00:00+09:00";
    expect(
      [csv(fixed), xml(fixed)].map(
        (body) => parseFeed(body, { now: late, timezone: "America/Vancouver" }).products[0]?.price?.value,
      ),
    ).toEqual([1299, 1299]);
  });

  it("reads a shop export's regular price and its sale's own start and end", () => {
    const woo = [
      "ID,Name,Regular price,Sale price,Date sale price starts,Date sale price ends",
      "11,Bell,12.99,9.99,2026-09-01 00:00:00,2026-09-30 23:59:59",
      "12,Horn,20.00,15.00,2026-10-01,2026-10-31",
      "13,Light,30.00,,,",
    ].join("\n");
    const prices = parseFeed(woo, { defaultCurrency: "CAD", now: NOW, timezone: "America/Toronto" }).products.map(
      (p) => p.price?.value,
    );
    expect(prices).toEqual([1299, 1500, 3000]);
  });

  it("says when its price changes by the sale's dates, so the change is made then", () => {
    const start = Date.parse("2026-11-27T05:00:00Z");
    const end = Date.parse("2026-12-01T05:00:00Z");
    // Not started: the regular price now, the sale's from its first moment, the regular from its last.
    for (const body of [csv("2026-11-27/2026-11-30"), xml("2026-11-27/2026-11-30")]) {
      const p = parseFeed(body, { now: NOW, timezone: "America/Toronto" }).products[0];
      expect(p?.price).toEqual({ value: 1299, currency: "CAD" });
      expect(p?.priceChanges).toEqual([
        { at: start, price: { value: 999, currency: "CAD" }, available: true },
        { at: end, price: { value: 1299, currency: "CAD" }, available: true },
      ]);
    }
    // Running: only its end is to come.
    const during = Date.parse("2026-11-28T12:00:00Z");
    expect(
      parseFeed(csv("2026-11-27/2026-11-30"), { now: during, timezone: "America/Toronto" }).products[0]?.priceChanges,
    ).toEqual([{ at: end, price: { value: 1299, currency: "CAD" }, available: true }]);
    // Over, with no dates, or with dates nobody can read: nothing is to come.
    for (const window of ["2026-09-01T00:00Z/2026-09-30T23:59Z", "", "Black Friday"]) {
      expect(
        parseFeed(csv(window), { now: NOW, timezone: "America/Toronto" }).products[0]?.priceChanges,
        window,
      ).toBeUndefined();
    }
  });

  it("keeps a row whose only price is a sale that is not on off sale, until it is on", () => {
    const sheet = ["id,title,sale_price,sale_price_effective_date", "B1,Bell,9.99 CAD,2026-11-27/2026-11-30"].join(
      "\n",
    );
    const before = parseFeed(sheet, { now: NOW, timezone: "America/Toronto" }).products[0];
    expect([before?.price, before?.available]).toEqual([null, false]);
    expect(before?.priceChanges).toEqual([
      { at: Date.parse("2026-11-27T05:00:00Z"), price: { value: 999, currency: "CAD" }, available: true },
      { at: Date.parse("2026-12-01T05:00:00Z"), price: null, available: false },
    ]);
    // After it, the price it had is not kept: it was the sale's.
    const after = parseFeed(sheet, { now: Date.parse("2026-12-02T12:00:00Z"), timezone: "America/Toronto" })
      .products[0];
    expect([after?.price, after?.available]).toEqual([null, false]);
  });

  it("never sells at cost", () => {
    const sheet = ["sku,name,cost,rrp", "W-1,Widget,4.00,9.99"].join("\n");
    const result = parseFeed(sheet, { defaultCurrency: "GBP" });
    expect(result.products[0]?.price).toBeNull();
    expect(result.mapped.price).toBeUndefined();
    // With a price column beside it, the price is the price.
    const priced = parseFeed(["sku,name,cost,price", "W-1,Widget,4.00,9.99"].join("\n"), { defaultCurrency: "GBP" });
    expect(priced.products[0]?.price).toEqual({ value: 999, currency: "GBP" });
  });
});

describe("the limit", () => {
  it("has a default, so a feed cannot fill the database by being long", () => {
    expect(DEFAULT_MAX_PRODUCTS).toBeGreaterThan(0);
  });
});

describe("identity", () => {
  it("uses the name only when the sheet has no id column anywhere", () => {
    const result = parseFeed("title,price\nChain lube,8.50\nInner tube,4.99");
    expect(result.products.map((p) => p.externalId)).toEqual(["Chain lube", "Inner tube"]);
  });

  it("never uses an XML title as the identity", () => {
    const noId = `<rss><channel><item><title>Saddle</title><price>30 EUR</price></item></channel></rss>`;
    const result = parseFeed(noId);
    expect(result.products).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe("no_id");
  });
});

/**
 * Everything below was found by an adversarial review of the first cut, and every case here was
 * demonstrated against the real code before it was believed. They are all the same class of
 * failure: a product imported at the wrong price or the wrong stock, silently, with no skip and
 * no error, and the wrong value then persisting through every later import.
 */
describe("prices that carry words", () => {
  it("does not read the punctuation of a trailing abbreviation as a thousands mark", () => {
    // `12,99 € inkl. MwSt.` became the digit string `12,99..`, so the real decimal comma was
    // read as a grouping mark and the product was imported at one hundred times its price.
    expect(parsePrice("12,99 € inkl. MwSt.", "EUR")).toEqual({ value: 1299, currency: "EUR" });
    expect(parsePrice("12.99 EUR incl. VAT", "EUR")).toEqual({ value: 1299, currency: "EUR" });
    expect(parsePrice("£12.99.", "EUR")).toEqual({ value: 1299, currency: "GBP" });
    expect(parsePrice("$19.99 / ea.", "EUR")).toEqual({ value: 1999, currency: "USD" });
    expect(parsePrice("Price: 12.99.", "EUR")).toEqual({ value: 1299, currency: "EUR" });
    expect(parsePrice("12.99 USD (incl. tax)", "EUR")).toEqual({ value: 1299, currency: "USD" });
  });

  it("takes the first number, so a percentage in the sentence is not the price", () => {
    expect(parsePrice("12.99 EUR incl. 20% VAT", "EUR")).toEqual({ value: 1299, currency: "EUR" });
    expect(parsePrice("ab 12,99 €", "EUR")).toEqual({ value: 1299, currency: "EUR" });
  });

  it("reads a thousands group written with a space", () => {
    expect(parsePrice("1 234,56 EUR", "EUR")).toEqual({ value: 123_456, currency: "EUR" });
    expect(parsePrice("1 234,56 EUR", "EUR")).toEqual({ value: 123_456, currency: "EUR" });
  });

  it("refuses a three-letter word that is not a currency", () => {
    // `VAT`, `RRP` and `NEW` are not currencies, and storing a product in one is not a typo the
    // owner can see: the number is right and the code beside it is nonsense.
    expect(parsePrice("12.99 incl VAT", "EUR")?.currency).toBe("EUR");
    expect(parsePrice("RRP 12.99", "GBP")?.currency).toBe("GBP");
    expect(parsePrice("12.99 NEW", "EUR")?.currency).toBe("EUR");
    // A real code still wins over the default.
    expect(parsePrice("12.99 SEK", "EUR")?.currency).toBe("SEK");
  });

  it("reads R$ as reais rather than dollars", () => {
    // "R$".includes("$") is true, so a shorter symbol tested first claimed every price.
    expect(parsePrice("R$ 49,90", "EUR")).toEqual({ value: 4990, currency: "BRL" });
    expect(parsePrice("$49.90", "EUR")).toEqual({ value: 4990, currency: "USD" });
    expect(parsePrice("399 zł", "EUR")?.currency).toBe("PLN");
  });
});

describe("stock counts", () => {
  it("reads 10.00 as ten, not as a thousand", () => {
    const ten = parseFeed("id,title,price,quantity\nA1,Chain lube,8.50,10.00").products[0];
    expect(ten?.stock).toBe(10);
    const dozen = parseFeed("id,title,price,quantity\nA1,Chain lube,8.50,12,00").products[0];
    expect(dozen?.stock).toBe(12);
    const plain = parseFeed("id,title,price,quantity\nA1,Chain lube,8.50,1 250").products[0];
    expect(plain?.stock).toBe(1250);
  });

  it("reads an oversold negative count as none", () => {
    const row = parseFeed("id,title,price,quantity\nA1,Chain lube,8.50,-3").products[0];
    expect(row?.stock).toBe(0);
    expect(row?.available).toBe(false);
  });
});

describe("XML fields belong to the item, not to something inside it", () => {
  it("does not take a nested shipping charge as the price", () => {
    const xml = `<rss xmlns:g="http://base.google.com/ns/1.0"><channel><item>
      <g:id>SKU-1</g:id><title>Track pump</title>
      <g:shipping><g:country>GB</g:country><g:price>3.99 GBP</g:price></g:shipping>
      <g:price>49.99 GBP</g:price>
    </item></channel></rss>`;
    const product = parseFeed(xml).products[0];
    expect(product?.name).toBe("Track pump");
    expect(product?.price).toEqual({ value: 4999, currency: "GBP" });
  });

  it("does not take an author's name as the product name", () => {
    const atom = `<feed><entry>
      <id>a1</id><author><name>Bob Smith</name></author><price>10 GBP</price>
    </entry></feed>`;
    // No title at all, so there is no name to find: the entry is skipped rather than invented.
    const result = parseFeed(atom);
    expect(result.products).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe("no_name");
  });

  it("still reads a nested value when the item has no direct one of its own", () => {
    const xml = `<rss><channel><item><id>X1</id><title>Bell</title><price>4.00 EUR</price></item></channel></rss>`;
    expect(parseFeed(xml).products[0]?.price).toEqual({ value: 400, currency: "EUR" });
  });

  it("survives a closing tag written inside CDATA", () => {
    const xml = `<rss><channel><item>
      <id>C1</id>
      <description><![CDATA[Fits the </item> bracket]]></description>
      <title>Clamp</title>
      <price>7.50 EUR</price>
    </item></channel></rss>`;
    const product = parseFeed(xml).products[0];
    expect(product?.name).toBe("Clamp");
    expect(product?.description).toBe("Fits the </item> bracket");
    expect(product?.price).toEqual({ value: 750, currency: "EUR" });
  });
});

describe("what a product is, beside its price (ADR-029)", () => {
  it("keeps a Merchant XML item's barcode and part number apart, with its sku as it was", () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>
  <item>
    <g:id>SKU-1</g:id><title>Moka pot, 6 cups</title><g:price>18.90 EUR</g:price>
    <g:gtin>8006363011662</g:gtin><g:mpn>BIA-0001162</g:mpn><g:brand>Bialetti</g:brand>
    <g:condition>refurbished</g:condition><g:identifier_exists>yes</g:identifier_exists>
    <g:google_product_category>Home &amp; Garden &gt; Kitchen</g:google_product_category>
    <link>https://shop.example/moka</link><g:image_link>https://shop.example/moka.jpg</g:image_link>
  </item>
  <item><g:id>SKU-2</g:id><title>Sourdough loaf</title><g:price>4.50 EUR</g:price><g:identifier_exists>no</g:identifier_exists></item>
</channel></rss>`;
    const [moka, loaf] = parseFeed(xml).products;
    expect(moka).toMatchObject({
      sku: "BIA-0001162",
      gtin: { raw: "8006363011662", hint: "barcode" },
      mpn: "BIA-0001162",
      brand: "Bialetti",
      condition: "refurbished",
      noGtin: false,
      sourceCategory: "Home & Garden > Kitchen",
      url: "https://shop.example/moka",
      imageUrl: "https://shop.example/moka.jpg",
    });
    expect(loaf).toMatchObject({ noGtin: true });
    expect(loaf).not.toHaveProperty("gtin");
  });

  it("fills the barcode from a CSV's EAN, UPC or ISBN column, saying which", () => {
    const csv = (header: string) => `id,title,price,${header}\n1,Chain lube,8.50,4006381333931\n`;
    expect(parseFeed(csv("EAN")).products[0]?.gtin).toEqual({ raw: "4006381333931", hint: "barcode" });
    expect(parseFeed(csv("Barcode")).products[0]?.gtin).toEqual({ raw: "4006381333931", hint: "barcode" });
    expect(parseFeed(csv("UPC")).products[0]?.gtin).toEqual({ raw: "4006381333931", hint: "upc" });
    expect(parseFeed(csv("ISBN")).products[0]?.gtin).toEqual({ raw: "4006381333931", hint: "isbn" });
    // The barcode is still the sku of a sheet that names no other, so an agent ordering by it is served.
    expect(parseFeed(csv("EAN")).products[0]?.sku).toBe("4006381333931");
    expect(parseFeed(csv("EAN")).mapped.gtin).toBe("EAN");
  });

  it("reads a condition in the words shops use, and none it cannot place", () => {
    const csv = (c: string) => `id,title,price,condition\n1,Bike,100.00,${c}\n`;
    expect(parseFeed(csv("New")).products[0]?.condition).toBe("new");
    expect(parseFeed(csv("usado")).products[0]?.condition).toBe("used");
    expect(parseFeed(csv("Refurbished")).products[0]?.condition).toBe("refurbished");
    expect(parseFeed(csv("like a dream")).products[0]).not.toHaveProperty("condition");
  });

  it("reads an old feed exactly as before: nothing new where it says nothing", () => {
    const csv = "id,title,price\n7,Bell,3.00\n";
    expect(parseFeed(csv).products[0]).toEqual({
      externalId: "7",
      name: "Bell",
      description: null,
      sku: null,
      price: { value: 300, currency: "EUR" },
      stock: null,
      available: null,
      url: null,
      imageUrl: null,
    });
  });
});
