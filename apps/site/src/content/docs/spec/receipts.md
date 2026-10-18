---
title: Receipts
description: "The receipt format: a signed record of a promise a business made and how it ended, and the customer's agent's counter-signature. Claims version 2, with JSON Schemas and test vectors."
---

**Claims version 2**, last changed 27 September 2026. JSON Schemas: [claims v1](/spec/schemas/receipt-v1.json), [claims v2](/spec/schemas/receipt-v2.json), [acknowledgement](/spec/schemas/receipt-ack-v1.json), [acknowledgement with `pas`](/spec/schemas/receipt-ack-v2.json) · vectors: [`receipts.json`](/spec/vectors/receipts.json), [`receipts-v2.json`](/spec/vectors/receipts-v2.json), [`receipts-v6.json`](/spec/vectors/receipts-v6.json) · [check one](/spec/check/) · MIT licence.

A receipt is a compact JWS an inbox signs when it makes a promise (a booking confirmed, an order accepted or paid, a refund owed), when both sides agree to change it, and when it ends. The customer's agent counter-signs it, so both sides hold the same proof. How Surfing Dog Inbox issues them is on [Receipts](/docs/receipts/); why, in [ADR-016](https://github.com/surfingdogai/inbox/blob/main/docs/adr/016-receipts.md).

## The signature

- A compact JWS signed with Ed25519. The header is `{"alg":"EdDSA","typ":"sdi-receipt+jws","kid":"<kid>"}`.
- `kid` is the RFC 7638 thumbprint of the signing key. The key is in the issuer's [manifest](/spec/manifest/) under `receipt_keys`, and at `/.well-known/jwks.json`.
- A verifier chooses the algorithm itself. Anything but EdDSA is refused, whatever the header says.

## Claims

| Claim | Version | Must it be there | What it holds |
| --- | --- | --- | --- |
| `iss` | 1, 2 | yes | the inbox's origin; https in v2 |
| `sub` | 1, 2 | yes | the customer, as `base64url(HMAC-SHA-256(pepper, identity))`, 16 to 64 characters; never an address, never a bare hash of one |
| `itm` | 1, 2 | yes | the item's id at the inbox, 1 to 64 characters |
| `typ` | 1, 2 | yes | v1: `message`, `quote_request`, `booking`, `order` or `refund`; v2: `booking`, `order`, and `refund` (added 27 September 2026) |
| `knd` | 1, 2 | yes | v1: `confirmed` or `paid`; v2 adds `accepted`, `outcome`, and `amended` (added 27 September 2026) |
| `iat` | 1, 2 | yes | Unix seconds: when the event happened |
| `nonce` | 1, 2 | yes | 32 lowercase hex characters; a network counts `(iss, nonce)` once |
| `amt` | 1, 2 | no | `{"value", "currency"}`, value in minor units (4500 is 45.00); never below 0 in v2 |
| `pay` | 1, 2 | no | how it was paid, at most 40 characters |
| `ver` | 2 | in v2 | `2`; absent (or `1`) is v1 |
| `due` | 2 | yes | Unix seconds, at most 2^37: a booking's start, an order's delivery, a refund's pay-by date |
| `end` | 2 | no | a booking's end, never before `due`, on a booking only |
| `out` | 2 | with an outcome | how the promise ended: one of the outcomes below, of the item's own type |
| `ref` | 2 | with an outcome or an amendment | the `nonce` of the item's earliest promise |
| `trm` | 2 (27 Sep 2026) | with an amendment | the agreed terms' fingerprint, 43 base64url characters; on a promise or an amendment, never on an outcome |
| `acc` | 2 (27 Sep 2026) | with an amendment | who accepted the change: `customer` or `business`; on an amendment only |
| `aut` | 2 | no | `1` when the system did it, not a person |
| `per` | 2 | no | at most 8 `{"n": network host, "p": presentation id}` |

The outcomes an inbox signs: `booking.completed`, `booking.no_show_customer`, `booking.cancelled_by_business`, `booking.cancelled_by_customer`, `booking.cancelled_late_by_customer`, `order.fulfilled`, `order.not_fulfilled`, `order.cancelled_by_customer`, `order.payment_failed`, `order.charged_back`, `order.lapsed`, and, added 27 September 2026, `refund.honoured`, `refund.late` and `refund.cancelled_by_customer`.

A receipt never carries a name, an address or what was ordered.

## Checking one

In this order, stopping at the first that fails, with the code a network answers:

1. Three base64url parts, the first two JSON objects. Else `malformed`.
2. `alg` is `EdDSA`. Else `bad_alg`.
3. `typ` is `sdi-receipt+jws`. Else `bad_typ`.
4. `kid` names a key the issuer publishes. Else `unknown_key`.
5. The signature verifies with that key. Else `bad_signature`.
6. The claims hold to the table above. Else `bad_payload`.
7. `iat` is at most 300 seconds ahead of the clock. Else `not_yet`.

A reader expecting a given inbox also refuses another issuer (`wrong_issuer`).

## The acknowledgement

The customer's agent counter-signs a receipt with its own Ed25519 key:

```
header   {"alg":"EdDSA","typ":"sdi-receipt-ack+jws","jwk":{"kty":"OKP","crv":"Ed25519","x":"…"}}
payload  {"rcp":"<receipt id>","sha":"<base64url(SHA-256(receipt JWS))>","iat":<seconds>,"pas":"<pass reference>"}
```

- `rcp` is the receipt's id at the inbox. `sha` is the hash of the receipt's JWS exactly as received, so anyone holding both can check they belong together.
- `pas` is optional: a pass reference, `sdpass1_<network host>_<id>`, never the pass itself.
- The inbox takes one at most an hour old (`expired`) and at most 300 seconds ahead (`not_yet`). The first one it takes is the one both sides hold.

## Sending them to a network

`POST <network>/v1/receipts` with `{"receipt": "<JWS>", "ack": "<JWS>"}` (`ack` when there is one). The network answers `{"ok": true, "state": "issued" | "acknowledged", "duplicate": <bool>}`. It trusts nothing in the body: it finds the issuer by `iss`, takes the keys from the manifest it fetched itself, and verifies both.

## How it changes

Claim names never change: a receipt outlives the software that signed it. New claims and values are added. A reader ignores a claim it does not know and refuses a value it does not know. The additions of 27 September 2026 show how that works: a reader written before that day drops `trm` and `acc`, and refuses refunds and amendments (`receipts-v6.json` shows exactly what it keeps). A change that would break a reader comes with a new `ver`.

## Changelog

- **27 September 2026**: the kind `amended`, the type `refund` with its three outcomes, `trm` and `acc`.
- **23 September 2026**: claims version 2: the kinds `accepted` and `outcome`, `due`, `end`, `out`, `ref`, `aut` and `per`; an acknowledgement may name a pass (`pas`).
- **22 September 2026**: receipts: `iss`, `sub`, `itm`, `typ`, `knd`, `iat`, `nonce`, `amt` and `pay`, and an acknowledgement bound to the receipt's hash (`sha`).
