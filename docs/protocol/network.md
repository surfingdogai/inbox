# The network protocol

Protocol 0.2 (October 2026). Everything in 0.2 is additive: a 0.1 network and a 0.1 inbox keep working.
Spec 0.3 adds, all of it optional for a network and none of it read by an inbox, capabilities and the
agentic score (§4.13), the discovery documents (§4.14) and a member's track record (§4.3). Spec 0.4
adds, optional for a network, door reports (§4.15): agents say how each use of a door went, and the
business sees it in its signed ping's answer; and it writes down how a network's own reads move a
door (§4.8). Spec 0.5 names `orderable` as a level of its own, the rung `bookable` is on, for doors
that take orders and none that books; `level=bookable` and `level=orderable` filter by what the doors
take; and a UCP or ACP profile raises a business only on a site that shows it sells (§4.9). A network
that emits `orderable` serves spec 0.5; a reader of 0.4 does not know the value. Spec 0.5.1 lets a
network keep, and show, a door's history from its own reads (§4.8, [ADR-020](../adr/020-door-history.md)),
optional for a network. Spec 0.6 adds, optional for a network, the census (§4.16): once a month, how
many of the websites it checked an agent can do each thing with, as counts; and version 2 of the
capability vocabulary, which says what each capability means, the evidence for it and how each kind
of door carries it ([ADR-021](../adr/021-the-reference.md)). Spec 0.7 adds how a business is paid: a
profile's `payments` (§4.6), each listing's ways to pay with their evidence (`accepts.pay_with`, §4.10)
and the census's payment metrics (§4.16); and, optional for a network, a business's inbox found from
its domain (§4.14a, [ADR-024](../adr/024-owners-in-control.md)). Spec 0.8 adds, optional for a network,
carried requests (§4.17, [ADR-025](../adr/025-carried-requests.md)): a network may carry a person's
request to a business's own inbox, which publishes whether it takes them in its manifest.

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
| A door's history, as the public sees it | [`vectors/door-history.json`](../../packages/spec/vectors/door-history.json) (§4.8) |
| A directory-level network's rules | [`schemas/ranking-directory.json`](../../packages/spec/schemas/ranking-directory.json) (§10) |
| The categories list | [`vocab/categories.json`](../../packages/spec/vocab/categories.json) |
| Door types, and what is never a door | [`vocab/doors.json`](../../packages/spec/vocab/doors.json) (§4.8) |
| Attributes a listing may carry | [`vocab/attributes.json`](../../packages/spec/vocab/attributes.json) (§4.10) |
| Rules version 7's order: tiers, newcomers, pages | [`vectors/ordering-v7.json`](../../packages/spec/vectors/ordering-v7.json) (§4.4), from the network |
| A found entry's card, from what was crawled | [`vectors/listing.json`](../../packages/spec/vectors/listing.json) (§4.11), from the network |
| The capability vocabulary, version 2: definitions, evidence, how each kind of door carries each capability | [`vocab/capabilities.json`](../../packages/spec/vocab/capabilities.json) (§4.13); version 1 at [`vocab/capabilities-v1.json`](../../packages/spec/vocab/capabilities-v1.json) |
| The agentic score's rules, version 2 as amended on 8 and 12 October 2026 (version 1 retired) | [`vocab/score-rules-v2.json`](../../packages/spec/vocab/score-rules-v2.json), [`vocab/score-rules-v1.json`](../../packages/spec/vocab/score-rules-v1.json) (§4.13) |
| The agentic score's arithmetic | [`vectors/score.json`](../../packages/spec/vectors/score.json) (version 2), [`vectors/score-v1.json`](../../packages/spec/vectors/score-v1.json) (§4.13), from the network |
| Door report classes | [`vocab/door-report-classes.json`](../../packages/spec/vocab/door-report-classes.json) (§4.15) |
| Door reports, and the network's own reads of a door | [`vectors/door-reports.json`](../../packages/spec/vectors/door-reports.json) (§4.8, §4.15) |
| How a tool's, skill's or operation's name is read as capabilities | [`vectors/capability-names.json`](../../packages/spec/vectors/capability-names.json) (§4.13), from the network |
| The agentic score's rules, version 3 as revised on 15 and 18 October 2026: a commerce profile counts where the site sells, its own catalogue included | [`vocab/score-rules-v3.json`](../../packages/spec/vocab/score-rules-v3.json) (§4.13), from the network |
| The census: an edition, and the list of them | [`schemas/census-edition.json`](../../packages/spec/schemas/census-edition.json), [`schemas/census-editions.json`](../../packages/spec/schemas/census-editions.json), an example in [`vectors/census-edition.json`](../../packages/spec/vectors/census-edition.json) (§4.16) |
| The census for an assistant: the MCP tool `get_census` | [`schemas/mcp-get-census-input.json`](../../packages/spec/schemas/mcp-get-census-input.json), [`schemas/mcp-get-census-output.json`](../../packages/spec/schemas/mcp-get-census-output.json) (§4.16) |

## 1. Conventions

- HTTPS only. A network is named by its origin, `https://<host>` on port 443 with no path; `<host>`
  is lowercase punycode and is the host inside every key and pass it issues.
- Bodies are JSON, UTF-8. Times are RFC 3339 in UTC. Unix times in receipts are seconds.
- A request body is at most 64 KB; no message in this protocol comes near it, except door reports
  (§4.15), at most 128 KB. A network refuses a larger one with `413 too_large`, and may set a lower
  limit on a call and refuse a body over that one the same way. `413` is final: the same body sent
  again gets the same answer.
- **Unknown members are ignored**, by both sides. A network may add a field to any answer; an inbox
  must not fail on it. The JSON Schemas therefore never forbid extra members, except in a door
  report's body (§4.15), which is strict so that nothing about a person travels in it by mistake.
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
| `GET /leaderboard.json` (0.3, MAY) | none | `?category=&country=&place=&can=&ready=&page=` → businesses where an agent can book, order or sign up above the rest, then by agentic score (§4.13) | `leaderboard` |
| `GET /.well-known/ai-catalog.json` (0.3, SHOULD) | none | → the network's doors for agents (§4.14) | `ai-catalog` |
| `POST /v1/door-reports` (0.4, MAY) | optional sdi-agent/1 or Web Bot Auth | `{v: 1, reports}` → `202 {accepted, ignored, next}` (§4.15) | `door-reports-*`, `door-report` |
| `POST /v1/door-incidents/{id}` (0.4, MAY) | sdi-instance/1 | `{state: "fixed"}` → `{id, state, check_queued}` (§4.15) | `door-incident-*` |
| `GET /report.md` (0.4, with door reports) | none | → how an agent reports, in plain words (§4.15) | |
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
  the last nightly snapshot, and whether it is listed (§4.5). From rules version 8 `standing.ranked`
  is false, and `tier` is `new`, while the business's record rests on its own word (less than a
  fifth of it kept outcomes a verified acknowledgement backs); its `score` is still there, since
  only the business sees it (ADR-017 A4.1). From spec 0.4 a network that takes door reports adds
  `doors`: how agents got on at the business's own doors, and what the network's own reads saw
  (§4.15).
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
| `422 v2_required` | from rules version 8 (ADR-017 A4.6): a member's v1 receipt, or an outcome or amendment whose `ref` names a v1 promise held from before |
| `422 due_too_far` | from rules version 8: `due` more than 400 days (a booking) or 60 days (an order or a refund) after the later of `iat` and the arrival |
| `422 end_too_far` | from rules version 8: `end` more than 31 days after `due` |
| `422 promise_conflict` | from rules version 8: a second promise of an item naming another `due` or `end` than the first the network stored; final |
| `422 ref_refused` | from rules version 8: an outcome or an amendment whose `ref` names a promise the network refused for good (any of the four above); final, do not retry |
| `422 bad_payload` | also, from rules version 8, an outcome naming another `due` or `end` than its item's (its promise's, or an amendment's the network holds) |
| `422 ack_<code>` | the acknowledgement |
| `429 too_many_receipts` | over 10,000 promises today, or over 32 outcomes for one item |

An inbox **retries** `404`, `429`, `5xx`, and `422` with `unknown_key` or `unknown_ref`; every
other refusal is final. It publishes an outcome's promise before the outcome. A network records
**arrival** (the first time it saw a receipt that verified) even on an attempt it refuses with
`422 unknown_ref`, `429` or `5xx`, so retrying never makes a receipt late. The bounds of rules
version 8 are measured from that arrival, so the same receipt always meets the same answer. A
promise refused for good is never held, and the network remembers it: its outcomes and amendments
are refused for good with `422 ref_refused`, so an inbox stops retrying them, where `unknown_ref`
means the promise may still be on its way. The item's promise is the first the network stored;
another promise of the item must name the same `due` and `end` (`promise_conflict`), whatever its
`iat`. A business's notice is measured from when the network stored its cancellation, not from
the arrival: a sighting is recorded before the promise and the acknowledgement are checked. A
network publishes the bounds in its rules, under `intake` (§4.4).

The body, the receipt's JOSE header, its claims and the acknowledgement's are read as **strict
JSON**, under every rules version: one value with nothing after it, valid UTF-8, no member named
twice, no lone surrogate or U+0000, nesting at most 16 deep, never `null` or another JSON type
where a member is named, and no member that names one the network reads in another case (`"Out"`
beside or instead of `"out"`, which a reader that folds case takes for `out`). Members no schema
names, in any case, are still ignored (§1). A header naming `crit` or `b64` is refused, since the
network understands no JWS extension. A body that is not strict JSON is `400`; a header, `422
malformed`; claims, `422 bad_payload`; an acknowledgement, the same codes with `ack_`. The same
bytes then read the same to every reader: the network, the inbox and the customer's agent.

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
kept, broken, customers, verified_share, rules, rules_url}`, and a member's `track_record` (below).
From rules version 8 `reputation` also has `open` (v2 promises issued, not yet closed by an outcome
and not unclosed) and `verified_kept_share` (the share of the record's weight that is kept outcomes
a verified acknowledgement backs), and a record less than a fifth of which is such outcomes rests on
the business's own word and is **self-reported**: `self_reported: true`, `ranked: false`, tier
`new`, **no `score`** and no `customers`, so what is shown is its counts, as the business's own word
(ADR-017 A4.1). `receipts.acknowledged` then counts the receipts an acknowledgement the network
verified backs (any acknowledgement checks out against the key in its own header), and
`receipts.customers`, on the detail, is absent for a self-reported record. Nothing about any
customer is ever returned. `GET /v1/businesses/{domain}` adds `outcomes`, a count for every outcome
code in §6. Only listed businesses are returned; the detail of a business that left the directory,
or was set aside, is `404`, and the problem's `detail` says which.

**The track record** (spec 0.3) is what a member's reputation was computed from, in counts and
words, from the same nightly snapshot and shown under the same rules, so the record, the reputation
and the order always agree: `track_record {state, in_words, as_of?, held_until?, self_reported?,
closed?, customers?, kept?, broken?, open?, unclosed?, refunds_late?, from?, to?, confirmed?,
confirmable?, threshold? {closed, customers?}, rules_url?}`. Every state carries `in_words`,
`threshold` and `rules_url`, and `as_of` once a nightly count has a row for the business; beyond
that, only what it can say:

| `state` | When | Also carries |
|---|---|---|
| `held` | a new member's 30 days (R31): nothing is counted yet | `held_until`, the night its record is counted from |
| `none` | no receipts | — |
| `pending` | receipts no nightly count has reached yet | — |
| `gathering` | counted, below the threshold | `closed`, and `customers` or `self_reported` |
| `shown` | the record | everything else |

From rules version 8 a record less than a fifth of which is kept outcomes a verified acknowledgement
backs rests on the business's own word, as its `reputation` does (ADR-017 A4.1): it is
**self-reported**, `self_reported: true`, and shows its counts in words (`kept`, `broken` and `open`,
its v2 promises still open) with **no score, nothing that reads as one, and no `customers`**, since
the business chooses who they are (A4.2 counts every row of a business that names none of them as
one anonymous customer). Its `in_words` begins "Self-reported track record", and the reference
network's page labels it "Self-reported" and draws no meter.

A record shows once at least `threshold.closed` promises have closed, kept or broken, and, unless it
is self-reported, from at least `threshold.customers` distinct customers; the reference is **5**,
**from 3**, and a self-reported record's `threshold` has no `customers`. Five is the smallest whole
count at which a record of nothing but kept promises can reach the trusted line (0.75 needs 4.93
units), and below three customers one customer counted three times over (R7) could make up the whole
record. Customers are told apart by R7's pair (the customer's mailbox when the network knows it,
else, before rules version 8, the receipt's `sub`; from rules version 8 a `sub` that names no person
is never a customer, and every receipt at a business that names nobody is one anonymous customer,
A4.2), so `customers` here is not `reputation.customers`, which counts only customers the network
can tell apart across businesses (§5.3). `kept` and `broken` are the reputation's; of the
broken, `unclosed` were left open 9 days past due (`promise.unclosed`) and `refunds_late` were refunds
paid late (`refund.late`). There is no "late" for a booking or an order: a promise is kept or broken.
`from` and `to` are the earliest and latest days of the counted outcomes, each at 00:00 UTC (the day,
never the moment of any one customer's promise), and `as_of` the night they were counted.
`confirmed` is how many of the closed are kept outcomes a verified acknowledgement backs, what
`verified_kept_share` weighs: a customer's report that stands is verified evidence, but against the
business, and never a confirmation of its record. `confirmable` says whether this network can verify
any acknowledgement: it is `false` while `recognised_platforms` is empty and the night the record is
from established no person (none is while customers are not scored, A2.10). Whatever was not
confirmed is the business's own word, which `in_words` says in place of a share. What was confirmed
stays counted and said even when nothing more can be. Nothing in it orders anything. An entry that
is not a member has no `track_record`. The reference network shows the same record on its page for
the domain, `/b/{domain}`.

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
| `level` | at that level or above (§4.9); `bookable` and `orderable` are one rung: `bookable` asks for a live door that takes bookings, `orderable` for one that takes orders; below `askable` nothing is listed yet |
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

Version 8 (network rules 0.2.1, ADR-017 Amendment 4, decided 12 October 2026) is version 7 amended
before it takes effect, and keeps every member and number of version 7:

- **A record ranks only on what its customers confirmed.** Ranked needs a score of 0.40 or more
  **and** `verified_kept_share` ≥ 0.2 (as shown, four decimals): at least a fifth of the record's
  weight is kept outcomes a verified acknowledgement backs. A report that stands is verified
  evidence against the business and never ranks it. Any other record rests on the business's own
  word: it is not ranked, its tier is `new`, and listings and cards show its counts and no score
  (§4.3, §4.7). Until a network can verify anything, nobody is ranked there.
- **Rows that name no customer.** At a business that names none of its customers they are one
  customer, kept and broken together, so they weigh at most 3 pieces of its record, in their own
  proportion; at one that names some, a kept row that names nobody does not count and a broken
  one counts in full. Inboxes that know who their customers are count for more than inboxes that
  do not.
- **Reach 1** only once a member's signed pings have kept it answering for 30 days without a break
  (`order.reach_1_after_days`); before that it is in reach 2, at its inbox's level.
- **Relations a network cannot see are unknown** (`verified.unknown`): a tenant under a private
  suffix, and a member whose signed pings in the last 30 days came only from `egress_ignored`, or
  that sent none, is related to nobody and unrelated to nobody.
- **Newcomers:** every member is a newcomer for its first 90 days, ranked or not, at any reach,
  while its inbox answers; at most one newcomer of each relations group has its turn in an hour's
  order (`order.newcomers.group`, `per_group_per_hour`, `turn`: the lowest first 16 hex digits of
  `SHA-256("<YYYY-MM-DDTHH>:<business uuid, lowercase>")`), and every member whose relations are
  unknown, every member of a component that holds one, and every member that has no night's score
  yet, is in one group.
- **Intake** (version 7 as amended, in force from version 8): claims v2 only from members, `due`
  and `end` within the bounds of §4.2 and the same on every receipt of an item, and a business's
  notice measured from when the network stored its cancellation, on its clock (`intake`).

Its document adds `order.reach_1_after_days`, the newcomers' `group`, `per_group_per_hour` and
`turn`, `score.shown`, `verified.unknown`, `verified_evidence` and `verified_kept_share_min` on the
business tiers and `intake`;
version 7's document stays as it was published, but for `next`. A network puts version 8 in force as it does versions 5 and 6, and never before version 7 takes
effect, since it amends it; when both take effect together, a version 6 network's `next` (and a
signed ping's `next_rules`) names version 8.

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
  closes (no overnight windows), at most six a day; a day left out is closed. A window may close at
  `24:00`: `["00:00", "24:00"]` is the whole day, and open through the night is a window to `24:00`
  and the next day's from `00:00`. A closure is whole
  days, both included.
- `services`: `[{"name": "Haircut", "type": "booking"}]`, at most 30: each service's name (80
  characters) and how it is taken (`booking`, `order` or `quote_request`). Prices and durations stay
  at the inbox, where they are current.
- `categories`: slugs of the categories list ([`vocab/categories.json`](../../packages/spec/vocab/categories.json):
  35 slugs, each with English and Portuguese labels and synonyms). A network reads a label or
  synonym as its slug, and keeps anything else a profile names as a free tag.
- Protocol 0.2 adds:
  - `place_category`: `{"primary": "hair_salon", "alternates": ["beauty_salon"]}`, place category
    ids (§4.10), at most two alternates. A network keeps an id it knows; one it does not know, or one
    it does not list, it drops alone.
  - `attributes`: `{"walk_ins": true, "cert": "b_corp"}`, keys of `GET /v1/attributes`. A network
    keeps a key that applies to the business's categories and drops one that needs a proof it
    cannot check yet.
  - `price_band`: 1 to 4. `currencies`: up to 5 ISO 4217 codes.
  - `payments` (18 October 2026): how customers and their agents can pay, at most 64 tokens of
    [`vocab/payments.json`](../../packages/spec/vocab/payments.json) (`card`, `apple_pay`, `paypal`,
    `pix`…). A network keeps the tokens it knows, reads a name its synonyms list as its token, drops
    anything else alone, adds `card` for a card brand (`visa`, `mastercard`, `amex`), and shows them as
    declared by the business (§4.10).

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
not two `HH:MM` opening before closing (the closing one may be `24:00`), and a closure that is not two real dates in order (the
calendar has no year 0), merges windows that overlap, and forgets closures that have ended. Hours it
cannot keep whole it drops whole: without its closures, a business would show open on a day it said
it is closed. `vectors/profile.json` holds the cases. Nothing in a profile is scored, and nothing in
it orders the directory (§4.3).

### 4.7 Assistants

A network SHOULD let an assistant find businesses without a key or a session, through three doors
that give the same answer: `GET /v1/businesses` (§4.3), an MCP server at `POST /mcp`, and two
documents, `GET /openapi.json` (OpenAPI 3.1 of every public read) and `GET /llms.txt` (the same in
plain words, MCP first, in the llms.txt layout). Every answer is the same whoever asks, and none of it
books or orders anything itself: a result names the business's own inbox, and the assistant goes there,
or asks the network to carry its person's request there (§4.17).

**The MCP server** is stateless: it opens no stream and keeps nothing between two requests. It MAY
answer `initialize` with an `Mcp-Session-Id` it signed, only to tell its callers apart for its limits
(spec 0.8): it stores nothing for it, never requires it, and serves a request without it, or with one it
did not sign, the same. It MAY answer the same at `POST /mcp/search`. It serves both eras of the
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
| `check_business` (0.3, optional) | `url`: a website or a bare domain; `fresh`: read it again | a check's result (§4.13) |
| `report_door` (0.4, optional) | `POST /v1/door-reports`'s body (§4.15) | its `202` answer |
| `ask_business` (0.8, optional) | `domain`, `message`, `subject?`, `contact {email, name?}`, `consent: true`, `language?` (§4.17) | what became of it, and the inbox's own answer |
| `request_quote` (0.8, optional) | `domain`, `what`, `details`, `quantity?`, `needed_by?`, `contact`, `consent`, `language?` | the same |
| `request_booking` (0.8, optional) | `domain`, `service`, `start?`, `from?`, `party_size?`, `notes?`, `terms_sha?`, `contact?`, `consent?`, `language?` | the same, or free times |

Every tool says all four annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`), and no tool's description or answer asks the model to call a tool its person did not
ask for: the directories that list MCP servers refuse that.

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
It may start a read of the site within the network's daily budget, so it is annotated not read-only,
not destructive, idempotent and open-world; calling it again with the same URL reads the result. A
recent result is answered as it is; `fresh: true` asks for a new read, which a network allows a few
minutes after the last one and otherwise answers the stored result with when to ask again.
Checking a site is not claiming it, and never touches a listing. `update_business` takes
`score_page: "hidden" | "shown"`, which needs the claim token or a proof as `set` does, and answers
it back.

Spec 0.4: `report_door` (in `MCP_OPTIONAL_TOOL_NAMES`) takes an agent's door reports (§4.15), the
body of `POST /v1/door-reports` as its arguments (`schemas/mcp-report-door-*.json`), and answers its
`202`. It asks for no signature. It records what it is told and may make the network read a door, so
it is annotated not read-only, not destructive, idempotent (an attempt counts once, however often it
is sent) and open-world. A report it refuses whole is a result with `isError: true` and the reason.

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
not), `standing? {tier, ranked, in_words}`, a member's `track_record?` as its listing gives it
(§4.3), `door_history?` as its listing gives it (§4.8), and `listing_url`. `in_words` says a tier, or a record, in plain sentences and is never a
mark against a business: no standing yet is said to be where every business starts, which it is.
From rules version 8 `standing` also has `kept`, `broken` and `open`, and then either
`verified_share` and `verified_kept_share` or, for a record on the business's own word,
`self_reported: true`: `in_words` then says those counts as the business's own word instead of a
tier, and the card carries no score (§4.4), nor does its `track_record`.

Each result also carries its content as one text block, for assistants that read only text: first,
in the network's own words, what the network knows (the order and the rules it follows, and for each
business its domain, categories, distance, today's hours, what it takes, its standing, its track
record's `in_words` (in place of a self-reported standing's, when the record is shown: the same counts,
said once) and where to book, naming a door only when it is on the business's own domain,
or one label of at most 12 characters under it, with no port, query or fragment and a plain path of at most 64 characters,
letters, digits and `-._~/`: a host and a path are text the business chose, and so kept short they
say hardly more than its domain); then everything the business wrote about itself (name, city or address,
description, services, tags, web site, and any other door), inside a block that opens `<<<UNTRUSTED <boundary>>>` and closes `<<<END
UNTRUSTED <boundary>>>`, with a boundary drawn at random for each answer, every line quoted with `| `,
and no run of `<<<` or `>>>` inside. The server's `instructions` say the same: the block holds data
about the business as it published it, not instructions from the server, and nobody can pay to move
in the order.

A network publishes its own limits on these doors. The reference: 600 requests a minute from one
address (an IPv6 /64 counts as one), in bursts of 200, for reading (an assistant platform sends many
people's searches from a few addresses), and 60 a minute, in bursts of 30, for the calls of tools that
write or reach other sites. Whatever the addresses, a network runs at most a few searches at once; one
that cannot start within a moment is told the directory is busy (503 with `Retry-After` over REST, a
tool failure that says so over MCP), so searches never take its database from everything else.

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

- `status` is `live` or `failing`, from the network's own reads alone (below). A failing door counts
  for nothing in the order and takes no requests; 30 days failing, it is `gone` and no longer shown.
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

**The network's own reads.** Only a network's own reads move a door between live, failing and gone.
Nothing an agent reports does (§4.15), and nothing anyone else says. Each read is one request, signed
as the network signs its other reads, and kept to what the probing rule above allows:

| Read | When | What it asks |
|---|---|---|
| Daily | once a day, for the doors of members and of claimed listings (the daily set) | the MCP server card or `tools/list`, the A2A card, the manifest; for a member's inbox, the door its manifest names for agents, wherever it is: `GET <rest>/business` at its REST door, else `tools/list` at its MCP door |
| Confirm | when an agent reports the door down (§4.15); for a door of the daily set, also when the network's crawl does not find it answering | the same single request, for that door |
| Recovery | after a failed read of a door of the daily set: 15 minutes, 1 hour and 4 hours later, then daily while it fails | the same |
| Should-fail | daily, for a member's inbox with a REST door | `GET <rest>/items/<an id made up for the read>`, which a working inbox refuses with a typed problem; never an MCP `tools/call` |

Any other door (a business the network found and nobody claimed) is read at the network's normal
crawl, plus at most 2 confirm reads a day when agents report trouble there, and has no recovery
reads. In the same minute as a read, the network reads a door it knows works through the same route;
when that control read does not come back good, the result is thrown away. A read concludes one of
three things:

- **failed**: no answer (the name does not resolve; the connection is refused, reset or times out;
  TLS fails; nothing within 10 seconds), a 5xx that is not a challenge page, or an answer that does
  not parse as the door's protocol. An inbox's doors are public and answer where its manifest says
  they are, so for an inbox a redirect, or a 401 that is not the inbox's own typed refusal, fails
  the read too;
- **blocked**: robots.txt disallows the read, or the door answered 403, 429 or a challenge page.
  Blocked is never a failure: it never lowers a door, and only the business hears of it, as "our
  check was blocked";
- **good**: anything else.

**One state machine**, for every read the network makes, scheduled or crawled: a door is `failing`
after 3 failed reads in 7 days, the first and the last at least 30 minutes apart, with no good read
between them; `live` again after one good read; `gone` after 30 days failing. A blocked read changes
nothing. A read anyone may ask for (a result page's "Check again", `check_business` with `fresh`) only
ever adds: its good read lifts a door, and its failure never lowers one. A crawl's failed read counts
for a door the network does not read every day (a business it found and nobody claimed, a platform's
page, a declared API); for a door of the daily set, a crawl that does not find it answering asks for
a confirm read instead, while the network's own reads are being made (a network whose reads have
stopped counts the crawl's again, so a door whose server is gone never stays live). A door's history
follows its type, not its URL: the network keeps it by domain and door type, and carries it over a
change of URL for 90 days. [`vectors/door-reports.json`](../../packages/spec/vectors/door-reports.json)
(`reads`, `states`) pins this down.

**History** ([ADR-020](../adr/020-door-history.md); optional for a network). A network may keep, for
good, one line per door per UTC day of what its own reads concluded, for the door types it may show
(never `llms.txt`, an experimental type, a door a generic adapter found, or a page): how many
answered, failed (by class) or were blocked; of its daily checks, how many answered, were missed and
were refused; the median time its own reads took to get an answer; and the protocol version a crawl
saw, when it has the shape of one; and per door the first and last day a read found it answering. A
door is kept by its URL without the query or fragment. A read counts as the state machine counts it
(a check's failure, a read thrown away and a crawl's doubt about a door of the daily set are none),
and nothing an agent reports enters it. Opting out deletes it. A listing's detail and `get_business`
carry it as `door_history` for the doors the listing shows, and a site's current result for every
door type at every host a read found answering (never an off-site door the crawl could not tie to the
site), each `{type, host, first_seen, last_seen, days_seen, current, checks?, summary?}`, the doors
there now (`current`) first, then by `first_seen`:

- `first_seen` and `last_seen` are the first and last UTC day a read found a door of that type at that
  host answering, and `days_seen` on how many days one did, whoever asked for the read: a door the crawl
  reads about once a month is seen on few days, and nothing is said of the days between. `current` says
  whether one is there now;
- `checks` is only for a door read every day, and only from **14** checked days. A **daily check** is
  the network's daily read of the door, and only that: a read that was also the daily read then due
  counts, whatever else asked for it, but a read the crawl, an agent's report or the business asked
  for, and a recovery read after a failed one, are never checks, so no one can choose when a door is
  checked. The daily read keeps its time of day (it is next due a day after it was due, not after it
  was made), so a read a report asks for just before it never moves it. A check is **missed** when it
  failed, or was blocked while the door is down by the network's reads (at least three reads blocked
  in a row over at least 48 hours, as a network's published rules count a member's inbox down), and
  **refused** when it was blocked otherwise. A day is checked when a check concluded; it is missed when
  one of its checks was missed, else refused when one was refused, else answered: a failure and an
  answer fifteen minutes later is a day missed, and a refused day is never an answered one.
  `{first_checked, last_checked, days, answered, refused, recent}`: `refused` is the days refused, and
  `recent` the last **90** days ending on `as_of`, `a` answered, `x` missed, `b` refused, `.` no check.
  14 and 90 are the protocol's, not a network's to change; a network may leave `checks` out altogether;
- `summary` says it in words, the count first and the share floored to the whole percent after it:
  "Answered every check on 41 of 42 days checked since 3 Oct 2026 (97%)", with the days refused when
  there were any ("(75%; refused our check on 5)"). A door last checked more than 7 days before `as_of`
  says "from … to …" instead of "since". `summary` is informative and in English: the vectors pin
  `checks` exactly and mark `summary` informative; another network may word it differently, or in
  another language.

Below 14 days there is no share and no sentence saying why. Latency, read counts, blocked reads other
than refused checks, and failure classes are never shown. [`vectors/door-history.json`](../../packages/spec/vectors/door-history.json)
pins this down.

The network spends little on any one door: at most one read per door and one per host in 10 minutes,
at most 12 reads of a door a day, and at most 2 a day made by reports nobody can tell apart (§4.15).
The daily set is read first, its recovery reads before all; reads of other doors take at most half of
a day's reads, and those agents' reports ask for at most a quarter, so no stream of reports can take
the reads of members' doors. A read thrown away or never answered takes nothing from the day's reads.

### 4.9 Readiness levels

A business's level is the highest level among its live doors.

| Level | Meaning | Signals |
|---|---|---|
| `listed` | known to exist; human contact only | no agent door |
| `readable` | an AI can read its facts or catalogue | schema.org data, llms.txt, MCP read-only tools, NLWeb, a UCP or ACP catalogue, OpenAPI read operations |
| `askable` | a door declares a request kind it answers (ask or quote) | an inbox; an A2A skill; an MCP tool or an API operation declared as ask or quote |
| `bookable` | a door can book | inbox booking; declared MCP or API booking operations |
| `orderable` | a door can create an order or a cart, and none books: the same rung as `bookable`, never called `bookable` | inbox order; UCP or ACP checkout on a site that shows it sells (Product markup with a price on its pages, another door of its own that takes orders, or a product for sale in the catalogue its UCP profile names, when that catalogue is the site's own); declared MCP or API order operations |
| `payable` | the agent can also pay | UCP payment handlers, ACP delegated payment, AP2, x402 |

Levels come from the network's own probes; what a business declares is a hint until a probe confirms
it. A door behind a customer account never raises a level. A UCP or ACP profile on a site that shows
nothing for sale (no Product markup with a price, no other door that takes orders, no product for
sale in the catalogue its UCP profile names) raises it no higher than `readable`: a website platform
may serve one on every site it hosts. A priced menu, a list of services or an offer with no price is
no Product markup, and a catalogue that refuses a network's read, lists nothing for sale, lists nothing but a
template's sample products or services and events, or is another business's, shows nothing. A UCP or
ACP profile never makes a business `bookable`. **Agent-ready** means `askable` or above.
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
| `accepts` | `{kinds, pay?, pay_with?}`: the kinds its live doors take, the payments it accepts (tokens of `GET /v1/attributes`' `payments`: methods, wallets and the ways an agent itself pays), and each of them with its evidence (below) |
| `category` | `{primary, alternates, path, group?}`: place categories, each `{id, label, src}`; `path` is the primary's ancestors, root first; `group` its slug of the categories list |
| `attributes` | `{key: {v, src}}`, keys of `GET /v1/attributes` |
| `place` | for entries that are not members: `{locality?, region?, country?, kind, service_area?, ships_to?}`; `kind` is any of `storefront`, `service_area`, `online`; a service area is a radius (at most 300 km) or up to 50 countries |
| `why` | why it is in this place of the list, in plain words |
| `found` | §4.11 |
| `facts` (detail only) | every displayed value as `{field, v, src, url?, at, via?}` |
| `door_history` (detail only) | the history of the doors it shows, from the network's own reads (§4.8) |

**Categories.** A listing's `categories` stay the slugs of the categories list (its 35 groups). A
place category is an id of the Overture Maps Foundation's **Overture Place Categories** taxonomy
(licensed CC BY 4.0), which a network names with its release in `taxonomy`; each group covers some of
its subtrees. `GET /c/{id}` answers one: `{id, label, parent, path, group?, regulated?, taxonomy}`, or
`404`. A network may leave whole categories unlisted for entries that are not members; `regulated`
says why, and members are not affected. This network lists every kind of business except adult
services, gambling, weapons, tobacco, cannabis and vaping, payday loans and bail bonds.

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

**Payments.** [`vocab/payments.json`](../../packages/spec/vocab/payments.json) (version 2) lists every
token with its English label: `methods` and `wallets` are how a person pays, `agent` the ways an agent
itself pays at a door. A token is never removed or renamed. `accepts.pay_with` gives each of a listing's
`pay` tokens as `{token, label, src, via, url?}`, with the strongest evidence the network has for it:

- `declared`, when the business said so itself: its registration (`via: registration`), its inbox's
  manifest (`manifest`, `profile.payments`), its own structured data (`schema_org`, `paymentAccepted`),
  its own UCP profile's payment handlers (`ucp`, each handler's name read against the vocabulary's
  `handlers`, anywhere in the name, then `handlers_last`, only as the whole of its last part), ACP
  delegated payment (`acp`), or an agent payment protocol its door's document declares in its structure
  (`door`: x402 or AP2 as a member of its own, or named in a payment, scheme, protocol or extension
  member);
- `seen`, when it did not: the network saw a payment provider's own code, button, hosted checkout link or
  a Shopify storefront's payment icons on the site's pages (`page`), or its Apple Pay domain file
  (`/.well-known/apple-developer-merchantid-domain-association`, `file`); a door's document names an
  agent payment protocol only in passing, its prose included (`door`); or its shop platform's standard
  UCP profile lists it (`ucp`: the handlers a platform gives nearly every store, such as Shopify's
  `dev.shopify.card`, `dev.shopify.shop_pay` and `com.google.pay`, in a profile that names the
  platform's own handlers).

A token declared and seen is declared. A card brand (`visa`, `mastercard`, `amex`) says a card: `card` comes
with the brand's evidence. `url` is where the evidence is, absent for a registration. A page's words are
never evidence, nothing is a model's reading, and a UCP or ACP profile the network does not count (a
platform's blanket profile, §4.13) gives none. A reader does not refuse a `via` it does not know: a later
network may add one. `accepts=` reads `declared` and `seen` alike; a reader that needs the business's own
word reads `src`. `ucp_handlers` says a UCP profile names payment handlers: it is the protocol, not a way a
person pays, and a page for people leaves it out (the handlers it names are listed themselves).

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
  store, once the network has not checked it for 180 days, all but its doors' history (§4.8), which a
  network may keep for good unless the site opts out;
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

A network SHOULD offer the same to a business's owner with no AI and no account: the reference
network's is `/b/<domain>/owner` (the result page's `owner.manage`), with the `dns` and `code`
proofs. A code goes only to an address at the domain the owner picks, never one typed: a role
address, or one the site itself publishes. The address that holds a listing's code claim is never
locked out of a new code. A correction is kept field by field (what was declared or shown before,
what it is now, the proof's label, who made it, and whether it came from the page or the tools), and
every fact a listing shows that the business said itself, by registering or correcting, carries
`via: "business"` in its `facts` (§4.10), so a reader tells the business's word from what was read.
Nothing a person does on that page lifts a suppression the site asked for, unless they ask for it
to be read again.

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
order, sign up, cancel or negotiate here, and the journey around those.

**The vocabulary** ([`vocab/capabilities.json`](../../packages/spec/vocab/capabilities.json)) lists 20
capabilities in a fixed order, which breaks every tie: `find`, `catalogue`, `availability`,
`message`, `negotiate`, `book`, `order`, `signup`, `pay`, `change`, `cancel`, `track`, `return`,
`receipt`, `feedback`, `subscription`, `vouchers`, `waitlist`, `support`, `policies`. Six lead every
result: `message`, `book`, `order`, `signup`, `cancel` and `negotiate`. **Sign up** (`signup`) asks
whether an agent can sign the person up: an account, a membership, a class, a course or a newsletter
list for the business's own service. A network reads it from a tool, skill or operation that signs a
person up (`sign_up`, `register`, `create_account`, `join`, `enrol`, a membership sign-up, a
newsletter subscription, a schema.org `RegisterAction` or `JoinAction`), through its door registry's
capability rules, never from one that logs a person in. A capability is `yes`, `partial` (met through a
door behind a customer account, or payment described but not done by the agent), `no`, or `na`
when it does not apply to that kind of business.

**Evidence** is a ladder: `declared` (the business's own site or door says so), `tested` (a probe
tried it) and `proven` (agents reported using it). Versions 1 and 2 of the rules produce `declared` alone.
A capability read from a tool's name, a page's words or a page's marker is still `declared`, with a
`basis` saying which (`tool_name`, `skill`, `operation`, `item_types`, `protocol`,
`structured_data`, `page`, `manifest`): the business published that name. A `probably` value never
counts, a failing door counts for nothing, and a door on another host counts once its own document
names the business (§4.8).

**Profiles and what does not apply.** A business is scored for its kind, and what does not apply to
that kind leaves the denominator: a plumber is not marked down for having no catalogue.

| Profile | Applies |
|---|---|
| `appointments` (salons, clinics, lawyers, advisers, tours) | find, catalogue, availability, message, book, change, cancel, pay, policies, feedback |
| `classes` (classes, lessons, tutoring and childcare; version 2) | find, catalogue, availability, message, book or sign up (one capability), change, cancel, pay, policies, feedback |
| `food` (restaurants, bars and food) | find, catalogue, availability, message, book, order, change, cancel, pay |
| `trades` (trades and quote-led services) | message, negotiate, book, change, cancel, pay, receipt |
| `shop` | find, catalogue, availability, order, pay, change, cancel, track, return, receipt |
| `stay` (places to stay and transport) | availability, book, change, cancel, pay, message, policies |
| `memberships` (gyms and memberships) | find, catalogue, order or sign up (one capability, version 2), book, subscription, cancel, pay |
| `venues` (live music, clubs, theatre, cinema, museums; version 2) | find, catalogue, availability, message, book or order or sign up (one capability), pay, change, cancel, policies |
| `general` (type unknown; also software, API and AI companies) | find, catalogue, message, book or order or sign up (one capability, version 2), pay, policies |

Each profile names the category groups it covers; a business without a category the network can
read from the business itself is scored by its doors' signals, or as `general`. **Version 2** (in
force from 7 October 2026) changed three things. The `general` profile is scored on whether an agent
can book, order or sign up there: its **either set** `book`/`order`/`signup` counts as one member of
the core group, met by the best of the states, never `na`; under version 1 none applied, and a site
that took messages and nothing else scored as high as one that also sold. That profile covers a business
of a kind not known and the group `software-ai`; the groups `health`, `dental`, `therapy` and `legal`,
under it in version 1, are `appointments` (booking counts, ordering does not apply) and `bar` is
`food` (booking a table and ordering both count), so a clinic, a dentist, a therapist, a lawyer, a
bar or a software company that takes no booking or order through an agent scores lower under
version 2 than under version 1. The kinds this network now lists (every kind but adult services,
gambling, weapons, tobacco, cannabis and vaping, payday loans and bail bonds) are scored where their
own actions apply: `finance` (banks, insurance, financial advice, loans), `property` (estate agents),
`recruitment` and `accounting` (scored as `trades` in version 1) as `appointments`; `childcare` as
`classes`; `transport` (airlines, ferries, coaches, taxis and drivers) with places to stay as `stay`;
wineries and distilleries in `bar`; pharmacies, drugstores and hearing aids in `shop`; licensed
trades in `trades`. And **venues** (the
category group `venues`: music venues, jazz clubs and nightclubs, theatres, cinemas, concert halls,
comedy clubs, museums and galleries, event spaces) are a profile where booking tickets, a table or
an entry, ordering them, or signing up, counts the same way (the same either set). And sign up is a
capability of the core group where it is natural: with book and order as one for `general` and
`venues`; with order as one for `memberships` (joining is buying the membership); and with book as
one for `classes`, the category group `education` (classes, lessons and tutoring), scored before as
`appointments` with the same weights. No group's weight changed, and a business that signs nobody up
scores as it did. A network recognises a venue
from what it publishes, in this order: a venue's schema.org place type (`MusicVenue`, `EventVenue`,
`PerformingArtsTheater`, `MovieTheater`, `Museum`, `ComedyClub`, `NightClub`) decides; then a site
that is an online shop, or a software company by the software type it declares, is that (one read as
a software company from its doors alone gives way to a venue its own words name); then a phrase that names a venue ("jazz
club", "concert hall", "opera house", in several languages; never one generic word such as
"concerts", "theatre", "cinema" or "museum") in its own name and description, for a site that says
where it is (an office's address on a plain `Organization` does not count) or whose own name holds
such a phrase of two words or more; then the events it publishes at an address it gives. Such words
never replace a language model's reading of the site as another kind (a bar, a restaurant): the
venue is then a probable alternate. A language model's reading stays a hint.

**What follows** (version 2 as amended on 8 October 2026). What counts follows what a business lets
an agent do, on top of its profile: the rules' `follows`. When a capability its profile counts is
`yes` or `partial`, the capabilities it brings count too: an **order** brings `change`, `cancel`,
`track` and `receipt`, and `return` when the business sells goods; a **booking** brings `change`,
`cancel` and `availability`; a **sign-up** brings `change`, `cancel` (changing or ending the
membership or account) and `subscription`. The rules' `goods` says who sells goods: a business scored
as a `shop`, or one whose signals say so (a live UCP, ACP or Shopify checkout door, or a catalogue of
at least three products), never one scored as `food` (a takeaway is not returned). What a profile
already counts stays as it is, no weight or grade changed, and book, order and sign up count as one
where they did. So a full score needs the steps after the booking, the order or the sign-up: a
business of no known kind where an agent can find it, read its catalogue and policies, message it,
order and pay, and do nothing after it, scored 100 before the amendment and scores 58 (C); with
changing, cancelling and tracking the order and a receipt it scores 100 again, and 92 (A) selling
goods without returns. A business where an agent can do none of book, order and sign up scores as
before, since nothing follows.

**Requests, and a message for every kind** (version 2 as amended on 12 October 2026). A request
counts as doing it (the rules' `requests`): where an agent can file a request to change, cancel or
return something and gets back a reference it can follow to the answer, that is `yes`, the same as a
door that carries it out at once, whether or not a person at the business approves each one. And
`message` applies to every profile, `shop` and `memberships` included: for a shop, message, order and
pay are a third of the core group each. Cancelling a cart, a basket or a checkout is not `cancel`,
which is cancelling an order or a booking.

**Groups and weights** (rules versions 1 and 2): `core` 40 (message, book, order, pay; sign up too
from version 2), `after` 30 (change,
cancel, return, subscription, receipt), `state` 10 (availability, track), `negotiate` 5, `readable`
10 (catalogue, policies), `find` 5; feedback, vouchers, waitlist and support are shown and not
counted. `yes` earns two halves, `partial` one, `no` none. The arithmetic is integer, the same in
every language:

```
For profile P: A_g = members(g) ∩ applicable(P), for each group g with weight > 0, where applicable(P) is P's applicable capabilities and what each of the rules' follows adds when its if is applicable to P and yes or partial (one marked goods when the business sells goods), and the capabilities of one of P's either sets count as one member of A_g, whose halves are the most any of them has. A group with A_g = ∅ is dropped.
possible = Σ_{g: A_g≠∅} W_g
N        = Σ_{g: A_g≠∅} W_g × s_g × (60 / |A_g|)      where s_g = Σ_{c∈A_g} halves(c)   (|A_g| ≤ 5; 60 = lcm(1..5))
D        = 120 × possible
score    = (100 × N + D/2) div D                       (round half up; 0..100)
grade    = A ≥ 80, B ≥ 60, C ≥ 40, D ≥ 20, E < 20
```

That is version 2's formula as amended; version 1's is the same without the follows and either
clauses. A capability's displayed weight is `W_g / |A_g|` to one decimal place (each member of an
either set shows the set's), over what applies. **Fixes** are each applicable,
weighted capability that is not `yes`, scored again as `yes`, an either set being one fix under its
first capability (`book` for book, order or sign up; `order` for a gym's order or sign up), due while none of its capabilities is `yes`: the points it would add, by points,
then group order, then vocabulary order; a fix worth nothing is left out. A fix that makes more
apply (letting an agent book brings changing, cancelling and availability) is scored with what it
brings as `yes` too, and lists it in its `with`: its points are what the whole interaction is worth. A fix's text in the rules
may hold `<door>`, which a network replaces with " on your <door label> door at <url>" when the
business has a live agent door, and with nothing otherwise. `scoreOf`, `fixesOf` and
`capabilityWeightOf` in `@surfingdog/spec` are the reference; `vectors/score.json` holds the worked
cases, a salon at 51 (C), a restaurant that takes orders it does not let an agent track or receipt at
63 (B), a plumber at 33 (D), a shop that takes orders and no message at 42 (C), and under version 2 as amended a business of no known
kind that takes messages and nothing else at 42 (C, 55 under version 1), one that books and takes
payment and lets an agent neither change nor cancel at 39 (D), a software company that takes messages
and signs people up at 43 (C), a gym that signs people up and books classes at 42 (C), a school that
enrols at 49 (C), a business of no known kind that takes orders and payment and nothing after them at
58 (C) and with changing, cancelling, tracking and a receipt at 100 (A), and a salon that books at 68
(B) without changing and cancelling and 100 (A) with them, and a shop where an agent can do the whole
order at 86 (A) without a way to message it and 100 (A) with one, among them; `vectors/score-v1.json` holds
version 1's. Each case says whether its signals say it sells goods (`goods`).

**The rules are published and versioned** like the directory's own: `GET /v1/score-rules` is the
version in force and `?version=N` any version ever published (`404` for one that never was), shaped
as `schemas/score-rules.json` ([`vocab/score-rules-v2.json`](../../packages/spec/vocab/score-rules-v2.json)
is version 2, in force; [`vocab/score-rules-v1.json`](../../packages/spec/vocab/score-rules-v1.json) is
version 1, its `status` `retired`). Each version's `changelog` says what changed and why, and an
amendment of a version in force is an entry of its own (`amended`, the day) saying the same. A new
version, or an amendment, is applied to every score the network keeps: each is worked out again.

**The score never changes the directory's search order** (§4.4), and nobody can pay for a score or a
place. It is not a certification: it is what was read on the business's own site and doors on the
date shown, each capability with its door, its source and its date.

**Checks and result pages.** Anyone may ask a network to check any website (`check_business`, or a
form at the network's `/check`); a check is read within the network's daily budget and never claims,
lists or changes a listing. Its result is `GET /b/{domain}` (a page) and `GET /b/{domain}.json`
(`schemas/check-result.json`): the state (`not_checked`, `queued`, `checking`, `scoring`, `done`,
`blocked`, `failed`, `hidden`, `not_checkable`), and when done the score, the grade, the profile,
the six lead answers each with its door and date, every capability, the fixes, a plain message the
owner can hand to whoever runs the site, and the rank. For a domain the directory lists as a member,
a result that is `done`, `not_checked`, `blocked` or `failed` also carries the member's `track_record`
exactly as its listing gives it (§4.3), and a result that is `done` also carries `door_history`
(§4.8); the page draws a shown record that is not self-reported as a thin meter of kept against broken, with
the counts in words; a self-reported one as its counts in words, labelled "Self-reported", with no
meter; and never puts either in the rank, which is the agentic score's.

**Ranks and leaderboards.** A leaderboard (`GET /leaderboard.json`, `schemas/leaderboard.json`)
orders, on every board: **whether an agent can book, order or sign up here (yes, then partly, then no
or not applicable), then agentic score, then the most recent check, then domain**, by category group,
country and place. It says that order in words (`order`) and field by field (`order_by`), and each
row carries `can_book_order_or_sign_up` (`yes`, `partly` or `no`). The score itself is unchanged by
the order: a business that can be booked scores what its rules give it, and comes above one that
cannot be booked, ordered from or signed up with, whatever that one scores. It counts every business
checked that its owner has not hidden and that is of a kind the directory lists.
Software, API and AI companies (the group `software-ai`) are ranked among themselves, on their
group's board, and on no board of every kind, of a country or of a place. A leaderboard's
`position`s run 1, 2, 3… among the businesses it names; a result page's rank ("#4 of 61 … checked")
counts every business checked, named or not, in the same order. A board of every kind says how many
software companies it leaves out (`software_and_ai`). It is a separate list from the directory, and it
says so.

**Lists behind the counts.** `?can=<capability>` (one of `message`, `book`, `order`, `signup`,
`cancel`, `change`, `negotiate`, `catalogue`, `availability`, `pay`, `track`, `return`) lists the
agent-ready businesses where an agent can do that, and `?ready=1` every agent-ready business, of
every kind, software and AI companies too, in the same order: the same businesses a network's
`/v1/stats` counts in its `directory` block (whose `capabilities` count `signup` too), so a count
links to its list. A list names those it may name and says how many more it counts and does not name;
the count is always the sum. A chip for a category group counts the businesses that group's board
names, and a group nobody is named in has no chip.

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

### 4.14a A business's inbox, found from its domain (spec 0.7, MAY)

An inbox answers at its own host, often `inbox.<domain>`, with its manifest at
`/.well-known/agent-inbox.json`. An agent that knows only the business's domain is led there by any of
five ways, each a line the business adds where it already publishes things (ADR-002, ADR-024):

| Way | What the domain publishes |
|---|---|
| `well_known` | its own `/.well-known/agent-inbox.json`: a copy of the inbox's manifest, or a redirect to it |
| `llms_txt` | a line in `/llms.txt` linking the inbox's manifest: `- [Agent inbox](https://<host>/.well-known/agent-inbox.json): send us messages and requests` |
| `link` | `<link rel="agent-inbox" type="application/json" href="https://<host>/.well-known/agent-inbox.json">` in its pages, or the same relation in an HTTP `Link` field |
| `schema_org` | a schema.org `potentialAction` whose `target` (a URL, or an `EntryPoint`'s `urlTemplate`) is the inbox's manifest |
| `dns_txt` | `_agent-inbox.<domain> TXT "v=sdi1; manifest=https://<host>/.well-known/agent-inbox.json"` |

`vectors/discovery.json` holds the exact lines for given inputs; every builder of them gives those.

A network MAY check them: `GET /v1/discovery/{domain}?host=&target=` (`schemas/discovery-result.json`),
and the MCP tool `check_dns` with the same answer. It reads as a browser would and nothing the site's
robots.txt keeps its reader off, follows redirects only within the domain, its `www.` and the inbox's
host, and answers each item (`cname`, `manifest`, `robots`, and the five ways) with `ok`, `missing`,
`wrong`, `blocked` or `unreadable`, a sentence, and when it is not `ok`, the exact fix (`fix_lines`:
the text to paste alone). `robots` is `blocked` when robots.txt keeps out an AI assistant that fetches
for a person (`ChatGPT-User`, `Claude-User`, `Perplexity-User`…); keeping out training crawlers is
the owner's choice and never a finding. A robots.txt that answers 5xx or 429, or does not answer, is
read as RFC 9309 says (nothing else of the site is read) and is `unreadable`; a 4xx is no rules.
`ready` is the inbox answering, no assistant kept out, and at least one of the four ways **on the
website** in place; `state` says which of these holds (`ready`, `unreachable`, `blocked`,
`robots_unreadable`, `dns_only`, `no_way`), `site_ways` counts the website's ways, and `platform`
names the site's platform when the check read one. The public answer never says whether a host is a
hosted inbox's. An inbox reads the answer leniently (`readDiscoveryAnswer`): an item or a state it
does not know is left out, so a network can add them. The words a surface shows for it are
`vectors/discovery-words.json`.

A network MAY also offer `start_inbox`, the link where an owner sets up a hosted inbox for the domain:
the link carries the domain and nothing else, and the tool never signs anyone up or takes an email.

### 4.15 Door reports (spec 0.4, MAY)

A network MAY take **door reports**: an agent says how each use of a business's door went, done or
not, in one call. A report measures a machine: did the door answer, was the operation done, refused
or failed, did it need a person, and how long it took. It is never about a person, and it never shows
that a promise was kept: receipts do that (§4.2). Reports are measurements, not reviews
([ADR-019](../adr/019-door-reports.md)).

`POST /v1/door-reports`, or the MCP tool `report_door` (§4.7) with the same body as its arguments and
the same answer as its `structuredContent`:

```json
{"v": 1, "reports": [{
  "domain": "bakery.example",
  "door": {"type": "mcp", "url": "https://bakery.example/mcp"},
  "op": "book", "tool": "create_booking",
  "at": 1791892777, "ms": 1840, "intent": "5mQ2c1Kc8Qx",
  "result": "fail", "class": "tcp.timed_out"
}]}
```

→ `202 {accepted: [{i, proof, counts}], ignored: [{i, why}], next}`.

**Signing is optional.** A call may be signed sdi-agent/1 with a self-held key (no pass is needed),
signed with Web Bot Auth, or not signed at all, and each is accepted. A signature only says whose
reports they are; it never makes a report count for more than its proof allows (below).

**Strict JSON.** Unlike every other call (§1), this body is strict. A member the schemas
(`schemas/door-reports-request.json`, `schemas/door-report.json`) do not name, at any level and in any
letter case, or a member named twice, makes the whole call `400 malformed`, as does a value of the
wrong type or outside its pattern. So nothing about a person can travel by mistake: no pass, key,
email, name, phone, address, message, body, IP address, item id, free-text reason or trace is ever
taken. A call is at most 100 reports and 128 KB, and a token at most 1 KB; over that, `413 too_large`.

| Member | Rule |
|---|---|
| `domain`, `door {type, url}` | A door the network shows for that domain, its type and URL exactly as shown: one of the listing's `doors`, or, for a member's inbox, type `inbox` with the inbox's address or one of the endpoints a card gives (`inbox.mcp`, `inbox.rest`). The URL carries no query or fragment. Else `unknown_door`. |
| `op` | What was attempted, from the capability vocabulary (§4.13). Else `unknown_op`. |
| `tool` | Optional: the tool or operation called at the door, lowercase, at most 64 of `a-z`, `0-9`, `_`, `.`, `-`. |
| `at` | Unix seconds, kept to the minute: at most 7 days old and at most 60 seconds ahead of the network's clock. Else `bad_time`. |
| `ms` | Optional: how long the door took to answer, at most 600000. Private. |
| `intent` | 8 to 32 base64url characters, one per attempt with all its retries. A source's attempt counts once, and its last result wins. |
| `result`, `class` | `ok`, with no class; or `refused`, `invalid`, `fail` or `info`, with a class of that result. Else `bad_class`. |
| `token` | Optional: the door's signed outcome token from its answer, as it came. A token that verifies decides the outcome, op and tool; a network that does not check tokens keeps the report as one without. |

Each report is taken or ignored on its own. An ignored one is in `ignored` with the first reason that
applies, in this order: `unknown_door`, `unknown_op`, `bad_class`, `bad_time`; then `superseded`, when
a later report in the same call is the same attempt, and `over_limit`, when its source sent more than
its share today. Every other report is in `accepted`, with `proof`, what proved it (`token`, a door
token that verified; else `signature`, a signature that verified; else `none`), and `counts`, what the
network kept (`row` or `counter`, both private). `next` says in one sentence what the network does
with them.

**Classes** ([`vocab/door-report-classes.json`](../../packages/spec/vocab/door-report-classes.json))
are reused, never invented:

| Phase | Result | Classes | What a report of it can do |
|---|---|---|---|
| reach | `fail` | Network Error Logging's names: `dns.name_not_resolved`, `dns.failed`, `tcp.timed_out`, `tcp.refused`, `tcp.reset`, `tls.cert.invalid`, `tls.failed`, `http.error`, `http.response.invalid`, `abandoned`; and `timeout`, `operation.timeout` | It may make the network read the door (§4.8), for a door it reads itself. It never counts by itself. |
| protocol | `fail` | `protocol.internal` (−32603), `protocol.advertised_missing` (−32601; A2A −32004), `protocol.version` (MCP −32022; A2A −32009), `protocol.invalid_answer` | It counts only with a door token that says the door erred. |
| operation | `fail` | `operation.tool_error`, `operation.failed`, `operation.internal`, `payment_failed` | The same. |
| operation | `refused` | `slot_taken`, `out_of_stock`, `item_unavailable`, `outside_limits`, `wrong_state`, `customer_side` | A refusal is the door working, never a failure. |
| needs_human | `info` | `escalation`, `auth`, `person` | Information only. |
| client | `invalid` | `client.invalid_params` (−32602), `client.parse_error` (−32700), `client.invalid_request` (−32600), `client.mcp_headers` (MCP −32020), `client.mcp_refused` (MCP −32021), `client.http` (4xx other than 408 and 429), `client.rate_limited` (every 429) | Kept privately, per tool, for the business ("agents sent `create_booking` arguments it cannot take 14 times"). Never public, never counted. |

A declined payment, an address the business does not deliver to and an eligibility refusal are all
`customer_side`: a report says nothing about the customer. `protocol.unsigned_answer` and
`protocol.signed_mismatch` are the network's own, from its reads; an agent never reports them.

**What a report can do.** No report changes anything public on its own. Only the network's own reads
move a door (§4.8), and every report reaches the business, privately.

| | No door token | A door token that verified |
|---|---|---|
| Nobody signed | A daily count per door, class and proof. A reach failure may make the network read the door, at most twice a day per door. | A row, private. |
| A self-held key, or a platform not independent of the business | The same, with the platform's origin kept (a platform-signed report is kept as a row). | A row, private. |
| An independent source | The same, and its confirm read goes ahead of the queue. | A row. A failure counts toward the door's public failures line. |

A platform origin is **independent** of a business when it serves a Web Bot Auth key directory on its
own origin, its registrable domain is neither the business's nor in the business's relations (§4.4),
and it has sent door-signed reports for at least 30 days at 5 or more members unrelated to each other
and to it. A self-held key has **standing** when receipts at 3 or more members name it as the agent
that carried the item, within 90 days, at members that are ranked on evidence this key did not
produce, that have been members for 90 days or more, and that sit in distinct relations components
and address blocks. A call nobody signed is never independent. Said plainly: no key has standing and
no platform is independent yet, since both need doors that sign their answers and receipts that name
agents. The door token's format, and the public failures line it makes possible, are specified with
the token itself; until then a network checks no token, and no report counts toward anything public.

`vectors/door-reports.json` pins the reading of a call (`calls`), what each report can do (`effects`)
and how a source's attempts count (`intents`).

**Limits.** The reference values: 60 calls a minute from one address (an IPv6 address's /64), in
bursts of 60, and 300 a minute from one address block (an IPv4 /24, an IPv6 /48) (then `429
rate_limited`); 1,000 reports a day from one self-held key and 50 at one door; 100,000 a day from one
platform (all the origins of one registrable domain together) and 5,000 at one door (beyond them,
`over_limit`); keys and platforms each have their own pool. Reports kept only as counts (unsigned or
key-signed) are at most 20,000 a day from one address block, then under a cap across the network, so
they cannot crowd out the rest; a report that would make a new count, or a new row, once the
network's day of them is spent is `over_limit` too. At most 10,000 rows per door a day, 70% of them
kept for door-signed reports from independent sources, 20% for other door-signed ones and 10% for
platform-signed reports without a token. Reports from one address block ask for at most 50 of the
network's reads a day, whatever doors they name. A network fetches a platform's directory at most
once a minute, learns at most one new platform a minute from one address block, does not fetch again
for an hour a directory it could not read, keeps at most 2 origins of one registrable domain and
5,000 registrable domains, and forgets a platform unseen for 90 days, or seen once and whose reports
left no row for a week.

**What a network keeps.** Reports are pseudonymous, with no person and no content. Counts per door (its
domain, type and the host of its URL), day, op, result, class and proof, and per tool only for a
client's own faults at a tool the network saw the door list. Rows only for door-signed and
platform-signed reports, each holding when it arrived, the door, `op` and `tool`, `at` to the minute,
`ms`, the result and class, a platform's origin, the source as a keyed hash that changes every 30
days, and the hash of a token's id. Rows are kept 30 days; counts by op and tool 30 days, then by
result, class and proof alone. A key is never shown to anyone, and a platform is named to a business
only when 5 or more distinct sources (keys) from it reported there within one 30-day period of the
source hash, over 7 days or more. A self-held key's
hash, with times and domains, may still be personal data of the person behind the agent, so an agent
tells its person that it reports how doors answer (for-agents.md §5).

**What the business sees.** A signed ping's `200` (§4.1) carries `doors`
([`schemas/ping-response.json`](../../packages/spec/schemas/ping-response.json)), of its own doors
only: its inbox, the doors of its own domain, and on a site its domain shares with others (a shared
host) only the doors on its own host or under it, never another business's. For each, the network's
own last read (`good`, `failed` or `blocked`) and the door's state; how many of the reads agents'
reports asked for found the door answering in 7 days (`not_reproduced`); what agents reported over 7
and 30 days, by op, tool, result, class and proof (`token`: signed by the business's door; `none`:
agents the network cannot tell apart), counts to the day, the most counted first, at most 50 lines a
door; the platforms with 5 or more sources over 7 days; open incidents to the hour, one per door,
each with when it shows publicly (`public_from`: from when it opened, as the door's state is public
then; none while the door's state is not yet shown); `trouble`, the doors where 5 or more reports
without a door token, from 3 or more address blocks in 24 hours, say the door is down while the
network's own reads see it answer; and one plain line to fix each class there is trouble with. A
member is emailed only when an incident opens, from the network's own reads or from door-signed
failures of independent sources: at most one email a day per address, and no digest. A claimed
listing that is not a member is not emailed yet; an unclaimed one never is. `POST
/v1/door-incidents/{id}`, signed sdi-instance/1 by the business, with `{"state": "fixed"}` answers
`200 {id, state, check_queued}`, and the network reads the door again as soon as its pace allows.

**Telling agents.** Every answer of a network that takes door reports carries `report: {tool, url,
guide, reward}`: `GET /v1/businesses`, `GET /v1/businesses/{domain}`, `GET /b/{domain}.json` and the
A2A door. Over MCP, `search_businesses`, `get_business` and `check_business` MAY leave it out, and ours
do (spec 0.8): `report_door`'s own description says when it is for, and an answer that asks the model to
make a call its person did not ask for is refused by the directories that list MCP servers. `guide` is `<network>/report.md`, an agent's guide
like `llms.txt`, linked from `llms.txt` ("Report how it went"), the MCP server card and the A2A card.
`reward` says what is true: reports may make the network read doors again (at most twice a day per
door, for the doors it reads itself), so an agent's searches send it to doors that work. Credit is the same for a success and a failure, and no answer differs for an agent
that reports.

### 4.16 The census (spec 0.6, MAY)

A network may publish, once a month, how many of the websites it checked an agent can do each thing
with. The method Surfing Dog's network follows, with every definition, is at
https://surfingdog.ai/spec/census/ (method version 1); another network may count by its own and say
so in `method`.

| Call | Auth | Answer | Schema |
|---|---|---|---|
| `GET /v1/census` | none | the published and withdrawn editions, newest first | `census-editions` |
| `GET /v1/census/{edition}` | none | one edition: `edition` is its month, `YYYY-MM` | `census-edition` |
| MCP `get_census` | none | an edition cut to a scope, or one key of it | `mcp-get-census-input`, `mcp-get-census-output` |

- An edition's `rows` are counts, one per `scope`, `key` and `metric`: the whole (`all`, key empty),
  and each `country`, kind of business (`group`), website `platform`, `source` (where the network
  found the site) and `city` with at least `method.min_sample` sites checked; `left_out` says how
  many keys of each scope were under it. Every published key has a row for every metric of its scope,
  zero included. A reader skips a scope or a metric it does not know: both are added to, never renamed.
- Metrics: `checked`; `agent_ready`; `can:<capability>` for every capability of the vocabulary
  version it names, counted among the agent-ready; `door:<type>`, counted among the agent-ready;
  `level:<name>`, a level below askable among the checked and askable and above among the
  agent-ready; `no_ai`, the sites whose doors reach askable and that ask AI systems to stay away;
  and for a city, `places`, its list's size. The levels and `no_ai` add up to `checked`. For the whole,
  each country and each city, an edition that names `payments` (the tokens it counts) also has
  `pay_read`, the sites whose ways to pay were read, and for each token `pay:<token>`, those that show it
  (§4.10), and `pay_declared:<token>`, those of them that declared it themselves; the difference is those
  where it was only seen. A metric is any lower-case name with at most one key after a colon.
- No row holds a website's name or domain, and a breakdown key is published only with at least
  `method.min_sample` sites checked. Small counts within a published key are published as they
  are: each counts public features of websites.
- `score_rules` names the rules the capabilities were read under, by version and the day they were
  last revised: a version amended in place counts differently. `method.rules_hash` and
  `method.rules_share` say which content, and how many of the checked were scored under it. A
  network does not publish an edition counted under a mix of rules.
- A published edition's counts never change. A mistake withdraws it (`status: "withdrawn"`, `note`
  says why); it stays readable. A draft is never served to anyone but the network's operators. An
  edition published from a draft taken before its month ended says why in `publish_note`.
- The data is open: `licence` names it, with the line to credit it by (`attribution`) and the credit
  for others' data the counts rest on (`credits`). Surfing Dog's census is CC BY 4.0, credited
  "Surfing Dog census, surfingdog.ai, CC BY 4.0", with "© Overture Maps Foundation" where its city
  counts rest on Overture Maps places data; its directory stays under the ODbL 1.0. A CSV of the same
  rows, `edition,scope,key,metric,value`, is a network's to offer.

### 4.17 Carried requests (spec 0.8, MAY)

A network MAY carry a person's request to a business's own inbox, when the person's assistant asks it
to and the business allows it ([ADR-025](../adr/025-carried-requests.md)): a question (`ask_business`), a
request for a quote (`request_quote`) or a request for a booking (`request_booking`), over MCP (§4.7). It
carries them only to an inbox that publishes a manifest (§4.1) on the business's own domain or one
label under it, through the inbox's own public API (`protocols.rest`: `POST /messages`, `/quotes`,
`/bookings`, and `GET /services` and `/availability` for a booking), the same doors any agent may use.
A network that carries requests says so in its own words: ours is *"Surfing Dog never touches the money
and never keeps what anyone writes. When a business allows it, we carry an assistant's request to the
business's own inbox and keep only a record that it was delivered."*

**The business's switch.** An inbox that has the owner's switch says it in its manifest either way:
`carried_requests: {"accepted": true}` accepts, `{"accepted": false}` refuses every network. A network
MUST NOT carry to a manifest that says nothing: that is an inbox from before the switch, whose owner
could not say no (outcome `no_inbox`). A network reads the manifest at most five minutes before it
carries, and an inbox serves it for a minute at most, so an owner's switch holds within minutes. A kind the inbox does not list in
`item_types`, or lists in `doors_elsewhere`, is not carried: the answer says where the business takes it.

**The person.** A request carries the person's email address and, if they give one, a name: never a
phone number. `consent: true` says the person agreed to give the business that address for its answer,
and nothing is sent without it. Their words go as they wrote them, at most 4,000 characters. Nothing the
person's assistant carries for them (a pass, a key) and nothing about the assistant's platform goes to
the inbox, and nothing about the person comes back to the platform: the answer has the inbox's item, its
words and the access token it hands an anonymous creator, never the person's address or the inbox's
`identity` block.

**The answer** (`schemas/mcp-ask-business-output.json`, the same for the three): `outcome` (`delivered`;
`confirm`, a priced booking whose terms the person confirms first, with `confirm {summary, terms_sha,
obligation_to_pay}`, sent again with `terms_sha` only after their yes; `times`, free times and nothing
sent; `not_free`; `refused`, `busy` or `failed`, from the inbox; `switched_off`, `no_inbox`, `not_taken`,
`elsewhere`), `delivered`, `business`, `inbox`, `item {id, type, state}`, `status_url`, `access_token`,
`answer` (the inbox's own words, quoted as data) and `kept`, what the network keeps. Free times are given
in UTC with the business's `timezone`, and an assistant tells its person the business's clock. A request
is sent with an `Idempotency-Key` made of the request itself (its kind, the business, the mailbox it is
for and its body), never of who sent it or when: a retry is the same request, which the inbox replays
(`replayed`, and the access token only the first time).

**What the inbox is told.** Besides the request, a network sends `Surfing-Dog-Carried: 1` and
`Surfing-Dog-Carried-For: <code>`, an opaque code that is the same only for one sender, one inbox and one
UTC day, and says nothing of who the sender is. An inbox MAY hold one carried sender to a limit, or turn
them away, by it, without turning the network away; neither header grants anything, and an inbox treats
both as said by whoever sent them. Ours marks the item (`flags.carried`) and acknowledges it by email at
most once a day per address. A network SHOULD refuse its carrying tools to a request with an `Origin` it
does not list, so no web page carries requests through its visitors' browsers.

**What a network keeps.** A record per attempt: when, which business, which kind, the outcome and the
inbox's status code. No sender, no contact, no words, no item id. It keeps no list of a person's
requests. Its limits hold what they need in memory (counts by caller, by keyed hash of an email address,
and of the words for an hour), never in a record. The business alone is told the counts, in a signed
ping's `200` (`carried {since, delivered, confirm, not_delivered: {outcome: n}}`, the last 30 days).

**Limits.** Per caller (a key, a session the network signed, else the address), per caller and business,
per address, per wider network, per email address (by the mailbox it reaches) and per email address and
business, per place and business, per business (hourly, and daily from everyone), the same words to few
businesses an hour, and the network's own total last; a request one limit refuses counts against none.
An assistant platform's published outbound range is many people, never a trusted caller: each address in
it keeps a limit of its own, and the range as a whole a share of the network's. A network MUST NOT carry to a business that has no inbox; a later version may
let a business that claimed its listing opt in.

### 4.18 Stays (spec 0.10, MAY)

A place to stay's inbox ([ADR-033](../adr/033-stays.md)) lists `stay` in its `item_types` once it has
a room to offer, and, where its area requires one, its short-term rental registration number. Its
manifest's `profile` MAY carry `lodging` (`schemas/profile-lodging.json`):

```json
{"lodging": {"kind": "guesthouse", "rooms": 6, "check_in_from": "14:00", "check_out_until": "10:00",
  "confirmation": "request", "answer_hours": 4, "registration": "STR-0427"}}
```

`kind` is a token of [`vocab/lodging.json`](../../packages/spec/vocab/lodging.json); `confirmation` is
`request` (every stay answered by the property), `instant_some` (rooms kept for direct guests confirm at
once inside their nights) or `instant` (the property's own system, written to first). A network drops
`lodging` alone, never the profile (§4.6): whole when its kind is not one it knows (read in any
capitals), a time is not `HH:MM`, `confirmation` is none of the three or `answer_hours` is outside 1 to
168; and within it, `rooms` outside 1 to 5,000 and a registration longer than 60 characters once
cleaned, each alone (`vectors/profile.json` holds the cases). It MAY show `lodging` on a listing; it
MUST NOT read `confirmation` as a promise that a given night is free.

A stay door elsewhere is `{"item_type": "stay", "url": …, "url_template": …}`: the property's own
booking engine, and its deep link with `{check_in}`, `{check_out}`, `{adults}`, `{children}` and
`{rooms}` to fill in, on the same host as `url` (`fillStayTemplate`, `vectors/doors-elsewhere-stay.json`).
A network that sends a person there fills the template; one that cannot sends them to `url`.

**Carried.** A network MAY carry a person's request for a stay (`request_stay`,
`schemas/mcp-request-stay-input.json`) to the property's own inbox under §4.17's rules: the business's
switch, the person's consent, their address and words and nothing else. The inbox answers with its own
quote later, or, where it confirms at once, with `confirm` and its terms; the same call again with
`terms_sha`, after the person's yes, books. A person's assistant may equally ask the inbox itself,
through its `get_property`, `check_stay_availability`, `quote_stay`, `request_stay`, `hold_stay`,
`book_stay` and `change_stay` doors.

What this version does not do:

- A network does not search stays across properties or relay one property's offers to a person: an
  offer from a place to stay is the inbox's own (an id only it can make, valid 15 minutes), and is never
  cached, compared or shown by a network.
- Receipts for stays carry no outcome codes a network publishes: until a rules version names them, a
  network keeps no record of stays.

**UCP Lodging (off; an optional binding to a third-party draft, not part of this spec).** An inbox MAY also
answer the [UCP Lodging booking draft](https://github.com/Universal-Commerce-Protocol/ucp/blob/f2626c28b8288976eee5bda77f3a9b1ddc0132b1/docs/specification/lodging/booking/index.md)
(`dev.ucp.lodging.booking`, read at commit `f2626c28`; [ADR-035](../adr/035-ucp-lodging.md)), and it ships switched
off: only an inbox whose operator set `INBOX_UCP_LODGING` serves `/.well-known/ucp` and the REST booking sessions
under `/v1/ucp/lodging`, and only for rooms it confirms at once (rooms kept for direct guests, or a property system
written to first). The mapping:

- `property`, `accommodation_type` and `rate_plan` are the property, its room types and its rate plans; a stay's `id`
  is `<room type>__<rate plan>`, with `__2`, `__3` for a second or third room alike, and every stay of one session
  has the same dates and rate plan.
- `totals[]` is the quote's lines: exactly one `subtotal`, whose `lines` are the rooms (with their nights) and the
  extras (`kind: "extra"`); each fee, tax and discount; exactly one `total`, which the addends sum to. A charge the
  property collects itself carries `collected: "at_property"`.
- `payment.terms[0].schedules[]` is the quote's schedule (`immediate`, `deferred`, `at_property`), summing to the
  total; each says on its own when it is due, in the property's time. There are no payment handlers: the property
  takes its own payments.
- `policies[]` is one `dev.ucp.lodging.policy.cancellation`: the policy's sentence, its `refundability` as of now,
  and `dated_steps` (`zone`, `steps[] {until, fee}`, `after`, `no_show`, in minor units).
- `messages[]`: `local_tax`, a disclosure whose `path` is the `at_property` schedule, for every charge the property
  collects; the cancellation policy as a disclosure at `$` whenever cancelling can cost anything; `totals_changed`
  (a disclosure at `$.totals`); `inventory_exhausted`; `occupancy_exceeded_capacity`; `lead_guest_required` while no
  lead is named; `payment_required` (`requires_buyer_input`) with a `continue_url` to the property's own page when a
  deposit or a card is due.
- Create and Update price the rooms (`quote_stay`); a named, reachable lead holds them (`hold_stay`). The hold stands
  while the rooms and dates do and the lead is reached the same way; other rooms or dates are priced before it is let
  go, and a change that cannot be had keeps it. Complete is `book_stay`; Cancel lets a hold go, or cancels a stay
  waiting for its payment. A booked session can no longer change.
- A session is a row the inbox keeps for as long as its stay: the hash of the id the platform holds (`bks_` and 32
  random bytes), the stay, and the last request, sealed. Guests' ids come back in every answer and are kept only
  sealed. `Idempotency-Key` is kept as UCP's REST binding says (`409` on another body); a Create's answer, which
  carries the session's id, goes back only to the key that signed it.

A property that answers each stay itself is not served: UCP needs one authoritative total in every session. In this
version a network does not read an inbox's UCP profile; it reads the inbox through its manifest (§4.8).

## 5. Persons and passes

### 5.1 First contact: `POST /v1/persons` (sdi-instance/1)

```json
{ "request_id": "01M34AVYNXTNSE2RC495H3W8QS", "email": "rita@example.com",
  "agent": { "label": "Example Assistant", "jkt": "…", "directory": "https://…" },
  "key_email": "network" }
```

`request_id` is 1–64 of `[A-Za-z0-9._:-]` (the inbox sends the item id); `email` is required and
normalised (§2.1: refused is `400 bad_payload`, "no email, no issuance"); `agent` is optional, and
its `label` names the first pass. `key_email` is optional: `"network"` asks the network to email the
person's key itself (any other value is `400 bad_payload`). Answers:

- `201 {key?, pass, presentation, ppid, person}`: a new person. The inbox hands the pass back to the
  carrying agent. A network sends `key` unless the inbox asked for `key_email: "network"`: then the
  key is not in the answer, and the network emails it to the address itself, so the business never
  holds it (below). An inbox that did not ask, or a network that does not know `key_email` (it
  ignores the member, §1), gets `key`, which the inbox then emails the customer (§7); an older inbox
  keeps working unchanged.
- `409 person_exists`: the network already knows a person with this address. Nothing is handed
  out; the agent must present the person's own pass or key (recoverable by email).
- `429 rate_limited`: the business's 50 issuances of the last 24 hours are used.
- The same `request_id` again, within 7 days, gets the same answer (`201` with the same pass, or
  `409`); with a different email it is `400 bad_payload`.

**The key email.** For an inbox that asked, the network keeps the new key and the address it was
given sealed, never in the clear, and sends the key once a receipt from the same business names the
person (`per`, §4): one short message in the business's name, from the network's own mail address,
with no other word of the network's (the code and the links carry its address), linking to its page
for people (`/me`, §5.3) and to "Not you?". The business is named by its name and its verified
domain ("Bakery (bakery.example)"), or by its domain alone when its name could pass for an address, a
link or a phone number. "Not you?" asks before it acts; then no key email goes to that mailbox again
and the key it carried stops working. At most one key email goes to a mailbox in 30 days (plus-tags
and Gmail dots folded, so another spelling of it is the same mailbox), within a daily cap across all
businesses, of which one business takes at most a fixed share (50 a day). Without such a receipt
within 7 days nothing is sent, and the sealed key and address are deleted; the person can get a code
from `/me` whenever they like.

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
| `ver` | `2` (absent or `1` is v1; anything else is refused); from rules version 8 a member's v1 receipts are refused, `422 v2_required` (§4.2) |
| `typ` | `booking` or `order` only |
| `knd` | `confirmed`, `paid`, `accepted` (promises) or `outcome` |
| `out` | exactly when `knd` is `outcome`: one of the inbox outcomes below, of the receipt's `typ` |
| `ref` | exactly with `out`: the `nonce` of the item's earliest promise (32 lowercase hex) |
| `due` | required, 1 to 2³⁷: a booking's start; an order's delivery time, else `iat` + 30 days; an outcome copies its promise's. From rules version 8 at most 400 days (a booking) or 60 days (an order or a refund) after the later of `iat` and the arrival, `422 due_too_far`; the same on every promise of an item, `422 promise_conflict`; and on an outcome its item's, `422 bad_payload` |
| `end` | a booking's end, not before `due`; never on an order. From rules version 8 at most 31 days after `due`, `422 end_too_far`, and the same on every receipt of an item, as `due` |
| `aut` | `1` when nobody decided it in the moment: the system (a booking completed after its end) or a rule |
| `per` | at most 8 `{n: "<network host>", p: "<presentation id>"}`, one per network holding a presentation for the item; each network reads only its own |

Every refusal of these is `422 bad_payload`. An acknowledgement's payload may add `pas`, a pass
reference.

An inbox issues v2 claims for the bookings and orders its customers made (and a shop's connector
brought in); the items a business makes itself keep v1 promises and record no outcome. They never
count, and from rules version 8 a network refuses them for good (`422 v2_required`), so
an inbox need not send them there. `iat` is the time of the event that caused the receipt, `due` and `end` are the same on every receipt of an
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
- Shows the owner, per network, the `doors` a signed ping's `200` carries (§4.15): how agents got on
  at its doors, what the network's own reads saw, and what to fix. It reads the block leniently: a
  part it cannot read is left out, and the rest of the answer counts as before.
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
- Seals a first contact's pass with its secret key, and the key too when a network sends one
  (§5.1), which it emails to the customer in an email of its own a day after their first booking
  or order; it deletes both within seven days. For a network that emails the key itself, it emails
  no code.
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
| 422 | `unknown_key`, `unknown_ref`, `bad_alg`, `bad_typ`, `not_yet`, `report_window`, `contest_window`, `bad_code`, `code_expired`, and from rules version 8 `v2_required`, `due_too_far`, `end_too_far`, `promise_conflict`, `ref_refused` (§4.2) |
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

