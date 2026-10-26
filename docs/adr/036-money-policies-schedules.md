# ADR-036 — Money in every currency, policies and payment schedules as data, write first

**Status:** proposed, 20 October 2026. The shared ground the industry tracks build on: stays (ADR-037),
then trades, salons and food. Amends ADR-023 (pay links beyond orders) and ADR-014 (the groups and
capabilities connectors may name). Numbered provisionally; renumbering at merge is fine.

## Context

The founder, 20 October 2026: connect directly to hotels and get them to install the inbox, with
hotel-ready features, and the same for other industries. Every industry needs four things the inbox did
not have, and building each four times would make four versions of them:

- **Money in any currency.** Every amount was kept in hundredths, so JPY, KRW, VND, CLP, ISK and the
  dinars were refused outright: a ryokan in Kyoto or a guesthouse in Kuwait City could not state a
  price. ISO 4217 gives each currency's minor unit; the inbox now keeps that.
- **Cancellation policies.** A stay is free until a date, a salon's booking until a few hours before, a
  table until the day: the same shape, steps before a start, each with a fee.
- **Payment schedules.** A deposit now and the balance later (or at the property), and a card held for a
  no-show. ADR-023 made one link per order for its whole total.
- **Writing first to the business's own system.** A property system, a salon's booking system or a till
  is the authority for what can still be sold; nothing should be promised until it has taken the write.

## Decisions

### 1. Money in the currency's own minor unit

- Every `money.value` is an integer count of its currency's ISO 4217 minor unit: 4500 is KSh 45.00,
  ¥4,500 and KWD 4.500. The exponent comes from one table in the spec (`ISO_4217_MINOR_UNITS`,
  `minorUnits`), which the currency check, the inbox's and the owner app's formatting, money inputs,
  feed prices, rule amounts and the guard that reads amounts in automated replies all read. Fund codes,
  metals and "no currency" are refused for prices. A few codes withdrawn recently stay readable.
- Amounts already stored do not move: for every currency the inbox took before, minor units were
  hundredths already.
- **Each payment platform converts in its own adapter**, from a table with a test per currency
  (`PaymentsHandler.currencyProblem`): Stripe from its currencies page (its zero-decimal list; ISK
  written as hundredths always ending 00; UGX refused, since the page gives it two rules; no currency of
  thousandths, which the page does not list); Mollie from its multicurrency page (ISK and JPY without
  decimals; HUF and TWD only for whole amounts, since Mollie rounds them up for some methods). A currency
  a platform has no test for is refused on the existing refusal path, with the reason, and the customer
  pays the business another way. A platform adapter that says nothing of currencies is asked only for
  currencies counted in hundredths, as before.

### 2. Policies as data

- A business states a policy once (`policySchema`): steps before the start of what it sells, each `days`
  before a date (the end of that local day) or `hours` before a time, with a fee of `none`, a `percent`,
  an `amount`, the first N `units` (nights, sessions) or the `full` price; a no-show fee; and whether a
  deposit is given back with a free cancellation.
- For one booking it is dated in the business's own zone (`datePolicy`, `datedPolicySchema`): local
  dates go through calendar arithmetic only, so clocks that change at midnight, half-hour daylight
  saving and zones across the date line cannot move a step. `feeAt` gives the fee at any moment (at
  least a deposit kept as not refundable, never more than the total), `refundOwed` what is owed back,
  and `policySentence` reads it back in English, Spanish, French, German, Italian and Portuguese, in the
  business's voice.
- Nothing is stored by this: each item type keeps the policy it applies, and shows the dated steps
  before the customer is bound.

### 3. Payment schedules and pay links beyond orders

- `paymentScheduleSchema` is UCP's `payment.terms[].schedules[]` shape: `immediate`, `deferred` (by a
  date) or `at_property`; a quote's schedules always add up to its total (`scheduleProblem`).
- An item type paid in parts registers a **schedule source** that says which entries want a link now. The
  payments side keeps **one live link per item and entry** (`connector_payments.schedule_id`, `purpose`,
  and the live-link index on both; an order's entry is `''`, so an order still has exactly one), closes a
  link whose entry changed or went, closes it on the platform when its window closes (`expires_at`:
  Stripe `active=false`; Mollie `expiresAt` set at creation, then archived), and hands what the platform
  says was paid, read back with the business's key, to the source. A payment that lands too late is the
  source's to take or to leave for the owner to refund in their own dashboard; nothing is refunded here.
  **Orders keep their own path, unchanged.**
- **A card held for a booking** is a Stripe Checkout Session in `mode=setup` on the business's own
  account, made when the guest opens the inbox's own link, charging nothing; the business charges a
  no-show itself, under the policy the guest saw. Its two extra key permissions (Checkout Sessions and
  Customers, write) are asked for only when the owner switches card holds on, and named when missing; the
  probes make nothing. Mollie needs a first payment for a mandate, so it offers a deposit, not a hold.

### 4. Write first

- `writeFirst` (core/src/connectors/write-first.ts): one caller writes for an item at a time (a
  compare-and-set claim on `connector_links`), every attempt is journalled in `connector_writes` (the key
  it was sent under, a hash of what was written, never the request, and its outcome), and a retry under
  the same key is answered, never written twice.
- **A timeout never counts as a refusal while the write may have landed.** It is looked for by its key;
  still unknown, a job settles it within five minutes through the resolver its owner registered: found,
  it is written; never found, it is not. A system that takes an oversold write is read back at once, and
  ours is taken back.

### 5. Names and registries for the tracks that follow

- Capabilities `stay_inventory`, `write_stays`, `stay_events`, `requests_out`, `setup_in`,
  `availability_in`, `orders_out` and `status_in`; groups `lodging`, `work`, `pos` and `booking`
  ("Property systems", "Job tools", "Point of sale and ordering", "Booking systems"); an optional
  `resourceId` on busy reads and booking writes; and `SetupSnapshot`, what a business's own tool says
  about its services, staff, hours and menu, with allergens that always arrive unconfirmed.
- Rule presets are one file each, listed once; the key schema, the plan, the hosted sign-up and the
  owner app follow from the list. Self-host setup opens on "What do you run?", from one `KINDS` list,
  and `ConnectYourSystem` shows a kind's systems first.
- **The customer copy lint** (`customerCopyProblems`): what a business's customers read never names the
  software, a network, receipts, passes, keys, a reputation or the inbox, in any of the six languages.

## Consequences

- Businesses priced in yen, won, dong, pesos without centavos and the dinars can state prices and,
  where their platform takes the currency, be paid through links; elsewhere they are paid at the
  property or another way, and the owner is told why once.
- Every industry track codes against the same policy, schedule and write-first pieces, and adds one line
  to each registry.
- The other connectors workflow's shop and booking connectors gain the same money table and the write
  helper (Square Bookings).

## Not decided here

The stay item type, its machine and its tools (ADR-037). Payment providers beyond Stripe and Mollie for
properties where neither operates (a later payments track).
