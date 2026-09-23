# ADR-018 — Negotiation: offers, changes and returns

**Status:** accepted, 23 September 2026. Drafted, then revised the same day after an independent
review; Tiago decided the six open questions the same day (**Q1**–**Q6**, in Decisions below and
marked where they bite), and the body follows his answers. **Q5 shipped first, on its own, as a fix
to the code of that day** (§3.2); the rest is not built yet. A number marked \* is a *default*
Tiago may change without a new ADR. The legal points are research, not advice, and need
a lawyer before they become Terms or public copy.

Tiago, 23 September 2026: *"negotiation, quotes, negotiating time, prices, returns... we need to
handle all of that"*, and *"most times the customer does not know it is using our network or
system. they just contact a business, keep that in mind"*.

## Context

In the deployed code (`0f1957f`) no public door lets a customer accept or decline a quote or a
proposed time; neither can be revised or answered; a confirmed booking or accepted order cannot be
changed, so an agreed reschedule is a cancel (broken for a business under ADR-017); `validThrough`,
`autoExpireHours` and `holdOnPropose` are read by nothing; no door creates a refund; the owner's AI
has no money limits; and customer emails carry no terms and do not thread. The inbox side of
reputation (`572c2bb`, the same day) already speaks to the customer as the business
(`describeToCustomer`, `customerMail`), but its presets still confirm bookings under €50 and accept
orders up to €200 **at whatever price the agent wrote** (`rules/presets.ts:57,113,181`), and the
owner's AI can lower any catalogue price (`upsert_product`). Gaps N1–N21 are in `code-map.md`; the
research is `protocols.md`, `patterns.md` and `law.md`, all of 23 September 2026.

## The decision in one screen

1. **One object, the offer:** an immutable, fully priced snapshot of terms in `item_offers`, for a
   quote, a proposed time, a counter, a change to a promise, or a return's settlement. Six verbs:
   offer, counter, accept, decline, retract, expire. One open offer per item; accepting names the
   offer's `terms_sha` and applies the terms in the same batch.
2. **The customer's request is the first offer**, taken by the business's `confirm`/`accept`; a
   business offer is taken by the customer's `accept`. Time, price and scope share this one shape.
3. **After the promise, a change is an amendment, never a cancel.** Declined or expired, the
   original stands; accepted, it moves the promise's time and due date.
4. **A return is a `refund` item whose settlement is an offer.** A statutory withdrawal in time
   cannot be declined by anyone; anything less than a full refund needs the customer's yes.
5. **The owner's limits are code, not prompt.** Checked in core for the owner's AI, integration
   keys and rules; outside them an offer is a draft for a person, never sent and never a refusal.
   Automation may accept a price or leave it to a person, never haggle one, never price above list,
   and never learns the floor as a number. Only the owner in person sets limits, floors, rewards and
   prices downward.
6. **The customer only ever meets the business:** "we", the terms, the deadline, links to accept,
   change or decline. The business is bound by what it sends; the customer only through a confirm
   step echoing the summary it saw (CRD art. 8(2)). The business prices catalogue lines and
   fixed-price services (Q5), a fix that ships before the rest.
7. **Haggling never counts (Q4, rules version 5).** An agreed change amends the promise; a refund
   paid on time is kept, a late one broken, and a lawful return refused is broken by verified
   report.
8. **A good record may earn a better price (Q3)**, only through the owner's own reward rules:
   applied by the inbox, never chosen by the AI, never below the owner's floor, never above the list
   price, and always with the personalised-price notice in the business's voice.

## Decisions

Tiago, 23 September 2026, answering the six questions put to him:

| # | Question | Decision | In Tiago's words |
|---|---|---|---|
| Q1 | Can customers haggle on price? | Off by default; the owner can switch it on (`negotiation.priceCounters`). Time, quantity and delivery can always be countered. While it is off, a price counter goes to a person as a message and is never refused (§4). | "Off by default, owner can switch on" |
| Q2 | What may the owner's AI and rules agree to on their own, out of the box? | Time yes, money no: any free time within 7 days, a reschedule before the cutoff, returns inside the policy, recording withdrawals; never a discount, a custom line's price or a refund payment. The owner can change each one (§4, §10). | "Time yes, money no" |
| Q3 | May a customer's good record get them a better price? | Yes: rewards the owner sets as rules, within the owner's limits, never worse than the list price, applied by the inbox and never by AI haggling, with the personalised-price notice in the business's voice whenever a price is personalised by automated decision (CRD art. 6(1)(ea)) (§4, §5). | "yes, thats the whole plan, reward good clients" |
| Q4 | How do negotiated changes and returns count in the network? | All of it, as network rules version 5: `amended` receipts; `refund.honoured` and `refund.late` on the refund's own receipts; a refused lawful withdrawal broken by verified report (`order.refund_refused`); `trm` on promises (§8). | "All of it, one rules version" |
| Q5 | Does the business, not the customer's assistant, set the price? | Always the business, for catalogue lines and fixed-price services. It ships first, on its own, as a fix (§3.2). | "Always the business" |
| Q6 | The code for the customer's assistant, in the business's emails | Only in its own short email, a day after the first contact, in the business's name; it rides on no other email (§12). | "Its own short email, a day later" |

Five answers are the options recommended to him. Q3 is not: the recommendation was no price
rewards in the first version, to stay clear of GDPR art. 22 and of "prices depend on your score".
§4 says how rewards stay on the right side of both. The rules Tiago had already set hold
throughout: the customer usually does not know the inbox or any network exists, so everything they
see speaks as the business; positive first; the owner's limits are code, not prompt; settings
merge; both runtimes; every write is one batch (D1 has no interactive transactions).

## 1. The offer

| Column | Meaning |
|---|---|
| `id`; `item_id`, `rev` | ULID; `rev` 1, 2, 3 … per item, `UNIQUE(item_id, rev)` |
| `parent_id` | The offer it answers, or the agreed offer it would change; null for the first |
| `kind` | `offer` (before the promise), `change` (amends a promise), `resolution` (settles a return) |
| `by`, `actor_kind`, `actor_id` | `business` or `customer`, and exactly which actor (`owner`, `owner_ai`, `integration`, `rule`, `system`, `customer_agent`, `customer_human`) |
| `round` | 1, then +1 per counter. A negotiation is the chain since the item's last accepted offer. |
| `status` | `draft`, `open`, `accepted`, `declined`, `countered`, `retracted`, `expired`, `superseded` |
| `valid_through` | unix ms, checked **in the write** at accept; the sweep only tidies |
| `terms`, `terms_sha` | The full snapshot, never a diff; base64url(SHA-256(RFC 8785 JCS(terms))) |
| `shown` | Exactly what the other side saw: `{human, lang, disclosures[], summary}` (the trader's burden of proof, CRD art. 6(9)) |
| `authored` | `person`, or `automated` (AI, rule, integration); drives the disclosures (§5) |
| `binding` | 1, unless the offer says plainly "subject to our confirmation" (Civil Code art. 230) |
| `reason_code`, `note` | The customer's reason for a decline or counter, in ACP's `intent_trace` codes (`price_sensitivity`, `timing_deferred`, `returns_policy`, … `other`) |

```jsonc
{ "lines": [{ "productId": "…", "serviceId": "…", "name": "…", "quantity": 2, "unitPrice": { "value": 1400, "currency": "EUR" } }],
  "charges": [{ "kind": "delivery", "name": "Delivery", "amount": {…} }],   // never negative
  "totalPrice": { "value": 3300, "currency": "EUR" },   // incl. VAT; server-checked = Σ lines + charges, business currency
  "startTime": "…", "endTime": "…", "partySize": 4,     // bookings, and quotes that create one
  "options": [{ "startTime": "…", "endTime": "…" }],    // ≤ 3 alternative times at the same price; accept names one
  "delivery": { "method": "delivery", "when": "…" },    // orders
  "payment": [{ "amount": {…}, "due": "on_acceptance" | "before_start" | "<RFC 3339>" }],  // deposit = first part (UCP terms)
  "resolution": { "kind": "refund" | "exchange" | "credit" | "repair", "amount": {…}, "keepItem": false,
                  "deductions": [{ "kind": "return_postage" | "diminished_value" | "restocking" | "service_supplied", "amount": {…}, "reason": "…" }] },
  "creates": "booking" | "order", "notes": "…" }
```

**Rules for offers.** A new offer moves the open one to `countered` if it answers it, or to
`superseded` if its own author replaces it, in the same batch. **Automation never walks back its
own price**: an answer from the owner's AI or a rule may not be worse for the customer than the
business's last offer in the negotiation (§4), though a person may. `changes[]` lists the JSONPaths
that differ from the parent, and any changed money adds
`{type: "warning", code: "price_changed", severity: "requires_buyer_review"}` (UCP, ACP), so a
price never rides along silently. A discount is always a lower `unitPrice`, never a negative
charge, so the floor check sees every one. An offer is never edited: it is retracted (if
non-binding) or replaced. Every verb is an item transition, so the item's version compare-and-set
(backed by the event's unique `(item_id, seq)`) makes each accept single-use. A second accept gets
`409 offer_changed` with the current offer.

**Validity.** Automation's offers run at most `offerValidHours`; a customer's offer, first or
counter, lapses after `counterValidHours`, so nobody is bound by a stale proposal (Civil Code art.
228). A business that takes a lapsed customer offer sends the same terms as its own offer, which
the customer accepts: late, never refused. Past `valid_through`, the customer's view shows the offer
as expired before the sweep reaches it.

**Compatibility and erasure.** The item's payload keeps `proposed` (booking) and `quote` (quote
request) as the projection of the open business offer, so webhooks, rules and the owner app read
what they read today, and gains `offer {id, rev, by, round, valid_through}` (the payload schemas
must list it: `rowToItem` strips unknown keys). Erasure (`PII_PATHS`) also rewrites an offer's
`note`, `shown`, `terms.notes` and addresses; `terms_sha` stays, proving the terms without them.

## 2. Verbs, and who may use them

| Verb | Who | Effect |
|---|---|---|
| offer | business: `propose`, `quote`, `propose_change`, `offer_resolution`; customer: `make_offer` | a new open offer; the other side is told |
| counter | the side the open offer was made to | the open offer becomes `countered`; the new one gets `round + 1` |
| accept | the side the open offer was made to | the terms are applied; the promise is made or amended |
| decline | the side the open offer was made to | the item closes or returns to the business's move (§3); a declined change leaves the promise as it was |
| retract | the author | the business only when `binding` is 0; a customer retracts an open change with `decline_offer` on it, and before the promise ends their request with `cancel` |
| expire | `system` (the sweep) | like a decline; the customer is told in the business's voice |

**The customer's agent** (REST, public MCP) uses every customer verb plus withdrawal and returns.
**The customer by email** uses them through action links (§5); **free text never accepts, counters
or declines** — a reply is a thread entry the business or its AI answers with an offer, or, to a
plain "yes", with the one-tap link again. It moves an item only in two ways: on `needs_info` it
fires `provide_info`, which just hands the move back to the business (N14), and a withdrawal, since
any clear statement is one (CRD art. 11(1)), is recorded by the owner or the owner's AI
(`record_withdrawal`, naming the inbound entry, whose arrival dates it; from an address other than
the customer's, the answer is the withdrawal link instead, because the thread alone proves
nothing). **The owner** (signed in or with a full key; staff sessions are `owner` today, `auth.ts`)
has no limits; only the owner sends a draft, records a phoned acceptance (`record_acceptance`, with
a note), rejects a return, disputes returned goods, deducts from a refund or changes the
negotiation settings. **The owner's AI, integration keys and rules** act **only within the limits**
(§4), judged on the real `actor.kind`, not `actsAs`: `owner_ai` passes the machines as `owner`, so
the check sits in core's offer path. **System**: expiries, holds, refund-date alerts;
**connectors**: payments and money refunded.

## 3. States per item type

Existing names stay, so webhooks and receipts keep their meaning. Before the promise, each type has
a state for **the business's move** (a customer offer is open) and one for **the customer's move**
(a business offer is open):

| Type | Business's move | Customer's move | Promise |
|---|---|---|---|
| booking | `requested` | `proposed` | `confirmed` |
| order | `received` | `proposed` (new) | `accepted` … `fulfilling` |
| quote_request | `received` | `quoted` | the linked booking or order |

### 3.1 Booking

| Event | From → to | By | Guards; effects |
|---|---|---|---|
| `propose` | requested, needs_info, proposed → proposed | owners | **`slot_available`** (new, N7) for each option, `within_limits`, `round_left`; `open_offer`, `hold_slot` (below), notify the customer |
| `counter` | proposed → requested | customers | `offer_open`, `confirm_terms`; `open_offer`, `release_hold`, notify the owner |
| `accept` | proposed → confirmed | customers | `offer_open`, `confirm_terms`, `slot_available` for the chosen option; `apply_offer`, `claim_slot` (the hold becomes the claim), receipt `confirmed`, confirmation email |
| `confirm` | requested, **needs_info** → confirmed | owners | `slot_available`, `within_limits`; takes the customer's open offer. **No longer from `proposed`**: that booked the original time (N13). From `needs_info` fixes N14. |
| `record_acceptance` | proposed → confirmed | owner | a note is required; otherwise as `accept` |
| `retract` | proposed → requested | owners | `offer_non_binding`; `release_hold` |
| `expire` | requested, needs_info → expired | system | `booking.autoExpireHours` (now read) with no answer; notify the customer (new) |
| `expire` | proposed → expired | system | at `valid_through`; `release_hold`; notify the customer (new) |
| `propose_change` | confirmed → confirmed | owners, customers | no open change; `changes_left`; `within_limits`; business: `slot_available` + `hold_slot`; customer: `confirm_terms` |
| `accept_change` | confirmed → confirmed | the other side | `offer_open`, `slot_available`, customer `confirm_terms`; `apply_offer`, `reclaim_slot`, receipt `amended`, notify both |
| `decline_change`, `retract_change`, `expire_change` | confirmed → confirmed | other side / author / system | `release_hold`; the promise stands |
| `withdraw` | confirmed → cancelled_by_customer | customers; owners via `record_withdrawal` | `withdrawal_open` (§7); `release_slot`; linked `refund` (`withdrawal`, `approved`); acknowledgement; outcome `booking.cancelled_by_customer` (neutral) |

**Holds.** A business time offer holds its slot (`slot_claims` rows carrying the offer's id) only
when `booking.holdOnPropose` is on, it has one option, and the customer (party, agent key or
anonymous fingerprint) holds fewer than `booking.maxHolds` (2\*) slots across their items;
otherwise it goes out unheld, binding on price only, and says so ("…if the time is still free when
you say yes"). A customer's request or counter never holds anything, so no agent can park slots by
haggling. `readClaims` skips the item's own rows, so a hold is planned counting the item's agreed
claim as taken, or an overlapping move hits the `(resource_key, bucket_start, ordinal)` key
(`write/slots.ts`); `release_hold` deletes by `(item_id, offer_id)`, `release_slot` by item.

A customer's change inside `changes.customerCutoffMin` (default: the cancellation window) is
recorded, but only a person may accept it. That closes Calendly's reschedule-to-dodge-a-late-cancel
loophole without refusing anyone. `cancel_item` picks `withdraw` before `cancel_late` while a
withdrawal right runs. **Create prices a fixed-price service from the catalogue** as §3.2 does
lines (Q5, the fix that ships first): at the list price, or at the owner's reward for this customer
(§4). A customer's different `totalPrice` stays in their offer, and a `from` or `quote` service is
priced by the business. `record_payment` becomes a booking self-transition (connector, owner)
that records a deposit or payment: it gates nothing in this version (§13), but it is what makes a
booking a paid distance contract (§7).

### 3.2 Order

**Create is the customer's first offer**: lines with a `productId`/`sku` are priced from the
catalogue (the list price, or the owner's reward for this customer, §4), and a different price the
agent wrote stays in the customer's offer with a `price_differs` message (Q5). `propose` (owners;
received, needs_info, proposed → proposed) carries
a corrected price or quantity, a delivery date or a payment schedule; the customer may `counter`
(proposed → received), `accept` (proposed → accepted) or `cancel`. The owner's `accept` (received,
needs_info → accepted) takes the customer's offer; automation passes `within_limits` only when no
line differs from the catalogue. **A payment due on acceptance** adds the system's
`request_payment` (amount, due date, link) as a second event in the same batch (seq + 2; the write
path writes one event per call today). `record_payment`
sums payments until they cover it, and `paidAmount` joins `orderPayloadSchema` (stripped on read
today, N15). **During the promise** (`accepted` … `fulfilling`), the `*_change` events cover lines,
quantities and `delivery.when`: before payment a new total updates the payment request; after it a
change may keep or lower the total (a lower one adds a linked `refund`, `price_adjustment`,
approved), and raising it is a second order (§13). **`withdraw`** (customers, promise state →
`cancelled`) records the neutral `order.cancelled_by_customer`, plus a linked refund if anything was
paid. **After fulfilment the order never moves**: returns are linked `refund` items and
`order.fulfilled` stays kept. `fulfil` takes an optional `deliveredAt`; `record_delivery` (a
self-transition by connector or owner) sets it later and starts the goods' withdrawal clock.

**Q5 ships first, as a fix to today's code**, on its own and before `item_offers` exists, because
today an assistant can book a €100 appointment or order a €150 product at €1 and get an automatic
yes. A customer's create prices each catalogue line and fixed-price service from the catalogue, and
an order's total is its lines' prices times their quantities. A different figure the assistant
wrote is kept beside the price as `customerStatedPrice` (on a booking, an order and each order
line, listed in the payload schemas so `rowToItem` keeps it), for the owner to read; it is never
the item's price, and rules never see it, so no rule or preset confirms or accepts on it. The
presets compare the business's price. What the catalogue does not price (a line naming no product
the business has, a `from` or `quote` service) stays as written for a person to price, so no rule
or preset may accept or confirm an item holding a price the business did not set, or the same hole
stays open under another name. Nothing is refused, and an integration that sent its own prices
now gets the business's back. When offers land, `customerStatedPrice` becomes the customer's offer
as above. Rewards (§4) come with offers, not with the fix.

### 3.3 Quote request

`quote` (owners; received, needs_info, quoted → quoted) needs `valid_through` (default
`negotiation.offerValidHours`) and supersedes an open quote; with `creates: "booking"` it needs
`startTime`/`endTime` (or `options`), holds under §3.1's rule, and the silent fallback to an order
goes (N12). The customer may `counter` (quoted → received), `decline` (worded as their own choice,
N21) or `accept`. **Accept creates the linked item already in its promise state, in the same
batch**: a `confirmed` booking with its slot claimed, or an `accepted` order plus a payment request
when money is due now. The accepted offer becomes the linked item's rev-1 agreed offer (`parent_id`
set), with the identity columns and `item_presentations` (ADR-017 §3.1); the customer gets the
confirmation and the business confirms nothing twice. The owner's `accept` (received → accepted)
takes a priced counter within limits; `retract` (quoted → received) is for non-binding quotes;
`expire` fires at `valid_through` and tells the customer.

### 3.4 Refund, widened into returns

States: `requested → approved → goods_received → refunded`, plus `rejected`, and `cancelled` (new,
when the customer drops the request). `refunded` is the terminal state for every settlement:
`resolution` says which one it was, and the customer-facing words come from `resolution`, never
from the state name ("your return", "your refund", "your replacement").

| `payload.kind` | Opened by | Starts at | Rejected by |
|---|---|---|---|
| `withdrawal` | `withdraw`, `withdraw_from_contract`, `record_withdrawal`, or goods sent back with no request (PT art. 11(2)) | `approved`; the acknowledgement is emailed at once (PT ≤ 24 h) | **nobody**; `withdrawal_open` is checked at intake, and a claim outside the window becomes `policy` |
| `faulty` | `request_return` with `reason: faulty` (legal guarantee, DL 84/2021, 3 years) | `requested` | the owner, with a reason; reportable (§8) |
| `policy` | `request_return` under the business's own policy | `requested` | the owner |
| `price_adjustment` | an accepted change that lowered a paid total | `approved` | nobody |

`approve` sets the instructions (method, address or label, `returnBy`); `offer_resolution` proposes
something other than what was asked (a partial refund keeping the item, an exchange, credit), which
the customer accepts or declines — a decline leaves the return open with the business; `goods_back`
(owner, connector) records the goods or proof of sending. **`dispute_goods`** (the owner, with a
note and photos, before the refund is promised) records goods that came back not as sold — an empty
parcel, another item; the refund waits, the customer is told why in the business's voice, and their
recourse is §8's report. `refund` settles it with `resolution`, `amount` (≤ what was paid for those
lines), `paymentRef` and itemised `deductions[]` shown to the customer — a withdrawal allows only
`return_postage` (if disclosed), `diminished_value` and, for a service begun at the customer's
express request, `service_supplied` (pro rata, art. 14(3)); restocking only on a `policy` return.
**Deductions are a person's**: automation settles in full or not at all. An **exchange** creates the
replacement as a linked order already `accepted`, at the price difference (a payment request when
positive, the refund's amount when negative), in the same batch. `withdrawal` has no `reject` entry
at all. The refund item copies its order's party, access token, identity columns and
presentations, as a quote's linked item does (`planLinkedItem`), so its receipts name the same
person. `refundPayloadSchema` gains `kind`, `lines[{index, quantity}]` and `wants`, `reason`
becomes optional, and `orderItemId` must be a paid order of the same party.

## 4. Limits the owner sets, enforced in code

`checkLimits(action, item, catalogue, history, settings) → breaches[]` is a pure function in
`packages/core/src/negotiation/limits.ts`. It runs in the write path whenever `caller.actor.kind`
is `owner_ai`, `integration` or `rule` — never `permissionKind`, which says `owner` for the first
two (`write/caller.ts`); the owner only sees warnings. `catalogue` is priced for this customer:
each line's list price and **P**, its price for them, which is the list price or the owner's reward
(Q3, below).

Outside the limits an **offer** becomes a `draft`: the self-transition `draft_offer` (no state
change, no customer notice, `needsHuman`), replacing the item's previous draft, for the owner to
send, edit or drop in one click. An **accept** is refused with `422 outside_limits` (owner doors
only) and flagged. An automated **reply** that names an amount of money not in the item's current
terms or the catalogue is held the same way, since an online message with every element of a
contract is a binding proposal (DL 7/2004 art. 32(1)). The customer sees nothing until a person
answers.

| Breach | Setting (`negotiation.ai.*` unless named) | Out of the box (Q2: time yes, money no) |
|---|---|---|
| `below_floor` | per product or service `floor_minor`; effective floor per line = max(`floor_minor`, P × (1 − `maxDiscountPct`/100)); the total may not fall under Σ floors plus the default charges | P: no discount |
| `above_list` | a catalogue line priced above P (a surcharge, or holding back a reward, is a person's) | always |
| `counter_priced` | answering a customer's price counter with a price of its own: automation accepts a counter at or above the floor, or leaves it to a person | always |
| `custom_line` | `mayPriceCustom` (a line with no catalogue price) | false |
| `time_moved` | `maxTimeShiftMin` from the customer's asked time; always within availability and opening hours | 10080 (7 days) |
| `delivery_later` | `maxDelayDays` past the asked `delivery.when` | 0 |
| `deposit_changed` | `mayWaiveDeposit`; automation never asks for a deposit the defaults don't | false |
| `worse_than_before` | worse for the customer than the business's last offer in this negotiation, or valid beyond `offerValidHours` | always |
| `rounds_exhausted` | `negotiation.maxRounds` | 3 |
| `change_not_allowed` | `mayAcceptChanges` (within availability, before the cutoff); `mayProposeChanges` | true; false |
| `refund_over_max` | `maxRefundMinor`, for `approve` and `offer_resolution`; any deduction | 0 |
| `return_outside_policy` | `mayAuthorizeReturnsInPolicy` (inside `returns.days`, not excepted) | true |
| `money_recorded` | recording a payment or a refund (`record_payment`, `refund`): a connector's or the owner's | always |
| `over_approval_value` | `orders.maxValueWithoutApprovalMinor` (exists; finally read) | 0 = none |
| `legal_identity_missing` | `commerce.legal` is incomplete while an offer prices something for a consumer | always |

**After the last round**, a customer's further counter is recorded as a message to a person and the
reply is `202 {waiting_on: "business"}`. It is never refused, and the business's last offer stays
acceptable until its `valid_through`.

**Price counters are off out of the box (Q1).** While `negotiation.priceCounters` is off,
`GET /v1/business` says `price_negotiable: false`, so assistants don't try, and "Suggest a change"
shows no price field. A counter that changes a price anyway, or one on a product or service with
`negotiable` 0, is recorded as a message to a person and answered `202 {waiting_on: "business"}`,
never refused, and the business's current offer stays acceptable. Time, quantity and delivery can
always be countered. The owner's rewards are prices, not haggling, so they apply either way.

**Probing and spam.** A floor revealed one step at a time is a floor given away, so automation never
counters a price (eBay's hidden auto-accept threshold, with the lower side going to a person here).
Rounds reset with every new item, so a customer (party, agent key or anonymous fingerprint) also has
at most `negotiation.perCustomer.open` (3\*) open negotiations and `priceCounters` (3\* per
catalogue line per 30 days, eBay's three offers per buyer per item); beyond that, counters are
messages to a person, recorded and answered `202`, never refused. Counters get a `negotiate`
rate-limit class (10\* an hour per address, `adapters/src/limits.ts`), the owner gets at most one
email per item an hour for them, and a new draft replaces the item's last. An accepted counter binds
the customer too (§5), so each probe costs a contract; withdrawing from it is lawful and neutral,
and the caps are what bound that loop.

**Around the limits, and away from the AI.** `negotiation`, `returns`, `commerce.legal`, the
catalogue's `floor_minor`, `negotiable` and `withdrawal`, and **any lowered list price** are the
owner's in person: the AI's `upsert_product`/`upsert_service` may raise a price but not lower one,
or the floor (a share of list) falls with it; feeds and integration keys, the business's systems of
record, still set prices. `get_settings` and the owner catalogue show `negotiation.ai.*`,
`negotiation.rewards` and `floor_minor` to the owner in person only; the AI and integration keys
learn a breach as a code when they try, so no customer message can talk the AI into reciting a
number it never had (prompt injection). No limit, no reward's condition, and not the rounds left,
appears on a public door, in the manifest, in `get_item_status`, in an error or in a `human`
sentence.

**Positive first (R25), extended to terms.** A rule that reads standing (`REPUTATION_FNS`,
`person.*`, `customer.*`, `agent.*`) may only make offers that pass `noWorseThanDefault(terms,
defaults)`: the customer's price P, the default deposit and return policy, **and the customer's own
asked time, quantity and delivery** — else "not trusted, so propose a later time" would pass.
`NEGATIVE_EVENTS` gains `retract`, `decline_change`, `retract_change`, `expire_change`,
`offer_resolution` and `dispute_goods`. Standing buys speed and a waived deposit, and it lowers a
price only through the owner's rewards (Q3, below). A price automation sets or accepts that differs
from the list price, a reward included, is personalised by automated decision-making and carries
the notice (§5; CRD art. 6(1)(ea); `law.md` §3.3). A rule that reads the customer's nationality,
residence or address country may not set a price or terms (refused when saved): an individually
negotiated agreement is outside the Geo-blocking Regulation, but a rule is a general condition
(Reg. 2018/302 arts. 2(14), 4(1)).

**Rewarding good customers (Q3).** A good record may earn a better price, set by the owner's own
rules and never by haggling. Rewards live in `negotiation.rewards` (§10), so only the owner in
person saves, changes or sees one; the owner's AI may suggest one in words, never save it:

```jsonc
"rewards": {   // keyed by id; empty until the owner writes one
  "regulars": { "if": { "path": "customer.completed", "op": "gte", "value": 3 }, "pct": 5,
                "only": null, "says": "Thank you for coming back." },
  "trusted":  { "if": { "fn": "person_trusted" }, "pct": 3 } }
```

- **Who qualifies** is written in the rules' own conditions, limited to a record the customer
  earned: the business's own history (`customer_known`, `customer.*`; ADR-017 R27) and the person's
  standing as their agent presented it (`person_trusted`, `person_tier_on`, `person.*`; R22).
  Anything else, `not` included, is refused when saved, so a reward never reads who or where
  someone is.
- **The price.** For each catalogue line it covers (`only`: product and service ids, null for all),
  P = min(list, max(list × (1 − `pct`/100), `floor_minor`)), rounded to the minor unit in the
  customer's favour: never below the owner's floor, never above the list price. `pct` is 1 to 50.
  Charges are untouched and a deposit follows the new total. When several rewards match, the best
  one applies; they never add up.
- **The inbox applies it, not the AI.** One pure function (`negotiation/rewards.ts`) works P out
  wherever the inbox prices a catalogue line for this customer, at create (Q5) and in every business
  offer, before the confirm step, so the summary the customer confirms already holds it. That is how
  Q3 sits with Q2's "money no": the AI never chooses, sees or changes a reward, cannot go below P
  (`maxDiscountPct`, 0 out of the box, counts from P), and a customer's price counter is judged
  against P like any other. An assistant that wrote the list price for a rewarded line has not
  countered: its customer pays P, and sees it in the confirm step before anything binds. A customer
  with no record, or whose agent shows none, pays the list price like everyone else: a reward only
  ever lifts.
- **An agreed price stays.** The terms and their `terms_sha` hold P; a record that changes later
  never re-prices a promise.
- **Every rewarded price carries the notice** (§5): the owner wrote the rule, but the inbox chose
  the price for this customer, and that is automated decision-making. On GDPR art. 22, the decision
  only ever lowers a price, everyone else gets the list price, a person is one reply away ("Ask for
  a person any time"), and the business's privacy notice says in plain words that returning
  customers may pay less (art. 13(2)(f)); ADR-012's DPIA and the lawyer check cover it. A reward is
  a personal reduction, not an announced one, so it shows the genuine current list price beside it
  and never "sale" or "was" (PID art. 6a).

## 5. What the customer sees: always the business

**The voice** is "we", in the business's name, time zone and language — never offer, rev, round,
"the business", network, inbox, key, draft, rule, limit or a ULID (a 6-character reference;
today's code still prints the ULID). `human` sentences follow it too, because agents relay them
verbatim, and the MCP text result ends with the offer's summary, deadline and three choices, since
many assistants read only the text (ADR-017 §8.4). The public MCP `serverInfo` and every page title
are the business's name, falling back to its domain, never `inbox@localhost` (N20).

**Every offer email** (one `notify.ts` template per verb) carries the terms (old and new side by
side for a change), the total incl. VAT with charges apart, the time in the business's zone, any
deposit and its payment link, the business's note, the real deadline with no invented urgency
(UCPD Annex I point 7), the disclosures, and **Accept**, **Suggest a change**, **No thanks**.

For example: "Your quote from Rosa's Bakery: the wedding cake, €310 incl. VAT. This price holds
until Friday 17 October, 18:00." / "Can we move your appointment from Tue 10:00 to Wed 10:00? If
that doesn't suit you, your booking stays as it is."

**Disclosures, in the business's voice:** under AI Act art. 50(1) (applies since 2 August 2026, not
postponed by Reg. 2026/1744), the first message of a conversation from `authored: automated` says
"You're writing with Rosa's Bakery's automated assistant. Ask for a person any time." (PT: "Está a
falar com o assistente automático de …"); no right of withdrawal for excepted items
(art. 6(1)(k)); the return policy.

**The personalised-price notice** (CRD art. 6(1)(ea); PT DL 24/2014 art. 4(1)(l)) goes next to
every price that the inbox, the AI or a rule chose for this customer, a reward (§4) or an accepted
counter, each time it is offered and in the confirm step's summary, not only in a privacy policy:
"Your price: €47.50 (our price €50.00). We personalised this price for you by automated
decision-making." (PT: "O seu preço: 47,50 € (o nosso preço: 50,00 €). Este preço foi
personalizado com base numa decisão automatizada."), then the reward's `says` line when the owner
wrote one (checked when saved against the words this section keeps out). It never names a network,
tier, score, record or key: the customer hears only the business. A price a person typed for one
customer is not automated and carries no notice. In `shown` it is also the disclosure
`personalised_price`, so an agent relays it with the price.

**Action links** use the unused `action_links` table (plus `offer_id`): a token `<jti>.<HMAC>` keyed
by HKDF(`INBOX_SECRET_KEY`, `action-link`), expiring at `valid_through`, single use (`used_at` in
the transition's batch). **A GET never acts** (mail scanners prefetch): the page, on the business's
own domain when it has one and with no product name on it, shows the summary and a POST button,
**"Order with obligation to pay"** (PT «Encomenda com obrigação de pagar») whenever the terms carry
a price, even one paid later or on the day (C-400/22), and **"Confirm booking"** only when nothing
is owed. "Suggest a change" offers a time picker from availability, plus a price field when
`negotiation.priceCounters` is on (Q1). Confirmations of a withdrawable contract link **"Withdraw
from contract here"** (PT «Retrate-se do contrato aqui») → **"Confirm withdrawal"** (CRD art. 11a).

**Threading** (N10). Each customer email gets a `Message-ID`, recorded on its `out` thread entry,
plus `In-Reply-To`/`References`. `Reply-To` is `<local>+<item id>@<domain>` when
`email.plusReplies` is on, and the business address otherwise. There is no subject token. The Node
REST sender must pass headers through (`platform/src/mail.ts`). An inbound reply enqueues `rules`
with `thread.inbound` (N18), so the AI or a rule can answer a counter written as text.

**The confirm step** (CRD art. 8(2); PT DL 7/2004 art. 29(5)). A customer call that can conclude or
amend a contract (`accept`, or a `make_offer` the business could take outright) carries `confirm:
{terms_sha, obligation_to_pay}`. Without it nothing is written: REST answers `409 confirm_terms
{summary, terms_sha}`, MCP an MRTR `input_required` elicitation form (or the same as structured
content). The summary holds the main characteristics, the total with taxes and charges, duration,
deposit, and the withdrawal right or its exception, plus, for a service starting inside the
withdrawal period, the express request and acknowledgement (arts. 8(8), 16(a)). The confirmation
email (art. 8(7)) follows at once with the art. 6(1) information, the model form and the withdrawal
link.

## 6. Doors and protocol mappings

Public REST (MCP tool in brackets); every call takes `access_token` or a pass, and an
`idempotency_key` (ADR-015):

| Call | Does |
|---|---|
| `GET /v1/items/:id` (`get_item_status`) | adds `offer` (open, customer-visible fields), `agreed`, `thread` (customer-visible, N11), `waiting_on`, `next[]`, `withdrawal {available, until}` |
| `POST /v1/items/:id/offers/:offer/accept` (`accept_offer`) | `{confirm, option?}` → the type's accept event; `410 offer_expired`; `409 offer_changed` with the current offer |
| `POST /v1/items/:id/offers/:offer/decline` (`decline_offer`) | `{reason_code?, note?}` → `cancel` (booking or order before the promise), `decline` (quote), `decline_change`, the resolution decline, or `retract_change` on the customer's own change |
| `POST /v1/items/:id/offers` (`make_offer`) | `{parent_id, terms (changed fields only), note?, reason_code?, source? {url, observed_at}, confirm?}` → `counter` or `propose_change`; `source` = ACP `suggested_price` provenance |
| `POST /v1/items/:id/withdraw` (`withdraw_from_contract`, titled "Withdraw from contract here") | two steps: a prefilled statement (name, contract, email), then confirm, then the acknowledgement |
| `POST /v1/items/:id/returns` (`request_return`) | `{lines[{index, quantity}], reason: changed_mind\|faulty\|wrong_item\|not_as_described\|other, wants: refund\|exchange\|credit, note?}` → a `refund` item, kind classified by the inbox |
| `GET /v1/business` | adds `return_policy` (`MerchantReturnPolicy`), `price_negotiable` (Q1), and `refund` in `item_types` |

**Owner doors.** The owner MCP gains `make_offer`, `list_offers`, `send_offer_draft` and
`open_return` (a return asked for by phone or email; the AI may open one, limits apply at approval).
`send_offer_draft` is limited to the owner in person, by the same test as `security`
(`isOwnerInPerson`, not on the `mcp_owner` channel, `service.ts:592`), so the AI cannot approve its
own drafts. The agent guides (`PUBLIC_INSTRUCTIONS`, `for-agents.md`) gain one line: *relay
`offer.human` as the business said it; accept only on your person's clear yes to the summary.*

| Inbox | A2A 1.0 | UCP 2026-08-25 | ACP 2026-04-17 | AP2 v0.2 | schema.org |
|---|---|---|---|---|---|
| Business offer open | `INPUT_REQUIRED` + offer DataPart | `ready_for_complete`; `expires_at` = `valid_through`; `ap2.merchant_authorization` | `quote_id`, `quote_expires_at` | `checkout_hash` = `terms_sha` | `Offer.validThrough` |
| Customer accepts | `{action: accept}` → `COMPLETED` | `complete_checkout` | complete | new closed mandate | `AcceptAction` |
| Customer counters | `{action: counter}` | **not expressible** (quantities, options, codes and payment term only) | `suggested_price` (unreleased) | new mandate within the constraints, or back to the human | `Demand` |
| Customer declines | `CancelTask` → `CANCELED` | `cancel_checkout` | cancel + `intent_trace` | — | `RejectAction` |
| Waiting on the business (incl. drafts) | `WORKING` | `complete_in_progress` / `incomplete` + info | `pending_approval` | — | `ActiveActionStatus` |
| Expired | `CANCELED` | `canceled` | `expired` | `exp` | `validThrough` passed |
| Change after the promise | new task, `referenceTaskIds` | order update + `fulfillment_changed` | `order_update` | new mandate | — |
| Return, refund, credit, exchange | new task | order `adjustments[]` (`pending` → `completed`) | `adjustments[]`, `amount_refunded` | — | `ReturnAction`, `OrderReturned` |
| Return policy | card skill | `policies[]` return + `disclosure` | `links[]` | — | `hasMerchantReturnPolicy` |

**Correction to ADR-010:** `requires_escalation` + `continue_url` is the *buyer* acting on the
business's page; a business waiting on a person is `complete_in_progress` / `pending_approval`. The
human's limits (AP2 constraints, ACP `allowance`) stay with the agent and are never asked for; each
change gives a new `terms_sha`, so an AP2 agent needs a fresh mandate or its human.

## 7. Returns: the legal floor and the defaults

The owner's policy may be more generous than the law, never less. These floors are for consumers; an
unknown customer is one, unless a positive signal such as a VAT number says otherwise.

- **The window: 14 days, no reason needed** (CRD art. 9; PT DL 24/2014 art. 10). Goods: from
  delivery of the last item, and before delivery too (recital 40); services: from conclusion.
  Counted by Reg. 1182/71 (day one excluded; a weekend or holiday end runs to the next working day);
  12 months longer if the customer was not told (art. 10). With no `deliveredAt`, from `fulfil` plus
  `returns.assumedTransitDays` (7\*), erring toward the customer.
- **The refund: within 14 days of the notice** (art. 13), standard outbound delivery included, to
  the same means of payment unless the customer expressly chooses otherwise; it may wait for the
  goods or proof of sending unless the business offered to collect. In Portugal a late refund is
  owed **twice over** (PT art. 12(6)); the sweep alerts the owner from day 10.
- **Charges:** return postage only if disclosed (art. 14(1)); diminished value (art. 14(2)); no
  restocking fees; PT voids any penalty (arts. 11(7), 29(2)).
- **Exceptions come from the product, never from the owner's wish** (art. 16; PT art. 17). The
  flags are `personalised`, `perishable`, `sealed_hygiene`, `sealed_media`, `mixed`,
  `dated_leisure`, `urgent_repair`, `digital_started` and `price_fluctuates`. They live in
  `products`/`services.withdrawal` (default `standard`), are set by the owner in person (§4), and
  are shown before the order. Read them narrowly: preset options are not personalisation, and
  long-life dry goods are not perishable.
- **Bookings.** An unpaid booking made at a distance is a reservation, not a distance contract
  (recital 20). A booking has the right only when it was paid at a distance and is not
  `dated_leisure` or `urgent_repair`. If such a service starts inside the window, the confirm step
  collects the express request and acknowledgement (arts. 14(3), 16(a)). Without them, a customer
  who withdraws owes nothing (C-97/22).
- **Faulty goods** fall under the legal guarantee, not withdrawal. There is no 14-day limit, no
  return cost for the customer, and neither the AI nor a rule may decline. The UK has the same
  shape (CCR 2013 regs. 28, 30 and 34).

```jsonc
"returns": { "days": 14, "from": "delivery", "postage": "customer" | "business", "refundOn": "goods_or_proof" | "notice",
             "collect": false, "restockingPct": 0, "offerCredit": false, "refundDays": 14, "respondHours": 48,
             "assumedTransitDays": 7 }   // days ≥ 14, refundDays ≤ 14; restockingPct on `policy` returns only
```

## 8. Reputation (ADR-017): rules version 5 (Q4)

| Case | Business | Customer | Code |
|---|---|---|---|
| Offer, counter, decline, retract or expiry before a promise | — | — | none |
| Accepted offer makes the promise | promise receipt as today, plus `trm` = `terms_sha` | | `confirmed`, `accepted` |
| Change accepted by both | — | — | receipt `knd: "amended"`: `ref` = earliest promise nonce, new `due`/`end`, `trm`, `acc` (`customer`/`business`); R30's clock moves |
| Change declined or expired | — | — | none; the original stands |
| Business's change refused, then the business cancels | broken | — | `booking.cancelled_by_business`, `order.not_fulfilled` (today) |
| Withdrawal in time, before fulfilment | — | — | `booking.cancelled_by_customer`, `order.cancelled_by_customer` (already neutral); **never `cancel_late`** |
| Return after fulfilment | `order.fulfilled` stays kept | — | — |
| Refund promised and paid by its `due` | **kept**, 1.0 | — | `refund.honoured` (new), on the `refund` item |
| Paid after its `due` | broken, 1.0\* | — | `refund.late` (new) |
| Promised, never paid | broken | — | `promise.unclosed` (R30), as today |
| The customer drops the return after the promise | — | — | `refund.cancelled_by_customer` (new, neutral) |
| Lawful withdrawal or faulty claim refused, or goods disputed and nothing paid | broken, by verified report on the **order's** receipt, disputable | — | report `order.refund_refused` (new) |
| Charge-back while a return is open, or after a late refund | — | none | not `order.charged_back` |

**Returns carry receipts of their own** because ADR-017 lets one outcome stand per item and side:
a `refund.late` on the order would erase its `order.fulfilled`. The refund's promise
(`typ: "refund"`, `knd: "accepted"`) is issued when its `due` is fixed — at `approve` when nothing
has to come back, at `goods_back` otherwise, and at settlement if the business pays sooner — with
`due` = the later of notice + 14 days and evidence + 3 days\* (withdrawal), else approval +
`returns.refundDays`. A refused claim or disputed goods have no refund promise, so the customer's
agent reports against the order's receipt, from the refusal to 90 days after it.

**What the network must learn.** Receipt claims are frozen once they ship
(`packages/spec/src/network/receipts.ts`): `typ` is booking or order and `knd` a closed enum, so a
network on rules version 4 refuses an `amended` or a refund receipt (`422 bad_payload`). **Rules
version 5** (Q4) adds `typ: "refund"`, `knd: "amended"`, the optional claims `trm` and `acc`, the
three `refund.*` outcomes and the report `order.refund_refused`: new values and claims, never a
renamed one. Like any rules change it is announced 15 days ahead (ADR-017 §11), as an amendment to
ADR-017 (§12). The inbox sends these receipts only to a network whose `rules_version`, or announced
next version, is 5 or later (the gate from 0008).

Without a verified acknowledgement the network honours at most 3\* amendments per item, moving
`due` by at most 90 days\* in all, so a business cannot postpone R30 on its own word. A customer
neither earns nor loses standing by returning. Against wardrobing and serial returns the business
has what the law gives it: the refund waits for the goods or proof of sending, a person deducts
diminished value item by item, the product exceptions, disclosed return postage, and its own say on
returns beyond the law — never the customer's record (R25). `outcomeOf` takes an optional `{due,
now, returnOpen}` and stays pure, tested over every path.

## 9. Events and webhooks

Types stay `<item type>.<event>` (ADR-015). New: `{booking,order,quote_request}.counter`,
`.retract`, `.draft_offer`, `.withdraw`; `{booking,order}.propose_change`, `.accept_change`,
`.decline_change`, `.retract_change`, `.expire_change`; `order.propose`, `order.record_delivery`,
`booking.record_acceptance`; `refund.create`, `.offer_resolution`, `.accept`, `.goods_back`,
`.dispute_goods`, `.cancel`; and `quote_request.expire` now fires. `data.offer` is `{id, rev, round,
by, kind, status, valid_through, terms_sha}` (the full style adds `terms`, `shown`). Drafts reach
the owner's systems only.

## 10. Settings (merged, strict on write)

`updateSettings` merges the patch into the stored document and validates it strictly (ADR-017
§8.1). Arrays are replaced whole, so per-product values are maps keyed by id or live in the
catalogue row. `negotiation`, `returns` and `commerce.legal` bound what the AI may do, and
`negotiation.rewards` sets prices (Q3), so, like `security`, only the owner in person may change
them (the check at `service.ts:592` widens). The owner's AI and integration keys cannot.

```jsonc
"negotiation": { "priceCounters": false,            // Q1; counters on time, quantity and delivery are always allowed
                 "offerValidHours": 48, "counterValidHours": 72, "maxRounds": 3, "binding": true,
                 "perCustomer": { "open": 3, "priceCounters": 3, "days": 30 },
                 "changes": { "maxPerItem": 3, "customerCutoffMin": null },   // null = booking.cancellationWindowMin
                 "rewards": {},                     // Q3; keyed by id, shape in §4
                 "ai": { "maxDiscountPct": 0, "mayPriceCustom": false, "maxTimeShiftMin": 10080, "maxDelayDays": 0,
                         "mayWaiveDeposit": false, "mayAcceptChanges": true, "mayProposeChanges": false,
                         "maxRefundMinor": 0, "mayAuthorizeReturnsInPolicy": true } },   // Q2: time yes, money no
"booking":  { …existing, "maxHolds": 2 },
"returns":  { …§7 },
"commerce": { "customers": "both", "legal": { "legalName": "", "address": "", "phone": "", "email": "", "vatId": "", "complaintsUrl": "" } },
"email":    { …existing, "plusReplies": false }
```

`products` and `services` gain `floor_minor` (null), `negotiable` (1) and `withdrawal`
(`standard`). Feeds and connectors never overwrite `floor_minor` or `withdrawal`.

## 11. Migrations and the two runtimes

The Q5 fix needs no migration: `customerStatedPrice` lives in the payload.
`0011_negotiation.sql` follows 0008–0010 (`migrations.generated.ts` regenerated for the Worker):
`item_offers` (`UNIQUE(item_id, rev)`, `INDEX(status, valid_through)`, `INDEX(item_id)`);
`slot_claims.offer_id TEXT NOT NULL DEFAULT ''`; `action_links.offer_id`; the catalogue columns;
`receipts.offer_id TEXT NOT NULL DEFAULT ''`, its unique index swapped to
`(item_id, kind, outcome, offer_id)` as 0008 swapped it, and the receipt job's dedupe key widened to
`receipt:<item>:amended:<offer>` — today's `receipt:<item>:<kind>` would swallow a second
amendment. New states are strings. Open `payload.quote` and `payload.proposed` become rev-1
business offers (keeping `validThrough`, else now + `offerValidHours`; nothing re-sent); SQL has no
SHA-256, so the sweep does it a slice at a time, as it fills `receipts.sha`, and an item it has not
reached gets its offer in the batch of its next transition.

**Each verb is one `db.batch()`** (no interactive transactions): the offer insert and settlement,
the item compare-and-set and event (two for a payment due on acceptance), slot claims and releases,
the link's `used_at`, the receipt, notify, rules and webhook jobs, and an accepted quote's or
exchange's linked item. **The existing `lifecycle_sweep`** (Workers cron and Node loop, 50 a run)
runs offer and change expiry, hold release, `autoExpireHours`, refund-date alerts, withdrawal
acknowledgements and the `terms_sha` backfill; guards enforce every deadline at write time. JCS,
SHA-256 and HMAC are WebCrypto in `packages/core`: one implementation.

## 12. Where this touches today's code (`572c2bb`)

- **First, on its own: the Q5 fix** (§3.2). `write/create.ts` prices a customer's catalogue lines
  and fixed-price services from the catalogue; `customerStatedPrice` joins the booking and order
  payload schemas; the rules engine reads the item without it, so `rules/presets.ts:57,113,181`
  compare the business's price, not the agent's; and no rule or preset accepts or confirms a price
  the business did not set.
- `machine/outcomes.ts`: `PROMISE_STATES` (typed booking and order only) gains `refund:
  ["approved", "goods_received"]`; `codeOf` gains the `refund.*` codes; `withdraw` → the existing
  neutral cancel codes; change events → null. `packages/spec/src/network/receipts.ts` (`typ`,
  `knd`, `OUTCOMES`, `trm`, `acc`) and its vectors gain rules version 5's values and claims (§8),
  added and never renamed, since claims are frozen once they ship.
- `receipts/capabilities.ts`: `due`/`end` from the latest accepted terms; `ref` stays the earliest.
- `jobs/lifecycle.ts`: the new clocks. `rules/reputation.ts`: `NEGATIVE_EVENTS`,
  `noWorseThanDefault`, the country check, and the conditions a reward may read (Q3).
  `capabilities/service.ts` `cancelItem`: `withdraw` before `cancel_late`, and the same one-door
  pattern for `decline_offer`. `adapters/src/limits.ts`: the `negotiate` class.
- `jobs/notify.ts`, `identity/pending.ts` (Q6): the key line is already the business's ("If you use
  an assistant, it can show this code next time so we recognise you:"), switchable
  (`customers.emailKey`), but today it rides on the first email to the customer, or goes alone
  after a day (`KEY_ALONE_AFTER_MS`). It now always goes alone: one short email a day after the
  first contact, in the business's name, and never on an offer, confirmation, withdrawal or any
  other email. The code itself still names the network's host (`sdkey1_<host>_…`), so the emails
  about the order stay purely the business's.
- ADR-017, as an amendment in force as rules version 5 (Q4): §3's table and "never counts" line;
  §3.3 R30 reads the latest amendment; §3.4 the `order.refund_refused` report and its window; §14;
  and `booking.lateCancellation` applies only where no withdrawal right runs.

## 13. Not in the first version

UCP, ACP and A2A doors (ADR-010's order; only the mapping is fixed — MCP MRTR does ship, as it
carries the confirm step). Booking payment states: a deposit is shown, linked and recorded, not
gating (ADR-017 §13). Moving money (the inbox records refunds), return labels and carriers,
condition grading beyond itemised deductions, a store-credit ledger, partial fulfilment, a change
that raises a paid order's total (a second order does it), and a person's own yes above an amount
before an agent's acceptance binds. Offers to several customers, AI-chosen substitutes (AP2
`acceptable_items`), "was" prices (no 30-day history, PID art. 6a), and ever auto-accepting on
silence. Rewards on lines the catalogue does not price (quotes, custom lines), and rewards that add
up. B2B-only terms; legal strings beyond EN and PT.

## Sources

Our research notes of 23 September 2026, not published (code read-only: `0f1957f`, and the inbox
side of reputation before it was committed as `572c2bb`): `code-map.md` (N1–N21, file:line); `protocols.md` (official
UCP `v2026-08-25`, ACP `2026-04-17`, AP2 v0.2, A2A 1.0.0, MCP 2026-07-28; the ACP "2026-07-28" claim
and AP2/FIDO dates unverified); `patterns.md` (platform help pages, some via search summaries only,
as marked); `law.md` (EU texts from the Publications Office, PT texts from PGDL); `attack.md` (the
review); `questions.md` (the six questions, answered in Decisions). Official texts: Directive
2011/83/EU arts. 6, 8, 9–16, recitals 20, 40; Directive 2023/2673 art. 11a; Directive 2019/2161;
Directive 98/6/EC art. 6a; Directive 2005/29/EC Annex I pt 7; Regulation 2016/679 arts. 13, 22;
Regulation 2024/1689 art. 50; Regulation 1182/71; Regulation 2018/302 arts. 2(14), 4(1)
(Publications Office, CELEX 32018R0302, read 23 September 2026); CJEU C-249/21, C-400/22, C-97/22;
PT DL 24/2014 arts. 4, 10–12, 17, 29, DL 7/2004 arts. 29, 32, 33, Civil Code arts. 228, 230, 233,
406; UK SI 2013/3134 regs. 28, 30, 34. **Unverified:** the PT transposition of art. 11a; whether an
agent's order meets art. 8(2); whether a reputation mark is a "penalty" under PT art. 29(2);
whether EU equal-treatment law reaches an AI's individually negotiated price (the `above_list`
limit keeps automation from surcharging anyone either way); whether GDPR art. 22 reaches a reward
that only ever lowers a price; and whether PT DL 70/2007, which allows price reductions only as
sales, promotions or clearances, reaches a reward that is never announced.
