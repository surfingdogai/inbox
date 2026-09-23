---
title: Security and privacy
description: What the instance trusts, what it stores, and what leaves it.
---

## Inbound content is untrusted

Everything that arrives through a door is data, never instructions. An email, a form submission, an agent's message: each is parsed into a typed item and stored as text. Rules read frozen values and perform no I/O. When AI extraction and drafting arrive, with a key you bring yourself, the extraction model has no tools; it can only fill fields that are then validated like any other input.

Raw email reaches the instance only through a path the receiving mail system authenticated (Email Routing on Workers, which checks DKIM and SPF) or through the `POST /v1/email/inbound` webhook, which requires the shared secret from settings in the `X-Inbox-Email-Secret` header. Email that arrived unauthenticated is treated as anonymous.

When the instance fetches a remote document (an OAuth Client ID Metadata Document, a product feed) it refuses IP literals, local and internal hostnames, redirects to another host, large bodies and slow servers, and checks every redirect again. A network is called only at an https address on a public host, port 443, with no path: that is checked when the owner adds it and again on every call, with a five-second limit per call and no redirects followed. What those calls carry is listed below, and nothing else.

## What reaches a network

An instance can report to several networks, and each one lists it in its own directory. The owner switches each one on or off in Settings → Networks; none is on until the owner switches it on, and a network that is off receives nothing.

Message text, names, phone numbers, postal addresses, line items and payment references never leave the instance. What can leave, to each network that is on:

- **activity counts**: a ping every hour with the software version, the runtime, and the number of items created in the last 24 hours per type (`share.counts: false` sends none). With `INBOX_SECRET_KEY` set, the ping is signed with the instance's receipt key, so only this instance learns its own standing from the answer;
- **receipts**: every receipt the instance issues (a booking confirmed, an order accepted or paid, and how each ended) and the customer agent's counter-signature when one arrives (`share.receipts: false` sends none, except the outcomes of promises the network already holds). A receipt carries the issuer, the item's id on the instance, its type, what it attests, when, a nonce, the customer's pseudonym (an HMAC under a key only this instance holds, never an address), the due date, and, when the item states them, the amount and the payment method; and, when the customer's assistant presented them, the id of each network's presentation (every network the receipt goes to sees them all; each counts only its own). A counter-signature carries the agent's public key, the same at every business where that agent uses it, so the receipts it counter-signed can be linked to each other, and may name the person's pass by reference. The fields are on the [Receipts](/docs/receipts/) page;
- **a customer's email, at first contact**: when a customer's booking or order has an email and their assistant carried no pass, the instance sends the network the email address as the customer typed it, the item's id as a request id, and a label for the assistant (with its key's thumbprint and platform when it signed), so the network can give the customer a key. Only networks with "Give first-time customers a key" on (`issue`, on by default) get this; switch it off per network. The network keeps a keyed hash of the address, never the address;
- **what an assistant carries**: a pass or a key the customer's assistant presents goes to the network that issued it, and to no other, with the customer's email address (normalised) when the request has one, so the network can say whether the address is the person's. A pass reference goes only inside the assistant's own signature, forwarded as it was made: the method, host, path and query of the request, a hash of its body, the assistant's public key, the pass reference and the signature. A signature that would carry a secret to the network, or that covers any header beyond those and `Content-Type`, is not forwarded;
- **the public profile** in the manifest, which a network reads from the instance's own domain when it verifies it, and lists in its directory.

What the instance keeps of this: a network's answer about a person (a pairwise id for this business, and the standing it gave) on the item and the customer; SHA-256 hashes of passes, to recognise one again; the network's answers for an hour (a day for "already known"), keyed by hashes; nothing of a key. A first-time customer's key is sealed with `INBOX_SECRET_KEY` until it is emailed to them, and their first pass so the item's creator can collect it again from the status door; both are deleted after seven days at most, and no door shows either to the business.

Every network is run by someone, and keeps what it receives under its own rules; add only networks you trust with the list above. The network at `network.surfingdog.ai` keeps the hourly pings, with the address they came from, for 90 days; every receipt, counter-signature and presentation for good, so a record is never lost; a person's email only as a keyed hash; and secrets only as hashes. Its directory shows a business's listing and its counts, never a receipt, an amount, a pseudonym or anything about a customer, and a business sees a person's standing only when that person's assistant presents their pass. The [privacy page](https://surfingdog.ai/privacy) has the whole list.

Personal data inside items is tracked by path so that an erasure request rewrites exactly those fields. Pseudonyms on the network are HMACs with a server-held secret, never a bare hash of an email or phone number. A standing is a record the network shows, not a decision it makes: each business's own rules decide what a customer's record earns them, and a rule that reads one may only speed things up or ask a person, never refuse.

## Signed requests

An assistant may sign its requests (`sdi-agent/1`, HTTP Message Signatures, Web Bot Auth compatible). The instance verifies the signature against the key in `Sdi-Agent-Key`, or the key a platform's directory lists (fetched over https from a public host, cached, one new platform per address a minute), checks that it covers the method, host, path, query, body digest and the passes carried, and that it was made in the last five minutes. A signature that does not verify is not an error: the request is served as unsigned, and `Sdi-Signature` says why. A signature on a request that changes something is kept, as a hash, until it expires, so a copy of the request is refused unless it is a retry from the same client with the same idempotency key.

## Keys and tokens are hashed

- Owner API keys (`sdi_own_…`) and agent keys (`sdi_agent_…`) are stored as SHA-256 hashes with a short prefix for identification. The key is shown once, when it is created.
- OAuth access tokens (`sdi_at_…`, one hour) and refresh tokens (`sdi_rt_…`, thirty days) are opaque, hashed, and rotate on every refresh. A refresh token presented twice revokes the whole token family.
- Magic-link tokens are hashed, single-use and expire in fifteen minutes. Sessions are hashed and expire after thirty days.
- Receipts are signed with an Ed25519 key generated on the instance; the private half is sealed by `INBOX_SECRET_KEY` before it is stored, and the public half is published in the manifest and at `/.well-known/jwks.json`. A retired key stays published so old receipts still verify. Without `INBOX_SECRET_KEY` no key is created and no receipt is issued, rather than storing a signing key in the clear.

## Same-origin writes for cookies

A session cookie only writes from the instance's own origin: cross-site requests that carry a cookie are refused with `403` on anything but `GET`. API keys and OAuth tokens carry no ambient authority, so they are checked wherever they are sent. Cookies are `HttpOnly`, `SameSite=Lax` and `Secure` behind HTTPS.

## Small blast radius by design

One business is one database. Every write is a single batch of precomputed statements, with unique constraints and compare-and-set versions deciding races; there are no interactive transactions anywhere. Raw email and attachments go to blob storage, never into SQLite. Batches stay small, and heavy work (email parsing, extraction, rule fan-out) runs in job consumers rather than in the request.

## Reporting

Security issues: open a private report through the repository's security advisories on GitHub rather than a public issue.
