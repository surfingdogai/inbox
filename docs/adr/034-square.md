# ADR-034 — Square: bookings, the catalogue and orders paid at the seller's own checkout

**Status:** proposed, 20 October 2026. Builds on ADR-022 (calendars), ADR-023 (pay links), ADR-030
(the connectors' shared base) and ADR-032 (currencies without a minor unit, which the base takes from
the WooCommerce track). Code: `packages/adapters/src/connectors/square/`.

## Context

Salons, barbers, cafés, restaurants, trades and gyms run their day on Square: the appointments, the
till, the items, the money. Their inbox has to fit into that, not stand beside it: a booking the owner
confirms belongs in Square Appointments, Square's busy team and closed hours belong off the times the
inbox offers, and an order belongs in Square, paid at the seller's own checkout. The base (ADR-030)
gives every piece but the platform. This ADR is the platform, and what Square's documentation changed
in the plan.

## Decisions

### 1. Two ways in, the seller's own

- **Sign in with Square** (preset `oauth`, listed first so it is the way offered wherever it is
  ready): the code flow of an app whoever runs the server registers (`SQUARE_CLIENT_ID`,
  `SQUARE_CLIENT_SECRET`), with the app's secret on the server, so its refresh token lasts and is
  renewed when fewer than 23 days of the access token's 30 remain (Square asks for every seven days or
  sooner, https://developer.squareup.com/docs/oauth-api/receive-and-manage-tokens). Without that app it
  says "set up" on one's own server and **Soon** on a hosted inbox. Scopes: reads, `APPOINTMENTS_WRITE`,
  `CUSTOMERS_WRITE`, `ORDERS_WRITE`, `PAYMENTS_WRITE`; never `APPOINTMENTS_ALL_WRITE`. Disconnecting
  revokes the token.
- **An access token** (the way on every inbox, today): the owner creates an app of their own in the
  Square Developer Console and pastes its production **personal access token**, which opens the whole
  account it was made in ("unrestricted", https://developer.squareup.com/docs/build-basics/access-tokens);
  the form says so, and what the inbox does with it. One field, two steps, a link to the console.
  Square's production host is asked first; a token it does not know is tried at the Sandbox, and
  connects in test mode (links for test orders only). Nothing else is tried: the token goes to
  `connect.squareup.com` or `connect.squareupsandbox.com` and nowhere else, and no redirect is followed.
- After connecting, choosers: the **location**, only when there is more than one (open locations
  only; the main one until the owner chooses), and **who takes bookings** (whoever is free, or one
  bookable team member), a choice about bookings only. Never a typed id. The connection keeps how it
  came in (`via`: `token` or `signin`), since that decides how Square takes its bookings (§3).

### 2. Busy times: what Square would not book

Square's own answer to "when is this service free" (`SearchAvailability`) already leaves out every
booking, the business hours, time off and each team member's schedule, whichever way the connection
came in (seller-level reads are allowed on every plan,
https://developer.squareup.com/docs/bookings-api/what-it-is). The inbox reads it for one service: for
whoever is free, the one most of the team take (the shortest of those), since a service one person
takes would show their day as everyone's; for a chosen team member, the shortest they take. 31 days at
a time as Square requires (at least a day, at most 31,
https://developer.squareup.com/docs/bookings-api/use-the-api#search-for-available-slots), three
windows a sync: 93 days. Busy is every time no available slot covers, from now on. The inbox's own
bookings are in Square too, and are taken out by their times so a booking never blocks itself. A seller
without Square Appointments makes nothing busy, and is offered nothing of bookings.

### 3. Bookings: the way Square takes them, under the business's own number

**The write level is the token's, not the plan's.** Square decides from the token's permissions whether
an app acts as the seller (`APPOINTMENTS_ALL_WRITE`) or books as a customer, and refuses seller-level
writes on Appointments Free with a 403, "Merchant subscription does not support write operations"
(https://developer.squareup.com/docs/bookings-api/what-it-is, which also says to check
`support_seller_level_writes` first). A personal access token has every permission, so it always acts as
the seller; a sign-in asks for no seller-level permission, so it always books as a customer. Hence
(`writeLevel`):

- an access token on Appointments Plus or Premium writes as the seller: `seller_note`, which the client
  never sees, and the service's `duration_minutes`;
- Sign in with Square writes as a customer, on every plan: `customer_note`, and no `duration_minutes`
  (read-only to a customer);
- an access token on Appointments Free writes no bookings. It keeps its busy times, and the base
  withholds `write_bookings` from it (§7) with one line saying why and what works instead (Plus or
  Premium, or Sign in with Square where the server has the app). Reading the plan again every few hours
  gives bookings back when the seller upgrades.

**The customer is never told twice.** Square asks every booking for a customer with a phone number
(https://developer.squareup.com/docs/bookings-api/use-the-api#specify-a-customer-for-a-booking), and
Square emails and texts the customer of every booking an app makes, with no way to stop it through the
API (Square staff, 5 May 2026:
https://developer.squareup.com/forums/t/suppress-customer-notification-flag-to-bookings-api/25709).
The inbox has already told the customer, in the business's name. So:

- **Each customer of the inbox has a customer record of their own** at a location: their name (whole,
  never split by guess, in `given_name`), the location's own phone number (`Location.phone_number`), no
  email, a reference only this inbox can make (`inbox-<hash(marker:location:name)>`). The salon's
  calendar shows who is coming; Square's messages reach the business. A customer who was erased has no
  name to show: one record, "Inbox booking", stands for them. Square does not merge records by itself:
  it suggests merging those that share a phone *and* a similar name, and the seller decides
  (https://squareup.com/help/us/en/article/8401). The customer's email, phone and address never go to
  Square for a booking.
- A location with no phone number says so in its chooser ("· add a phone in Square to take
  bookings", drawn even for a single location) before a booking is refused for it; the refusal says
  where to add it in one line.
- The team member is the one Square says is free at that time (`SearchAvailability` for that service
  and start). A booking is **moved in place** (`UpdateBooking` with its version) only when Square says
  its own team member is free at the new time: Square does not check for an app that moves a booking,
  and a seller may double-book. Otherwise a new one is made first and the old one cancelled after,
  since an app that books as a customer cannot change a booking's service or team member. **One
  booking of the inbox never holds two times in Square**: when the old one cannot be cancelled (a
  customer's cancellation window has closed), the new one is cancelled again and the move refused in
  one line, "Move it in Square"; when even that fails, the new one is kept and named, and the old one is
  the owner's to cancel. Cancelling sends the booking's version; a closed window is said in Square's own
  words, with "Cancel it in Square".
- The service is the one of the same name and length. Several of the same length and none named the
  same is refused, never guessed: "In Square, name one Fade, as it is here." There is nothing to choose
  in the owner app (one service for every booking would send a colour to the haircut). A service with
  a cancellation fee is not offered: Square refuses those through its API.
- Idempotency keys come from the connection's marker and what is written, so a retry never books twice;
  a run that stopped before keeping the id finds the booking on the customer's record at its start.

This departs from the connectors list (§2.3), which planned a customer per booking "with a name and
`reference_id` and no email or phone": Square's documentation does not allow a booking without a phone
number, and a record per booking would fill the seller's customer directory with copies.

### 4. The catalogue

Each variation of an item is one product, keyed on its catalogue id, priced at the location (its own
price there when it has one), in stock as Square counts it there (`IN_STOCK`, only when Square tracks
it), on sale while it is sold at that location and not deleted, archived, sold out there, or hidden
from Square Online. Services, gift cards, donations and events are not products. A variable price is no
price. Prices are Square's in the currency's smallest unit
(https://developer.squareup.com/docs/build-basics/common-data-types/working-with-monetary-amounts),
kept here in hundredths: exact for a currency counted in cents and for one with none (¥12,800 is
1280000, ADR-032); one counted in thousandths comes in with no price and stays off sale. A full pass reads
every item (`SearchCatalogObjects`); a pass of what changed reads items and variations changed since
(`begin_time`, deleted ones too, each variation with its item through `include_related_objects`), so a
variation taken off an item comes off sale within minutes; then the stock counts changed since
(`updated_after`), whose variations are read back by id, since a count never changes the catalogue's
version. Pages are fifty items, read up to 8 MB, so a catalogue of many sizes and colours never stops on
one page.

### 5. Orders paid at the seller's own Square checkout

- Each order the inbox accepts becomes a Square order and its payment link in one call
  (`CreatePaymentLink` with an `order`,
  https://developer.squareup.com/docs/checkout-api/square-order-checkout): items of the catalogue by
  their id, at Square's price; anything else by name at the inbox's price, in Square's units (whole yen
  for yen; a fraction of a yen is refused before Square is asked); the order's `reference_id` is the
  inbox's own id for the link, and so is the idempotency key. A pickup is a `PICKUP` fulfillment at its
  time, or `ASAP` from now; a delivery a `SHIPMENT` to the customer's address
  (https://developer.squareup.com/docs/orders-api/fulfillments). The customer's name, email and phone
  (only when written with its country code) are given to the checkout to prefill.
- Taxes are Square's, as the seller set them (`auto_apply_taxes`): Square's total is read back from the
  order it made, and when it is not what the customer accepted the base holds the link (ADR-030 §2). A
  link whose total cannot be read back is never answered: the base tries again, and never sends it
  unchecked.
- **Never `app_fee_money`**, never card details, never a share. The link is Square's checkout, in the
  seller's name, paid into the seller's account.
- Paid is a tender on the order whose payment Square, asked with the key, says is `COMPLETED`.
  Deleting a link "sets the corresponding order state to CANCELED", paid or not
  (https://developer.squareup.com/docs/checkout-api/manage-checkout#delete-a-payment-link), so a link the
  inbox closes has its order read first, and only an unpaid one (a draft, or open with no tender) loses
  its link; one paid meanwhile is left, and `check` says it was paid. Polling says cancelled, or ready
  (a pickup prepared or picked up, a shipment sent with its tracking), one step at a time; a webhook says
  each that holds, picked up included. Refunds made in Square are read per payment (`refunded_money`),
  which marks the inbox's refund done.
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
and orders are read back with the key.

The subscription is made once a hosted inbox is live, moved with the inbox's address, put back when it
was removed in Square, switched on again, and removed on disconnect; a connect again keeps one. Made
again from a sync, its idempotency key comes from the marker, the address and the subscription it
replaces, so a retry whose answer was lost makes no second one, and any other this inbox made for
Square is removed once the new one is in place. One Square would not make or move is tried again an
hour on (`hooksTriedAt`), never on every sync. The key is taken again when RetrieveWebhookSubscription
answers another (the owner made a new one in the Developer Console). A sign-in has no subscription of
its own: it polls.

### 7. The owner app, and what the base gains

The gallery card turns from **Soon** to ready. Settings → Integrations shows a till that takes bookings
as well as payments with both: its line says its products, links waiting ("1 link waiting"), and busy
times "from Square" (a count of busy blocks is no count of appointments). Its Change panel draws the
location with the payment switch, and the booking choices (busy times, bookings, who takes them) under
the booking switch, saved together with Save; "None" is offered only while nothing is chosen. The new
credential is named as the way names it ("New access token"). The connect drawer draws its tabs only
when two ways are ready. This is drawn from the connection, for any connector that books and takes
payments.

The shared base gains, for any connector (ADR-030 §5):

- `ConnectorDefinition.withheld(view)`: what an account cannot do now (`busy_times`,
  `write_bookings`), a line each, read from the connection's `extra`. Withheld capabilities are left out
  of the view's `capabilities`, given as `withheld` for the owner app to say, and never run.
- `ConnectorDefinition.bookingsNote`: a line under "Add confirmed bookings" ("Square texts its
  booking messages to your location's phone, never to your customer").
- `ConnectionChoice.bookings`: a choice about bookings only, drawn with the booking choices; kept
  across a refresh.
- From ADR-032 (the WooCommerce track, the same lines): `isWholeUnitCurrency`, and a shop or till
  (`shop_orders`) may make links in a currency with no minor unit. Whichever track lands first brings
  them; the other's copy merges as the same change.

## Consequences

- A Square connection is the one that makes an order's links in its mode once connected (ADR-030 §2):
  Stripe or Mollie links switch off, and the owner can switch Square's off in Change.
- The seller's Square holds a customer record for each customer of the inbox, under the business's own
  number. Square's confirmations and reminders for the inbox's bookings go to that number.
- On hosted inboxes, Appointments Free sellers (most salons and barbers) get busy times but no bookings
  until Surfing Dog has its own Square app for Sign in with Square. To confirm in a Square Sandbox with a
  free-plan test seller before release: the 403 on a seller-level write, and that a sign-in's bookings
  are accepted on that plan.
- Busy times read for one service can offer a time a service only part of the team takes cannot have;
  writing it is then refused in Square's words and said on the booking.
- Not in this ADR: an app-level subscription for sign-ins (needs our Square app and routing by
  `merchant_id`); seller-level reads of every booking on Appointments Plus and Premium (the availability
  read already covers them); overriding the price of a catalogue item on an order (not documented: the
  link is held when the inbox's price differs).
- Tests: `packages/adapters/test/square.test.ts` (contract, against `fixtures/square.ts`, written from
  Square's documented examples: seller-level writes refused on the free plan, buyer-level fields, a
  link deleted cancels its order paid or not, moves Square does not check) and
  `apps/inbox/test/connector-square.test.ts` (end to end); the base's withheld capabilities in
  `apps/inbox/test/connectors-ways.test.ts` (a barber in Nairobi). A salon in Toronto (CAD), a café in
  Melbourne (AUD), a shop in Osaka (JPY). No real Square is called.
