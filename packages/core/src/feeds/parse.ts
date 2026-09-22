/**
 * Feed import (ADR-015 §7.3): turn the product feed a shop already publishes into products in
 * this inbox, with no credentials, no OAuth and no platform to join.
 *
 * Two formats cover the ground. WooCommerce, Wix, PrestaShop, BigCommerce, Squarespace and
 * Shopify-through-Google all emit either a comma-separated export or a Google Merchant XML feed,
 * and a shop that has neither can still publish a spreadsheet. Everything here is pure: text in,
 * rows out, no fetching and no database, so the awkward parts are tested directly.
 *
 * Nothing about a feed is trusted. A field can be absent, empty, in another language, priced in a
 * currency the sheet never names, or three megabytes of someone's blog. Every row that cannot be
 * made into a product is returned with a reason rather than dropped in silence: an owner who
 * imports 412 of 415 products needs to know what the other three were.
 */

/** A product as a feed describes it, normalised. `null` means the feed did not say. */
export interface FeedProduct {
  /** The feed's own id for this product. The key we reconcile on, so it is required. */
  readonly externalId: string;
  readonly name: string;
  readonly description: string | null;
  readonly sku: string | null;
  /** Minor units and an ISO currency, as the rest of the schema stores money. */
  readonly price: { readonly value: number; readonly currency: string } | null;
  /** Units in stock when the feed counts them. A feed that only says "in stock" leaves this null. */
  readonly stock: number | null;
  /** What the feed claims about availability, when it says anything at all. */
  readonly available: boolean | null;
  readonly url: string | null;
  readonly imageUrl: string | null;
}

export interface FeedSkip {
  /** 1-based, counting the header, so it matches what a spreadsheet shows. */
  readonly row: number;
  readonly reason: "no_id" | "no_name" | "duplicate_id";
  /** Enough of the row to recognise it, never the whole thing. */
  readonly sample: string;
}

export interface FeedParseResult {
  readonly format: "csv" | "xml";
  readonly products: readonly FeedProduct[];
  readonly skipped: readonly FeedSkip[];
  /** True when the feed had more rows than `maxProducts` and the rest were not read. */
  readonly truncated: boolean;
  /** The header names we recognised, so Settings can show what was mapped to what. */
  readonly mapped: Readonly<Record<string, string>>;
}

export interface FeedParseOptions {
  /** Used when a price carries no currency of its own. */
  readonly defaultCurrency?: string;
  /** A feed longer than this stops here. Protects the database and the Worker's memory alike. */
  readonly maxProducts?: number;
}

export class FeedParseError extends Error {
  readonly code: "empty" | "unrecognised" | "no_rows" | "no_id_column";

  constructor(code: FeedParseError["code"], message: string) {
    super(message);
    this.name = "FeedParseError";
    this.code = code;
  }
}

export const DEFAULT_MAX_PRODUCTS = 5000;

/* --- Field names -------------------------------------------------------- */

/**
 * What a column may be called. Google's own names come first because a feed built for Google is
 * the commonest export by a distance; the rest are what the platforms and their translations
 * actually write. Matching is done on a squashed form, so `Product Name`, `product_name` and
 * `productname` are one name.
 */
const FIELD_ALIASES: Readonly<Record<keyof FeedProduct | "quantity", readonly string[]>> = {
  externalId: ["id", "gid", "itemid", "productid", "uniqueid", "identifier", "sku", "variantid", "ref"],
  name: ["title", "name", "productname", "producttitle", "itemname", "nome", "nombre", "titel", "titre"],
  description: ["description", "descr", "productdescription", "summary", "descricao", "descripcion"],
  sku: ["sku", "mpn", "skucode", "productcode", "code", "reference", "referencia", "artikelnummer", "ean", "gtin"],
  price: ["price", "saleprice", "unitprice", "amount", "cost", "preco", "precio", "preis", "prix"],
  stock: ["quantity", "stock", "stockquantity", "inventory", "inventoryquantity", "qty", "onhand", "estoque"],
  quantity: ["quantity", "stock", "stockquantity", "inventory", "inventoryquantity", "qty", "onhand", "estoque"],
  available: ["availability", "available", "instock", "stockstatus", "status", "disponibilidade"],
  url: ["link", "url", "producturl", "permalink", "productlink"],
  imageUrl: ["imagelink", "image", "imageurl", "picture", "thumbnail", "mainimage", "imagen", "imagem"],
};

/** `Product Name`, `g:product_name` and `PRODUCT-NAME` all squash to `productname`. */
function squash(header: string): string {
  const withoutNamespace = header.includes(":") ? header.slice(header.lastIndexOf(":") + 1) : header;
  return withoutNamespace
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Picks the column for each field. A feed that names two candidates keeps the earlier alias, which
 * is why `sale_price` sits behind `price`: when a shop publishes both we want the one it sells at.
 * `id` and `sku` share aliases on purpose, and a feed with only one of them uses it for both.
 */
function mapColumns(headers: readonly string[]): { index: Record<string, number>; mapped: Record<string, string> } {
  const squashed = headers.map(squash);
  const index: Record<string, number> = {};
  const mapped: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const at = squashed.indexOf(alias);
      if (at >= 0) {
        index[field] = at;
        mapped[field] = headers[at] ?? alias;
        break;
      }
    }
  }
  return { index, mapped };
}

/* --- Money -------------------------------------------------------------- */

/**
 * Longest symbol first, and the lookup honours that order. `"R$".includes("$")` is true, so a
 * shorter symbol tested first claims every price carrying the longer one, and Brazilian reais
 * were stored as dollars.
 */
const CURRENCY_SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ["R$", "BRL"],
  ["zł", "PLN"],
  ["Kč", "CZK"],
  ["kr", "SEK"],
  ["€", "EUR"],
  ["£", "GBP"],
  ["¥", "JPY"],
  ["$", "USD"],
];

/**
 * ISO 4217: what a small European shop prices in, plus the majors. The check exists because a
 * price cell reads `12.99 EUR incl. VAT` as often as it reads `12.99 EUR`, and matching any
 * three-letter uppercase token stored the product in a currency called VAT. Or RRP. Or NEW.
 */
const ISO_CURRENCIES = new Set([
  "AED",
  "ARS",
  "AUD",
  "BGN",
  "BRL",
  "CAD",
  "CHF",
  "CLP",
  "CNY",
  "COP",
  "CZK",
  "DKK",
  "EGP",
  "EUR",
  "GBP",
  "HKD",
  "HRK",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "ISK",
  "JPY",
  "KRW",
  "MAD",
  "MXN",
  "MYR",
  "NGN",
  "NOK",
  "NZD",
  "PEN",
  "PHP",
  "PLN",
  "RON",
  "RSD",
  "RUB",
  "SAR",
  "SEK",
  "SGD",
  "THB",
  "TRY",
  "TWD",
  "UAH",
  "USD",
  "UYU",
  "VND",
  "ZAR",
]);

/** Currencies whose amounts have no minor unit at all, so 500 JPY is 500 and not 50,000. */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF", "XAF", "XOF", "RWF", "UGX"]);

/**
 * `12.99 EUR`, `EUR 12.99`, `€12,99`, `1.234,56 €`, `£9` and a bare `9.5` all have to land on the
 * same integer. The hard part is not the symbol, it is that half of Europe writes the decimal
 * separator as a comma and the thousands separator as a full stop: `1.234,56` is one thousand
 * two hundred, and `1.234` on its own is almost certainly one thousand two hundred and thirty
 * four rather than one and a bit. The rule used here is the one a person uses reading it: the
 * LAST separator is the decimal point when it leaves two or fewer digits behind it, and every
 * separator is a grouping mark otherwise.
 */
export function parsePrice(raw: string, defaultCurrency: string): { value: number; currency: string } | null {
  const text = raw.trim();
  if (text === "") return null;

  let currency = "";
  for (const match of text.matchAll(/\b([A-Z]{3})\b/g)) {
    const code = match[1] as string;
    if (ISO_CURRENCIES.has(code)) {
      currency = code;
      break;
    }
  }
  if (currency === "") {
    for (const [symbol, code] of CURRENCY_SYMBOLS) {
      if (text.includes(symbol)) {
        currency = code;
        break;
      }
    }
  }
  if (currency === "") currency = defaultCurrency.toUpperCase();

  const number = readNumber(text);
  if (!number) return null;
  const exponent = ZERO_DECIMAL.has(currency) ? 0 : 2;
  // A zero-decimal currency written with a fraction is someone's formatter, not money.
  const value =
    exponent === 0 ? Number(number.whole) : Number(number.whole) * 100 + Number(`${number.fraction}00`.slice(0, 2));
  if (!Number.isFinite(value)) return null;
  return { value: number.negative ? -value : value, currency };
}

/**
 * The first number in a cell that may carry anything around it.
 *
 * The first cut of this stripped every non-numeric character from the WHOLE cell, which is wrong
 * in a way that costs real money: `12,99 € inkl. MwSt.` became the digit string `12,99..`, the
 * full stop of the abbreviation became the last separator with nothing behind it, so the genuine
 * decimal comma was read as a thousands mark and the product imported at €1,299.00. Reading the
 * first numeric RUN instead leaves the sentence outside the number, where it belongs. The first
 * run and not the last, because `12.99 EUR incl. 20% VAT` has to be twelve ninety-nine.
 */
function readNumber(text: string): { whole: string; fraction: string; negative: boolean } | null {
  const match = text.match(/-?\d[\d.,\u00a0\u202f' ]*/);
  if (!match) return null;
  const negative = match[0].startsWith("-");
  const body = match[0]
    .replace(/^-/, "")
    .replace(/[\u00a0\u202f' ]/g, "")
    // A separator at the very end belonged to the sentence, not to the number.
    .replace(/[.,]+$/, "");
  if (body === "" || !/\d/.test(body)) return null;

  const lastSeparator = Math.max(body.lastIndexOf(","), body.lastIndexOf("."));
  let whole = body;
  let fraction = "";
  if (lastSeparator >= 0) {
    const tail = body.slice(lastSeparator + 1);
    // Two digits or fewer after the last separator: it is the decimal point. Three, and it was a
    // thousands mark, which is why `1.234` reads as 1234 rather than 1.234.
    if (tail.length > 0 && tail.length <= 2 && /^\d+$/.test(tail)) {
      whole = body.slice(0, lastSeparator);
      fraction = tail;
    }
  }
  whole = whole.replace(/[.,]/g, "");
  if (whole === "") whole = "0";
  if (!/^\d+$/.test(whole)) return null;
  return { whole, fraction, negative };
}

const IN_STOCK = new Set([
  "instock",
  "in",
  "available",
  "yes",
  "true",
  "1",
  "y",
  "disponivel",
  "disponible",
  "auflager",
]);
const OUT_OF_STOCK = new Set(["outofstock", "out", "unavailable", "no", "false", "0", "n", "esgotado", "agotado"]);

/** `in stock`, `in_stock`, `InStock`, `yes`, `1` and `https://schema.org/InStock` all mean true. */
export function parseAvailability(raw: string): boolean | null {
  const text = squash(raw.includes("/") ? (raw.split("/").pop() ?? raw) : raw);
  if (text === "") return null;
  if (IN_STOCK.has(text)) return true;
  if (OUT_OF_STOCK.has(text)) return false;
  // `preorder` and `backorder` are real answers, and neither is "you can buy this now".
  if (text.startsWith("preorder") || text.startsWith("backorder")) return false;
  if (text.startsWith("instock") || text.startsWith("limited")) return true;
  if (text.startsWith("outof") || text.startsWith("soldout")) return false;
  return null;
}

function parseCount(raw: string): number | null {
  const number = readNumber(raw);
  if (!number) return null;
  // `10.00` is ten. Deleting the decimal point rather than truncating made it a thousand, and a
  // shop with ten in stock told every agent it had a thousand.
  const n = Number(number.whole);
  if (!Number.isFinite(n)) return null;
  // A negative count is a platform's way of saying oversold. Zero is the honest reading.
  return number.negative ? 0 : Math.trunc(n);
}

/* --- Delimited text ----------------------------------------------------- */

const DELIMITERS = [",", ";", "\t", "|"] as const;

/**
 * RFC 4180, plus the three things real exports do that it does not mention: a UTF-8 byte order
 * mark, CRLF line endings, and a final row with no newline after it.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      started = true;
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
      continue;
    }
    field += ch;
    started = true;
  }
  if (started || field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The delimiter is the one that gives the header the most columns. Counting commas is not enough:
 *  a semicolon-separated feed whose descriptions contain commas would win on the count and lose
 *  every field. */
function detectDelimiter(text: string): string {
  const sample = text.slice(0, 64_000);
  let best = ",";
  let bestColumns = 0;
  for (const candidate of DELIMITERS) {
    const rows = parseDelimited(sample, candidate);
    const header = rows[0];
    if (!header) continue;
    if (header.length > bestColumns) {
      bestColumns = header.length;
      best = candidate;
    }
  }
  return best;
}

/* --- XML ---------------------------------------------------------------- */

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/**
 * CDATA is taken out of the document before any tag is looked at, and put back only when a
 * field's text is read. A feed that writes `<description><![CDATA[Fits the </item> bracket]]>`
 * is legal XML, and scanning for tags without masking it first ends the item early and loses
 * every field after it.
 */
interface MaskedXml {
  readonly text: string;
  readonly sections: readonly string[];
}

const MASK = "\u0000";

function maskCdata(xml: string): MaskedXml {
  const sections: string[] = [];
  const text = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, body: string) => {
    sections.push(body);
    return `${MASK}${sections.length - 1}${MASK}`;
  });
  return { text, sections };
}

function unmask(text: string, sections: readonly string[]): string {
  return text.replace(new RegExp(`${MASK}(\\d+)${MASK}`, "g"), (whole, index: string) => {
    const at = Number(index);
    return Number.isInteger(at) && at >= 0 && at < sections.length ? (sections[at] as string) : whole;
  });
}

export function decodeXmlText(raw: string): string {
  const masked = maskCdata(raw);
  return decodeEntities(unmask(masked.text, masked.sections)).trim();
}

function decodeEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => codePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);
}

function codePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return "";
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

/** Every `<item>` or `<entry>` body, in document order, still masked. */
function xmlEntries(xml: string): string[] {
  const out: string[] = [];
  const re = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi;
  let match = re.exec(xml);
  while (match !== null) {
    out.push(match[2] ?? "");
    match = re.exec(xml);
  }
  return out;
}

interface XmlChild {
  readonly name: string;
  readonly inner: string;
  readonly attrs: string;
}

/**
 * The DIRECT children of an item, in document order.
 *
 * Matching a field with a plain regex over the whole item body finds the first element with that
 * name ANYWHERE inside it, and in a Google Merchant feed that is routinely the wrong one:
 *
 *   <item>
 *     <g:shipping><g:price>3.99 GBP</g:price></g:shipping>
 *     <g:price>49.99 GBP</g:price>
 *   </item>
 *
 * The nested shipping charge comes first in document order, so the £49.99 product was imported
 * at £3.99, silently, with no skip and no error, and the wrong price then persisted through
 * every later import. So the children are walked with a depth counter and only depth-one
 * elements are offered to the field lookup.
 */
function directChildren(entry: string): XmlChild[] {
  const out: XmlChild[] = [];
  // Comments and processing instructions are skipped whole; CDATA is already masked.
  const body = entry.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  const tag = /<(\/?)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let depth = 0;
  let openName = "";
  let openAttrs = "";
  let contentStart = 0;
  let match = tag.exec(body);
  while (match !== null) {
    const whole = match[0];
    const closing = match[1] === "/";
    const name = localName(match[2] ?? "");
    const attrs = match[3] ?? "";
    const selfClosing = match[4] === "/";
    if (closing) {
      // A stray closing tag must not drive the depth negative and swallow the rest of the item.
      if (depth > 0) depth -= 1;
      if (depth === 0 && name === openName) {
        out.push({ name: openName, inner: body.slice(contentStart, match.index), attrs: openAttrs });
        openName = "";
      }
    } else if (selfClosing) {
      if (depth === 0) out.push({ name, inner: "", attrs });
    } else {
      if (depth === 0) {
        openName = name;
        openAttrs = attrs;
        contentStart = match.index + whole.length;
      }
      depth += 1;
    }
    match = tag.exec(body);
  }
  return out;
}

/** `g:price` and `price` are one name; the prefix is a namespace, not part of the name. */
function localName(raw: string): string {
  const at = raw.lastIndexOf(":");
  return (at >= 0 ? raw.slice(at + 1) : raw).toLowerCase();
}

/** The text of the first DIRECT child with one of these names, or its href when it has no text. */
function xmlField(children: readonly XmlChild[], names: readonly string[], sections: readonly string[]): string {
  for (const name of names) {
    const wanted = name.toLowerCase();
    for (const child of children) {
      if (child.name !== wanted) continue;
      const text = decodeEntities(unmask(child.inner, sections)).trim();
      if (text !== "") return text;
      // `<link href="…"/>`, which is how Atom writes a URL.
      const href = child.attrs.match(/\shref\s*=\s*"([^"]*)"/i) ?? child.attrs.match(/\shref\s*=\s*'([^']*)'/i);
      if (href?.[1]) return decodeEntities(href[1]).trim();
    }
  }
  return "";
}

/** The XML names for each field: Google's, plus the Atom and RSS spellings. */
const XML_FIELDS: Readonly<Record<string, readonly string[]>> = {
  externalId: ["id", "item_group_id", "guid", "sku", "mpn"],
  name: ["title", "name"],
  description: ["description", "summary", "content"],
  sku: ["mpn", "sku", "gtin", "identifier"],
  // Sale price first: it is what the shop is actually selling at today.
  price: ["sale_price", "price"],
  stock: ["quantity", "inventory", "stock"],
  available: ["availability", "in_stock", "stock_status"],
  url: ["link", "url"],
  imageUrl: ["image_link", "image", "enclosure"],
};

/* --- The parser --------------------------------------------------------- */

/** Detects the format and parses. Throws `FeedParseError` only when nothing can be read at all. */
export function parseFeed(text: string, options: FeedParseOptions = {}): FeedParseResult {
  const body = text.replace(/^﻿/, "").trim();
  if (body === "") throw new FeedParseError("empty", "the feed is empty");
  const currency = (options.defaultCurrency ?? "EUR").toUpperCase();
  const limit = Math.max(1, options.maxProducts ?? DEFAULT_MAX_PRODUCTS);
  const looksXml = body.startsWith("<") || /<(?:rss|feed|products|channel)\b/i.test(body.slice(0, 2000));
  return looksXml ? parseXmlFeed(body, currency, limit) : parseCsvFeed(body, currency, limit);
}

function parseXmlFeed(raw: string, currency: string, limit: number): FeedParseResult {
  // Masked once for the whole document, so an item boundary can never fall inside CDATA.
  const masked = maskCdata(raw);
  const entries = xmlEntries(masked.text);
  if (entries.length === 0) {
    throw new FeedParseError("no_rows", "this looks like XML but has no <item> or <entry> elements");
  }
  const products: FeedProduct[] = [];
  const skipped: FeedSkip[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (let i = 0; i < entries.length; i++) {
    if (products.length >= limit) {
      truncated = true;
      break;
    }
    const entry = entries[i] as string;
    const children = directChildren(entry);
    const read = (field: string): string => xmlField(children, XML_FIELDS[field] ?? [], masked.sections);
    const name = read("name");
    // Never the title: a title is edited, and an identity that changes makes a second product on
    // the next import instead of updating the first. Both formats mandate an id anyway.
    const externalId = read("externalId") || read("sku") || read("url");
    const row = i + 1;
    if (externalId === "") {
      skipped.push({ row, reason: "no_id", sample: sample(unmask(entry, masked.sections)) });
      continue;
    }
    if (name === "") {
      skipped.push({ row, reason: "no_name", sample: sample(externalId) });
      continue;
    }
    if (seen.has(externalId)) {
      skipped.push({ row, reason: "duplicate_id", sample: sample(externalId) });
      continue;
    }
    seen.add(externalId);
    const availability = read("available");
    const stock = parseCount(read("stock"));
    products.push({
      externalId,
      name,
      description: read("description") || null,
      sku: read("sku") || null,
      price: parsePrice(read("price"), currency),
      stock,
      available: parseAvailability(availability) ?? (stock === null ? null : stock > 0),
      url: read("url") || null,
      imageUrl: read("imageUrl") || null,
    });
  }
  return { format: "xml", products, skipped, truncated, mapped: {} };
}

function parseCsvFeed(body: string, currency: string, limit: number): FeedParseResult {
  const delimiter = detectDelimiter(body);
  const rows = parseDelimited(body, delimiter);
  const headers = rows[0];
  if (!headers || headers.length === 0) throw new FeedParseError("no_rows", "the feed has no header row");
  if (rows.length < 2) throw new FeedParseError("no_rows", "the feed has a header row and nothing under it");

  const { index, mapped } = mapColumns(headers);
  if (index.externalId === undefined && index.name === undefined) {
    throw new FeedParseError(
      "no_id_column",
      `no column here looks like an id or a name. Found: ${headers.slice(0, 12).join(", ")}`,
    );
  }

  const hasIdColumn = index.externalId !== undefined || index.sku !== undefined;
  const products: FeedProduct[] = [];
  const skipped: FeedSkip[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (let r = 1; r < rows.length; r++) {
    if (products.length >= limit) {
      truncated = true;
      break;
    }
    const row = rows[r] as string[];
    // A trailing blank line is not a row, and neither is a line of empty cells.
    if (row.every((cell) => cell.trim() === "")) continue;
    const at = (field: string): string => {
      const column = index[field];
      return column === undefined ? "" : (row[column] ?? "").trim();
    };
    const name = at("name");
    // The name is an identity of last resort, and only for a sheet that has no id column at all.
    // When the feed HAS one and this row left it empty, the row is broken: falling back to the
    // name would make a second product the day someone fixes a typo in it.
    const externalId = at("externalId") || at("sku") || (hasIdColumn ? "" : name);
    const line = r + 1;
    if (externalId === "") {
      skipped.push({ row: line, reason: "no_id", sample: sample(row.join(delimiter)) });
      continue;
    }
    if (name === "") {
      skipped.push({ row: line, reason: "no_name", sample: sample(externalId) });
      continue;
    }
    if (seen.has(externalId)) {
      skipped.push({ row: line, reason: "duplicate_id", sample: sample(externalId) });
      continue;
    }
    seen.add(externalId);
    const stock = parseCount(at("stock"));
    products.push({
      externalId,
      name,
      description: at("description") || null,
      sku: at("sku") || null,
      price: parsePrice(at("price"), currency),
      stock,
      available: parseAvailability(at("available")) ?? (stock === null ? null : stock > 0),
      url: at("url") || null,
      imageUrl: at("imageUrl") || null,
    });
  }
  return { format: "csv", products, skipped, truncated, mapped };
}

function sample(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat;
}
