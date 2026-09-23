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
from each network the business uses that has verified the business's inbox: the business emails it
to them a day later, in an email of its own. A test request (`x-sandbox: 1`) asks no network. You
get their first pass in the answer:

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

## 5. Acknowledge receipts, and report only what happened

When a business issues a receipt on your item (a booking confirmed, an order accepted, and how it
ended), counter-sign it: `acknowledge_receipt` (MCP) or `POST /v1/items/{id}/receipt-ack` with
`counter_signature`. A broken promise may be reported to the network, signed, and only when it really
happened. Both count as verified evidence only when signed (step 7).

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

A business may answer a booking with another time, send a quote, or ask for a detail. The item's
status (`get_item_status`, or `GET /v1/items/{id}`) then says so: `waiting_on: "you"`, and an `offer`
with its `terms`, a `deadline` and `human`, the business's own words. Tell your person `offer.human`
as it is, in the language it is in; it names the time with its zone and the price, and says when
accepting means an obligation to pay.

- On their clear yes, call `accept_offer` (`POST /v1/items/{id}/accept`) with `terms_sha`, the
  fingerprint of the terms they said yes to. Without it nothing is booked: the answer gives you the
  terms to show them. If the business changed its proposal meanwhile, you get the new terms
  (`offer_changed`): ask again.
- Otherwise `decline_offer`, or `suggest_time` with one of the free times `check_availability` lists.
  Answer before the `deadline`: a proposed time closes at the business's minimum notice before it
  starts, and `check_availability` never lists a time inside that notice or one that has started.
- When the business asked for a detail, send it with `provide_details`.

The business may also email the person the same choice as links; whichever answer comes first
counts, and the other is told it is already done.

The item's status also carries the conversation (`thread`): what the business wrote to your person
and what they wrote, oldest first, never the business's internal notes. Relay the business's
replies as they are; one marked `automated` was not written by a person. The MCP text ends with the
business's last message when it is the latest word.
