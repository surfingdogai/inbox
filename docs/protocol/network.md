# The network protocol

A **network** is a service that inboxes report to: it lists businesses, keeps the receipts they
publish, gives customers a key and passes, and orders the directory by the published rules. Anyone
can run one (ADR-017, R24), and an inbox can use several at once. This document is everything a
network must implement to work with any inbox, and everything an inbox may send to it.

It restates [ADR-017](../adr/017-reputation-and-ranking.md) §2–§7 as a protocol. The rules of
reputation and order (what counts, the formula, tiers) are in the ADR and, machine-readable, at a
network's own `GET /v1/ranking`. When this text and the vectors disagree, **the vectors decide**.

| What | Where |
|---|---|
| Schemas (Zod, MIT) | [`packages/spec/src/network/`](../../packages/spec/src/network/) |
| Schemas (JSON Schema) | [`packages/spec/schemas/`](../../packages/spec/schemas/), one file per message |
| Signed requests | [`vectors/signatures.json`](../../packages/spec/vectors/signatures.json) |
| Keys, passes, email normalisation | [`vectors/passes.json`](../../packages/spec/vectors/passes.json) |
| Receipt claims v2 | [`vectors/receipts-v2.json`](../../packages/spec/vectors/receipts-v2.json) |
| Receipts v1 and acknowledgements | [`vectors/receipts.json`](../../packages/spec/vectors/receipts.json) (ADR-016) |
| Scores | [`vectors/scoring.json`](../../packages/spec/vectors/scoring.json) |
| Order, shuffle, cursors | [`vectors/ordering.json`](../../packages/spec/vectors/ordering.json) |

## 1. Conventions

- HTTPS only. A network is named by its origin, `https://<host>` on port 443 with no path; `<host>`
  is lowercase punycode and is the host inside every key and pass it issues.
- Bodies are JSON, UTF-8. Times are RFC 3339 in UTC. Unix times in receipts are seconds.
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
| `POST /v1/instances/{domain}/ping` | optional sdi-instance/1 | `{version, runtime, counts?}` → `204`, or `200` when signed | `ping-*` |
| `POST /v1/receipts` | the JWS itself | `{receipt, ack?}` → `{ok, state, duplicate}` | `receipts-*`, `receipt-*` |
| `GET /v1/businesses` | none | query → `{businesses, next_cursor}` | `businesses` |
| `GET /v1/businesses/{domain}` | none | → listing + `outcomes` | `business` |
| `GET /v1/ranking` | none | `?version=N` → the rules | `ranking` |
| `POST /v1/persons` | sdi-instance/1 | `{request_id, email, agent?}` → `201` | `persons-*` |
| `POST /v1/presentations` | sdi-instance/1 | one of `pass`, `key`, `agent_key` → `200` | `presentations-*` |
| `POST /v1/passes` | the key | `{key, label?}` → `201 {pass}` | `passes-*` |
| `POST /v1/passes/revoke` | the pass, or a session | `{pass}` or `{pass_id}` → `{revoked: true}` | `passes-revoke-*` |
| `POST /v1/delegations` | session **and** sdi-agent/1 | `{pass}` → `201 {pass_ref, jkt, bound}` | `delegations-*` |
| `GET /v1/person` | session | → the person's own record | `person` |
| `POST /v1/person/contests` | session | `{evidence}` → `{id}` | `contests-*` |
| `POST /v1/recovery/start` | none | `{email, purpose}` → `202` | `recovery-start-*` |
| `POST /v1/recovery/finish` | none | `{email, code, purpose}` → session, or key and pass | `recovery-finish-*` |
| `POST /v1/reports` | sdi-agent/1 | `{receipt, out, why, pass_ref}` → `202` | `reports-*` |
| `POST /v1/reports/{id}/response` | sdi-instance/1 | `{answer: "dispute"}` → `{id, status, answer}` | `report-answer`, `case-answered` |
| `POST /v1/contests/{id}/response` | sdi-instance/1 | `{answer: "withdraw"}` → `{id, status, answer}` | `contest-answer`, `case-answered` |

Limits a network publishes under `limits` at `/v1/ranking` (the reference values): 600 signed
calls a minute per instance; 50 issuances a day per business (`409`s included); 10 passes a day
per key; 20 presentations per person per business per day, after which the last result is
answered again and nothing is recorded; 10,000 promises a day per business.

### 4.1 Registration and the ping

`POST /v1/instances {"domain": "inbox.example.com"}` answers `202 {domain, status, status_url,
manifest_url, message}` and queues verification: the network fetches
`https://<domain>/.well-known/agent-inbox.json`, which must have `spec` starting
`surfingdog-inbox/` and `instance` equal to `https://<domain>` (port 443, no path). It keeps the
manifest's `profile`, `item_types`, `protocols` and `receipt_keys`, and fetches it again every six
hours. A business is **listed** when its status is `verified` or `unreachable` and it has a
`verified_at`.

`POST /v1/instances/{domain}/ping` is sent hourly with
`{"version": "…", "runtime": "…", "counts": {"bookings", "orders", "quotes", "messages"}}` (the
last 24 hours; `counts` optional; each 0 to 10⁹). A ping keeps the business **answering** for 24
hours, signed or not.

- **Unsigned:** `204`, no body.
- **Signed** sdi-instance/1 by that domain's own key: `200` with
  `{ok: true, rules: {version, effective_at}, next_rules: {version, effective_at, url} | null,
  reports: [{id, receipt_sha, out, why, created_at, respond_by}], contests: [{id, evidence_id,
  out, created_at}], standing: {score, tier, ranked}}` — the open reports and contests the business
  may answer (oldest first, at most 200 each) and its standing in the last nightly snapshot.
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
| `404 unknown_issuer` | the issuer is not a listed business |
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

`GET /v1/businesses?near=lat,lng&radius_km=10&category=&item_type=&q=&limit=100&cursor=` →
`{businesses: [listing], next_cursor}`. A listing has `domain`, `name`, `description?`, `city?`,
`country?`, `categories`, `languages`, `item_types`, `protocols`, `geo? {lat, lng}`,
`distance_km?` (near only), `url?`, `manifest_url`, `verified_at`, `last_ping_at?`,
`software? {version, runtime}`, `receipts {issued, acknowledged, customers?, last_at?}` (promises
only), `answering`, `online` (the same), `not_answering_since`, and, once the ranked order is in
force, `rank_pos`, `rank_shuffle` (a 16-hex-digit **string**) and `reputation {ranked, score, tier,
kept, broken, customers, verified_share, rules, rules_url}`. Nothing about any customer is ever
returned. `GET /v1/businesses/{domain}` adds `outcomes`, a count for every outcome code in §6.

The order and the cursor are ADR-017 §6; `ordering.json` holds the shuffle (the first 16 hex digits
of `SHA-256("<YYYY-MM-DD>:<business uuid>")`), one full snapshot's order and the cursors (base64url
JSON `{m, p}`; any other cursor is `410 cursor_expired`).

### 4.4 The rules

`GET /v1/ranking` is the version in force; `?version=N` any version ever published, for ever
(unknown: `404 not_found`). A version is announced at least 15 days before it takes effect: the
version in force carries it in `next: {version, effective_at, url}`, and signed pings in
`next_rules`. Version 3 (network rules 0.1) publishes `{version, rules, status, published_at,
effective_at, summary, order, score, weights, timing, verified, tiers, limits, never_used,
changelog, next}` with every number a network may choose; `status` is `announced`, `in_force` or
`retired`. The schema is `ranking`.

An inbox reads it daily: it sends every receipt (§6) to a network whose rules, in force or
announced in `next`, are version 3 or later. To the others it sends only the promises v1 already
knew, `confirmed` and `paid`, whose v1 claims are unchanged (a v1 reader ignores the members it
does not know); acceptances and outcomes wait for the network to move to version 3.

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
`email` (the item's address) and `agent` (as in §5.1).

`200 {presentation, ppid, person, pass?, email_match?}`, where `person` is
`{tier, score, kept, broken, businesses, email_proven, since, unusual_use, rules}` and
`email_match` is `proven` (it is the person's address, proven by code), `unproven` or `no`.
Refusals: `404 unknown_pass` (unknown, wrong secret, or another network's host — keys too);
`410 revoked` (only after the secret matched); `403 pass_requires_signature` (a pass reference in
`pass`, the secret of a pass bound to a signing key, or an `agent_key` that does not verify);
`400 bad_payload` (not exactly one; `ack` without `sha`).

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
- `GET /v1/person` → `{standing, evidence, keys, passes, delegations, presentations}` (newest
  first, at most 200 each). `POST /v1/person/contests {evidence}` contests a broken outcome about
  the person (`201 {id}`; again: `200` with the same id).
- `POST /v1/recovery/start {email, purpose: "recover" | "sign_in"}` always answers `202` for a
  well-formed body; when the address is a person's, a 6-digit code is emailed (10 minutes, 5 tries,
  3 an hour). `POST /v1/recovery/finish {email, code, purpose}` → `{session, expires_at}` for
  `sign_in`, or `{key, pass}` for `recover` (same person, every older key, pass, delegation and
  session revoked). Refusals: `422 bad_code`, `422 code_expired`, `429 too_many_attempts`.
  Session calls without one: `401 not_signed_in`.

### 5.4 Reports and contests

`POST /v1/reports {receipt, out, why, pass_ref}` comes from the customer's agent, signed
sdi-agent/1 with a key delegated to the pass `pass_ref` names (else `403
report_requires_signature`). `receipt` is any receipt of the item (its JWS or its sha); `out` is
`booking.no_show_business` or `order.not_received`; `why` is `closed`, `no_one_there`,
`not_delivered` or `other`. → `202 {id, status: "open", respond_by}`. Refusals: `403
not_your_receipt`, `404 not_found`, `404 unknown_pass`, `410 revoked`, `422 report_window`
(outside `due` + 1 h to `due` + 90 days), `409 already_reported`, `409 you_acknowledged_it`.

The business sees open reports in its signed ping and may answer within 14 days with
`POST /v1/reports/{id}/response {"answer": "dispute"}`; it sees contests there too and may answer
`POST /v1/contests/{id}/response {"answer": "withdraw"}`. Both → `{id, status, answer}`
(`disputed`, `withdrawn`); answering again gives the same result; another business's case is `404
not_found`; a report past its window is `422 report_window`.

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

## 7. What an inbox does

- Registers its domain once, pings every hour (signed when it holds a receipt key), and publishes
  every receipt through a durable queue, at most 1,000 an hour per network, oldest first. A signed
  ping answered `401` is sent again unsigned at once; a `200` gives the business its `standing`
  and the rules (the day's `/v1/ranking` read is then skipped); a `204` is a ping all the same.
- Signs every call to `/v1/persons`, `/v1/presentations`, `/v1/reports/{id}/response`,
  `/v1/contests/{id}/response` and the ping with sdi-instance/1 and a fresh `nonce`.
- Asks for a person (`/v1/persons`) only on a customer's first booking or order that carries an
  email and no pass or key; nothing about the booking waits on it. It caches a `409` for 24 hours.
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
| 400 | `malformed`, `bad_payload` |
| 401 | `unknown_instance`, `bad_signature`, `expired`, `not_signed_in`, `replayed_signature` |
| 403 | `pass_requires_signature`, `not_your_receipt`, `report_requires_signature` |
| 404 | `unknown_pass`, `unknown_issuer`, `not_found` |
| 409 | `person_exists`, `nonce_reused`, `already_reported`, `you_acknowledged_it` |
| 410 | `revoked`, `cursor_expired` |
| 422 | `unknown_key`, `unknown_ref`, `bad_alg`, `bad_typ`, `not_yet`, `report_window`, `bad_code`, `code_expired` |
| 429 | `too_many_receipts`, `rate_limited`, `too_many_attempts` |

An inbox also answers its own callers with `409 nothing_to_verify`, `409 already_verified` and
`422 positive_only` (ADR-017 §8).
