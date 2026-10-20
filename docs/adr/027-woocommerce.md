# ADR-027 — WooCommerce: a business's own WordPress shop

**Status:** proposed, 20 October 2026. Builds on ADR-026 (the shared base for shops, tills and links),
ADR-023 (pay links) and ADR-024 (the WordPress plugin's discovery lines). Connector kind `woocommerce`,
frozen once merged.

## Context

Of 15,146 WooCommerce sites our crawler read, 3 were agent-ready. A WooCommerce shop already has
everything an order needs: its catalogue, its stock, its own checkout and payment gateways. What it
lacks is a door agents can use. The inbox can be that door without taking any of it over: products in,
accepted orders written into the shop, paid at the shop's own checkout.

WooCommerce needs no developer account from anybody. Its REST API v3 takes a key pair the store makes,
and the store can make one for an app itself, on an Approve page in the owner's own WordPress admin.

Sources, read on 20 October 2026:

- REST API v3: https://woocommerce.github.io/woocommerce-rest-api-docs/
- Authorize endpoint: https://woocommerce.github.io/woocommerce-rest-api-docs/#authentication-endpoint,
  and its source, https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/class-wc-auth.php
- Webhooks: https://woocommerce.com/document/webhooks/, and their source,
  https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/class-wc-webhook.php
- Orders controller (line items, totals):
  https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/rest-api/Controllers/Version2/class-wc-rest-orders-v2-controller.php
- Unpaid orders cancelled by the stock hold: `wc_cancel_unpaid_orders` in
  https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/wc-order-functions.php
- Customer emails: https://github.com/woocommerce/woocommerce/tree/trunk/plugins/woocommerce/includes/emails
- Keys made by hand: https://woocommerce.com/document/woocommerce-rest-api/

## Decisions

### 1. Connected by the store's own Approve page; keys by hand under More options

- **Connect your shop** asks one thing, the shop's address, filled in from Settings → Business website.
  The owner's browser goes to `<store>/wc-auth/v1/authorize` with `scope=read_write`, `user_id` = the
  inbox's state, `return_url` = the inbox's callback carrying the state, and `callback_url` =
  `POST /v1/hooks/woocommerce/authorized` (https; WooCommerce refuses any other). The app name the
  owner sees there, and on the key afterwards, is `Agent inbox (<inbox host>)`.
- WooCommerce POSTs `{key_id, user_id, consumer_key, consumer_secret, key_permissions}` server to
  server, then sends the owner back with `success` and `user_id`. The inbox takes the key only with
  `read_write`, checks it against the store **at the address the owner gave** (never one the POST
  names), seals it, and answers 200. Anything else is answered 400, and WooCommerce deletes the key it
  made, so nothing is left behind.
- While WooCommerce waits for that answer, the inbox asks the store one thing (its settings). The
  webhooks are made on the first sync: the store pings each webhook as it is made, and a small host
  may have one PHP worker, busy waiting.
- **More options → Paste the keys instead:** the store's address and a key pair made in WooCommerce →
  Settings → Advanced → REST API, Read/Write. For a store whose Approve page cannot work (plain
  permalinks), and for a hosted inbox before it is live (§7).
- The store is found where it is: `www.` added or taken away by the site itself (only that: a store
  that sends the inbox to another host is said so, and the key goes nowhere else); `/?rest_route=`
  without pretty permalinks; and the key pair in the query for a host that drops the Authorization
  header, as WooCommerce documents. Such a request never follows a redirect.
- The account is the store's address without `www.` (`connector:woocommerce:<host><path>` for its
  products, ADR-026 §3), and its name the site's own (`/wp-json/?_fields=name`).

### 2. What is read, and nothing else

Every request names its `_fields`. Products, variations, the store's currency and whether it counts tax,
the orders this inbox made, and this inbox's webhooks. **An order is never read with its billing or
shipping details**: the inbox wrote them, and has no need to read them back.

### 3. The catalogue

- A simple product is one sellable unit (`p:<id>`); a variable product is not, its variations are
  (`v:<id>`), named "Parent – option, option". Grouped and external products are not sold by this
  shop's checkout and are not brought in.
- On sale means published and purchasable (a variation: of a published parent too). Stock is
  WooCommerce's count where it counts, 0 when out of stock without counting, unknown otherwise. The
  price is the active price (the sale price during a sale), in the store's currency, rounded to
  hundredths at the third decimal.
- One request per page: a page of products, then the variations of each variable product it listed,
  so a run stays inside its budget however a store is built. What changed is read with
  `modified_after` (GMT): a stock change saves the product, so it is seen; a changed variable product
  has all its variations read; and the bin is read too, so a product binned comes off sale within
  minutes. Anything else gone (deleted for good) comes off sale at the next full pass.

### 4. Orders, paid at the store's checkout

- An accepted order becomes a **pending** WooCommerce order: lines at the inbox's prices
  (`product_id` or `variation_id`, `subtotal` = `total`), a line with no product of the store's as a fee
  line (WooCommerce takes a product line only with a product or SKU), a pickup as a zero-cost
  `local_pickup` shipping line, the customer's full name in one field (splitting names is wrong for most
  of the world), email, phone and address, and the customer's note as theirs. Meta `_sdi_ref` (the
  link's id), `_sdi_mark` (of `ctx.marker`: no other inbox, and nobody who writes `_sdi_ref`, passes for
  this one) and `_sdi_reference`. A private note says where it came from; WooCommerce emails nobody
  about a private note or a pending order.
- **The pay link is the order's `payment_url`**: the store's own order-pay page and gateways. No card
  detail is ever seen here, nothing is charged by the inbox, no fee is ever added.
- **Made once.** Before an order is made, the store's orders of the last three days are looked through
  for one this inbox made under the same id, so a retry after a lost answer makes no second order.
- **Tax.** WooCommerce adds tax to a line's total whatever its prices include. For a store whose prices
  **include** tax, each line is written again at its price without tax, at the rate the store itself
  applied to it (its own tax over its own total, to six decimals), and a cent of rounding goes on the
  largest line, so the order comes to what the customer accepted. A store whose prices **exclude** tax
  adds it on top: its total is not the customer's, the link is held, and the owner can propose the
  store's total (ADR-026 §2). The store's total is always the one checked.
- An order in another currency than the store's is not written into it (`refused`, the order says why).
- A REST order is never cancelled by WooCommerce's stock hold, which cancels only checkout orders.

### 5. What the store says became of it

Read back with the key, by webhook and on each sync:

- **paid**: `processing` or `completed` with `date_paid`. **Cash on delivery** is `processing` before
  anyone paid, so it is paid once `completed`. The payment's id is `order-<id>`; its method in the
  receipt's words where the gateway is known (vocab/payments.json: card, paypal, bank_transfer, cash,
  pix, ideal…), left out otherwise.
- **fulfilled**: `completed`, with tracking when the Shipment Tracking extension recorded one.
- **cancelled**: `cancelled`, in the bin, or gone. Unpaid, this closes the link and leaves the order to
  the owner (ADR-026 §2).
- **refunded**: the order's refunds, in all, which mark done a refund the inbox owes.
- **Closing a link** cancels the store's order while it is still `pending` or `failed` (WooCommerce emails
  nobody for that), and leaves one paid or on hold meanwhile.
- A store has no test mode of its own: every fact is live, and connecting WooCommerce makes it the
  connection that makes links for real orders (Stripe's and Mollie's switch off, ADR-023).

### 6. Webhooks

- One webhook per topic: `order.updated`, `product.updated`, `product.deleted`, at the connection's own
  address, named `Agent inbox (<inbox host>) · <topic>`, with a secret the inbox makes and keeps (sealed)
  before the store is told it.
- `X-WC-Webhook-Signature` is the base64 HMAC-SHA-256 of the body, checked in constant time. The ping a
  webhook sends when it is made (`webhook_id=<id>`, unsigned) is answered 200 and nothing else; any other
  unsigned request is refused. The event's id is the webhook's id and its delivery id.
- An order the inbox did not make (the shop's own checkout) is let go unkept, by the signed body's own
  `_sdi_ref` and mark. The inbox copies no order it did not make (ADR-026: not now). Nothing a body says
  is believed: the order is read back with the key.
- Every few hours the webhooks are put right: made where missing, moved when the inbox moves to its own
  domain, switched back on when the store switched one off after failed deliveries.
- `order.created` is not asked for: the inbox makes its own orders, and every order the shop takes at
  its checkout would otherwise be sent to it.

### 7. A hosted inbox before it is live

A hosted inbox answers only its owner until it is live, so the store's POST to
`/v1/hooks/woocommerce/authorized` cannot reach it, and the owner comes back to "WooCommerce did not
send this inbox a key". Until the base can say so before the owner goes, the docs say to connect once
the inbox is live, or to paste the keys. Webhooks wait for it to be live either way, and every order is
read back on each sync meanwhile.

### 8. Disconnecting

The inbox removes its webhooks. WooCommerce gives no way over its REST API to take a key back, so the
owner is told, once, in their words: "Remove the key in WooCommerce → Settings → Advanced → REST API".

### 9. The WordPress plugin, with WooCommerce

The plugin (`integrations/wordpress`, ADR-024) gains, when WooCommerce is active and the inbox's address
is saved:

- **Connect WooCommerce** in Settings → Agent inbox: it opens the inbox's Settings → Integrations with
  the WooCommerce drawer open (`?connect=woocommerce`), the shop's address filled in from the business's
  website; one press there, one on the store's Approve page.
- One line in its llms.txt: orders at the shop's own checkout; questions, quotes and bookings to the
  agent inbox.
- **Your customer hears from you once.** For orders the inbox made (`_sdi_ref`), and only while the
  inbox is connected to the shop (one of its webhooks, active, delivers to the saved address: after a
  disconnect the inbox no longer writes about those orders, so WooCommerce does again), WooCommerce's
  own emails to the customer that the inbox already sends (processing, completed, refunded,
  cancelled) stay quiet, through WooCommerce's `woocommerce_email_enabled_<id>` filter. On-hold emails (which
  carry bank transfer details), invoices, notes and the store's shipment emails are left as they are.
  A site can turn this off with the `sdi_quiet_store_emails` filter.
- No new dependency, no new setting stored. The wordpress.org listing is prepared
  (`integrations/wordpress/wordpress-org/`) and stays the founder's to submit.

## Consequences

- `woocommerce` is registered in `builtInConnectors`; its gallery card is ready wherever the inbox runs:
  no developer account, no OAuth client, the same on a hosted inbox and one's own server.
- The owner app opens one card's drawer from `?connect=<card id>`, once, when the card can be connected
  there; the owner still presses its one button.
- Docs: `docs/connectors/woocommerce.md`. The integrations page's "Being built" line changes when this
  is merged and deployed, not before.
- Not here: orders placed at the shop's own checkout into the inbox; a WooCommerce order-status door
  for agents; amounts not counted in hundredths (ADR-023); taking a key back over the API (WooCommerce
  has none).
