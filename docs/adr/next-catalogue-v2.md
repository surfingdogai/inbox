# ADR-next — Catalogue version 2: variants, price models, availability, age, shipping and returns

**Status:** proposed, 2 November 2026; the spec (protocol §4.18 as amended, `@surfingdog/spec` Unreleased)
written. Its number, the spec's version and the protocol section's are given when it merges. The network's
intake of version 2 and the inbox's own version 2 feed are their own work. Builds on
[ADR-029](029-catalogue.md) (the catalogue), [ADR-036](036-money-policies-schedules.md) (money in minor units)
and ADR-017 Amendment 7 (rules version 11).

## Context

Catalogue version 1 holds one offer at one price, available or not. Goods shops sell by more: a product with
sizes and colours, a price from or on request, a sale price, a price per kg, a pre-order, an age check, a
delivery rate and a return window. Google Merchant Center, OpenAI's product feed and Stripe's catalogue feed all
carry these, and an import that flattens them loses them. The first outside shops to list their products serve
version 2 only, so a network has to read version 2 before it reads them, and read each of them once.

## Decisions

The founder's, in chat, on the plan of 31 October 2026:

1. **Variants now.** A product group, with the options that set each variant apart (`group {id, title, position}`,
   `options [{key, name, value}]`), at most 250 variants a group. Option keys are open: `vocab/option-keys.json`
   names the shared ones and any other lower-case name is the business's own. Rules version 11 shows one business's
   group as one result, keyed `group:<business>:<group.id>`.
2. **No price of 0.** A listed price is at least 1 minor unit; anything free stays in messages. A price on request
   (`price_model: quote`) has no price at all, never 0.
3. **A "was" price** only when the offer was at or above it for the whole of the 30 days before its price first went
   below it: the EU's rule, applied everywhere. A reader shows it only when its own record says so, and an inbox
   refuses to publish one that fails.
4. **Regulated goods off the network.** Tobacco and nicotine, cannabis and weapons are kept off at product level, ID
   check or not (`vocab/age-kinds.json`, `network: off`). A shop's other products list as before.
5. **Returns outside the EU and the UK:** no returns, or a window under 14 days, shown as they are. The legal right of
   withdrawal is still enforced wherever the law gives one.
6. **Age-restricted offers are shown by default,** labelled "ID checked at handover: 18+". The owner picks each
   product's age (12 to 21, and by country up to 25); we keep no table of what any law says. An ID refused at
   handover counts against nobody (rules version 11, `order.id_refused`, reserved).
7. **"Few left"** (`limited`) only when the owner chose a mark of their own, and never a count.
8. **Shipping v1 is the owner's own rate tables:** flat, per item, by weight, by order value, free over a value. The
   owner buys and prints their own labels. No carrier is called.
9. **Defaults accepted:** a description of up to 5,000 characters; an inbox serves version 1 for 12 months after it
   first serves version 2.
10. **What the first outside producer met, put right in the spec:** canonical JSON defined (RFC 8785) with a signature vector to sign
    against byte for byte; ids of up to 256 characters; one page size, 500, in the prose and the schemas;
    `no_gtin` and `on_sale` defined; `url` absolute and `price.value` in minor units, said plainly; a catalogue-only
    member lists `item_types: []`; the cursor rule; `manifest_sha256` and `body_sha256` over the bytes as served;
    and the order in which a signing key is replaced.

And of this design:

11. **Versions are named, never guessed.** The manifest lists the versions a feed serves (`catalogue.versions`,
    absent `[1]`), a reader names the one it reads (`version=N`), and a producer that lists `[2]` alone answers an
    unversioned read `422 version_required`, so no reader of version 1 can take its offers for version 1's. Cursors
    belong to their version. A reader whose version for a source changes reads it all again.
12. **One shape for shipping and returns.** The signed policies document (`catalogue.policies`) is the only
    published shape of shipping profiles, return policies and carriers; later order versions refer to it.
13. **A reader reads each item alone.** An item that does not read, or whose price does not hold together, is held,
    and the rest of the page kept; a field that does not hold (a "was" or unit price, a profile the document does
    not have) is dropped alone. Every problem has a code and words for the owner (`CATALOGUE_V2_PROBLEMS`).
14. **Version 1 says only what it can say truly.** An inbox's version 1 page withdraws what version 1 would misstate:
    a price not fixed, a pre-order or back-order, something made to order, an age-restricted offer.
15. **The vectors are written by an implementation of their own,** in Python's standard library, its own Ed25519
    included; the inbox's TypeScript and the network's Go are each held to them.

## Consequences

- A producer is told every field name the day this merges, may serve version 2 alone, and switches on once the
  network reads version 2. Its offers are then read once, as version 2.
- Every offer's hash changes once, at version 2. A network keys its record of price changes on the version, so the
  change of shape never reads as a change of every price.
- A "was" price imported from a shop is held from view at first: the record it needs takes 30 days to build. An owner
  may read that as a fault, so the owner's page says why.
- A unit price is only as right as the quantity the owner typed: the arithmetic cannot catch a wrong one.
- An age is declared, never checked by us: the business, or a carrier service it marks as checking ID, checks it.

## Not decided here

- Prescription-only medicines (excluded until decided). Price tiers, price per hour or per person, subscriptions,
  rentals, dated sessions, translations, categories, properties and lead times are later fields.
- The network's machine-readable reason per item in `check_catalogue`, and the owner's screens for options, prices,
  ages, shipping and returns, belong to the builds that read and write version 2.
