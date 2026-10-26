# ADR-040 — Restaurants, takeaways, bakeries and cafés: the menu, allergens, orders for a time, tills

**Status:** proposed, 21 October 2026. Builds on ADR-036 (money in each currency's own minor unit, write
first, slot claims), ADR-039 (the area matcher, files on a request) and ADR-030 (the connectors' shared
base). Spec 0.12.0, migration 0032. Numbered provisionally; renumbering at merge is fine.

## Context

A customer's assistant ordering dinner needs what a shop's catalogue does not carry: a menu in
sections, a pizza's size and what it adds, half-and-half, what a dish contains and may contain, when it
is served, a time to collect it or have it delivered, a delivery zone with its fee and minimum, a tip.
The kitchen needs to say "not now", and to say how far an order is. A bakery takes orders days ahead,
some made for one customer; a café sells out and takes coffee ordered ahead. Most of them already run
an ordering system or a till, which the inbox reads from and writes into, never around.

The rules that do not bend: the business is the merchant and the party to the contract; nothing here
takes card data, sets a price, charges a commission, dispatches a courier or connects a marketplace.
Allergens are never inferred.

## Decisions

### 1. The menu

- A product is on a menu when `products.menu` holds its menu fields (`menu/schema.ts`): its section,
  its option groups, its allergens, dietary tags, an age limit, the dayparts it is served in, whether it
  is a deal, how far ahead it must be ordered, a daily cap, the days it is made, dates it is not, whether
  it is made to order, and a bakery's brief (servings, flavours, the length of the writing on it, a
  photo). Settings → Menu holds the sections and the dayparts (`settings.menu`).
- **Option groups, one level deep**: each with a minimum and a maximum; each choice adds an amount per
  unit in the item's currency, and may open one other group (a size opens its crust). A group that a
  choice opens opens nothing (`optionGroupsProblem`). A group may take **halves**: a choice on the left
  or the right half, at its half price where it has one (`halfDelta`).
- **Priced from the menu, never from the agent**: the inbox writes each line's options with the
  business's names and what each adds, and the line's price is the product's plus what its options add,
  on the list price and the customer's price alike (`write/pricing.ts`, `menu/options.ts`). What an
  agent sent as a delta is ignored. The owner's limits judge a line against that list price
  (`linePricing` carries the options, a group's default choices included when none were sent), so a
  larger size is at its list price, never above it. A zone's minimum counts what the options add.
- **What the menu says of a dish holds together**: a dietary tag its own allergens contradict is refused
  (`menu.dietary`, spec `DIETARY_CONFLICTS`): gluten free beside a gluten cereal, dairy free beside milk,
  nut free beside peanuts or a tree nut (in what it contains or may contain), vegan beside milk, eggs,
  fish, shellfish, gelatin or meat, vegetarian beside the same less milk and eggs. The owner's editor
  does not offer such a tag.
- **Withdrawal follows the menu** (ADR-018 §7, 2011/83/EU art. 16): a dish put on the menu is the
  `perishable` exception, one made to order the `personalised` one (and back to `perishable` when it no
  longer is); a service booked by covers is `dated_leisure`. Only an exception the inbox set follows the
  menu; one the owner chose stays theirs. The confirm step and the emails then say the exception, never
  the fourteen days.
- A dish off sale (`active = 0`) is refused by its id too (`not_available`), not only hidden.
- A dish brought in again from its tool takes the tool's name, price and option groups, and keeps every
  field the owner set here (caps, notice, days, dayparts, made to order, sort, a choice's allergens);
  its allergens stay as they are when the tool sends none, and are unconfirmed only when the tool's
  lists differ. A Toast item keeps its menu group (`externalGroupId`), which Toast's orders name.
- `get_menu` (MCP and `GET /v1/menu`) gives the menu by section with prices in minor units, the options,
  allergens with their status, dietary tags (a free-from tag with the allergens' status), the age limit,
  dayparts, whether it is available now, and today's sold-out items.

### 2. Allergens

- `packages/spec/vocab/allergens.json`: 46 codes in seven languages (en, es, fr, de, it, pt, ja), with
  the law of each jurisdiction that names them and its source: the EU and UK 14 (Regulation 1169/2011,
  Annex II), the US 9 with sesame (FALCPA and the FASTER Act), Canada's priority allergens, Australia and
  New Zealand's required names (Standard 1.2.3), and Japan's 9 to be declared and 20 asked for (Consumer
  Affairs Agency, April 2026). A part reads as its whole (walnut is a tree nut; wheat is a cereal
  containing gluten: `expandAllergens`). Mexico, India and the rest have no list here: the owner's grid
  then shows the ones some law names, and every one under All.
- **Never inferred.** Nothing reads a dish's name or description for allergens. A dish's lists are
  what the business states; what an import or the owner's AI writes arrives `unconfirmed`, with where it
  came from.
- **Only a person at the business confirms**, in the app: the owner or staff, signed in or with an owner
  key, never through the owner's MCP, never with an integration key (`mayConfirmAllergens`). A confirm
  carries the fingerprint of the lists the person was shown (SHA-256 of their canonical form, with each
  choice's allergens and the free-from tags); lists that changed since are refused (`allergens_changed`).
  The confirm writes only over the menu exactly as it read it (a compare-and-set): a change another
  person saved between the read and the write is never written back as confirmed. Any change that
  touches what they speak for makes them `unconfirmed` again.
- **Unconfirmed is "ask the business"**: that is what agents are told, in the customer's language, and
  never that a dish is free from anything. An order with an unconfirmed dish waits for a person on every
  door (`payload.kitchen.hold` names it; the guard refuses a rule's or a key's accept: `kitchen`).

### 3. Orders for a time

- Settings → Kitchen (`kitchen/settings.ts`): on or off; how long the kitchen needs; slots of 10, 15,
  30 or 60 minutes inside the opening hours; how many orders one slot takes **here** (what the kitchen
  set aside, on top of the till); how far ahead; collection, delivery and eating in; who accepts (each by
  a person, or at once inside what was set aside); tips; and whether a pause pauses the ordering system
  too.
- `list_order_slots` (MCP and `GET /v1/order-slots`) gives a day's slots for a method, the delivery zone
  an address falls in with its fee, minimum and time, and says why there are none (closed, paused,
  outside every zone, nothing for delivery).
- **A slot is never sold twice here**: an order claims `order-slot:<location>:<start>` places in
  `slot_claims` with the item's insert, in one batch; the primary key decides a race for the last place
  on both runtimes, and the loser is told the slot is full. Each dish's daily cap is claimed the same way
  (`menu-cap:<product>`). A declined, cancelled or expired order gives its places back.
- **Instant only inside the caps**: an order is marked `instant` only when its slot had room, each dish
  was within its cap, every allergen was confirmed, nothing is made to order, and the kitchen accepts at
  once. Everything else is a request for a person (`payload.kitchen` with its holds).
- Notice, the days a dish is made and its blackout dates are checked against the slot. A daypart may run
  past midnight (22:00 to 02:00: its days from 22:00, and the mornings after until 02:00). **Made to
  order** is on request and is the `personalised` exception to withdrawal (ADR-018 §7).
- **A person who accepts an order over a daily cap** gives it every place still free under the cap that
  day, so the orders after it wait for a person too and automation never sells past what was set aside.

### 4. The order

- A line takes `options` (`[{groupId, choiceId, portion}]`), a `note` of 140 characters ("no onions")
  and a bakery's `brief` (servings, flavour, the writing on it).
- `payload.fulfil`: the method and the slot, and for delivery the address's point when the agent has
  it; the inbox writes the zone it fell in, its fee and its time. The zone is trades' exported
  `matchZone` (rings by distance from the premises, or postal prefixes); nothing about the area module
  changed.
- `payload.tip`: a percent of the food or an amount, where the business takes tips; the total is the
  food, the zone's fee and the tip, on the business's own pay link. The owner can switch tips off.
- The customer's emails list each line with its choices and note, then how and when, the zone's fee and
  the tip, so the lines add up to the total.
- **Progress inside fulfilling** (`payload.progress`): preparing, ready, out for delivery (a delivery
  only), with when and an expected time. Fields, not states: the order machine is unchanged. An accepted
  or paid order starts fulfilment first. The customer's agent reads it on `get_item_status`; a webhook
  carries `order.progress`.

### 5. The pause

Any person at the business pauses orders for 15, 30 or 60 minutes or the rest of the day, and resumes,
from the inbox's home (on a phone, above the conversations). Never the owner's AI. Agents are told when
orders start again. With `pausePos`, a connected system that can be paused is paused too (Flipdish:
`Closed` overrides on collection and delivery on the store the owner chose, never another; their ids kept
sealed, and only those removed on resume: a closure the owner set in Flipdish stays). The switch shows
only when Flipdish is connected.

### 6. Tables

A service may be booked by covers (`services.capacity_unit = 'people'`, `table_rules`): the largest
party; a request for a price above a size; a deposit per person from a party size, on the business's own
pay link; a policy. **Instant only for the covers set aside**: the service's capacity is the covers set
aside and nothing more, and a booking confirms at once only when what is left of them holds the whole
party (the slot claims count people); a larger party, and every table when none are set aside, waits for
a person (guard `tables`, reasons `over_set_aside`, `none_set_aside`). A person's confirm seats the
party from the whole room, never held to that number, and its places are counted, so automation sees
them taken. A deposit becomes a payment schedule only when no other booking schedule source is
registered (salons' deposits take precedence at merge).

### 7. Bakeries and cafés

A bakery's dish carries its notice, the days it is made, a daily cap and, for a cake made for someone,
its brief; the order's line its writing and servings. A café's dish is **sold out today** with one press
and comes back the next day on its own (`products.sold_out_on`, the business's local date).

### 8. Presets

`food` (Restaurant & takeaway), `bakery` and `cafe`: an order the kitchen marked instant is accepted;
every other waits for a person, soonest first; a table inside the covers set aside in a free sitting
within opening hours is confirmed, any other waits; events and catering are requests for a price. The
setup's first question gains **Restaurant or takeaway**, **Bakery** and **Café**. For them the wizard
asks what agents can do as a kitchen does (orders for a time on; a restaurant books tables; a café takes
no requests for a price to begin with), then **Your first dishes**: name, price and a section chosen
from a short list, each put on the menu with its allergens for the owner to state and confirm. The last
step says that every order waits for the owner until they choose otherwise in Settings → Kitchen (the
kitchen starts on "I accept each"), and lists the menu first under "Not set up yet" while it is empty.

### 9. Ordering systems and tills

Each built from its vendor's published reference, checked against a local fake
(`packages/adapters/test/fakes/pos.ts`, `fixtures/pos.ts`), never with a real account.

| System | State | What it does | Reference |
| --- | --- | --- | --- |
| GloriaFood | On: the restaurant's own keys | Menu in; accepted orders, only if the owner switches it on, for their eyes alone (`pos_orders`, no customer details, no receipts); a push let in by the master key, compared in constant time, that only makes the next read happen | <https://github.com/GlobalFood/integration_docs> |
| Flipdish | On: an OAuth app the owner makes in their own Flipdish account (client id and secret) | Menu and collection hours in; the store closed while paused | <https://developers.flipdish.com/docs/api-overview>, <https://api.flipdish.co/swagger/docs/v1.0> |
| Toast | Built, off: Needs setup (a Toast partner app) | Menu in by restaurant; accepted orders written into the till with an external id; its approval read back | <https://doc.toasttab.com/openapi/> |
| Lightspeed Restaurant (K-Series) | Built, off: Needs setup (a partner app) | Menu by location; accepted orders as to-go orders, a duplicate treated as written | <https://api-docs.lsk.lightspeed.app/source.json> |
| Clover | Built, off: Needs setup (an App Market app; North America, Europe, Latin America) | Menu; accepted orders as atomic orders; status read back | <https://docs.clover.com/dev/docs/create-an-atomic-order> |
| Deliverect | Built, off: Needs setup (a certified channel) | Accepted orders into the channel link; its signed status updates (HMAC-SHA256, constant time) become progress | <https://developers.deliverect.com/v3.0-ordering-experience/docs/channel-api-overview> |

Writes go first into the write journal (`connector_writes`, op `order`, owner `food`), so a retry or a
lost answer never writes an order twice where the system can find it again. A refusal from the till
comes back to the owner as a note on the order, written in the same batch as the till's word is kept.

- **When it goes in**: at its accept when it is paid at the handover; once paid when the business's pay
  link is on its way (a till never takes an order paid by link as cash, nor makes one whose link is
  open).
- **A till that never answered** (a timeout, a 5xx, an answer that does not read): a person is told at
  once that it has not answered, and the write is looked for by its key for five minutes. Not found, it
  is written once more where the till answers a repeat of the same key as the same order
  (`OrdersWriter.idempotent`: Toast's `externalId`, Lightspeed's `thirdPartyReference`, Deliverect's
  `channelOrderId`), and a person is told to look in the till after the second time. Clover is never
  written again: a person checks it there.
- **Cancelled here after it went in** (cancelled, declined, lapsed unpaid): a job marks the order for a
  person, to cancel it in the till too.
- **Nothing is left out silently**: a line or a choice with no id in the till is refused with its name,
  for a person to put in by hand; Clover takes up to 200 units in one order made here, one line each,
  never cut. Deliverect gets each item at its price without its options and each option at its own.
- Toast's orders name each item's menu group and each modifier's option group, carry `deliveryInfo` for
  a delivery, and no customer (Toast takes one only with a last name, an email and a phone). Its login's
  token is kept sealed until it runs out, and asked for again after a 401.
- Deliverect's signed word is believed only with the secret made in its Integration settings; the
  channel link signs only in staging.
- Every open order written to a till is asked about in turn (the oldest-asked first), never the same
  twenty.

## Consequences

- The menu is the business's: prices, what each option adds, caps and allergens. The inbox writes
  nothing on its own behalf and charges nothing.
- A hosted inbox needs the partner apps of Toast, Lightspeed, Clover and Deliverect on the host before
  they show anything but Needs setup; each is in the founder's checklist.
- Not built: Lightspeed's order status (its reference gives none to read back); finding a Clover order
  again after a lost answer (Clover documents no idempotency key and no lookup by the app's own
  reference, so a write whose answer never came is left for the owner to check in Clover, never sent
  again); cancelling in the till from here (Toast's void, Clover's delete, Deliverect's cancel: a person
  is told to do it); Deliverect's menu push; a "your order is ready" email to the customer (the
  agent reads progress); Japan's "may contain" on labels, which the CAA does not allow on packaged food
  (a restaurant's spoken "may contain" is kept, and said only as the business's).
- To confirm in each sandbox once one exists: whether Toast's `GET /orders/v2/orders/{id}` finds an order
  by our `externalId` (its reference names the GUID), Deliverect's token body and which `courier` it
  wants for collection.

## Open questions

- What a kitchen tells agents is in English, Spanish, French, German, Italian, Portuguese and Japanese
  (the allergen labels' seven). Chinese, Korean and Arabic are the next to add, then Hindi.
