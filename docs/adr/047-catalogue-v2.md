# ADR-047 — Catalogue version 2: variants, price models, availability, age, shipping and returns

**Status:** accepted, 4 November 2026; the spec (protocol §4.18 as amended, `@surfingdog/spec` 0.15.0)
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
   check or not (`vocab/age-kinds.json`, `network: off`). A shop's other products list as before. The gate fails
   closed: the words a shop types for them (`tobacco`, `vape`, `firearms`…) are the vocabulary's `also` spellings of
   those kinds, and a kind the vocabulary does not know at all is held until the owner picks one.
5. **Returns outside the EU and the UK:** no returns, or a window under 14 days, shown as they are. The legal right of
   withdrawal is still enforced wherever the law gives one.
6. **Age-restricted offers are shown by default,** labelled "ID checked at handover: 18+". The owner picks each
   product's age (12 to 21, and by country up to 25); we keep no table of what any law says. An ID refused at
   handover counts against nobody (rules version 11, `order.id_refused`, reserved).
7. **"Few left"** (`limited`) only when the owner chose a mark of their own, and never a count.
8. **Shipping v1 is the owner's own rate tables:** flat, per item, by weight, by order value, free over a value. The
   owner buys and prints their own labels. No carrier is called.
9. **Defaults accepted:** a description of up to 5,000 characters; a producer that served version 1 serves it for 12
   months after it first serves version 2 (one that never served version 1 may serve version 2 alone from the
   start); age-restricted parcels go only on a carrier service the owner marks as checking ID.
10. **What the first outside producer met, put right in the spec:** canonical JSON defined (RFC 8785) with a signature vector to sign
    against byte for byte; ids of up to 256 characters; one page size, 500, in the prose and the schemas;
    `no_gtin` and `on_sale` defined; `url` absolute and `price.value` in minor units, said plainly; a catalogue-only
    member lists `item_types: []`; the cursor rule; `manifest_sha256` and `body_sha256` over the bytes as served;
    and the order in which a signing key is replaced. A review of the spec against that producer added: `url` and
    the manifest's addresses carry their https grammar in the JSON Schemas too; a character is a Unicode code point
    everywhere; the signed `url` is the request target as received, compared byte for byte, with ids encoded one
    way; `iss` is the member's registered domain, never the feed's host; and a network's held reasons carry a code.

And of this design:

11. **Versions are named, never guessed.** The manifest lists the versions a feed serves (`catalogue.versions`,
    absent `[1]`), a reader names the one it reads (`version=N`), and a producer that lists `[2]` alone answers an
    unversioned read `422 version_required`, so no reader of version 1 can take its offers for version 1's. Cursors
    belong to their version. A reader whose version for a source changes reads it all again.
12. **One shape for shipping and returns.** The signed policies document (`catalogue.policies`) is the only
    published shape of shipping profiles, return policies and carriers; later order versions refer to it.
13. **A reader reads each item alone.** An item whose core (its id, name, price, availability, dates, age, ways and
    named policies) does not read, or whose price does not hold together, is held with the path of what did not
    read, and the rest of the page kept; a member that only adds to it (a link, a picture, a text, a "was" or unit
    price) and does not read or hold is dropped alone. A profile or policy the document does not have holds the
    offer: it is never read as the default, so a part of the document a reader dropped never shows another's rates
    or terms. Every problem of an item, a group or the policies document has one code, its effect and words for
    the owner in one registry (`CATALOGUE_V2_PROBLEMS`), which the ping's held entries and `check_catalogue` name.
14. **Version 1 says only what it can say truly.** A version 1 page withdraws what version 1 would misstate: a
    price not fixed, a pre-order or back-order, something made to order, an age-restricted offer, an offer with its
    own tax basis. What it says changes only when the offer does, or at its `available_until`, when the producer
    gives it a new position; version 1's cursors keep never expiring.
15. **The vectors are written by an implementation of their own,** in Python's standard library, its own Ed25519
    included; the inbox's TypeScript and the network's Go are each held to them.
16. **Time is a change.** At an offer's `available_until`, and at a pre-order's `available_from`, the producer gives
    it a new position, and a reader applies both on its own clock too.
17. **Postcodes as the post reads them.** In the United Kingdom and the Crown Dependencies a prefix matches by outward
    code, so a Highlands surcharge on `PH20` never lands on Perth's `PH2`.
18. **The right to withdraw, per offer.** An offer may say whether the legal right of withdrawal runs for it, or which
    exception the law allows (`withdrawal`, the inbox's own list); a reader says only what that supports, and for an
    offer that says nothing, only that the law may give one.

## Consequences

- A producer is told every field name the day this merges, may serve version 2 alone, and switches on once the
  network reads version 2. Its offers are then read once, as version 2.
- Every offer's hash changes once, at version 2. A network keys its record of price changes on the version, so the
  change of shape never reads as a change of every price.
- A "was" price imported from a shop is not shown for the reduction already running when a network first reads the
  shop (`list_price_never_seen`), nor for one that begins less than 30 days into the network's record
  (`list_price_history_short`). Waiting does not change it: it shows for a later reduction, from a price held at or
  above it for 30 days. An owner may read that as a fault, so the owner's page says why, by its code.
- A unit price is only as right as the quantity the owner typed: the arithmetic cannot catch a wrong one.
- An age is declared, never checked by us: the business, or a carrier service it marks as checking ID, checks it.

## Not decided here

- Prescription-only medicines (excluded until decided). Price tiers, price per hour or per person, subscriptions,
  rentals, dated sessions, translations, categories, properties and lead times are later fields.
- How the network's `check_catalogue` lists `{id, held: code}` per item, and the owner's screens for options, prices,
  ages, shipping and returns, belong to the builds that read and write version 2; the codes are this spec's.
