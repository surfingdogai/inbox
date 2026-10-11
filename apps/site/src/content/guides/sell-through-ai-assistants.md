## What an assistant needs

An assistant asked to "order more coffee beans, the same as last time" compares, picks, and then has to buy. To finish, it needs:

- **Your products, with prices and stock**, as data it can read rather than pages it has to guess from.
- **A checkout made for agents**, where it places the order and the person approves the payment, without typing card details into a form made for people.
- **The steps after**: change or cancel the order, see where it is, fetch the receipt, start a return.

Two open protocols describe a checkout for agents. **UCP**, the Universal Commerce Protocol, publishes a profile at `/.well-known/ucp` with the parts your shop supports: checkout, catalogue, orders and payment. **ACP**, the Agentic Commerce Protocol, publishes `/.well-known/acp.json` with a checkout and delegated payment. Some shop platforms publish one of them for you; others need an app or a plugin. Either counts.

How the payment itself works is in [the payments guide](/guides/ai-assistant-payments/).

### A basket hand-off

If you can't offer a checkout yet, you can still let an assistant fill a basket for a person to pay. Write a line in your `llms.txt` with a link template, for example:

<pre><code>- Basket hand-off (an agent fills the basket, a person pays): https://yourshop.example/cart/&lt;variant_id&gt;:&lt;qty&gt;</code></pre>

It counts as partly: the agent did the choosing, and a person still pays. On a site we can't yet tell is a shop, a hand-off on its own can lower the score, because it brings the steps after an order into the count. [Your details as data](/guides/business-details-for-ai/#kind) says how we tell a shop.

<h2 id="after">After the order: change, cancel, track, receipt, return</h2>

An order is the start of the job, not the end of it. Once an assistant can order from you, these count too, and a full score needs them:

- **Change**: `update_order`, `modify_order`, `PATCH /orders/{id}`.
- **Cancel**: `cancel_order`, `DELETE /orders/{id}`.
- **Track**: `get_order_status`, `track_order`, `order_status`, `lookup_order`, `GET /orders/{id}/status`, a UCP order capability, or an order lookup line in `llms.txt`, such as `Order lookup API: POST https://yourshop.example/orders/lookup`.
- **Receipt**: `get_invoice`, `get_receipt`, `GET /invoices/{id}`.
- **Return or refund**: `request_return`, `start_return`, `request_refund`, `create_return`, `POST /returns`, or a UCP return capability.

A lookup by order number and email address is a simple way to offer tracking and receipts. Returns services run portals made for people; ask yours for an API you can publish. For bookings, changing and cancelling are in [the bookings guide](/guides/ai-assistant-bookings/).

## What counts in the check

We read what your shop declares, and never place an order:

- **Order**: a UCP checkout, an ACP checkout, a Shopify storefront's cart tools, or a tool or an operation such as `create_order`, `create_checkout`, `purchase` or `POST /orders`. Also an agent inbox that takes orders.
- **Partly**: a basket hand-off line in `llms.txt` or `agents.md`, or a cart-link tool such as `create_basket_link`: an agent fills the basket and a person pays.
- **Catalogue**: products with an `Offer` price and currency in your schema.org markup, a UCP catalogue, or tools such as `list_products` or `search_catalog`.
- **Stock**: `check_stock` or a UCP catalogue; `availability` on your offers counts as partly.
- **The steps after**, listed above.

Not counted: a checkout page made for people, a contact form, email or phone.
