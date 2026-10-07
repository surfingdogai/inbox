# The network protocol

Protocol 0.2 (October 2026). Everything in 0.2 is additive: a 0.1 network and a 0.1 inbox keep working.
Spec 0.3 adds, all of it optional for a network and none of it read by an inbox, capabilities and the
agentic score (§4.13) and the discovery documents (§4.14).

A **network** is a service that inboxes report to: it lists businesses, keeps the receipts they
publish, gives customers a key and passes, and orders the directory by the published rules. Anyone
can run one (ADR-017, R24), and an inbox can use several at once. This document is everything a
network must implement to work with any inbox, and everything an inbox may send to it.

It restates [ADR-017](../adr/017-reputation-and-ranking.md) §2–§7 as a protocol. The rules of
reputation and order (what counts, the formula, tiers) are in the ADR and, machine-readable, at a
network's own `GET /v1/ranking`. When this text and the vectors disagree, **the vectors decide**.

A network need not do all of it. At the **directory** level (§10) it lists businesses and keeps
their receipts, eight calls, and orders its directory by rules of its own; at the **full** level it
also gives customers keys and passes, scores, and hears reports and contests. Its rules say which.
[`examples/network`](../../examples/network/) is a small directory-level network, and
[`packages/network-check`](../../packages/network-check/) tests any network against either level.

| What | Where |
|---|---|
| Schemas (Zod, MIT) | [`packages/spec/src/network/`](../../packages/spec/src/network/) |
| Schemas (JSON Schema) | [`packages/spec/schemas/`](../../packages/spec/schemas/), one file per message |
| Signed requests | [`vectors/signatures.json`](../../packages/spec/vectors/signatures.json) |
| Keys, passes, email normalisation | [`vectors/passes.json`](../../packages/spec/vectors/passes.json) |
| Receipt claims v2 | [`vectors/receipts-v2.json`](../../packages/spec/vectors/receipts-v2.json) |
| Rules version 6: amendments, refunds, `trm`, `acc` | [`vectors/receipts-v6.json`](../../packages/spec/vectors/receipts-v6.json) |
| Receipts v1 and acknowledgements | [`vectors/receipts.json`](../../packages/spec/vectors/receipts.json) (ADR-016) |
| Scores | [`vectors/scoring.json`](../../packages/spec/vectors/scoring.json) |
| Order, shuffle, cursors | [`vectors/ordering.json`](../../packages/spec/vectors/ordering.json) |
| What a network keeps from a profile | [`vectors/profile.json`](../../packages/spec/vectors/profile.json) |
| What an assistant reads from the tools | [`vectors/mcp.json`](../../packages/spec/vectors/mcp.json) |
| A directory-level network's rules | [`schemas/ranking-directory.json`](../../packages/spec/schemas/ranking-directory.json) (§10) |
| The categories list | [`vocab/categories.json`](../../packages/spec/vocab/categories.json) |
| Door types, and what is never a door | [`vocab/doors.json`](../../packages/spec/vocab/doors.json) (§4.8) |
| Attributes a listing may carry | [`vocab/attributes.json`](../../packages/spec/vocab/attributes.json) (§4.10) |
| Rules version 7's order: tiers, newcomers, pages | [`vectors/ordering-v7.json`](../../packages/spec/vectors/ordering-v7.json) (§4.4), from the network |
| A found entry's card, from what was crawled | [`vectors/listing.json`](../../packages/spec/vectors/listing.json) (§4.11), from the network |
| The capability vocabulary | [`vocab/capabilities.json`](../../packages/spec/vocab/capabilities.json) (§4.13) |
| The agentic score's rules, version 1 | [`vocab/score-rules-v1.json`](../../packages/spec/vocab/score-rules-v1.json) (§4.13) |
| The agentic score's arithmetic | [`vectors/score.json`](../../packages/spec/vectors/score.json) (§4.13), from the network |

## 1. Conventions

- HTTPS only. A network is named by its origin, `https://<host>` on port 443 with no path; `<host>`
  is lowercase punycode and is the host inside every key and pass it issues.
- Bodies are JSON, UTF-8. Times are RFC 3339 in UTC. Unix times in receipts are seconds.
- A request body is at most 64 KB; no message in this protocol comes near it. A network refuses a
  larger one with `413 too_large`, and may set a lower limit on a call and refuse a body over that
  one the same way. `413` is final: the same body sent again gets the same answer.
- **Unknown members are ignored**, by both sides. A network may add a field to any answer; an inbox
  must not fail on it. The JSON Schemas therefore never forbid extra members.
- Errors are RFC 9457 problem documents (`application/problem+json`) with a `code` (§9). A `400`
  may have none. A refused acknowledgement's code is prefixed `ack_`.
- Rate limits answer `429` with `rate_limited` or `too_many_receipts`.

## 2. Strings a person holds

| String | Format | Does |
|---|---|---|
| Key | `sdkey1_<host>_<id>_<secret>` | Proves the person; mints passes. Issued once, by email. |
| Pass | `sdpass1_<host>_<id>_<secret>` | What an agent presents to businesses. Revocable alone. |
| Pass reference | `sdpass1_<host>_<id>` | Names a pass. Honoured only in a request signed by a key delegated to that pass. |
| Session | `sdps_<secret>` | 24 hours, from an emailed code: `Authorization: Bearer sdps_…` |

`<id>` is 16 and `<secret>` 32 characters of RFC 4648 base32, lowercase, unpadded (`[a-z2-7]`).
`<host>` is `[a-z0-9.-]`, not starting or ending with a dot, and never contains `_`, so a string
splits unambiguously at `_`. A string over 200 characters is none of these. A network keeps only
SHA-256 (hex) of a secret. Keys and passes never expire; they are revoked.

A network is authoritative only for strings whose host is its own: a pass from another network is
`404 unknown_pass`, never forwarded.

Other identifiers: a **presentation id** is 22 base64url characters (16 random bytes); a
**`ppid`** is what a business sees instead of the person, different at every business:

```
ppid = base64url(HMAC-SHA-256(pairwise secret, "<pid>|https://<business domain>"))[:22]
```

A **thumbprint** (`jkt`, a signing key's `keyid`) is the RFC 7638 SHA-256 thumbprint of an Ed25519
JWK, base64url, 43 characters: SHA-256 of `{"crv":"Ed25519","kty":"OKP","x":"<x>"}`.

### 2.1 Email normalisation

A network keeps an address only as `email_mac = hex(HMAC-SHA-256(email secret, normalised))`, so
the inbox and the network must normalise to the same bytes. No Unicode table is used, because no
two implementations' Unicode lowercasing agree on every letter:

1. Trim ASCII whitespace (space, `\t`, `\n`, `\v`, `\f`, `\r`) from both ends. Refuse an empty
   result, one over 320 bytes of UTF-8, or one holding any byte ≤ `0x20` or `0x7F`.
2. Split at the **last** `@`; refuse if it is the first or last character.
3. The local part must be a dot-atom: refuse any of `" ( ) < > [ ] \ , ; :` or `@` in it (so a
   quoted local part is refused). Lowercase ASCII `A`–`Z` only. No NFC, no dot or plus folding.
4. Drop one trailing `.` from the domain; refuse an empty domain or any empty label.
5. In each label, lowercase ASCII `A`–`Z` only; if the label then holds any non-ASCII character,
   encode it with RFC 3492 punycode and prefix `xn--` (no UTS 46 mapping: `ß` stays `ß`,
   `Ü` stays `Ü`, full-width letters stay full-width). The label must then be 1–63 of `[a-z0-9-]`.
6. The result is `<local>@<labels joined with ".">`.

Anything else is **refused, not repaired**: a recovery code is sent to the address as typed, and
`me@evil.example,x@gmail.com` must not become one person. A refused address means no issuance.
`passes.json` holds 43 cases, including IDN, `ß`, full-width letters, trailing dots, plus-addresses
and every refused special. (Input that reaches a network through JSON cannot carry a lone UTF-16
surrogate: it arrives as U+FFFD and is normalised as that character.)

## 3. Signed requests

Both profiles are RFC 9421 HTTP Message Signatures with Ed25519 (`alg="ed25519"`).

| | sdi-instance/1 | sdi-agent/1 |
|---|---|---|
| Who signs | an inbox, calling a network | a customer's agent, calling an inbox (or a network's `/v1/delegations` and `/v1/reports`) |
| `tag` | `sdi-instance` | `sdi-agent` (self-held key) or `web-bot-auth` (platform directory) |
| `keyid` | a `kid` in the `receipt_keys` of the inbox's own manifest (a key without a `kid` is named by its thumbprint) | the key's thumbprint |
| Also covered | `"sdi-instance"`, holding `https://<the inbox's domain>` | `"sdi-agent-key";key="<label>"`, or `"signature-agent";key="<label>"` (the whole `"signature-agent"` field for the legacy string form); `"sdi-pass"` when that header is sent |

Every signed request covers, in this order, `"@method"`, `"@authority"`, `"@path"`, `"@query"`
when the URL has a query, and `"content-digest"` when there is a body (RFC 9530,
`Content-Digest: sha-256=:<base64 of SHA-256(body)>:`), then the profile's components. The
parameters are `created`, `expires`, `keyid`, `alg`, `tag` and a **random `nonce`**:

```
Signature-Input: sig1=("@method" "@authority" "@path" "content-digest" "sdi-instance");created=1790001000;expires=1790001300;keyid="kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k";alg="ed25519";tag="sdi-instance";nonce="vector-instance-0001"
Signature: sig1=:zZjkqslaRZsNkba3yPl5EAuvSi53vJraBMcGP0cv457Ir4CrQU9yoRuLslZjcIQxLno7aek4Ch8p5Xmy/DdTCA==:
Sdi-Instance: https://inbox.example.com
```

and the signature base the key signs is

```
"@method": POST
"@authority": network.example.com
"@path": /v1/persons
"content-digest": sha-256=:Zt7Dw78irL0VEno+/NCzKjznXyd9ndYzORpN0ykPKJE=:
"sdi-instance": https://inbox.example.com
"@signature-params": ("@method" "@authority" "@path" "content-digest" "sdi-instance");created=1790001000;expires=1790001300;keyid="kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k";alg="ed25519";tag="sdi-instance";nonce="vector-instance-0001"
```

Rules a receiver applies:

- **Which signature.** The first member of `Signature-Input` tagged with the profile's tag; its
  label names the member of `Signature` (64 bytes). `@signature-params` is that member's text
  exactly as received.
- **`@authority`** is the receiver's own canonical host (with a port only when not the default),
  never the request's `Host` header: a signature made for another host does not verify. An inbox
  answers to the host of its public URL and any `identity.extraAuthorities`.
- **Times.** `created` and `expires` are required; `0 < expires − created ≤ 300`;
  `created ≤ now + 60`; `expires ≥ now − 60`.
- **Header values** are RFC 9421 §2.1 (each line trimmed, joined with `, `). A keyed component
  (`;key="…"`) is the RFC 8941 serialization of that dictionary member. Structured fields over 8 KB
  are refused unread.
- **Single use.** A network stores SHA-256 of the signature bytes until `expires + 60` s and
  refuses a second use with `401 replayed_signature` — on every endpoint, including
  `/v1/persons`. A retry signs again. Ed25519 is deterministic, so two identical requests signed in
  the same second would share a signature: that is what the `nonce` parameter is for.

**sdi-instance/1 failures** (a network): `401 bad_signature` (no or unparseable signature, wrong
`alg`, missing coverage, a digest that does not match, a `keyid` the manifest does not publish, a
signature that does not verify); `401 expired` (outside the time window);
`401 unknown_instance` (`Sdi-Instance` is not an https origin, or not a listed business). An
unknown `keyid` makes the network fetch the instance's manifest again, at most once a minute per
domain.

**sdi-agent/1 keys.** A self-held key travels in `Sdi-Agent-Key: <label>=:<base64 of the JSON
JWK>:`, whose JSON has exactly `kty` `"OKP"`, `crv` `"Ed25519"` and `x` (a private `d` is
refused), and `keyid` must be its thumbprint. A platform key is found in the Web Bot Auth
directory at `<origin>/.well-known/http-message-signatures-directory` of the origin
`Signature-Agent` names (`Signature-Agent: sig1="https://platform.example"`, or the legacy
`Signature-Agent: "https://platform.example"`). At an inbox a failed agent signature is not a
refusal: the request proceeds unsigned with `Sdi-Signature: invalid; reason="<code>"`
(`bad_signature`, `expired`, `unknown_key`); only a replay is refused.

**`Sdi-Pass`** is an RFC 8941 List of at most 8 strings, each at most 200 characters: the passes
or pass references the agent carries, one per network.

### 3.1 Forwarded signatures (`agent_key`)

An inbox that verified an agent's signature can hand it to a network, which verifies it again under
the key delegated to the pass:

```json
{ "jkt": "<thumbprint>", "pass_ref": "sdpass1_<host>_<id>", "label": "sig1",
  "signature_input": "<the label's inner list with parameters, exactly as received>",
  "signature": "<the base64 between the colons of Signature>",
  "signature_base": "<the UTF-8 signature base the inbox verified>" }
```

The network checks that: the label is `[a-z*][a-z0-9_.*-]{0,63}`; the tag is `sdi-agent` or
`web-bot-auth`; `alg` is `ed25519` and `keyid` is `jkt`; `created` is within the last 300 s (60 s
ahead allowed) and `expires`, if present, is after `created` by at most 300 s and not over 60 s
past; the base has exactly one line per component `signature_input` names, in order, each starting
with that component's identifier, and ends with `"@signature-params": ` + `signature_input`;
`@method`, `@authority` and `@path` are covered and `@authority` is exactly the presenting
instance's domain; a covered `"sdi-pass"` line lists `pass_ref`; and the signature verifies under
the delegated key. Each forwarded signature is used once.

The base travels whole, so this inbox forwards only a signature that covers nothing beyond the
profile's components and `content-type`, holds no key, pass secret or session, and has no
`access_token` in its query; any other is not forwarded (`carries_secret`).

## 4. Endpoints

| Call | Auth | Body → answer | Schemas |
|---|---|---|---|
| `POST /v1/instances` | none | `{domain}` → `202` | `instances-*` |
| `GET /v1/instances/{domain}/status` | none | → status | `instance-status` |
| `POST /v1/instances/{domain}/ping` | optional sdi-instance/1 | `{version, runtime, counts?, manifest_sha256?}` → `204`, or `200` when signed | `ping-*` |
| `POST /v1/instances/{domain}/listing` | sdi-instance/1 by that domain | `{listed}` → `{domain, listed, delisted_at, dormant_since, shown_from}` | `listing-*` |
| `POST /v1/receipts` | the JWS itself | `{receipt, ack?}` → `{ok, state, duplicate}` | `receipts-*`, `receipt-*` |
| `GET /v1/businesses` | none | query → `{businesses, next_cursor}` | `businesses` |
| `GET /v1/businesses/{domain}` | none | → listing + `outcomes` | `business` |
| `GET /v1/categories` | none | `?group=` → `{version, categories: [{slug, labels}], place_categories?, taxonomy?}` | `categories` |
| `GET /c/{id}` (0.2, SHOULD) | none | → one place category | `place-category` |
| `GET /v1/attributes` (0.2, SHOULD) | none | → `{version, keys, payments}` | `attributes` |
| `GET /v1/ranking` | none | `?version=N` → the rules | `ranking` |
| `POST /mcp` | none | one JSON-RPC message → its answer (§4.7) | `mcp-*` |
| `GET /v1/score-rules` (0.3, MAY) | none | `?version=N` → the agentic score's rules (§4.13) | `score-rules` |
| `GET /b/{domain}`, `GET /b/{domain}.json` (0.3, MAY) | none | → a check's result page, or its JSON (§4.13) | `check-result` |
| `GET /leaderboard.json` (0.3, MAY) | none | `?category=&country=&place=&page=` → businesses by agentic score (§4.13) | `leaderboard` |
| `GET /.well-known/ai-catalog.json` (0.3, SHOULD) | none | → the network's doors for agents (§4.14) | `ai-catalog` |
| `GET /openapi.json`, `GET /llms.txt` | none | → the public reads, described (§4.7) | |
| `POST /v1/persons` | sdi-instance/1 | `{request_id, email, agent?}` → `201` | `persons-*` |
| `POST /v1/presentations` | sdi-instance/1 | one of `pass`, `key`, `agent_key` → `200` | `presentations-*` |
| `POST /v1/passes` | the key | `{key, label?}` → `201 {pass}` | `passes-*` |
| `POST /v1/passes/revoke` | the pass, or a session | `{pass}` or `{pass_id}` → `{revoked: true}` | `passes-revoke-*` |
| `POST /v1/delegations` | session **and** sdi-agent/1 | `{pass}` → `201 {pass_ref, jkt, bound}` | `delegations-*` |
| `GET /v1/person` | session | → the person's own record | `person` |
| `POST /v1/person/contests` | session | `{evidence}` → `{id}` | `contests-*` |
| `POST /v1/person/unlinks` | session | `{business}` → `201 {business, stopped: true, since, by}` | `person-unlinks-*` |
| `POST /v1/person/unlinks/remove` | session | `{business}` → `{business, stopped: false}` | `person-unlinks-*` |
| `POST /v1/person/erase` | a session made in the last hour | `{confirm: "erase"}` → `202 {erasing: true}` | `person-erase-*` |
| `POST /v1/unlinks` | sdi-instance/1 | `{request_id, ppids?, presentations?}` → `200 {unlinked, items, open_items}` | `unlinks-*` |
| `POST /v1/recovery/start` | none | `{email, purpose}` → `202` | `recovery-start-*` |
| `POST /v1/recovery/finish` | none | `{email, code, purpose}` → session, or key and pass | `recovery-finish-*` |
| `POST /v1/reports` | sdi-agent/1 | `{receipt, out, why, pass_ref}` → `202` | `reports-*` |
| `POST /v1/reports/{id}/response` | sdi-instance/1 | `{answer: "dispute"}` → `{id, status, answer}` | `report-answer`, `case-answered` |
| `POST /v1/contests/{id}/response` | sdi-instance/1 | `{answer: "withdraw" \| "dispute"}` → `{id, status, answer}` | `contest-answer`, `case-answered` |
| `GET /me`, `GET /me/about` (SHOULD) | none, then an emailed code | a person's own page and the notice, HTML (§5.3) | |

Limits a network publishes under `limits` at `/v1/ranking` (the reference values): 600 signed
calls a minute per instance; 50 issuances a day per business (`409`s included); 10 passes a day
per key; 20 presentations per person per business per day, after which the last result is
answered again and nothing is recorded; 10,000 promises a day per business.

### 4.1 Registration and the ping

`POST /v1/instances {"domain": "inbox.example.com"}` answers `202 {domain, status, status_url,
manifest_url, message}` and queues verification: the network fetches
`https://<domain>/.well-known/agent-inbox.json`, which must have `spec` starting
`surfingdog-inbox/` and `instance` equal to `https://<domain>` (port 443, no path). It keeps the
manifest's `profile` (checked field by field, §4.6), `item_types`, `protocols` (a door only as an
`https` address written as RFC 3986 writes a URI, on a host name, never an IP address or a name a
URL parser reads as one, and with no user, and with no space, control character or hidden character
in it: a listing holds only the doors a card may hand on, §4.7. From protocol 0.2 a network keeps no
`mailto` address, or any other human channel, among them: those are never doors, §4.8) and
`receipt_keys`,
and fetches it again every six hours (weekly, once it has failed for 30 days, for as long as the
business is a member), and at once when a signed ping says it changed (below). A business
is a **member** when its status is `verified` or `unreachable` and it has a `verified_at`: it may
call the network and is scored every night. A member is **listed**, in the directory, unless it left
the directory or was set aside for silence (§4.5).

`GET /v1/instances/{domain}/status` answers `{domain, status, listed, delisted_at, dormant_since,
verified_at, last_checked_at, last_ping_at, fail_count, manifest_url, verification?}`: `listed` is
whether the directory shows it, and a member that is not listed has `delisted_at` (it left) or
`dormant_since` (it was set aside).

`POST /v1/instances/{domain}/ping` is sent hourly with
`{"version": "…", "runtime": "…", "counts": {"bookings", "orders", "quotes", "messages"},
"manifest_sha256": "…"}` (the last 24 hours; `counts` optional; each 0 to 10⁹). A ping keeps the
business **answering** for 24 hours, signed or not. `manifest_sha256`, optional, is the SHA-256 of
the manifest exactly as the inbox serves it, in lowercase hex; the network reads it on a signed ping
only. When it is not the manifest the network holds, and the network has not fetched that manifest
in the last ten minutes nor been asked to, it fetches it at once, so a changed profile shows within
minutes. A fetch asked for this way that fails counts for nothing: not towards `unreachable`, and it
does not end the business's answering spell. The network makes at most 20 such fetches a minute
across every business; a hint over that is dropped and not recorded, so the next ping may send it
again, and the regular fetch comes all the same.

- **Unsigned:** `204`, no body.
- **Signed** sdi-instance/1 by that domain's own key: `200` with
  `{ok: true, rules: {version, effective_at}, next_rules: {version, effective_at, url} | null,
  reports: [{id, receipt_sha, out, why, created_at, respond_by}], contests: [{id, evidence_id,
  out, created_at, respond_by}], standing: {score, tier, ranked}, listing: {listed, delisted_at,
  dormant_since}}` — the open reports and contests the business may answer (oldest first, at most
  200 each; a contest's `respond_by` is the last moment it may dispute it, §5.4), its standing in
  the last nightly snapshot, and whether it is listed (§4.5).
  Anyone can ping for any domain, so only the domain's own signature sees this.
- **A signature that fails** (or one by another listed domain) is a ping all the same: `204` with
  `Sdi-Signature: invalid; reason="<code>"`.

An inbox treats `200` and `204` alike as success. An unknown domain is `404`.

### 4.2 Receipts

`POST /v1/receipts {"receipt": "<compact JWS>", "ack": "<compact JWS>"}` (ADR-016 format; §6 below
for v2 claims). The receipt is verified against the `receipt_keys` of the issuer's manifest as the
network fetched it; an unknown `kid` makes it fetch the manifest once more.

| Answer | When |
|---|---|
| `201 {ok, state: "issued" \| "acknowledged", duplicate: false}` | a new receipt |
| `200 {ok, state, duplicate}` | already held: `duplicate: true`, or `state: "acknowledged"` when this adds the acknowledgement |
| `404 unknown_issuer` | the issuer is not a member (§4.1); a business that left the directory still publishes |
| `409 nonce_reused` | the issuer already sent a different receipt with this nonce |
| `422 bad_alg`, `bad_typ`, `malformed`, `unknown_key`, `bad_signature`, `bad_payload`, `not_yet` | the receipt (`not_yet`: `iat` more than 300 s ahead; there is no maximum age) |
| `422 unknown_ref` | an outcome whose `ref` names no promise the network holds: publish the promise first |
| `422 ack_<code>` | the acknowledgement |
| `429 too_many_receipts` | over 10,000 promises today, or over 32 outcomes for one item |

An inbox **retries** `404`, `429`, `5xx`, and `422` with `unknown_key` or `unknown_ref`; every
other refusal is final. It publishes an outcome's promise before the outcome. A network records
**arrival** (the first time it saw a receipt that verified) even on an attempt it refuses with
`422 unknown_ref`, `429` or `5xx`, so retrying never makes a receipt late.

### 4.3 The directory

`GET /v1/businesses?near=lat,lng&radius_km=10&category=&item_type=&language=&q=&open_now=true&limit=100&cursor=`
→ `{businesses: [listing], next_cursor}`. A listing has `domain`, `name`, `description?`, `city?`,
`country?`, `address? {street?, locality?, postal_code?, country?}`, `categories` (slugs of the
categories list), `tags`, `languages`, `item_types`, `protocols`, `hours? {timezone, weekly,
closures}` (closures that have not ended), `open_now` (`true`, `false`, or `null` when the business
published no hours), `services [{name, type}]`, `geo? {lat, lng}`,
`distance_km?` (near only), `url?`, `manifest_url`, `verified_at`, `last_ping_at?`,
`software? {version, runtime}`, `receipts {issued, acknowledged, customers?, last_at?}` (promises
only), `answering`, `online` (the same), `not_answering_since`, and, once the ranked order is in
force, `rank_pos`, `rank_shuffle` (a 16-hex-digit **string**) and `reputation {ranked, score, tier,
kept, broken, customers, verified_share, rules, rules_url}`. Nothing about any customer is ever
returned. `GET /v1/businesses/{domain}` adds `outcomes`, a count for every outcome code in §6. Only
listed businesses are returned; the detail of a business that left the directory, or was set aside,
is `404`, and the problem's `detail` says which.

The order and the cursor are ADR-017 §6; `ordering.json` holds the shuffle (the first 16 hex digits
of `SHA-256("<YYYY-MM-DD>:<business uuid>")`), one full snapshot's order and the cursors (base64url
JSON `{m, p}`; any other cursor is `410 cursor_expired`).

Every query parameter only leaves businesses out; the rest keep their order, and nothing a
business's profile says moves it (A2.5, A2.6). `near` keeps those within `radius_km`, each with its
`distance_km`. `category` is a slug of the categories list, found by its slug, a label or a synonym
in any language the list has, ignoring capitals and accents (`cabeleireiro`, `Hair & beauty` and
`hair-beauty` are one category); anything else matches a business's tags. `language` keeps a business
that speaks that language or a variant of it, by RFC 4647 basic filtering: `pt` keeps `pt` and
`pt-br`, `pt-br` keeps `pt-br` only. `q` keeps a business whose name, city, description, categories
(with their labels and synonyms in every language of the list), tags and services' names hold every
word of it, ignoring capitals and accents, each word anywhere in that text (`cabel` finds
`cabeleireiro`). A word is a run of letters and digits; a network ignores words of one letter and
may ignore words that say nothing about a business (the reference list: `an`, `and`, `are`, `as`,
`at`, `by`, `for`, `from`, `in`, `is`, `me`, `my`, `near`, `of`, `on`, `or`, `the`, `to`, `with`, `ao`,
`aos`, `com`, `da`, `das`, `de`, `do`, `dos`, `em`, `mim`, `na`, `nas`, `no`, `nos`, `os`, `ou`, `para`,
`perto`, `um`, `uma`). `q` is at most 80 characters and 8 words; a `q` with no word left to look for
is `400`. How well a business matches never orders anything. A search is a scan of text the businesses
wrote, so a network bounds the time one may take (the reference: 10 seconds, on every door); one it
cuts off is `503` with `Retry-After`. `open_now=true` keeps the
businesses open at the moment of the answer by the hours they published, in their own time zone, a
closure winning over the hours; a business that published no hours is left out, never shown as
closed. `open_now` is the network's answer at the moment it answered: a cached page (a minute or two
with `open_now=true`, a few minutes otherwise) may be that old, and `hours` has the whole week.

`GET /v1/categories` is the categories list, `{version, categories: [{slug, labels: {en, pt}}]}`,
the same for a day; the full list, with synonyms, is `vocab/categories.json`.

**Protocol 0.2.** A listing may carry what §4.10 lists: `source`, `claimed`, `proof`, `level`,
`has_inbox`, `doors`, `requestable`, `accepts`, `category`, `attributes`, `place`, `why` and `found`,
each optional. A network lists entries that are not members (§4.11), so `manifest_url` and
`verified_at` are optional; a member's listing always has both. The detail of such an entry adds
`facts` (§4.10) and has `outcomes: {}`, `receipts: {issued: 0, acknowledged: 0}`, `answering: false`,
`online: false` and `not_answering_since: null`. `GET /v1/businesses` takes more filters, and every one
of them only leaves businesses out:

| Parameter | Keeps |
|---|---|
| `attributes` | comma-separated keys of `GET /v1/attributes`, or `key=value` for one with values, at most 10: all hold |
| `country` | ISO 3166-1 alpha-2: a business located there, serving it, or shipping there |
| `price_band` | `2`, or a range `1-2`: its price band, 1 the cheapest, 4 the dearest |
| `accepts` | comma-separated kinds (`ask`, `quote`, `book`, `order`, `pay`) and payment tokens, at most 8: its live doors take every kind and it accepts every payment |
| `requestable` | `ask` or `quote`: a live door that declared that kind |
| `door_type` | comma-separated door types (§4.8), `platform` for any platform, at most 5: a live door of any of them |
| `level` | at that level or above (§4.9); `orderable` is `bookable`; below `askable` nothing is listed yet |
| `has_inbox` | `true`: with an inbox door; `false`: without one |
| `source` | comma-separated `member`, `registered`, `found`: any of them |
| `order` | `rank`, the published order (the default), or `nearest`, by distance, which needs `near` |

From rules version 7, `category` also takes a place category id (§4.10) and keeps every category
below it; a category the network does not know is `400 category_unresolved`, whose problem names up to
5 `candidates`. `q` also sets the band (§4.4): of the businesses it keeps, those whose name, categories
or services hold every word come before the rest, each band in the published order; every other
parameter leaves the order as it is. A version 7 page is at most 1000 places deep; past that is
`400 page_too_deep`, and the page that reaches it has no `next_cursor`.
`GET /v1/categories?group=<slug>` adds `place_categories: [{id, label, parent}]` (that group's place
categories, `parent` null at the taxonomy's top) and `taxonomy: {name, release, licence, url}`.

### 4.4 The rules

`GET /v1/ranking` is the version in force; `?version=N` any version ever published, for ever
(unknown: `404 not_found`). A version is announced at least 15 days before it takes effect: the
version in force carries it in `next: {version, effective_at, url}`, and signed pings in
`next_rules`. Version 3 (network rules 0.1) publishes `{version, rules, status, published_at,
effective_at, summary, order, score, weights, timing, verified, tiers, limits, never_used,
changelog, next}` with every number a network may choose; `status` is `announced`, `in_force` or
`retired`. The schema is `ranking`. Version 5 (network rules 0.1.2, ADR-017 Amendment 2) adds, among
others, `timing.contest_days` and `weights.contest_weighs` (§5.4). A network puts version 5 in force
the moment it publishes it when no more than one business is a member of it then, and otherwise at
00:00 UTC on the sixteenth day after the day it published it. Version 6 (network rules 0.1.3, ADR-017
Amendment 3) adds `amendments` and `refunds` (§6.1) and takes effect the same way. While
a network scores no customer (§5.2), every version from 3 that it serves also carries
`customer_scoring`, a sentence saying so.

Version 7 (network rules 0.2.0, protocol 0.2) keeps every member of version 6 and lists agent-ready
businesses with their doors. Its `order` adds `rule`, `bands`, `reach`, `within_reach`, `newcomers`,
`one_place`, `nearest`, `found_tier`, `sources` and a `filters` every version 7 has. In short: every
filter narrows the list and never reorders it; among the businesses left, those whose name,
categories or services match the words or the category asked for come before those that match in
their description alone; then comes reach, a member's inbox that answers (ours or any compatible
inbox), then other live agent doors by level (payable, then bookable or orderable, then askable), then the rest;
within each, kept promises (a score of 0.40 or more) and the daily shuffle as before; every 5th place
of the whole order goes to an answering newcomer, placed once when the hour's order is frozen, so no
filter and no page moves anyone; a business has one place. Until version 7 takes effect, entries the
network found and businesses registered without an inbox appear in a separate tier after every
member, so no member's position changes. Version 7 is always announced 15 days ahead, whatever the
number of members. The schema is `ranking`; `vectors/ordering-v7.json` holds the order, the
newcomers' places and pages.

**A reader accepts a version newer than it knows.** It reads `version`, `status`, `effective_at`,
`summary` and `next`, which every version has, ignores the rest, and takes the receipt claims as
`claimsFromVersion` says (`6` from version 6 on). `readRankingDocument` in `@surfingdog/spec` does
exactly this: a version it knows must match its schema whole; a newer one is read leniently.

A network that publishes rules of its own (any network but one following ADR-017) says what it
offers in `protocol` (§10), and that decides what it is sent, whatever its version. For the rest:
an inbox reads it daily: it sends every receipt (§6) to a network whose rules, in force or
announced in `next`, are version 3 or later. To the others it sends only the promises v1 already
knew, `confirmed` and `paid`, whose v1 claims are unchanged (a v1 reader ignores the members it
does not know); acceptances and outcomes wait for the network to move to version 3. What version 6
adds (§6.1) — amendments and refunds' receipts — goes likewise only to a network whose rules, in
force or announced, are version 6 or later, and waits for the others; every receipt of a promise
that changed goes only once version 6 is **in force** there (§6.1).

### 4.5 Leaving the directory, and silence

A business leaves the directory, or comes back, with
`POST /v1/instances/{domain}/listing {"listed": false}` (or `true`), signed sdi-instance/1 by that
domain's own key (another domain's signature is `401 unknown_instance`). The answer is
`200 {domain, listed, delisted_at, dormant_since, shown_from}`: `shown_from` is when a listed
business is in the directory's hourly order, now or the next `:00`, and null when it is not listed.
Asking for what already holds changes nothing; at most 10 changes in 24 hours, then
`429 rate_limited`.

- Leaving is at once: the business is gone from `GET /v1/businesses` and its detail is `404` (a
  cached page may show it for a few minutes more), and it is left out of the next hourly order and
  of `/v1/stats` (its pings no longer count it online, nor its activity). Coming back, it is in the
  order by the next `:00`, where its record puts it.
- It stays a member: it pings, publishes receipts, asks for and presents persons, answers reports
  and contests, and is scored every night, exactly as before. Its verification date does not change.
- An inbox that cannot sign says the same in its manifest: `"directory": {"listed": false}`. The
  network acts when what the manifest says changes: `false` leaves; `true`, or saying nothing, comes
  back from a leaving the manifest made. It never undoes a signed call, and a signed call may undo
  what the manifest did.

**Silence** (from rules version 5). A listed member with no ping that counts (§4.1: signed, once it
has signed) and no good fetch of its manifest (changed or `304`) for 90 days is **set aside**: out of
the directory like a business that left, still a member, still scored, nothing taken from its
record. A business that left the directory is neither written to nor set aside while it is out.
When the manifest's `profile.contact_email` is one address, the network writes to it at 60 days of
silence (and never sets the business aside sooner than 30 days after that warning was sent), and
again with the reason when it is set aside; it writes to any one address at most once a day, and a
notice that has to wait, or could not be sent, keeps the business listed that much longer. The first
ping that counts, or good manifest fetch, brings it back, by the next `:00`.

### 4.6 The business profile

The manifest's `profile` is what the directory shows about a business, and everything in it is
optional apart from `name`: `description` (500 characters), `categories`, `languages`, `address
{streetAddress, addressLocality, postalCode, addressCountry}`, `geo {latitude, longitude}`, `url`,
`contact_email` (never shown), and

- `hours`: `{"timezone": "Europe/Lisbon", "weekly": {"tue": [["09:00", "13:00"], ["14:00",
  "19:00"]], "sat": [["09:00", "13:00"]]}, "closures": [{"from": "2026-12-24", "to":
  "2026-12-26"}]}`: the inbox's own weekly hours and closures, as it keeps them, with the IANA zone
  every time and date in them is in. A window is `[opens, closes)`, `HH:MM`, opening before it
  closes (no overnight windows), at most six a day; a day left out is closed. A closure is whole
  days, both included.
- `services`: `[{"name": "Haircut", "type": "booking"}]`, at most 30: each service's name (80
  characters) and how it is taken (`booking`, `order` or `quote_request`). Prices and durations stay
  at the inbox, where they are current.
- `categories`: slugs of the categories list ([`vocab/categories.json`](../../packages/spec/vocab/categories.json):
  28 slugs, each with English and Portuguese labels and synonyms). A network reads a label or
  synonym as its slug, and keeps anything else a profile names as a free tag.
- Protocol 0.2 adds:
  - `place_category`: `{"primary": "hair_salon", "alternates": ["beauty_salon"]}`, place category
    ids (§4.10), at most two alternates. A network keeps an id it knows; one it does not know, or one
    it does not list, it drops alone.
  - `attributes`: `{"walk_ins": true, "cert": "b_corp"}`, keys of `GET /v1/attributes`. A network
    keeps a key that applies to the business's categories and drops one that needs a proof it
    cannot check yet.
  - `price_band`: 1 to 4. `currencies`: up to 5 ISO 4217 codes.

The manifest may also carry `claims`, `{"<network host>": "<token>"}`: how an inbox proves to a
network that the manifest is its own when it registers or claims a listing there (§4.12).

A network checks each field alone and drops a bad one alone; a bad field never fails the manifest,
the verification or the listing. It removes control characters, the characters that reorder text
(Unicode's `Bidi_Control`) and the invisible tag characters (U+E0000 to U+E007F), so that what a
reader sees is what the text says, collapses white space and cuts text to length; keeps at most 10
slugs and 10 tags (a tag is at most 40 characters, or dropped); keeps a language tag only in BCP
47's shape; keeps `url` only as an absolute `http` or `https` address with no space, control or
hidden character in it; keeps `hours` only with a zone it knows and at least one good window, and
within them drops a day that is not `mon`…`sun`, a day with more than six windows, a window that is
not two `HH:MM` opening before closing, and a closure that is not two real dates in order (the
calendar has no year 0), merges windows that overlap, and forgets closures that have ended. Hours it
cannot keep whole it drops whole: without its closures, a business would show open on a day it said
it is closed. `vectors/profile.json` holds the cases. Nothing in a profile is scored, and nothing in
it orders the directory (§4.3).

### 4.7 Assistants

A network SHOULD let an assistant find businesses without a key or a session, through three doors
that give the same answer: `GET /v1/businesses` (§4.3), an MCP server at `POST /mcp`, and two
documents, `GET /openapi.json` (OpenAPI 3.1 of every public read) and `GET /llms.txt` (the same in
plain words, MCP first, in the llms.txt layout). Every answer is the same whoever asks, and none of it
books or orders anything: a result names the business's own inbox, and the assistant goes there.

**The MCP server** is stateless: it issues no session and opens no stream. It serves both eras of the
protocol on the one endpoint. A request that carries the per-request envelope in `params._meta`
(`io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities`) is served
at that revision (2026-07-28): it has no `initialize`, `server/discover` says what is served, it
carries `Mcp-Method` (and `Mcp-Name` on `tools/call`), and a header that is missing or disagrees with
the body is `400` with `-32020`; an envelope naming a revision the network does not serve is `400`
with `-32022` and `data: {supported, requested}`; a list result carries `ttlMs` and `cacheScope`.
Otherwise `initialize` negotiates one of 2025-11-25, 2025-06-18, 2025-03-26 or 2024-11-05, and
`MCP-Protocol-Version`, when sent, must name one of them. One JSON-RPC message per `POST` (a batch is
`400`, `-32600`); a notification or a response is `202` with no body; `GET` and `DELETE` are `405`;
`Content-Type` must be `application/json` (else `415`); a body is at most 16 KB (`413`). These
refusals are JSON-RPC errors with `id: null`, never problem documents. A method's own failure is a
JSON-RPC error on `200`, and a tool's own failure (arguments it cannot take, a business that is not
listed) a result with `isError: true` and a plain sentence, so the assistant can correct itself. CORS
is open to every origin, without credentials.

| Tool | Arguments | `structuredContent` |
|---|---|---|
| `search_businesses` | `query?`, `near? {lat, lng, radius_km?}`, `category?`, `item_type?`, `language?`, `open_now?`, `limit?` (1–20, 10), `cursor?` | `{businesses: [card], next_cursor, rules: {version, url}}` |
| `get_business` | `domain` | a card, with `address?`, `hours?` and `outcomes` |
| `list_categories` | none | `GET /v1/categories` |
| `list_attributes` (0.2, optional) | none | `GET /v1/attributes` |
| `register_business` (0.2, optional) | the business, its doors and a proof (§4.12) | the status, the card, what was dropped |
| `update_business` (0.2, optional) | a claim token or a proof, and what changes (§4.12) | the same |
| `check_business` (0.3, optional) | `url`: a website or a bare domain | a check's result (§4.13) |

Protocol 0.2: `search_businesses` takes `attributes`, `country`, `price_band`, `accepts`,
`requestable`, `door_type`, `level`, `has_inbox`, `source` and `order`, as `GET /v1/businesses` does
(§4.3; arrays where the query is comma-separated), and every one only leaves businesses out. A card
may carry every member of §4.10, and `human_contact_only`, which no network sends while nothing below
askable is listed. A card's `inbox` is present whenever `has_inbox` is true or absent. `get_business`
adds `facts` and `rules: {version, url}`. `MCP_TOOL_NAMES` stays the three tools above; the optional
ones are `MCP_OPTIONAL_TOOL_NAMES`. `list_attributes` is read-only like the others;
`register_business` and `update_business` change what a network holds and are annotated so.

Spec 0.3: `check_business` (in `MCP_OPTIONAL_TOOL_NAMES`) checks how far an agent can go with one
business's website and answers `GET /b/{domain}.json`'s shape (`schemas/mcp-check-business-*.json`).
It may queue a read of the site within the network's daily budget, so it is annotated not read-only,
not destructive, idempotent and open-world; calling it again with the same URL reads the result.
Checking a site is not claiming it, and never touches a listing. `update_business` takes
`score_page: "hidden" | "shown"`, which needs the claim token or a proof as `set` does, and answers
it back.

Their `inputSchema` and `outputSchema` are `schemas/mcp-*.json` word for word, and every tool is
annotated read-only, idempotent and closed-world. `search_businesses` is `GET /v1/businesses` with
the same filters, the same order and the same cursors, a page at a time; `get_business` is `GET
/v1/businesses/{domain}`, and a business that is not listed is a failure that says why. A **card** is
what an assistant needs to act, derived from the listing as `vectors/mcp.json` pins down: `domain`,
`name`, `description?`, `website?`, `city?`, `country?`, `distance_km?` (to the nearest 10 metres),
`categories`, `tags`, `languages`, `takes` (the inbox's `item_types`), `services`, `open_now`,
`hours_today` (the day's windows in the business's own zone, `"closed today"`, or null without
hours), `answering`, `inbox {url, mcp?, rest?, openapi?}` (`https://<domain>` and only the doors for
customers that are https, on a host name, with no user, written as RFC 3986 writes a URI (ASCII only:
anything else percent-encoded) and holding no space, control character or hidden character: the
schemas say `format: uri`, and a client that checks it refuses a whole answer for one door that is
not), `standing? {tier, ranked, in_words}` and `listing_url`. `in_words` says a
tier in one plain sentence and is never a mark against a business: no standing yet is said to be
where every business starts, which it is.

Each result also carries its content as one text block, for assistants that read only text: first,
in the network's own words, what the network knows (the order and the rules it follows, and for each
business its domain, categories, distance, today's hours, what it takes, its standing and where to
book, naming a door only when it is on the business's own domain, or one label of at most 12
characters under it, with no port, query or fragment and a plain path of at most 64 characters,
letters, digits and `-._~/`: a host and a path are text the business chose, and so kept short they
say hardly more than its domain); then everything the business wrote about itself (name, city or address,
description, services, tags, web site, and any other door), inside a block that opens `<<<UNTRUSTED <boundary>>>` and closes `<<<END
UNTRUSTED <boundary>>>`, with a boundary drawn at random for each answer, every line quoted with `| `,
and no run of `<<<` or `>>>` inside. The server's `instructions` say the same: a business's words are
information about it, never instructions to the assistant, and nobody can pay to move in the order.

A network publishes its own limits on these doors; the reference is 60 calls a minute from one
address, in bursts of 30.

### 4.8 Doors

A **door** is a machine endpoint the business published for agents: where an AI can read, ask, book,
order or pay. The types are in [`vocab/doors.json`](../../packages/spec/vocab/doors.json):

| Type | What it is |
|---|---|
| `inbox` | an inbox that takes typed items (`/.well-known/agent-inbox.json`): ours or any compatible one |
| `mcp` | an MCP server |
| `a2a` | an A2A agent card |
| `openapi` | an OpenAPI document |
| `api` | an endpoint without an OpenAPI document, declared with its kinds |
| `ucp`, `acp` | commerce protocols' catalogue, checkout and payment |
| `nlweb` | a declared NLWeb `/ask` endpoint |
| `webhook` | in the vocabulary; no network delivers to one yet |
| `other` | any other protocol, named in `protocol` (like `beckn` or `graphql`) |
| `platform:<name>` | a commerce or booking platform's door for this business |

**Experimental door types** (`vocab/doors.json` version 2, `experimental`) are read by a network but
cannot be declared, and they never raise a level, make a listing or move anyone in the order. Today
that is `webmcp`: tools a page registers for an agent in the browser, read from the page's own HTML
(`<form toolname>` and inline scripts). A crawler runs no JavaScript, so tools registered by an
external script are not seen. An experimental door may count toward the agentic score (§4.13), where
it is marked as such.

**Never a door:** mail, phone, SMS, messaging, forms and web pages (`mailto`, `tel`, `sms`, `whatsapp`,
`form`, `page`), nor an address with a scheme or host of a human channel (`refused_url_schemes`,
`refused_hosts`). An inbox's email-in, its web page and its form are never doors: a network never
declares, shows or delivers to them, and `network-check` fails a network that lists one (§10.2).

A door shows `{type, url, level, status, kinds, src, protocol?, checked_at?}`:

- `status` is `live` or `failing`. A door that failed 3 checks in 7 days is `failing`, counts for
  nothing in the order and takes no requests; 30 days failing, it is `gone` and no longer shown.
- `kinds` are what an AI can do through it: `ask`, `quote`, `book`, `order`, `pay`. `src` says where
  they come from: `declared` by the business (its inbox's `item_types`, a UCP or ACP manifest, an A2A
  card's skills, a door declared at registration or in a manifest), or `seen` (an MCP server's tool
  names, a platform's storefront tools). Both count for the level and for `accepts`.
- `requestable` lists the kinds a live door **declared** it answers (`ask`, `quote`): what the crawler
  saw alone never makes a door requestable.

**A door on another host.** A door whose host is not the business's domain or one of its subdomains
(a platform's door included) counts for the level and is shown only when its own document names the
business's domain: the MCP server card's or the A2A card's URL, the UCP profile, an OpenAPI `servers`
entry, an inbox manifest whose `instance` is `https://<domain>`, or a file the network names at the
door host's `/.well-known/` that lists the domain. Until then the network keeps it as declared, at no
level, and does not show it. A claim proved by `code` (§4.12) declares no door on another host.

**Probing reads and never acts.** For MCP servers at 2026-07-28 or later a network reads the server
card or calls `tools/list` only, and calls `initialize` for older versions alone. It never makes a
`tools/call`, a write call, an A2A `message/send`, a checkout, a form submission or a login.

### 4.9 Readiness levels

A business's level is the highest level among its live doors.

| Level | Meaning | Signals |
|---|---|---|
| `listed` | known to exist; human contact only | no agent door |
| `readable` | an AI can read its facts or catalogue | schema.org data, llms.txt, MCP read-only tools, NLWeb, a UCP or ACP catalogue, OpenAPI read operations |
| `askable` | a door declares a request kind it answers (ask or quote) | an inbox; an A2A skill; an MCP tool or an API operation declared as ask or quote |
| `bookable` (or `orderable`) | a door can book, or create an order or a cart | inbox booking or order; UCP or ACP checkout; declared MCP or API write operations |
| `payable` | the agent can also pay | UCP payment handlers, ACP delegated payment, AP2, x402 |

Levels come from the network's own probes; what a business declares is a hint until a probe confirms
it. A door behind a customer account never raises a level. **Agent-ready** means `askable` or above.
A network lists businesses below `askable` only after its own checks for that (a working claim,
correction and removal, and the fields each jurisdiction asks for); until then a filter below
`askable` returns nothing. A network never shows a number for a level, only its name.

### 4.10 Listing fields

Every value a listing shows has a **source**: `declared` (the business said it: its manifest, its
registration, its own structured data), `seen` (on its own pages or at its own door) or `probably`
(read from its pages by a model or a heuristic). A `probably` value is shown with `~` and **never
counts in a filter**, except page language. A filter reads `declared` and `seen` values alone.

| Member | Meaning |
|---|---|
| `source` | `member` (through its inbox), `registered` (by the business, with a proof, §4.12) or `found` (by the network, §4.11) |
| `claimed`, `proof` | whether the business claimed the entry, and with which proof: `domain`, `key`, `platform` or `code` (never "verified") |
| `level` | §4.9, by name |
| `has_inbox` | it has an inbox door, ours or any compatible one |
| `doors` | §4.8 |
| `requestable` | §4.8 |
| `accepts` | `{kinds, pay?}`: the kinds its live doors take, and the payments it accepts (tokens of `GET /v1/attributes`' `payments`: methods, wallets and the ways an agent itself pays) |
| `category` | `{primary, alternates, path, group?}`: place categories, each `{id, label, src}`; `path` is the primary's ancestors, root first; `group` its slug of the categories list |
| `attributes` | `{key: {v, src}}`, keys of `GET /v1/attributes` |
| `place` | for entries that are not members: `{locality?, region?, country?, kind, service_area?, ships_to?}`; `kind` is any of `storefront`, `service_area`, `online`; a service area is a radius (at most 300 km) or up to 50 countries |
| `why` | why it is in this place of the list, in plain words |
| `found` | §4.11 |
| `facts` (detail only) | every displayed value as `{field, v, src, url?, at, via?}` |

**Categories.** A listing's `categories` stay the slugs of the categories list (its 28 groups). A
place category is an id of the Overture Maps Foundation's **Overture Place Categories** taxonomy
(licensed CC BY 4.0), which a network names with its release in `taxonomy`; each group covers some of
its subtrees. `GET /c/{id}` answers one: `{id, label, parent, path, group?, regulated?, taxonomy}`, or
`404`. A network may leave whole categories unlisted for entries that are not members (regulated
trades, for instance); `regulated` says why, and members are not affected.

**Attributes.** [`vocab/attributes.json`](../../packages/spec/vocab/attributes.json) lists each key with
its group, the categories it applies to, how a crawler may read it (`declared`, `seen` or `never`, for
one derived from published hours), whether it needs a proof a register would give (such a key is listed
with `filterable: false` and not shown until one exists), and labels in five languages. Accessibility
is read from an explicit statement alone, never inferred. Free tags are text for `q`; only vocabulary
attributes filter.

**Place, hours, languages, money.** A member keeps `city`, `country` and `address` (§4.6). Another entry
has `place`; H3 cells are not part of 0.2. Hours and their zone are as §4.3 says; a business without a
zone is left out of `open_now`. `languages` are BCP 47 tags; the language of its pages counts, as
`probably`. `currencies` are ISO 4217; `price_band` is 1 to 4.

**Filters** are §4.3's, and every one only leaves businesses out.

### 4.11 Crawled entries

A network may list businesses it found on their own websites. Such an entry:

- shows only facts the business published on its own site or at its own doors, each with its source
  and date (`facts`), and **never a phone number, an email address, or the name of a person other
  than the business's own name**;
- shows the town, region and country, never the street, while it is unclaimed; its distance is in
  whole kilometres, at least 1. While it is unclaimed, a network searches and sorts it by a coarse
  point (a cell a few kilometres wide, or its town's centre), never its exact one; a search radius
  under 5 km counts as 5 km for it; and its service area shows a radius, never a centre;
- carries `found: {note, checked_at, about_url}`, where `note` is
  `found on its own website · not a member · checked <YYYY-MM-DD>` and `about_url` is the network's
  page for businesses: why it is there, how to correct or claim it, how to opt out;
- is listed only at `askable` or above (§4.9);
- is not listed while it is unclaimed and its own site tells AI systems not to use or train on its
  content (`ai-input=no` or `ai-train=no` in its robots.txt `Content-Signal`, or the same wish in
  `Content-Usage`), from the crawl that reads that wish;
- leaves the directory within 24 hours of an opt-out at that page or through `update_business`
  (§4.12), and is not stored again while the opt-out stands;
- loses a fact the network has not seen for 180 days, and leaves the directory, and the network's
  store, once the network has not checked it for 180 days;
- is served with `X-Robots-Tag: noindex` on its detail.

`vectors/listing.json` holds what was crawled and the card a network derives from it.

### 4.12 Claims

A network may offer two tools to the business's own AI: `register_business` declares a business and
proves it speaks for it; `update_business` claims, corrects, switches off or removes a listing. Their
shapes are `schemas/mcp-register-business-*.json` and `schemas/mcp-update-business-*.json`.

`register_business` takes the domain, the name, a category (one, and at most two more), a one-line
description, where it is (a storefront, a service area or online, with what each needs), languages,
and agreement to the network's rules and listing terms; doors, hours, currencies, a price band,
attributes, payments and other names are optional. A network checks each part alone: a human channel
offered as a door, a contact detail in a text, a key outside its vocabulary or a category it does not
list is **dropped** and named in `dropped: [{field, reason, detail}]`, and the call fails only when a
required part is missing. Its answer has a `status`: `listed`, `not_agent_ready` (claimed, below
`askable`), `probe_pending` (doors declared, not yet probed), `proof_needed`, `code_sent`, `member`
(listed through its inbox, which corrects it through its profile) or `refused`.

**Proof** carries a label, strongest first:

| Label | Method | How the network checks it |
|---|---|---|
| `domain` | `well_known` | a line `<prefix>=<token>` in a file the network names at `https://<domain>/.well-known/` |
| `domain` | `manifest` | the manifest member `claims` maps the network's host to the token |
| `domain` | `dns` | a TXT record at `_<prefix>.<domain>` holding `<prefix>=<token>` |
| `key` | `key` | a signature, by a key the business publishes (its manifest's `receipt_keys`, or its JWKS), over `<prefix>:v1:<network host>:<domain>:<challenge id>`; EdDSA (Ed25519) or ES256 |
| `platform` | | a platform's own proof that the business holds the store or account |
| `code` | `code` | a code sent to an address at exactly the domain (not a subdomain) that the owner types, never one read from the site; never for a domain whose addresses a public mail or internet provider gives out |

A network names its own well-known file and prefix; the reference network's are
`surfingdog-claim` (`/.well-known/surfingdog-claim`, `_surfingdog-claim.<domain>`,
`surfingdog-claim:v1:…`). Without a proof the answer is `proof_needed` with a `challenge: {id, token,
expires_at, ways}`, each way saying exactly what to put where; the next call carries
`proof: {method, challenge_id, …}`. When the proof holds, the answer carries a **claim token**
(`sdc_` and 43 base64url characters), good for 90 days on that listing, which proves it again in
later calls. A proof at least as strong as the listing's takes it over; a weaker caller is refused.
Every fresh proof (a token is not one) revokes every other live token on the listing whose label is
as strong or weaker. When a different claimant takes a listing over, what the earlier one declared,
doors included, is dropped. A `code` claim is held by its address: a code sent to another address
does not take it over.

A claim proved by `code` declares no door on another host (§4.8) and cannot switch off or remove an
entry the network found.

A network counts challenges, checks and codes per caller as well as per domain, so a stranger's calls
never use up what the business needs to prove its domain, and it does not say whether an address was
sent a code before.

`update_business` needs a claim token or a proof at least as strong as the listing's, **opt-out
included**, for a listing that is claimed or registered. An opt-out without a proof, through the tool
or at the network's page for businesses, stops the crawling and removes an unclaimed entry the network
found, at once; it never removes a claimed or registered listing. A business that opted out comes back
with a `domain` or `key` proof; a removal the network made itself (for abuse, or on a legal request)
stays, and the answer is `refused`. `listing: "off"` hides it from search and keeps it in the index.

### 4.13 Capabilities and the agentic score

A network MAY say, business by business, how far an AI agent can go with it through the doors it
published, and sum that up as an **agentic score** from 0 to 100. It is about capabilities, not
standards: whatever the door (an inbox, MCP, A2A, an API, UCP or ACP), can an agent message, book,
order, cancel or negotiate here, and the journey around those.

**The vocabulary** ([`vocab/capabilities.json`](../../packages/spec/vocab/capabilities.json)) lists 19
capabilities in a fixed order, which breaks every tie: `find`, `catalogue`, `availability`,
`message`, `negotiate`, `book`, `order`, `pay`, `change`, `cancel`, `track`, `return`, `receipt`,
`feedback`, `subscription`, `vouchers`, `waitlist`, `support`, `policies`. Five lead every result:
`message`, `book`, `order`, `cancel` and `negotiate`. A capability is `yes`, `partial` (met through a
door behind a customer account, or payment described but not done by the agent), `no`, or `na`
when it does not apply to that kind of business.

**Evidence** is a ladder: `declared` (the business's own site or door says so), `tested` (a probe
tried it) and `proven` (agents reported using it). Version 1 of the rules produces `declared` alone.
A capability read from a tool's name, a page's words or a page's marker is still `declared`, with a
`basis` saying which (`tool_name`, `skill`, `operation`, `item_types`, `protocol`,
`structured_data`, `page`, `manifest`): the business published that name. A `probably` value never
counts, a failing door counts for nothing, and a door on another host counts once its own document
names the business (§4.8).

**Profiles and what does not apply.** A business is scored for its kind, and what does not apply to
that kind leaves the denominator: a plumber is not marked down for having no catalogue.

| Profile | Applies |
|---|---|
| `appointments` (salons, wellness, classes, tours) | find, catalogue, availability, message, book, change, cancel, pay, policies, feedback |
| `food` (restaurants and food) | find, catalogue, availability, message, book, order, change, cancel, pay |
| `trades` (trades and quote-led services) | message, negotiate, book, change, cancel, pay, receipt |
| `shop` | find, catalogue, availability, order, pay, change, cancel, track, return, receipt |
| `stay` (places to stay) | availability, book, change, cancel, pay, message, policies |
| `memberships` (gyms and memberships) | find, catalogue, order, book, subscription, cancel, pay |
| `general` (type unknown) | find, catalogue, message, pay, cancel, policies |

Each profile names the category groups it covers; a business without a category the network can
read from the business itself is scored by its doors' signals, or as `general`.

**Groups and weights** (rules version 1): `core` 40 (message, book, order, pay), `after` 30 (change,
cancel, return, subscription, receipt), `state` 10 (availability, track), `negotiate` 5, `readable`
10 (catalogue, policies), `find` 5; feedback, vouchers, waitlist and support are shown and not
counted. `yes` earns two halves, `partial` one, `no` none. The arithmetic is integer, the same in
every language:

```
For profile P: A_g = members(g) ∩ applicable(P), for each group g with weight > 0. A group with A_g = ∅ is dropped.
possible = Σ_{g: A_g≠∅} W_g
N        = Σ_{g: A_g≠∅} W_g × s_g × (60 / |A_g|)      where s_g = Σ_{c∈A_g} halves(c)   (|A_g| ≤ 5; 60 = lcm(1..5))
D        = 120 × possible
score    = (100 × N + D/2) div D                       (round half up; 0..100)
grade    = A ≥ 80, B ≥ 60, C ≥ 40, D ≥ 20, E < 20
```

A capability's displayed weight is `W_g / |A_g|` to one decimal place. **Fixes** are each applicable,
weighted capability that is not `yes`, scored again as `yes`: the points it would add, by points,
then group order, then vocabulary order; a fix worth nothing is left out. A fix's text in the rules
may hold `<door>`, which a network replaces with " on your <door label> door at <url>" when the
business has a live agent door, and with nothing otherwise. `scoreOf`, `fixesOf` and
`capabilityWeightOf` in `@surfingdog/spec` are the reference; `vectors/score.json` holds the worked
cases, a salon at 51 (C), a restaurant at 74 (B), a plumber at 33 (D), a shop at 53 (C), among them.

**The rules are published and versioned** like the directory's own: `GET /v1/score-rules` is the
version in force and `?version=N` any version ever published (`404` for one that never was), shaped
as `schemas/score-rules.json` ([`vocab/score-rules-v1.json`](../../packages/spec/vocab/score-rules-v1.json)
is version 1).

**The score never changes the directory's search order** (§4.4), and nobody can pay for a score or a
place. It is not a certification: it is what was read on the business's own site and doors on the
date shown, each capability with its door, its source and its date.

**Checks and result pages.** Anyone may ask a network to check any website (`check_business`, or a
form at the network's `/check`); a check is read within the network's daily budget and never claims,
lists or changes a listing. Its result is `GET /b/{domain}` (a page) and `GET /b/{domain}.json`
(`schemas/check-result.json`): the state (`not_checked`, `queued`, `checking`, `scoring`, `done`,
`blocked`, `failed`, `hidden`, `not_checkable`), and when done the score, the grade, the profile,
the five lead answers each with its door and date, every capability, the fixes, a plain message the
owner can hand to whoever runs the site, and the rank.

**Ranks and leaderboards.** A leaderboard (`GET /leaderboard.json`, `schemas/leaderboard.json`) orders
by score, then the most recent check, then domain, by category group, country and place; it counts
every business checked that its owner has not hidden and that is of a kind the directory lists. It
is a separate list from the directory, and it says so.

**Naming and indexing.** A business is **named** on leaderboards, and its result page may be
indexed, when it is agent-ready (`askable` or above, §4.9); others are counted, not named, and their
result pages carry `noindex`: no unrequested public grades. Claiming a listing, or showing the badge,
does not name a business that is not agent-ready. A business whose own site tells AI systems not to
use or train on its content (`ai-input=no` or `ai-train=no` in a `Content-Signal` line of its
robots.txt, or the same wish in `Content-Usage`) is never named or indexed, and its badge carries no
number; the network applies a new crawl's `no` at once. A member of the network is not affected. A
kind of business the directory does not list gets a result page, never indexed and never ranked.

**The owner decides.** Checking is not claiming. The owner, with a claim token or a proof, can claim
and correct the listing, hide the result (`update_business` with `score_page: "hidden"`, which takes
it out of ranks and leaderboards too) or opt out of crawling altogether (§4.5, §4.12). A **badge**
(`/badge/{domain}.svg` and a snippet linking to the result page) exists for the owner to place on
their own site if they wish; a network never places it anywhere.

### 4.14 Discovery documents

So an agent or a model can find a network's doors without being told, a network SHOULD serve:

- **`/.well-known/ai-catalog.json`**, an ARD catalog (`specVersion`, `host`, `entries[]` of
  `{identifier, displayName, type, url, description?, tags?, capabilities?}`) listing its MCP server
  card (`application/mcp-server-card+json`), its A2A agent card (`application/a2a-agent-card+json`),
  its OpenAPI document, its rules and its llms.txt, every `url` https
  (`schemas/ai-catalog.json`, read loosely);
- **`/.well-known/mcp/server-card.json`**: the MCP server's name, version, protocol revision,
  endpoint, its tools exactly as `tools/list` gives them, and its instructions;
- **`/.well-known/agent-card.json`**: an A2A agent card, when the network answers A2A (a read-only
  `message/send` for search and check is enough);
- **`robots.txt`** with a `Content-Signal` line saying what its public pages may be used for.

Tool descriptions say plainly what the directory is and when to use it. They never tell an agent to
call the network every time.

## 5. Persons and passes

### 5.1 First contact: `POST /v1/persons` (sdi-instance/1)

```json
{ "request_id": "01M34AVYNXTNSE2RC495H3W8QS", "email": "rita@example.com",
  "agent": { "label": "Example Assistant", "jkt": "…", "directory": "https://…" } }
```

`request_id` is 1–64 of `[A-Za-z0-9._:-]` (the inbox sends the item id); `email` is required and
normalised (§2.1: refused is `400 bad_payload`, "no email, no issuance"); `agent` is optional, and
its `label` names the first pass. Answers:

- `201 {key, pass, presentation, ppid, person}`: a new person. The inbox emails the key to the
  customer and hands the pass back to the carrying agent.
- `409 person_exists`: the network already knows a person with this address. Nothing is handed
  out; the agent must present the person's own pass or key (recoverable by email).
- `429 rate_limited`: the business's 50 issuances of the last 24 hours are used.
- The same `request_id` again, within 7 days, gets the same answer (`201` with the same key and
  pass, or `409`); with a different email it is `400 bad_payload`.

### 5.2 Presenting: `POST /v1/presentations` (sdi-instance/1)

Exactly one of `pass` (the secret form), `key` (exchanged for a pass, returned in `pass`; the same
key and agent get the same pass back for 24 hours) or `agent_key` (§3.1); `purpose` `"request"`
(default) or `"ack"` (then `sha`, the receipt's `base64url(SHA-256(JWS))`, is required); optional
`email` (the item's address), `agent` (as in §5.1) and `resume` (§5.5).

`200 {presentation, ppid, person, pass?, email_match?}`, where `person` is
`{tier, score, kept, broken, businesses, email_proven, since, unusual_use, rules, scored}` and
`email_match` is `proven` (it is the person's address, proven by code), `unproven` or `no`.
`scored` is `false` while the network scores no customer (ADR-017 A2.10): `person` is then as for a
person with no record (`tier` `new`, `score`, `kept`, `broken` and `businesses` 0), and says nothing
about the person's outcomes; nobody is established then, so no report is taken (§5.4). A network
before Amendment 2 sends no `scored`.
Refusals: `404 unknown_pass` (unknown, wrong secret, or another network's host — keys too);
`410 revoked` (only after the secret matched); `403 pass_requires_signature` (a pass reference in
`pass`, the secret of a pass bound to a signing key, or an `agent_key` that does not verify);
`403 unlinked` (the person stopped this business, or it stopped for them, §5.5: nothing is
recorded and no pass is minted); `400 bad_payload` (not exactly one; `ack` without `sha`).

A pass seen at more than 10 businesses in 24 hours, or with a second signing key, is
`unusual_use`: it keeps working and the person sees it.

### 5.3 The person's own calls

- `POST /v1/passes {key, label?}` → `201 {pass}` (at most 10 a day per key).
- `POST /v1/passes/revoke {pass}` revokes that pass (a **bound** pass's secret is refused:
  `403 pass_requires_signature`); `{pass_id}` or a pass reference needs the person's session.
  Revoking also revokes its delegations; revoking twice is `200 {revoked: true}`.
- `POST /v1/delegations {pass}` needs the session **and** an sdi-agent/1 signature by the self-held
  key being delegated (covering `"sdi-agent-key";key="<label>"`, and `"sdi-pass"` when sent); the
  pass must be the session person's → `201 {pass_ref, jkt, bound: true}`. From then on the pass's
  secret form is refused; the agent presents its reference in signed requests.
- `GET /v1/person` → `{standing, evidence, keys, passes, delegations, presentations, stopped}`
  (newest first, at most 200 each; `stopped` is §5.5's `[{business, since, by}]`).
  `POST /v1/person/contests {evidence}` contests a broken outcome about the person (`201 {id}`;
  again: `200` with the same id). Each evidence row carries `contest_status` when contested: `open`,
  `disputed`, `withdrawn` or `upheld` (§5.4).
- `POST /v1/recovery/start {email, purpose: "recover" | "sign_in"}` always answers `202` for a
  well-formed body; when the address is a person's, a 6-digit code is emailed (10 minutes, 5 tries,
  3 an hour). `POST /v1/recovery/finish {email, code, purpose}` → `{session, expires_at}` for
  `sign_in`, or `{key, pass}` for `recover` (same person, every older key, pass, delegation and
  session revoked). Refusals: `422 bad_code`, `422 code_expired`, `429 too_many_attempts`.
  Session calls without one: `401 not_signed_in`.

A network SHOULD offer the same to a person without an assistant (ADR-017 A2.8): a page on its own
origin at `/me`, and at `/me/about` the notice of what it keeps about them, why, for how long, who
sees it and their rights. The person signs in with an emailed code (`sign_in`) and reads their
`GET /v1/person` in plain words and in their language; from the page they contest a broken outcome
about them, revoke a pass, stop a business or let it again (§5.5), get a new key (`recover`),
download the record exactly as `GET /v1/person` answers it, and erase it (§5.5). Each of these is
one of the calls above, with the same effect: the page is not a new wire format, and it can do
nothing an assistant could not. Most customers never learn that a network exists, so the page uses
none of this document's words: a key is "your code", as the key email calls it; a pass is "an
assistant that can show your record". A pass's `label` is not the network's word (§5.1: at first
contact it is the instance's `agent.label`), so the page only quotes it, set apart from its own
text, and names the business that gave it. It runs no script, keeps the session in a cookie only its
own host receives and no script reads, takes a form only from its own pages (a signed-in form also
carries a token bound to the session), and is neither stored nor sent as a referrer. An inbox may
link to it from the page its key email links to (§7).

### 5.4 Reports and contests

`POST /v1/reports {receipt, out, why, pass_ref}` comes from the customer's agent, signed
sdi-agent/1 with a key delegated to the pass `pass_ref` names (else `403
report_requires_signature`). `receipt` is any receipt of the item (its JWS or its sha); `out` is
`booking.no_show_business` or `order.not_received`, with `why` `closed`, `no_one_there`,
`not_delivered` or `other`; or, from rules version 6, `order.refund_refused` (a lawful withdrawal,
a claim under the legal guarantee, or goods disputed with nothing repaid, refused), with `why`
`withdrawal_refused`, `faulty_refused` or `goods_disputed_unpaid` (`REPORT_WHYS`; any other pair is
`400 bad_payload`). → `202 {id, status: "open", respond_by}`. Refusals: `403 not_your_receipt`,
`404 not_found`, `404 unknown_pass`, `410 revoked`, `422 report_window` (outside `due` + 1 h to
`due` + 90 days, and to `due` + 730 days for `order.refund_refused`, `due` being the latest
amendment's), `409 already_reported`, `409 you_acknowledged_it` (never for `order.refund_refused`:
acknowledging that the goods came does not stop it).

The business sees open reports in its signed ping and may answer within 14 days with
`POST /v1/reports/{id}/response {"answer": "dispute"}`. It sees open contests there too, each with
its `respond_by`, and may answer `POST /v1/contests/{id}/response` with `{"answer": "withdraw"}`,
at any time, which takes the outcome back for good, or `{"answer": "dispute"}`, while the contest
is open and until its `respond_by`: 14 days after it was filed, or after rules version 5 took
effect for a contest filed before. All → `{id, status, answer}` (`disputed` or `withdrawn`);
answering again gives the same result; another business's case is `404 not_found`; a report past
its window is `422 report_window`, and a dispute of a contest no longer open or past its
`respond_by` is `422 contest_window`.

What a contest does to the outcome is the rules' (ADR-017 §3.4, A2.9). Up to rules version 4 an open
or disputed contest counts the outcome half. From version 5 an open contest's outcome counts
nothing (its row's `state` is `contested`, and it is left out of the listing's counts), a disputed
one counts half, and a contest not disputed by its `respond_by` is `upheld`: the outcome never
counts again. A contest is of the customer's broken outcome on the item: when the business records
it again by another receipt, the contest holds for that receipt too.

### 5.5 A customer who stops, and erasure

A customer can ask a business to stop (ADR-017 A2.1). The inbox then sends the network nothing more
about them, and tells it once, per network, with `POST /v1/unlinks` (sdi-instance/1):

```json
{ "request_id": "01M34AVYNXTNSE2RC495H3W8QS", "ppids": ["…"], "presentations": ["…"] }
```

`ppids` are every `ppid` this network gave this business for the customer (at most 8, one per
address they used); `presentations` are the presentation ids the inbox kept for their items (at
most 200); at least one of the two. The network looks only at what it gave this business, and cuts
each person they name from it: everything of theirs there moves onto an anonymous **stand-in**, so
the business keeps its record whole and the person's record loses that business's outcomes. The
answer is `200 {unlinked, items, open_items}`: how many persons and items, and the items whose
promise has no outcome yet. Ids that name nobody give `unlinked: 0`, not an error. The same
`request_id` within 7 days gets the same answer byte for byte; with other ids, `400 bad_payload`.

From then on the business's presentations of that person are `403 unlinked`. When the customer
lifts their stop, the inbox sends `"resume": true` on its next presentation of them; it lifts a
stop the business made, never one the person made. What moved stays moved. A receipt arriving later
that names a moved presentation lands on the stand-in. A stop never takes away a report: the person
can still report an item that moved onto their stand-in (§5.4), and it is recorded there; a person
established when the item moved counts as established for that report.

The person's own calls, with a session:

- `POST /v1/person/unlinks {"business": "<domain>"}` stops that business for them (`201`; `200`
  when it already was); only they can lift it, with `POST /v1/person/unlinks/remove`, which lifts a
  stop of either kind. An unknown domain is `404 not_found`.
- `POST /v1/person/erase {"confirm": "erase"}` erases their record (A2.2). It needs a session made
  in the last hour (else `401 not_signed_in`) and answers `202 {erasing: true, message}`. Every key,
  pass, delegation, session and code is revoked at once; the person is then cut from every business
  as above and deleted, and recovery knows the address no more. Each business keeps its own record,
  bound to no one; acknowledgements their agent signed keep what they did, without the agent's key.
  The same address can come back as a new person, with nothing carried over.

## 6. Receipt claims v2

v1 claims and the JOSE header are unchanged (ADR-016). A v2 receipt adds:

| Claim | Rule |
|---|---|
| `ver` | `2` (absent or `1` is v1; anything else is refused) |
| `typ` | `booking` or `order` only |
| `knd` | `confirmed`, `paid`, `accepted` (promises) or `outcome` |
| `out` | exactly when `knd` is `outcome`: one of the inbox outcomes below, of the receipt's `typ` |
| `ref` | exactly with `out`: the `nonce` of the item's earliest promise (32 lowercase hex) |
| `due` | required, 1 to 2³⁷: a booking's start; an order's delivery time, else `iat` + 30 days; an outcome copies its promise's |
| `end` | a booking's end, not before `due`; never on an order |
| `aut` | `1` when nobody decided it in the moment: the system (a booking completed after its end) or a rule |
| `per` | at most 8 `{n: "<network host>", p: "<presentation id>"}`, one per network holding a presentation for the item; each network reads only its own |

Every refusal of these is `422 bad_payload`. An acknowledgement's payload may add `pas`, a pass
reference.

An inbox issues v2 claims for the bookings and orders its customers made (and a shop's connector
brought in); the items a business makes itself keep v1 promises and record no outcome. `iat` is
the time of the event that caused the receipt, `due` and `end` are the same on every receipt of an
item, and an outcome whose item has no promise yet is issued after that promise. Which transition
records which outcome is one function of the item type, the event, the state it leaves and who
fired it; `receipts-v2.json` lists every path through the booking and order state machines with
its outcome.

| Outcome | Item | Business row | Customer row | `o` | Recorded by |
|---|---|---|---|---|---|
| `booking.completed` | booking | kept | kept | 1 | inbox |
| `order.fulfilled` | order | kept | kept if paid or free | 1 | inbox |
| `booking.cancelled_by_business` | booking | broken | — | 1; 0.5 with ≥ 24 h notice | inbox |
| `order.not_fulfilled` | order | broken | — | 1 | inbox |
| `booking.no_show_business` | booking | broken | — | 1 | a report that stands |
| `order.not_received` | order | broken | — | 1 | a report that stands |
| `promise.unclosed` | either | broken | — | 1 | the network, 9 days after `due` (or `end`) |
| `booking.no_show_customer` | booking | — | broken | 1 | inbox |
| `booking.cancelled_late_by_customer` | booking | — | broken | 0.5 | inbox |
| `order.payment_failed` | order | — | broken | 0.5 | inbox |
| `order.charged_back` | order | — | broken | 1 | inbox |
| `booking.cancelled_by_customer` | booking | — | — | — | inbox |
| `order.cancelled_by_customer` | order | — | — | — | inbox |
| `order.lapsed` | order | — | — | — | inbox |

Which outcome stands, how evidence is dated and weighed, and when a promise counts as unclosed are
ADR-017 §3 and §5; `scoring.json` holds the arithmetic.

### 6.1 Rules version 6: changes both sides agreed, and refunds

Version 6 (ADR-017 Amendment 3; rules "0.1.3") adds values and claims and renames none. A
network puts it in force as it did version 5 (§4.4); until then a network that has announced it
stores what it adds and scores none of it.

| Claim | Rule |
|---|---|
| `typ` | also `refund`: a refund, return or withdrawal of a booking or an order, on an item of its own; its `knd` is only `accepted` (its promise) or `outcome` |
| `knd` | also `amended`: a change to a booking's or an order's promise both sides agreed, never a refund's |
| `ref` | also on an amendment, required: the `nonce` of the item's earliest promise |
| `due`, `end` | an amendment names the new ones (an order's `due` stays the earlier one when the change names no delivery date); the latest amendment (greatest `iat`, then nonce) sets them for notice, R30 and reports, and outcomes carry them, except that a customer's cancellation is late only against the later of that `due` and the date last verifiably agreed; a refund's `due` is the date it must be paid by |
| `trm` | 43 base64url characters: `base64url(HMAC-SHA-256(k, terms_sha))`, the fingerprint of the terms both sides agreed under a key `k` the business derives for that offer and discloses only to settle a dispute (so it cannot be tested against guesses); required on an amendment, optional on a promise, never on an outcome. Evidence for a dispute, never scored |
| `acc` | `customer` or `business`, who accepted the change; required on an amendment and only there |
| `per` | never on an amendment or a refund's receipts: they are about the business's promise |

| Outcome | Item | Business row | Customer row | `o` | Recorded by |
|---|---|---|---|---|---|
| `refund.honoured` | refund | kept | — | 1 | inbox, when paid by `due` (or before any `due` was fixed) |
| `refund.late` | refund | broken | — | 1 | inbox, when paid after `due` |
| `refund.cancelled_by_customer` | refund | — | — | — | inbox, when the customer drops a return after its `due` was fixed |
| `order.refund_refused` | order | broken | — | 1 | a report that stands (§5.4) |

A refund's promise is issued when its date is fixed: at once when nothing has to come back, else
when the goods do. Without a verified acknowledgement of the amendment itself, a network honours at
most 3 amendments per item, moving `due`, and the date R30 reads (a booking's `end`, else `due`), at
most 90 days either way from the earliest promise's (`AMENDMENT_LIMITS`); one beyond is stored and
changes nothing. No version 6 outcome has a customer's row, and an amendment on the business's word
alone never makes a customer's cancellation late: it is judged against the later of the item's
`due` and the date last verifiably agreed (the latest acknowledged amendment's, else the earliest
promise's). A network on version 5 refuses `typ: "refund"` and `knd: "amended"`
(`422 bad_payload`) and ignores `trm` and `acc` however they look (malformed, on an outcome, `acc`
on a promise); `parseReceiptClaims(payload, {rules})` does exactly that. An inbox sends version 6's receipts only to a network whose rules, in force or announced, are
6 or later; it carries `trm` on a promise only when every network the promise goes to then takes
version 6; and it moves the dates of a promise a network holds, and sends a promise that moved,
only where version 6 is in force, so R30 never counts a moved booking as unclosed. An outcome goes
after its promise and its amendments. `receipts-v6.json` pins all of it, with every path through
the refund machine.

## 7. What an inbox does

- Registers its domain once, pings every hour (signed when it holds a receipt key), and publishes
  every receipt through a durable queue, at most 1,000 an hour per network, oldest first. A signed
  ping carries `manifest_sha256`, the SHA-256 of the manifest bytes it serves. A signed
  ping answered `401` is sent again unsigned at once; a `200` gives the business its `standing`
  and the rules (the day's `/v1/ranking` read is then skipped); a `204` is a ping all the same.
- Signs every call to `/v1/persons`, `/v1/presentations`, `/v1/unlinks`,
  `/v1/instances/{domain}/listing`, `/v1/reports/{id}/response`, `/v1/contests/{id}/response` and
  the ping with sdi-instance/1 and a fresh `nonce`.
- Shows the owner each open contest with its `respond_by`, and lets them take the outcome back
  (`withdraw`) or say it is right (`dispute`) before then: from rules version 5 a contest left
  unanswered is upheld, and the outcome no longer counts.
- Publishes in its manifest's `profile` (§4.6) its weekly hours and closures with its time zone as
  `hours`, its active services as `services`, and the categories the owner picked from the
  categories list, by slug. It publishes a street address only when the owner entered one, and says
  plainly, where the owner enters it, that the directory shows it: someone who works from home
  leaves it empty.
- Lets the owner choose whether the business is in the directory. A change is sent to every network
  as `POST /v1/instances/{domain}/listing`, retried until answered; an inbox without a receipt key
  publishes it in its manifest's `directory` instead. It shows the owner the `listing` a signed ping
  returns, and says plainly when a network set the business aside and why.
- Asks for a person (`/v1/persons`) only on a customer's first booking or order that carries an
  email and no pass or key; nothing about the booking waits on it. It caches a `409` for 24 hours.
  It never asks a directory-level network (§10), nor sends one an unlink.
- Presents what an agent carries (`/v1/presentations`) with a 3-second limit, in parallel across
  networks, and never refuses a customer because a network is slow or down.
- Keeps what a network answered only by hash: a pass's presentation for an hour (or a shorter
  `max-age`), a revoked pass likewise, a `409 person_exists` for a day, an acknowledgement never.
  After three calls in a row without an answer it leaves that network alone for a minute; only
  then does a pass whose hash it linked to a customer stand in, with the standing last returned.
- Retries a first contact the request could not finish with the same `request_id` (the network
  replays its answer), backing off to six hours; after a `429` the next day; for seven days.
- Seals a first contact's key and pass with its secret key, emails the key to the customer with
  the first email it sends them (or alone within a day), and deletes both within seven days.
- When a customer stops (the page the key email links to, or the owner for them), sends every
  network holding anything about them `POST /v1/unlinks` with their `ppid`s and kept presentation
  ids, retried with the same `request_id` like a first contact. After that it sends nothing about
  them but the outcomes of the answer's `open_items`, as they happen, with no `per` and no
  acknowledgement, so the business is never counted `promise.unclosed` for respecting the stop.
  When the customer lifts their stop, its next presentation of them carries `"resume": true`.
- May link each network, on the page the key email links to, by its page for people,
  `<network origin>/me` (§5.3), where the customer can see, correct, download or erase what that
  network holds about them; a network that serves no such page is linked by its origin.
- Forwards a pass reference only as the agent's own signature (`agent_key`, §3.1), for a request
  (`purpose: "request"`) or an acknowledgement (`purpose: "ack"` with the receipt's `sha`), and
  never one whose base holds a secret — a key, a pass or a session in a signed `Sdi-Pass`, or an
  `access_token` in `@query` — since the network would read it.

## 8. Several networks

An inbox can report to up to 8 networks. Each is authoritative only for its own keys, passes and
scores; an agent presents one string per network (the host inside each string says which), and
the inbox asks each network only about its own. No network ever sees another's strings.

## 9. Error codes

| Status | Codes |
|---|---|
| 400 | `malformed`, `bad_payload`, `category_unresolved`, `page_too_deep` (0.2) |
| 401 | `unknown_instance`, `bad_signature`, `expired`, `not_signed_in`, `replayed_signature` |
| 403 | `pass_requires_signature`, `not_your_receipt`, `report_requires_signature`, `unlinked` |
| 404 | `unknown_pass`, `unknown_issuer`, `not_found` |
| 409 | `person_exists`, `nonce_reused`, `already_reported`, `you_acknowledged_it` |
| 410 | `revoked`, `cursor_expired` |
| 413 | `too_large` |
| 422 | `unknown_key`, `unknown_ref`, `bad_alg`, `bad_typ`, `not_yet`, `report_window`, `contest_window`, `bad_code`, `code_expired` |
| 429 | `too_many_receipts`, `rate_limited`, `too_many_attempts` |

An inbox also answers its own callers with `409 nothing_to_verify`, `409 already_verified` and
`422 positive_only` (ADR-017 §8).

## 10. Levels

A network offers one of two levels, and says which in its rules (`GET /v1/ranking`, §4.4) as
`protocol`:

```json
"protocol": { "level": "directory", "claims": 2 }
```

- `level`: `"directory"` or `"full"`.
- `claims`: the receipt claims it takes. `1` is the promises `confirmed` and `paid` as ADR-016 wrote
  them; `2` is every promise, acceptance and outcome (§6); `6` adds agreed changes and refunds
  (§6.1). An inbox sends it those, whatever the rules' version, and treats `6` as in force.

A rules document without `protocol` is read as `full`, with its claims from its version: `6` from
version 6, `2` from version 3, otherwise `1`. That is how every network published before levels
existed is read, the Surfing Dog network among them.

### 10.1 The directory level

A directory-level network answers these, as this document says:

| Call | Section |
|---|---|
| `POST /v1/instances` | §4.1 |
| `GET /v1/instances/{domain}/status` | §4.1 |
| `POST /v1/instances/{domain}/ping` | §4.1 |
| `POST /v1/instances/{domain}/listing` | §4.5 |
| `POST /v1/receipts` | §4.2 |
| `GET /v1/businesses` | §4.3 |
| `GET /v1/businesses/{domain}` | §4.3 |
| `GET /v1/ranking` | §4.4, and below |

and should answer `GET /v1/categories` (§4.3), `POST /mcp`, `GET /openapi.json` and `GET /llms.txt`
(§4.7), so assistants can search it. It may answer `GET /v1/attributes`, `GET /c/{id}` and the optional
tools of protocol 0.2 (§4.10, §4.12). Every other call of §4 and §5 is `404 not_found`. An inbox never
makes them to a directory-level network: it asks it for no person, presents it no pass and sends it
no unlink. Its answer to a signed ping is `200` with `ok`, `rules`, `next_rules`, `listing` and
empty `reports` and `contests`, and no `standing`, since it keeps none.

What it still does, as the full level does:

- verifies a business by fetching its manifest (§4.1), and checks every sdi-instance/1 signature
  (§3) on a listing change and on a signed ping, refusing a replayed one;
- verifies every receipt against the issuer's manifest and keeps it (§4.2), with the answers and
  codes §4.2 lists, for the claims it said it takes;
- keeps the profile field by field (§4.6) and returns listings in the shape of §4.3. A listing
  carries `receipts`, `answering` and `not_answering_since`; it leaves out `reputation`,
  `rank_pos` and `rank_shuffle`, which belong to ADR-017's order.

It orders its directory by rules of its own, so a trade body, a city or a marketplace can run one
without adopting ADR-017. Its rules document needs only `version`, `status`, `effective_at`,
`summary` (how it orders, in plain words), `next` and `protocol`
([`schemas/ranking-directory.json`](../../packages/spec/schemas/ranking-directory.json)); `next`
announces a change before it takes effect, as §4.4 says. Filters on `GET /v1/businesses` are a
should: one it does not support it ignores, and `limit` and `cursor` it must honour.

### 10.2 Checking a network

`packages/network-check` runs against any network's origin:

```
npx tsx packages/network-check/src/cli.ts https://network.example.org
```

By default it only reads, and sends requests a correct network refuses without storing anything:
unsigned and wrongly signed calls, a forged receipt, a listing change for nobody. With `--flow` it
also plays an inbox from start to finish: it serves a manifest, registers, pings signed, lists and
delists itself, and publishes receipts. A network has to be able to fetch that manifest, so `--flow`
is for a network running in a test mode that reads manifests from a URL it is given (the example
network's `NETWORK_TEST_MANIFESTS`), never for one in production.

Protocol 0.2 adds two checks, both read-only:

- `doors.no-human-door` (must, §4.8): it reads `GET /v1/businesses?limit=100` and, when `/mcp`
  answers, one `search_businesses` with no arguments, and fails on any door of a refused type, any
  door whose address has a refused scheme or host, and any such address among a listing's
  `protocols` or a card's `inbox`. A directory with no doors passes.
- `filters.narrow` (should, §4.3): it reads the first page of 100, then the same with each of
  `language` and `category` (the first business's), `has_inbox=true`, `level=askable` and
  `source=member`. Each filtered page must keep the relative order of the businesses it shares with
  the whole page, and, when the whole list fits that page, add nobody. A filter answered `400` is
  "not supported" and skipped.

Spec 0.3 adds two more, both read-only and both a should:

- `score.rules` (§4.13): it reads `GET /v1/score-rules`. A `404` passes as "not offered"; otherwise
  the document must hold to `scoreRulesSchema`, and every capability it names must be one of the
  vocabulary's.
- `discovery.catalog` (§4.14): it reads `GET /.well-known/ai-catalog.json`. A `404` passes as "not
  offered"; otherwise it must hold to `aiCatalogSchema`, and every address in it must be https.

`rules.read` takes a rules version newer than the checker knows, and says it read it leniently.

