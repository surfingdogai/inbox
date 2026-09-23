---
title: Receipts
description: The signed proof an instance issues when it makes a promise — a booking confirmed, an order accepted or paid — and when the promise closes, how an agent reads and verifies it, and how it counter-signs.
---

A **receipt** is the instance's signed statement about a transaction: this booking was confirmed, this order was paid — a **promise** — and later how it ended: the booking happened, the customer did not turn up, the order went out — an **outcome**. It is a compact JWS, Ed25519, small enough to sit in a header, and it names the customer only by a pseudonym. Both sides can hold one, a network can count one, and nobody who sees one learns an address.

Receipts are issued by the instance and counter-signed by the customer's agent. They are the ground a review will later stand on: a review is only ever accepted against a receipt, in both directions. Reviews themselves are not built yet; receipts are.

## When one is issued

Promises:

| Item | Event | Receipt `knd` |
|---|---|---|
| booking | `confirm` (by the business, including a proposed time the customer agreed to by phone) or `accept` (customer takes a proposed time) | `confirmed` |
| booking | the customer's `accept` of a quote that creates a booking: the booking is created confirmed | `confirmed` |
| order | `accept` | `accepted` |
| order | the customer's `accept` of a quote that creates an order: the order is created accepted | `accepted` |
| order | `record_payment` | `paid` |

Outcomes, `knd: "outcome"` with the code in `out` ([ADR-017](https://github.com/surfingdogai/inbox/blob/main/docs/adr/017-reputation-and-ranking.md) §3):

| Item | Event | `out` |
|---|---|---|
| booking | `complete`, by you, or by the system `booking.autoCompleteHours` (48) after the end unless it was marked a no-show | `booking.completed` |
| booking | `no_show` | `booking.no_show_customer` |
| booking | `cancel_by_business` once confirmed | `booking.cancelled_by_business` |
| booking | the customer's `cancel` within the window, or their cancellation you record (`record_cancel`) when they asked within it | `booking.cancelled_by_customer` |
| booking | the customer's cancellation after the window (`cancel_late`, or `record_cancel_late` when you record it and they asked after it), when `booking.lateCancellation` is `record` | `booking.cancelled_late_by_customer` |
| order | `fulfil` | `order.fulfilled` |
| order | your `cancel` once accepted | `order.not_fulfilled` |
| order | the customer's `cancel` once accepted, or their cancellation you record (`record_cancel`) | `order.cancelled_by_customer` |
| order | `payment_failed` | `order.payment_failed` |
| order | `charge_back`, or `record_charge_back` on a completed order | `order.charged_back` |
| order | the system's `lapse`, `orders.payDays` (14) after payment was requested and none came | `order.lapsed` |

A no-show recorded by mistake, or a completion that should have been one, can be corrected once, until the booking would have completed on its own: the later receipt is the one a network keeps. After that the correction is no longer offered. Bookings and orders promised before the upgrade that brought outcomes are left as they were: never completed or lapsed by the system, no outcome recorded, closed by you. Declines, expiries, cancellations before anything was confirmed or accepted, quotes, messages and refunds close no promise and issue no outcome.

The transition writes a job in the same batch as the event; the job signs within the second on a live instance, and `iat` is the time of the event itself. One receipt per item, kind and outcome: a job that runs twice finds the row and stops. **Sandbox items never get one.** A receipt for a rehearsal would be a signed statement that something happened when nothing did. Bookings and orders you, your staff or a rule created keep the `confirmed` and `paid` receipts they always had and record no outcome: the networks count what customers asked for.

Two settings gate it. `INBOX_SECRET_KEY` seals the private key before it is stored, so an instance without one creates no key and issues nothing rather than keep a signing key in the clear. `INBOX_PUBLIC_URL` is the `iss` claim, and a job has no request to derive it from. Without either, the job records the reason and finishes; nothing is retried, and the owner's Settings page says which one is missing.

## Reading one

The receipts are on the item, for whoever may read it: the owner through `GET /v1/owner/items/{id}` or `get_item`, the customer through `GET /v1/items/{id}` or `get_item_status` with the access token they were given at creation.

```json
{
  "receipts": [
    {
      "id": "01M34X9PAFXES35PXPY6QT944T",
      "kind": "confirmed",
      "jws": "eyJhbGciOiJFZERTQSIsInR5cCI6InNkaS1yZWNlaXB0K2p3cyIsImtpZCI6Ii4uLiJ9.eyJpc3MiOi4uLn0.…",
      "payload": {
        "iss": "https://inbox.oficinamare.pt",
        "sub": "Zm9vYmFyYmF6cXV1eGZvb2JhcmJhenF1dXhmb29iYXJiYXo",
        "itm": "01M34AVYNXTNSE2RC495H3W8QS",
        "typ": "booking",
        "knd": "confirmed",
        "iat": 1790000461,
        "nonce": "0123456789abcdef0123456789abcdef",
        "amt": { "value": 4500, "currency": "EUR" }
      },
      "issued_at": "2026-09-22T09:01:01.000Z",
      "acknowledged_at": null
    }
  ]
}
```

`payload` is the decoded content of `jws`, for readers that do not want to decode it. Trust the JWS, not the copy.

## What is inside

The header is `{"alg":"EdDSA","typ":"sdi-receipt+jws","kid":"<kid>"}`. The claim names are frozen: a receipt outlives the software that wrote it.

| Claim | Meaning |
|---|---|
| `iss` | The issuing instance: its public origin, no trailing slash. Where the keys are. |
| `sub` | Who it is about, as a pseudonym: `base64url(HMAC-SHA-256(pepper, identity))`, where the pepper is derived from the instance's secret key and never leaves it. Two receipts for one customer on one instance share it; the same customer on another instance does not. Never an address, and never a bare hash of one. |
| `itm` | The item's id on the issuing instance. |
| `typ` | The item type: `booking`, `order`. |
| `knd` | `confirmed`, `paid`, `accepted` or `outcome`. |
| `iat` | Issued at, Unix seconds: when the event that caused it happened. |
| `nonce` | 128 bits of hex. A network deduplicates on `(iss, nonce)`, so a receipt shown twice counts once. |
| `amt` | On a promise, the amount the item states, in minor units, when it states one. For a paid order it is the amount recorded as paid. Never derived, never summed. |
| `pay` | How it was paid, when the instance knows (`card`, `transfer`…). |
| `ver` | `2` on the receipts of bookings and orders a customer made (claims v2); absent on the others, which are v1. |
| `out` | On an outcome, how the promise ended: one of the codes above. |
| `ref` | On an outcome, the `nonce` of the item's earliest promise. |
| `due` | When the item is due, Unix seconds: a booking's start; an order's delivery time, else 30 days (`orders.dueDays`) after it was accepted. Every receipt of an item carries the same one. |
| `end` | A booking's end. |
| `aut` | `1` when nobody decided it: the system completed the booking, or a rule fired the transition. |
| `per` | `[{"n": "<network host>", "p": "<presentation id>"}]`: each network's presentation of the customer for this item, when their assistant presented one. Each network reads only its own entry. |

No customer name, no address, no line items. A receipt proves a transaction happened and what it was worth. It is not a copy of the order.

## Verifying one

The public keys are in two places, identical: the manifest under `receipt_keys`, and `/.well-known/jwks.json` for anything that expects a JWKS. `kid` is the RFC 7638 thumbprint of the key, so it is derivable from the key itself. A retired key stays published so an old receipt still verifies.

The verifier decides the algorithm, not the token: refuse anything whose header is not `EdDSA` and `sdi-receipt+jws`, find the key by `kid`, verify the signature over `<header>.<payload>`, then read the claims. With the MIT `@surfingdog/sdk`:

```ts
import { verifyReceipt } from "@surfingdog/sdk";

const jwks = await (await fetch(`${inbox}/.well-known/jwks.json`)).json();
const { claims, sha } = await verifyReceipt(receipt.jws, jwks, { issuer: inbox }); // throws on any mismatch
```

It throws `ReceiptVerificationError` with the code a network would answer: `malformed`, `bad_alg`, `bad_typ`, `unknown_key`, `bad_signature`, `bad_payload` (claims a network would refuse), `wrong_issuer` or `not_yet`. Fetch the keys from the inbox you dealt with, not from the `iss` inside the receipt you are checking.

## Acknowledging one

The customer's agent counter-signs to say it holds the same receipt. From then on the receipt is *acked*: both sides hold it, and a network is told so rather than asked to guess. An unacked receipt is still a receipt, only weaker evidence.

The acknowledgement is a compact JWS **by the agent's own Ed25519 key**, which travels in the header:

```
header   {"alg":"EdDSA","typ":"sdi-receipt-ack+jws","jwk":{"kty":"OKP","crv":"Ed25519","x":"…"}}
payload  {"rcp":"01M34X9PAFXES35PXPY6QT944T","sha":"<base64url(SHA-256(receipt jws))>","iat":1790000500}
```

`rcp` is the receipt's `id` from the item; `sha` is the base64url SHA-256 of the receipt's `jws` string exactly as you received it, no padding — it is what lets a network that never sees the instance's ids check that your acknowledgement is of this receipt and no other; `iat` is now, in seconds. You may add `pas`, the reference of the person's pass (`sdpass1_<network host>_<id>`, never the pass itself), so the network knows whose acknowledgement it is; anything else in `pas` is refused. Acknowledge the outcome receipts too: an acknowledged completion counts in full where an automatic one is presumed. Send it to `POST /v1/items/{id}/receipt-ack` with the access token (in the body as `access_token`, as `?access_token=`, or as `X-Access-Token`), or call the `acknowledge_receipt` tool. You may include `receipt` (the JWS) if you want the instance to confirm it is the one it holds.

With the SDK it is one call, and the key is one you keep:

```ts
import { generateAgentKey, signAck } from "@surfingdog/sdk";

const key = await generateAgentKey(); // once; store key.privateJwk
const counter_signature = await signAck({ receipt: receipt.jws, receiptId: receipt.id, key, passRef });
```

By hand, with WebCrypto alone:

```ts
const enc = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", publicKey);
const header = b64u(enc.encode(JSON.stringify({ alg: "EdDSA", typ: "sdi-receipt-ack+jws", jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x } })));
const sha = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(receipt.jws))));
const payload = b64u(enc.encode(JSON.stringify({ rcp: receipt.id, sha, iat: Math.floor(Date.now() / 1000) })));
const sig = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, enc.encode(`${header}.${payload}`));
const counter_signature = `${header}.${payload}.${b64u(new Uint8Array(sig))}`;

await fetch(`${iss}/v1/items/${itemId}/receipt-ack`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ counter_signature, access_token }),
});
```

The instance checks that the signature verifies against the key in the header, that `rcp` names a receipt on this item and `sha` is that receipt's hash, that `iat` is no more than an hour old and no more than five minutes ahead, and keeps it. The response is the receipt with `acknowledged_at` set. **The first acknowledgement is the one both sides hold**: a second one, with the same key or another, is accepted and changes nothing. Keep the private key you signed with; it is how a network will know a later review comes from the same agent.

Refusals are problem documents: `403` when the item is not yours, `404` when `rcp` is not on this item, `422` with a `reason` (`bad_signature`, `expired`, `not_yet`, `bad_alg`, `malformed`) when the acknowledgement itself is wrong.

**An agent that signs its requests** (`sdi-agent/1`, with a key the person delegated to their pass: see [the agent guide](https://surfingdog.ai/for-agents.md)) can acknowledge without a counter-signature: it sends `receipt_id` in a signed request that carries the pass reference, in `Sdi-Pass` or the `pass` field. The inbox forwards that signature to the person's network with the receipt's `sha`, and the network checks it again under the delegated key. The inbox never forwards a signature whose signed parts hold a secret — an access token in the URL, another pass in `Sdi-Pass` — and says `carries_secret` instead; send the token in `X-Access-Token`.

## Networks

The instance publishes every receipt to each network switched on in Settings → Networks — once when issued, again once acknowledged — with `POST <network>/v1/receipts` and the body `{"receipt": "<jws>", "ack": "<jws>"}` (`ack` only when there is one). The manifest names the networks an instance publishes to under `review_services`. The network answers `{"ok": true, "state": "issued" | "acknowledged", "duplicate": false}`.

Each network is kept track of on its own, receipt by receipt, so nothing is lost to one that is down: a receipt waits for a network that does not answer, or does not know the instance yet, and goes out when it does. A network switched on later is sent every receipt issued before it, oldest first, up to a thousand an hour; it counts a completion whose promise reached it more than a day late at half, so switching on early is what counts.

Which receipts a network gets depends on the rules it applies, which the instance reads once a day from its `GET /v1/ranking`: from rules version 3 — in force, or announced in `next` — it gets every receipt, acceptances and outcomes included; before that, the `confirmed` and `paid` promises it has always had, and the rest waits until it moves on. An outcome goes after its promise, and a network that stopped taking receipts in Settings still gets the outcomes of the promises it was sent. The instance tries again when the network answers `404`, `408`, `425`, `429`, a redirect or a server error, or a problem document whose `code` is `unknown_key`, `unknown_ref`, `unknown_instance` or `unknown_issuer`; any other refusal is the network's verdict on that receipt, recorded once and not sent again. Settings → Networks shows how many receipts each network has.

`per` in a receipt names the presentation a network made of the customer for that item, when their assistant presented a pass: that is how a network ties the item to its person, and each network reads only its own entry. A network that never saw the person on that item counts the receipt without one.

The network believes nothing it is sent. It finds the business by `iss`, takes the keys from the manifest it fetched from that domain itself, verifies the receipt, verifies the acknowledgement against the key in its header and the receipt's `sha`, and counts one receipt per `(issuer, nonce)`. It refuses a receipt from a domain it has not listed (`404`), one signed by a key the manifest does not publish (`422 unknown_key`, after refreshing its copy), an outcome whose `ref` it does not hold yet (`422 unknown_ref`, sent again later), a forgery (`422 bad_signature`) and one dated more than five minutes ahead (`422 not_yet`). It stores the receipt whole, with the acknowledgement when there is one: the pseudonym, the type, the kind, when, and the amount and payment method when the receipt carries them — never an address, never a name — and keeps every one. A directory listing shows how many promises a business has made and how many were counter-signed, and how they ended; the amounts are never published.

Any service that speaks this one endpoint can be a review service, and an instance can publish to several; `https://network.surfingdog.ai` is only the default.

## For implementers

`packages/spec/vectors/receipts.json` in the repository (MIT) holds fixed keys, the `sub` derivation with its inputs, two receipts whose JWS an implementation must reproduce byte for byte, a valid acknowledgement, and every refusal with the error code it must raise. `packages/spec/vectors/receipts-v2.json` does the same for claims v2: a promise and its outcome for each of the eleven outcomes, an acknowledgement with `pas`, the refused claims, and every path through the booking and order state machines with the outcome it records. A verifier in any language is right when it agrees with those files.

## As events

A receipt being issued, and being counter-signed, are events on the item like any transition: `booking.receipt_issued`, `booking.receipt_acknowledged`, `order.receipt_issued`, `order.receipt_acknowledged`. They appear in `GET /v1/owner/events` and reach your [webhooks](/docs/webhooks/) under the same subscriptions (`order.*` includes them); in the full payload style, `data.receipt` carries the receipt. The issue event's id is the receipt's id; the acknowledgement's is that id with `:ack`.

## Keys

One key per instance, generated on first use, private half sealed by `INBOX_SECRET_KEY` (AES-256-GCM) and never readable back through any door. If the secret key is changed the sealed private key can no longer be opened and the instance stops issuing until it is restored — so treat `INBOX_SECRET_KEY` as the thing it is, and add keys in front of it for rotation rather than replacing it. The pseudonym pepper comes from the same secret and cannot rotate at all without severing the link between receipts already in the world and the customers they are about. [ADR-016](https://github.com/surfingdogai/inbox/blob/main/docs/adr/016-receipts.md) has the reasoning.
