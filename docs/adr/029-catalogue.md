# ADR-029 — The catalogue: a business's products on the networks it reports to

**Status:** accepted, 26 October 2026; Track 1 (the inbox's side) built 26 October 2026. The network's
side, the search tools and the order of offers are their own work.

## Context

A business with an inbox already lists its products at its own doors: `GET /v1/products` and MCP
`list_products`. People's assistants can only find them there once they know the business. The founder
asked for "a catalogue network, similar to merchant center from google, we allow the inbox owners to list
their products with, we can later match products by gtin". So a network should know what each business
sells, and be able to put the same product at several businesses side by side, without ever coming
between the business and its customer: the price that counts, and the order, stay at the business's own
door.

## Decision

1. **The network pulls a signed feed.** The inbox serves its products at `GET /v1/catalogue/changes`
   and by id at `GET /v1/catalogue/items`, each answer signed (`Catalogue-Signature`, a compact JWS by the
   receipt key the manifest publishes, `typ` `sdi-catalogue+jws`, over the domain, the address asked and
   the body's SHA-256). Any network can read the same feed, the inbox keeps no state per network, and the
   signature is the record of what the business stated and when. The manifest names the feed while the
   products are listed (`catalogue {feed, items}`).
2. **Three small signals.** The hourly signed ping carries `catalogue {listed, count, updated_at, rev}`, so
   a network reads the feed again when `rev` moved; `{listed: false}` once to a network last told they were
   listed. The owner's switch is told at once, with the signed
   `POST /v1/instances/{domain}/catalogue {"listed"}`, and by the hourly tick while a network was told
   something else. A network never told lists nothing, so one that should is told once.
3. **On by default** (the founder, 26 October 2026: "keep the product sync on by default"). *Your products
   on networks* (`settings.catalogue.listed`) is on for every inbox, old and new, unless the owner switches
   it off; each network has "List my products here" (`share.catalogue`, on), and each product "Keep it off
   networks" (`products.listed`). Products are listed only while the business is in that network's
   directory, and only from an inbox that can sign. Only the owner in person changes any of it: never the
   owner's AI, never a key handed to another system, and so never a customer's message.
4. **What a network is sent.** A product's public fields, as the business's own doors already show them:
   name, description, price, a picture link, its barcode, brand and part number, condition, its page on
   the business's own site, and in stock, out of stock or on sale. Never a stock count, the owner's lowest
   prices or costs, where a product was imported from, or anything about a customer. Listing is free, with
   no paid places, ever.
5. **One barcode check, two languages.** `normaliseGtin` in `@surfingdog/spec`, held to
   `vectors/gtin.json`, which the network's Go runs too: a barcode is kept as 14 digits only when its check
   digit holds and it is a product's barcode; a shop's own code or a coupon is kept for the owner to read
   (`gtin_given`) and never published. The owner's AI may only propose a barcode, which the owner confirms
   with one tap; feeds and connectors set one through the check; imported products' codes that look like
   barcodes become their barcodes only on the owner's one tap, offered once, and offered only when at least
   three of them pass the check and nine in ten do: any number passes it 1 time in 10, so a shop's own
   numbering would otherwise be matched to other businesses' products.
6. **The feed's order is the order of the writes.** Every statement that inserts a product, or changes
   what the feed shows of one, sets `products.catalogue_seq` to the next number, worked out inside that
   statement (`NEXT_CATALOGUE_SEQ`), and the feed's cursor is that position. A cursor on the time a
   product changed misses a change that a slow batch commits late, and re-reading a window behind it
   loops when a bulk import writes more than a page at one instant; the order the database commits in has
   neither problem. It is set by each writer rather than by a trigger, because on D1 a trigger's writes
   count in a statement's `changes`, which code reads as the rows it changed. A write that changes nothing
   the feed shows (a connector marking what it saw) leaves the position where it is.
7. **Orders stay at the door.** An assistant reads the live price at the business's own door
   (`list_products` with `ids`, or by `gtin`) and orders there, as today. Nothing about ordering changes.

## Consequences

- Migration 0026: the identity columns on `products` (`gtin`, `gtin_given`, `no_gtin`, `brand`, `mpn`,
  `condition`, `url`, `image_url`, `source_category`, `listed`, `catalogue_seq`), and what each network last
  said of the products on `network_status`. Nothing is backfilled. Every product writer sets
  `catalogue_seq`, the connectors' `upsertCatalogue` included when it lands.
- Feeds read the barcode beside the sku (the sku aliases stay, so an agent that orders by a sku equal to
  the barcode is still served), the brand, part number, condition and category hint, and keep the product
  page and picture links they used to drop. The Shopify, WooCommerce and Square connectors read theirs when
  they land.
- The owner sees, beside each product, what needs a look in plain words (a barcode that does not add up, a
  shop's own code, no price yet, a template's sample name, a network's own reason for holding one back), and
  the networks' answer under the switch.
- Spec 0.9: the catalogue's messages and schemas, the ping's and the answer's `catalogue`, the manifest's
  `catalogue`, `vectors/gtin.json` and `vocab/placeholder-titles.json` (protocol §4.18). A network or an
  inbox that knows none of it reads everything else as before.
