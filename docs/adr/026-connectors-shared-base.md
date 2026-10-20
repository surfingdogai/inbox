# ADR-026 — Connectors: the shared base for shops, tills, bookings and links

**Status:** proposed, 20 October 2026. Builds on ADR-014 (connectors strategy), ADR-015 (webhooks),
ADR-022 (calendars) and ADR-023 (pay links). The base that WooCommerce (ADR-027), Shopify (ADR-028),
Square (ADR-029), Calendly and the calendar link to share (ADR-030) and the doors elsewhere (ADR-031)
build on. It holds no platform's code.

## Context

The next connectors are shops and tills (WooCommerce, Shopify, Square), a booking platform (Calendly)
and a link the inbox serves (a calendar of its bookings for a booking site's import). Each needs the same
things the inbox did not have: products coming in from an account, orders written into the business's own
shop and paid at its own checkout, webhooks addressed to one connection, a key a store hands over
itself, choosers once connected, and a link the inbox makes. Built five times, each would decide the
money rules again. The gallery also said "Soon" for cards nobody was building, and the product feed import
filled in EUR for a price it did not have.

## Decisions

### 1. The business's own accounts; the business is the merchant

Unchanged from ADR-014 and ADR-023, and binding on every connector here: the owner pastes a key they made,
or approves a page on their own store. Money goes to the business's own account, shop checkout or till.
No connector takes card details, sets an application fee (Square `app_fee_money`, Stripe
`application_fee_amount`) or takes a share of a sale or a booking. Connecting, changing and disconnecting
are the owner's in person; the owner's AI and integration keys list and sync.

### 2. Shop orders, and the shop's total

- Two capabilities: `catalogue` (products in) and `shop_orders` (accepted orders written into the
  business's own shop, paid at its checkout). `shop_orders` rides on `pay_links`: a shop is the payment
  platform for its orders, with the one-live-link rule, the claims and the reconciliation of ADR-023.
- `createLink` of a shop is given the order (`PayLinkRequest.order`, a `ShopOrder`): its lines at the
  prices the customer accepted, the shop's own id for each product it sent in, the delivery, and the
  customer's name, email, phone, language and addresses: what fulfilling needs, to the business's own
  shop (the same controller), never to anyone else. An erased customer is nobody: nothing about them is
  sent.
- **The shop's total must be the customer's.** A shop answers with what it says the order comes to
  (`PayLink.total`), tax or delivery it adds itself included. When that is not what the customer
  accepted, the link is `held`: made in the shop, never sent, and the owner is told once. When the shop
  counts more, the owner can **Propose the shop's total**: a business change (ADR-018 §3.2) with the
  order's lines and one line for what the shop adds (`SHOP_CHARGES_SKU`), which the customer accepts or
  not. Accepted, the held order is closed in the shop and a new one made; the shop is told the product
  lines and the charges it adds itself (`ShopOrder.charges`), so its total is the customer's. When the
  shop counts less, the owner looks into the shop's prices. Nobody is ever charged more without a word.
  A held link is live: the one-live-link index takes it in (migration 0024).
- What a shop says became of an order (`PaymentsHandler.orderState`, or a webhook's `order` fact):
  fulfilled and delivered move the order on, by the connector; refunded marks done a refund the inbox
  owes, when it covers it. **Cancelled before it was paid closes the link and leaves the order to the
  owner**, who is told once: shops cancel unpaid orders on their own (WooCommerce's stock hold,
  https://woocommerce.com/document/configuring-woocommerce-settings/products/#inventory), and a customer is
  never told their order ended for that. The connector cannot cancel an order in the inbox.
- Polling is the source of truth: open and held shop links are asked about on each reconciliation, paid
  ones hourly until the order ends. Webhooks only make it sooner.

### 3. The catalogue, one upsert

- Feeds and shops write products through one function (`connectors/catalogue.ts`): upsert on
  `(source, external_id)`; the source is the account (`connector:<kind>:<account>`, a feed's address),
  never the connection row, so connecting the same shop again adopts its products. Withdrawal and
  negotiable are the owner's and never written. A SKU another product holds is dropped, the product kept;
  the SKU the inbox keeps for itself is never written.
- A missing price keeps the last one; **a product with no price ever is kept off sale**, in the business's
  own currency, never a currency guessed. This removes the feed import's EUR default.
- A complete pass marks what it saw (`products.seen_at`, migration 0024) and takes off sale what it did not
  (`deactivateUnseen`). A pass cut short (a feed at its size, a shop past 5,000 products) takes nothing
  off sale. Deactivated, never deleted: an order may name a product.
- Cadence: a full pass every six hours (and first), what changed since the last read on every sync, and at
  once (job `connector_catalogue`, in the connection's lane) when a webhook says products changed. Ten
  pages a run; a pass with more goes on a second later. At most 5,000 products per connection; past that
  the owner is told once and the first 5,000 stay.

### 4. Webhooks at a connection's own address

- `POST /v1/hooks/<kind>/<token>`: 32 random bytes per connection, its SHA-256 in `connectors.inbound_token`
  and the token sealed in `inbound_enc` (purpose `connector-inbound`). A request reaches one connection,
  never a fan-out of signature tries; `POST /v1/hooks/<kind>` stays as it is for Stripe and Mollie.
- The flood guard first, then a body over 1 MB refused, then the connector's `verify`: the signature over
  the exact bytes in constant time (`hook-sign.ts`: base64 and hex HMAC-SHA-256). A signature that does not
  check out is answered 400 and writes nothing; a ping is answered 200.
- `connector_events` keeps the platform's delivery id, the topic and the ids it names, **never the body**:
  a platform's body carries the customer's details, and is never believed anyway. A delivery sent twice is
  answered 200 `{duplicate: true}` and applied once.
- The platform is answered at once, inside every platform's timeout (Shopify gives five seconds,
  https://shopify.dev/docs/apps/build/webhooks/subscribe/https). A job (`connector_hook`, retried by the
  runner's backoff) reads back with the business's key what the event names, and applies each fact: a
  payment (ADR-023), an order (§2), products changed or busy times (read again now), access withdrawn (the
  connection fails, and the owner is told once).
- Webhooks the inbox makes are made in `connect` at `hookUrl` (the connection's own address), and taken
  back in `disconnect`; while a hosted inbox is not live (`hooksLive: false`) none is made and polling
  covers the gap. Connecting again in place keeps the address; a sign-in gives a new one, which the
  connector names in what it makes.

### 5. Ways in

- **Per way.** A preset may connect otherwise than its definition (`ConnectorPreset.auth`) and have its own
  readiness: a shop approved on its own store with a way to paste its keys instead (kept under More
  options, `advanced`), or a key with a one-click sign-in beside it that needs the platform app of
  whoever runs the server (Shopify, Square, Calendly: `SHOPIFY_CLIENT_ID`/`_SECRET`,
  `SQUARE_CLIENT_ID`/`_SECRET`, `CALENDLY_CLIENT_ID`/`_SECRET`). Without that app the sign-in says
  "set up" on one's own server and "Soon" on a hosted inbox, and the key way works.
- **What a sign-in asks first** (`OAuthFlow.before`): a store's address, prefilled from the business's
  website (`FieldHints.prefill: "website"`), never a format to guess. Kept in `connector_auth.input`.
- **A key the store POSTs itself** (`OAuthFlow.delivery: "post"`, WooCommerce's authorize endpoint,
  https://woocommerce.github.io/woocommerce-rest-api-docs/#authentication-endpoint): it arrives at
  `POST /v1/hooks/<kind>/authorized` with the state, which is checked like a way back (minted here, used
  once, ten minutes), the key is checked against the store before it is kept, and the connection (or what
  went wrong) waits on the sign-in for the owner's browser to find on its way back.
- **Choosers once connected** (`Connected.choices`): a till's location, a team member. Drawn by the owner
  app, checked against their options, given to every run (`RunContext.choices`); options sent again keep
  what the owner chose where it is still one of them.
- **A link the inbox makes** (`auth: "link"`, `FeedServer`): one per kind, served at
  `GET /v1/feeds/<kind>/<token><extension>`, public behind the flood guard, `noindex`, no cookies,
  `private, max-age=300` unless the connector says otherwise. It shows only what the connector says a link
  may; the base gives it confirmed bookings by time and service name (`FeedContext.bookings`), never who
  booked. The link is shown to the owner in person only; **Make a new link** stops the old one at once.

### 6. The gallery says only what is true

- A way is ready only when its connector is registered in this release and ready here.
- **"Soon" only for what is being built now** (`building`, the five cards of this work: Calendly, the
  calendar link to share, WooCommerce, Shopify, Square), until its connector registers. Any other card or
  way without a registered connector is not shown at all.
- Outlook is the calendar card's published-link way, with Outlook's own steps: busy times only, ready
  everywhere, instead of a "Soon" nobody was building.
- Google says "Soon" while its client is in Google's Testing mode (`GOOGLE_OAUTH_TESTING=1`), where only
  test users can sign in: no button that ends on "access blocked".
- Cards are grouped (Calendars, Payments, Shops and tills) and ordered by what the inbox holds: one with
  more products than services sees its shop and till first. None is hidden for it.
- Site and docs say "Works today" only for what is merged and deployed, "Being built" for this work, and
  nothing about anything else. Doors to other sites are never called integrations.

### 7. One pattern on the owner's side

Settings → Integrations is drawn wholly from what the server says (card of each connection, groups, ways,
the button's words, what a sign-in will ask and asks first, a link to make, choosers, what a disconnect
leaves to do by hand), so a connector adds no screen and no change to `Integrations.tsx`. A connector
added to this release takes one import, one export line and one entry in `builtInConnectors`; a host may
offer its own beside them (`createInbox({ connectors })`). Its docs page goes in `docs/connectors/`,
listed by the sidebar on its own.

## Consequences

- Migration 0024: `connectors.inbound_enc`; `connector_auth.input`, `connector_id`, `message`;
  `products.seen_at` and its index; `connector_payments.shop_total`, `shop_currency`; the one-live-link
  index takes `held` in. Nothing that exists changes meaning.
- REST: `POST /v1/owner/integrations/{id}/link`, `POST /v1/owner/items/{id}/payments/shop-total`;
  `authorize` takes `preset` and `input`; `PATCH /integrations/{id}` takes `choices`. Public:
  `POST /v1/hooks/{kind}/{token}`, `POST /v1/hooks/{kind}/authorized`, `GET /v1/feeds/{kind}/{file}`.
- Jobs `connector_hook` and `connector_catalogue`, in the connection's lane; a demo runs neither.
- A hosted inbox's router passes `/v1/hooks/*` and `/v1/feeds/*` once it is live, as it does
  `/v1/hooks/*` for Stripe today; the hosted host sets `GOOGLE_OAUTH_TESTING=1` while its Google client is
  in Testing mode. Both are the host's, outside this repository.
- Tests run against a fake platform (`packages/adapters/test/fakes/platform.ts`): the inbox's own connector
  client over it, so every connector proves its refusals of plain http, private hosts and redirects to them.
  No real platform is ever called.
- Not in this base: amounts not counted in hundredths (JPY, KRW, CLP, VND: no link, as ADR-023); an
  order-status door for orders placed in the shop's own checkout, and copying those orders into the inbox
  (decided: not now); the platforms themselves, each in its own ADR.
