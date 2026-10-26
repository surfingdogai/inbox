---
title: Product feeds
description: Point your Inbox at the product feed your shop already publishes, and agents can answer what you sell and what it costs from the same numbers your customers see.
---

An agent asked to buy something from you needs to know two things: whether you have it, and what it costs. A **product feed** is the cheapest way to tell it, because your shop almost certainly publishes one already.

Nearly every platform emits a feed so that Google Shopping can read it — WooCommerce, Wix, PrestaShop, BigCommerce, Squarespace and Shopify all do. It is a public URL. There is no password to hand over, no app to install, no OAuth screen and nothing to review. You paste the URL, and your catalogue fills itself.

## Connect one

Settings → Integrations → **Connect a feed**. Paste the URL your platform calls a product feed or a Google Shopping feed, and the first import starts at once. After that it re-imports every six hours, and **Import now** runs one immediately.

Or over the API, with an owner key:

```bash
curl -X POST https://<your-instance>/v1/owner/feeds \
  -H "authorization: Bearer sdi_own_…" -H 'content-type: application/json' \
  -d '{ "url": "https://yourshop.example/feed.xml" }'
```

`GET /v1/owner/feeds` lists them with what each one last did, `POST /v1/owner/feeds/{id}/import` runs one now, and `DELETE /v1/owner/feeds/{id}` disconnects.

## What it reads

Two formats, which between them cover what the platforms actually emit.

**A spreadsheet export**, separated by commas, semicolons, tabs or pipes. The separator is detected from your header row, so a European export full of semicolons and decimal commas works without being told. Quoted fields, embedded commas, embedded newlines and a byte order mark are all handled.

**Google Merchant XML**, the feed built for Google Shopping, including the `g:` namespace, CDATA and entities.

Columns are matched by name, ignoring case, spaces and punctuation, so `Product Name`, `product_name` and `productname` are one column. It also reads the Portuguese, Spanish, German and French spellings of the common ones.

| What we take | Columns we recognise |
| --- | --- |
| Identity | `id`, `sku`, `mpn`, `gtin`, `ean`, `reference`, `referencia`, `artikelnummer` |
| Name | `title`, `name`, `product_name`, `nome`, `nombre`, `titel`, `titre` |
| Description | `description`, `summary`, `descricao`, `descripcion` |
| Price | `price`, `regular_price`, `unit_price`, `preco`, `precio`, `preis`, `prix` |
| Sale | `sale_price`, with `sale_price_effective_date`, or `Date sale price starts` and `Date sale price ends` |
| Stock | `quantity`, `stock`, `inventory`, `qty`, `estoque` |
| Availability | `availability`, `in_stock`, `stock_status` |
| Links | `link`, `image_link` (kept only when they are `https` on a public host) |
| Barcode | `gtin`, `ean`, `upc`, `barcode`, `isbn`, `jan`, `ean13`, `gtin8` to `gtin14` |
| Brand | `brand`, `marca`, `marke`, `marque`, `vendor`, `manufacturer` |
| Part number | `mpn`, `manufacturer_part_number`, `part_number` |
| Condition | `condition` (`new`, `used`, `refurbished`, and their Portuguese, Spanish, German, French and Italian words) |
| Category, as a hint | `google_product_category`, `product_category`, `product_type`, `category` |

The sale price is the price while the sale runs, and the regular price before and after it, the same in both formats. A sale with no dates runs. Dates written without an offset (`2026-11-27/2026-11-30`) are read on your business's clock, a date alone meaning that whole day; a sale whose dates cannot be read is not taken to be on. A sale starts and ends here at the moment its dates give: the feed is read again then, and the price changes even if the feed cannot be read at that moment. A product whose only price is a sale that is not on is kept off sale.

A `cost` column is never read as a price: it is what you pay, not what you sell at. A product with no price is kept off sale until the feed gives it one.

### Barcodes

A barcode is read beside the identity, not instead of it: a sheet whose only code is its `ean` still has that code as the product's SKU, so an agent that orders by it is served. It is checked the way the networks check it: spaces and hyphens removed, a UPC whose leading 0 a spreadsheet dropped put right, an ISBN-10 read as its book barcode (never from a UPC column), and the last digit checked against the others. One that does not add up, a number a spreadsheet turned into `4.00638E+12` or `3017620422003.0`, a shop's own in-store code or a coupon is kept for you to read beside the product, and the product is listed without a barcode until it is fixed. A row that leaves the barcode, the brand or the part number out has not lost them: what an earlier read gave is kept. The category is a hint for later and never shown. Google's `identifier_exists` is read, and saying a product has no barcode stays yours to do, in the app.

### Prices

A price cell is read the way a person reads it. `12.99 EUR`, `EUR 12.99`, `€12,99`, `£9`, `1.234,56 €` and `R$ 49,90` all land on the right number and the right currency. Words around the number are ignored, so `12,99 € inkl. MwSt.` is twelve ninety-nine and not one thousand two hundred.

The decimal separator is decided by what follows it: two digits or fewer make it a decimal point, three make it a thousands mark. So `1.234,56` is one thousand two hundred and thirty-four, and `1.234` is one thousand two hundred and thirty-four as well, which is what a shop means by it.

A price is in the currency it names, by its ISO code (`45.00 QAR`, `KES 1,500.00`, any code in ISO 4217) or by its sign. A three-letter word that is not a currency code is ignored rather than believed, so `12.99 incl VAT` is not priced in VAT. Nor are the codes that are also words a price carries in capitals (`ALL`, `TOP`, `CUP`, `SOS`, `BAM`): if you price in one, set it as your currency and write the bare number.

The signs read are `€`, `£`, `$`, `¥`, `kr`, `zł`, `Kč`, `R$`, `KSh`, the dollar signs with their country's letters (`US$`, `A$`, `AU$`, `C$`, `CA$`, `NZ$`, `HK$`, `S$`, `MX$`, `NT$`, `RD$`, `TT$`, `J$`), `CN¥` and `JP¥`, `E£`, the signs of their own currency (`₹`, `₪`, `₺`, `₽`, `₴`, `฿`, `₱`, `₦`, `₡`, `₵`, `₸`, `₼`, `₾`, `₭`, `₮`, `৳`, `៛`, `֏`, `؋`, `₩`, `₫`, `₲`), `円`, `元` (and `圆`, `圓`), `원`, the full-width `＄`, `￥` and `￦`, and the Arabic abbreviations of the dirham, riyal, rial, dinar and pound (`د.إ`, `ر.س`, `ر.ق`, `ر.ع.`, `د.ك`, `د.ب`, `د.ا` or `د.أ`, `د.ع`, `د.ت`, `د.ج`, `د.م.`, `ل.د`, `ج.م`, `ل.ل`, `ل.س`, `ر.ي`; `ر.ع.` and `د.م.` with or without their last full stop). A sign several currencies write is your currency when yours is one of them: `$25.00` is Australian dollars for a shop in Australian dollars, and `199,00 kr` is Norwegian crowns for one in crowns. Otherwise `$` is US dollars, `kr` Swedish crowns, `£` pounds sterling, `¥` yen, `元` yuan and `C$` Canadian dollars. The rupee sign `₨` and the rial sign `﷼` are read only in your own currency, and any other currency sign, such as `¢`, is not read as a price.

If a price states no currency, your business currency is used, or the one you gave the feed.

Every price here is counted in its currency's own minor unit, as ISO 4217 counts it, by its code, its sign or as your feed's currency: cents for euros, whole yen (`4980 JPY`, `¥4,980` and `4,980円` are all ¥4,980), whole won (`₩12,000`), dong and guaraní, and thousandths for Kuwaiti and Bahraini dinars and Omani rials (`12.500 KWD` and `12.500 د.ك` are twelve and a half dinars). Never as euros, nor a hundred or a thousand times the amount. A code that is no currency a price is set in, a fund code such as `CLF` or a metal such as `XAU`, is not read as a price, and the product is kept off sale.

A price of nothing or less, such as a placeholder `0.00` or a refund's `-5.00`, is no price to sell at either: the product is kept off sale, with the price it last had, until the feed gives it a price again. A price left empty is different: the product keeps the price it last had, and stays on sale.

## What it never does

**It never touches a product you typed in.** A feed owns only the products it created. Anything you added by hand in Settings is invisible to it.

**It never deletes a product.** When something leaves the feed it is taken off sale and kept, because an order may point at it and a deleted product takes that order's history with it. If it reappears in the feed, it comes back.

**It never empties your shop on a short read.** A feed is read up to 5,000 products. If it hits that limit, nothing is deactivated, because a truncated read is not evidence that anything is gone.

**It never takes a sku another product owns.** If a product you typed in already holds that code, the imported one is stored without it rather than stealing it.

## Disconnecting, and connecting again

Disconnecting takes the feed's products off sale and keeps them. Connecting the same URL again adopts them back rather than importing a second copy of everything: a feed's products are identified by the feed's address, not by the connection, so the identity survives.

## When something is wrong

A feed that cannot be read says so on its row in Settings, with the reason. A row that cannot be made into a product is skipped and counted rather than guessed at, and the reason is one of: no identifier, no name, or an identifier already used earlier in the same feed.

If a row has an id column and that cell is empty, the row is skipped rather than falling back to the product's name. A name is not an identity: the day someone fixes a typo in it, a name-keyed product becomes a second product.

## Where a feed is fetched from

Only a public `https` address. An `http` URL is upgraded. Addresses on the machine or the network the Inbox runs on are refused, and a redirect is followed only as far as another public address, because a public URL that redirects to an internal one is how a server gets talked into fetching something it should not.

## What it does not do yet

A feed is one way. It tells your Inbox what you sell; it does not write anything back to your shop, and it does not carry orders in either direction. A platform connector that reconciles both ways is the next step. Ask for it on [the requests board](/requests/).
