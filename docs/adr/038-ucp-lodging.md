# ADR-038 — UCP Lodging: a place to stay's instant rooms as booking sessions, off by default

**Status:** proposed, 21 October 2026. Builds on ADR-037 (stays), and takes the line ADR-037 left under
"Not decided here". Migration 0030 (`ucp_sessions`). No spec version: this is an optional binding to a
third-party draft, not part of the inbox's own spec (§7). Numbered provisionally; renumbering at merge
is fine.

## Context

The Universal Commerce Protocol has a lodging booking capability in its draft
(`dev.ucp.lodging.booking`), and some AI platforms are starting to use UCP to book. A place to stay
whose inbox can confirm a room at once could be booked through it with no work of the owner's. The
draft is marked "Draft - Work in Progress"; everything here was built from it in public, pinned at
commit `f2626c28b8288976eee5bda77f3a9b1ddc0132b1` (main, 20 October 2026; lodging came in with
`c9a1395b`, #780), without credentials, against recorded examples and a local app. Sources: the
draft's `docs/specification/lodging/booking/{index,rest}.md`, its cancellation-policy extension, and the
JSON schemas under `source/schemas/lodging` and `source/schemas/common`.

The tests' places are fictional and spread across the world: Ryokan Hoshi (Kyoto, JPY), Kijani House
(Nairobi, KES) and Maple Hollow B&B (Nova Scotia, CAD).

## Decisions

### 1. Off unless asked for, and only for rooms that confirm at once

`INBOX_UCP_LODGING` turns it on (`1`, `true`, `yes` or `on`, read as every switch of the inbox is).
Without `INBOX_SECRET_KEY` it stays off, and the server says so once on stderr. Hosted inboxes keep it
off while the protocol is a draft. When it is on, `/.well-known/ucp` and the REST booking sessions
under `/v1/ucp/lodging` answer only while the inbox has a property that confirms some rooms at once:
rooms kept for direct guests and closed elsewhere, or a connected system that confirms at once and is
written to first (ADR-037 D4).

A property that answers each stay itself is not served. UCP needs one authoritative total in every
session, and before the property answers there is only an estimate. A session for one is refused
with `on_request`, in plain words (the property confirms each stay itself, within its hours), and no
`continue_url`: no page can yet take a stay request with its dates filled in, and the business's
front page would leave the guest to start again. That page is a follow-up. A property that keeps
stays on its own booking engine sends the platform there, with the engine's deep link filled in
(`{check_in}`, `{check_out}`, `{adults}`, `{children}`, `{rooms}`) when the owner gave one.

### 2. A session is a row of its own

`ucp_sessions` keeps one row per session: the SHA-256 of its id, the stay it holds or booked, the
last request it accepted, sealed by the secret box under its own purpose (`ucp-session`), the
fingerprint of the money last shown, its language, how many holds it made, and when the platform
cancelled it if it held nothing. The id the platform holds is `bks_` and 32 random bytes; the inbox
keeps only its hash, as it does an item's access token.

- The row lives as long as its stay. Idempotency records (30 days) are not how a session finds its
  stay, so a guest who reads or cancels a stay booked months ahead is told where it stands, never
  "canceled" for want of a record. A session the inbox cannot find is `404 not_found`.
- A row that never held a room goes two days after it was made. A session holding nothing lapses
  after 24 hours, and reads as `canceled` then, which it is.
- Every answer is made from the row: the booker as the platform wrote them, every guest with the id
  the platform gave them, each stay's `guest_assignments`, and `travel_purpose`, as UCP requires. The
  guests' ids are kept only sealed in that row and in the stored answers below, never in the clear.
- Erasing a customer deletes the rows of their stays with them (`eraseStatements`), and the stored
  answers about those stays go too (they carry the stay's id).

### 3. Idempotency-Key, and whom a session's id goes back to

UCP's REST binding: with an `Idempotency-Key`, the first answer is kept (here, sealed) and returned
for the same body, and another body under the key is `409 idempotency_conflict`; a key still running is
`409 idempotency_in_progress`. Refusals are not kept, so a corrected retry with the same key runs.
Update, Complete and Cancel keep their keys within the session, and any caller holding the session's
id gets the stored answer.

A Create's answer carries the session's id, which is all it takes to read the lead's name and
address or cancel their hold. An Idempotency-Key is no secret: it is a signed component and passes
through relays. So a Create's stored answer goes back only to the key that signed the request that
made it: a verified HTTP signature's key (an agent's own, or a platform's), or an agent's API key. A
replay from anyone else, or of a Create nobody signed, is a 409 that names no session; the platform
makes a new one. The scope a Create's key is kept under is the signer when there is one, so a
platform's retry from another of its addresses finds it; otherwise the caller's fingerprint. Unlike a
create's access token in core, a platform's key counts here: the platform is the client that holds the
session for its user, and nobody else can sign with its key. A session is not bound to the key that
made it: a platform may rotate its keys over the months before a stay, and the id is a 32-byte secret
of its own.

### 4. Holds, changes, and the guest's yes

- Create and Update price the rooms (`quote_stay`). A named lead with an email or a phone holds them
  (`hold_stay`); the platform sent those details in a session with the property, which UCP's flow
  treats as the guest sending them, so the hold is made with `consent: true`.
- The hold stands while the rooms, dates and guests per room stay the same and the lead is reached
  the same way (the same email when both give one, else the same phone). Names refined or added (a
  primary guest named after the booker, a companion) are written on the held stay; nothing is let go.
  This is UCP's progressive enrichment, and a GET-then-PUT round trip changes nothing.
- Anything else is priced before anything is let go. Only when the session's own hold is what stands
  in the way of the new rooms (the last kept room, or the lead's two holds) is it released, priced
  again and held again; a change that still cannot be had holds the old rooms again. A request that
  does not fit (occupancy, dates, plan) lets nothing go. Either way the answer is the session as it
  stands, with what was refused, never a bare error.
- A session holds at most six times.
- Complete is `book_stay`. Core's `terms_confirmed` guard ties a guest's yes to the terms they were
  shown; UCP has no fingerprint for that. The platform's own interface stands in for it: it shows the
  totals, the schedule and every disclosure, and its Complete is the guest's yes. So the inbox passes
  the stay's current fingerprint itself, and in return discloses the cancellation policy
  (`dev.ucp.lodging.policy.cancellation`, at `$`) whenever cancelling can cost anything (a step with a
  fee, a fee after the last, or one for not arriving), not only when the stay is non-refundable. UCP
  obliges a platform to show a policy only when a disclosure names it.
- A hold whose time ran out reads as `canceled`, swept or not. Two Completes at once answer as the stay
  stands after; a stay that is booked carries no error from the attempt that lost.

### 5. Limits a platform meets

A Create, an Update and a Complete each spend a token of the `create` class (twenty an hour per
address, as a hold through the stays doors does), since each can hold or book a stay and tell the
owner. Core's two open holds per guest counted a platform's key as one guest, so one platform got two
holds for all its users. Now a platform's key (Web Bot Auth: a key its directory lists) is not counted
as a guest: each guest is counted by their address, and the platform on its own, ten open holds at
once per inbox. A refusal says whose limit it is: the lead's (at `$.booker`, only when the lead's own
address holds two), the assistant's, or the platform's. This applies to every stays door, not only
UCP.

### 6. The mapping

- `property`, `accommodation_type` and `rate_plan` are the property, its room types and its rate
  plans. A stay's `id` is `<room type>__<rate plan>`, and `__2`, `__3` for a second or third room
  alike, so two doubles for one family are two stays. Every stay of one session has the same dates and
  rate plan.
- `totals[]` is the quote's lines: exactly one `subtotal`, whose `lines` are the rooms with their
  nights and the extras (`kind: "extra"`), since UCP allows only one subtotal; each fee, tax and
  discount; one `total`, which the addends sum to. A charge the property collects itself carries
  `collected: "at_property"`.
- `payment.terms[0].schedules[]` is the quote's schedule (`immediate`, `deferred`, `at_property`),
  summing to the total. No payment handlers: the property takes its own payments, on its own Stripe or
  Mollie. Every deadline a guest reads says whose time it is in (the property's).
- `messages[]`: `local_tax`, a disclosure at the `at_property` schedule, naming each charge once with
  its rate, who is exempt and for how many nights; the cancellation disclosure (§4); `totals_changed`;
  `inventory_exhausted` (a place that books at once whose kept rooms are gone); `on_request` (§1);
  `occupancy_exceeded_capacity`; `lead_guest_required` while no lead is named, at `$.booker`, a member
  still to be given; `payment_required` (`requires_buyer_input`) with `continue_url` to the property's
  own payment page, or the stay's card page, when a deposit or a card is due. Guest-facing words are in
  the six stays languages and name nothing but the property; messages to the platform are in English.
- `continue_url` is given only where a page can continue the session: a payment or card page, or the
  property's own engine. No page yet continues a held room, so incomplete, ready and in-progress
  sessions carry none (UCP says SHOULD).

### 7. Versions

The draft has no dated release of its own, and 2026-08-25 (the newest dated release) does not define
lodging. Answers name `2026-08-25` and the schema links point at `https://ucp.dev/draft`, until lodging
ships in a dated release; the version moves then. In the profile, `dev.ucp.common.payment.terms` and
the cancellation policy `extend` `dev.ucp.lodging.booking`, so negotiation reads them as extensions.

No spec version of the inbox's own moves: nothing in `@surfingdog/spec` changes, the binding answers
in UCP's own schemas, and it ships off. Protocol §4.19 describes it as an optional binding to a
third-party draft. In this version a network does not read an inbox's UCP profile; it reads the inbox
through its manifest (§4.8).

## Consequences

- A property that books at once can be booked by a UCP platform with nothing set up by its owner but
  the operator's switch, and every stay it makes is an ordinary stay: in the owner's inbox, under the
  owner's rules, theirs to change or cancel.
- A phone or email the platform adds after the hold, for the same lead, is shown back to the platform
  but not written to the contact the stay was held for; the property reaches the guest by that one.
- `ucp_sessions` is one more table an erasure clears, and one more the hourly tick does not need: rows
  that held nothing go when the next session is made.

## Not decided here

- A page of the property's own that continues a held session, or takes a stay request with its dates
  filled in, for request-mode properties.
- Which platform sent a stay, shown to the owner as "via <platform>".
- UCP's MCP binding (`mcp.openrpc.json`), and payment handlers: the property takes its own payments.
- Turning it on for hosted inboxes, once lodging leaves draft.
