# ADR-017 — Reputation and ranking: network rules 0.1

**Status:** accepted, 22 September 2026; revised the same day for R28–R32 (§15); amended on 23
September 2026 by Amendment 1, in force as rules version 4 (§15). The decisions are
Tiago's; a number marked *default* is a proposal he may change without a new ADR (§14 lists every
number and whose it is). The first ranking was withdrawn on 22 September 2026 before it had been
designed as a whole, and the directory has since been neutral (newest verified first; near a place,
nearest first). This ADR is the public rules and the contract for the inbox and any network,
complete enough to build a compatible one (§7); our own network's code stays private. It replaces
the evidence weights of ADR-012 and ADR-016 and ADR-012's 12–18 month retention, and builds
ADR-013's list of networks.

## The rules in one screen

Numbers marked \* are defaults, changed only with 15 days' notice (§11).

1. **What counts (R2, R6, R30).** A promise counts when it closes. Kept: the booking happened, the
   order was fulfilled. Broken: the business cancelled or did not deliver, or the customer did not
   turn up. The inbox records outcomes itself; a verified customer's agent may report a broken one.
   A promise with no outcome 9 days after it was due counts as broken. Both sides (R15): a kept
   promise counts for business and customer, a broken one against whoever broke it, and against a
   customer only once their email is proven: someone using your email can't hurt you.
2. **The score (R5).** The share kept, estimated cautiously (Wilson lower bound, z = 1.2816\*): the
   less evidence, the more cautious. 20 of 20 beats 900 of 1000; 2 of 2 does not.
3. **Each piece weighs** outcome × time × source × repeat. Time (R14, R29): ≤ 30 days 1, ≤ 6 months
   0.75, ≤ a year 0.5, older 0.25\*, on the share and the confidence, never zero: 20 of 20 from two
   years ago scores 0.75. Source (R3, R13): 1 to 2 by the other side's own record, 2.5\* when a
   verified agent signed it: a counter-signature of that very receipt, or a report. Repeat (R7): a
   customer counts 1, each return +0.25\*, at most 3; one mailbox is one customer (`ana+1@gmail.com`
   is `ana@gmail.com`).
4. **The business's own word** (what no verified agent signed) gives at most 50\* outcomes' worth of
   confidence, ageing like the rest. A new business counts nothing for 30 days, then at most 30\*
   units more a month until day 90 (R31).
5. **The order (R10–R12, R32).** Answering businesses first; among them those at 0.40 or more
   (`building`) by score, then everyone else, newcomers included, in a daily shuffle. Silent 24 h\*:
   keeps its score, sorts after, "not answering since …"; once an inbox signs its pings, only its
   signed pings count. Near me: within `radius_km` (10).
6. **Tiers (R25):** `new`, `building` (≥ 0.40), `trusted` (≥ 0.75\*, with breadth). Nothing below.
7. **People (R16, R19–R22, R28).** One key per person per network, issued at a first booking and
   sent by email. Agents carry a pass or sign with our SDK. A business sees a person's record only
   when their agent presents it. Lost key: recover by email. Our network recognises only its keys.
8. **Forever (R8, R9, R17).** Every receipt is kept. Rules are versioned at `/v1/ranking`, changes
   announced 15 days\* ahead. Nothing about the order can be bought, and nobody is ever blocked.

## 1. Decisions

| # | Decision | In Tiago's words, where given |
|---|---|---|
| R2 | A promise counts when **completed**, not when confirmed or paid. New receipt kinds. | |
| R3 | A counter-signature adds weight only from a **verified** agent; otherwise it is the business's word. Only a token counter-signing that very receipt verifies (A1.1). | "Only a real counter-signature verifies a promise." |
| R5 | Score = **reliability with confidence**. 20/20 outranks 900/1000; 2/2 does not. | |
| R6 | Broken promises recorded **by the inbox automatically**, and reported by verified customers' agents. | |
| R7 | A distinct customer counts fully once; returning adds a little; cap 3 per customer. One mailbox is one customer (A1.4). | "One mailbox is one customer (ana+1@gmail.com counts as ana@gmail.com)." |
| R8, R9 | No cutoff; nothing ever drops to zero. Keep every receipt forever. | "ranks are permanent" |
| R10–R12 | No-record businesses after ranked ones, shuffled daily, ties too. Near me = best within the agent's radius (default 10 km). A silent inbox keeps its rank, sorts after answering ones, "not answering since …". A business that signs its pings answers only by signed pings (A1.2). | "Once an inbox signs its pings, only signed pings count." |
| R13 | Two-sided weights: evidence weighted by the reputation of whoever it came from. Businesses are related only by what they proved, never by a profile's contact email (A1.3). | "the more a customer ranks in confidence, payment etc the more weight their rank has, the same in reverse"; "Stop linking businesses by contact email." |
| R14 | Recency weights, never zero. | "the last 6 months ranks or last 1 month has different weight than older ranks, let's have a weight system" |
| R15 | Customers have their own reputation; businesses reward good ones; newcomers get neutral treatment. A customer's broken promises count only once their email is proven (A1.7). | "customers are the most important"; "Someone using your email can't hurt you." |
| R16 | Identity is **a key per person**, across agents and businesses, on the network that issued it (R28). Legal paperwork is a task list (§12). | "Me Tiago can have an unique key that I can use with multiple agents … It's attributed once and I keep it."; "don't care, this is how we go" |
| R17 | Publish everything: human rules, machine rules with changelog, Terms, notice before changes. | "the rank is core … publish them"; "I want human, short explanations" |
| R18 | Unsigned or unknown agents, and instances without the new receipts, keep working. | |
| R19 | Networks issue keys automatically on a first contact, through the inbox. | "Most users don't know about the network." |
| R20–R22 | Any agent uses a **pass**; SDK agents **sign**. Lost or stolen: recover by email. A person's reputation is seen only by a business their agent presents it to. | |
| R23, R24 | An inbox uses several networks (up to 8 in 0.1, a default). Open protocol, private code. | "people can launch their own networks and the inbox can ping multiple rank networks" |
| R25 | Positive first: tiers are about what someone has earned; nobody is excluded. | "I like how we focus on positive rank and not the opposite" |
| R26 | A guide helps agents identify themselves and the human. | "helping agents identifying themselves its a good one. or identifying the human." |
| R27 | Rules for customers the business already knows. | "Sometimes can be an existing customer. We should have rules for that." |
| R28 | One key per network; ours recognises only its own keys; later surfingdog.ai may become an approval body. | "initially just us and later we can check networks and become an approval body" |
| R29 | Old records drop slowly, never to zero: age lowers weight and confidence. | "Drop slowly, never to zero" |
| R30 | A promise with no outcome 9 days after it was due counts as broken. | |
| R31 | A new business's evidence is held 30 days, then released gradually. | |
| R32 | A business sorts above the newcomers only from 0.40 (`building`); below, it shuffles with them. | |

## 2. Identity

A **person** is a record at one network with an opaque id (`pid`), never shown to businesses and
never reused. The person holds plain-text strings any assistant can carry and paste:

| String | Format | Held by | Does |
|---|---|---|---|
| **Key** | `sdkey1_<network host>_<id>_<secret>` | the person; issued once, kept | Proves the person and mints passes, nothing more. |
| **Pass** | `sdpass1_<network host>_<id>_<secret>` | one agent | Presented to businesses in real requests; revocable alone. |
| **Pass reference** | `sdpass1_<network host>_<id>` | an SDK agent | Names a pass; honoured only in a request signed by a key delegated to it. |
| **Session** | `sdps_<secret>` | the person, 24 h | For `/v1/person`: history, contests, revocation, delegation. Only from an emailed code. |

`<id>` is a 16-character public id (also the wire `pass_id`) and `<secret>` 32 characters, RFC 4648
base32, lowercase, unpadded; `<network host>` is the network's lowercase punycode host (API
`https://<host>`), which cannot contain `_`. Presentation ids are 22 base64url characters. Networks
keep only SHA-256 of secrets. Keys and passes never expire; they are revoked. A pass with a
delegated signing key (§7.2) is **bound**: its secret form is refused, so a copy is worthless.

Everything beyond presenting needs a session, which needs the person's email: the business that
relays the key (R19), and any business that sees a pass, can borrow the person's standing (accepted,
R20) but never act as them. **Unusual use** (*default*): a pass seen at over 10 businesses in 24 h,
or with two signing keys, is flagged `unusual_use` to the person and in presentations; it keeps
working (R25) and revokes in one step. Businesses see only `ppid = base64url(HMAC-SHA-256(pairwise
secret, "<pid>|https://<business domain>"))[:22]`, never the `pid`.

**Email normalisation**, byte-identical in TypeScript and Go without a Unicode library: trim ASCII
whitespace; split at the last `@`; in the local part lowercase ASCII `A`–`Z` only (no NFC, dot or
plus folding; quoted local parts refused); lowercase each domain label and encode non-ASCII labels
with RFC 3492 punycode (hand-rolled in TypeScript, never `new URL()`), no UTS 46 mapping, no
trailing dot. A local part holding a space or any of `( ) < > [ ] \ , ; : @ "`, or a domain label
that is not `[a-z0-9-]{1,63}` after punycode, is refused by the network and the inbox alike, so
`me@evil.example,x@gmail.com` can neither pass as a gmail.com customer nor send a recovery code to
`me@evil.example`; such a customer still books, and no key is issued (§2.1, R25).
`email_mac = HMAC-SHA-256(network email secret, normalised email)`. Identity never folds an
address; counting customers does (§4's customer key).

### 2.1 First contact: the inbox gets the key from the network (R19)

A person never signs up. Issuance runs for customer actors on `create_booking` and `create_order`
(REST and MCP), and on the email door for DKIM-authenticated mail only (answering by email); never
for owner, staff, rule, connector or feed actors, messages or quote requests. When such a request
has `contact.email` and no pass or key:

1. The inbox creates the item as today, in one batch; nothing waits on a network. `pass` and `key`
   stay out of the idempotency hash, payload, thread and events.
2. It calls `POST /v1/persons` on every enabled network with `issue` on, in parallel, 3 s each,
   `request_id` = the item id; the network replays the same answer for 7 days (sealed, then
   deleted), so a retry never loses a key. No answer: the item is unaffected and a job retries.
3. On `201` it gets a **key**, a first **pass** labelled with the carrying agent and a presentation
   (a second batch seals them in `pending_identity`). The pass goes back in the response
   (`identity.passes` and MCP text, §8.4; the status door re-attaches it). The key rides on the first
   email to the customer, or within 24 h one line of its own, in the business's voice: *"If you use
   an assistant, it can show this code next time so we recognise you: sdkey1_…"*. Then it is
   deleted. The customer most often does not know any network exists, only that they contacted a
   business, so nothing a customer or their email sees names the network, a pass, a key or a
   receipt, and the sender is the business; the business can switch the line off
   (`customers.emailKey`, default on), and the pass still reaches the agent.
4. A person already known for that `email_mac` gets `409 person_exists`, and nothing is handed out;
   the inbox caches this 24 h and asks the agent for the person's pass or key, recoverable by email
   (§2.3). Meanwhile the customer is `new` on that network: neutral, never refused.

No email, no issuance. Issuance is limited (*default*) to 50 a day per business per network, `409`s
included (then `429 rate_limited`, retried daily for 7 days); every `409` is audited.

### 2.2 Many networks, one key each (R23, R28), and later an approval body

A person holds one key per network that issued one; Tiago chose this over a key shared across
networks. Each network is authoritative only for its own keys, passes and scores, and ours
recognises only the keys it issued: anyone can launch a network, including a careless or hostile
one, and a shared identity would let networks join up a person's history. An agent presents every
string it holds; the inbox, with several networks enabled, verifies each with the network
named inside it and shows per customer and per business the standing on each. Other identity
sources (ERC-8004 registries, ANS identities) are a later option (R26).

**Later: an approval body (R28).** surfingdog.ai may review other networks against these published
rules and publish a list of those it has approved, which inboxes may use to choose networks and
networks to decide whose keys to recognise. 0.1 defines nothing beyond that list; nothing depends on
it, and joining or running a network never needs our approval.

### 2.3 Recovery (R21), sign-in and visibility (R22)

`POST /v1/recovery/start {email, purpose: "recover"|"sign_in"}` always answers `202`. When the
`email_mac` matches, the network emails a 6-digit code without storing the address (10 min, 5
tries, 3 sends an hour). `/finish {email, code, purpose}` returns `{session}`, or for `recover` a
new key and pass on the **same `pid`** (the reputation carries over whole), revoking every older
key, pass, delegation and session; the email is then network-proven. One person per `email_mac`.
No public lookup of people exists: a business learns a person's standing only through a
**presentation** (§7.2) from a real request, each listed to the person at `GET /v1/person`.

### 2.4 Signed requests

**`sdi-agent/1`** (a customer's agent calling an inbox or a network) is RFC 9421, compatible with
Web Bot Auth (`draft-ietf-webbotauth-httpsig-protocol-00`, 1 September 2026, which folded in
`draft-meunier-http-message-signatures-directory-05`).

| Element | Rule |
|---|---|
| Key, label | `alg="ed25519"`; `keyid` = RFC 7638 JWK thumbprint, base64url, 43 characters; the first label tagged `web-bot-auth` (platform directory) or `sdi-agent` (self-held key). |
| Covered | `"@method"`, `"@authority"`, `"@path"`; `"@query"` if present; `"content-digest"` (RFC 9530, sha-256) for any body (MCP is a POST); `"signature-agent";key="<label>"` (the whole field for the legacy string form) or `"sdi-agent-key";key="<label>"`; `"sdi-pass"` when sent. |
| Parameters | `created`, `expires`, `keyid`, `alg`, `tag`; `nonce` ignored. `0 < expires − created ≤ 300` s; `created ≤ now + 60`, `expires ≥ now − 60`. `@authority` is the host of `INBOX_PUBLIC_URL`, else `notifications.appUrl`, or one in `identity.extraAuthorities`. |
| Keys | Platform: `Signature-Agent: <label>="https://platform.example"`, whose `/.well-known/http-message-signatures-directory` (public hosts, 5 s, 64 KB, ≤ 2 redirects, cached 300 s–24 h, failures 300 s, one new origin per IP a minute) must list `keyid`. Self-held: `Sdi-Agent-Key: <label>=:<base64 of the JSON JWK>:`, exactly `kty:"OKP"`, `crv:"Ed25519"`, `x`. |
| Person | `pass` field or MCP argument (≤ 8 space-separated strings) or `Sdi-Pass` (SF List of ≤ 8 strings); each ≤ 200 characters; GET: header only; first per network wins. |
| Result | `vouched`, `self` or `none`. `vouched` needs the platform's host in the `recognised_platforms` of at least one enabled network (its `/v1/ranking`, read daily beside the rules and cached in `network_status`); a platform no enabled network recognises is `self` at most, so `party_verified` and `reputed_principal` widen only through a recognised platform (R18). Per-IP tokens come before any signature work (platform keys also get a bucket, recognised or not; self-held keys never). A failure counts as unsigned, with `Sdi-Signature: invalid; reason="<code>"`. Only a replay is refused: SHA-256 of `Signature` is kept to `expires + 60` s on non-GETs, and a repeat gets the stored reply if it carries a matching idempotency key, else `401 replayed_signature`. |

**`sdi-instance/1`** (an inbox calling a network): the same with tag `sdi-instance`, `keyid` a `kid`
from the manifest's `receipt_keys`, and a covered `"sdi-instance"` header holding the instance
origin. Failures: `401` `unknown_instance`, `bad_signature` or `expired`.

### 2.5 Unsigned requests and existing instances (R18)

An unsigned or failed-signature request resolves as today; with no pass the customer is `new`, and
a pass without a signature works (that is how everyday assistants carry a person). Existing
instances keep working: v1 receipts are stored, never scored; **unsigned pings get `204` as today
and keep answering a business that has never signed a ping** (§6); once it has, only its signed
pings do. The new inbox sends v2 receipts only to networks whose
`/v1/ranking` `version` ≥ 3 (checked daily), v1 promises to others. Without `INBOX_SECRET_KEY` it
cannot sign, so it neither issues nor checks passes.

## 3. Evidence

Every outcome **closes** its promise and writes a standing row only on the sides listed. Weights
`o` are *defaults*; a broken promise never weighs more than a kept one (R25).

| Outcome | Rows | `o` | Emitted by (inbox unless stated) |
|---|---|---|---|
| `booking.completed` | kept, both | 1.0 | `complete`; or the system 48 h after the end unless marked no-show, with `aut: 1` |
| `order.fulfilled` | kept, business; customer too if paid or free | 1.0 | `fulfil` |
| `booking.cancelled_by_business` | broken, business | 0.5 with ≥ 24 h notice, else 1.0 | `cancel_by_business` from `confirmed` |
| `order.not_fulfilled` | broken, business | 1.0 | the owners' cancel after `accept` |
| `booking.no_show_business`, `order.not_received` | broken, business | 1.0 | a verified report that stands (§3.4) |
| `promise.unclosed` | broken, business | 1.0 (R30) | the **network** (§3.3) |
| `booking.no_show_customer` | broken, customer | 1.0 | `no_show` |
| `booking.cancelled_late_by_customer` | broken, customer | 0.5 | `cancel_late` under 48 h before the start |
| `order.payment_failed` | broken, customer | 0.5 | `payment_failed` |
| `order.charged_back` | broken, customer | 1.0 | `charge_back`; `record_charge_back` |
| `booking.cancelled_by_customer`, `order.cancelled_by_customer`, `order.lapsed` | none | — | a customer's cancel after the promise (in time, or ≥ 48 h before the start); the system `lapse` |

A **presumed** kept outcome, auto-completed or whose promise was published late (§3.3), counts
`o × 0.5` unless a verified acknowledgement backs it.

A **customer's broken outcome** (a no-show, a late cancellation, a failed payment, a charge-back)
counts against the item's person only when their email was **proven** by the outcome's date
(A1.7): network-proven (§2.3), for every business; or proven to the business that recorded it, for
its own outcomes only, when its inbox issued or linked the person with that address saying how it
proved it (`email_proof`, §7.1, §7.2) or the person's key was presented there. Otherwise it is
stored (R9) and never scored, even once the email is proven later: someone booking with another
person's email cannot hurt their record. Kept outcomes always count.

### 3.1 New states and transitions in the inbox

In `packages/core/src/machine/tables.ts`, an event that differs by from-state or actor becomes
several same-named entries. Every transition leaving a promise state emits exactly one outcome, via
one pure function `(type, event, from, actor) → (code, aut)`, tested over every path.

- **Booking.** New `cancel_late` (`confirmed → cancelled_by_customer`, customers, guard
  `outside_cancellation_window`, only when `booking.lateCancellation` is `"record"`), which
  `cancel_item` fires once the window has closed. `cancel` from `confirmed` emits
  `booking.cancelled_by_customer`; `cancel_by_business` emits only from `confirmed`; `complete` and
  `no_show` gain `issue_receipt:outcome`.
- **Order.** `accept` issues the new promise kind `accepted`. `cancel` splits: owners after `accept`
  emit `order.not_fulfilled`, customers `order.cancelled_by_customer`. New state `payment_failed`
  (from `awaiting_payment`; connector, owner, staff, system), left as `awaiting_payment` is; new
  terminal `charged_back` (from paid, fulfilling, fulfilled; connector, owner, staff). Two
  self-transitions, which bump `version` and write an event: `record_charge_back` on `completed`,
  and the system's `lapse` on `awaiting_payment` or `payment_failed` `orders.payDays` (14) after
  payment was requested. `fulfil` gains `issue_receipt:outcome`.
- **Time.** A `lifecycle_sweep` every 15 minutes (scheduled handler and Node loop), 50 items a run,
  re-enqueued when full: automatic completion, `lapse`, the one-line key email. A receipt's `iat` is
  its causing event's `created_at`. Quotes turned into bookings or orders copy the identity columns
  and `item_presentations`. Owner-, staff- or rule-created items issue no v2 receipts.
- **Promises made before the upgrade (R18).** The outcomes migration marks every booking and order
  already promised (`items.legacy_promise`: bookings `confirmed`, `completed`, `no_show`; orders
  from `accepted` to `completed`). The sweep never completes or lapses one, no outcome receipt is
  issued for one, and its one-time corrections are refused; its owner closes it by hand, as before.
- **Corrections.** A one-time correction (no-show ↔ completed, a charge-back on a completed order)
  is listed only while it can be made — not after its window, once made, or on a legacy promise —
  in the owner app, the owner MCP's `Next:` and a full webhook's `transitions`.

### 3.2 Receipt claims v2 and publishing

v1 claims (ADR-016) and the JOSE header are unchanged. v2 adds `ver: 2` (absent means v1); `knd`
`confirmed | paid | accepted | outcome`; `out`, the outcome code, exactly when `knd` is `outcome`;
`ref`, with `outcome`, the `nonce` of the item's **earliest** promise; `due` (unix seconds, on
promises and outcomes: a booking's start; an order's `payload.delivery.when`, else `iat` + 30 days;
outcomes copy it from their promise or, for a v1 promise, from the item); `end`, a booking's end;
`aut: 1` when the system fired it; and `per: [{"n": "<network host>", "p": "<presentation id>"}]`,
one per network holding a presentation for the item, at most 8, each network reading only its own.
An outcome job issues a missing promise first; a promise waits (≤ 15 minutes) while its item's
issuance or presentation is pending (§8.1), then issues without `per`.

**Publishing.** Each receipt gets a `network_publications` row per enabled network; each network's
hourly ping job enqueues up to 1000 queued rows, oldest first, in one statement, keyed
`network_receipt:<origin>:<receipt>:<stage>:<attempt>` (the counter raised in the same batch), so a
job dead after 8 tries never blocks the next; dead jobs are pruned after 30 days. This is also a new
network's backfill (late, §3.3, which the owner app says) and the catch-up after an outage. Retried:
`404`, `429`, `5xx`, `422` with `code` `unknown_key` or `unknown_ref`; other refusals are final. An
outcome posts its promise first. With `share.receipts` off, outcomes of published promises still go.

### 3.3 What the network checks (*defaults*)

- **Intake** takes receipts from any listed business (§6). `iat` over 300 s ahead: `422 not_yet`;
  no maximum age. Unknown `ref`: `422 unknown_ref`, retried; a v1 `ref` is fine. The daily cap
  (10,000 per business) counts promises only, keyed by business; an item takes at most 32
  outcomes, then `429 too_many_receipts`. **Arrival** is when the network
  first saw a receipt, even in an attempt it refused with `429`/`5xx`. A `per` entry that names no
  presentation to the same business made by `iat + 60` s is ignored: the receipt counts without a
  person. **Late:** a promise arriving over 24 h after its `iat`, or after `due`, makes its kept
  outcome presumed, so waiting to see how things go never pays.
- **Dating.** Evidence is dated by `iat`, the business's broken outcomes by max(`iat`, arrival −
  24 h). The date sets `t` (§5) and notice (a cancellation ≥ 24 h before `due`). A customer's late
  cancellation ≥ 48 h before `due` closes the promise with no row.
- **Which outcome stands.** Per item and side, the greatest `iat`, then nonce, never arrival order.
  A business's broken outcome is final (a later kept one is stored as `conflict`); only a report
  that stands turns kept into broken.
- **Unclosed (R30).** A v2 promise with no outcome of any kind 9 days after it was due (`end` if
  present, else `due`) gets `promise.unclosed` (`o` 1.0) on the business side, and it is final: an
  outcome first seen later is stored, never scored. It is not recorded while the business is not
  answering (§6: a business that signs its pings answers only by signed ones, so nobody else's
  pings can end this pause); the 9 days restart when it answers. Only an item's earliest promise,
  never v1.

### 3.4 Acknowledgements, reports and contests (R3, R6)

An **acknowledgement** is a token: the ADR-016 counter-signature JWS, whose payload carries the
receipt's `sha` and may add `pas` (a pass reference). It is verified when its key passes §4 (for an
SDK agent, the key it delegated; `signAck` makes the token), and counts from the next nightly run.
An agent that cannot make one may still send an `acknowledge_receipt {item_id, receipt_id}` request
signed under §2.4, which the inbox forwards as `agent_key` with `purpose: "ack"` and the receipt's
`sha` (§7.2): it is accepted and stored (R9) but verifies nothing, since the network never sees the
body behind a forwarded signature; the outcome stays the business's word (R18). A platform's key
signs only its agents' requests, so until a platform makes tokens, only SDK agents verify an
acknowledgement.

A **report** goes straight to the network, signed `sdi-agent/1` or Web Bot Auth (else `403
report_requires_signature`): `POST /v1/reports {receipt, out, why, pass_ref}`, `out`
`booking.no_show_business` or `order.not_received`, `why` `closed | no_one_there | not_delivered |
other`. Only by the item's own person, verified by §4 (`403 not_your_receipt`), between `due` + 1 h
and `due` + 90 days (`422 report_window`), once (`409 already_reported`), never after acknowledging
the kept outcome with a token (`409 you_acknowledged_it`; nothing a business holds can block a
report). The business sees it in its signed ping and may
dispute within 14 days; else it stands and replaces the kept row **at that row's weight**, as
verified evidence. A disputed report and its kept outcome each count `d` = 0.5; a report is disputed
automatically if the business recorded a customer outcome for the item; only documented fraud
removes one. A person may **contest** a broken outcome about them: it counts half until the
business withdraws it (which is how a mistaken no-show is undone).

**Never counts** (stored, R9): cancelling in time; declines, expiries, quotes, messages, refunds,
sandbox items; promise and v1 receipts; amounts; the business's own items or email domain.

## 4. Verified evidence (R3)

Only an acknowledgement **token** or a **signed** report can be verified (every business that served
a person holds their pass, and the network never sees the body behind a forwarded signature, §3.4):
when the item's person has a network-proven email and the key passes a route:

1. **Vouched.** The key is in the Web Bot Auth directory of a platform on `recognised_platforms`
   **and** made the item's own presentation (`per`); a platform key is shared by all its users, so
   without the item's person it verifies nothing. The list is **seeded at launch** with every
   platform that publishes a directory over https and names its operator; additions are changelog
   entries.
2. **Delegated.** The key is delegated, through the person's session (§7.2), to a pass of the item's
   person, who is **established**: `trusted` (§5.3) with kept outcomes at ≥ 3 mutually unrelated
   businesses, each `trusted` when it issued them, spanning ≥ 60 days.

**Related businesses** share a registrable domain (by an embedded, dated Public Suffix List; tenants
under a hosting suffix in `private_suffixes`, ours first, compare by owner account), a receipt `kid`
each of them signed with, an address from their signed pings in one IPv4 /24 or IPv6 /48 within 30
days (ignoring published serverless egress ranges), a hosted owner account, ≥ 50% customer overlap,
or an operator record with a reason; "mutually unrelated" means different **connected components**.
Each relation rests on proof; a profile's `contact_email` is whatever its manifest says, so it
relates nobody (§3.4's own-domain rule still reads its domain, which can only cost the business
itself), and the overlap groups a customer by customer key or company domain only once their email
is network-proven, and counts anyone else as their own person, since any business can register any
address for a customer (A1.4). Levels are fixed at intake and only lowered, by a logged operator
record of a relation or fraud, with the subjects rescored.

**Customers count by customer key**, wherever the rules count them: distinct customers (§5.3), `U`
(§5), the overlap relation (for network-proven customers, above), and the customer in `r`'s pair
for evidence about a business (R7). The key folds the normalised email (§2): it drops everything
from the first `+` to the `@`, and for `gmail.com` and `googlemail.com` it also drops the dots and
uses `gmail.com`, so `A.Silva+x@googlemail.com` and `asilva@gmail.com` are one customer. Customers
sharing a non-free-mail domain count as one. Identity keeps §2's exact address, so each address is still its
own person with its own key; a wrong fold can only count fewer customers, and never refuses a person
or touches their key.

**Effect.** Verified evidence about a business has `q` = 2.5 (*default*) and sits outside the word
cap. Evidence about a customer is never verified (the business is its only witness): it weighs by
the business's reputation, capped per business and open to contest. Little is verified at first
(`verified_share` shows it); meanwhile fresh perfect records of 50+ units tie at 0.9682.

## 5. The formula

Each piece of evidence weighs `x = o × t × q × r × d`:

| Factor | Definition (*defaults*) |
|---|---|
| `o` outcome | §3, halved when presumed. |
| `t` time (R14, R29) | Age at scoring time from the evidence date (§3.3): ≤ 30 days 1.0; ≤ 182 days 0.75; ≤ 365 days 0.5; older 0.25. Never 0 (R8). |
| `q` source (R3, R13) | 2.5 when verified; else `c = 1 + s × min(1, U/5)` (1.0–2.0): `s` the counterparty's score in the previous night's snapshot (0 without record or identity), `U` its unrelated businesses outside this business's component (a person) or its other distinct customers, by customer key (a business, §4). |
| `r` repeat (R7) | Per business–customer pair, side and ledger (kept apart from broken, so visits never dilute a broken one): `min(cap, 1 + 0.25·(m − 1)) / m` for `m` pieces; `cap` 3, or 1 for a customer's broken pieces from one business. The customer is the person's customer key (§4) for evidence about a business, the `pid` for evidence about a customer, else the receipt `sub`. |
| `d` dispute | 0.5 for a disputed report, the kept outcome it disputes, or a contested outcome. |

**Why `c = 1 + s`.** R13's proposed 0.5 + 0.5 × s has the same ratio; this scales it so a newcomer
weighs one. With 0.5 for a newcomer, 20/20 from new customers would score 0.8589, below a verified
900/1000 (0.8920), breaking R5. **Time moves both** the share and the confidence (R29): recent
evidence moves the share more, old evidence makes us less sure, so a quiet record slides slowly,
never to zero.

### 5.1 Confidence, score, and R5

```
K = Σx kept    B = Σx broken    p = K / (K + B)
n = f × Σx(word) + Σx(verified),  f = min(1, 50 / Σ(x/t)(word))          persons: n = K + B
score = 0 if n = 0,  else  (p + z²/(2n) − z·√(p(1−p)/n + z²/(4n²))) / (1 + z²/n)
```

- **Word cap.** The business's word counts as at most **50 fresh units** (*default*), each at its
  own age: the cap applies before time, so it ages too (fresh ≤ 0.9682; over a year old ≤ 0.8839).
- **Hold (R31).** While a business is under 30 days past verification on this network, none of its
  evidence is scored, for it or its customers. **Release:** its `n` is then at most 30 per full
  month since verification until day 90 (*default*). Evidence keeps its age; backdating lowers `t`.
- **Score.** `z = 1.2816` (*default*), `z² = 1.6425`; stored to 6 decimals, compared as `floor(score
  × 10⁴ + 0.5)`. A perfect record of `n` units scores `n / (n + 1.6425)`: 0.40 needs 1.10 units,
  0.75 needs 4.93. A business is **ranked** from 0.40 (`building`, R32); below, it shuffles with
  the businesses that have no record.

**R5, as it holds.** Fresh: 20 of 20 (0.9241) outranks 900 of 1000 on the word (0.8323) or all
verified (0.8920); 2 of 2 (0.5491, at most 0.7527) does not. In general, 20 of 20 kept within six
months outranks 900 of 1000 of any age and source; 2 of 2 never outranks 900 of 1000 of the same age
or fresher; on the word, 20 of 20 wins at every equal age. Older records slide, small ones faster
(R29): both over six months old, a verified 900/1000 (0.8886) passes 20/20 (0.8589). `scoring.json`
checks every `t` and `q` ∈ {1, 1.5, 2, verified}, chosen per record.

### 5.2 Worked examples

New counterparties, the business's word, distinct customers, past day 90, fresh (≤ 30 days) unless
stated. All follow from §5.1; these and more (presumed outcomes, reports) are in `scoring.json`.

| Case | `n` | `p` | Score | Shows |
|---|---|---|---|---|
| 20 kept of 20 | 20 | 1 | **0.9241** | R5 |
| 900 kept of 1000 | 50 (cap) | 0.9 | **0.8323** | below 20/20; all verified: 0.8920 |
| 2 kept of 2 | 2 | 1 | **0.5491** | below 900/1000; from customers at `c` 2: 0.7089; verified: 0.7527 |
| 20 of 20: 1–6 months / 6–12 months / 2 years old | 15 / 10 / 5 | 1 | 0.9013 / 0.8589 / **0.7527** | R29: slides, never below 0.7527; 900/1000 at 2 years: 0.7412 |
| 1000 of 1000: fresh / 2 years old | 50 / 12.5 | 1 | 0.9682 / 0.8839 | the word cap ages |
| 18 kept now, 2 broken over a year ago / the reverse | 18.5 / 6.5 | 0.9730 / 0.6923 | 0.8741 / 0.4426 | recent evidence dominates (R14, R29) |
| 10 kept from customers at `c` 1.8 / from new ones | 18 / 10 | 1 | 0.9164 / 0.8589 | R13 |
| One customer 12 times / 12 customers | 3 / 12 | 1 | 0.6462 / 0.8796 | R7 |
| 1 kept of 1; or 2 of 2 aged 6–12 months | 1 | 1 | 0.3784 | not ranked (R32) |
| **1 kept, 50 broken** | 50 (cap) | 0.0196 | **0.0058** | shuffled with the newcomers (R32) |
| **19 kept, 1 promise unclosed** | 20 | 0.95 | **0.8468** | R30: broken; a cancellation with notice instead: 0.8801 |
| 10 kept, 10 unclosed | 20 | 0.5 | 0.3623 | not ranked |
| **R31: 20 kept in the first week** | 0 / 20 / 15 | 1 | 0 to day 29; 0.9241 day 30; 0.9013 day 60 | held, then released |
| 5,000 invented on day 0 | 0 / 30 / 37.5 / 12.5 | 1 | 0; 0.9481 days 30–59; 0.9580 to day 182; 0.8839 after a year | honest 990/1000: 0.9508 |

### 5.3 Nightly computation, tiers and presentations

At 00:00 UTC one job computes relations and components, then every score from all evidence at
`scoring_time` = that midnight, each `c` from the **previous** night's snapshot (0 on the first
night), and switches snapshots in one transaction. Listings and presentations read the snapshot. The
result is a pure function of evidence, previous snapshot and `scoring_time`, reproducible (§7.4).

| Tier | Customer (person) | Business |
|---|---|---|
| `trusted` | ≥ 0.75, kept at ≥ 3 mutually unrelated businesses | ≥ 0.75, kept with ≥ 10 distinct customers |
| `building` | ≥ 0.40 | ≥ 0.40 (ranked, R32) |
| `new` | everything else, including no record | everything else, including no record |

A **distinct customer** is one customer key (§4), counted once a person under it has a network-proven
email or was presented at another, unrelated business: one mailbox is one customer, whatever `+` or
dots it adds. A customer's kept outcomes always count, and their broken ones only once their email
is proven (§3, A1.7).
Customers: 1 kept → 0.3784 `new`; 2 kept → 0.5491 `building`; 1 kept at a business at 0.80 (`c` 1.8)
→ 0.5229; 4 visits at each of 3 unrelated businesses → 0.7617 `trusted`, 0.7056 a month after the
last visit, 0.4442 after a year (R29). A trusted person with a proven email (3 kept at `c` 1.9,
0.7763) whom one business (`c` 2.0) records as 3 no-shows has one outcome's worth broken (`r` cap
1, so 2.0 at `c` 2.0) → 0.5094; contested, 0.6092; with the email unproven, the no-shows count
nothing (0.7763). A presentation gives `{tier, score, kept, broken, businesses, email_proven, since,
unusual_use, rules}`.

## 6. Ordering

**Listed** means `status IN ('verified','unreachable') AND verified_at IS NOT NULL` (R8, R12).
**Answering** means a ping that counts within 24 hours and no failed manifest sweep since. Anyone
may ping for any domain, so once a business has sent one signed ping, only its signed pings count.
For a business that has never signed, unsigned pings count too, so existing instances keep answering
(R18); one that goes back to an inbox that cannot sign shows as not answering until it signs again.
`not_answering_since` is the later of the last ping that counts and the last good manifest fetch.
Every hour at `:00` UTC the network freezes, per listed business, `rank_answering`, `rank_score_int`
(`floor(score × 10⁴ + 0.5)`), `rank_ranked` (`rank_score_int ≥ 4000`, R32), `rank_shuffle` and

```
rank_pos = ROW_NUMBER() OVER (ORDER BY rank_answering DESC, rank_ranked DESC,
             CASE WHEN rank_ranked THEN rank_score_int ELSE 0 END DESC, rank_shuffle ASC, id ASC)
```

The `CASE` keeps a business at 0.30 in the shuffle. `rank_shuffle` is the first 16 hex digits of
`SHA-256("<YYYY-MM-DD>:<business uuid, lowercase>")` for the snapshot's UTC date, sent as a
**string** (a JSON number loses precision above 2^53): businesses below 0.40, and ties, move once a
day in an order anyone can reproduce (R10, R32). A business verified after `:00` appears at the next
snapshot. **Near (R11):** `near=lat,lng`, `radius_km` (10, Tiago's; max 1000) filters; inside it the
order is `rank_pos`, with `distance_km`. **Cursor:** base64url JSON `{m, p}` (mode, last
`rank_pos`), continued in the current snapshot, so across `:00` an entry may repeat or be skipped;
other cursors, including earlier formats: `410 cursor_expired`.

## 7. The network protocol (R24)

With §2–§6 this is the whole protocol; nothing in it refers to a private implementation.
`docs/protocol/network.md` restates it (the vectors decide any difference). A network may choose
its own numbers (§14) and publishes them at `/v1/ranking`.

### 7.1 Endpoints

| Call | Auth | Body → answer |
|---|---|---|
| `POST /v1/instances` | none | `{domain}` → `202`; fetches `https://<domain>/.well-known/agent-inbox.json`, requires `spec` starting `surfingdog-inbox/` and `instance` = `https://<domain>` (port 443, no path), keeps `profile`, `item_types`, `protocols`, `receipt_keys` |
| `POST /v1/instances/{domain}/ping` | optional `sdi-instance/1` | §7.3 |
| `POST /v1/receipts` | the JWS | `{receipt, ack?}` → `{ok, state: "issued"\|"acknowledged", duplicate}`, v1 and v2 |
| `GET /v1/businesses` | none | `near?, radius_km?, category?, item_type?, q?, limit ≤ 100, cursor?` → `{businesses: [listing], next_cursor}` |
| `GET /v1/businesses/{domain}` | none | listing + `outcomes: {"<code>": <count>}` for every §3 code |
| `GET /v1/ranking` | none | `version?` → §7.3 |
| `POST /v1/persons` | `sdi-instance/1` | `{request_id, email, agent: {label?, jkt?, directory?}, email_proof?}` → `201 {key, pass, presentation, ppid, person}` · `409 person_exists` · `429 rate_limited` |
| `POST /v1/presentations` | `sdi-instance/1` | §7.2 → `{presentation, ppid, person, pass?, email_match?}` · `404 unknown_pass` · `410 revoked` · `403 pass_requires_signature` |
| `POST /v1/passes`, `/v1/passes/revoke` | the key; the pass or a session | `{key, label}` → `{pass}` (≤ 10 a day per key); `{pass}` or `{pass_id}` → `{revoked: true}` |
| `POST /v1/delegations` | session **and** `sdi-agent/1` by the key delegated | `{pass}` → `{pass_ref, jkt, bound: true}` |
| `GET /v1/person`, `POST /v1/person/contests` | session | standing, evidence, passes, delegations, presentations; `{evidence}` → `{id}` |
| `POST /v1/recovery/start`, `/finish` | none | §2.3 |
| `POST /v1/reports` | signed (§3.4) | → `202 {id, status: "open"\|"disputed", respond_by}`; `disputed` when the business already recorded a customer outcome for the item (§3.4) |
| `POST /v1/reports/{id}/response`, `/v1/contests/{id}/response` | `sdi-instance/1` | `{answer: "dispute"}`, `{answer: "withdraw"}` → `{id, status, answer}` |

### 7.2 Listings, presentations and forwarded signatures

A **listing** has `domain`, `name`, `description?`, `city?`, `country?` (ISO 3166 alpha-2),
`categories`, `languages`, `item_types` (string arrays), `protocols` (name → URL), `geo? {lat,
lng}`, `distance_km?` (near only), `url?`, `manifest_url`, `verified_at`, `last_ping_at?` (the last
ping that counts, §6), `software? {version, runtime}`, `receipts {issued, acknowledged, last_at?}`
(promises only), `answering`, `online` (its alias), `not_answering_since`, `rank_pos` and
`reputation {ranked, score, tier, kept, broken, customers, verified_share, rules}` (times ISO 8601;
`verified_share` is the share of weight from verified evidence). Nothing about any customer is ever
returned.

`POST /v1/presentations` takes one of `pass`, `key` or `agent_key`, `purpose: "request"|"ack"`,
`sha?`, `email?` and `email_proof?`; `person` is §5.3's object. A key is exchanged for a pass,
reusing one minted for the same key and agent within 24 h. `email_match: "proven"|"unproven"|"no"`
lets an inbox recognise a known customer without a code (§8.2). `email_proof` (`"otp"`: a code the
inbox emailed to the address was entered; `"dkim"`: DKIM-authenticated mail from it; anything else
`400`) says how the inbox proved `email`, which it needs; on `POST /v1/persons` it is recorded for
the person a `201` creates, never on a `409`, and here only when `email_match` is not `"no"`
(A1.7). Limits (*default*): 600 calls a minute per instance; 20 per person per business per day,
then the last result is returned.

`agent_key = {jkt, pass_ref, label, signature_input, signature, signature_base}`: the label's inner
list with parameters exactly as received, the raw base64 between the colons, and the UTF-8 signature
base the inbox verified (RFC 9421 §2.5, ending with the `"@signature-params"` line). The network
reads signature fields up to 8 KB, checks that line equals `"@signature-params": ` +
`signature_input`, verifies with the delegated or directory key, requires `@authority` to be the
presenting instance, `created` within 300 s and `expires` at most 60 s past, as the inbox does
(§2.4), and stores SHA-256 of `signature` so each is used once. With `purpose: "ack"` it is stored
and verifies nothing (§3.4). Delegation needs a session because businesses hold passes and keys too,
and could otherwise delegate their own key to a customer's pass and sign "verified"
acknowledgements; for an SDK agent it is one emailed code at setup.

### 7.3 The ping and the published rules

Ping body `{version, runtime, counts: {bookings, orders, quotes, messages}}` (last 24 h; `counts`
optional), as today. **Unsigned:** `204`, no body, as today; it counts as answering only for a
business that has never sent a signed ping (§6), and is kept as telemetry (§9). **Signed:**
`200 {ok, rules: {version, effective_at}, next_rules: {version, effective_at, url} | null, reports:
[{id, receipt_sha, out, why, created_at, respond_by}], contests: [{id, evidence_id, out,
created_at}], standing: {score, tier, ranked}}`; anyone can ping for any domain, so only a signed
ping sees these. The new inbox treats `200` and `204` as success.

`GET /v1/ranking` (version 4; `?version=N` for any past one, forever) returns `{version, rules:
"0.1.1", status, effective_at, summary, order, score, weights, timing, verified, tiers, never_used,
changelog, next}` (version 3's `rules` is `"0.1"`; 0.1.1 is 0.1 with Amendment 1): §6's order and
every §14 value (with `recognised_platforms` and the PSL snapshot date) under the `packages/spec`
schema's names; `never_used` lists advertising, payment, amounts, anything a business's profile
says about it except its location, and who is searching. The changelog starts at version 2
(2026-09-22, the neutral order during the redesign).

### 7.4 Errors, schemas and vectors

RFC 9457 problems with a `code` (a `400` may have none); a failed acknowledgement prefixes `ack_`.
**400** `malformed`, `bad_payload`. **401** `unknown_instance`, `bad_signature`, `expired`,
`not_signed_in`, `replayed_signature` (inbox). **403** `pass_requires_signature`, `not_your_receipt`,
`report_requires_signature`. **404** `unknown_pass`, `unknown_issuer`, `not_found`. **409**
`person_exists`, `nonce_reused`, `already_reported`, `you_acknowledged_it`, `nothing_to_verify`
(inbox), `already_verified` (inbox). **410** `revoked`, `cursor_expired`. **422** `unknown_key`,
`unknown_ref`, `bad_alg`, `bad_typ`, `not_yet`, `report_window`, `bad_code`, `code_expired`,
`positive_only` (inbox, saving a rule, §8.3). **429**
`too_many_receipts`, `rate_limited`, `too_many_attempts`.

Schemas are zod in `packages/spec` (MIT), JSON Schema generated by `z.toJSONSchema` into
`packages/spec/schemas/`. Vectors in `packages/spec/vectors/`: `receipts-v2.json` (every claim and
every transition path's outcome); `passes.json` (formats, `ppid`, 12+ email cases: IDN, `ß`,
full-width, trailing dot, plus-address, refused quoted local part, the refused characters and
domain labels of §2); `signatures.json` (both
profiles, both tags, `agent_key`); `scoring.json` (every §5.2 row with its `scoring_time`, the R5
grid, the ageing cap, hold and release, R32); `ordering.json` (shuffles above 2^53, cursors).

## 8. Inbox changes

**Storage** (idempotent single-batch migrations). `items` gains `agent_thumbprint`, `agent_level`,
`agent_directory`, `customer_match`, `possible_party_id` and `end_at INTEGER GENERATED ALWAYS AS
(unixepoch(json_extract(payload, '$.endTime'))) VIRTUAL`, indexed `(type, state, end_at)`; `parties`
gains `merged_into`; `receipts` gains `outcome TEXT NOT NULL DEFAULT ''` and an indexed, backfilled
`sha`, unique on `(item_id, kind, outcome)` (`EffectId`, `receiptKindSchema` gain `accepted`,
`outcome`). New tables: `person_links` (`PK(party_id, network)`, `UNIQUE(network, ppid)`, indexed
`pass_hash`), `item_presentations` (`PK(item_id, network)`), `network_cache`,
`network_publications` (`PK(receipt_id, network, stage)`, with `attempts`), `network_cases`
(reports and contests from signed pings), `party_contacts` (replacing `party_identities`, which is
unique per value, also for the "verified" badge; filled from `parties.contact` by a resumable
backfill job, phones as ≥ 6 digits), `pending_identity`, `customer_codes` (by destination hash) and
`carrying_agents`. `sig_nonces` holds replays (`nonce` = `sig:` + SHA-256 of `Signature`) and
`key_directories` the directory cache; the hourly tick deletes expired rows. No pass or key secret
is stored in clear, except sealed in `pending_identity` until delivered. Owners are emailed a new
report or contest and answer with `answer_network_case {network, id, answer}` (REST, owner MCP).

### 8.1 Resolving identity, and settings

An `IdentityResolver` in `packages/adapters` runs: bearer; per-IP tokens; signature (§2.4, split
out of `callerFromRequest`); passes and keys; `createItem` with an `identity` input, so party join,
identity columns, presentations and links are **in the create batch**; issuance (§2.1) in a second
batch, the `rules` job then scheduled 4 s ahead. Tiers: `reputed_principal` (vouched agent, trusted
person) > `verified_principal` > `signed_agent` > `anonymous`. Passes are checked in `network_cache`
(TTL 3600 s or a lower `max-age`; `revoked` cached; `ack` never), then at the network (≤ 3 s, in
parallel, fail-open; after 3 straight failures skipped for 60 s). Only while a network is
unreachable does a `pass_hash` match stand in, with the last stored standing. Rules do no network
I/O: `buildRuleContext` and `test_rule` read local rows.

```
networks: { "https://network.surfingdog.ai": { enabled: true, issue: true,
              share: { listing: true, counts: true, receipts: true, reviews: false } } }
booking:  { …existing, lateCancellation: "record", autoCompleteHours: 48 }
orders:   { …existing, payDays: 14, dueDays: 30 }
identity: { extraAuthorities: [] }
customers: { otp: { ttlMinutes: 10, attempts: 5, sendsPerHour: 3, sendsPerDay: 5, guessesPerDay: 10 },
             emailKey: true }
```

Networks are a map keyed by https origin (port 443, no path), since the merge replaces arrays whole;
removing one is `enabled: false`; up to 8 networks in 0.1, a default that can be raised (R23). `share.reviews` (ADR-013) stays, unused until
reviews ship. `updateSettings` merges the patch into the **stored raw** document, validates it
**strictly** (`422` with paths) and stores it raw; `readSettings` is **lenient**, skipping a bad
network entry; a `z.preprocess` in both derives `networks` from a legacy `network` (`enabled:
network.join === true`). The shipping migration sets `booking.lateCancellation` to `"refuse"` where
absent (`json_set` over `json_patch`), so no existing instance changes policy silently. Ping,
registration and publishing are one job per enabled network.

### 8.2 Customers the business already knows (R27)

Every create writes the normalised email and phone to `party_contacts` in its batch; authenticated
email sets `verified_at`. For a value, the **known party** is the oldest party with a link or
`verified_at` for it, else the oldest party with that value.

| Match | Condition | Confidence | Then |
|---|---|---|---|
| Linked key, API key, authenticated email | a pass, key or delegated signature resolves to a linked `ppid`; or today's `verified_principal` paths | strong | joins that party |
| Network email proof | a presented, unlinked person with `email_match: "proven"` for the known email | strong | link, join |
| One-time code | the code sent to the known party's email was entered | strong | merge, link |
| Email or phone only | equals a known party's contact | **weak** | provisional party, `possible_party_id`; the owner sees "may be Ana Silva, unconfirmed"; with no match at all, a new party |

A weak match never sees the known party's items: impersonation is refused without refusing the
person. **A merge** is one batch (items, thread entries, links, `merged_into`); a code verifies every
contact row with that value and merges every party holding it, perhaps pulling in items someone else
made with that address (R27's accepted cost). **Linking:** a known customer's first pass attaches
its `ppid` on a strong match; a weak one waits for a code or `email_match: "proven"`. When a
one-time code or authenticated email proved the address, the issuance or presentation that links
it carries `email_proof` (§7.2), so the customer's broken outcomes here can count (A1.7).

**One-time code:** REST `POST /v1/customers/verify`, MCP `verify_customer`, limiter class `verify`
(30 per IP an hour). `{item_id, access_token}` emails 6 digits to the known party → `202 {sent_to:
"a•••@e•••.pt"}` (`409 nothing_to_verify`, `409 already_verified`); adding `code` → `200
{recognised: "strong"}`, `422 bad_code`, `422 code_expired`, `429 too_many_attempts`. Hashed, 10
minutes, 5 attempts, 3 sends an hour and 5 a day per destination address, and 10 tries a day at its
codes (right or wrong), each limit counted in the statement that spends it; email only in 0.1. The
email is the business's: *"Your code for <business>"*, *"Your code for <business> is 482913. It works
for 10 minutes."* **The business's
own history** is a first-class signal beside network reputation ("a customer you know"), over every
party linked to the same `ppid` or verified contact: completed, no-shows, late cancellations,
failed payments, charge-backs, largest paid, first and last seen.

### 8.3 Rules: conditions and presets

The context gains `person {present, tier, score, networks: [{network, tier, score, kept, broken}],
limit_minor}`, `customer {match, known, completed, paid, no_shows, late_cancellations,
payment_failed, charged_back, largest_paid, limit_minor, first_seen (unix ms), open_bookings}` and
`agent {level, platform}`. `person.tier` is the best across enabled networks; `person.limit_minor`
is 40000 when trusted, else 0; `customer.limit_minor` is 2 × `largest_paid`. New fns (schema,
`describe`, `test_rule`): `person_trusted`, `person_tier_on {network, min}`, `customer_known`
(strong, ≥ 1 completed), `within_customer_limit`; `party_verified` also accepts a vouched
`signed_agent`. **Positive only, enforced:** a rule reading any of these cannot fire `decline`,
`cancel`, `cancel_by_business`, `expire` or `enqueue`; it is refused (`positive_only`) when saved,
and an older rule's action is skipped and logged (flag chains best-effort): in the rule's run, in
the item's history as a `rule_skipped` event the owner app's timeline shows (left out of the
developer stream), and in `test_rule`'s `skipped`, in plain words: *"Rule '<name>' wanted to decline
this, but rules that read a customer's record can only help them"*. A record speeds things up or
asks a human (R25).

**Presets** (*defaults*); a tier speeds acceptance and can waive a booking deposit (R15), never
order payment. **Appointments:** confirm at once, when the slot is free and in hours, a
`customer_known` with ≥ 2 completed and no no-shows, or a `person_trusted` with ≤ 2 open bookings
here and a value up to 20000 minor units; otherwise today's rule (under 5000); the rest goes to a
person. **Shop:** everyone pays as the shop's flow says; `within_customer_limit` orders are accepted
at once, new customers with `request_payment`; large orders are flagged. **Trades:** trusted
customers raise priority. **All:** a weak match asking to cancel, change or see past orders is
offered a code first. Until a payment connector brings deposits, a new customer's booking gets a
person's confirmation, never a refusal. **Implementation tasks:** that connector; SMS codes.

### 8.4 Doors, responses, manifest, SDK and the agent guide

Public create, status, cancel and acknowledge doors accept `pass` and `key` (exchanged, never
stored); create and status answers add `identity: {recognised: "strong"|"weak"|"none", passes:
[{network, pass}], verify: {available, sent_to}, guide}` (`available`: a weak match with a
deliverable email; `sent_to`: the masked address once sent). Many assistants read only an MCP result's
text, so it ends with `Keep this pass for <name>: sdpass1_… (network <host>)` and, when weak, `Ask
the person for the emailed code and call verify_customer.` The manifest's `agent_policy` gains
`signatures: ["sdi-agent/1"]`, `passes`, `networks` and `guide`. The **SDK** (`packages/sdk`, MIT,
WebCrypto) adds `generateAgentKey`, `thumbprint`, `signRequest`, `signAck` and `delegate`.

**Agent guide (R26)** at `https://surfingdog.ai/for-agents.md`, a stable URL like `/install.md`,
linked from every manifest; in plain steps, for any customer's agent:

1. **Say who you carry:** present the person's pass in `pass` or `Sdi-Pass`, never in a URL. Given a
   key, exchange it once for a pass (at the network or in the `key` field) and keep the pass.
2. **First booking:** keep the pass from `identity.passes`; tell the person their key comes by email.
3. **Identify the human, not yourself:** `contact.name`, `email`, `phone`, `locale` are the person's.
4. **Same customer next time:** present the pass; if the answer is `weak`, ask for the emailed code
   and call `verify_customer`.
5. **Acknowledge receipts** with a token (the SDK's `signAck`), and report a broken promise, signed,
   only when it happened; an acknowledgement without a token is kept but verifies nothing.
6. **Never put a key in message text.**
7. **If you can sign,** use the SDK: one emailed code delegates your key; nothing copyable travels.

## 9. What a network stores

Every receipt, acknowledgement, report, contest, presentation and piece of evidence, forever (R9),
even when a business is deleted; business snapshots too. Secrets only as SHA-256, except an issuance
answer, sealed for its 7-day replay, and a pass minted by exchanging a key, sealed 24 h so the same
key and agent get it back (§7.2). Emails only as keyed hashes: `email_mac`; the email's registrable
domain (none for free mail), for §3.4's own-domain rule and §4's one-domain-one-customer rule; and
the customer key (§4). Pings, with their address, are telemetry kept 90 days. Listings and
presentations are served from the snapshot.

## 10. Anti-gaming

| Attack | Defence in 0.1 | Still open |
|---|---|---|
| **Invented customers** | Word ≤ 50 fresh units (0.9682), ageing; 30-day hold, ≤ 30 units a month to day 90; distinct customers need a proven email or a presentation elsewhere, and one mailbox is one customer (`+` and Gmail dots folded); issuance ≤ 50 a day; outcomes need a held promise; `verified_share` public. | A fabricated word record reaches an honest 50/50's ceiling, above an honest 990/1000 (0.9508). Alias services such as Apple's Hide My Email give one person many addresses no fold can join; counting each such domain as one customer is Tiago's call. |
| **Self-acknowledgement, shared platform keys** | A pass never verifies, nor a forwarded signature, whose body the network never sees; only an acknowledgement token of that receipt, by a key vouched and making the item's own presentation, or delegated to an established person. Nothing a business holds can block a report. | Paying real orders at honest shops. |
| **Borrowed passes and keys** | Only standing is borrowed (R20); acting as the person needs an emailed session; `unusual_use`; presentations listed; recovery rotates all. | Accepted (R20). |
| **Collusion rings** | Relations as components, each resting on proof (a copied contact email joins nobody, and the overlap groups by mailbox or company domain only customers with a network-proven email); `c` scaled by `min(1, U/5)`; the word cap. | Genuinely distinct businesses and customers. |
| **Hiding broken promises** | `due`; late promises make kept outcomes presumed; `promise.unclosed`, final; broken outcomes dated by arrival; notice decided by the network. | — |
| **Rivals' false reports** | Signed, verified, the item's own person, once; never above the kept row; 0.5 against 0.5 when disputed; automatic dispute. | A per-business cap (§13). |
| **A hostile business; tier as credit** | A customer's broken outcomes from one business ≤ one outcome's worth, halved by a contest; order payment never waived; instant bookings ≤ 2 open, ≤ 20000; shop ≤ 2× paid. | — |
| **Floods, clocks, probing, impersonation** | Tokens before signatures; per-platform, per-instance, issuance and per-address limits; future `iat` refused, backdating lowers `t`; `201` against `409` counted and audited; a weak match gets a provisional party and codes go to the known address; a customer's broken outcomes count only once their email is proven; a business that signs its pings answers only by signed ones. | Knowing whether an email is known (accepted); phone-only customers until SMS. |

## 11. Publication and change (R17)

Human rules on `/network`, short and plain; machine rules at `/v1/ranking`; a Ranking section in the
Terms (main parameters, their weight, "nothing about the order can be bought"); every listing links
the rules version that ordered it. A change to a §14 number or a rule is announced **15 days**
(*default*) ahead: in `next` at `/v1/ranking`, in `next_rules` on signed pings (shown in the owner
app), on `/network`, and by email to each listed business's profile contact, which reaches instances
that have not upgraded (R18); they are told plainly they stay listed with the newcomers until they
send v2 receipts.

## 12. Compliance tasks

Tasks, not blockers (R16): legitimate-interest assessment and DPIA; the Art. 14 notice, linked
from the key email and `/v1/person`; joint-controller terms; the P2B ranking description and notice;
DSA contact points and statements of reasons; a processor agreement for the network's email; erasure
against R9 (unlink the `pid`, keep pseudonymous evidence); a records-of-processing entry.

## 13. Not in 0.1

Each would come as a rules version with 15 days' notice: the approved-networks list (§2.2) and other
networks' keys or identity sources; acknowledgement by pass; pay-later orders; a cap on disputed
reports; leaving a subject's own group out of `c`; sharded or on-intake scoring; a pass scoped to one
business; cursors that survive the hourly reorder; SMS codes, booking deposits, browser agents.

## 14. Defaults Tiago may change

| Number | Value | Source | Does |
|---|---|---|---|
| Ranked | score ≥ 0.40 (`building`) | Tiago (R32) | Sorts before the newcomers' shuffle |
| Unclosed promise | broken, `o` 1.0, 9 days after due | Tiago (R30) | Silence never beats an honest outcome |
| Hold; release | 30 days; then ≤ 30 units a month to day 90 | Tiago (R31); release default | New businesses |
| Repeat | cap 3; +0.25 a return; a customer's broken pieces per business ≤ 1 | Tiago (R7) cap; rest default | Returning customers |
| `radius_km` | 10; max 1000 | Tiago (R11); max default | Near mode |
| Keys | one per network | Tiago (R28) | Identity |
| Networks per inbox | up to 8 | Tiago (R23) "multiple"; limit default | Bounds background work per inbox; raise when needed |
| Time | 1.0 ≤ 30 d; 0.75 ≤ 182 d; 0.5 ≤ 365 d; 0.25 older; weight and confidence | Tiago (R14, R29); values default | Quiet records slide, never to zero |
| Outcomes | kept 1; business cancel 0.5 with ≥ 24 h notice, else 1; no-show 1; late customer cancel 0.5; payment failed 0.5; charge-back 1; presumed kept × 0.5 | default | Share moved by each outcome |
| A customer's broken outcomes | count only when their email was proven by the outcome's date: network-proven, for every business; or at the business that recorded them (`email_proof`, or their key presented there), for its own; kept ones always count | Tiago (A1.7) | Someone using your email can't hurt you |
| Word cap; verified; disputed | 50 fresh units, ageing (0.9682); 2.5; × 0.5 | default | The word alone; R3; both sides stand |
| Counterparty; `z` | 1 + score × min(1, unrelated / 5); 1.2816 | R13's proposed ratio, scaled; default | The other side's record; caution |
| Established; platforms | trusted, 3 unrelated trusted businesses, 60 days, proven email; seeded at launch (https directory, named operator) | default | When a key verifies |
| Related | same /24 or /48 within 30 d, from signed pings; overlap ≥ 50%, grouping by mailbox or domain only customers with a network-proven email; no contact-email relation; one non-free-mail domain = one customer; one mailbox = one customer (`+` and Gmail dots folded) | Tiago (A1.3, A1.4) contact email, mailbox; rest default | "Unrelated"; distinct customers |
| Tiers | trusted ≥ 0.75 (+ 3 businesses or 10 customers); building ≥ 0.40; `person.tier` best across networks | default; building R32 | Rules and presets |
| Order; timing | answering 24 h; hourly snapshot; daily shuffle; notice 24 h; late customer 48 h; late promise 24 h; auto-complete 48 h after the end; rules change notice 15 d | default | R10, R12, R17, §3 |
| Orders; reports | lapse 14 d after a payment request; due 30 d; reports `due` + 1 h to + 90 d, disputed within 14 d | default | §3 |
| Presets | known: ≥ 2 completed, no no-shows; trusted ≤ 2 open, ≤ 20000; shop ≤ 2× paid; `person.limit_minor` 40000 when trusted | default | Rewards, never credit |
| Calls and codes | signatures ≤ 300 s, 60 s skew; network 3 s, cache 3600 s, breaker 3 → 60 s, `409` cached 24 h; codes 6 digits, 10 min, 5 tries, 3/h per address; session 24 h | default | Never block a booking; recovery |
| Limits | issuance 50/day/business; passes 10/day/key; 600 calls/min/instance; 20 presentations/person/business/day; ≤ 8 pass strings (≤ 200 chars) and `per` entries; 32 outcomes per item; signature fields ≤ 8 KB; networks unlimited (R23); unusual use > 10 businesses in 24 h or two signing keys | default | Floods, misuse signs (R20) |

## 15. Changes

- **First revision:** word cap; verification bound to the item's person; delegation needs a session.
- **R28–R32:** one weight per piece, time lowering confidence (R29; "a perfect record never fades"
  is gone; the word cap ages); ranked from 0.40 (R32); unclosed promises final, with neutral closing
  outcomes (R30); hold and release by business age (R31); approval body (R28); platforms seeded;
  pass acks, scoped passes, pay-later and the report cap to §13; exact email normalisation,
  forwarded signature base, durable publication, identity in the create batch, strict settings,
  customer backfill, email notice; the network's private schema replaced by what it must store.
- **In force, 23 Sep 2026:** version 3 took effect the day it was published, at Tiago's decision. No
  other business was listed, so nobody was owed the notice §11 describes. Later changes keep it once
  another business is listed.
- **Version 4, 23 Sep 2026 (Amendment 1):** only an acknowledgement token verifies, and only it
  stops a report (A1.1); a business that signs its pings answers only by signed ones (A1.2); a
  profile's contact email no longer relates businesses (A1.3); one mailbox is one customer, `+` and
  Gmail dots folded (A1.4), and the overlap relation groups by mailbox or company domain only
  persons with a network-proven email; a customer's broken outcomes count only once their email is
  proven (A1.7); the network's records of A1.5 written into the body. Its rules are named 0.1.1.
  It took effect the day it was published, at Tiago's decision: ours was still the only listed
  business, so, as for version 3, nobody was owed §11's notice.

## Amendment 1 (23 Sep 2026)

**Status: accepted (Tiago, 23 Sep 2026)** for A1.1–A1.4 and A1.7, in force as rules version 4 the
day it was published (ours was the only listed business, so no notice was owed); A1.6 stays
proposed. Tiago approved the first four items in these words, and A1.7 quotes the choice he made:

> Only a real counter-signature verifies a promise.
> Once an inbox signs its pings, only signed pings count.
> Stop linking businesses by contact email.
> One mailbox is one customer (ana+1@gmail.com counts as ana@gmail.com).

A security review of the network found the gaps below. The body of this ADR now states the accepted
rules, and this section records why. A1.5, and the lines in A1.1 and A1.3 that say "already", record
what the network already does, so the text matches it. Each item says how Tiago's decisions stay
whole.

### A1.1 Only a signed token verifies an acknowledgement

**Risk.** The network never sees the body behind a forwarded signature (`agent_key`, §7.2), so a
business can pass off any signed request from an established customer's agent, even the booking
request itself, as a verified acknowledgement of its own kept outcome.

**Rule.** Only an acknowledgement token can make evidence verified: the ADR-016 counter-signature
JWS, whose payload carries the receipt's `sha`, signed by a key that passes §4. For an SDK agent
that is the key it delegated, and `signAck` makes the token. A forwarded `acknowledge_receipt`
(`agent_key` with `purpose: "ack"`) is still accepted and stored (R9), and verifies nothing. The
same token is already the only acknowledgement that stops a report with `409 you_acknowledged_it`
(§3.4), so a business cannot block a report with anything it holds. Forwarding the signed body, so
the network could check its digest, would also close the gap; the token is simpler and already in
the SDK.

**Tiago's decisions.** R3 holds exactly: weight still comes only from a verified agent, now one that
signed this very receipt. R6 gets stronger, since a business cannot silence a customer's report.
R18: an agent that cannot make a token keeps working; its acknowledgement is stored, and the outcome
stays the business's word. The cost: a platform's key signs only its agents' requests, so until a
platform makes tokens, only SDK agents verify an acknowledgement.

**Text changed:** the rules in one screen (3), §1 (R3), §3.4, §4 (first sentence), §7.2
(`purpose: "ack"`), §8.4 (guide step 5), §10 (self-acknowledgement).

### A1.2 A business that signs is answering only by signed pings

**Risk.** Anyone may send an unsigned ping for any domain (§7.3), so a rival can keep a business
whose inbox is down "answering", and R30 then records its promises as unclosed during the outage
its pause was meant to cover.

**Rule.** Once a business has sent one signed ping, only its signed pings make it answering, for §6
(the order and `not_answering_since`) and for R30's pause. Unsigned pings for it still get `204` and
are kept as telemetry (§9). A business that has never signed keeps version 3's rule. R30 cannot
hurt it: only new inboxes send v2 promises, and they sign their ping with the key that signs their
receipts. A rival can still make it look answering, which only flatters it. One case changes: a
business that goes back to an inbox that cannot sign shows as not answering until it signs again.

**Tiago's decisions.** R30 holds as written, and its pause now protects the business it was meant
for. R12's "not answering since …" can no longer be faked for a business that signs. R18: instances
that have never signed are unchanged, and unsigned pings still get `204`.

**Text changed:** the rules in one screen (5), §1 (R10–R12), §2.5, §3.3 (unclosed), §6 (answering),
§7.2 (`last_ping_at`), §7.3 (unsigned ping), §10 (floods).

### A1.3 Contact email no longer relates businesses

**Risk.** A profile's `contact_email` is whatever its manifest says, so one person with many
subdomains of one domain can copy a different victim's contact email into each and pull all the
victims into one component with them (§4).

**Rule.** Drop the `contact_email` relation. Under version 3 a joined business lost weight it
earned: evidence from its customers weighed less (their `U` fell, so `c` fell, §5), and visits to
joined businesses counted as one toward a customer's `trusted` (§5.3). The relation adds little,
since the network proves no business's email and a ring can simply use different ones. It may return in a
later rules version for an email each business has proved it controls. The other relations stay,
each resting on what a business proved, as the network already applies them: a receipt key counts
only when each business signed with it, and an IP address only from its signed pings. An operator
can still record a relation with a reason (§4).

**Tiago's decisions.** R13 is protected: nobody can lower the weight of another business's customers
by declaring a link. "Mutually unrelated" (§4) keeps its meaning through the relations that rest on
proof.

**Text changed:** §1 (R13), §4 (related businesses), §10 (collusion rings), §14 (related).

### A1.4 Plus-addresses count as one customer

**Risk.** `a+1@gmail.com`, `a+2@gmail.com` and so on reach one mailbox, so one person can prove any
number of addresses, and a business can make them its 10 distinct customers for `trusted` or spread
one customer's visits past R7's cap.

**Rule.** To count customers, the network folds each address into a **customer key**: it drops
everything from the first `+` to the `@`, and for `gmail.com` and `googlemail.com` it also drops the
dots and uses `gmail.com`. So `A.Silva+x@googlemail.com` and `asilva@gmail.com` are one customer.
The key is used wherever the rules count customers: distinct customers (§5.3), `U` (§5), the overlap
relation (§4) and the customer in `r`'s pair for evidence about a business (R7). Identity keeps §2's
exact address: issuance, `email_mac`, recovery and codes are unchanged, so each address is still its
own person with its own key. A custom domain needs no folding, since customers sharing a
non-free-mail domain already count as one (§4). A wrong fold can only make the network count fewer
customers; it never refuses a person or touches their key.

**Still open.** Alias services such as Apple's Hide My Email or DuckDuckGo's addresses give one
person many addresses that no fold can join. Counting each such domain as one customer, like a
company domain, would close this, and would also count all their honest users as one. That is
Tiago's call.

**Tiago's decisions.** R7 holds again for the free way to multiply addresses: one mailbox counts as
one customer, whatever `+` or dots it adds. R16 and R19 are untouched: one key per person, issued by
email at a first booking. §2's "no dot or plus folding" stays true for identity.

**Text changed:** the rules in one screen (3), §1 (R7), §2 (last sentence), §4 (grouping), §5
(`r`, `U`), §5.3 (distinct customer), §9, §10 (invented customers), §14 (related).

**Note: the overlap groups only proven customers.** The overlap relation (§4) groups a person by
customer key, or by company domain, only once their email is network-proven; anyone else counts
there as their own person, as under version 3, so businesses sharing invented customers still
relate. The fold still applies wherever customers are counted, as approved. Registering an address
needs no proof, so otherwise a business could register `ana+x@gmail.com` for a rival's customer
`ana@gmail.com`, or any address at a customer's company domain, and, grouped with that customer,
relate itself to the rival. **Text changed:** §4 (related businesses), §10 (collusion rings), §14
(related), §15.

### A1.5 Records

- **Stored (§9).** Beside the issuance answer, a pass minted by exchanging a key is sealed for 24 h,
  so the same key and agent get it back (§7.2). Beside `email_mac`, the network keeps a keyed hash
  of the email's registrable domain (none for free mail), for §3.4's own-domain rule and §4's
  one-domain-one-customer rule. With A1.4 it also keeps a keyed hash of the customer key.
- **Reports (§7.1).** `POST /v1/reports` answers `202 {id, status, respond_by}`, where `status` is
  `"open"`, or `"disputed"` when the business already recorded a customer outcome for the item
  (§3.4's automatic dispute). The spec schema allows both.
- **Email addresses (§2).** The network also refuses a local part holding a space or any of
  `( ) < > [ ] \ , ; : @ "`, and a domain label that is not `[a-z0-9-]{1,63}` after punycode.
  Otherwise `me@evil.example,x@gmail.com` could pass as a gmail.com customer while a recovery code
  also went to `me@evil.example`. The inbox must refuse the same, and `passes.json` must carry these
  cases.
- **Limits (§7.2, §14).** At most 32 outcomes per item, then `429 too_many_receipts`. Signature
  fields are read up to 8 KB. A forwarded signature more than 60 s past its own `expires` is
  refused, as the inbox refuses it (§2.4).

None of these moves a decision of Tiago's. The email rule refuses only malformed addresses; such a
customer still books, and no key is issued (§2.1, R25).

**Text changed:** §2, §3.3 (intake), §7.1, §7.2, §7.4, §9, §14 (limits).

### A1.6 Smaller items (proposed)

**Status: proposed.** Not approved yet, so none of this is in force or in the body above.

| Risk | Proposed |
|---|---|
| The overlap relation (≥ 50% of the smaller business's customers) relates two tiny businesses through one shared customer, and a stranger with one real booking at each victim can join them as in A1.3. | Overlap also needs at least 5 shared customers (*default*). |
| An IPv4 /24 or IPv6 /48 at a cloud host holds many unrelated customers. Honest businesses there become related, and an attacker can rent a server in each victim's block and join them as in A1.3. | Relate by one IPv4 address or one IPv6 /64 (*default*). A ring can use different blocks anyway. |
| Anyone can ask for a code to an address, which replaces the owner's code, or use up its 3 sends an hour or its 5 tries, and keep the owner out of recovery. | `start` always returns an id, and `finish` needs it with the code. Each id has its own code and its own 5 tries, so a stranger's calls never touch the owner's code. The 3 sends an hour stay, and one IP may ask once an hour per address (*default*). Someone with 3 IPs can still hold recovery off while they keep at it. |
| Past the 20-a-day presentation limit, `email_match` is still worked out afresh, so a business holding a pass can test guessed emails without end. | Past the limit the stored answer comes back whole, `email_match` included. |
| `since` to the second and `score` to six decimals are close to unique, so two businesses can link one person's presentations despite separate `ppid`s. | `since` is the first day of its month (UTC), and a presentation's `score` has two decimals. |

These narrow what an attacker can do. R21 (recovery by email) and R22 (a person's record is seen
only when presented) get stronger. The overlap minimum and the single address remove only relations
that rest on little: a few shared customers, or a block shared with strangers. If accepted, §14
gains the new numbers.

### A1.7 A customer's broken promises count once their email is proven

**Status: accepted (Tiago, 23 Sep 2026)**, part of rules version 4. Tiago was asked: "Someone could
book using another person's email, then not turn up, to hurt that person's record. How should a
customer's broken promises count?" He chose:

> Only once their email is proven: Kept promises always count. A no-show or late cancellation
> counts against a person only once their email is proven: they used the code we emailed them,
> verified by code, or wrote from their real mailbox. Someone using your email can't hurt you.

**Risk.** A first booking needs only an email address, and nothing proves it is the booker's
(§2.1). Anyone can book with someone else's address: the network issues a person for it, the
booker's agent gets the pass, and every no-show or late cancellation lands on the record of the
address's owner, who inherits it with the key that reaches their mailbox.

**Rule.** Kept outcomes always count. A broken outcome about a customer (§3: a no-show, a late
cancellation, a failed payment, a charge-back) counts against the item's person only when their
email was proven by the outcome's date, in one of the ways Tiago named:

- **Network-proven** (§2.3): they used a code the network emailed them. This counts for every
  business's outcomes.
- **Proven to the business** that recorded the outcome, for its own outcomes only. Either they
  entered its one-time code or wrote from the address by authenticated mail (§8.2), and its inbox
  said so with `email_proof` (`"otp"` or `"dkim"`) when it issued or linked them with that address
  (§7.1, §7.2); or they presented there the key issued for the address, which rides on the first
  email to it (§2.1). The network records a proof only for an address that is the person's: never
  on a `409`, and on a presentation only when `email_match` is not `"no"`.

Otherwise the outcome is stored (R9) and never scored, even after the email is proven: a stranger's
no-shows from before the owner proved the address never reach the owner's record. Failed payments
and charge-backs follow the same rule, since an order can be placed with someone else's address too.

**Tiago's decisions.** R15 holds: customers keep their own reputation, built from their first kept
promise. R25 gets stronger: nobody's record falls for what someone else did with their address.
R16 and R19 are untouched: a first booking still needs only an email, and the key still comes by
email. A business's own history of a customer (§8.2) is unchanged: a weak match never joins the
known customer. The cost: a customer who never proves their email carries no broken outcomes; a
presentation's `email_proven` shows whether the network holds proof. A business could claim a
proof it never saw; that is its word, like the no-show itself, so it counts for that business's
outcomes only, still at most one outcome's worth per business and open to contest (§3.4).

**Still open.** A proof covers outcomes dated after it, whenever the booking was made. A stranger
who booked with the address before its owner signed in, and missed the booking after, still counts
against the owner, who can contest it (§3.4); recovery also revokes the stranger's pass (§2.3),
while a sign-in does not.

**Text changed:** the rules in one screen (1), §1 (R15), §3, §5.3 (customers), §7.1 and §7.2
(`email_proof`), §8.2 (linking), §10 (impersonation), §14 (a customer's broken outcomes), §15.
