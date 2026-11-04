# @surfingdog/spec (MIT)

The open formats of Surfing Dog Inbox, so anyone can implement a compatible instance, agent,
or network:

- the discovery manifest (`/.well-known/…`, see ADR-002),
- the receipt format (compact JWS, Ed25519) and its counter-signature (ADR-016), and receipt
  claims v2 (ADR-017 §3.2),
- every message an inbox exchanges with a network (ADR-017 §7): registration and the ping,
  persons, presentations, passes, delegations, recovery, reports and contests, the directory and
  the published rules — described for people in [`docs/protocol/network.md`](../../docs/protocol/network.md),
- the tools a network offers assistants at `/mcp` (ADR-017 A2.7): what each takes and answers,
- protocol 0.2: doors, readiness levels, listing fields, entries a network found on businesses'
  own websites, claims (`register_business`, `update_business`) and rules version 7, with
  version 8, version 7 amended before it took effect (ADR-017 Amendment 4): a record on the
  business's own word alone shows its counts and no score, and the bounds on what a network takes,
- 0.3 (optional for a network): capabilities and the agentic score (`check_business`, the score's
  published rules, result pages and leaderboards), and the discovery documents an agent reads to find a network,
- 0.3.1: the manifest's optional `doors_elsewhere`, the kinds of request a business takes somewhere
  else and where, read with `readDoorsElsewhere` (`vectors/doors-elsewhere.json`). A manifest
  without it reads as before.
- 0.4 (optional for a network): door reports, how an agent says each use of a business's door went,
  done or not (`POST /v1/door-reports`, the `report_door` tool, a strict body that can carry nothing
  about a person), the classes they use (`vocab/door-report-classes.json`), the `doors` block a signed
  ping's answer gives the business, the `report` hint on a network's answers, and how a network's
  own reads move a door between live, failing and gone (`readDoorReports`, `doorReportEffect`,
  `classifyDoorRead`, `doorStatusAfter`; `vectors/door-reports.json`).
- 0.5: `orderable` is a level of its own, the same rung as `bookable`, for doors that take orders
  and none that books; `level=bookable` and `level=orderable` filter by what the doors take, so
  `level=bookable` no longer returns a shop whose doors take orders alone; and a UCP or ACP profile
  raises a business only on a site that shows it sells (Product markup with a price, another door
  of its own that takes orders, or, since 18 October 2026, a product for sale in the catalogue its
  UCP profile names, when that catalogue is the site's own). A reader pinned to 0.4 rejects
  `orderable`.
- 0.5.1 (optional for a network): a door's history from the network's own reads (`door_history` on
  a listing's detail, `get_business` and a check result; `doorHistorySchema`, `doorHistoryOf`;
  `vectors/door-history.json`). An answer without it reads as before.
- 0.6 ([ADR-021](../../docs/adr/021-the-reference.md)): the capability vocabulary, version 2
  (`vocab/capabilities.json`; version 1 kept as `vocab/capabilities-v1.json`): for each capability a
  definition, other words for it, what partial means, what has to be seen at each step of the
  evidence ladder, what is not enough, and how each kind of door carries it, by example names that
  the network's own door registry reads as that capability. The conformance check (`checkManifest`,
  `checkReceipt`, `checkAcknowledgement`, `checkDocument`), which says whether a document holds to
  these specs and why not, with the codes a network answers. How a door's names are read as
  capabilities, as vectors (`vectors/capability-names.json`, from the network). The census's data
  (`census-edition`, `census-editions`, an example in `vectors/census-edition.json`, and the MCP tool
  `get_census`; protocol §4.16, optional for a network), and the score rules version 3 it is counted
  under (`vocab/score-rules-v3.json`, as revised on 15 and 18 October 2026). Every JSON Schema but
  the MCP tools' now carries a `$id`, its address at `https://surfingdog.ai/spec/schemas/<name>.json`.
  In the vocabulary's and the census's schemas a capability, a kind of door and a scope are any
  lower-case name, so a later version that adds one still validates. `verifyReceipt` in
  `@surfingdog/sdk` reads amendments and refunds, as the check does.
- 0.7: how a business is paid. `vocab/payments.json` version 2 (every token with an English label,
  a bank transfer apart from SEPA, ways people pay in every region (M-Pesa, Interac, Venmo, Cash App,
  Zelle, Bizum, PayNow, PromptPay, GCash, PayPay, KakaoPay, Mercado Pago, OXXO), Afterpay, Affirm,
  Tabby, Tamara, Stripe Link, Amazon Pay, Visa Intelligent Commerce and Mastercard Agent Pay, and the
  UCP payment handler names a network reads, `handlers` and `handlers_last`); `PAYMENT_TOKENS`,
  `MAX_PROFILE_PAYMENTS`, `paymentLabel`, `paymentToken`, `isPaymentToken` and `sortPaymentTokens`;
  a profile's `payments`, at most 64 (`vectors/profile.json`); each payment of a listing with its
  evidence, declared by the business or only seen (`accepts.pay_with`, also on a check result as
  `pay_with`); and the census's payment metrics (`pay_read`, `pay:<token>`, `pay_declared:<token>`,
  and an edition's `payments`). A 0.6 reader of manifests, profiles and listings ignores what it does
  not know. A 0.6 reader that validates census editions against `schemas/census-edition.json` must
  move to 0.7: 0.6's metric pattern names its metrics one by one and refuses `pay_read`. From 0.7 the
  metric pattern is any lower-case name with at most one key after a colon, and `pay_with.via` any
  lower-case name, so a metric or a source of evidence added later validates: a reader skips one it
  does not know. With it, optional for a network ([ADR-024](../../docs/adr/024-owners-in-control.md)):
  a business's inbox found from its domain (`discovery-result`, the MCP tools `check_dns` and
  `start_inbox`, `vectors/discovery.json` and `vectors/discovery-words.json`; protocol §4.14a), and
  the owner's page in a listing's `owner.manage`.
- 0.8 (optional for a network): carried requests ([ADR-025](../../docs/adr/025-carried-requests.md)): `ask_business`, `request_quote` and
  `request_booking` carry a person's request to a business's own inbox (`schemas/mcp-ask-business-*`,
  `mcp-request-quote-*`, `mcp-request-booking-*`); the manifest's `carried_requests`, which an inbox with
  the owner's switch publishes either way (a network carries nothing to a manifest without it); the
  `Surfing-Dog-Carried` and `Surfing-Dog-Carried-For` headers a carried request comes with; and the
  `carried` counts a signed ping's answer gives the business. Over MCP a network may leave out the `report` hint, and may answer `initialize` with a
  signed session id used only for its limits.
- 0.8.1 (optional for a network): the reporters' reading allowance (protocol §4.15,
  [ADR-019](../../docs/adr/019-door-reports.md) Amendment 1, accepted 19 October 2026), a larger
  reading allowance for agents whose signed door reports, about businesses their own signed reads
  found, earn the points: the reference network's rule (`REPORTER_CREDIT_RULE`, `READ_ALLOWANCE`),
  `ReporterCreditRule`, `reporterCreditOf(days, rule?)` and `doorReportEarns`, the answer of
  `GET /v1/door-reports/me` (`doorReportsMeSchema`, `DoorReportsMe`, `schemas/door-reports-me.json`;
  `401 signature_required` unsigned) and the vectors that pin it (`vectors/door-reports.json`'s
  `contributors`); and a published limit of 600 requests a minute on `GET /v1/businesses` and
  `GET /v1/businesses/{domain}` (§4.7). Nothing earlier changes.
- 0.8.2 (optional for a network): listing rules. The score rules' `listing` (`vocab/score-rules-v3.json`, as amended on
  19 October 2026: who a network's directory lists and its leaderboards name, real businesses above the rest); a
  leaderboard row's `real_business`, `order_by`'s `real_business` and the home-page list `scope.real` (`?real=1`); and
  `/v1/stats` `directory.real_businesses_verified`, given only while the rules are applied. A row without
  `real_business` reads as before.
- 0.9 (optional for a network and for an inbox): the catalogue (protocol §4.18,
  [ADR-029](../../docs/adr/029-catalogue.md)). An inbox whose owner lists its products on networks serves a
  signed feed of them, `GET /v1/catalogue/changes` and `GET /v1/catalogue/items` (`cataloguePageSchema`,
  `catalogueItemsSchema`, `schemas/catalogue-page.json`, `schemas/catalogue-items.json`), signed in
  `Catalogue-Signature` (`CATALOGUE_SIGNATURE_TYP`, `catalogueSignatureSchema`); its manifest names them
  (`catalogue {feed, items}`); its signed ping carries `catalogue` (`pingCatalogueSchema`) and a signed ping's
  answer may carry the network's (`pingCatalogueAnswerSchema`); the owner's switch is
  `POST /v1/instances/{domain}/catalogue` (`schemas/catalogue-switch-request.json`). One barcode check for
  both sides: `normaliseGtin`, `gtinCheckDigit`, `expandUpcE`, `gtinDisplay` and `GTIN_PREFIXES`, held to
  `vectors/gtin.json`; and the names a template gives its sample products (`vocab/placeholder-titles.json`,
  `isPlaceholderTitle`). A ping, an answer or a manifest without `catalogue` reads as before.
- 0.10 ([ADR-035](../../docs/adr/035-doors-elsewhere-platforms.md)): a door elsewhere may name its platform. A
  `doors_elsewhere` entry's optional `platform` is a token of `vocab/door-platforms.json` (Fresha, OpenTable,
  TableCheck, Toast, Shopify, Cloudbeds and others: each with its hosts, the kinds of request it takes and how a
  business's own page there is told apart from the platform's own pages), so an agent can say "Book at Fresha"
  rather than a host. `readDoorsElsewhere` keeps it only when the vocabulary knows it, the platform takes that kind
  and the URL is the business's own page there (one of the platform's `pages`, or past its home and its reserved
  names), or, for a platform that serves pages on the business's own domain, the URL's host is on the website the
  manifest's `profile.url` names; otherwise it drops the platform alone and keeps the door. `doorPlatformOf`,
  `doorPlatformFit`, `doorPlatformHolds`, `doorPlace`, `doorTrackingParams`, `cleanDoorUrl` and `ownSiteDomain` say
  the same for anyone else, and a door carries no tracking or affiliate parameter (`tracking_params`). A 0.8 reader
  ignores `platform`; a 0.8 manifest reads as before. The spec's own examples (a time zone, an amount) no longer name
  one country, and minor units follow each currency's ISO 4217 exponent.
- 0.11 ([ADR-036](../../docs/adr/036-money-policies-schedules.md)): money in every currency's own minor unit: a
  `money.value` is an integer count of the ISO 4217 minor unit of its `currency` (4500 is KSh 45.00,
  ¥4,500, KWD 4.500), read with `minorUnits`, `decimalOf`, `parseDecimal` and `shareOf` (the exponent
  table is `ISO_4217_MINOR_UNITS`; fund codes, metals and "no currency" are not money a price is in).
  A reader on 0.10 that assumed hundredths for every currency must move: its amounts were already in
  minor units for every currency it took. Policies as data (`policySchema`: steps before a start, fees
  `none`, `percent`, `amount`, `units` or `full`, a no-show fee and whether a deposit is refundable; a
  dated policy, `datedPolicySchema`), and payment schedules in UCP's `payment.terms` shape
  (`paymentScheduleSchema`: `immediate`, `deferred` or `at_property`; `scheduleProblem`, the invariant
  that the schedules add up to the total). Stays ([ADR-037](../../docs/adr/037-stays.md)), below.
- 0.12 ([ADR-039](../../docs/adr/039-trades.md)): trades and projects. Files on a request
  (`attachmentRefSchema`: JPEG, PNG, WebP or PDF by their first bytes, at most six of 10 MB, and room of
  their own for files waiting for a request, `ATTACHMENT_LIMITS`); where a business works, as it says so in public (`areaSummarySchema`: a radius in
  km or postal prefixes, never the place a radius is measured from; `checkAreaInputSchema` and
  `checkAreaOutputSchema` for `check_area`; a site told as a band, `areaCheckSchema`); the job a request
  for a price describes (`jobSchema`: urgency, visit, site, up to three windows, a budget range); a trade's
  quote (`tradeQuoteSchema`: estimate or fixed, stages on the 0.11 payment schedule, call-out and visit
  fees already taken off the total or paid apart, tax included or not, the total always what the
  customer pays with its tax; a line's `quoteLineKindSchema`); and how a trade takes work
  (`workProfileSchema`, `get_business_profile`'s `work`). Schemas: `attachment-ref`, `area-summary`,
  `job`, `trade-quote`, `work-profile`, `mcp-check-area-input`, `mcp-check-area-output`.
- 0.12 ([ADR-040](../../docs/adr/040-food.md)): restaurants, takeaways, bakeries and cafés. The allergen
  vocabulary (`vocab/allergens.json`: 46 codes in seven languages, with the lists the EU, the UK, the US,
  Canada, Australia, New Zealand and Japan name and their sources; `expandAllergens` reads a part as its
  whole, `jurisdictionOf` gives a country's list) and a dish's allergens with whether the business
  confirmed them (`allergenInfoSchema`); the menu as `get_menu` gives it (`getMenuOutputSchema`: sections,
  option groups with what each choice adds and halves, dietary tags, an age limit, dayparts, sold out
  today); slots to collect or have it delivered (`listOrderSlotsInputSchema`, `listOrderSlotsOutputSchema`,
  a zone with its fee and minimum); an order line's options, note and brief (`lineOptionSchema`,
  `lineBriefSchema`); an order's fulfilment, tip and progress inside fulfilling (`fulfilSchema`, `tipSchema`,
  `orderProgressSchema`); a kitchen in the business profile (`kitchenProfileSchema`); and a table service's
  rules (`tableRulesSchema`). Schemas: `allergen-info`, `fulfil`, `order-progress`, `kitchen-profile`,
  `table-rules`, `mcp-get-menu-input`, `mcp-get-menu-output`, `mcp-list-order-slots-input`,
  `mcp-list-order-slots-output`.
- 0.12.1 (optional for a network and for an inbox): a catalogue offer may be a pack (protocol §4.18). A listed
  item's optional `multipack` (`CATALOGUE_MULTIPACK_MAX`, in `schemas/catalogue-page.json` and
  `schemas/catalogue-items.json`) is how many identical units of one item, the one its `gtin` names, the offer
  is: 2 to 10,000 a pack, absent or 1 one. The barcode still names the item, so twelve bottles sold as a case
  under the bottle's barcode are `multipack` 12, and a case's own barcode with `multipack` 1 is one case. Two
  offers are one product only with the same barcode and the same `multipack`. A 0.12.0 reader ignores it; a
  feed without it reads as before.
- 0.13 ([ADR-045](../../docs/adr/045-stripe-pay.md)): Stripe Pay, Stripe's transfer between Stripe accounts to a
  business's Stripe profile. `vocab/payments.json` version 3 adds `stripe_pay` among the ways a person pays (no mark
  or handler reads it: only the business's own word declares it); a profile's optional `pay_to`
  (`payToSchema`, at most `MAX_PAY_TO`), where to send a way paid to an address of the business's own, read with
  `readPayTo` (`PAY_TO_METHODS`, `stripePayRecipient`, `STRIPE_PAY_CURRENCIES`; `vectors/profile.json`); and a
  listing's `pay_with` entry may carry `to` and `currencies`, from a member's manifest only. A 0.12 reader ignores
  `pay_to` and the new members, and reads `stripe_pay` as a token it does not know.
- 0.13.1 (optional for a network and for an inbox): kinds of business. `vocab/business-kinds.json` version 1
  (`BUSINESS_KINDS`, `businessKind`, `isBusinessKind`, `KIND_LABEL_MAX`), 574 kinds with their names in five
  languages, and `kindCategories`, how an inbox publishes a business's kind in its profile's `categories`. A
  0.13 reader reads `categories` as before.
- 0.14 (optional for a network and for an inbox): rich listings. A profile may say what a place that serves
  food cooks (`cuisines`: at most five slugs of `vocab/cuisines.json`, 117 of them, regional and dishes, with
  labels in English, Portuguese, Spanish, French, German, Italian and Dutch, synonyms, OpenStreetMap `cuisine=`
  values, schema.org `servesCuisine` strings and the Overture place categories whose places serve each;
  `readCuisines`, `readCuisineTerm`, `cuisineLabel`), how it takes tables (`reservations`: `required`,
  `recommended`, `accepted` or `walk_in_only`), up to 600 characters of the business's own words
  (`description`, 500 before), and where each field came from (`sources`: the business's own word, saved by its
  owner, or its website, read and not yet checked, with the page and when). `vocab/attributes.json` version 2
  files a cuisine as the attribute `cuisine=<slug>`, of a new type, `set`: up to five values of another
  vocabulary (`values_from`); `GET /v1/attributes` lists it as an `enum` of those values, with `values_from`.
  Vegan and vegetarian named as a cuisine read as their diet attribute; halal and kosher are never read from
  one. Each field is checked and dropped alone, so a 0.13 reader ignores them (`vectors/profile.json`), and
  cuts or drops a description over 500 characters.

- 0.15 ([ADR-047](../../docs/adr/047-catalogue-v2.md); optional for a network and for an inbox): catalogue version 2 (protocol §4.18, as amended).
  The manifest's `catalogue` gains `versions` (absent: `[1]`) and `policies`; a reader names the version it reads
  (`version=2`, `catalogueVersionsOf`, `catalogueVersionToRead`), and a producer that lists `[2]` alone answers a read
  that names none `422 version_required`. A page (`cataloguePageV2Schema`, `schemas/catalogue-page-v2.json`) carries
  `catalogue.policies_rev`; products by id answer `{version, items, missing}` (`catalogueItemsV2Schema`,
  `schemas/catalogue-items-v2.json`). An offer (`catalogueListedItemV2Schema`) gains `group {id, title, position}` and
  `options [{key, name, value}]` (at most 250 variants a group, `CATALOGUE_GROUP_MAX`; keys from
  `vocab/option-keys.json`, `OPTION_KEYS`, `optionKeyOf`), `price_model` (`fixed`, `from`, `range`, `quote`, whose `price`
  is `null`), `price_max`, `list_price` (shown only under the 30-day rule, `wasPriceOf`), `unit_price
  {measure, reference}` (`unitPriceOf`, `UNIT_PRICE_UNITS`), `tax_included`, the availabilities `limited`, `preorder`,
  `backorder` and `made_to_order` with `available_from` and `available_until`, `is_bundle`, `media`
  (in place of `image_url`; every address in the https grammar of `CATALOGUE_URL_PATTERN`, `catalogueUrlSchema`, which
  the JSON Schemas carry as `pattern`), `age_restricted {min_age, kind, by_country, check}` (kinds from
  `vocab/age-kinds.json`, `AGE_KINDS`, with their `also` spellings, `ageKindOf`; tobacco and nicotine, cannabis and
  weapons kept off networks, and a kind it does not know held, `AGE_KINDS_OFF`, `ageKindIsOff`; `ageLabel`, `ageFor`),
  `fulfil_methods`, `shipping_profile`, `weight`, `return_policy` and `withdrawal` (the legal right to withdraw, or the
  exception the law allows); ids of up to 256 printable ASCII characters (`catalogueIdV2Schema`; `ids=` written by
  `catalogueIdsParam`) and descriptions of up to 5,000 characters, a character a Unicode code point. The policies
  document (`cataloguePoliciesSchema`, `schemas/catalogue-policies.json`), signed: shipping profiles of the owner's own
  rates (flat, per item, by weight, by order value, free over a value; `readCataloguePolicies`, `quoteShipping`, which
  takes an age-restricted line only by an ID-checked service; postcodes by `postcodeOf` and `postcodeMatches`, British
  ones by outward code; carriers from `vocab/carriers.json`, `CARRIERS`, `trackingUrl`) and return policies. How a
  reader takes each item (`readCatalogueItemV2`: a core member that does not read holds it, with its JSON Pointer; a
  member that only adds is dropped alone) and each group (`readCatalogueGroups`), every problem's code in one registry
  (`CATALOGUE_V2_PROBLEMS`, which the ping's `held[].code` names); the "was" price's codes (`wasPriceOf`); the version 1
  item a producer that served version 1 serves for 12 months (`catalogueItemV1Of`); canonical JSON, RFC 8785
  (`canonicalJson`, `sha256Text`, `catalogueItemHash`), numbers by their value. In both versions: one page size,
  500; the cursor rule, and two ways to meet it; `cursor_invalid` and `limit_invalid`; `body_sha256` and
  `manifest_sha256` over the bytes as served; the signed `url` as received, byte for byte; and the order to replace a
  signing key in. Version 2 cursors alone expire (`cursor_expired`, after 7 days at the earliest). A version 1 reader
  reads a version 1 feed as before; a manifest without `catalogue.versions` reads as before.

A version number is given when a change merges, in the order changes merge. Work in progress names no number, so
two changes built side by side never claim the same one.

## Stays (0.11)

A place to stay answers in its own inbox (`src/stays.ts`). Everything here is additive: a reader on
0.10 ignores what it does not know.

- **The item type `stay`.** A stay's dates are the property's local dates (`YYYY-MM-DD`); its nights
  are their difference, never minutes, so no change of clocks moves one. Its start and end are the
  check-in date at the property's check-in time and the check-out date at its check-out time, with
  the zone's offset on each day (`vectors/stay-nights.json`). Receipts may name `typ: "stay"`; they
  record no outcome codes yet: a network takes stays' outcomes only under rules that say so.
- **The quote** (`stayQuoteSchema`): every line in the total, taxes and fees paid at the property
  included (marked `collected: at_property`); the rate plan; the cancellation policy dated for these
  dates (`datedPolicySchema`); the payment schedule, `immediate`, `deferred` or `at_property` as UCP's
  `payment.terms`; whether a card holds the stay; and until when it can be accepted. It holds
  together when `checkStayTotals` finds nothing: the lines add up to the total, the schedule does too,
  what is collected at the property is left for it, one currency throughout, no fee above the total,
  the steps in order and before arrival, and it can still be accepted, only until before arrival
  (`vectors/stay-totals.json`, in JPY and KWD among others). An estimate (`stayEstimateSchema`,
  `binding: false`) is the property's rates before it answers: never an offer.
- **Policies** for stays are presets (`stayPolicySteps`: free until N days before arrival, then the
  first night, half or the full stay; non-refundable; up to four steps of your own), each step ending
  at 23:59:59 local on its day, whatever the clocks do that day (`vectors/stay-policy.json`, in zones
  with half-hour daylight saving, changes at midnight and the date line).
- **What an agent reads**: the property (`propertyPublicSchema`: rooms, rate plans, extras, taxes and
  fees, children, pets, house rules, how to find it, how it confirms, how soon it answers, and a
  short-term rental registration number where one is required; never its private arrival details)
  and what is free (`stayAvailabilitySchema`: per room type and rate plan, `instant` with an offer to
  hold and book, `on_request` with an estimate, or `unavailable`; `likely_taken` when another of the
  property's calendars shows the nights as taken). The words come from `vocab/lodging.json`: kinds,
  beds, amenities, meals, house rules, how a tax or fee is charged, and on-property extras only (no
  transfer, tour or car hire is on it, so a stay never bundles another trader's travel service).
- **The manifest** may list `stay` in `item_types`, with a `stay` door (`{mode, answers_within_h,
  secure, currencies}`), and its profile a `lodging` (`profileLodgingSchema`: kind, rooms, check-in and
  check-out, how it confirms, how soon it answers, a registration number). `doors_elsewhere` may name
  `stay` with an optional `url_template`, the property's own booking engine's deep link: a reader keeps
  it only when, filled in, it is an https URL on the entry's own host, fills `{check_in}`,
  `{check_out}`, `{adults}`, `{children}` and `{rooms}`, and drops any other `{…}`
  (`fillStayTemplate`; `vectors/doors-elsewhere-stay.json`).
- **Carried** (`request_stay`, `schemas/mcp-request-stay-*`): a network may carry a person's request
  for a stay to the property's own inbox as it carries a booking request (0.8).

Everything here is published, byte for byte, at https://surfingdog.ai/spec/ (the files under
`/spec/schemas/`, `/spec/vectors/` and `/spec/vocab/`, the vocabulary's versions at
`/spec/capabilities/v<N>.json` and the latest at `/spec/capabilities.json`, and `/spec/index.json`,
which lists them), readable from any origin, with a page for people for each spec and a page that
checks a pasted manifest, receipt or acknowledgement in the browser.

The Zod schemas in `src/` are the source; `schemas/` holds one JSON Schema per message, generated
from them. `vectors/` holds the test vectors, which decide any difference between two
implementations:

| File | What it pins down |
|---|---|
| `receipts.json` | receipts and acknowledgements (ADR-016): fixed keys, the `sub` derivation, JWS any Ed25519 implementation must reproduce byte for byte, and the refusals |
| `receipts-v2.json` | v2 claims: every promise kind and every outcome an inbox records, an acknowledgement naming a pass (`pas`), the refused claims with their codes, §3's outcome table, and every path through the booking and order machines with the outcome it records |
| `signatures.json` | RFC 9421 requests: sdi-instance/1, sdi-agent/1 with a self-held key and with Web Bot Auth (both `Signature-Agent` forms), forwarded signatures (`agent_key`), and refusals with their codes |
| `passes.json` | key, pass and pass-reference strings, `ppid`, `email_mac`, and 43 email normalisation cases |
| `scoring.json` | the network's scores (ADR-017 §5): every worked example, the R5 grid, ageing, hold and release |
| `ordering.json` | the network's order (ADR-017 §6): shuffles above 2^53, one snapshot's order, cursors |
| `profile.json` | what the network keeps from a manifest's profile (ADR-017 A2.5): each field checked and dropped alone, hours, categories and tags, a place to stay's `lodging` (0.11), and cuisines, reservations, a description of 600 characters and each field's source (0.14) |
| `doors-elsewhere.json` | what a reader keeps of a manifest's `doors_elsewhere` (`readDoorsElsewhere`): the kinds of request a business takes somewhere else, and where, each entry checked and dropped alone, and since 0.10 the platform each names; `detect` and `clean`, the platform a URL is on and the tracking it carries |
| `mcp.json` | what an assistant reads from the network's tools (ADR-017 A2.7): the card derived from each listing, today's hours in the business's zone, and one answer of each tool |
| `score.json` | the agentic score, rules version 2 (§4.13): for each case a profile and every capability's state, and the score, grade, numerator and fixes the published formula gives; `score-v1.json` the same under version 1 |
| `door-reports.json` | door reports (§4.15): how a network reads a call (strict JSON, the limits, each report taken or ignored and why), what each report can do by its proof and source, how the network's own reads move a door (§4.8), and what earns a reporter points and who is a contributor (`contributors`, §4.15) |
| `gtin.json` | barcodes (§4.18): how one is read, checked and classified, each input with its hint and what it reads as, the UPC-E expansion for each sixth digit, and the GS1 prefixes pinned; written by hand, the check digits worked out apart from both implementations |
| `stay-totals.json` | a stay's quote (0.11): when it holds together and why not, in currencies with no minor unit and with three |
| `stay-policy.json` | a stay's cancellation preset dated for its arrival in zones across clock changes, and the fee at given instants |
| `stay-nights.json` | a stay's nights, and its start and end with the zone's offset |
| `doors-elsewhere-stay.json` | a stay taken elsewhere, its deep link kept or dropped, and filled in |
| `catalogue-signature.json` | catalogue version 2 (§4.18): canonical JSON (RFC 8785), from values and from body text, items' hashes, and `Catalogue-Signature` byte for byte with RFC 8037 A.1's key (A.4 first), a feed on an API host and ids encoded one way, with the refusals, their codes and their order |
| `catalogue-checks.json` | one version 2 item read alone: listed with what was dropped, held with every problem (and the path of what did not read), or withdrawn |
| `catalogue-prices.json` | price models, unit-price arithmetic, and the "was" price's 30 days |
| `catalogue-options.json` | a business's product groups: one product, or each variant its own, and the 250 limit |
| `catalogue-v1.json` | the version 1 item an inbox serves for each version 2 item |
| `catalogue-policies.json` | the policies document read part by part, and shipping quotes |
| `door-history.json` | a door's history (§4.8): the days seen answering, days checked, answered and refused, the floored share from 14 days, the last 90 days as a line, since or from…to, and the door types never shown; `summary` is informative |

`vocab/categories.json` is the categories list a profile names its categories from: each slug with
its English and Portuguese labels and synonyms. Protocol 0.2 adds `vocab/doors.json` (the door
types, and the human channels that are never doors) and `vocab/attributes.json` (the attributes a
listing may carry, with the categories each applies to and labels in five languages); the network
serves the same files. `vocab/capabilities.json` is the capability vocabulary (what an agent can do
with a business, from finding it to a refund) and `vocab/score-rules-v2.json` the agentic score's
rules, version 2, in force from 7 October 2026, as `GET /v1/score-rules` serves them
(`vocab/score-rules-v1.json` is version 1, retired, at `?version=1`); `doors.json` version 2 adds the
`experimental` door types, which count toward the score and never toward a level.
`vocab/door-report-classes.json` (0.4) lists the classes a door report may carry, by phase and
result, with the JSON-RPC, MCP, A2A and HTTP codes each one stands for.
`vocab/payments.json` (0.7) is the payments vocabulary, the network's own file byte for byte: the
tokens a profile's `payments` and a search's `accepts` name, their labels, and how a network reads
what a business writes (synonyms), what it sees on a site's pages (marks) and a UCP profile's payment
handlers (handlers). A token is never removed or renamed.
`vocab/door-platforms.json` (0.10) lists the platforms a door elsewhere may name: for each its token, name,
group, the kinds of request it takes, its hosts, how a business's own page there is told apart, whether it also
serves pages on the business's own domain, where its pages for a business are known to sit, and the platform's
public page its hosts were read from; and the names under a host, and the first path segments, that are a platform's
own pages. Not listed: delivery apps and stay marketplaces (Uber Eats, DoorDash, Deliveroo, Booking.com, Airbnb,
Expedia…). Some listed platforms charge the business per booking or order; that is between the business and the
platform. A token is never removed or renamed.
`vocab/business-kinds.json` (0.13.1, additive) lists kinds of business, from a tattoo studio to a surf house: each
with its name in English, Portuguese (Portugal), Spanish, French and German, the setup an inbox starts it from
(`preset`: one of the inbox's rule presets, or `general`, whose rules follow what agents may do) and the directory
categories it falls under (slugs of `vocab/categories.json`). An inbox publishes a business's kind in its profile's
`categories`, as a network already reads them: those slugs, then the kind's name as a free tag; a kind the list
lacks is the business's own words, as a free tag (`kindCategories`). Some kinds also list other names people
search for them by (`also`: "Dog groomer", "B&B"), for finding a kind only, never published. A kind is never
removed or renamed.
`vocab/option-keys.json`, `vocab/age-kinds.json` and `vocab/carriers.json` (catalogue version 2, 0.15) list the
keys a variant's options name (each with labels in five languages, the Google Merchant Center attribute it fills, and the
other spellings read as it), the kinds of age-restricted offer (with whether a network lists them: tobacco and
nicotine, cannabis and weapons it does not; and the spellings read as each), and the carriers a shipping service names
(the countries each carries within, its kind, whether its numbers are UPU S10, the form its numbers take where it is
known, its tracking page's address where that page takes the number, and the domains its tracking pages are on). None
keeps a table of what any law says. A key, kind or carrier is never removed or renamed, and a spelling never moves.
`vocab/cuisines.json` (0.14) lists the cuisines a profile's `cuisines` names and a network files as `cuisine=<slug>`,
the network's own file byte for byte: each slug's kind (regional or dish), labels in seven languages, synonyms, the
OpenStreetMap and schema.org words that name it and the Overture place categories whose places serve it, and the two
diets a cuisine may name instead (vegan, vegetarian), read as their attributes. A slug is never removed or renamed.

`receipts.json` is written by `npx tsx scripts/gen-receipt-vectors.ts` from `packages/core`;
`receipts-v2.json`, `signatures.json`, `passes.json`, the four stay vectors and `schemas/` by
`npx tsx scripts/gen-network-vectors.ts` (then `npx biome format --write ../spec`). `scoring.json`,
`ordering.json`, `profile.json`, `mcp.json` and `score.json` come from the network unchanged.
The six `catalogue-*.json` vectors are written by `python3 scripts/gen-catalogue-vectors.py` (then `npx biome format
--write vectors`), Python's standard library only, its own Ed25519 included. `door-history.json` is written by `python3 scripts/gen-door-history-vectors.py` (Python's standard
library only: an implementation of its own, in another language than either side it checks). `packages/core/test/*-vectors.test.ts` checks
every file against the code on Node and in workerd; the network checks the same files in Go.
