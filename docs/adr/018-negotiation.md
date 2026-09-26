# ADR-018 — Negotiation: offers, changes and returns

**Status:** accepted, 23 September 2026. Drafted, then revised the same day after an independent
review; the founder decided the six open questions the same day (**Q1**–**Q6**, in Decisions below and
marked where they bite), and the body follows his answers. **Q5 shipped first, on its own, as a fix
to the code of that day** (§3.2). The customer's answers to a proposed time and a quote, by their
assistant and by links in the business's email (§5, §6), shipped next, in a first build that
[Amendment 1](#amendment-1-23-sep-2026-the-first-build-of-the-customers-answers) records; offers
themselves, with their deadlines, followed ([Amendment 2](#amendment-2-24-sep-2026-offers-and-their-deadlines)),
then changes to a promise ([Amendment 3](#amendment-3-24-sep-2026-changes-to-what-was-agreed)),
then returns, withdrawal and the confirm step before a priced request
([Amendment 4](#amendment-4-25-sep-2026-returns-withdrawal-and-the-confirm-step)), then the owner's
limits in code, a customer's own price and rewards
([Amendment 5](#amendment-5-26-sep-2026-the-owners-limits-price-counters-and-rewards)), then the
receipts of network rules version 6 (§8,
[Amendment 6](#amendment-6-26-sep-2026-the-receipts-of-rules-version-6)), which ADR-017's Amendment 3
proposes (rules version 5 went to ADR-017's Amendment 2, accepted on 26 September 2026); the rest is
not built yet. A number marked \* is a *default*
The founder may change without a new ADR. The legal points are research, not advice, and need
a lawyer before they become Terms or public copy.

The founder, 23 September 2026: *"negotiation, quotes, negotiating time, prices, returns... we need to
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
7. **Haggling never counts (Q4, rules version 6).** An agreed change amends the promise; a refund
   paid on time is kept, a late one broken, and a lawful return refused is broken by verified
   report.
8. **A good record may earn a better price (Q3)**, only through the owner's own reward rules:
   applied by the inbox, never chosen by the AI, never below the owner's floor, never above the list
   price, and always with the personalised-price notice in the business's voice.

## Decisions

The founder, 23 September 2026, answering the six questions put to him:

| # | Question | Decision | In the founder's words |
|---|---|---|---|
| Q1 | Can customers haggle on price? | Off by default; the owner can switch it on (`negotiation.priceCounters`). Time, quantity and delivery can always be countered. While it is off, a price counter goes to a person as a message and is never refused (§4). | "Off by default, owner can switch on" |
| Q2 | What may the owner's AI and rules agree to on their own, out of the box? | Time yes, money no: any free time within 7 days, a reschedule before the cutoff, returns inside the policy, recording withdrawals; never a discount, a custom line's price or a refund payment. The owner can change each one (§4, §10). | "Time yes, money no" |
| Q3 | May a customer's good record get them a better price? | Yes: rewards the owner sets as rules, within the owner's limits, never worse than the list price, applied by the inbox and never by AI haggling, with the personalised-price notice in the business's voice whenever a price is personalised by automated decision (CRD art. 6(1)(ea)) (§4, §5). | "yes, thats the whole plan, reward good clients" |
| Q4 | How do negotiated changes and returns count in the network? | All of it, as one network rules version, version 6 (ADR-017 Amendment 3; version 5 went to Amendment 2): `amended` receipts; `refund.honoured` and `refund.late` on the refund's own receipts; a refused lawful withdrawal broken by verified report (`order.refund_refused`); `trm` on promises (§8). | "All of it, one rules version" |
| Q5 | Does the business, not the customer's assistant, set the price? | Always the business, for catalogue lines and fixed-price services. It ships first, on its own, as a fix (§3.2). | "Always the business" |
| Q6 | The code for the customer's assistant, in the business's emails | Only in its own short email, a day after the first contact, in the business's name; it rides on no other email (§12). | "Its own short email, a day later" |

Five answers are the options recommended to him. Q3 is not: the recommendation was no price
rewards in the first version, to stay clear of GDPR art. 22 and of "prices depend on your score".
§4 says how rewards stay on the right side of both. The rules the founder had already set hold
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

## 8. Reputation (ADR-017): rules version 6 (Q4)

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
network on rules before version 6 refuses an `amended` or a refund receipt (`422 bad_payload`).
**Rules version 6** (Q4, ADR-017 Amendment 3) adds `typ: "refund"`, `knd: "amended"`, the optional
claims `trm` and `acc`, the three `refund.*` outcomes and the report `order.refund_refused`: new
values and claims, never a renamed one. As an amendment to ADR-017 (§12) it takes effect as version
5 did (ADR-017 N1): the moment a network publishes it when no more than one business is a member
there, otherwise after 15 days' notice (ADR-017 §11). The inbox sends these receipts only to a
network whose `rules_version`, or announced next version, is 6 or later (the gate from 0008).

Without a verified acknowledgement the network honours at most 3\* amendments per item, moving
`due`, and a booking's `end`, by at most 90 days\* either way, so a business cannot postpone R30 on
its own word; and a change on its word alone never makes a customer's cancellation late. A customer
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
  `knd`, `OUTCOMES`, `trm`, `acc`) and its vectors gain rules version 6's values and claims (§8),
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
- ADR-017, as an amendment in force as rules version 6 (Q4; ADR-017 Amendment 3): §3's table and "never counts" line;
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

## Amendment 1 (23 Sep 2026): the first build of the customer's answers

**Status: proposed.** the founder decided on 23 Sep 2026 that customers accept or decline a proposed time
or a quote, and send details asked for, through three doors — their assistant, links in the
business's email, and a small page those links open — and that the owner's **Confirm** on a proposed
booking books the proposed time. The first build does that on today's tables, so it differs from the
body in the points below, which await his review:

- **The open offer is what the item holds** (§1): another time is `payload.proposed` on a booking in
  `proposed`, a quote is `payload.quote` on a request in `quoted`; there is no `item_offers` table
  yet. `terms_sha` is `base64url(SHA-256(canonical JSON of {kind, …terms}))`, which for these terms
  equals RFC 8785's. The doors are verbs on the item (§6): `POST /v1/items/{id}/accept`, `/decline`,
  `/counter` and `/details`, and the MCP tools `accept_offer`, `decline_offer`, `suggest_time` and
  `provide_details`; `/offers/{offer}/…` can be added beside them when offers get a table.
- **`action_links`** gains `terms_sha` (instead of `offer_id`), `lang` and `mail_key` in migration
  `0011_customer_links`; this ADR's `0011_negotiation` takes a later number.
- **§3.1 `confirm` from `proposed` stays**, and books the proposed time (N13): it records a yes the
  customer gave a person, so only a person may fire it — the owner or staff, never the owner's AI, a
  rule, an integration key, or anything on the owner's MCP even with a full owner key (the test the
  `security` settings use) — with an optional note of how they agreed. `record_acceptance` is not
  added. `confirm` also leaves `needs_info` (N14), and a customer's details, by any door, fire
  `provide_info`; an automatic reply from their mailbox (`Auto-Submitted`, `X-Autoreply`,
  `Precedence: auto_reply`) is kept on the item and answers nothing.
- **`propose`** (from `requested`, `needs_info`) takes a time a customer could say yes to: one that
  ends after it starts, fits one booking, and is free when proposed (N7); nothing is held.
  `request_info` from `proposed` withdraws the proposed time, which the event keeps. `propose` from
  `proposed` is not built: the owner asks again or waits for the answer.
- **`counter`** is proposed → requested for the customer's own other time, which must be a free time
  the business would offer; nothing is held. **`record_cancel`** (and `record_cancel_late`, fired for
  it) lets the owner, staff or the owner's AI record a cancellation the customer asked for: the
  customer's, judged at the moment they asked, with the customer's outcomes
  (`booking.cancelled_by_customer`, `booking.cancelled_late_by_customer`,
  `order.cancelled_by_customer`); a rule cannot record one.
- **§3.3 is built as written for acceptance**: the booking is created `confirmed` with its places
  claimed, or the order `accepted`, in the accept's batch; a quote must add up, and one that creates a
  booking names a time (no fall back to an order, N12). `counter` on a quote and `retract` are not built.
- **No time that has started** is proposed, confirmed, accepted or asked for (`not_too_soon`). The
  minimum notice before a time is the setting `booking.minNoticeMin` (default 60 minutes, the founder
  23 Sep 2026): `check_availability` offers nothing inside it, and no customer, rule, AI or
  integration key books a time inside it; the owner or staff in person still may. Nobody proposes
  or quotes one, a person included: the customer answers by the notice, so they could not accept
  it. A customer's request inside it is taken and waits for a person; one for a time that has
  started is refused at the create. A proposed time's deadline, and its links, end at the start
  less the notice.
- **Threading (§5, N10) without a `Message-ID` of ours.** Cloudflare Email Service writes that header
  itself and refuses a message that sets it, so each item has a random anchor id sent first in the
  `References` of every email about it, with `In-Reply-To` the customer's last own id, else the
  anchor. `mail_refs` (migration `0012_customer_mail`) maps the anchor, each email's own ref and the
  id the mail service returned to the item; the email door looks a reply up there. There is no
  plus address and no subject token in what we send.
- **The mail log** (`outbound_mail`, same migration): every email is rendered once, stored, and sent
  from the row, so a retry sends the same words and links; its status is kept and a customer email
  that failed for good marks the item as needing a person. The row keeps each action link without
  its HMAC, which the send puts back from `action_links`: the owner's app, the owner's AI reading
  `get_item` and a copy of the database see the email but cannot answer it as the customer. A
  transport that only logs (no mail service set up) records `skipped: no_service`, never `sent`.
  The acknowledgement goes to one address at most three times a day. Emails are in the customer's language
  (English or Portuguese), and one a rule or the owner's AI caused ends with "This reply was sent
  automatically. Reply to reach a person." (the founder, 23 Sep 2026), in place of §5's AI Act sentence.
- **Time yes, money no (Q2), for the owner's AI only, before §4's limits exist.** The owner's AI
  (actor `owner_ai`, or anything on the owner's MCP) is held like a rule by `assertBusinessPriced`,
  and further: it cannot send a quote, propose a time at a price other than the catalogue's (named,
  or kept by leaving the price out of a request whose price the customer set) or longer than the
  service, change a service's or product's price or the business's currency, publish a priced
  product or service (what it adds with a price is saved unpublished), add or remove a feed, or
  write, rewrite or switch on a rule that sends a quote or names an amount (a rule prices on its own
  for as long as it is on). A booking or order it makes through the public doors is priced from the
  catalogue like a customer's, so its own figure is never the price. §4's "the AI may raise a
  price" is not built. Every refusal carries `draft_for_owner: true` and tells it to leave a note.
- **A price per person.** A service's fixed price is per booking unless `price.per` is `person`; then
  a booking costs it times `partySize`. A group still takes one place per booking.
- **Test items reach nobody.** A sandbox item emails neither the customer nor the owner (the mail log
  keeps each as `skipped: test_item`), asks no network for a key, presents no pass, and its one-time
  code is left on the item as a note. ADR-017 §2.1 is amended the same day: a network other than the
  default one gets customers' addresses only once it has verified this inbox. Since a network
  verifies by answering the inbox's ping, which any host can do, only a person at the business
  switches a network on or lets it issue codes; the owner's AI and integration keys may switch one
  off, never on.

## Amendment 2 (24 Sep 2026): offers and their deadlines

**Status: proposed.** The offer of §1 and its six verbs are built, with the deadlines of §1 and §11,
on the doors Amendment 1 shipped. It differs from the body, and from Amendment 1, in these points,
which await review:

- **The table** is `item_offers`, in migration `0014_offers` (0011–0013 were taken), with §1's
  columns and one more, `form`: the kind the fingerprint names — `time` (a booking's time, either
  side's), `quote`, `order` (an order's lines, total and delivery, either side's) and `request` (what a
  quote request asks for: the thing, how many, for when; never its words or a budget). The
  fingerprint stays Amendment 1's, `base64url(SHA-256(canonical {kind: form, …terms}))` with the field
  names the item holds (`price`, a quote's `validThrough`), so a time or a quote fingerprints exactly
  as the links already emailed. Each offer's terms are the projection of what the item holds after
  the transition that makes it, so the row and the projection never differ. `slot_claims` gains
  `offer_id` (a hold) and `items` gains `request_expires_at` (below). No draft is written yet: drafts
  come with the owner's limits, and the unique index for them is already there.
- **The payload's pointer** is `offer: {id, rev, by, round, status, validThrough, held?, binding?}`,
  in the payload's own camelCase; `status` is `open` or `accepted`, `held` marks a time held for the
  customer, `binding: false` one we may still withdraw.
- **Rounds.** The customer's request is round 1, and each answer that is not a yes is one more;
  replacing one's own offer keeps its round. `negotiation.maxRounds` (3\*) bounds automation (the
  owner's AI, a rule), which past it is refused (`guard_failed`, `round_left`, `draft_for_owner`)
  until drafts exist, and a customer, whose next suggestion goes to a person as their message
  (`202`, `passed_on`, `waiting_on: "us"` as the details door already says); a person at the business
  is never bounded.
- **The doors** are Amendment 1's verbs, plus: `offer_id` on `accept_offer` and `decline_offer` (an
  answer to an offer since replaced is `409 offer_changed`), their aliases
  `/v1/items/{id}/offers/{offer}/accept` and `/decline`, `reason_code` on a decline (kept on the
  declined offer), and `POST /v1/items/{id}/offers` (`make_offer`) with only what the customer would
  change: a time, quantities or a delivery date for changes to an order, how many or for when for a
  quote. A price of their own (`total_price`, `unit_price`), `party_size`, or anything else that is
  not a counter the business could take is kept as their message for a person (Q1, off out of the
  box: `GET /v1/business` says `price_negotiable: false`, and there is no switch yet). The confirm
  step on a customer's own offer is not built. The owner has `list_offers` and `make_offer`; there is
  nothing for `send_offer_draft` to send yet.
- **Validity (§1).** A time a person proposes holds until its start less the
  minimum notice, the deadline its email has always shown; what the owner's AI or a rule proposes
  holds at most `negotiation.offerValidHours` (48\*); a quote or changes to an order hold until the
  date they give, else `offerValidHours` (a quote's `validThrough` is no longer required). A proposed
  time held before offers had a table keeps the deadline its email gave.
- **The request's own clock** is `items.request_expires_at`: a booking `booking.autoExpireHours` on
  (now read) and never later than its start, an order or a quote request
  `negotiation.counterValidHours` on, wound again whenever the request goes back to the business or
  the business asks the customer something. A request made before this migration has none and never
  lapses on its own, so an upgraded instance does not close and email every old request at once;
  neither does one the business wrote down itself (the owner, a shop's system, an integration key),
  since the customer did not send it. Either gets a clock only once the customer next acts (answers a
  question, suggests another time): the business's own question never closes an order a shop already
  took. While the customer's request stays open, its offer's `valid_through` and the payload's
  pointer follow the clock.
- **Withdrawing** our open offer — `retract`, and Amendment 1's `request_info` from `proposed` —
  closes it (`retracted`) and opens the customer's request again as it stands on the item, a new
  offer of theirs: the business's `confirm` or `accept` always takes an open offer of the customer's.
  `retract` needs the offer to be non-binding, which today means `negotiation.binding` off: every
  offer then says it is subject to our confirmation.
- **Orders** gain `proposed` and `expired` (terminal, before any promise). `propose` (the owner, staff,
  their AI, a rule) carries the lines as they would be, an optional delivery and validity, and the
  inbox works out the total; the owner's AI and rules may change quantities and delivery, never a
  price (each line a catalogue product at its catalogue price). The customer accepts (the order is
  accepted on the changes, with its receipt), declines (`cancel`, as for a proposed time), or answers
  with quantities or a date (`counter`, back to `received`); a person records a yes given by phone
  (`accept` from `proposed`, `byPerson`). Links in the email: **Accept** and **Decline**; the change
  is a reply or the assistant's `make_offer`.
- **Quotes** gain the customer's `counter` (how many, for when; back to `received`, the quote gone)
  and `retract`. The owner's `accept` of a priced counter is not built: price counters are off.
- **Late, never refused (§1).** A business `confirm` of a booking, or `accept` of an order, whose
  request's clock had run out before the sweep reached it becomes our `propose` on the same terms,
  which the customer accepts; the answer says `converted: "request_lapsed"`.
- **Expiry** is checked in the write that would accept (`410 offer_expired`, in the customer's words
  for a time, a quote or changes) and swept every quarter hour as the `system` actor
  (`request_lapsed`, `offer_lapsed`), which tells the customer in the business's words: we could not
  answer in time, we did not hear back, or what we proposed lapsed and until when it held. A rule may
  still `expire` a request as before, but what we proposed (a time, a quote) only once it lapsed, and
  the customer is now told then too. A lapse found more than 7 days after its date (an old offer from
  before this table) closes without an email.
- **Automation is held to what we said.** What we proposed binds us until it lapses, so the owner's
  AI and rules never take it back: no `retract`, `request_info`, `decline`, `cancel` or `expire` of an
  open binding offer before its date (`guard_failed`, `offer_binding`, `draft_for_owner`); recording
  the customer's own no (`record_cancel`) stays theirs. They never offer a customer a dearer price
  than the business last offered them in the negotiation, a price a person gave included (§1,
  `worse_than_before`); never accept a customer's answer holding a price that is not the catalogue's;
  and a rule never proposes a time without a price of its own on a request the customer priced (Q5).
  What they send with a later date than `offerValidHours` carries the capped date, so the customer
  reads the date it holds until. A rule that reads a customer's standing proposes and quotes nothing
  until offers are checked against the customer's own terms (§4, positive first). The owner's AI
  records no payment, failed payment, charge-back or refund, and names no payment link (Q2).
- **Answers are pinned.** A decline or a suggestion naming an offer (`offer_id`) is written on the
  item as it was checked, so it never lands on an offer made meanwhile (`409 offer_changed`), as an
  accept already was. A request never arrives holding the business's answer (`offer`, `proposed`,
  `quote` are dropped at create), and a customer's words alone in `make_offer` go to a person as their
  message. The customer's side never reads the round.
- **Items from before** get their offer lazily, with an id every writer agrees on (`lgo_<item>`), in
  the batch of their next transition; the sweep writes it first for proposed bookings and quoted
  requests, a batch a run, so they lapse when their emails said. Nothing is sent again.
- **Holds (§3.1)** are built as written: `booking.holdOnPropose` (now read) and `booking.maxHolds`
  (2\*), counted per party or per signed assistant.
- **Settings**: `negotiation.offerValidHours`, `counterValidHours`, `maxRounds` and `binding`, which
  only the owner in person changes; `priceCounters`, `perCustomer`, `changes`, `rewards` and `ai.*`
  come with what reads them. Erasure rewrites an offer's note, the words it was shown with, and what
  the customer named, keeping its terms, amounts and fingerprint; a customer's export lists the
  offers; a full webhook carries `data.offer` for the offer its event made or closed.

## Amendment 3 (24 Sep 2026): changes to what was agreed

**Status: proposed.** Changes to a confirmed booking or an accepted order (§3.1, §3.2) are built on
Amendment 2's offers. They differ from the body in these points, which await review:

- **The change is an offer** of `kind: change` and `form: change`: its terms are the booking (time,
  party, price) or the order (lines, total, delivery) as it would be, a full snapshot, and the
  fingerprint names `change`, so a yes to a change is never a yes to a time or an order that
  happened to hold the same terms. Its parent is the open change it answers, else the offer both
  sides last agreed; a promise from before offers had a table gets that agreed offer, written from
  what it holds, in the same batch. While one is open the payload carries it as `change: {by, …}`
  and points `offer` at it; accepted, it becomes the promise; otherwise the pointer goes back to
  what was agreed. No migration: the tables of Amendment 2 hold it.
- **Five events** on `confirmed` bookings and on orders from `accepted` to `fulfilling`, each leaving
  the item where it was: `propose_change` (either side; a new one answers the other side's open
  change, `countered`, or replaces the asker's own, `superseded`), `accept_change` and
  `decline_change` (the side it was asked of), `retract_change` (the asker; the business only when
  `negotiation.binding` is off) and `expire_change` (the system, at its date). A customer who asks
  again before we answered is one round further, so asking over and over reaches a person after
  `negotiation.maxRounds`. A promise that ends another way — cancelled, completed, fulfilled,
  charged back — ends its open change with it (declined, withdrawn, or lapsed when the system ends
  it), and lets its hold go. A person at the business records a customer's yes to our own change,
  given by phone or in person, with `accept_change` and an internal note (§3.1's
  `record_acceptance`, as `confirm` from `proposed` does for a time); the owner's AI cannot.
- **What each side may ask.** The customer: another start for a booking, one we would offer (open,
  on the grid, free but for its own places), keeping its length; other quantities of an order's
  lines (by index, 0 drops one) or another delivery date. Never a price or a party size: those, and
  a note alone, go to a person as their message (`202`, `passed_on`: "what we agreed stands"). The
  business: another start and end (its length by default) and a price of the owner's; an order's
  lines and delivery; a date to answer by. A change that changes nothing is refused as one.
- **Deadlines.** The customer's lapses `negotiation.counterValidHours` on, and before either start;
  ours at the date it gives, else before either start less the minimum notice (a booking) or
  `negotiation.offerValidHours` on (an order); what automation asks, at most `offerValidHours`. A
  deadline is checked in the write that would accept it (`410 offer_expired`, "what we agreed
  stands"), and the quarter-hour sweep closes what lapsed (`expire_change`) and tells the customer.
  A customer's change we take after it lapsed goes back to them as our change on the same terms
  (`converted: "change_lapsed"`): late, never refused.
- **Holds and places.** A change we ask for to a booking is held as a proposed time is
  (`booking.holdOnPropose`, `booking.maxHolds`), counting the booking's own places as taken, since
  they stay its own until the change is accepted; a move onto its own time that capacity cannot hold
  twice goes out unheld. Accepting releases every place of the item and claims the new time in the
  same batch.
- **Limits.** At most `negotiation.changes.maxPerItem` (3\*, at most 3) accepted changes to a
  promise, and none moving what it is due, or when a booking ends, more than 90 days from what was
  first agreed, either way (`AMENDMENT_LIMITS` in core, until rules version 6 puts them in the spec). An order agreed with
  no delivery date was due `orders.dueDays` after it was agreed, as its receipts say, and the 90 days
  count from then. Every accepted
  change counts: §8's "unverified" (a receipt no acknowledgement answers) needs the `amended`
  receipts. Past either, the customer's change goes to a person, and the owner is refused
  (`changes_left`) with the way to do it: the customer's own cancellation and a new booking or order.
- **Where a network holds the promise, nothing changes yet.** A network on rules before version 6
  holds a promise to the date it was sent with, and would count a booking moved later as a promise
  never closed; and until this inbox sends rules version 6's `amended` receipts, even a network on 6
  would not see the change. So a change is recorded only when no receipt of the item was published to a
  network and none that takes receipts is switched on for it (a customer who stopped networks aside),
  or the promise carries no due date (the business wrote it down itself: claims v1), or it is a test
  (`amendments_live`). Otherwise the customer's change goes to a person, and the owner is told to
  record the customer's cancellation and take a new booking. This is stricter than "rules version 6
  in force" and loosens when the receipts ship. A promise once changed is never sent to a network
  at all — not its promise, its acknowledgement or its outcome, and not to a network switched on
  after the change, whose backfill would otherwise send the date first agreed and count the
  promise unclosed (ADR-017 R30): its receipts stay the business's own, `withheld` where a
  publication was queued.
- **No `amended` receipt yet**, and no `receipts.offer_id`: both come with rules version 6 (§8). The
  promise's receipts keep the due date first agreed, and an outcome copies it, as today; with no
  network in the way that is a date nobody else holds.
- **Orders and money.** Before payment is asked for, a change may change an order's total. Once it
  was asked for or made (`awaiting_payment`, `payment_failed`, `paid`, or a payment recorded), a
  change keeps the total: a customer's that does not goes to a person, and ours is refused
  (`total_fixed`: a second order for more, a refund for less). That holds at acceptance too: a change
  asked for before payment and accepted after it is not made. The customer's yes to ours, then, or
  once a network holds the promise (above), goes to a person as their message (`202`, `passed_on`,
  by their assistant or from the email's page), never refused; what was agreed stands until a
  person answers. §3.2's "a new total updates the
  payment request" and the linked `price_adjustment` refund come with refunds.
- **Automation (Q2).** `negotiation.ai.mayAcceptChanges` (on\*) lets the owner's AI and rules accept
  a customer's change to a free time, before `negotiation.changes.customerCutoffMin` (empty\* = the
  cancellation window) and, for an order, only at the catalogue's prices; `mayProposeChanges`
  (off\*) lets them ask for one, moving the time or the quantities and delivery, never a price (no
  line dearer than was agreed, so a price a person gave is not put back up to the catalogue's) or a
  longer booking. While the cancellation window is also the cutoff, the owner's AI may lengthen it
  but never shorten it, since it is then a limit on the AI. Otherwise `guard_failed` (`change_allowed`, `owner_money` or `business_priced`) with
  `draft_for_owner`. Both are `negotiation` settings, so only the owner in person changes them; the
  AI still reads them in `get_settings` (withholding `negotiation.ai` comes with the money limits).
  Integration keys act as the owner, as before.
- **The confirm step.** Accepting our change takes `terms_sha` like any offer; `obligation_to_pay`,
  and the page's "Order with obligation to pay", only when it asks more of the customer than what
  was agreed; otherwise the button is "Confirm the change". A customer's own change carries no
  confirm step yet, as Amendment 2 says of their offers.
- **Doors.** On a promise, `make_offer` and `suggest_time` ask for a change; `accept_offer` and
  `decline_offer` answer ours (`offer.kind: change`); `decline_offer` on their own takes it back. The
  status gains `requested_change` (their change while we have not answered). The owner's
  `make_offer` asks for a change on a promise. Our change's email carries **Accept the change** and
  **Keep it as it is**; every email about a confirmed booking with no change of ours open carries
  **Change the time**, which opens the free times (its own places free to it, its own time left out)
  and asks for one; a link is bound to the booking as it stood, so any change retires the links sent
  before. A customer changes an order by reply or through their assistant.
- **Words.** "Can we move your booking … from … to …? If that does not suit you, your booking stays as
  it is."; "We have received your request to move … Until we confirm, your booking stays for …";
  "Done: your booking … is now for …"; "We cannot move … to …, so your booking stays for …"; "Our
  suggestion to move … has lapsed"; in Portuguese alike ("Podemos mudar a sua marcação …?", "Feito:
  … passa para …", "… mantém-se para …"). Owners are told who asked for or answered a change.
- **Reputation.** No change counts: a change event records no outcome. `NEGATIVE_EVENTS` gains
  `decline_change`, `retract_change` and `expire_change`, and `OFFER_EVENTS` `propose_change`, so a
  rule that reads a standing may take a customer's change but never refuse one or ask for one.

## Amendment 4 (25 Sep 2026): returns, withdrawal and the confirm step

**Status: proposed.** Returns and refunds (§3.4), the right of withdrawal and its function (§7, CRD
art. 11a), the business cancelling a paid order (§3.2), the return policy in the profile (§6) and the
confirm step before a priced request binds a consumer (§5) are built on Amendments 2 and 3. They
differ from the body in these points, which await review:

- **The migration** is `0015_returns`: `products.withdrawal` and `services.withdrawal` (text, default
  `standard`), and an index on `items.linked_item_id`, by which an order or a booking finds its
  returns. The flags are public like the rest of the catalogue row (they are shown before the order);
  the owner or staff set them, never the owner's AI or another system's key, and feeds never write
  them. `floor_minor` and `negotiable` come with the owner's limits.
- **Settings.** `returns` (`days` ≥ 14\*, `postage`, `refundDays` ≤ 14\*, `respondHours` 48\*,
  `assumedTransitDays` 7\*) and `commerce` (`customers`: `both`\*, `consumers` or `businesses`; `legal`:
  `legalName`, `address`, `country`, `phone`, `email`, `vatId`, `complaintsUrl`) are the owner's in
  person, like `negotiation`, as is the new `negotiation.ai.mayAuthorizeReturnsInPolicy` (on\*).
  `country` (two letters) picks the law: Portugal's, the UK's (GB), else the EU's. `refundOn`,
  `collect`, `restockingPct` and `offerCredit` wait for settlements.
- **A return is a `refund` item** linked to its order or booking, made in the batch of the transition
  that makes it, as the same customer's (its party, access token, identity columns and
  presentations), with its own `create` event caused by that transition. Its payload keeps `amount`
  (what is owed) and gains `kind` (`withdrawal`, `faulty`, `policy`, `cancellation`;
  `price_adjustment` is reserved, since a change that lowers a paid total is still refused),
  `reasonCode`, `lines`, `wants`, `noticeAt`, `goodsBack`, `returnBy`, `instructions`, `evidenceAt`,
  `refundDue`, `disputed`, `paymentRef` and `paidAmount`; `reason` becomes optional, and a refund
  written before reads as it did. States: `requested`, `approved`, `goods_received`, `refunded`,
  `rejected`, `cancelled`. `approve` (the owners; automation as below) sets whether goods come back,
  by when (14 days\*) and how; `reject` is a person's, with the reason the customer reads, and has no
  way past a withdrawal, nor past any return the customer asked for while they could still withdraw,
  whatever reason they gave (`not_withdrawal`); `goods_back` (the owner, staff, a connector) fixes when
  the refund is due, and only where goods were to come back (`goods_expected`), so it never moves the
  date of a refund that had nothing to wait for; `dispute_goods` is a person's, its note the
  customer's to read, and the refund waits; `refund` (a connector, the owner, staff) pays at least
  what is owed and at most what is left of what was paid; the customer's `cancel` (of a return of
  goods only, which they then keep: money owed with nothing to send back is not theirs to drop by a
  click) and a person's `record_cancel` (never the owner's AI's) drop it.
- **Settlements are not built.** `offer_resolution` (a partial refund, an exchange, credit) and every
  deduction need the customer's yes to an offer of `kind: resolution`; until they exist, a refund of
  less than what is owed is refused (`refund_amount`) and the business settles in words and in full.
- **What makes a return.** Before the goods went out, a withdrawal (`withdraw`, `record_withdrawal`)
  ends the order, neutrally, and what was paid is owed back within 14 days of the notice
  (`withdrawal`, `approved`, nothing to come back); nothing paid, no refund item. After it the order
  stays `fulfilled` (it was kept) and the withdrawal is a return, `approved`, the goods to come back
  within 14 days of the notice and the refund due at the later of the notice's 14 days and three days\*
  after they arrive. The customer's `request_return` (and the business's `open_return`, for one asked
  for by phone) is `faulty` for faulty, not as described or the wrong item, `withdrawal` (agreed at
  once) for anything else while the period runs, else `policy`; one return of an order is open at a
  time (`no_open_return`). The business's `cancel` of a paid order is a person's: `order.not_fulfilled`,
  and a `cancellation` refund due in `returns.refundDays`; so is its `cancel_by_business` of a paid
  booking (`booking.cancelled_by_business`), whose email says by when. `record_cancel` (or `record_cancel_late`) of a
  paid order or a paid booking, asked while the customer could still withdraw, is their withdrawal
  whatever the business calls it: it is recorded as `record_withdrawal`, dated as they asked, never
  late, owed back within 14 days, and the owner's AI makes it only from their message. Otherwise
  `record_cancel` of a paid order is the customer's (`order.cancelled_by_customer`) and their refund
  waits for the business (`policy`, `requested`). The same goods never come back twice: a return takes
  only what earlier returns (neither refused nor dropped) left with the customer, owes at most what is
  left of what was paid (`nothing_to_return` when nothing is), and no refund records more than that.
  A booking gains `record_payment` (a connector, the owner, staff), which makes it a paid contract
  (payments under another reference add up, a deposit and then the rest; the last one told again
  counts once); `withdraw` and `record_withdrawal` then cancel it, never late
  (`booking.cancelled_by_customer`), and refund what was paid.
- **The right, as built.** A consumer (unless `commerce.customers` is `businesses`), nothing excepted,
  a booking paid for and not begun, within the period: goods from delivery (`deliveredAt`, set by
  `fulfil` or `record_delivery`; else `fulfil` plus `assumedTransitDays`) and before it, a service from
  the booking. Every item counts as a contract made at a distance, erring toward the customer: a
  business that also sells face to face records those sales elsewhere or flags them. The period is
  counted by Regulation 1182/71 in the business's zone, its end moved off weekends and Portugal's
  national holidays or England and Wales's bank holidays (Easter computed); elsewhere weekends only,
  which can only end a period later than the law. The 12 months more for a customer never told are
  in the pure function but not applied: every confirmation now tells them. A booking is withdrawn from
  before it starts; the pro rata for a service begun at the customer's request comes with settlements.
  A withdrawal the business records is judged at the moment the customer said it — their message on
  the item (`entryId`), which the owner's AI must name, or the time a person types — and so is a return
  it opens for them (`open_return` with `entry_id` or `asked_at`).
- **The withdrawal function.** Every email that confirms such a contract (accepted, paid, fulfilled,
  confirmed, a change accepted) carries the period and a **Withdraw from contract here** link while
  the right runs, living until the period ends and a day (60 days\* while the goods are on their way);
  the first confirmation (accepted, paid) also carries the model form of Annex I(B) (DL 24/2014's in
  Portuguese, the UK's model cancellation form in English under GB law) and who the business is. An
  excepted contract's confirmation says why there is none. The page shows the statement — name,
  contract, email for the copy — and sends it on **Confirm withdrawal**; past the right it says so and
  still sends it, as a return under the policy once the goods reached them, else as the customer's
  message. The assistant's `withdraw_from_contract` is the same two steps: `409 confirm_withdrawal`
  with the statement, then the withdrawal with `confirm_withdrawal: true`; never refused. The
  customer's `cancel_item` on something paid for is their withdrawal while the right runs; before a
  payment it stays the cancel it always was, which ends the same way and owes nothing. A link page of
  an email sent before this build does not yet offer the withdrawal link.
- **The acknowledgement** goes at once, from the withdrawal's own email (the order's, or the
  return's), with the statement as sent, the refund's date or the goods to send back, and who pays
  for that. The PT 24-hour check and the separate alert are not built: nothing delays it, and the item
  shows when an email was not sent. The owner is told once, three days\* before a refund falls due,
  and in Portugal from the tenth day after a withdrawal.
- **Automation (Q2).** The owner's AI and rules may approve a return while
  `mayAuthorizeReturnsInPolicy` is on: faulty goods, or inside the owner's policy (`returns.days`,
  nothing excepted, whoever the customer), and always with the goods coming back
  (`return_allowed`, `return_outside_policy`); a refund with nothing sent back is a payment
  (`owner_money`). Refusing, disputing, dropping a return for the customer, cancelling a paid order,
  recording a payment or a refund, and the return settings are never theirs. `maxRefundMinor` is not
  built.
- **The confirm step (C17).** A consumer's `create_booking` or `create_order` that carries a price of
  the business's, above zero, writes nothing without `terms_sha`: `409 confirm_terms` with the summary
  (the thing and the time or the lines, the total, the trader's name and address, the right of
  withdrawal or the exception, the express request for a service starting within the period, the
  obligation to pay), `terms_sha` (the request's own fingerprint, `form` `time` or `order`) and
  `obligation_to_pay: true`; on MCP an ordinary result with the question. No idempotency row is kept,
  so the confirmed retry is a first request, and the request then binds the customer (`binding` on
  its offer). A booking's fingerprint names the service (`itemOffered`), so a yes to one service never
  books another at the same price and time; offers compare it only when both sides name it. A request holding no price of the business's yet, a free one, a business customer's, and
  one the business writes down itself need none. Counters, changes and requests by email or from
  before this build are taken as today: converting an unconfirmed request into the business's own
  offer is not built.
- **Doors.** `POST /v1/items/{id}/withdraw` (`withdraw_from_contract`), `POST /v1/items/{id}/returns`
  (`request_return`, `201`), and for the owner `POST /v1/owner/items/{id}/returns` (`open_return`).
  Both customer doors are in the `negotiate` rate class. The status door gains `withdrawal`
  (`available`, `until`, `label`, and `why`, `reason` when not) and `refunds` (each return's id,
  reference, state and sentence); `next` gains `withdraw_from_contract` and `request_return`.
  `GET /v1/business` gains `refund` in `item_types`, `return_policy` (schema.org
  `MerchantReturnPolicy`) and `trader`; the network's directory profile is unchanged.
- **Words.** EN and PT, and the UK's for English under GB law (cancel, a cancellation). A customer
  reads "your return", never "refund request"; every sentence is the business's.
- **Reputation.** No receipt for a refund yet: `refund.honoured`, `refund.late`,
  `order.refund_refused` and the refund's own promise receipt come with rules version 6. A withdrawal
  records the neutral cancellation codes that exist; a return after fulfilment records nothing on the
  order. A charge-back while a return is open, or after a refund paid past its date, records nothing
  against the customer. Returns and refunds are left out of the business's own history of a customer.

## Amendment 5 (26 Sep 2026): the owner's limits, price counters and rewards

**Status: proposed.** The owner's limits (§4), a customer's own price (Q1), rewards (Q3) and the
personalised-price notice (§5) are built on Amendments 2 to 4. They differ from the body in these
points, which await review:

- **The migration** is `0016_limits`: the owner's floors in a table of their own, `price_floors`
  (`kind` `product` or `service`, `ref_id`, `floor_minor`), not a catalogue column, since the public
  catalogue and the owner's AI read catalogue rows whole; `products.negotiable` and
  `services.negotiable` (1\*); the drafts table (below); and `money:write` given to every live
  integration key that holds `inbox:write` or everything, so today's integrations keep working.
- **Who is automation.** The owner's AI (an OAuth app, or anything on the owner's MCP, even with a
  full owner key), a rule, and an integration key without the new scope `money:write` ("record
  payments and refunds, and price offers and quotes, as your shop or till does", offered to no AI
  app). Without it a key records no payment, failed payment, charge-back or refund and gives no payment
  link (`403 not_allowed`, `money_recorded`). The owner in person is never held.
- **The limits built** are `below_floor`, `above_list`, `counter_priced`, `custom_line`, `time_moved`,
  `delivery_later`, `worse_than_before`, `rounds_exhausted`, `change_not_allowed` and
  `over_approval_value`, judged in the write for every offer automation makes (a time, changes to an
  order, a quote, a change to what was agreed) and every acceptance of a customer's price, on each
  catalogue line priced for this customer. The effective floor is max(`floor_minor`, P × (1 −
  `maxDiscountPct`/100)), rounded up, and never above P itself: a list price the owner lowered under
  its floor may still be offered. Refunds and returns keep Amendment 4's guards (`refund_over_max`,
  `owner_money`, `return_outside_policy`). **Not built:** `deposit_changed` (no deposit terms exist),
  and `legal_identity_missing`, which would draft every priced offer automation makes for an owner who
  has not filled `commerce.legal` in yet — out of the box, time proposals included — against Q2;
  still to decide, with an owner-app prompt to fill it in as the likely alternative.
- **`amount_named`**, new: words from automation name only money the business offered (DL 7/2004
  art. 32(1)). A reply from the owner's AI or a key without `money:write` naming an amount that neither
  the item's business-side terms, nor the catalogue, holds — the customer's own stated or countered
  price included — or something off a price, is kept as an internal note, the item marked for a person
  (`202`, `held`); a transition note that does so makes an offer a draft and refuses anything else
  (`422 outside_limits`). An amount is a number beside a currency, so times and party sizes never are.
  A rule's words are the owner's own and are not judged.
- **Drafts** live in their own table, `offer_drafts` (one per item, the latest, with the
  transition's input), not as `item_offers` rows of status `draft`: a draft is no offer anyone saw, so
  it takes no rev or round. Making one is the self-transition `draft_offer` (`needsHuman`, no word to
  the customer, no rule run), answered `202 drafted {id, breaches}`; the owner is emailed once an hour
  per item at most. It is stale once anything but a flag or another draft moved the item. Only the owner
  in person sends it (`POST …/offers/draft/send`; there is no MCP tool) or drops it. Past the last round
  and worse than before are now drafts, not the refusals `round_left` and `worse_than_before` of
  Amendment 2; a customer past the last round is still passed to a person.
- **Reading the limits.** `get_settings` leaves out `negotiation.ai` and `negotiation.rewards` for
  anyone but the owner in person and names them in `withheld`; a write without them keeps them.
  Floors are read and written only at `GET`/`PUT /v1/owner/catalogue/floors`, by the owner in person,
  never above the price. Errors, drafts and sentences carry codes, never a number.
- **Price counters (Q1).** `negotiation.priceCounters` (off\*); `GET /v1/business` says
  `price_negotiable`. On, `total_price` (a proposed time) and `unit_price` (the lines of changes to an
  order) are the customer's counter, in the business's currency; automation takes one at or above the
  floor, never answers a price with a price. It goes to a person as the customer's message, never
  refused, when off, on a quote, on what is not `negotiable`, past `perCustomer.open` (3\*) open
  negotiations on price or `perCustomer.priceCounters` (3\*) prices for the same product or service in
  `perCustomer.days` (30\*), and past the last round. The email page (`/c/`) offers times only; a price
  of their own comes through their assistant or a reply.
- **Rewards (Q3).** `negotiation.rewards`, keyed by name (at most 20): `if` (a rule condition reading
  only `customer_known`, `customer.*`, `person_trusted`, `person_tier_on` and `person.*`, with `all` and
  `any`; `not`, anything else and an empty group are refused when saved), `pct` 1–50, `only` (ids, null
  for all), `says` (≤ 200, checked against the words a customer never reads from the business). P =
  min(list, max(⌊list × (1 − pct/100)⌋, floor)); the best match applies. The inbox prices a request at
  P when it is created (the door loads the customer's standing) and a catalogue line automation offers
  at the list price is offered at P; a price a person types is theirs, with no notice. A rewarded line
  keeps `listPrice`, the payload `personalised {listPrice, says?}`; the notice ("Your price: … (our
  price …). We personalised this price for you by automated decision-making.") is in the confirm
  summary, `offer.human`, the status sentence, the emails, and `disclosures: ["personalised_price"]`.
  Rewards are not applied to quotes or custom lines.
- **Rules.** A rule that reads a standing still offers nothing of its own (stricter than
  `noWorseThanDefault`, which is not built); one that reads an address, a country, a language or a
  nationality may not set a price or terms (`422 geo_terms` when saved; skipped and noted when an
  older one runs). `offer_resolution` joins `NEGATIVE_EVENTS` when settlements exist.
- **The owner app** gains the limits and price counters in Settings, each product's and service's
  lowest price and `negotiable`, and the draft on the item, to send as it is or drop. Rewards are
  written through the settings document for now.
- **Hardened after an independent review**, each with a test that failed first:
  - An acceptance by automation above the list price is `above_list` (an assistant that mistook
    cents for euros), and a customer's own price for what a person priced — a service priced `from`
    or by quote, a longer time — is `custom_line`: no floor judges it. A price the inbox itself put on
    a rewarded request stays acceptable if the owner changes the rewards before it is confirmed.
  - A time automation offers must be one we would offer (open, not closed, on the grid): else
    `time_moved`, as §4's table says.
  - The notice goes with every price automation puts below the list, named or kept (a customer's
    price taken by proposing another time at it), and with a draft the owner sends as it is.
  - `amount_named` reads amounts glued to or spaced from their currency, spelt out in words (EN, PT),
    per cent in words, and half price or free of charge; the names of lines automation writes; and a
    catalogue price only beside the name of what it prices ("€18.50 and it's yours" is held).
  - The owner's AI, and a key without `money:write`, may not write, change or switch on a rule whose
    words name an amount or a discount (a rule's words go out unjudged, as the owner's), nor a pricing
    rule; nor raise or lift `orders.maxValueWithoutApprovalMinor` (lowering it is fine).
  - Rules no longer read `negotiation.ai`, `negotiation.rewards` or any secret from the settings:
    `test_rule` was an oracle for each, a reply template a recital.
  - A reward whose condition a customer with no record meets ("no no-shows", "not trusted"), or that
    reads `customer.match` or `customer.open_bookings`, is refused when saved and never applied: a
    reward only ever lifts, so it is never a price for everyone but those with something against them.
  - Only the owner in person drops a draft, as only they send one.
  - `maxRefundMinor` bounds what automation agrees with nothing to send back for the whole order,
    counting the order's other refunds agreed so: a claim split line by line never goes past it.

## Amendment 6 (26 Sep 2026): the receipts of rules version 6

**Status: proposed.** The inbox side of §8 (Q4) is built: agreed changes and refunds are signed
receipts, sent to the networks that read them. The rules themselves are ADR-017's Amendment 3
(accepted in substance in Q4), rules version 6 (`"0.1.3"`): version 5 went to ADR-017's Amendment 2,
accepted and in force on 26 Sep 2026, and on the same day it was decided that these receipts come as
version 6, taking effect as version 5 did (ADR-017 N1): the moment a network publishes it when no
more than one business is a member there, otherwise at 00:00 UTC on the sixteenth day after, at
least 15 days' notice. It was published, and in force on our network, on 29 September 2026. A network at version 5
is sent exactly what it was sent before: nothing below waits on it or reaches it until it takes 6. This differs from the body, and from Amendments 3 and 4, in these points, which
await review:

- **The migration** is `0017_amended_receipts`: `receipts.offer_id` ('' for every receipt but an
  amendment), and the unique index swapped to `(item_id, kind, outcome, offer_id)` in the same batch,
  as 0008 swapped it; every receipt issued before keeps its row, unchanged. The receipt job's dedupe
  key for an amendment is `receipt:<item>:amended:<offer>`.
- **An amendment** (`knd: amended`) is issued for each change both sides accepted (`accept_change`,
  by either door, a yes a person recorded included), dated by the acceptance: `ref` the item's
  earliest promise, `due` and `end` the new times (an order changed without a delivery date keeps the
  `due` the change before it set, else its promise's), `trm` the change offer's `terms_sha` bound
  under that offer's own key (below), `acc` whoever said yes, and no `per`. Its `iat` is the moment of
  acceptance, never before a change agreed earlier; two agreed in the same second get nonces in the
  order they were agreed, so a network's latest (greatest `iat`, then nonce) is the one agreed last. None for a promise the business
  wrote down itself (claims v1), one made before outcomes were recorded, or a test. An outcome issues
  first any agreed change that has no receipt yet, as it issues a missing promise, and carries the
  latest amendment's `due` and `end`; the promise's own receipts keep the dates they were signed with.
  A promise signed only after a change (its job failed, or it waited for a first contact's answer)
  still names the dates and `trm` of the offer that made it, never the change's.
- **The limits** (3 changes, 90 days) are measured from the `due`, and a booking's `end`, of the
  item's earliest promise receipt, the date every network holding it measures from, and only without one from the terms first
  agreed: raising `orders.dueDays` after an order was accepted with no date must not buy it more room
  than a network will honour.
- **Where a network holds the promise** (this replaces Amendment 3's "nothing changes yet" and "a
  promise once changed is never sent to a network"): a change is recorded only when every network that
  holds the promise (a publication of the item's receipts published or queued) or will be sent it (one
  switched on to take receipts, unless the customer stopped the networks) applies rules version 6 —
  in force, since announced is not enough: until then it holds the business to the date first agreed.
  With no network in the way, at once, as before. The receipts of a changed promise go only to a
  network that applies version 6, and only once each agreed change has its receipt: its promise, each
  amendment, then its outcome. Anywhere else they wait, counted as held, never withheld, and a network
  switched on later gets them from its backfill once it applies version 6. The customer's side is
  unchanged: their change still goes to a person as their message while the promise cannot move.
- **Refunds** have receipts of their own (`typ: refund`) when the order or booking they refund was a
  customer's (C14): the promise (`knd: accepted`) when its date is fixed — as the refund is made, when
  it is owed at once (a withdrawal before the goods went out, a paid order or booking the business
  cancels); at `approve` with nothing to come back; at `goods_back` — with `due` that date and `amt`
  what is owed; `refund.honoured` or `refund.late` at `refund`, by the second the receipts carry;
  `refund.cancelled_by_customer` when the customer drops it (or a person records that they did) after
  its date was fixed, and nothing before. Paid before any date was fixed, the promise is issued with
  the payment and kept. The refund machine's `cancel` and `record_cancel` are split by whether
  anything was agreed, so only the agreed ones queue an outcome. A refund's receipts carry no `trm`:
  nothing both sides agreed has a fingerprint until settlements exist. A refund that owes nothing (the
  order was to be paid on delivery or on account) promises nothing and has no receipts, so no kept
  outcome can be had for returning what was never paid for. The customer's own `cancel` drops a
  return only while the goods are still with them (`approved`), as Amendment 4 says ("which they then
  keep"): once they are back (`goods_received`), dropping it is a person's `record_cancel`.
- **`trm`** is not §8's bare `terms_sha`, which anyone holding the receipt could test guesses against
  (which service, which products, how many, from the public catalogue): it is
  `base64url(HMAC-SHA-256(k, terms_sha))`, `k` = HMAC of `offer:<id>` under a key derived from
  `INBOX_SECRET_KEY` (`receipt-terms`), one per offer, for the business to disclose with the terms in
  a dispute. On a promise it is the offer that made it (never a change), carried only when the
  promise goes to at least one network and every one takes version 6 (C12); a business with no network
  on issues none. `k` comes from the newest `INBOX_SECRET_KEY`, as the pseudonyms do (ADR-016): a
  disclosure for a receipt signed before the key rotated derives `k` from each key in the ring until one
  matches its `trm`. Amendments and a refund's receipts name no presentation (`per`); they still carry
  the customer's pseudonym (`sub`), which a network needs to weigh repeat evidence per customer (R7),
  so a network can tell a return is theirs: what protects the customer is ADR-017's A3.5, that none of it counts.
- **Sending.** What only version 6 reads — an amendment, a refund's receipts — goes to a network whose
  rules, in force or announced, are 6 or later, and waits for the others, as claims v2 wait for
  version 3; with receipts switched off, a network still gets the amendments and outcomes of promises
  it holds. Only a receipt that names a date (claims v2) waits because its promise moved: a promise
  the business wrote down itself (claims v1) names none and goes as before. The owner's Settings →
  Networks says which rules each network takes and how many receipts wait for newer ones;
  `get_networks` says so to the owner's AI.
- **The spec** (`@surfingdog/spec`, MIT) gains exactly §8's values and claims, none renamed:
  `amended`, `typ: refund`, `trm`, `acc`, the three `refund.*` outcomes and the report
  `order.refund_refused` (rows marked `since: 6`, none on a customer's side), `parseReceiptClaims`
  with the rules a reader takes (below 6 it refuses what version 6 added and ignores `trm` and `acc`),
  `AMENDMENT_LIMITS` (moved from core: 3 unverified, 90 days), the reasons each report takes
  (`REPORT_WHYS`), and the ranking document's version 6 (version 5's, with `amendments` and
  `refunds`, rules `0.1.3`). `receipts-v6.json` pins every claim, how a rules 5 reader takes it, and
  every path through the refund machine; `receipts-v2.json` keeps the table of rules 3 to 5.
- **The refused-claim report's window** is from the order's `due` + 1 h to `due` + 730 days\* (the EU's
  minimum legal guarantee), not §8's "from the refusal to 90 days after it": a network never sees a
  refusal (C13).
- **Not here.** The network's side — reading version 6 at intake, R30 over a refund's promise, the
  new report and its window, the version 6 ranking document, the announcement and the emails to
  listed businesses (ADR-017 §11) — is the network's own work. A return whose goods a person
  disputed, and that is then never paid, becomes `promise.unclosed` nine days after its date (R30):
  the business has no way to close a disputed return but to pay it or for the customer to drop it.
  §3.4 has `dispute_goods` come "before the refund is promised", and §8 has disputed goods make no
  refund promise; as built, `goods_back` promises the refund and `dispute_goods` follows it, so a
  dispute that ends unpaid can count twice against the business: `promise.unclosed` on the refund and
  a verified `order.refund_refused` (`goods_disputed_unpaid`) on the order. Letting a person dispute
  what arrived instead of marking it received would match §3.4, but a business could then dispute
  every return to escape any date. Still to decide. Likewise, a return whose goods the business
  never marks as received has no refund promise at all, and the customer's only recourse is the report:
  the customer has no door to give proof of sending, which fixes the date in law.

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
