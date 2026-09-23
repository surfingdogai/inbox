---
title: Concepts
description: Typed items and their states, rules, agent policy and trust tiers, networks, the people they recognise, and receipts.
---

## A typed inbox

Everything that arrives becomes an **item** of one of five types: `message`, `quote_request`, `booking`, `order` or `refund`. An item has a typed payload (field names follow schema.org where they fit: `reservationFor`, `orderedItem`, `totalPrice`), a state, a version number, the party it belongs to, the channel it came through, and three flags: `needsHuman`, `priority` (0 to 3) and `sandbox`.

Each type has a state machine, defined as data. A transition names the event, who may fire it (customers, the owner and staff, the owner's AI, a rule, a connector, the system), the states it applies from, the state it leads to, optional guards, and the effects it triggers.

| Type | States |
| --- | --- |
| booking | requested, needs_info, proposed, confirmed, completed, no_show, cancelled_by_customer, cancelled_by_business, declined, expired |
| order | received, needs_info, accepted, awaiting_payment, payment_failed, paid, fulfilling, fulfilled, completed, declined, cancelled, charged_back |
| quote_request | received, needs_info, quoted, accepted, declined, expired |
| message | open, answered, closed, spam |
| refund | requested, approved, rejected, refunded |

A booking, for example, moves from `requested` to `confirmed` when the owner fires `confirm` (guard: the slot is still free; effects: claim the slot, issue a receipt, notify the customer), or to `proposed` when the owner fires `propose` with another time, which the customer then `accept`s. Whoever reads an item is told which events it accepts right now, so the valid next actions are never a guess: for the owner they become the primary buttons, for an agent they are listed in the item view.

A confirmed booking and an accepted order are **promises**, and every way out of one records how it ended as a signed receipt: completed, a no-show, cancelled by either side, fulfilled, not fulfilled, a failed payment, a charge-back. Some of it happens because time passed: a confirmed booking counts as completed 48 hours after it ended unless it was marked a no-show (`booking.autoCompleteHours`), and an order whose payment never came lapses 14 days after it was requested (`orders.payDays`), which closes it for the networks and leaves it open for you. A customer who cancels after your cancellation window is recorded as cancelling late, or refused, as `booking.lateCancellation` says. [Receipts](/docs/receipts/) has the full list.

## Events, versions, idempotency

Every transition is an event with an actor, a timestamp, a reason and a diff, appended to the item's history. The event sequence number doubles as the version: a write that carries `expected_version` fails with `version_conflict` if someone else moved the item first.

Every mutation from an agent or an API client carries an **idempotency key**. The same key with the same request returns the same answer and creates nothing new; the same key with a different request is refused with `idempotency_mismatch`. Correctness lives in the database: unique constraints, idempotency rows and slot claims are written in one batch, so races are settled by SQLite rather than by application code.

## Rules

Rules are plain JSON, evaluated deterministically after each committed event. A rule has triggers (`item.created`, `item.transitioned`, `item.transitioned:<event>`, `thread.inbound`), a condition and actions.

Conditions combine `all`, `any` and `not` with comparisons on paths in the item (`eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`, `nin`, `contains`, `startsWith`, `exists`, `empty`, `between`) and a few named checks: `slot_is_free`, `within_business_hours`, `party_verified`, `text_has_keywords`, `is_sandbox`. Actions are `transition`, `set_flags`, `reply` (to the customer, or an internal note), `enqueue` a job, or `stop`.

A rule can also read who is asking: `person` (the best `tier` and `score` across the networks that presented the customer, each network's own, and `limit_minor`, 40000 for a trusted person), `customer` (`match` — `strong`, `weak` or `none` — and your own history with them: `completed`, `paid`, `no_shows`, `late_cancellations`, `payment_failed`, `charged_back`, `largest_paid`, `open_bookings`, `first_seen`) and `agent` (`level`: `vouched`, `self` or `none`, and `platform`), with the checks `person_trusted`, `person_tier_on {network, min}`, `customer_known` (a customer you know with a completed visit or order) and `within_customer_limit` (within twice their largest paid order, or a trusted person's limit). **Positive only**: a rule that reads any of these, or `party_verified` or the trust tier, may speed things up or ask a person — confirm, accept, ask for payment, flag, reply — and never decline, cancel, expire, mark a no-show or queue a job. Saving one that would is refused with `positive_only`; an older one has those actions skipped, and the rule's run, the item's timeline and "Try it" say so in plain words. `agent.level` is `vouched` only for a platform a network you report to recognises; any other signed agent is `self`.

Nothing in a condition does I/O; everything a rule may read is fetched into a frozen context first. Limits keep rules honest: at most 20 rules per event, a chain depth of 3, and a per-rule cap on runs per item.

Presets exist for three verticals. Appointments: confirm at once a customer you know (two completed, no no-show) or a trusted one (at most two open bookings, up to 200.00), otherwise auto-confirm bookings under a limit when the slot is free and inside opening hours, and ask a person about everything else. Trades: quotes always need a person, urgent words raise priority, trusted customers and customers you know go first. Shop: accept at once an order within a customer's limit, accept small orders and ask a new customer to pay, flag large ones for approval. All three offer a one-time code to someone who gives a known customer's address and asks about earlier items. A new customer's booking is never refused: it waits for a person.

## Agent policy and trust tiers

Every request is resolved into a **caller** with an actor, a channel and a trust tier. The tiers are:

- `anonymous`: nobody proved anything. Allowed to send messages and to request quotes, bookings and orders. On creation the caller receives an `access_token`, a capability secret that is the only way to read or cancel that item later.
- `signed_agent`: the request carried a verified HTTP Message Signature (`sdi-agent/1`: the agent's own Ed25519 key, or a platform's key under Web Bot Auth). A signature that does not verify counts as none, and the answer says why in `Sdi-Signature`.
- `verified_principal`: the caller holds an API key issued by the instance, an OAuth token, or a session; email that arrived through a path that verified DKIM and SPF is treated the same way.
- `reputed_principal`: an agent a platform vouches for, carrying a person a network trusts.

**People and customers you already know.** An agent may carry its person's pass (`sdpass1_…`), issued by a network; the inbox presents it to that network, which says how that person keeps their promises, and a person the business has met before is recognised as the same customer. A first booking or order with an email and nothing carried gets the customer a key from each network switched on, emailed to them, and the agent their first pass. Someone who only gives the address of a customer you know is a **weak** match: their item stays on its own, you see "may be Ana Silva, unconfirmed", and a one-time code sent to the known address makes them the same customer. The agent's side of all this is [the agent guide](https://surfingdog.ai/for-agents.md).

The manifest publishes which tiers an instance serves. A tier or a record only ever speeds things up: nobody is refused for being unknown or unsigned, and a new customer's booking waits for a person's confirmation.

**Test mode**. An instance in test mode marks every item as `sandbox`. Any caller can also ask for a sandbox item with the `x-sandbox: 1` header or by calling a `sandbox.` hostname. Sandbox items go through the same machines but never trigger real notifications.

## Networks

An instance can report to several networks, and each one lists it in its own directory. They are the `networks` setting, a map keyed by each network's https origin: `{"networks": {"https://network.surfingdog.ai": {"enabled": true}}}`. Settings are merged, never replaced, so adding one network leaves the others as they are, and switching one off is `"enabled": false` (it stays in the list, and anything it missed is sent when it is switched on again). At most eight. Each entry can limit what that network gets, with `share: {"counts": false}` or `share: {"receipts": false}`, and whether it gives first-time customers a key, with `issue: false`; everything is on by default. A fresh instance lists `https://network.surfingdog.ai`, switched off. Any service that implements the [network protocol](https://github.com/surfingdogai/inbox/blob/main/docs/protocol/network.md) works.

For each network that is on, the instance registers its domain, which the network verifies by fetching the manifest (until it has, the instance asks again at most once a day); then every hour it sends its software version, its runtime and the number of bookings, orders, quotes and messages created in the last 24 hours, and it publishes every receipt it issues (below), which names the customer only by a pseudonym. With `INBOX_SECRET_KEY` set the hourly ping is signed, and the network answers it with the business's own **standing** there — its tier and score — which Settings → Networks shows. Each network is called on its own, so one that is slow or down never holds up another. An older document's `network: {url, join}` is read as one entry of this map. The numbers on the front page of surfingdog.ai are the sum of the pings `network.surfingdog.ai` receives.

A network also keeps a record for **people**. A customer's assistant presents their pass; the network that issued it answers with how that person keeps their bookings and orders (`new`, `building` or `trusted`, what they kept and broke, since when), and the owner sees it on the item, one line per network, only for people whose assistant presented a pass. A customer's first booking or order with an email, from an assistant carrying nothing, gets them a key from each network with `issue` on: the instance sends that network the email address, the network keeps only a keyed hash of it, and the instance emails the key to the customer. The [privacy page](https://surfingdog.ai/privacy) lists everything that crosses.

## Receipts

When a booking or an order becomes a promise (a booking confirmed, an order accepted or paid) the instance issues a **receipt**: a compact JWS signed with the instance's Ed25519 key, which the manifest publishes in `receipt_keys` and `/.well-known/jwks.json` serves as a plain JWKS. When the promise closes it issues another, the **outcome**: completed, a no-show, cancelled by either side, fulfilled, and so on. The receipts are on the item for whoever may read it, and the customer's agent counter-signs them with `acknowledge_receipt`. Both sides then hold a small, verifiable proof that this transaction happened between these two parties and how it ended, without either holding the other's address: the receipt names the customer by a pseudonym only this instance can produce. A network counts a promise when it closes, kept or broken, for the business and for the customer, and weighs what a verified agent counter-signed above what the business says alone. The format and the rules are on the [Receipts](/docs/receipts/) page; how a network scores and orders is its published rules (`GET /v1/ranking` on the network; for ours, [the network page](https://surfingdog.ai/network)).

Reviews are not built yet. When they come, a review will only be valid against a co-signed receipt, in both directions, and [ADR-012](https://github.com/surfingdogai/inbox/blob/main/docs/adr/012-reputation-and-reviews-law.md) explains the legal reasoning.
