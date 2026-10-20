---
title: Agent inbox manifest
description: "The format of /.well-known/agent-inbox.json, surfingdog-inbox/0: what a business's agent inbox takes and where its doors are. Versioned, with a JSON Schema and test vectors."
---

**Format `surfingdog-inbox/0`**, last changed 15 October 2026. [JSON Schema](/spec/schemas/manifest.json) · vectors: [`doors-elsewhere.json`](/spec/vectors/doors-elsewhere.json), [`profile.json`](/spec/vectors/profile.json) · [check one](/spec/check/) · MIT licence.

An agent inbox publishes one JSON document that says what kinds of request it takes and where each of its doors is. An agent reads it to choose a door without opening every card. How Surfing Dog Inbox builds its own is on [Manifest](/docs/manifest/).

## Where it is

- At `https://<the inbox's host>/.well-known/agent-inbox.json`, over https, as `application/json`.
- A business may also point to it from its main domain with a DNS record: `_agent-inbox.<domain>` TXT `v=sdi1; manifest=<the manifest's URL>`.
- A reader takes the inbox's receipt keys from this document at the inbox's own host, never from anything the inbox sends.

## Fields

| Field | Must it be there | What it holds | Since |
| --- | --- | --- | --- |
| `spec` | yes | `"surfingdog-inbox/0"` | 21 Sep 2026 |
| `instance` | yes | the inbox's https origin: scheme and host, no path, no trailing slash | 21 Sep 2026 |
| `item_types` | yes | the kinds of request it takes, each once: `message`, `quote_request`, `booking`, `order`, `refund` | 21 Sep 2026 |
| `protocols` | yes | protocol name → the door's https URL: `mcp`, `openapi`, `rest`, `a2a`, `ucp` and others | 21 Sep 2026 |
| `agent_policy.tiers` | yes | at least one of `anonymous`, `signed_agent`, `verified_principal`, `reputed_principal` | 21 Sep 2026 |
| `agent_policy.signatures` | no | the request signatures it checks, at most 8: `sdi-agent/1`, `web-bot-auth` | 23 Sep 2026 |
| `agent_policy.passes` | no | whether it presents a person's passes to their networks | 23 Sep 2026 |
| `agent_policy.networks` | no | the networks whose people it recognises, at most 8 https origins | 23 Sep 2026 |
| `agent_policy.guide` | no | a URL: how an agent says who it is, and who its person is, here | 23 Sep 2026 |
| `receipt_keys` | yes | a JWKS of the Ed25519 public keys it signs receipts with (below); `{"keys": []}` when it signs none | 21 Sep 2026 |
| `review_services` | yes | the networks it sends receipts to, as https origins; `[]` for none | 21 Sep 2026 |
| `profile` | no | public facts the business chose to share: name, description, categories, languages, address, coordinates, website, hours, services, place category, attributes, price band, currencies, and how it is paid (`payments`: tokens of the [payments vocabulary](https://github.com/surfingdogai/inbox/blob/main/packages/spec/vocab/payments.json), such as `card`, `apple_pay` or `paypal`) | 21 Sep 2026; hours and services 26 Sep; place category, attributes, price band and currencies 6 Oct; a day that closes at `24:00` 15 Oct; payments 18 Oct |
| `directory` | no | `{"listed": false}` keeps the business out of networks' directories | 26 Sep 2026 |
| `claims` | no | network host → claim token: proof that a listing on that network is the business's own | 6 Oct 2026 |
| `doors_elsewhere` | no | at most 5 `{"item_type", "url", "platform"?}`: kinds of request it takes somewhere else, never one in `item_types`, each at an https address on a named host; `platform`, a token of the [door platforms](https://github.com/surfingdogai/inbox/blob/main/packages/spec/vocab/door-platforms.json) (`fresha`, `opentable`, `toast`…), names the platform the page is on | 12 Oct 2026; `platform` 20 Oct |

The JSON Schema has every bound: lengths, counts and formats.

## Receipt keys

Each key in `receipt_keys.keys` is an Ed25519 public JWK:

- `kty` is `OKP`, `crv` is `Ed25519`, and `x` is the public key, 43 base64url characters.
- `kid` is the key's RFC 7638 thumbprint. A receipt names its key by it.
- It never carries `d`. A key whose private half was published is no longer secret: replace it.
- A retired key stays in the list, so receipts it signed still verify.

## Reading one

- Ignore any field you do not know.
- Read `profile` and `doors_elsewhere` field by field and entry by entry: drop a bad one, keep the rest. The vectors show exactly what a reader keeps.
- Never ask a business to list a door it cannot fulfil, and never treat a door listed here as proof it works: that takes reading it.

## How it changes

New fields are added, and only as optional ones, so a reader of an older manifest keeps working. A field may also come to take a value it did not take before, as a day's hours that close at `24:00` did on 15 October 2026: a reader written before it refuses that one value, as it refuses any value it does not know, and reads the rest. A change that would break a reader comes with a new `spec` value, `surfingdog-inbox/1`.

## Changelog

- **20 October 2026** (`@surfingdog/spec` 0.9): in `doors_elsewhere`, `platform`: the platform a door's page is on, a token of `vocab/door-platforms.json`, so an agent says "Book at Fresha". A reader keeps it only when it knows the token, the platform takes that kind of request and the page is the business's own there; otherwise it drops the platform alone and keeps the door. A reader before 0.9 ignores it.
- **18 October 2026**: in `profile`, `payments`: how customers and their agents can pay, at most 64 tokens of `vocab/payments.json`. A reader keeps the tokens it knows and drops the rest alone; a card brand says `card` too.
- **15 October 2026**: in `profile.hours`, a day may close at `24:00`: open until midnight, or all the time from `00:00`. A reader written before this day (`@surfingdog/spec` before 0.5) refuses `24:00` in that one day's hours, and keeps the rest of the profile.
- **12 October 2026**: `doors_elsewhere`, the kinds of request a business takes somewhere else, and where.
- **6 October 2026**: `claims`; in `profile`, `place_category`, `attributes`, `price_band` and `currencies`.
- **26 September 2026**: `directory`; in `profile`, `hours` and `services`.
- **23 September 2026**: in `agent_policy`, `signatures`, `passes`, `networks` and `guide`.
- **21 September 2026**: the format: `spec`, `instance`, `profile`, `item_types`, `protocols`, `agent_policy.tiers`, `receipt_keys` and `review_services`.
