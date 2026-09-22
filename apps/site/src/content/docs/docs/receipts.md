---
title: Receipts
description: The signed proof an instance issues when a booking is confirmed or an order is paid, how an agent reads and verifies it, and how it counter-signs.
---

A **receipt** is the instance's signed statement that a transaction happened: this booking was confirmed, this order was paid. It is a compact JWS, Ed25519, small enough to sit in a header, and it names the customer only by a pseudonym. Both sides can hold one, a network can count one, and nobody who sees one learns an address.

Receipts are issued by the instance and counter-signed by the customer's agent. They are the ground a review will later stand on: a review is only ever accepted against a receipt, in both directions. Reviews themselves are not built yet; receipts are.

## When one is issued

| Item | Event | Receipt `knd` |
|---|---|---|
| booking | `confirm` (by the business) or `accept` (customer takes a proposed time) | `confirmed` |
| order | `record_payment` | `paid` |

The transition writes a job in the same batch as the event; the job signs within the second on a live instance. One receipt per item and kind: a job that runs twice finds the row and stops. **Sandbox items never get one.** A receipt for a rehearsal would be a signed statement that something happened when nothing did.

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
| `knd` | `confirmed` or `paid`. |
| `iat` | Issued at, Unix seconds. |
| `nonce` | 128 bits of hex. A network deduplicates on `(iss, nonce)`, so a receipt shown twice counts once. |
| `amt` | The amount the item states, in minor units, when it states one. For a paid order it is the amount recorded as paid. Never derived, never summed. |
| `pay` | How it was paid, when the instance knows (`card`, `transfer`…). |

No customer name, no address, no line items. A receipt proves a transaction happened and what it was worth. It is not a copy of the order.

## Verifying one

The public keys are in two places, identical: the manifest under `receipt_keys`, and `/.well-known/jwks.json` for anything that expects a JWKS. `kid` is the RFC 7638 thumbprint of the key, so it is derivable from the key itself. A retired key stays published so an old receipt still verifies.

The verifier decides the algorithm, not the token: refuse anything whose header is not `EdDSA` and `sdi-receipt+jws`, find the key by `kid`, verify the signature over `<header>.<payload>`, then read the claims. With the MIT `@surfingdog/core` helpers:

```ts
import { verifyReceipt } from "@surfingdog/core";

const { keys } = await (await fetch(`${receipt.payload.iss}/.well-known/jwks.json`)).json();
const claims = await verifyReceipt(receipt.jws, keys); // throws on any mismatch
```

## Acknowledging one

The customer's agent counter-signs to say it holds the same receipt. From then on the receipt is *acked*: both sides hold it, and a network is told so rather than asked to guess. An unacked receipt is still a receipt, only weaker evidence.

The acknowledgement is a compact JWS **by the agent's own Ed25519 key**, which travels in the header:

```
header   {"alg":"EdDSA","typ":"sdi-receipt-ack+jws","jwk":{"kty":"OKP","crv":"Ed25519","x":"…"}}
payload  {"rcp":"01M34X9PAFXES35PXPY6QT944T","sha":"<base64url(SHA-256(receipt jws))>","iat":1790000500}
```

`rcp` is the receipt's `id` from the item; `sha` is the base64url SHA-256 of the receipt's `jws` string exactly as you received it, no padding — it is what lets a network that never sees the instance's ids check that your acknowledgement is of this receipt and no other; `iat` is now, in seconds. Send it to `POST /v1/items/{id}/receipt-ack` with the access token (in the body as `access_token`, as `?access_token=`, or as `X-Access-Token`), or call the `acknowledge_receipt` tool. You may include `receipt` (the JWS) if you want the instance to confirm it is the one it holds.

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

## Networks

When the owner has joined a network in Settings, the instance publishes every receipt to it — once when issued, again once acknowledged — with `POST <network>/v1/receipts` and the body `{"receipt": "<jws>", "ack": "<jws>"}` (`ack` only when there is one). The manifest names the networks an instance publishes to under `review_services`. The network answers `{"ok": true, "state": "issued" | "acknowledged", "duplicate": false}`.

The network believes nothing it is sent. It finds the business by `iss`, takes the keys from the manifest it fetched from that domain itself, verifies the receipt, verifies the acknowledgement against the key in its header and the receipt's `sha`, and counts one receipt per `(issuer, nonce)`. It refuses a receipt from a domain it has not verified (`404`), one signed by a key the manifest does not publish (`422 unknown_key`, after refreshing its copy), a forgery (`422 bad_signature`), and anything older than 180 days. What it stores is what the receipt says: the pseudonym, the type, the kind, when — never an address, never a name. A directory listing shows how many receipts a business has issued and how many were counter-signed; the amounts are never published.

Any service that speaks this one endpoint can be a review service; `https://network.surfingdog.ai` is only the default.

## For implementers

`packages/spec/vectors/receipts.json` in the repository (MIT) holds fixed keys, the `sub` derivation with its inputs, two receipts whose JWS an implementation must reproduce byte for byte, a valid acknowledgement, and every refusal with the error code it must raise. A verifier in any language is right when it agrees with that file.

## As events

A receipt being issued, and being counter-signed, are events on the item like any transition: `booking.receipt_issued`, `booking.receipt_acknowledged`, `order.receipt_issued`, `order.receipt_acknowledged`. They appear in `GET /v1/owner/events` and reach your [webhooks](/docs/webhooks/) under the same subscriptions (`order.*` includes them); in the full payload style, `data.receipt` carries the receipt. The issue event's id is the receipt's id; the acknowledgement's is that id with `:ack`.

## Keys

One key per instance, generated on first use, private half sealed by `INBOX_SECRET_KEY` (AES-256-GCM) and never readable back through any door. If the secret key is changed the sealed private key can no longer be opened and the instance stops issuing until it is restored — so treat `INBOX_SECRET_KEY` as the thing it is, and add keys in front of it for rotation rather than replacing it. The pseudonym pepper comes from the same secret and cannot rotate at all without severing the link between receipts already in the world and the customers they are about. [ADR-016](https://github.com/surfingdogai/inbox/blob/main/docs/adr/016-receipts.md) has the reasoning.
