# ADR-016 — Receipts

**Status:** accepted, 22 September 2026.

## The decision

When an item completes, the instance issues a **receipt**: a small signed record of what was
agreed and what happened. The customer's agent counter-signs it. Both sides then hold the same
proof, and neither can quietly change it afterwards.

A receipt is an **Ed25519 compact JWS**. The payload claims are frozen here, because a receipt
outlives the software that wrote it and a claim renamed later invalidates every receipt already
issued.

```
{
  "iss": "https://inbox.example.com",   // the instance, an https origin, no trailing slash
  "sub": "<subject hash>",              // who it is about, pseudonymous — see below
  "itm": "01M34...",                    // the item's id on the issuing instance
  "typ": "booking",                     // message | quote_request | booking | order | refund
  "knd": "confirmed",                   // confirmed | paid — what the receipt attests
  "iat": 1790000000,                    // issued at, Unix seconds
  "nonce": "9f2c...",                   // 128 bits, hex; the network deduplicates on it
  "amt": { "value": 4500, "currency": "EUR" },   // optional: minor units
  "pay": "card"                         // optional: how it was paid, when known
}
```

The JOSE header is `{"alg":"EdDSA","typ":"sdi-receipt+jws","kid":"<kid>"}`.

## Why these claims and not others

**Three-letter names in the payload, spelled-out names everywhere else.** JWT convention, and a
receipt is carried in headers and URLs where every byte is visible. `iss`, `sub` and `iat` are
RFC 7519 and mean exactly what they mean there, so a reader who knows JWT already knows most of
this. `itm`, `typ`, `knd`, `amt` and `pay` are ours and are namespaced by `typ` in the header.

**`sub` is a hash, never an address.** A receipt is handed to a network and may be published
against a business. Putting a customer's email in it would make every receipt a disclosure. The
subject is `base64url(HMAC-SHA-256(pepper, party identity))`, where the pepper is derived by HKDF
from this instance's `INBOX_SECRET_KEY` and never leaves the secret box. Two receipts for the same
customer on the same instance share a subject, which is what makes a reputation possible; the same
customer on a different instance does not, which is what stops one being built without them.

HMAC rather than `SHA-256(secret || identity)`: the concatenated form is length-extendable, and a
pseudonym is precisely the value that ends up published. Without the pepper the hash would also be
brute-forceable — the input space of email addresses is small enough to enumerate — so a bare hash
of an address is not a pseudonym at all, which is the conclusion the GDPR research reached before
any of this was written.

**The pepper cannot be rotated.** Changing it changes every pseudonym and severs the link between
a receipt already in the world and the party it is about. `INBOX_SECRET_KEY` may still be rotated
for sealing, but the newest key is the one the pepper comes from, so a business that has issued
receipts should add keys only when it accepts that new receipts no longer link to old ones.

**`nonce` exists so a receipt can be presented more than once but counted once.** A network
deduplicates on `(iss, nonce)`.

**No customer name, no address, no line items.** A receipt proves a transaction happened and what
it was worth. It is not a copy of the order.

## Keys

Ed25519, generated on the instance, private half sealed by the secret box (ADR-015 §2) and never
readable back. The public half is published two ways: in the manifest under `receipt_keys`, and
at `/.well-known/jwks.json` for anything that expects a JWKS.

A key is retired rather than deleted, so a receipt signed last year still verifies. `kid` is the
RFC 7638 thumbprint of the public JWK, so it is derivable from the key itself rather than
allocated.

**Without `INBOX_SECRET_KEY` an instance cannot issue receipts at all.** A private key that could
only be stored in the clear is one that should not exist, so the job records why and stops rather
than downgrading quietly.

## The acknowledgement

The customer's agent counter-signs with a JWS of its own over `{"rcp": "<receipt jti>", "iat":
<seconds>}`, header carrying the agent's public JWK. The instance checks the signature against
that embedded key, records it, and from then on the receipt is *acked*: both sides hold it.

An unacked receipt is still a receipt. It is simply weaker evidence, and the network is told which
it is (ADR-012: paid 1.0, unpaid 0.7, unacked business-side 0.4) rather than being asked to guess.

**Amended the same day, before any acknowledgement existed.** The payload is `{"rcp": "<receipt
id>", "sha": "<base64url(SHA-256(receipt compact JWS))>", "iat": <seconds>}`. `rcp` alone bound the
acknowledgement to an id only the issuing instance can resolve, so a network holding the two JWS
strings could not tell whether the acknowledgement was of *this* receipt or of another from the
same issuer. `sha` is the check anyone can repeat with nothing but the two strings. The instance
checks both; a network checks `sha`.

## Publishing to a network

The instance pushes each receipt, and again once it is acknowledged, to every review service it
names in the manifest under `review_services` — the network chosen in Settings, while `network.join`
is on. `POST <service>/v1/receipts` with `{"receipt": "<jws>", "ack": "<jws>"?}`; the service
answers `{"ok": true, "state": "issued" | "acknowledged", "duplicate": <bool>}`. The service trusts
nothing in the body: it finds the issuer by `iss`, takes the keys from the manifest it fetched from
that domain itself, verifies the receipt, verifies the acknowledgement against the key it carries
and the receipt's hash, and deduplicates on `(issuer, nonce)`. A receipt from a domain the service
has not verified is refused (404) and the instance retries, because registration and verification
run on the hourly ping and will catch up. The customer's agent may present the same pair to a
service itself; the verification is identical, and nothing in it depends on who delivered it.

## What this does not decide

Reviews. A review is only accepted against a receipt, in both directions, and both are sealed
until the window closes — but none of that is built here, and the reveal rules live with the
network. This ADR is the receipt alone.
