import { describe, it, expect } from "vitest";
import { parseFeed } from "../src/feeds/parse";

describe("nested descendant probe", () => {
  it("shipping price", () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>
  <item>
    <g:id>SKU-1</g:id><title>Track pump</title>
    <g:shipping><g:country>GB</g:country><g:service>Standard</g:service><g:price>3.99 GBP</g:price></g:shipping>
    <g:price>49.99 GBP</g:price>
  </item>
</channel></rss>`;
    const r = parseFeed(xml);
    console.log("SHIPPING-CASE", JSON.stringify(r.products, null, 1), JSON.stringify(r.skipped));
    expect(r).toBe("SHOW");
  });
  it("atom author name", () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>a1</id><author><name>Bob Smith</name></author><price>10 GBP</price></entry></feed>`;
    const r = parseFeed(atom);
    console.log("AUTHOR-CASE", JSON.stringify(r.products, null, 1), JSON.stringify(r.skipped));
    expect(r).toBe("SHOW");
  });
  it("google canonical order price first", () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>
  <item>
    <g:id>SKU-2</g:id><title>Track pump</title>
    <g:price>49.99 GBP</g:price>
    <g:shipping><g:country>GB</g:country><g:price>3.99 GBP</g:price></g:shipping>
  </item>
</channel></rss>`;
    const r = parseFeed(xml);
    console.log("PRICE-FIRST-CASE", JSON.stringify(r.products, null, 1));
    expect(r).toBe("SHOW");
  });
});
