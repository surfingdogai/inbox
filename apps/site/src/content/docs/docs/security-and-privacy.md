---
title: Security and privacy
description: What the instance trusts, what it stores, and what leaves it.
---

## Inbound content is untrusted

Everything that arrives through a door is data, never instructions. An email, a form submission, an agent's message: each is parsed into a typed item and stored as text. Rules read frozen values and perform no I/O. When AI extraction and drafting arrive, with a key you bring yourself, the extraction model has no tools; it can only fill fields that are then validated like any other input.

Raw email reaches the instance only through a path the receiving mail system authenticated (Email Routing on Workers, which checks DKIM and SPF) or through the `POST /v1/email/inbound` webhook, which requires the shared secret from settings in the `X-Inbox-Email-Secret` header. Email that arrived unauthenticated is treated as anonymous.

When the instance fetches a remote document (an OAuth Client ID Metadata Document, a product feed) it refuses IP literals, local and internal hostnames, redirects to another host, large bodies and slow servers, and checks every redirect again. A network is called only at an https address on a public host, port 443, with no path: that is checked when the owner adds it and again on every call, with a five-second limit per call and no redirects followed. Its calls to the networks it reports to carry its domain, its software version and runtime, counts and receipts, nothing else.

## What reaches a network

An instance can report to several networks, and each one lists it in its own directory. The owner switches each one on or off in Settings → Networks; none is on until the owner switches it on. Every network that is on receives the same things, the same receipts included, and a network that is off receives nothing.

Content never leaves the instance: no message text, no customer's name, email address, phone number or postal address, no line items, no payment references. What can leave, to each network that is on, is:

- **activity counts**: a ping every hour with the software version, the runtime, and the number of items created in the last 24 hours per type. No content, no identities, no amounts. A network can be set to get no counts (`share.counts: false`);
- **receipts**: every receipt the instance issues (a booking confirmed, an order paid) is published to the network, and published again with the customer agent's counter-signature when one arrives. A network switched on later is sent the receipts issued before it, too, a thousand an hour at most. A network can be set to get no receipts (`share.receipts: false`). A receipt carries the issuer, the item's id on the instance, its type, what it attests, when, a nonce, the customer's pseudonym (an HMAC under a key only this instance holds, never an address), and, when the item states them, the amount and, for a paid order, the payment method. The counter-signature carries the agent's public key, which is the same at every business where that agent uses it, so the receipts it counter-signed can be linked to each other. The fields are on the [Receipts](/docs/receipts/) page;
- **the public profile** in the manifest, which a network reads from the instance's own domain when it verifies it, and lists in its directory;
- **outcome codes**, when the business joins a review service (coming).

Every network is run by someone, and keeps what it receives under its own rules; add only networks you trust with the list above. The network at `network.surfingdog.ai` keeps the hourly counts for 90 days, each receipt and its counter-signature for 540 days after it arrives, and each business's totals (receipts issued and counter-signed) indefinitely. Its directory shows counts and the date of the latest receipt: never a receipt, an amount or a pseudonym.

Personal data inside items is tracked by path so that an erasure request rewrites exactly those fields. Pseudonyms on the network are HMACs with a server-held secret, never a bare hash of an email or phone number, and reputation, when it arrives, will be a record the network shows, not a decision it makes: each business's own rules decide what a customer's record earns them, and what the network collects will be listed here before it collects it.

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
