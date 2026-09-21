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

  it("gives a zero-decimal currency no minor units", () => {
    expect(parsePrice("500 JPY", "EUR")).toEqual({ value: 500, currency: "JPY" });
    expect(parsePrice("2500 HUF", "EUR")).toEqual({ value: 2500, currency: "HUF" });
  });

  it("refuses what is not a price", () => {
    expect(parsePrice("", "EUR")).toBeNull();
    expect(parsePrice("on request", "EUR")).toBeNull();
    expect(parsePrice("   ", "EUR")).toBeNull();
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
