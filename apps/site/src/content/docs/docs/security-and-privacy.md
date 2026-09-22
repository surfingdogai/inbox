---
title: Security and privacy
description: What the instance trusts, what it stores, and what leaves it.
---

## Inbound content is untrusted

Everything that arrives through a door is data, never instructions. An email, a form submission, an agent's message: each is parsed into a typed item and stored as text. Rules read frozen values and perform no I/O. When AI extraction and drafting arrive, with a key you bring yourself, the extraction model has no tools; it can only fill fields that are then validated like any other input.

Raw email reaches the instance only through a path the receiving mail system authenticated (Email Routing on Workers, which checks DKIM and SPF) or through the `POST /v1/email/inbound` webhook, which requires the shared secret from settings in the `X-Inbox-Email-Secret` header. Email that arrived unauthenticated is treated as anonymous.

The instance fetches remote documents in one place, to resolve OAuth Client ID Metadata Documents, through a fetcher that refuses IP literals, local and internal hostnames, redirects to another host, large bodies and slow servers. Its own outbound calls go to the network it joined, and carry counts only.

## Nothing personal reaches the network

Content never leaves the instance. What can leave, each by the owner's choice in settings, is:

- **activity counts**: once the owner joins a network (`network.join`, off by default), a ping every hour with the software version, the runtime, and the number of items created in the last 24 hours per type. No content, no identities, no amounts;
- **the public profile**, when the business chooses to be listed in a directory (coming);
- **receipts**, which name the customer by a pseudonym (an HMAC under a key only this instance holds), never by an address, so a receipt can be shown to a network without disclosing who it is about; and outcome codes, when the business joins a review service (coming).

Personal data inside items is tracked by path so that an erasure request rewrites exactly those fields. Pseudonyms on the network will be HMACs with a server-held secret, never a bare hash of an email or phone number, and reputation stays advisory: decayed counts, no pass/fail, a human decision with a recorded reason, a contest procedure ([ADR-012](https://github.com/surfingdogai/inbox/blob/main/docs/adr/012-reputation-and-reviews-law.md)).

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
