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

## Amendment, 18 October 2026: on from the first day, and the key can go with the business

**Status:** accepted.

A business's track record starts with its first receipt that reaches a network, and a network
counts a promise that reaches it more than a day late at half its weight. An inbox that joins a
month after it opens has a month that never counts. So the network is on by default where we can
say so honestly, and a business that moves its inbox can take its signing key with it.

**Hosted inboxes join their host's network with their first settings.** The host policy carries a
seed (`HostPolicy.seed`, core `settings/policy.ts`): the settings a new inbox starts with, written
once, with the very first settings it stores, and the owner's from then on. A hosted inbox is seeded
with network.surfingdog.ai switched on and listed, with its listing, counts and receipts, and with
`issue` off: no first-time customer's email goes to a network until a person at the business
switches "Give first-time customers a key" on (`join_networks` in the policy payload names other
networks, or none). An inbox that already had settings is never seeded on its own; its host can do
it on purpose (`POST /admin/v1/tenants/{id}/networks/join`, the runtime's `join-networks <id>`).

**A host's hold remembers, and the owner chooses during it.** While a hosted inbox is only at its
setup address, its host holds every network off and the business out of every directory. The hold
used to switch them off: `enabled: false`, `listed: false`, indistinguishable from the owner's own
choice, so an inbox that went live stayed off until the owner noticed. Now each held network keeps
`resume`, what it comes back to, and so does the listing (`directory.resume`). When the hold ends,
each comes back as it was and `resume` goes; a network the host switched on during a hold (a seed)
resumes on. The owner's choice survives a hold too: an inbox that loses its DNS record and gets it
back is on or off as its owner left it.

During a hold nothing reaches a network, and what comes back is the business's to choose before it
does. The host and the owner in person write `resume`, either way; anyone may set it to false (the
owner's AI and integration keys included, as they may switch a network off at any time). While
held, `networks.<origin>.enabled` and `directory.listed` sent alone mean the same as `resume`, since
nothing can be on meanwhile, so a client that knows nothing of holds still switches a network off
for good. Sharing less (`issue`, `share.*` to false) is anyone's during a hold too; adding a network,
sharing more, or removing a hold is the host's alone. Where no host holds the networks, nobody sets
`resume`; one left in a copy of a hosted inbox may be taken away, and a download strips it.

**Self-hosted inboxes are asked.** Nothing on an instance that is already running changes: a stored
document, or none, reads exactly as before, and an instance whose wizard is skipped stays off the
network. The setup wizard's last step, on a first setup at a public https address, offers
network.surfingdog.ai switched on (listing, counts and receipts; keys for first-time customers off);
at localhost, on a private address or on a port it only says to list the inbox once it has a public
address, since no network can verify it there. Run again, the wizard leaves the network to
Settings → Networks.

**The demo and our own inbox sign receipts.** The demo signs a receipt for each booking it confirms
and order it accepts, and publishes none: it speaks for nobody to a network.

**The key can go with the business.** A network keeps a business's record by its address (the
domain of `iss`), and verifies a receipt against any key the business's manifest publishes; a copy
opened without the private key still publishes the old public halves, so the receipts signed before
still verify, and signs new ones with a key of its own. What the private key adds is that the inbox
the business moves to signs with the same key as before. So it travels only when the owner asks for
it: a download (`POST /v1/owner/download`) with `receipt_keys: true` carries `receipt-keys.json`
beside `inbox.db`, holding the key that signs now and no other (a retired key never signs again,
and its private half would be of use only to someone forging a back-dated receipt), its private
half in the clear. `inbox.db` still never holds one. The owner app offers the key behind a switch,
off for a routine download and on from the start while a hosted inbox closes. `import-receipt-keys`
on a Node instance the business runs checks the key (its `kid` is its own thumbprint; its private
half signs what its public half verifies; no `kid` twice; none held there for another purpose),
seals it under that instance's own secret key, and makes it the one that signs; a key that instance
made meanwhile is retired and still verifies. Every check runs before anything is written, and the
same file taken in twice changes nothing. Taking a key into a hosted inbox is not built.

**A key can be replaced.** `POST /v1/owner/receipt-keys/rotate` (Settings → Networks, "Make a new
receipt key"), the owner's in person only, retires the key that signs and makes a new one: this
inbox never signs with the old key again, and it stays published, so every receipt it signed still
verifies. A verifier cannot tell from the published keys when one was retired, so a key that leaked
can still be used to sign a receipt a network would accept; recording when a key was retired, and
networks honouring it, is left to ADR-017. The download notice tells an owner who did not make a
download that took the key to make a new one.
