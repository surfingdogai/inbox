# ADR-033 — Stays: a place to stay in its own inbox, and property systems

**Status:** proposed, 20 October 2026. Builds on ADR-032 (money in every currency, policies and
payment schedules as data, write first) and on the connectors base (ADR-026). Amends ADR-023 (pay
links for deposits, balances and a card to hold a stay), ADR-018 (changes and the confirmed fee of a
cancellation, for stays), ADR-022 (calendar links per room, as hints) and ADR-014 (the `lodging`
group). Spec 0.10.0, migration 0026. Numbered provisionally; renumbering at merge is fine.

## Context

The founder, 20 October 2026: connect directly to hotels and get them to install the inbox, with
hotel-ready features, and the same for other industries. A hotel, a B&B, a guesthouse, a hostel or a
holiday rental could not use the inbox for what it sells: a booking is a slot of minutes on one
resource, with one price. A stay is nights between two local dates, rooms as lines, a total that
includes every tax and fee, a deposit now and a balance later, a cancellation policy dated for those
nights, and a room that must never be sold twice while the property also sells it on other channels.

Everything here is fictional and spread across the world in the tests: Ryokan Hoshi (Kyoto, JPY),
Kijani House (Nairobi, KES), Maple Hollow B&B (Nova Scotia, CAD) and Dar Al Bahr (Kuwait City, KWD).

## Decisions

- **D1. Stays are their own item type, `stay`, with their own machine** of fourteen states:
  `requested`, `needs_info`, `quoted`, `held`, `booking`, `awaiting_payment`, `confirmed`,
  `checked_in`, `completed`, `declined`, `expired`, `cancelled_by_guest`, `cancelled_by_property`,
  `no_show`. `booking` is a write in flight to the property's own system. There is no "offered"
  state: an offer is a signed object (§6.1). Changes use ADR-018's change transitions on `confirmed`.
- **D2. One event, twin transitions.** An acceptance, a booking, a write that landed or a payment
  leads where the stay's terms say: `accept` to `confirmed`, or `accept_pay` to `awaiting_payment`
  when something is due now; `book` and `book_pay`; `written` and `written_pay`; `record_payment` and
  `record_part_payment`; and `late_payment` from `expired`. The inbox picks the twin; callers name
  only the event.
- **D3. Request mode is the default.** The guest's assistant asks; the property answers with a
  binding quote (its own total, its policy as dated steps, its schedule, until when it holds). The
  guest accepts on the terms they were shown (`terms_sha`) and the room is theirs.
- **D4. A stay is confirmed at once only where a room cannot be sold twice**: rooms the owner keeps
  for direct guests and has closed on every other channel (an allotment, saved only with that
  checkbox), or the property's own system, connected, fresh, asked live, and written to first. A
  calendar link from another channel is a hint and never makes anything instant (§4.4).
- **D5. The business is the merchant and the contract party.** Deposits and balances are pay links on
  the property's own payment account; a card to hold a stay is a session in setup mode on the
  property's own Stripe. We never take card data, set a price, charge a commission on a booking or
  move a refund: a refund owed is written down for the owner, never paid by the inbox.
- **D6. Total price, always.** A quote's lines add up to its total and its schedule does too, with
  every tax and fee in it, including those collected at the property (`checkStayTotals`).
- **D7. Guests hear only from the property,** in its name and language (six of them), and private
  arrival details are sealed and sent only to confirmed guests.
- **D8. On-property extras only.** Breakfast, parking, a cot, late check-out: never a transfer, a tour
  or car hire, so a stay never bundles another trader's travel service (Directive 2015/2302 Art. 3(5)).
- **D9. No property system is called working until its own connector is on main and deployed.** This
  build is the seam, the contract kit, a generic fake, and the gallery card with each system "Soon".
- **D10. The owner's alone, in person:** how stays confirm (`mode`, `instant`, `fresh_minutes`), the
  rooms kept for direct guests, policies, deposits, guarantees, a plan offered to guests, the
  registration number and the connected system. The owner's AI may fill in rooms, rates, fees and
  extras of what guests are not offered yet, and may quote only from the rates.

## 2. Data

### 2.1 Tables (migration 0026)

`properties`, `room_types`, `rate_plans`, `stay_policies`, `rates` (a base price per plan and room
type, and seasons with weekdays), `stay_fees`, `stay_extras`, `allotments`, `night_closures`,
`night_claims` (one unit of one room type on one night, primary key `(room_type_id, night, ordinal)`,
with `hold_until`), `stay_ari` (what the property's system says, with its source and when it was
read), and `offer_drafts`. Room types and rate plans carry the system's `external_id`, so there is
no second copy of rooms.

### 2.2 The payload

`stayPayloadSchema`: local dates (nights are their difference, never minutes), rooms as lines, the
guests, the requests in their own words, the quote in force, the estimate the rates gave before it,
the hold, the payments as they stand, the cancellation, where availability came from, the system's
own booking, and a change asked for. Only the property, or the inbox for it, writes `quote`,
`payments`, `cancellation` and `external`: a request never sets them. `startTime`, `endTime` and
`totalPrice` are written by the inbox, so the existing columns, indexes and sweeps work as for a
booking.

## 3. The machine

The machine is data (`machine/stay.ts`); the write algorithm interprets its guards and effects, and
the stays layer (`stays/transition.ts`) plans the night claims and statements for one transition in
the same batch. A promise made, waived or broken on a person's word (`record_accept`, `waive_payment`,
`record_cancel` lower than the policy, `no_show`) is never automation's.

## 4. Availability

### 4.1 Three modes, one per property, read back as one sentence

`request` (every stay is answered), `allotment` (rooms kept for direct guests confirm at once inside
their nights) and `connected` (the property's system, written to first). The owner reads the mode
back as the sentence agents are given, e.g. *"Kijani House answers every request within 4 hours."*

### 4.2 Night claims

Accepting, holding or booking claims one unit per room per night in the same batch as the state
change. The primary key decides the last room: two guests accepting at the same moment, exactly one
stay is confirmed, the other gets `slot_taken`.

### 4.3 Holds

A hold claims its nights until `hold_until` (10, 20, 30 or 60 minutes, the owner's choice). A sweep
lets lapsed holds go. A stay in `booking` keeps its claims for a day, and the sweep never lets them go:
a write that may have landed is settled by its resolver, never by a timer.

### 4.4 Calendar links are hints

A calendar link mapped to a room type (one per listing on another channel) says which nights that
channel took. A night is noon on its date to the midnight after, in the property's zone, so an
all-day event from check-in to check-out covers exactly its nights. A hint never claims, never
confirms and never declines: the owner sees a marked night, an agent reads `likely_taken`, and rule R4
asks a person.

### 4.5 The property system's cache

What the property's system says is free is kept in `stay_ari`, read every 15 minutes while stays are
near and every 6 hours otherwise, within the system's own budget. Agents are offered instant rooms
only when the cache is fresh (5, 15 or 60 minutes, the owner's choice) and the system is asked again,
live, at hold and at book. A webhook from the system only marks nights stale; they are read again.

## 5. Prices, policies and payments

### 5.1 A quote from the rates

Night by night from the rate plan's base price and its seasons (weekdays included), extra adults and
children above the base, children free under an age, derived plans (a percentage off another), each
line rounded half-up once. Automation may only quote from the rates; a quote with prices of its own
is the owner's to send.

### 5.2 Taxes and fees

Per stay, per night, per room per night, per guest per night, or a percentage of the room price;
steps by nightly price, a cap on nights, children exempt under an age; collected with the booking or
at the property. Every one is in the total.

### 5.3 Policies

Presets in (free until 1, 2, 3, 7, 14 or 30 days before, then the first night, half or everything;
non-refundable; or custom steps), dated steps out (ADR-032 §2). A step's until is the last second of
its local day. A cancellation the property writes down is judged as of when the guest asked, and can
only lower the fee; lower than the policy only by a person.

### 5.4 Deposits, balances, a card to hold the stay, and refunds owed

Each plan says what is paid when the guest accepts (nothing, the first night, 20, 30 or 50%, or
everything) and when the rest is (at the property, or 7, 14 or 30 days before). Each schedule entry
gets its own pay link on the property's account when it is due: the deposit's window closes with the
pay window, the balance's opens three days before it is due. A card to hold the stay is made when the
guest opens its link. A payment that lands after its window takes the nights again when they are
still free (`late_payment`) and is otherwise written down as a refund owed: a linked refund item,
approved, with the owner's note *"Refund … Nothing is refunded automatically."*

## 6. Doors

### 6.1 For guests' assistants (MCP and REST)

`get_property`, `check_stay_availability`, `quote_stay`, `request_stay`, `hold_stay`, `book_stay`,
`change_stay`, and the existing `accept_offer` (with `terms_sha`), `decline_offer`, `cancel_item`
(with `fee_sha` for a confirmed stay), `get_item_status` and `send_message`. Listed only once the
property has a room to offer.

- An instant room comes with an offer: an id only this inbox can make (HMAC), valid 15 minutes.
- `book_stay`, `accept_offer` and `change_stay` without the fingerprint of the terms the person
  confirmed answer `409 confirm_terms` with those terms; with a stale one, `offer_changed`.
- A cancellation of a confirmed stay answers its fee and what is owed back first (`fee_sha`).
- At most two open holds per person and per agent.

### 6.2 For the owner and the owner's AI

The property, rooms, plans, rates, fees, extras, rooms kept for direct guests, closed nights,
calendar links per room, the Nights grid, Today, a quote drafted from the rates, the system's
properties and the matching of its rooms, and a read of the system now. D10 says which are the
owner's alone.

### 6.3 Manifest and profile

`item_types` gains `stay`; the stay door says how the property confirms, how soon it answers and how
a stay is secured; the profile gains `lodging` (kind, rooms, check-in and check-out, confirmation,
how soon it answers, and a registration number where one is required). A rental whose area requires
a registration number takes no stays until it has one.

### 6.4 Elsewhere, and the business's own page

A property that takes stays at its own booking engine keeps a stay door elsewhere with the engine's
deep link (`{check_in}`, `{check_out}`, `{adults}`, `{children}`, `{rooms}`): agents are sent there
with the dates filled in. The business's own page carries the place as schema.org reads it: a
LodgingBusiness of its kind, each room offered as a HotelRoom, and an Offer with a price only where a
stay is booked at once, since anywhere else the price is the property's answer to a request.

## 7. Rules (preset `stays`)

| | Rule | Does |
|---|---|---|
| R1 | Draft a quote from my rates | Drafts the quote for a person; never sends it |
| R2 | Send the quote at once when the rooms are kept for direct guests | Only inside an allotment; left out when the owner confirms each stay |
| R3 | Say sorry when you are full | Only when the property is full by its own word (closed or claimed) |
| R4 | Ask me when another calendar shows the nights as taken | A note and needs-a-person; never declines |
| R5 | Accept date changes while cancellation is free | Off until the owner switches it on |
| R6 | Messages before arrival | Not a rule: the stay's scheduled messages (§10) |
| R7 | Ask a person about anything else | |

R8, no deposit for a guest the property knows, waits until customer standing is in use again, and is
not built.

## 8. Property systems

### 8.1 The gallery

A "Property systems" card in the `lodging` group, shown only to a place to stay, with Beds24,
Hostaway, Smoobu, Guesty, Mews, apaleo and Cloudbeds, each "Soon" until its connector is registered,
and calendar links per room, which work today.

### 8.2–8.4 Each system

None is built here (D9). Each is its own track, built from its official documentation, with recorded
fixtures and a local fake, never with real credentials: Beds24
(<https://wiki.beds24.com/index.php/API_V2.0>), Hostaway (<https://api.hostaway.com/documentation>),
Smoobu (<https://docs.smoobu.com/>), Guesty (<https://open-api-docs.guesty.com/>), Mews
(<https://docs.mews.com/connector-api/>), apaleo (<https://api.apaleo.com/>) and Cloudbeds
(<https://developers.cloudbeds.com/>). A system that needs a partner or developer account ships
code-complete but switched off, saying "Needs setup", with a checklist for the founder.

### 8.5 The seam and its contract

`ConnectorDefinition.stays` (`PropertySystem`): `writeGuard`, `hold`, `pricing`, `hosts`, and
`properties`, `rooms`, `ratePlans`, `ari`, `quote`, `reserve`, `release`, `modify`, `cancel`, `get`,
`find`, `receive`, `subscribe`, `budget`; capabilities `stay_inventory`, `write_stays`,
`stay_events`. Writes go through the write journal (ADR-032 §4) with our reference, so a retry finds
its own write. A `check_then_write` system is read back after the write; a conflict cancels our own
write and the stay is on request. `packages/adapters/test/property/contract.ts` is the contract
every adapter runs against its own fake; the generic fake runs it here.

## 9. Onboarding

The setup wizard's "A place to stay" asks for the place (kind, check-in and check-out) and its rooms
(name, how many, how many sleep), applies the `stays` rules, and leaves prices and policies for
Settings → Property, so every request waits for the owner's quote until they are set. A hosted
inbox's setup plan may name the `stays` preset, the `stay` door and a stay door elsewhere with its
deep link; it never makes a property, a room or a price.

## 10. Guest messaging and arrival details

One thread per stay, in the property's name. Before arrival (2 days by default), the arrival
details (2 days, sealed at rest, opened only as the email goes, never shown on a page or to an
agent), and a thank-you after the stay only when the owner switches it on.

## 11. Before a guest is bound; the owner's screens

A guest sees the total, the schedule, the policy dated for their nights, the property's registration
number where it has one, and what cancelling costs now, before they accept, book, change or cancel.
The owner's screens: the confirmation sentence and mode (S1), "Connect your system" with the
property chosen and rooms matched (S2), Property, Rooms, Rates, Policies, Taxes & fees and House
rules & arrival (S3–S9), the Nights grid with rooms kept for direct guests and closed nights (S10),
a stay in the list (S11) and in detail (S12), the quote composer (S13), Today (S14) and the owner's
emails in their own words (S16).

## 12. Guest pages and emails

The pages behind an email's links (G1–G5: accept the quote, other dates, cancel, a card to hold the
stay, the change answered) and six emails (G1–G6), in English, Spanish, French, German, Italian and
Portuguese, each checked by the copy lint: no guest string names us, a network, a receipt, a pass, a
key, a reputation or an inbox.

## 14. Tests

Rows of the design's test table, with the generic fake: the machine, night claims (the last room
once, ten holds at once give one), prices (JPY, CAD, KES, KWD), policies (inclusive until, lowered
only by a person), rules R1–R5, copy in six languages, pay links (deposit window, late payment
retaken or owed, balance link, card in setup mode), the doors (holds, `confirm_terms`, `fee_sha`,
elsewhere), calendar hints, schema.org, the owner app's words, and three stays end to end: Kijani
House (KES, pay at the property), Ryokan Hoshi (JPY, the generic system and Stripe as fakes) and
Maple Hollow (CAD, rooms kept for direct guests).

## Consequences

- An inbox with an active property and a room to offer lists `stay` and the stays tools; any other
  inbox is unchanged.
- Night claims are the one place availability is decided for stays; minute buckets never see a stay.
- Writes to a property's system are journalled before they are sent; a stay waits in `booking` until
  the system answers or is proved not to have taken it.

## Not decided here

- A network relaying offers for stays (`search_stays`).
- Stay outcomes on network receipts (rules version 7): until then receipts for stays are signed and
  kept by both sides, and a network does not publish them.
- UCP Lodging: mapped in its own track, off until it leaves draft.
- Payment providers beyond Stripe and Mollie, for properties where neither operates.
- Counsel on travel-intermediary status and short-term-rental rules per jurisdiction, before stays are
  shown as bookable on a network.
