# ADR-043 — An assistant's retry, the times a business offers, and who an item waits on

**Status:** accepted, 31 October 2026. Amends ADR-018 (a customer's request for a time) and the
retry rule written in `packages/core/src/write/create.ts` after the security review of 14 October
2026. No migration, no spec version: the answers gain fields and a refusal, and nothing stored changes
shape.

## Context

On 30 October 2026 an assistant acted as a customer against the public demo, over MCP and over the
curl steps on the Try page. The happy path held. Five things did not:

1. **A retry lost its access token.** The token a create hands an anonymous caller is the only way to
   read or cancel the item, and a retry with the same idempotency key answered `replayed: true`,
   `accessTokenWithheld: true` and no token. An assistant whose first answer is lost (a timeout, a
   crash) does what the docs say, retries, and can then never read or cancel what it made. It happened
   on a request for a price and on a message.
2. **A booking at a time the business does not offer was taken.** `check_availability` listed
   Saturday 09:00 to 11:30; `create_booking` at 03:00 still produced a confirm summary and, after the
   terms, a request that landed on the owner as work.
3. **A cancel answered "this item belongs to someone else"** when its token was in the query, where
   the status read takes it and the Try page teaches it.
4. **A confirmed booking said `waiting_on: "us"`** with nothing pending.
5. **The demo said it is set up again every night**, yet showed items "8 days ago", and requests
   "waiting for the shop" for half a day beside "the shop's own rules confirm a booking when the slot
   is free"; and every slot said `available: 499`.

The token was withheld on purpose. A customer without a key is known to the inbox only by a
fingerprint of its address and user agent, which many people share (a carrier's NAT, an assistant
platform's servers) and a caller can choose. The idempotency lookup is keyed by that fingerprint, so
anyone who sends the same key and the same body from behind the same address would get the first
caller's token, and with it the item's whole thread. A guessable key (`booking-1`) must never hand one
person another's token. That guarantee stays; what changes is that a key nobody else could send now
proves the retry.

## Decision

### 1. A random idempotency key gets its access token again

A retry of a customer's create gets the access token (and the passes the first answer carried) again
when all of these hold:

- **The key is random.** It carries a version-4 UUID (any case, anywhere in the key, so `req_<uuid>`
  counts), or a run of at least 32 hexadecimal digits: 128 bits of key material. Nothing can prove a
  key was drawn at random, so what is plainly not random is refused: fewer than eight distinct digits,
  one digit eight times in a row, eight digits counting up or down, every other digit counting through
  six (`a1b2c3d4e5f6`), a short part repeated through the whole run, and the example UUIDs the manuals
  and the API tools' forms print (a model with no random-number tool often writes one of those from
  memory). Counters, dates, words and time-based UUIDs (versions 1, 6 and 7, whose digits are partly a
  clock) never qualify. `strongIdempotencyKey` in `write/idempotency.ts`. On two million keys from
  `crypto.randomUUID()`, 53 failed these checks (about one in forty thousand): such a retry is answered
  as a guessable key's is, without the token.
- **Nobody else sent the key.** A key that is in the idempotency table under another scope as well was
  not drawn at random for this request: it was copied, and others hold it. Its retry never gets the
  token. (The check reads the table by key alone, which no index covers; it runs only on a retry whose
  first answer carried a token and whose key passed the test above.)
- **The request is the same.** The stored request hash must match, as for every replay; another body
  under the key is still `422 idempotency_mismatch`, and says nothing of the first answer.
- **It is the same scope.** The key is looked up in the caller's scope (its principal, else the
  fingerprint, and the door), so another address, another user agent or another door never finds it:
  it makes an item of its own.
- **The key is still kept.** Within its 30 days (`IDEMPOTENCY_TTL_MS`), checked against when it was
  first used, not only against the hourly prune.
- **No network carried it.** A carried request's key is made of the request itself (ADR-025 §12), so
  anyone could send it again: its retry never gets the token, as before.

A retry signed by the agent's own key that made the item still gets it too (the review's rule); a
platform's key still does not.

**It is the same token, and the first stays valid.** The inbox keeps only the token's hash on the item,
and the stored first answer, which already held the token, is what a replay returns. Minting a new one
and voiding the first would break whichever copy of the first answer did arrive (a second worker of
the same assistant, a log the person can read), and would let a replay revoke a token, which a replay
must never do: it changes nothing. Handing the same token back creates no new capability; it gives the
token only to a caller who already holds the key that was sent with it.

**What stays open.** A key derived from the request (a hash of its body) passes the test and is as
guessable as the request: anyone behind the same address who sends the same request with it gets the
token back. The docs, the MCP instructions and the tools' descriptions say so, and ask for a fresh
random UUID per request, never one made from what is sent; the inbox cannot tell such a key from a
random one. The doors
that make a key of their own from what arrives (a form on the business's site, an email's
`Message-ID`) never hand an access token to whoever sent it, so their keys open nothing; a door that
did would have to mark its callers as carried.

### 2. A customer books a time the business offers

A customer's booking request (an agent's or a person's, through any door) for a time the business
does not offer is refused before the confirm step and before anything is written: `422 invalid_input`
on `payload.startTime`, with `details.reason` and `details.free_times`, the nearest free times before
or after it (at most three, up to half a day before and a week after, each with `start_time` and
`end_time`), named in the customer's language in the message too.

- `outside_hours`: outside the weekly hours, or on a day it is closed.
- `not_a_start_time`: inside the hours, but not one of the service's start times. The grid of start
  times is counted from midnight UTC, as `check_availability` has always counted it and as the slot
  claims are bucketed, so in a time zone half an hour off UTC an hourly service starts at half past the
  local hour, and a request on the local hour is told so, with the nearest start times. Counting the
  grid in local time would change how places are claimed, and is left for later.
- `time_not_free`: inside the hours, with no place free.

The free times are those `check_availability` would offer, so the minimum notice holds for them. What
does not change:

- **A time that has started** is refused as before, "That time has passed."
- **A time inside the minimum notice** that is otherwise free is taken and waits for a person
  (ADR-018).
- **A table past the covers set aside** is taken for a person to seat from the room (ADR-040 §8): only a
  time the restaurant is closed is refused.
- **Hours nobody set**: an agent is already told no booking is taken here (`refuseUnbookable`); a
  person writing on a form is still heard.
- **The business itself** (the owner, its AI, an integration key, a connector) writes down any time.
- **A retry** of a request that was taken is answered as it was, whatever the time is now.

This is ADR-018's rule for a customer's counter ("a free time the business would offer") applied to
the first request. The rules' `slot_is_free` and `within_business_hours` still matter for what the
business writes down itself. There was no setting that takes customers' requests at any time, so
there is none to keep; a business open all day sets its hours to 00:00–24:00.

### 3. `waiting_on` names who must act

`you` while the business waits for the customer (a time, a quote or changes to answer, details, a
payment, a change it asked for); `us` while the business has something to do (a request, an order to
send, a change the customer asked for, a message to answer); `null` when nobody has: closed, or a
confirmed booking or stay, a guest checked in, delivered goods, an answered message, with nothing
pending.

On a promise in force the thread counts too: when the customer wrote after the business last acted (a
reply it sent, or a move by its people, its AI, a rule or a system it connected; a rule's held-back
action and an internal note are not acts), it is `us` until the business answers. A message that came
with the request, or with the customer's own move, is part of that move, so a booking confirmed after a
request with a note waits on nobody. An answered message the customer writes on opens again, as it
always did.

### 4. An item's token the same three ways on every door

`POST /v1/items/{id}/cancel` and `POST /v1/customers/verify` take the token in the body, the query or
the `X-Access-Token` header, as the status read and every other item write already did. A customer's
request that carries no token and no party is refused `403 not_allowed` with `details.reason`
`no_access_token` and a message that says where the token goes, not "this item belongs to someone
else". The status stays 403, as it was for every such refusal. The docs and the Try page now teach the
header, since a URL ends up in logs; the query keeps working on reads and writes alike.

### 5. The demo tells the truth

- Every night the demo is set up again with the showcase's week of examples, dated as if they came in
  over the past week. The live view and its JSON mark each one `example: true` (it came in before the
  shop was seeded: the business row is dated `SHOWCASE_HISTORY_MS` before the seed) and show "example"
  in place of a time.
- A request that waits for the shop says why (`why`), from its kind, its price, its clock and whether
  it is a test, never from anything a person wrote and never from the spam screen, whose verdict the
  sender never sees (ADR-041): a test the rules leave alone, asked for inside the notice, larger than
  the rules confirm on their own, outside what the rules confirm or accept, a person prices every
  quote, a person answers messages from assistants. A request in its first minute says nothing: the
  rules are still reading it. The fine print says what the rules do as the appointments preset reads:
  a small booking in a free slot inside the opening hours, with the shop's notice.
- The week of examples shows only what the doors still take: the after-hours booking among them is one
  the shop wrote down from a phone call, since a customer's request for that time is now refused.
- Every service takes six bikes at once (`DEMO_CAPACITY`), a number a workshop would say. A crowd that
  fills a time is told the nearest free ones (§2) and books those. The Try page's curl asks for the
  free times from the coming Saturday and books the first, so it works however many came before.

## Consequences

- An assistant that sends a random UUID as its idempotency key never loses an item to a lost answer.
  One that sends `booking-1` is told, on MCP in words, to use a random key next time.
- Requests for times nobody opened no longer reach the owner; tests that booked such times were moved
  to times the business offers, or written down by the business where a rule's reading of the hours was
  the point.
- The demo fills as a workshop does: about a dozen full services take Saturday morning, and the
  assistants after them are offered the nearest free times instead.
