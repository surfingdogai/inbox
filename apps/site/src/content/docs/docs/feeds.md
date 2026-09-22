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
| Price | `sale_price` first, then `price`, `preco`, `precio`, `preis`, `prix` |
| Stock | `quantity`, `stock`, `inventory`, `qty`, `estoque` |
| Availability | `availability`, `in_stock`, `stock_status` |
| Links | `link`, `image_link` |

The sale price wins over the list price, because it is what you are actually selling at today.

### Prices

A price cell is read the way a person reads it. `12.99 EUR`, `EUR 12.99`, `€12,99`, `£9`, `1.234,56 €` and `R$ 49,90` all land on the right number and the right currency. Words around the number are ignored, so `12,99 € inkl. MwSt.` is twelve ninety-nine and not one thousand two hundred.

The decimal separator is decided by what follows it: two digits or fewer make it a decimal point, three make it a thousands mark. So `1.234,56` is one thousand two hundred and thirty-four, and `1.234` is one thousand two hundred and thirty-four as well, which is what a shop means by it.

If a price states no currency, your business currency is used. A three-letter word that is not a real currency code is ignored rather than believed, so `12.99 incl VAT` is not priced in VAT.

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
