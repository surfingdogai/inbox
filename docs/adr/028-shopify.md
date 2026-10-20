# ADR-028 — Shopify: messages, quotes and receipts beside Shopify's own checkout

**Status:** proposed, 20 October 2026. Builds on ADR-014 (connectors strategy), ADR-023 (pay links) and
ADR-026 (the shared base for shops). The docs cited are the ones Shopify published on 20 October 2026.

## Context

Shopify shops are already the most agent-ready businesses we read: Shopify serves their cart and checkout to
assistants itself (its Storefront MCP and the checkout of UCP, ADR-014). What a Shopify shop lacks is a place
for everything that is not a cart: a question, a quote for a wedding's flowers, a booking, and a signed receipt
of each. Building a second checkout beside Shopify's would duplicate it and confuse agents. So the connector
adds messages, quotes and receipts, and sends every cart to Shopify.

## Decisions

### 1. Shopify keeps the cart and the checkout

- The inbox does not serve a Shopify shop's products to agents as a checkout of its own. The order door is
  meant to point at the shop (`doors_elsewhere`, `item_type: "order"`, the shop's own address), so the
  manifest sends agents to Shopify to buy and to the inbox for messages and quote requests. The connection
  keeps the shop's primary domain (`extra.storefront`) for the doors chooser of ADR-031 to offer as
  "Order at your Shopify checkout"; until that chooser is in, the owner sets it in `doorsElsewhere`.
  Whether connecting Shopify sets that door by itself (orders to the shop's checkout; questions and quotes to
  the inbox), shown on the connected row as "Agents buy at your Shopify checkout · Change", is the founder's
  decision; the recommendation is yes, once the chooser lands. The docs say "soon" until then.
- The catalogue still comes in (ADR-026 §3): agents asking for a quote, and the owner quoting, name the
  shop's own products, at the shop's prices.

### 2. The owner's own app, and its two keys

- The owner makes an app for their own shop in Shopify's Dev Dashboard and pastes its Client ID and Client
  secret, with the shop's `.myshopify.com` address. The inbox gets a token by the **client credentials
  grant** (`POST https://<shop>.myshopify.com/admin/oauth/access_token`, `grant_type=client_credentials`),
  which lasts 24 hours (`expires_in` 86399) and is asked for again a minute before it lapses, kept sealed
  (`saveSecret`), once per run. Shopify grants it only when the app and the shop are in the same Shopify
  organization, which an owner's own app is; otherwise it answers `shop_not_permitted`, said to the owner as
  "this app can't reach the shop: check the address, and that the app was made and installed by the
  account that owns it", on the shop's address (a mistyped handle is the likeliest cause).
  https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
- Since 1 January 2026 the Shopify admin makes no new legacy custom apps; the ones made before still work,
  with an Admin API access token (`shpat_…`) that does not lapse. That token is taken under More options,
  with the app's API key as the Client ID and its API secret key as the Client secret (the secret signs its
  webhooks). That secret cannot be checked at connect: the help says that a wrong one stops Shopify's
  updates reaching the inbox, which still polls.
- The form asks for the keys first, with the steps right under the first box, then the shop. The steps are
  Shopify's own (https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard), numbered:
  Create app → Start from Dev Dashboard, named Inbox; Versions: keep the App URL Shopify suggests (its
  default app home), tick the three scopes, Release; Install app, on the shop; App settings → Credentials.
- **Scopes: `read_products`, `read_orders`, `write_draft_orders`.** Nothing else. The connect checks the
  scopes the shop granted (`currentAppInstallation.accessScopes`, else the token's `scope`) and names any
  that is missing before anything is kept. A write scope includes its read scope, and Shopify may list only
  the write one ("don't read an absent `read_` handle as a missing permission",
  https://shopify.dev/docs/apps/build/authentication-authorization/app-installation/manage-access-scopes), so
  `write_orders` counts as `read_orders`. No customer is ever read back: the inbox writes a customer's name,
  email, phone and address onto its own draft for fulfilling, and reads none.
- **Protected customer data needs no step from the owner.** Orders and draft orders are protected customer
  data, and outside development stores Shopify withholds them from an app that may not see them. An app the
  owner makes for their own shop is a custom app in the shop's own organization: Shopify's table gives
  custom apps Level 1 and Level 2 as "Always available" (https://shopify.dev/docs/apps/launch/protected-customer-data),
  and Shopify's staff confirm that custom apps installed on a store in their own organization have that
  access by default, with no request or approval
  (https://community.shopify.dev/t/enable-protected-customer-data-access-for-a-custom-app-created-in-the-dev-dashboard-no-ui-option-available/35445).
  So the form adds no step. In case a shop still withholds it, an answer naming a field "not approved to
  access" (HTTP 200, the field null) is never read as "not paid yet": the call fails `config`, telling the
  owner to make the app with the account that owns the shop. To be confirmed on a real store, not a
  development one, before release.
- **Only Shopify's own host is called with a key.** The address the owner types is taken as
  `<handle>.myshopify.com`, the admin's own (`admin.shopify.com/store/<handle>`) or the handle alone, and
  checked against Shopify's anchored pattern (`^[a-z0-9][a-z0-9-]*\.myshopify\.com$`). A custom domain is
  refused with where to find the address (Settings → Domains): resolving it would mean an undocumented
  storefront file, so it is not done. Plain http, IP addresses and anything else are refused before any
  call; nothing follows a redirect; every call goes through the inbox's connector client (https only, public
  hosts only).
- **A shop counted in whole units or thousandths (JPY, KRW, KWD…) is refused at connect**, with why: every
  amount in the inbox is in hundredths (ADR-023 §2), and a shop whose catalogue and orders cannot be counted
  is no use connected.
- A development shop (`plan.partnerDevelopment`) is connected in test mode: it takes only test orders.

### 3. "Sign in with Shopify" is the operator's app, and only shown with one

- A preset `oauth` signs in by the authorization code grant with the app of whoever runs the server
  (`SHOPIFY_CLIENT_ID`/`_SECRET`): `https://<shop>/admin/oauth/authorize?client_id&scope&redirect_uri&state`,
  the code exchanged with `expiring=1` for an offline token that lapses and a refresh token, refreshed with
  `grant_type=refresh_token`. The shop's address is asked first (`OAuthFlow.before`). The operator's secret
  stays in the server's environment and signs that app's webhooks; it is never kept on a connection.
  https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
- Without that app the way is not offered at all: no "set up" naming server variables to a shop owner, no
  **Soon** promising an app nobody has decided to make. The drawer is one form, the keys. Surfing Dog's own
  app (a Shopify developer organization, a public app, App Store review, protected customer data review and
  the mandatory compliance webhooks) would give hosted inboxes a one-click connect; whether to make it is the
  founder's decision. Until then the keys are the way on hosted inboxes too.
- **A departure from Shopify's documented callback checks.** Shopify's authorization code docs ask the app
  to verify the callback's `hmac` (HMAC-SHA-256 of the sorted query under the client secret) and to match
  `shop` against the anchored hostname pattern. The base hands a connector only the code, not the callback's
  query, so neither is checked here. What stands in for them: the inbox's own state (minted here, used once,
  ten minutes), and the code exchanged at the shop the owner typed, never at the callback's `shop`, so a
  forged `shop` is never called and a code for another shop fails its exchange. When the base passes the
  query through, the `hmac` is checked with the operator's secret in constant time.

### 4. An accepted quote or order becomes a draft order

- `createLink` (ADR-026 §2) writes a **draft order** (`draftOrderCreate`): a line the shop sent in is its
  variant at the price the customer accepted (`priceOverride`); any other line is a custom one at its price
  (`originalUnitPriceWithCurrency`), taxable, shipped only when the order is delivered. The draft is in the
  order's currency (`presentmentCurrencyCode`), with the customer's email, a phone only when it is E.164,
  the shipping and billing addresses (a region only when it is a code), a note for the owner (the inbox's
  reference, delivery or pickup, when it is wanted, and the customer's own words marked as theirs), and the
  tags `inbox` and `inbox-<the link's id>`: words an owner reading the Orders list understands.
  https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/draftOrderCreate
- **The shop's total is read, never assumed.** A draft is `ready` once Shopify has worked out its tax; the
  inbox reads it again a moment apart until it is, and otherwise comes back in half a minute. Its
  `totalPriceSet.presentmentMoney` is the shop's total: when the shop adds tax the customer did not accept,
  the link is held and the owner may propose the shop's total (ADR-026 §2).
- **Nothing is added at the checkout either.** A delivered or collected order gets a shipping line of
  nothing, named in the customer's language (over thirty languages, English last), so Shopify's checkout
  asks no rate on top; automatic discounts and discount codes are off for the draft. The customer pays what
  they accepted. A delivery fee the owner quoted is one of the order's own lines, so the checkout can show
  that fee beside a free shipping line. Writing it as the shipping line's price instead needs the inbox to
  know which line is the delivery fee, and its orders do not say (a line is a line): that is a change to the
  order's lines, for a later ADR, not this connector.
- **The draft's own checkout (`invoiceUrl`) is the link to pay.** The inbox never calls
  `draftOrderInvoiceSend`: the business's own email from the inbox carries the link, so the customer is told
  once, in the business's words. Shopify's invoice email would be a second message, in Shopify's template.
- Safe to ask again: before making a draft the inbox looks for its own by the link's tag, so a run that
  stopped before it noted the draft finds it instead of making another. A draft made seconds before may not
  be in Shopify's search yet; the half-minute retry is longer than that.
- `closeLink` deletes the draft (`draftOrderDelete`), the only way Shopify gives, unless it was completed:
  then it is the shop's order.

### 5. What Shopify says became of it, read back

- Paid: the draft is `COMPLETED` and its order's financial status is paid (or partly or wholly refunded
  since). Authorised and not captured, or a manual payment still to come, is not paid. The payment is the
  order (`gid://shopify/Order/…`), for what Shopify says it received (`totalReceivedSet`), `livemode` false
  for a test order (Shopify's Bogus Gateway), "card" for Shopify Payments.
- Fulfilled (with the first tracking number, carrier and https link), delivered (every successful
  fulfilment delivered), refunded (`totalRefundedSet`), and a draft deleted before it was paid (cancelled:
  the link closes and the order is the owner's, ADR-026 §2). Polled, these come one at a time; when Shopify
  holds several, each is offered in turn an hour apart, and the inbox takes the ones it can.
- An order's draft is found by the tag it kept from the draft: Shopify carries a draft's tags over to its
  order (https://help.shopify.com/en/manual/shopify-flow/reference/actions/add-draft-order-tags). An order
  without the inbox's tag is not the inbox's, and is read no further; a tagged one Shopify's search has not
  caught up with yet is looked for among the inbox's 25 latest completed drafts (Shopify's Order has no field
  back to its draft).
- **60 days.** Shopify shows an app only the last 60 days of orders unless it is granted `read_all_orders`,
  which Shopify must approve (https://shopify.dev/docs/api/admin-graphql/2026-10/queries/order). Return and
  refund windows can be longer. The inbox does not ask for it, so that connecting never waits on Shopify's
  approval: it stops asking about a paid order 60 days after it was paid (the base hands the connector
  `paidAt`), and a refund made in Shopify after that is not read back; the owner marks it done. The docs say
  so under Limits.

### 6. Webhooks at the connection's own address

- At connect (and once a hosted inbox is live) the inbox makes, with `webhookSubscriptionCreate`, at
  `/v1/hooks/shopify/<token>`: `orders/paid`, `orders/fulfilled`, `orders/updated`, `orders/cancelled`,
  `refunds/create`, `draft_orders/delete`, `products/create`, `products/update`, `products/delete`,
  `app/uninstalled`. Each needs only the scopes asked for (`fulfillments/*` would need
  `read_fulfillments`, so fulfilment is read from the order). A refresh puts back one Shopify removed after
  eight failed deliveries in four hours, moves them when the inbox's address moves, and removes what points
  at an old address; disconnecting removes them all.
  https://shopify.dev/docs/api/admin-graphql/2026-10/enums/WebhookSubscriptionTopic
- **Each carries ids only (`includeFields`).** Orders: `id`, `admin_graphql_api_id`, `source_name`, `tags`;
  `refunds/create`: `order_id`; `draft_orders/delete` and `app/uninstalled`: `id`; products: `id`,
  `admin_graphql_api_id`. Without it, Shopify sends the whole resource: every order in the shop with the
  customer's name, email and address, and bodies that can pass the inbox's 1 MB limit (refused before the
  signature is checked, so Shopify retries and in the end deletes the subscription). One at the inbox's
  address carrying other fields is made again.
  https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/WebhookSubscriptionInput
- **A webhook Shopify will not make never refuses the shop.** The others are still made, the connection
  is kept with `webhook: "failed"`, and a refresh tries again within the hour (`stale`); after a failure
  that is not that topic's own (the shop unreachable, the bucket empty) the rest wait for that refresh.
  Polling is the source of truth meanwhile.
- **Verify:** `X-Shopify-Hmac-Sha256` is the base64 HMAC-SHA-256 of the exact body under the app's client
  secret, compared in constant time; a delivery without `X-Shopify-Webhook-Id` (the dedupe key) is refused;
  one from another shop (`X-Shopify-Shop-Domain`) or of a topic not asked for is left alone. The body is
  Shopify's and signed, so it may say an order did not come from a draft (`source_name`) or carries no
  `inbox-…` tag and spare a read; it is never believed about what happened. Only ids are kept.
  https://shopify.dev/docs/apps/build/webhooks/subscribe/https
- **Read:** an order event reads the order back and its draft; products changed reads the catalogue again;
  `app/uninstalled` is believed only when Shopify then refuses the access.

### 7. The catalogue

- Every variant (`productVariants`, 100 a page): the product's title (with the variant's unless it is
  Shopify's "Default Title"), its description cut at 500 characters, SKU, price in the shop's currency,
  stock only when Shopify tracks it and stops selling at none, on sale when its product is `ACTIVE` and the
  variant can be sold.
- What changed since the last read: the variants changed (`updated_at:>…`), then the products changed with
  their first 25 variants, since a product's own change (archived, renamed) is not always its variants'.
  The six-hourly full read takes the rest, and takes off sale what is gone.

### 8. One API version, and its rate limit

- Every call is the GraphQL Admin API **2026-10**, the stable version of 1 October 2026, supported until
  16 October 2027 (https://shopify.dev/docs/api/usage/versioning). Moving to the next is one constant and a
  re-read of these fields, at least every twelve months.
- The limit is a bucket of points refilled every second (100 a second on Standard, 200 on Advanced, 1,000 on
  Plus, 2,000 on Commerce Components; at most 1,000 points a query;
  https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits). Every answer's
  `extensions.cost.throttleStatus` is kept per shop; a call the bucket would not hold waits for the points it
  needs first, and a `THROTTLED` answer (HTTP 200 with the code, or 429) waits once as long as the bucket
  needs. A wait longer than five seconds is not made: the call fails `rate_limited` with the wait, and the
  job comes back then. Documents are written with their cost in mind (a variants page about 300 points).

## Consequences

- One connector, `shopify`, in `packages/adapters/src/connectors/shopify/` (`admin.ts`, `queries.ts`,
  `index.ts`); the gallery's Shopify card is no longer "being built", and says "Catalogue in, paid at your
  checkout". No migration, no spec change, no new dependency.
- Small additions to the shared base (ADR-026), each optional and with the old behaviour as its default:
  `KnownLink.paidAt` (so a connector can stop following an order a platform no longer shows);
  `ConnectorDefinition.testLabel` (a connection's row in test mode says "development store" rather than
  "test key"); the owner app's steps are numbered, the change panel says "Refunds are made in Shopify."
  without naming a page that differs by platform, a card whose connection is well shows no "Connected" tag
  beside the row that already says so, and the way switcher's hidden legend reads "How to connect Shopify".
- Disconnecting deletes the unpaid draft orders the inbox made in the owner's shop (`closeLink`); the
  disconnect confirmation and the docs say so.
- Tests run against a made-up shop answering as Shopify documents it
  (`packages/adapters/test/fixtures/shopify.ts`), with no real shop called: the connector's contract
  (`packages/adapters/test/shopify.test.ts`) and the whole inbox around it
  (`apps/inbox/test/connector-shopify.test.ts`).
- Not in this connector: Shopify's own invoice email; orders placed at the shop's checkout copied into the
  inbox (ADR-026: not now); a Shopify POS; the compliance webhooks of a public app, which come with the
  founder's app; currencies not counted in hundredths.
