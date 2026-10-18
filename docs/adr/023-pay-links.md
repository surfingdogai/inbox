# ADR-023 — Getting paid through the business's own account

**Status:** proposed, 18 October 2026. Builds the payment connectors ADR-014 named (Stripe with a
restricted key, Mollie with a profile key) on the connector SDK of ADR-022.

## Context

An order the inbox accepts has a price and a promise, and until now a payment only an owner could
record by hand, or a link the owner pasted. The order machine has had `request_payment`,
`record_payment`, `payment_failed` and a `connector` actor since ADR-017, and a receipt kind `paid`
with `amt` and `pay` since ADR-016, waiting for something to drive them. Most small businesses that
take payments online already have a Stripe or Mollie account. The founder: get paid through the
business's own account; Surfing Dog never touches the money; never Stripe Connect.

## Decisions

### 1. The business's own account, with its own key

- **Stripe: a restricted key** the owner creates for this inbox and nothing else, with *Write* for
  Payment Links, Products, Prices and Webhook Endpoints and *Read* for Checkout Sessions. A secret key
  (`sk_`) is refused for what it is: it can do anything in the account. A publishable key is refused
  too. The key is checked before anything is kept: every permission it lacks is named at once, asked
  with requests missing their parameters, which make nothing (403 for a permission the key lacks, 400
  otherwise; should Stripe ever read the parameters first, a missing permission still shows, as a link
  that could not be made, on the order and the connection). Never Stripe Connect: no platform account
  stands between the business and its money.
- **Mollie: the profile's API key** (`live_…` or `test_…`), checked with `GET /v2/profiles/me`. An
  organisation access token is refused: payment links made with one need a profile and a mode the
  owner would have to choose.
- **Test keys for test orders, live keys for real ones.** A test-mode key makes links only for test
  items, a live key only for real ones, and a payment is applied only to a link of its own mode. Nobody
  is asked for real money for a test, and no real order is marked paid with a test card.
- Keys and webhook secrets are sealed by the secret box (`connector-config`, bound to the row) and no
  door ever returns them, as for every connector (ADR-015 §2, ADR-022 §2). Connecting, changing and
  disconnecting are the owner's in person.

Stripe gives a restricted key no way to say which account it belongs to without a Connect
permission, which this inbox does not ask for; so a Stripe connection is known by its mode
(`stripe:live`, `stripe:test`): one Stripe account per mode per inbox. Mollie's is known by its
profile and mode.

### 2. A link for each accepted order, and only one

Every event of an order queues one `pay_link` job, when a payment connection takes orders or the order
holds a live link. The job makes the order's link match the order:

- an order **accepted, waiting for payment, or whose payment failed**, with a total above zero, gets
  one link for what it comes to now, made in the business's account, and is asked to pay at it
  (`request_payment` by the connector, which already takes a `paymentUrl`);
- when its **total changes**, the link is closed on the platform and a new one sent;
- when it **ends** (paid, cancelled, declined, fulfilled before it was paid), the link is closed;
- an order the **owner gave a link of their own** is left alone, and a link of ours it had is closed;
- a **quote the customer accepts** becomes an order already accepted, which gets its link the same way.

At most one link per order is live (`connector_payments_live`, a partial unique index on `creating`
and `open`), so two jobs that meet make one link. Only the job that holds a link's claim asks the
platform for it; a link is made with idempotency keys from the inbox's own id for it (Stripe
`sdi-<id>-price` and `sdi-<id>-link`, Mollie `sdi-<id>`), so a retry never makes two. A platform that
does not answer is asked again later (five minutes doubling, at most six hours, eight tries); a
refusal (an amount below the platform's minimum, a currency it does not take) is given up at once and
the owner told in the platform's words. The order then waits as accepted: the owner can still ask for
payment by hand.

On Stripe a link is a Price and a Payment Link good for one payment (`restrictions[completed_sessions]
[limit]=1`), with the inbox's ids in its metadata, a thank-you in the customer's language on Stripe's
confirmation, and an "inactive" message for a link that was closed. On Mollie it is a Payment Link
(`reusable: false`) that names its own webhook.

The customer's details are not sent to the platform from here: no name, no email, no address. The
platform asks the customer for what it needs on its own page.

### 3. One email asks the customer to pay

Every customer email is written from the order as it stands when it goes. While a link is on its way,
the email about an order accepted (or a payment that failed, or a request for payment without a link)
waits twenty seconds (`PAY_LINK_GRACE_MS`), so it carries the link. An email that would ask the
customer to pay again, after one written since its own event already did, is not sent. When the
platform is slow, the customer gets the order's own email and then the link: two, never a request
without what it asks for.

### 4. Paid is the platform's word, read back

`POST /v1/hooks/<kind>` is where a platform says something. Nothing in a body is believed:

- **Stripe** signs every webhook (`Stripe-Signature: t=…,v1=…`, HMAC-SHA-256 over `<t>.<body>` with
  the endpoint's secret). The signature is checked (five minutes' tolerance, any `v1` while a secret
  rolls), a checkout that did not come from a link this inbox made is left alone without a call, and
  the Checkout Session is read back from Stripe with the key; only `payment_status: "paid"` is paid.
  `checkout.session.async_payment_failed` is a failed payment: the link is spent and switched off, the
  order is told (`payment_failed`) and a new link follows.
- **Mollie**'s per-link webhook carries only a payment's id, unsigned. It is a nudge: the link is the
  one the address names (`?ref=<the inbox's id for it>`), and what was paid on it is asked of Mollie
  with the key. An owner who adds a signed webhook in Mollie's dashboard (`payment-link.paid`,
  `X-Mollie-Signature: sha256=<hex>`) gives its signing secret, and those events are checked by it,
  then read back the same way. A profile key cannot add one itself (Mollie's Webhooks API takes an
  organisation token), so it is optional.
- **The webhook endpoint** is added in Stripe by the inbox when the key may, and an earlier one it
  added for this inbox is removed (never one another system added). When the inbox's address changes
  (a business takes its inbox to its own domain), the next sync points that webhook at the new one.
  Without that permission the owner adds it by hand, from the address and events Settings shows, and
  pastes its signing secret.

A payment is applied once: the link is marked paid by compare-and-set, then the order gets
`record_payment` by the connector under an idempotency key of the link's id, with the payment's id as
`paymentRef`, the amount the platform says was paid and, where it says, how (`method`: Mollie's
`ideal`, `card`, …; Stripe says only with permissions this inbox does not ask for). The receipt the
order earns (`knd: paid`) carries that amount (`amt`) and method (`pay`): the claims ADR-016 froze,
filled by the platform, not typed. Every request is kept in `connector_events` (the platform's event
id, unique per connection, so a request sent twice counts once) with what was read back, never the
body: a platform's event carries the customer's details.

A payment that cannot go on the order is the owner's to settle, and they are told once, by email,
with the payment's page in their dashboard: one that arrived after the order was cancelled or
fulfilled, a second payment on an order already paid, and a payment of another amount than the order
comes to (marked paid with what was paid).

A webhook that never came is found by the regular sync, which asks the platform about links still
open: every ten minutes for two hours, hourly for two days, twice a day for a fortnight (unpaid orders
lapse after fourteen days, ADR-017 §3.1), within a budget of ten calls a run.

### 5. Refunds stay where the money is

The inbox never moves money: it makes no refund, no capture and no charge. Each paid link keeps the
payment's page in the business's own dashboard (`dashboard_url`), and the owner app links to it as
**Refund in Stripe** (or Mollie). Recording a refund in the inbox stays as it was (the refund item's
`refund` event, by the owner).

### 6. The machine, additively

`request_payment` is also the connector's, and gains a self-transition from `awaiting_payment` and
`payment_failed` to `awaiting_payment` ("Request payment again"), by the owners and the connector: a
new link once the amount changed or a payment failed, or the same one sent again. It closes no
promise (`outcomeOf` is null), and the fourteen days before an unpaid order lapses count from the last
request. `record_payment` takes an optional `method`, kept as the order's `paymentMethod`, which is
what a `paid` receipt's `pay` already reads. The spec's machine vectors (`receipts-v2.json`) list the
new paths, each with no outcome.

## Consequences

- Migration 23 adds `connector_payments` and its indexes; nothing that exists changes. Its rows are
  not tied to the connection by a foreign key: a paid link is the business's record of where the
  money went, and stays after a disconnect. An inbox with no payment platform writes no row and
  queues no job; the write path asks the small `connectors` table once per order event to know.
- Settings → Integrations: Stripe and Mollie connect (the cards no longer say "Soon"); a connected one
  says its mode, whether accepted orders get a link, how many wait and were paid, and opens the
  business's dashboard. **Change** has one switch: send a link to pay when you accept an order.
  Disconnecting closes the links still open (nothing here would hear of a payment on them) and removes
  the webhook the inbox added; payments already made stay in the account.
- An order shows its payment: waiting, paid (how and when), or no link and why, and **Refund in
  Stripe**. REST `GET /v1/owner/items/{id}/payments`, owner MCP `list_payments`; `list_integrations`
  says what each payment connection holds. The owner's AI reads them and still records no money.
- Jobs `pay_link` (one order's jobs in one lane) and `pay_notice`; a demo runs neither.
- A hosted inbox answers `/v1/hooks/*` only once it is live on the business's own name: below that the
  router lets only the owner through, and orders are not taken there either.
- Not in this release: deposits and pay links for bookings (a quote that becomes a booking gets none);
  Stripe Checkout Sessions instead of Payment Links; refunds and charge-backs recorded from the
  platform's own events; the payment method on Stripe payments; one-click connection on hosted inboxes
  (a Stripe App, Mollie OAuth); more than one Stripe account per mode.
