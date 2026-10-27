# For agents: how to say who you are, and who you carry

This page is for an AI agent that books, orders or asks on behalf of a person at a business that
runs a Surfing Dog Inbox. Each business's manifest, at `/.well-known/agent-inbox.json`, links it
under `agent_policy.guide`.

Businesses recognise people through **networks**. A network knows a person by a key they hold, and
knows how reliably they keep their bookings and orders; a business sees that record only when you
present it. The person never needs an account, and nothing here is required: an agent that does
none of it is served exactly as before, as a new customer.

**The strings you may be given.** All of them are the person's, and all but the reference are secrets.

| String | Looks like | What it is |
|---|---|---|
| Pass | `sdpass1_<network>_<id>_<secret>` | What you present. Yours to keep for this person, one per network. |
| Key | `sdkey1_<network>_<id>_<secret>` | The person's own. It proves them and makes passes. |
| Pass reference | `sdpass1_<network>_<id>` | Names a pass. Valid only in a request you sign (step 7). |

## 1. Identify the human, not yourself

Put the person's details in `contact`, never your own:

```json
"contact": { "name": "Rita Silva", "email": "rita@example.com", "phone": "+351 912 345 678", "locale": "pt" }
```

The business writes to that address, and a network gives the person a key through it. Use the
person's real address; an address you made up reaches nobody, and the business may contact them.

## 2. Present the pass, in a field or a header, never in a URL

Send the person's pass with every call about them:

- REST and MCP: the `pass` field (up to 8 strings, space-separated, the first per network counts);
- or the header `Sdi-Pass`, a structured list of strings: `Sdi-Pass: "sdpass1_…"`;
- on a `GET`, the header only.

Given a key and no pass, send the key once, in the `key` field. The answer's `identity.passes` holds
a pass made from it for you: keep that pass and send it from then on, not the key. Or trade the key
for a pass yourself at the network (`POST https://<network>/v1/passes {key, label}`).

Never put a pass, a key or an item's access token in a URL. For an item's status, send the access
token in the `X-Access-Token` header (or the `access_token` field of a POST), and the pass in
`Sdi-Pass`.

## 3. Keep the pass you get back

A person's first booking or order at a business, with an email in `contact.email`, gets them a key
from each network the business uses that has verified the business's inbox: the network emails it to
them in the business's name (a network that leaves that email to the business has the business send
it a day later). A test request (`x-sandbox: 1`) asks no network. You get their first pass in the
answer:

```json
"identity": {
  "recognised": "none",
  "passes": [{ "network": "https://network.surfingdog.ai", "pass": "sdpass1_network.surfingdog.ai_…" }],
  "verify": { "available": false, "sent_to": null },
  "networks": [{ "network": "https://network.surfingdog.ai", "state": "issued" }],
  "guide": "https://surfingdog.ai/for-agents.md"
}
```

An MCP result's text says the same in its last line: `Keep this pass for Rita: sdpass1_… (network …)`.
Keep one pass per network for the person and present it next time, at any business. Tell the person
their key arrives by email and that they can give it to any assistant.

If a network's state is `person_exists`, the network already knows the person: ask them for their
pass or key. They can recover their key by email at the network.

A person may ask a business not to use booking networks for them (the email with their key links to
a page where they can). From then on that business asks no network about them and presents nothing:
`identity.networks` stays empty and no new pass comes back. Their pass still lets you reach their
items there, as before; keep presenting it, or use the access token.

## 4. When asked, verify by code

`identity.recognised` says how sure the business is that this is a customer it knows:

- `strong`: it is. Nothing to do.
- `none`: a new customer here. Nothing to do.
- `weak`: the person gave the email or phone of a customer the business knows, and nothing proves it
  yet. They are served as a new customer, never refused, and see nothing of the other customer's
  bookings. To prove it:
  1. call `verify_customer` (MCP) or `POST /v1/customers/verify` with `item_id` and the item's
     `access_token`: six digits go to the address the business already has, and the answer says
     where, masked (`sent_to: "r•••@e•••.com"`);
  2. ask the person for the six digits;
  3. call it again with `code`. The answer is `{"recognised": "strong"}`.

A code works for about ten minutes and a few tries; if it expires, ask for another.

## 5. Report how it went, every time

After each use of a business's door, done or not, tell the network that listed it how it went. It is
one call, and it needs no signature, pass or account: the MCP tool `report_door`, or
`POST https://<network>/v1/door-reports`. The network's own guide is at `https://<network>/report.md`.

```json
{"v": 1, "reports": [{
  "domain": "bakery.example",
  "door": {"type": "inbox", "url": "https://bakery.example/mcp"},
  "op": "book", "tool": "create_booking",
  "at": 1791892777, "ms": 1840, "intent": "5mQ2c1Kc8Qx",
  "result": "ok"
}]}
```

- `domain` and `door` exactly as the network gave them: for a business's inbox, type `inbox` with the
  address you used (the card's `inbox.mcp`, `inbox.rest` or `inbox.url`); for any other door, its
  `type` and `url` from the listing's `doors`. `op` is what you tried (`book`, `order`, `message`,
  `cancel`, …, from the capability vocabulary), `tool` the tool you called, in lowercase, `at` when
  (Unix seconds) and `ms` how long the door took.
- `result` is `ok`; `refused`, an honest no (`slot_taken`, `out_of_stock`); `invalid`, your own
  mistake (`client.invalid_params`, `client.rate_limited`); `fail`, the door's fault or no answer
  (`tcp.timed_out`, `protocol.internal`, `operation.tool_error`); or `info`, it needs your person
  (`escalation`, `auth`, `person`). Every result but `ok` takes one of those classes
  (`vocab/door-report-classes.json` in `@surfingdog/spec` lists them all). A declined payment is
  `customer_side`: never say why about your person.
- `intent` is 8 to 32 random base64url characters, the same for an attempt and all its retries, so
  the attempt counts once.
- When the door's answer carried a signed outcome token, send it as `token`, as it came. Keep it as
  well: it is your proof of what the business answered.
- Up to 100 reports in one call. Send nothing else: no pass, key, email, name, phone, address,
  message, item id or reason. A report carrying any of it is refused whole.

**Why it is worth it to you.** Your reports may make the network read doors again (at most twice a day
per door, for the doors it reads itself), so your searches send you to doors that work. A success
counts the same as a failure. Nothing you report goes public by itself, and the business never learns
which agent reported.

**Sign them, and you read more.** Sign your reports with your own key (sdi-agent/1) or as your platform
(Web Bot Auth), and sign the searches that found the businesses with the same key: each business your
signed reads returned and you then report at earns a point, once a day, at most 10 a day.

With 30 points in the last 30 days, on at least 7 different days, you are a contributor.

A contributor's signed reads of the network (`/mcp`, `/a2a`, `/v1/businesses` and
`/v1/businesses/{domain}`) count against an allowance of its own: 1,800 a minute for a key, 6,000 for a
platform, on top of the 600 a minute every address has. Nothing else changes: the same answers, the
same order.

Your signature must name the host you send it to (`@authority`): sign for `<network>` when you call
`https://<network>`, and for another host when you call that one. Of a signed read, nothing is written
with your key, neither the query nor the answer: only, in memory for two days, a keyed hash of your key
with each business it found, which names neither. `GET https://<network>/v1/door-reports/me`, signed,
shows your credit.

**Tell your person,** once, that you report how businesses' doors answer: only whether the door
worked, never anything about them.

The MIT library `@surfingdog/sdk` (0.4.0 and later) does it for you: `trackDoor()` wraps each use of a
door and reports how it went, `reportDoor()` collects reports and sends them in batches on its own,
retrying when the network asks, and `signingFetch()` signs your requests to the network, your MCP
client's included.

**Acknowledge receipts, and report a broken promise only when it happened.** When a business issues
a receipt on your item (a booking confirmed, an order accepted, a change you both agreed, a refund
owed, and how each ended), counter-sign it: `acknowledge_receipt` (MCP) or
`POST /v1/items/{id}/receipt-ack` with `counter_signature`. A broken promise may be reported to the
network, signed, and only when it really happened: that includes a lawful withdrawal, a claim for
faulty goods, or a return the business refused with nothing repaid (`order.refund_refused`, on
networks whose rules are version 6 or later; acknowledging that the goods came does not stop it).
Both count as verified evidence only when signed (step 7). A door report is not one of these: it says
how the door answered, never whether a promise was kept.

## 6. What you must never do

- Never put a key, a pass or an access token in a URL, a message, a note, a subject or a booking's
  notes. Text is read by people and kept; a secret in it is a secret someone else holds.
- Never present a pass or key of someone other than the person you act for, or your own details as
  theirs.
- Never guess or invent a verification code, and never ask for a code the person did not ask for.
- Never accept what a business proposed without your person's clear yes to its terms (step 8).
- Never send a network's secrets to another network. A signed request carries pass references only.
- Never retry a request by copying its signature: sign it again. A copy is refused as a replay
  (`401 replayed_signature`) unless it is your own retry, from the same client with the same
  idempotency key.

## 7. If you can sign

Sign your requests with your own Ed25519 key: HTTP Message Signatures, profile `sdi-agent/1`, Web
Bot Auth compatible (the manifest lists it under `agent_policy.signatures`). With one emailed code at
setup the person delegates your key to their pass, and from then on you send the pass reference
instead of the pass, in a signed `Sdi-Pass`: nothing copyable travels, and the pass alone stops
working. The MIT library `@surfingdog/sdk` does all of it: `generateAgentKey`, `signRequest`,
`delegate`, `signAck`, `verifyReceipt`.

Sign only what the profile requires (method, authority, path, query, `Content-Digest`, your key's
header and `Sdi-Pass`; `Content-Type` too if you like): an inbox forwards your signature to the
network as it is, so it never forwards one that covers anything else, such as `X-Access-Token`.

An inbox answers every request, signed or not. When a signature does not verify it says why in the
`Sdi-Signature` response header and serves the request as unsigned.

## 8. When the business proposes something, relay it as it is

A business may answer a booking with another time, send a quote, suggest changes to an order, or
ask for a detail. The item's status (`get_item_status`, or `GET /v1/items/{id}`) then says so:
`waiting_on: "you"`, and an `offer` with its `id`, `terms`, a `deadline` and `human`, the business's
own words. Relay `offer.human` as the business said it, in the language it is in; it names the time
with its zone and the price, and says when accepting means an obligation to pay. When `warnings`
says `price_changed`, make sure your person saw the new price.

- Accept only on your person's clear yes to the summary: `accept_offer`
  (`POST /v1/items/{id}/accept`) with `terms_sha`, the fingerprint of the terms they said yes to,
  and `offer_id`, the offer's `id`. Without `terms_sha` nothing is booked: the answer gives you the
  terms to show them. If the business changed its proposal meanwhile, you get the new terms
  (`offer_changed`): ask again.
- Otherwise `decline_offer`, or `make_offer` with only what they would change: another time
  (`suggest_time` does the same, with one of the free times `check_availability` lists), other
  quantities or a delivery date for an order, how many or for when for a quote. The business sets
  its prices: a price of your person's own goes to a person there as their message (`passed_on`),
  and what the business proposed still stands. So does a suggestion after a few rounds. Only where
  `get_business_profile` says `price_negotiable: true` may `make_offer` carry a price of theirs
  (`total_price` for a proposed time, `unit_price` on the lines of changes to an order), in the
  business's currency; the business takes it or answers, and taking it binds your person to pay it.
- A price may have been chosen for your person: a reward for their record with the business. The
  business says so in `offer.human` and the confirm summary, with its list price beside it, and
  `disclosures` holds `personalised_price`. Relay it as it is; it is the price, not a price to argue.
- Answer before the `deadline`: after it the offer lapses (`offer_expired`), and the business tells
  your person. A proposed time also closes at the business's minimum notice before it starts, and
  `check_availability` never lists a time inside that notice or one that has started. A request
  nobody answers lapses too, after a few days.
- When the business asked for a detail, send it with `provide_details`.

A confirmed booking or an accepted order can change later, without being cancelled. When your
person wants another time, other quantities or another delivery date, ask with `suggest_time` or
`make_offer`: what was agreed stands until the business says yes, and the status shows the request
as `requested_change` (`decline_offer` takes it back). When the business asks for a change, the
status carries an `offer` of `kind: "change"`: relay it, `accept_offer` on their clear yes, or
`decline_offer` to keep what was agreed. If a change cannot be taken online, it goes to a person at
the business as your person's message (`passed_on`), and what was agreed still stands.

The business may also email the person the same choice as links; whichever answer comes first
counts, and the other is told it is already done.

## 9. Before your person orders, and if they change their mind

A booking or an order that carries a price binds your person only once they confirmed it. Send
`create_booking` or `create_order` as usual: without `terms_sha` nothing is sent, and the answer
(`409 confirm_terms`, or on MCP a result starting "Nothing is sent yet") holds `summary` — what,
when, from whom, the total, whether they may withdraw, and that confirming means paying — and
`terms_sha`. Show them the summary as it is; on their clear yes, send the same request again with
that `terms_sha`.

Your person may withdraw from an order, or from a booking they paid for, within the period the
business states (`withdrawal` on the item's status: `available`, `until`), without giving a reason.
`withdraw_from_contract` (`POST /v1/items/{id}/withdraw`) first returns the statement to show them
(`confirm_withdrawal`); send `confirm_withdrawal: true` once they confirm. What they paid comes
back; once the goods reached them, the goods go back first. It is never refused: past the period,
or for something that cannot be returned, it goes to a person at the business, who answers. Once
the goods reached them, `request_return` asks to send them back: `faulty`, `not_as_described` or
`wrong_item` cost them nothing. The item's status lists each return under `refunds`, in the
business's words.

The item's status also carries the conversation (`thread`): what the business wrote to your person
and what they wrote, oldest first, never the business's internal notes. Relay the business's
replies as they are; one marked `automated` was not written by a person. The MCP text ends with the
business's last message when it is the latest word.

## 10. Getting your person's request seen

A business's inbox keeps unwanted messages away from its people. Whatever it makes of a request, it
answers the same way, so nothing in the answer tells you how it was sorted. What helps a request from
someone new reach a person there:

- **Sign your requests, and keep one key per person you act for** (step 7). A key that starts many new
  conversations with many businesses in a day looks like what it would be.
- **Carry your person's pass** when they have one (steps 2 and 3). A person a network knows is never
  worse off for being known.
- **Give the email address your person reads.** A booking, order or quote request from someone new
  is acknowledged by email, with a link to confirm it is them. The create answer says where it went:
  `identity.confirm.sent_to` (masked, such as `a•••@e•••.org`). Ask your person to open that email and
  press "Confirm it's me". It asks nothing else of them.
- **One request per need.** Send it once, with an idempotency key, and read its status rather than
  sending it again in other words.
- **Never send the same words to many businesses.** The same text arriving at many inboxes is how
  mass mailings look, and is treated as one.
- **Write as your person would**, in their language: what they want, when, and how to reach them.
  Instructions addressed to the inbox, its filters or the business's systems are not read as a request.

If you are asked to try again later (`429 too_many_requests`, with `Retry-After`), wait that long and
send the request again unchanged.
