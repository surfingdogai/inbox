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

The inbox does not ask Stripe which account a restricted key belongs to, so a Stripe connection is
known by its mode (`stripe:live`, `stripe:test`): one Stripe account per mode per inbox. Mollie's is
known by its profile and mode. A second key of a mode already connected is refused before the
platform is asked anything (`ConnectorDefinition.modeOf` reads the mode from the key's prefix), so
nothing the first one made there is touched; a new key replaces the old one in place (**Change → New
key**). What a connect makes on the platform for the new key (Stripe's webhook endpoint) is kept, and
what the old one had removed, only once the connection is stored (`Connected.settle`); refused after
all, what it made is removed again.

**One platform sends an order's links per mode.** Connecting a payment platform switches links off on
the others of its mode, and switching links on for one switches them off on the others; links already
sent keep working, and their connection still hears of their payments.

### 2. A link for each accepted order, and only one

Every event of an order queues one `pay_link` job, when a payment connection takes orders or the order
holds a live link. The job makes the order's link match the order:

- an order **accepted, waiting for payment, or whose payment failed**, with a total above zero, gets
  one link for what it comes to now, made in the business's account, and is asked to pay at it
  (`request_payment` by the connector, which already takes a `paymentUrl`);
- **only orders the connection is for**: one accepted once the connection was made, one a person
  asked to pay since without a link of their own, or one that has a link of ours already (waiting,
  failed or refused). An order accepted before keeps what it had: a business paid on delivery is
  never asked to pay by surprise, and the owner who wants a link asks for payment;
- **no link while a change waits** for an answer (`payload.change`): what the order comes to is not
  settled, and once payment is asked for its total is fixed (more is a second order, less a refund).
  The change's answer is an event, and queues the job again;
- **only amounts in hundredths**: every amount in the inbox is (`util/locale.ts`); an order in a
  currency counted otherwise (JPY, KWD) gets no link, its row says why, and the owner is told once.
  The platform is never sent a guess at another exponent;
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
the owner told, plainly for the refusals an owner meets (Stripe's `amount_too_small`) and in the
platform's words otherwise. A refusal stands: it is not asked again on every event, nor told twice
(once per order and reason), until the total, the currency or the connection changes or a person asks
for payment. The order then waits as accepted: the owner can still ask for payment by hand.

On Stripe a link is a Price and a Payment Link good for one payment (`restrictions[completed_sessions]
[limit]=1`), with the inbox's ids in its metadata, a thank-you in the customer's language on Stripe's
confirmation ("Thank you for your payment for order 4F2K9Q."), and a line for a link that is closed,
true whatever closed it (paid, changed, cancelled, disconnected): "This link to pay is closed. Ana's
Salon's latest email about order 4F2K9Q says what is still to pay, if anything." On Mollie it is a
Payment Link (`reusable: false`) that names its own webhook. Every Stripe call names the API version
the inbox reads (`Stripe-Version`), and so does the webhook it adds (`api_version`).

The customer's details are not sent to the platform from here: no name, no email, no address. A link
is named by the catalogue's own product names ("Sourdough and 2 more (4F2K9Q)", in the customer's
language), or "Order 4F2K9Q" when a line is not a catalogue product: never words a customer's agent
typed, which a bank statement could show. The platform asks the customer for what it needs on its
own page.

### 3. One email asks the customer to pay

Every customer email is written from the order as it stands when it goes. While a link is on its way
(`linkComing`, by the same rules the link is made by), the email about an order accepted (or a payment
that failed, or a person's request for payment without a link) waits twenty seconds
(`PAY_LINK_GRACE_MS`), so it carries the link, and its own words with it: the owner's note, "The
payment did not go through." The connector's own request is then the email that is not sent, as long
as that one is still to go. When the platform is slow, the order's own email goes without the link and
the connector's follows with it: two, never a request without what it asks for, and never the
owner's words dropped. An email that asks to pay again, after one since already carried the same
link, is not sent unless it has the business's own words.

A spent link (its bank payment failed) and a link closed by a disconnect are taken off the order
(`payload.paymentUrl`), so neither the customer's agent nor the next email sends anyone there.

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
  with the key, at most every fifteen seconds per link (a nudge in between is answered 503 with
  `Retry-After`; Mollie sends its own again, one made up is never read). Someone who adds a signed
  webhook in Mollie's dashboard (`payment-link.paid`, `X-Mollie-Signature: sha256=<hex>`) gives its
  signing secret through the API (the form does not draw it: every Mollie report is read back either
  way), and those events are checked by it, then read back the same way. A profile key cannot add one
  itself (Mollie's Webhooks API takes an organisation token), so it is optional.
- **The webhook endpoint** is added in Stripe by the inbox when the key may, and an earlier one it
  added for this inbox is removed once the new connection is kept (never one another system added).
  When the inbox's address changes (a business takes its inbox to its own domain), the next sync
  points that webhook at the new one; one Stripe switched off (its deliveries kept failing) is
  switched on again; one removed is said on the connection and told by email. While a link waits to
  be paid it is looked at on every sync. A hosted inbox before it goes live answers only its owner
  (`HostPolicy.hooksLive: false`): no endpoint is added then (`webhook: "pending"`), since every
  delivery would fail and Stripe would write to the business about it; it is added on the first sync
  once the inbox is live. Without that permission the owner adds it by hand, from the address and
  events Settings shows, and pastes its signing secret; connecting again that way removes the one the
  inbox had added.

A payment is applied once: the link is marked paid by compare-and-set, then the order gets
`record_payment` by the connector under an idempotency key of the link's id, with the payment's id as
`paymentRef`, the amount the platform says was paid and, where it says, how (`method`, in the
network's payment words, which the payment-methods data reads: Mollie's `creditcard` is `card`,
`banktransfer` and `directdebit` are `sepa`, `klarnapaylater` is `klarna`, `mbway` is `mb_way`; one
with no word there is left out, never stored raw; Stripe says only with permissions this inbox does
not ask for). The receipt the
order earns (`knd: paid`) carries that amount (`amt`) and method (`pay`): the claims ADR-016 froze,
filled by the platform, not typed. Every request is kept in `connector_events` (the platform's event
id, unique per connection, so a request sent twice counts once) with what was read back, never the
body: a platform's event carries the customer's details.

A payment that cannot go on the order is the owner's to settle, and they are told once, by email,
with the payment's page in their dashboard: one that arrived after the order was cancelled or
fulfilled (or while it was being cancelled), a second payment on an order already paid (on another
link, or on the same one: the platform's list of a link's payments is read whole, and each payment
told once, with its own amount and page), and a payment of another amount than the order comes to
(marked paid with what was paid). When recording a payment fails for a reason of ours, the link is
put back exactly as it was, so the next word records it.

A webhook that never came is found by the regular sync, which asks the platform about links still
open as each falls due: on every five-minute sync for its first day, hourly to two days, twice a day
to a fortnight (unpaid orders lapse after fourteen days, ADR-017 §3.1, and stay waiting), then daily
for as long as the link is open. Links of the last two days are asked about first; a link not due
never takes another's place; ten calls a run.

### 5. Refunds stay where the money is

The inbox never moves money: it makes no refund, no capture and no charge. Each paid link keeps the
payment's page in the business's own dashboard (`dashboard_url`), and the owner app links to it as
**Refund in Stripe** (or Mollie). A refund the inbox owes on such an order shows **Refund €45.00 in
Stripe**, the payment's page, and **Refunded in Stripe** records it in one click against that payment
for what is owed (the refund item's `refund` event, with nothing to type). Mollie's profile key can
read a payment's refunds: the sync asks hourly about paid links whose order owes a refund, and once
what was refunded there (pending, processing or refunded) covers what is owed, the connector records
the refund against Mollie's refund id. Stripe's restricted key asks for no refunds, so it reads none.

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
- Settings → Integrations: Stripe and Mollie connect (the cards no longer say "Soon"; without an https
  address of its own the inbox says it needs one first); a connected one says only what is not the
  default (a test key, links off, which platform sends the links when there are two), how many wait
  and were paid, and opens the business's dashboard. **Change** has one switch, applied at once, and
  **New key**; the tile of a connected platform opens its new key, and offers a key of the other mode.
- Disconnecting a payment platform goes in two steps: it makes no new link at once, and its links
  still waiting are switched off on the platform, a few in the owner's request and the rest by a job
  (`pay_close`, tried again after one, five, fifteen, thirty and sixty minutes). Its key and webhook
  stay until then, so a payment made meanwhile is still recorded. Then the webhook the inbox added is
  removed, the connection goes with what its platform told it (`connector_events`), and the owner is
  told once which orders were left waiting on a link that no longer works and which links could not
  be switched off. Payments already made stay in the account, and their rows stay here.
- An order shows its payment: waiting, paid (how and when), or no link and why, and **Refund in
  Stripe**. REST `GET /v1/owner/items/{id}/payments`, owner MCP `list_payments`; `list_integrations`
  says what each payment connection holds. The owner's AI reads them and still records no money.
- Jobs `pay_link` (one order's jobs in one lane), `pay_notice` and `pay_close`; a demo runs none.
- A payment connection that stops working (a key withdrawn, a webhook removed) is told as itself:
  "Stripe stopped working with your inbox", never as a calendar.
- A hosted inbox answers `/v1/hooks/*` only once it is live on the business's own name: below that the
  router lets only the owner through, and orders are not taken there either. Its host says so through
  the policy (`hooksLive`), so Stripe's webhook waits for it.
- Not in this release: deposits and pay links for bookings (a quote that becomes a booking gets none);
  Stripe Checkout Sessions instead of Payment Links; charge-backs recorded from the platform, and
  Stripe refunds read from Stripe; the payment method on Stripe payments; one-click connection on
  hosted inboxes (a Stripe App, Mollie OAuth); more than one Stripe account per mode; currencies not
  counted in hundredths.
- Not checked against a real account: whether Stripe answers 403 for a missing permission before it
  reads a request's (empty) parameters, which naming every missing permission at connect relies on.
  If it does not, a missing permission still shows, later, as a link that could not be made.
