---
title: Concepts
description: Typed items and their states, rules, agent policy and trust tiers, receipts and two-sided reviews.
---

## A typed inbox

Everything that arrives becomes an **item** of one of five types: `message`, `quote_request`, `booking`, `order` or `refund`. An item has a typed payload (field names follow schema.org where they fit: `reservationFor`, `orderedItem`, `totalPrice`), a state, a version number, the party it belongs to, the channel it came through, and three flags: `needsHuman`, `priority` (0 to 3) and `sandbox`.

Each type has a state machine, defined as data. A transition names the event, who may fire it (customers, the owner and staff, the owner's AI, a rule, a connector, the system), the states it applies from, the state it leads to, optional guards, and the effects it triggers.

| Type | States |
| --- | --- |
| booking | requested, needs_info, proposed, confirmed, completed, no_show, cancelled_by_customer, cancelled_by_business, declined, expired |
| order | received, needs_info, accepted, awaiting_payment, paid, fulfilling, fulfilled, completed, declined, cancelled |
| quote_request | received, needs_info, quoted, accepted, declined, expired |
| message | open, answered, closed, spam |
| refund | requested, approved, rejected, refunded |

A booking, for example, moves from `requested` to `confirmed` when the owner fires `confirm` (guard: the slot is still free; effects: claim the slot, issue a receipt, notify the customer), or to `proposed` when the owner fires `propose` with another time, which the customer then `accept`s. Whoever reads an item is told which events it accepts right now, so the valid next actions are never a guess: for the owner they become the primary buttons, for an agent they are listed in the item view.

## Events, versions, idempotency

Every transition is an event with an actor, a timestamp, a reason and a diff, appended to the item's history. The event sequence number doubles as the version: a write that carries `expected_version` fails with `version_conflict` if someone else moved the item first.

Every mutation from an agent or an API client carries an **idempotency key**. The same key with the same request returns the same answer and creates nothing new; the same key with a different request is refused with `idempotency_mismatch`. Correctness lives in the database: unique constraints, idempotency rows and slot claims are written in one batch, so races are settled by SQLite rather than by application code.

## Rules

Rules are plain JSON, evaluated deterministically after each committed event. A rule has triggers (`item.created`, `item.transitioned`, `item.transitioned:<event>`, `thread.inbound`), a condition and actions.

Conditions combine `all`, `any` and `not` with comparisons on paths in the item (`eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`, `nin`, `contains`, `startsWith`, `exists`, `empty`, `between`) and a few named checks: `slot_is_free`, `within_business_hours`, `party_verified`, `text_has_keywords`, `is_sandbox`. Actions are `transition`, `set_flags`, `reply` (to the customer, or an internal note), `enqueue` a job, or `stop`.

Nothing in a condition does I/O; everything a rule may read is fetched into a frozen context first. Limits keep rules honest: at most 20 rules per event, a chain depth of 3, and a per-rule cap on runs per item.

Presets exist for three verticals. Appointments: auto-confirm bookings under a limit when the slot is free and inside opening hours, ask a person about everything else. Trades: quotes always need a person, urgent words raise priority. Shop: accept small orders, flag large ones for approval.

## Agent policy and trust tiers

Every request is resolved into a **caller** with an actor, a channel and a trust tier. The tiers are:

- `anonymous`: nobody proved anything. Allowed to send messages and to request quotes, bookings and orders. On creation the caller receives an `access_token`, a capability secret that is the only way to read or cancel that item later.
- `signed_agent`: the request carried a verified signature (RFC 9421 style; Web Bot Auth and Visa TAP tags). the next release.
- `verified_principal`: the caller holds an API key issued by the instance, an OAuth token, or a session; email that arrived through a path that verified DKIM and SPF is treated the same way.
- `reputed_principal`: a verified principal with a track record on a network. a later release.

The manifest publishes which tiers an instance accepts. Defaults that stand unless the owner changes them: anonymous callers may send messages and request quotes; bookings and orders will require a signed agent or a deposit once those arrive.

**Test mode**. An instance in test mode marks every item as `sandbox`. Any caller can also ask for a sandbox item with the `x-sandbox: 1` header or by calling a `sandbox.` hostname. Sandbox items go through the same machines but never trigger real notifications.

## Networks

An instance may join a network from settings: `network.url` is the directory it reports to (default `https://network.surfingdog.ai`; any directory that implements `POST /v1/instances` and `POST /v1/instances/{domain}/ping` works) and `network.join` is the switch, off by default. When on, the instance registers its domain once, which the network verifies by fetching the manifest and checking that `instance` is the https origin it was told, and then sends every hour its software version, its runtime and the number of bookings, orders, quotes and messages created in the last 24 hours. Nothing about customers leaves the instance. The numbers on the front page of surfingdog.ai are the sum of those pings.

## Receipts and two-sided reviews

When an item reaches a state that matters (`confirmed` for a booking, `paid` for an order) the instance issues a **receipt**: a compact JWS signed with the instance's Ed25519 key, which the manifest publishes in `receipt_keys`. The customer's agent counter-signs it with `acknowledge_receipt`. Both sides then hold a small, verifiable proof that this transaction happened between these two parties. Receipt issuing and counter-signing are the next release; the endpoints already exist and answer `501` until then.

Reviews live on a network, not on the instance, and a review is only valid against a co-signed receipt, in both directions. The customer reviews the business; the business records an outcome for the customer (completed, no-show, refund), as a code rather than a star rating. Both are sealed on submission and revealed together after a window, so neither side writes in reaction to the other. Reputation lookups return decayed counts per outcome and stay advisory: no pass/fail, no automated declines. a later release, and [ADR-012](https://github.com/surfingdogai/inbox/blob/main/docs/adr/012-reputation-and-reviews-law.md) explains the legal reasoning.
