# ADR-029 — Square: bookings, the catalogue and orders paid at the seller's own checkout

**Status:** proposed, 20 October 2026. Builds on ADR-022 (calendars), ADR-023 (pay links) and ADR-026
(the connectors' shared base). Code: `packages/adapters/src/connectors/square/`.

## Context

Salons, barbers, cafés, restaurants, trades and gyms run their day on Square: the appointments, the
till, the items, the money. Their inbox has to fit into that, not stand beside it: a booking the owner
confirms belongs in Square Appointments, Square's busy team and closed hours belong off the times the
inbox offers, and an order belongs in Square, paid at the seller's own checkout. The base (ADR-026)
gives every piece but the platform. This ADR is the platform, and what Square's documentation changed
in the plan.

## Decisions

### 1. Two ways in, the seller's own

- **An access token** (the way on every inbox, today): the owner creates an app of their own in the
  Square Developer Console and pastes its production **personal access token**, which works for their
  own account only (https://developer.squareup.com/docs/build-basics/access-tokens). One field, two
  steps, a link to the console. Square's production host is asked first; a token it does not know is
  tried at the Sandbox, and connects in test mode (links for test orders only). Nothing else is tried:
  the token goes to `connect.squareup.com` or `connect.squareupsandbox.com` and nowhere else, and no
  redirect is ever followed.
- **Sign in with Square** (preset `oauth`): the code flow of an app whoever runs the server registers
  (`SQUARE_CLIENT_ID`, `SQUARE_CLIENT_SECRET`), with the app's secret on the server, so its refresh
  token lasts and is renewed when fewer than 23 days of the access token's 30 remain (Square asks for
  every seven days or sooner, https://developer.squareup.com/docs/oauth-api/receive-and-manage-tokens).
  Without that app it says "set up" on one's own server and **Soon** on a hosted inbox. Scopes: reads,
  `APPOINTMENTS_WRITE`, `CUSTOMERS_WRITE`, `ORDERS_WRITE`, `PAYMENTS_WRITE`; never
  `APPOINTMENTS_ALL_WRITE`. Disconnecting revokes the token.
- After connecting, choosers: the **location** (open locations only; the main one until the owner
  chooses) and **who takes bookings** (whoever is free, or one bookable team member). Never a typed id.

### 2. Busy times: what Square would not book

On Appointments Free an app sees only the bookings it made (buyer-level,
https://developer.squareup.com/docs/bookings-api/what-it-is), so a list of bookings cannot say when the
seller is busy. Square's own answer to "when is this service free" (`SearchAvailability`) already
leaves out every booking, the business hours, time off and each team member's schedule. The inbox reads
it for the service bookings go to (the chosen one, or the shortest Square books at that location), for
the chosen team member or anyone, 31 days at a time as Square requires (at least a day, at most 31,
https://developer.squareup.com/docs/bookings-api/use-the-api#search-for-available-slots), three windows a
sync: 93 days. Busy is every time no available slot covers, from now on. The inbox's own bookings are in
Square too, and are taken out by their times so a booking never blocks itself. A seller without Square
Appointments makes nothing busy.

### 3. Bookings: the inbox's own customer record, never the customer's

Square asks every booking for a customer with a phone number
(https://developer.squareup.com/docs/bookings-api/use-the-api#specify-a-customer-for-a-booking), and
Square emails and texts the customer of every booking an app makes, with no way to stop it through the
API (Square staff, 5 May 2026:
https://developer.squareup.com/forums/t/suppress-customer-notification-flag-to-bookings-api/25709).
The inbox has already told the customer, in the business's name. So:

- **One customer record per location stands for the inbox**: "Inbox bookings", the location's own phone
  number (`Location.phone_number`), no email, a reference only this inbox can make. Square's messages
  reach the business. Each booking says whom it is for in its note: `customer_note` when the app books
  as a customer, `seller_note` (which the client never sees) on Appointments Plus or Premium. The
  customer's email, phone and address never go to Square for a booking.
- A location with no phone number is told so, in one line, before anything is written.
- The team member is the one Square says is free at that time (`SearchAvailability` for that service and
  start). A booking moved to a time its team member is free is moved in place (`UpdateBooking` with the
  booking's version); otherwise a new one is made first and the old one cancelled after, since an app
  that books as a customer cannot change a booking's service or team member. Cancelling sends the
  booking's version; a cancellation window that has closed is said in Square's own words, with "Cancel it
  in Square".
- The service is the one the owner chose, or the one of the same name and length; several of the same
  length and none named the same is a choice for the owner, never a guess. A service with a cancellation
  fee is not offered: Square refuses those through its API.
- Idempotency keys come from the connection's marker and what is written, so a retry never books twice;
  a run that stopped before keeping the id finds the booking by the inbox's own customer record and its
  start.

This departs from the connectors list (§2.3), which planned a customer per booking "with a name and
`reference_id` and no email or phone": Square's documentation does not allow a booking without a phone
number, and a customer per booking would fill the seller's customer directory with the inbox.

### 4. The catalogue

Each variation of an item is one product, keyed on its catalogue id, priced at the chosen location (its
own price there when it has one), in stock as Square counts it there (`IN_STOCK`, only when Square
tracks it), on sale while it is sold at that location and not deleted, archived, sold out there, or
hidden from Square Online. Services, gift cards, donations and events are not products. A variable price
is no price. Prices are Square's in the currency's smallest unit, which is the inbox's hundredths only
for a currency counted in hundredths: in yen or won an item comes in with no price, and stays off sale
(ADR-026 §3). A full pass reads every item (`SearchCatalogObjects`); a pass of what changed reads items
changed since (`begin_time`, deleted ones too), then the stock counts changed since (`updated_after`),
whose variations are read back by id, since a count never changes the catalogue's version.

### 5. Orders paid at the seller's own Square checkout

- Each order the inbox accepts becomes a Square order and its payment link in one call
  (`CreatePaymentLink` with an `order`,
  https://developer.squareup.com/docs/checkout-api/square-order-checkout): items of the catalogue by
  their id, at Square's price; anything else by name at the inbox's price; the order's `reference_id`
  is the inbox's own id for the link, and so is the idempotency key. A pickup is a `PICKUP` fulfillment
  at its time, or `ASAP` from now; a delivery a `SHIPMENT` to the customer's address
  (https://developer.squareup.com/docs/orders-api/fulfillments). The customer's name, email and phone
  (only when written with its country code) are given to the checkout to prefill.
- Taxes are Square's, as the seller set them (`auto_apply_taxes`): Square's total is read back from the
  order it made, and when it is not what the customer accepted the base holds the link (ADR-026 §2).
- **Never `app_fee_money`**, never card details, never a share. The link is Square's checkout, in the
  seller's name, paid into the seller's account.
- Paid is a tender on the order whose payment Square, asked with the key, says is `COMPLETED`. A link the
  inbox closes is deleted, which cancels its order unless it was paid
  (https://developer.squareup.com/docs/checkout-api/manage-checkout#delete-a-payment-link). Polling
  says cancelled, or ready (a pickup prepared or picked up, a shipment sent with its tracking), one step
  at a time; a webhook says each that holds, picked up included. Refunds made in Square are read per
  payment (`refunded_money`), which marks the inbox's refund done.
- An order in another currency than the location's is refused in plain words.

### 6. Webhooks

With an access token, the inbox makes one subscription at the connection's own address
(`POST /v1/hooks/square/<token>`) through the Webhook Subscriptions API, which takes only an app's
personal access token (https://developer.squareup.com/docs/webhooks/webhook-subscriptions-api).
Topics: `booking.created`, `booking.updated`, `order.updated`, `order.fulfillment.updated`,
`payment.updated`, `refund.updated`, `catalog.version.updated`, `inventory.count.updated`. Square signs
each with base64 HMAC-SHA-256 of the notification URL and the body under the subscription's key
(`x-square-hmacsha256-signature`, https://developer.squareup.com/docs/webhooks/step3validate), checked
in constant time against the address the subscription was made for; Square's own example is a test. A
delivery for another seller, or a topic not followed, is answered and kept nowhere. What is kept is the
event id, the topic and the ids it names, each marked with what it is (`order:`, `payment:`); payments
and orders are read back with the key. The subscription is made once a hosted inbox is live, moved with
the inbox's address, put back when it was removed in Square, switched on again, and removed on
disconnect; a connect again keeps one. A sign-in has no subscription of its own: it polls.

### 7. The owner app

The gallery card turns from **Soon** to ready. Settings → Integrations shows a till that takes bookings
as well as payments with both: its line says busy times and bookings beside its products and links, its
Change panel has the payment switch and the booking choices (busy times, bookings, location, who takes
them, the service), and its disconnect sheet says that bookings stay in Square. This is drawn from the
connection's capabilities, for any connector that both books and takes payments.

## Consequences

- A Square connection is the one that makes an order's links in its mode once connected (ADR-026 §2):
  Stripe or Mollie links switch off, and the owner can switch Square's off in Change.
- The seller's Square holds one customer record per location, "Inbox bookings", under its own number.
  Square's confirmations and reminders for the inbox's bookings go to that number.
- Busy times read for one service can offer a time a service only part of the team takes cannot have;
  writing it is then refused in Square's words and said on the booking.
- Not in this ADR: amounts not counted in hundredths (no links, as ADR-026); an app-level subscription for
  sign-ins (needs our Square app and routing by `merchant_id`); seller-level reads of every booking on
  Appointments Plus and Premium (the availability read already covers them).
- Tests: `packages/adapters/test/square.test.ts` (contract, against `fixtures/square.ts`, written from
  Square's documented examples) and `apps/inbox/test/connector-square.test.ts` (end to end). A salon in
  Toronto (CAD), a café in Melbourne (AUD), a shop in Osaka (JPY). No real Square is called.
