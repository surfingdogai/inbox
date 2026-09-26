# ADR-017 — Reputation and ranking: network rules 0.1

**Status:** accepted, 22 September 2026; revised the same day for R28–R32 (§15); amended on 23
September 2026 by Amendment 1, in force as rules version 4 (§15); amended on 26 September 2026 by
Amendment 2 (a customer's stop and erasure, A2.1–A2.2; leaving the directory and silence, A2.3–A2.4;
the business profile and searching near a place, A2.5; searching by words and language, A2.6;
assistants, A2.7; a page for a person, A2.8; a customer's contest, A2.9; customers not scored for
now, A2.10), accepted by Tiago, rules version 5 (§15). The decisions are
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
   customer only once their email is proven: someone using your email can't hurt you. A customer
   who says a broken outcome about them is wrong: it counts for nothing while the business may
   answer; disputed within 14 days\*, half; not answered, never (A2.9).
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
   signed pings count. Silent 90 days\*: set aside until it answers, after a warning 30 days\*
   before (A2.4). Near me: within `radius_km` (10). A search by words, category or language, or for
   what is open now, only leaves businesses out; nothing a business says about itself moves it
   (A2.5, A2.6).
6. **Tiers (R25):** `new`, `building` (≥ 0.40), `trusted` (≥ 0.75\*, with breadth). Nothing below.
7. **People (R16, R19–R22, R28).** One key per person per network, issued at a first booking and
   sent by email. Agents carry a pass or sign with our SDK. A business sees a person's record only
   when their agent presents it. Lost key: recover by email. Our network recognises only its keys.
   A customer can stop a business from seeing them, or erase their record; the business keeps its
   own record, bound to no one (A2.1, A2.2). For now our network scores no customer (A2.10).
8. **Forever (R8, R9, R17).** Every receipt is kept. Rules are versioned at `/v1/ranking`, changes
   announced 15 days\* ahead. Nothing about the order can be bought, and nobody is ever blocked. A
   business may leave the directory and come back whenever it likes, keeping its record (A2.3).

## 1. Decisions

| # | Decision | In Tiago's words, where given |
|---|---|---|
| R2 | A promise counts when **completed**, not when confirmed or paid. New receipt kinds. | |
| R3 | A counter-signature adds weight only from a **verified** agent; otherwise it is the business's word. Only a token counter-signing that very receipt verifies (A1.1). | "Only a real counter-signature verifies a promise." |
| R5 | Score = **reliability with confidence**. 20/20 outranks 900/1000; 2/2 does not. | |
| R6 | Broken promises recorded **by the inbox automatically**, and reported by verified customers' agents. | |
| R7 | A distinct customer counts fully once; returning adds a little; cap 3 per customer. One mailbox is one customer (A1.4). | "One mailbox is one customer (ana+1@gmail.com counts as ana@gmail.com)." |
| R8, R9 | No cutoff; nothing ever drops to zero. Keep every receipt forever. | "ranks are permanent" |
| R10–R12 | No-record businesses after ranked ones, shuffled daily, ties too. Near me = best within the agent's radius (default 10 km). A silent inbox keeps its rank, sorts after answering ones, "not answering since …". A business that signs its pings answers only by signed pings (A1.2). Silent 90 days, it is set aside until it answers (A2.4). | "Once an inbox signs its pings, only signed pings count." |
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
   *Amended 23 Sep 2026 (Tiago):* a network other than the default one is asked, and is sent a
   customer's email beside a pass it issued (§8.1), only once it has verified this inbox (its
   `network_status` is `registered`); a retry asks again only while that holds. A test item asks
   no network anything.
3. On `201` it gets a **key**, a first **pass** labelled with the carrying agent and a presentation
   (a second batch seals them in `pending_identity`). The pass goes back in the response
   (`identity.passes` and MCP text, §8.4; the status door re-attaches it). The key rides on the first
   email to the customer, or within 24 h one line of its own, in the business's voice: *"If you use
   an assistant, it can show this code next time so we recognise you: sdkey1_…"*. Then it is
   deleted. The customer most often does not know any network exists, only that they contacted a
   business, so nothing a customer or their email sees names the network, a pass, a key or a
   receipt, and the sender is the business; the business can switch the line off
   (`customers.emailKey`, default on), and the pass still reaches the agent.
   *Amended 23 Sep 2026 (Tiago):* the key never rides on another email. It goes alone, a day after
   the first contact, with one line in the business's words — "We use a booking network to recognise
   returning customers. How it works: <link>" (and its Portuguese) — linking a page the inbox serves
   (`/c/privacy`) that may name the network, says what it keeps and how to stop. With no public URL
   for that page, no key email is sent.
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
**presentation** (§7.2) from a real request, each listed to the person at `GET /v1/person`. With a
session made from a code in the last hour, a person can erase their record (A2.2). A person without
an assistant does all of this on the network's own page, `/me` (A2.8).

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
removes one. A person may **contest** a broken outcome about them. The business may withdraw it at
any time (which is how a mistaken no-show is undone), or dispute the contest within 14 days\* of its
filing. Up to rules version 4 the outcome counts half until withdrawn; from version 5 it counts
nothing while the contest is open, half once the business disputes it, and never again once the
business has let the 14 days pass (A2.9).

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
| `d` dispute | 0.5 for a disputed report, the kept outcome it disputes, or a contested outcome (from version 5, one whose contest the business disputed; an open contest's outcome counts nothing, A2.9). |

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
1, so 2.0 at `c` 2.0) → 0.5094; contested and the contest disputed, 0.6092 (from version 5,
while the contest is open, 0.7763, A2.9); with the email unproven, the no-shows count nothing
(0.7763). A
presentation gives `{tier, score, kept, broken, businesses, email_proven, since, unusual_use, rules,
scored}`; `scored` is false while a network scores no customer, and the rest then says nothing about
the person's outcomes (A2.10).

## 6. Ordering

**Member** means `status IN ('verified','unreachable') AND verified_at IS NOT NULL` (R8, R12): a
member may call the network and is scored every night. **Listed** means a member that has not left
the directory (A2.3) and, from rules version 5, is not set aside for silence (A2.4); the directory,
its hourly order and its counts hold listed businesses only.
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
order is `rank_pos`, with `distance_km`. **Filters:** `category`, `item_type`, `language`, `q` and
`open_now` (A2.5, A2.6) narrow the same way; nothing a business's profile says moves it, and how well
a business matches `q` orders nothing. **Cursor:** base64url JSON
`{m, p}` (mode, last `rank_pos`), continued in the current snapshot, so across `:00` an entry may
repeat or be skipped; other cursors, including earlier formats: `410 cursor_expired`.

## 7. The network protocol (R24)

With §2–§6 this is the whole protocol; nothing in it refers to a private implementation.
`docs/protocol/network.md` restates it (the vectors decide any difference). A network may choose
its own numbers (§14) and publishes them at `/v1/ranking`.

### 7.1 Endpoints

| Call | Auth | Body → answer |
|---|---|---|
| `POST /v1/instances` | none | `{domain}` → `202`; fetches `https://<domain>/.well-known/agent-inbox.json`, requires `spec` starting `surfingdog-inbox/` and `instance` = `https://<domain>` (port 443, no path), keeps `profile`, `item_types`, `protocols`, `receipt_keys` |
| `POST /v1/instances/{domain}/ping` | optional `sdi-instance/1` | §7.3 |
| `POST /v1/instances/{domain}/listing` | `sdi-instance/1` by that domain | `{listed}` → `{domain, listed, delisted_at, dormant_since, shown_from}`: the business leaves the directory, or comes back (A2.3) |
| `POST /v1/receipts` | the JWS | `{receipt, ack?}` → `{ok, state: "issued"\|"acknowledged", duplicate}`, v1 and v2 |
| `GET /v1/businesses` | none | `near?, radius_km?, category?, item_type?, language?, q?, open_now?, limit ≤ 100, cursor?` → `{businesses: [listing], next_cursor}` |
| `GET /v1/businesses/{domain}` | none | listing + `outcomes: {"<code>": <count>}` for every §3 code |
| `GET /v1/categories` | none | → `{version, categories: [{slug, labels}]}`: the categories list (A2.5) |
| `GET /v1/ranking` | none | `version?` → §7.3 |
| `POST /mcp` | none | one JSON-RPC message: the tools `search_businesses`, `get_business`, `list_categories`, the same reads for an assistant (A2.7) |
| `GET /openapi.json`, `GET /llms.txt` | none | the public reads described, for a program and in plain words (A2.7) |
| `POST /v1/persons` | `sdi-instance/1` | `{request_id, email, agent: {label?, jkt?, directory?}, email_proof?}` → `201 {key, pass, presentation, ppid, person}` · `409 person_exists` · `429 rate_limited` |
| `POST /v1/presentations` | `sdi-instance/1` | §7.2 → `{presentation, ppid, person, pass?, email_match?}` · `404 unknown_pass` · `410 revoked` · `403 pass_requires_signature` · `403 unlinked` |
| `POST /v1/passes`, `/v1/passes/revoke` | the key; the pass or a session | `{key, label}` → `{pass}` (≤ 10 a day per key); `{pass}` or `{pass_id}` → `{revoked: true}` |
| `POST /v1/delegations` | session **and** `sdi-agent/1` by the key delegated | `{pass}` → `{pass_ref, jkt, bound: true}` |
| `GET /v1/person`, `POST /v1/person/contests` | session | standing, evidence, passes, delegations, presentations, `stopped`; `{evidence}` → `{id}` |
| `POST /v1/unlinks` | `sdi-instance/1` | `{request_id, ppids?, presentations?}` → `200 {unlinked, items, open_items}`: the customer stopped this business (A2.1) |
| `POST /v1/person/unlinks`, `/v1/person/unlinks/remove` | session | `{business}` → `{business, stopped, since?, by?}`: the person stops a business, or lets it again (A2.1) |
| `POST /v1/person/erase` | a session made in the last hour | `{confirm: "erase"}` → `202 {erasing: true}` (A2.2) |
| `POST /v1/recovery/start`, `/finish` | none | §2.3 |
| `POST /v1/reports` | signed (§3.4) | → `202 {id, status: "open"\|"disputed", respond_by}`; `disputed` when the business already recorded a customer outcome for the item (§3.4) |
| `POST /v1/reports/{id}/response`, `/v1/contests/{id}/response` | `sdi-instance/1` | `{answer: "dispute"}`; `{answer: "withdraw" \| "dispute"}` (A2.9) → `{id, status, answer}` |
| `GET /me`, `/me/about` (should) | an emailed code | the person's calls above as a page, for a person without an assistant, and the notice (A2.8) |

### 7.2 Listings, presentations and forwarded signatures

A **listing** has `domain`, `name`, `description?`, `city?`, `country?` (ISO 3166 alpha-2),
`address? {street?, locality?, postal_code?, country?}`, `categories` (slugs of the categories
list), `tags`, `languages`, `item_types` (string arrays), `protocols` (name → URL), `hours?
{timezone, weekly, closures}`, `open_now` (`true`, `false`, or `null` without hours), `services
[{name, type}]` (A2.5), `geo? {lat, lng}`, `distance_km?` (near only), `url?`, `manifest_url`,
`verified_at`, `last_ping_at?` (the last
ping that counts, §6), `software? {version, runtime}`, `receipts {issued, acknowledged, last_at?}`
(promises only), `answering`, `online` (its alias), `not_answering_since`, `rank_pos` and
`reputation {ranked, score, tier, kept, broken, customers, verified_share, rules}` (times ISO 8601;
`verified_share` is the share of weight from verified evidence). Nothing about any customer is ever
returned.

`POST /v1/presentations` takes one of `pass`, `key` or `agent_key`, `purpose: "request"|"ack"`,
`sha?`, `email?`, `email_proof?` and `resume?`; `person` is §5.3's object. A person who stopped this
business, or whom it stopped for them, is `403 unlinked`; `resume: true` (the customer lifted their
stop there) lifts a stop the business made, never one the person made (A2.1). A key is exchanged for
a pass, reusing one minted for the same key and agent within 24 h. `email_match:
"proven"|"unproven"|"no"` lets an inbox recognise a known customer without a code (§8.2).
`email_proof` (`"otp"`: a code the inbox emailed to the address was entered; `"dkim"`:
DKIM-authenticated mail from it; anything else `400`) says how the inbox proved `email`, which it
needs; on `POST /v1/persons` it is recorded for the person a `201` creates, never on a `409`, and
here only when `email_match` is not `"no"` (A1.7). Limits (*default*): 600 calls a minute per
instance; 20 per person per business per day, then the last result is returned.

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

Ping body `{version, runtime, counts: {bookings, orders, quotes, messages}, manifest_sha256}` (last
24 h; `counts` optional; `manifest_sha256`, optional and read on a signed ping only, the SHA-256 of
the manifest as served, which makes the network fetch a changed manifest at once, A2.5).
**Unsigned:** `204`, no body, as today; it counts as answering only for a business that has never
sent a signed ping (§6), and is kept as telemetry (§9). **Signed:**
`200 {ok, rules: {version, effective_at}, next_rules: {version, effective_at, url} | null, reports:
[{id, receipt_sha, out, why, created_at, respond_by}], contests: [{id, evidence_id, out,
created_at, respond_by}], standing: {score, tier, ranked}, listing: {listed, delisted_at, dormant_since}}`;
anyone can ping for any domain, so only a signed ping sees these. The new inbox treats `200` and `204` as success.

`GET /v1/ranking` (the version in force; `?version=N` for any past one, forever) returns `{version,
rules, status, effective_at, summary, order, score, weights, timing, verified, tiers, never_used,
changelog, next}` (version 3's `rules` is `"0.1"`; version 4's `"0.1.1"`, 0.1 with Amendment 1;
version 5's `"0.1.2"`, 0.1.1 with Amendment 2, with the fields "A2 in the rules version" lists): §6's order and
every §14 value (with `recognised_platforms` and the PSL snapshot date) under the `packages/spec`
schema's names; `never_used` lists advertising, payment, amounts, anything a business's profile
says about it except its location, and who is searching. The changelog starts at version 2
(2026-09-22, the neutral order during the redesign). While a network scores no customer, every
version from 3 that it serves also carries `customer_scoring`, which says so (A2.10).

### 7.4 Errors, schemas and vectors

RFC 9457 problems with a `code` (a `400` may have none); a failed acknowledgement prefixes `ack_`.
**400** `malformed`, `bad_payload`. **401** `unknown_instance`, `bad_signature`, `expired`,
`not_signed_in`, `replayed_signature` (inbox). **403** `pass_requires_signature`,
`not_your_receipt`, `report_requires_signature`, `unlinked` (A2.1). **404** `unknown_pass`,
`unknown_issuer`, `not_found`. **409** `person_exists`, `nonce_reused`, `already_reported`,
`you_acknowledged_it`, `nothing_to_verify` (inbox), `already_verified` (inbox). **410** `revoked`,
`cursor_expired`. **413** `too_large` (a body over the network's limit, 64 KB at most). **422**
`unknown_key`, `unknown_ref`, `bad_alg`, `bad_typ`, `not_yet`, `report_window`, `contest_window`
(A2.9), `bad_code`, `code_expired`, `positive_only` (inbox, saving a rule, §8.3). **429**
`too_many_receipts`, `rate_limited`, `too_many_attempts`.

Schemas are zod in `packages/spec` (MIT), JSON Schema generated by `z.toJSONSchema` into
`packages/spec/schemas/`. Vectors in `packages/spec/vectors/`: `receipts-v2.json` (every claim and
every transition path's outcome); `passes.json` (formats, `ppid`, 12+ email cases: IDN, `ß`,
full-width, trailing dot, plus-address, refused quoted local part, the refused characters and
domain labels of §2); `signatures.json` (both
profiles, both tags, `agent_key`); `scoring.json` (every §5.2 row with its `scoring_time`, the R5
grid, the ageing cap, hold and release, R32); `ordering.json` (shuffles above 2^53, cursors);
`profile.json` (what a network keeps from a profile, A2.5); `mcp.json` (the card an assistant reads for
a listing, and one answer of each tool, A2.7). The categories list is
`packages/spec/vocab/categories.json`.

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
`signatures: ["sdi-agent/1"]`, `passes`, `networks` and `guide`. Its `profile` gains `hours` (the
inbox's weekly hours and closures, with its time zone) and `services` (names and how each is taken),
and names its `categories` from the categories list (A2.5). The **SDK** (`packages/sdk`, MIT,
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
even when a business is deleted, leaves the directory or is set aside; business snapshots too. When a customer stops a business or erases
their record, what that business holds about them stays and is cut from them, bound to an anonymous
stand-in (A2.1, A2.2); an erased person's acknowledgements keep what they did, without their
agent's key. A stopped pair is kept as a keyed hash of person and business; an erasure,
under the id that named the person and now names nothing. Secrets only as SHA-256, except an
issuance answer, sealed for its 7-day replay, and a pass minted by exchanging a key, sealed 24 h so
the same key and agent get it back (§7.2). Emails only as keyed hashes: `email_mac`; the email's
registrable domain (none for free mail), for §3.4's own-domain rule and §4's one-domain-one-customer
rule; and the customer key (§4). Pings, with their address, are telemetry kept 90 days. Listings and
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
| **A hostile business; tier as credit** | A customer's broken outcomes from one business ≤ one outcome's worth, nothing while contested, halved once the business disputes the contest (A2.9); order payment never waived; instant bookings ≤ 2 open, ≤ 20000; shop ≤ 2× paid. | — |
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

*Amended 23 Sep 2026 (Tiago):* the inbox side is built. A customer can stop the networks for
themselves from the page the key email links to (or the owner for them): from then on the inbox sends
no network anything more about them — no first contact, presentation, receipt or acknowledgement —
reads no standing for them, and withholds what was still queued. The owner can export one customer's
data and erase it (personal data rewritten, structure and receipts kept), which also stops the
networks. The network side is still a task: there is no call to unlink a person from one business's
items or erase them, so what a network already holds stays, and a promise it holds for a stopped
customer is closed by nothing and becomes `promise.unclosed` (R30) for the business.

*Amendment 2 (accepted, 26 Sep 2026):* the network side. The inbox tells each network about a stop
(`POST /v1/unlinks`), the network cuts the person from that business onto an anonymous stand-in and
refuses the business their standing from then on, and the inbox still publishes the outcomes of the
promises the network already held, naming no one (A2.1). A person can erase their record
(`POST /v1/person/erase`, A2.2). The notice and the access, correction, download, objection and
erasure it describes are on the network's own page for people, `/me` and `/me/about`, which the
page the key email links to may link to (A2.8).

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
| Silence; leaving | set aside after 90 d with no ping that counts and no good manifest fetch, warned ≥ 30 d before; one notice a day to any one address; ≤ 10 listing changes a day (A2.3, A2.4) | Tiago (N3); rest default | A closed inbox is not listed for ever; a business leaves when it likes |
| Contests | an open contest's outcome counts nothing; disputed within 14 d of filing, half; not disputed by then, never (A2.9) | Tiago (Q2); 14 d default | A customer's word that a record is wrong holds while it is checked |
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
- **Version 5, 26 Sep 2026 (Amendment 2):** a customer who stops a business or erases their record
  counts there as an anonymous customer (A2.1, A2.2); a business may leave the directory and come
  back (A2.3); silent 90 days, a business is set aside until it answers (A2.4); profiles, filters
  and search words only leave businesses out (A2.5, A2.6); an open contest's outcome counts nothing,
  disputed half, unanswered within 14 days never (A2.9). Its rules are named 0.1.2. A network puts
  it in force the moment it publishes it when no more than one business is a member of that network
  then, as versions 3 and 4 were; otherwise at 00:00 UTC on the sixteenth day after the day it
  published it, at least 15 days' notice (N1). Our network also scores no customer for now, under
  every version (A2.10). The receipts ADR-018 adds (`amended`, `refund`) come in version 6.

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

## Amendment 2 (24 Sep 2026; accepted 26 Sep 2026)

**Status: accepted (Tiago, 26 Sep 2026)**, with the decisions below, as rules version 5 (`"0.1.2"`).
A network puts version 5 in force the moment it publishes it when no more than one business is a
member of that network then, and otherwise at 00:00 UTC on the sixteenth day after the day it
published it (N1). A2.1 and A2.2 are the network's half of the
customer's stop that the inbox already has (§12) and of a person's right to have their record
erased. They are rights, so a network applies them as soon as it has built them, not from a rules
version. What they change about counting customers is written into the rules text of the next
version (below) when it is published. A2.3 (leaving the directory) is the business's own act, and
applies the same way. A2.4 (silence) is the one rule here the network applies to a business on its
own account, so it waits for rules version 5. A2.5 (the business profile, and searching near a
place) changes what a listing shows and what a search may ask, never an order or a score, so it too
applies as soon as it is built; the one line it adds to the rules is published with version 5. So do
A2.6 (searching by words and by language) and A2.7 (the doors an assistant uses): they change what a
search may ask and how the same answers are read, never an order or a score. A2.8 (a page for a
person) adds no call: it is the person's own calls, for a person without an assistant. A2.9 (a
customer's contest) changes what an outcome counts, so it waits for version 5 too, although the
business's new answer is taken as soon as a network builds it. A2.10 (customers not scored) is not
a rule of version 5: while it lasts it holds under every version, and a network says so in every
version from 3 that it serves.

**Tiago's decisions (26 Sep 2026).** Each was put to him with options and a recommendation; he took
every recommended one.

- **N1. When version 5 takes effect.** The moment a network publishes it, when no more than one
  business is a member of that network then (nobody else is owed notice, as for versions 3 and 4);
  otherwise at 00:00 UTC on the sixteenth day after the day it published it, so every other business
  has at least 15 days' notice (§11). A network decides this once, when it first publishes version 5.
- **N2. A business that left the directory keeps everything else** (A2.3): it is still a member, it
  is scored, its customers keep the credit of their kept promises there, and its promises still
  close honestly.
- **N3. A business silent for 90 days is set aside**, back by itself when it answers, with a plain
  note to its contact before and when it happens (A2.4).
- **N4. A domain that changed hands.** After 90 days or more set aside, a return with none of the
  keys the business had proven starts a new record; the old one is kept and never shown. Accepted,
  not built yet: until a network builds it, a domain's record follows the domain, as before, and it
  comes with the rules version that brings it, announced as §11 says (A2.4).
- **N5. A stopped customer's open promises still close** (A2.1): the inbox keeps publishing their
  outcomes without naming the customer, and the network links them to no one, so a business is not
  counted against for respecting a stop. The network side is built; the inbox side is to be built.
- **N6. A person can stop a business themselves**, from their page or with their session, and only
  they can lift that stop (A2.1, A2.8).
- **N7. The emailed code is the only proof for erasure**: a key may have passed through a business
  (A2.2).
- **N8. A customer who stops a business or erases their record stays counted there** as an anonymous
  customer: a customer's privacy never lowers a business (A2.1).
- **N9. After erasure the same address may come back at once**, as a new person with no record
  (A2.2).
- **N10. The street is shown when the inbox publishes it**, and the inbox warns the owner where it is
  entered to leave it empty if they work from home (A2.5).
- **N11. `open_now=true` leaves out a business that published no hours**: the person asked for
  certainty (A2.5).
- **N12. The categories list** is the one published, 28 slugs in `packages/spec/vocab/categories.json`
  (A2.5).
- **N13. Our network's pages tell browsers to use https for a year**, for its own host only, not its
  subdomains and not preloaded. This is our network's own choice, not the protocol's.
- **N14. Our network's MCP server is written on its language's standard library**, with no MCP
  library (A2.7). Our network's own choice too.
- **Q2. A contested outcome does not count while the contest is open** (A2.9). If the business does
  not answer within 14 days, the customer's contest wins and the outcome no longer counts. If the
  business disputes it, it counts half, as §3.4 said. In version 5.
- **Q11. Our network scores no customer for now** (A2.10). Keys and passes are still issued, the
  directory runs, and businesses are scored as these rules say; no customer is scored and no
  customer's standing is told from what happened, until Tiago switches it on and announces it.

### A2.1 A customer who stops a business

**Why.** Since 23 Sep 2026 a customer can stop the networks for themselves from the page the key
email links to, or the owner can for them (§12). The inbox then sends nothing more about them, but
the network keeps everything it already holds: the business can still present them and learn
their standing, their record keeps the business's outcomes, and a promise the network holds for
them is closed by nothing and becomes `promise.unclosed` (R30) for the business, which is counted
against it for respecting the customer's wish.

**Rule.**

- **The inbox tells each network.** `POST /v1/unlinks`, signed `sdi-instance/1`:
  `{"request_id": "…", "ppids": ["…"], "presentations": ["…"]}`. The customer is named by the
  `ppid`s this network gave this business for them (at most 8: one per address they used) and the
  presentation ids the inbox kept for their items (at most 200); at least one of the two. The
  network looks only at what it gave this business. Ids that name nobody are not an error: the
  answer is `unlinked: 0`, and the business learns nothing it did not know. The same `request_id`
  within 7 days gets the same answer, byte for byte; with other ids it is `400 bad_payload`.
- **The network cuts the person from the business.** Everything of theirs there moves onto an
  anonymous **stand-in**: a record that is nobody, with no address, no key, no pass and no session,
  which exists at that business only. That is their presentations there (keeping what the business
  was told, without the person's pass, `ppid` or first-seen date), their receipts there and so their
  items and evidence, and their reports and contests there. The business's own record stays exactly
  as it stood: every piece of evidence, its weight and its state. The business's proofs of the
  person's address (A1.7) and the 7-day replay of their first contact there are deleted. The
  person's own record loses that business's outcomes, the kept ones with the broken.
- **The answer** is `200 {"unlinked": <persons>, "items": <items moved>, "open_items": ["<itm>", …]}`:
  the items whose promise has no outcome yet.
- **Open promises still close.** For the `open_items` only, the inbox keeps publishing the outcomes
  as they happen, with no `per` and no acknowledgement, and nothing else about the customer. They
  land on the stand-in. So a business is never counted `promise.unclosed` for respecting a stop,
  and the network learns nothing new about the customer.
- **The pair stays stopped.** The network records that this business has a stopped customer by a
  keyed hash of the person and the business, so only someone holding the person's own id can tell
  which customer. From then on, a presentation of that person by that business is `403 unlinked`,
  whatever it carries (a pass, the key, a forwarded signature), and no pass is minted and no proof
  of address recorded for it. Other businesses are not affected.
- **Lifting a stop.** When the customer lifts their stop at the business, the inbox sends
  `"resume": true` with its next presentation of them. That lifts a stop the business made for the
  customer, never one the person made themselves. What moved to the stand-in stays there.
- **The person can stop a business themselves.** `POST /v1/person/unlinks {"business": "<domain>"}`
  with their session does the same, and only they can lift it (`POST /v1/person/unlinks/remove`).
  `GET /v1/person` lists every stopped business, since when, and whether it was "you" or "the
  business".
- **Nothing links them again.** A receipt that arrives later naming a presentation that moved lands
  on the stand-in.
- **A stop never takes away a report.** The customer can still report what happened before the
  stop (§3.4): a report by the person about an item that moved onto their stand-in is taken, with
  the same checks, and recorded on the stand-in, naming no pass of theirs. A person who was
  established (§4) when their rows moved counts as established for these reports, whatever the stop
  did to their record since: otherwise a business could take its outcomes off a customer's record,
  and with them the standing a report needs.

**How a stand-in counts** (the text rules version 5 publishes under `weights.stand_ins`):

> A customer who stopped a business, or erased their record, counts at that business as an
> anonymous customer, and their outcomes there count for no person. That customer is never scored,
> weighs as a customer with no record (`c` = 1), and is its own customer in the repeat rule (R7). Two
> addresses of one mailbox (A1.4) are one such customer at a business. It counts among the
> business's distinct customers (§5.3) exactly when the person counted there at the moment they
> were cut and nobody still linked there counts as the same customer; a person there with the same
> mailbox counts instead of it. An address at a company's email domain stays, with every other
> address there, linked or stopped, that domain's one customer (§4). An address at the business's
> own domain never counts (§3.4). It relates the business to nobody (§4).

So stopping customers, one by one or all at once, never adds a customer to a business and never
takes one away, and a business cannot turn one mailbox, or one company's domain, into several
customers by stopping them.

**Tiago's decisions.** R9 holds: every receipt is kept; the network only cuts who it was about. R15:
a customer's record is theirs, and after a stop it no longer carries that business, good or bad.
R22 gets stronger: a customer can take back a business's sight of their record. R25 (positive
first): a stop only removes links, and a customer's wish never lowers the business's customers or
tier. R6 gets stronger: a business cannot silence a report by stopping the customer. R30 holds as
written: an open promise still closes, now by an outcome that names no one (N5). A person may stop a
business themselves (N6), and a customer's stop never lowers the business's count (N8).

**Still open.**

- Rows with a stopped customer weigh as a newcomer's (`c` = 1) instead of by the customer's record,
  so the business's confidence can move a little, either way. The business chooses whom it stops,
  so it can choose the direction: stopping the customers of its own broken promises who have strong
  records makes those broken promises weigh less. Keeping on each stand-in the `c` its customer had
  when they were cut would close this.
- A business's stop takes the business's outcomes off the customer's record, the kept ones too, on
  the business's word alone. The customer sees it (`by: "the business"`) but cannot undo what moved,
  so a business can lower a customer's standing without any verified basis (R25). One way to close
  this: a business's stop hides the customer from it at once, and moves their rows only when the
  customer confirms the stop themselves.
- Another business that counted the customer only because they had been seen at the stopped
  business may no longer count them.
- A stand-in takes no part in the overlap relation (§4), so a business that stops customers it
  shares with another lowers what the two share: related businesses could stop part of what they
  share until they no longer look related, and what they still share would then count as if they
  were not.
- A business asks on its customer's word, which the network cannot check. It gains nothing in its
  count by it, and cannot see the customer again until they come back.

**Text changed:** the rules in one screen (7), §7.1 (endpoints), §7.2 (`resume`), §7.4 (`403
unlinked`), §9, §12.

### A2.2 Erasure

**Why.** §12 lists "erasure against R9 (unlink the `pid`, keep pseudonymous evidence)" as a task.
Until now a person could revoke every pass and see everything the network holds about them, but
not have it erased.

**Rule.**

- **Asking.** `POST /v1/person/erase {"confirm": "erase"}` with a session made from an emailed code
  in the last hour → `202 {"erasing": true, "message": "…"}`. The code is the only proof: a key can
  have passed through a business at first contact (§2.1), and a business may borrow a person's
  standing but never act as them (§2).
- **At once.** Every key, pass, delegation, session and code of the person is revoked, so nothing can
  act as them from the answer on, and recovery treats their address as unknown.
- **Then.** The person is cut from every business as in A2.1, and deleted: the keyed hashes of their
  address, their keys, passes, delegations, sessions, codes, proofs of address, nightly scores,
  stopped pairs and first-contact replays. The keyed hashes of their mailbox and of their company's
  email domain on their stand-ins are cleared too, unless another person still has the same one.
  Acknowledgements their agent signed keep what they did for the businesses' evidence, but lose the
  agent's key and signature, and the network's own audit trail stops naming their id beside a
  business or a report: the same agent, back with the address starting again, leads nowhere.
- **What stays, and why.** Each business's receipts, reports, evidence and presentations, bound to
  no one. A receipt is the business's own signed statement, and the business's reputation and other
  people's claims rest on them (GDPR Art. 17(3)(e)); cut from the person, they no longer identify
  anyone to the network. The network keeps a record that the erasure was asked for and finished,
  under the random id that named the person and now names nothing, so that an erasure interrupted by
  a failure is finished, and one is done again on a copy of the data restored from before it
  (Art. 5(2)).
- **Starting again.** The same address can come back at once as a new person, with nothing carried
  over.

**Tiago's decisions.** R16 and R19 are untouched: a first booking still needs only an email, and a
new person starts neutral (R25). R21: the emailed code, the way a person proves themselves for
recovery, is also the way they prove themselves for erasure (N7). R9 holds for the businesses'
records. The same address may come back at once as a new person (N9).

**Still open.**

- Once those keyed hashes are cleared, the address starting again is a new customer beside its old
  stand-in. Someone who controls a mailbox, or every address at a domain, can erase and start again
  to count once more, each time, at a business they deal with. Keeping the two hashes on the
  stand-ins, for counting and nothing else, would close this, at the cost of the network still
  recognising an erased address's mailbox at the businesses it dealt with.

**Text changed:** §2.3, §7.1 (endpoints), §9, §12.

### A2.3 Leaving the directory

**Why.** A verified business stays in the directory for ever: §6 lists every one, and the only way
out was to stop answering, which kept it listed as "not answering since …". An owner who wants
their business out (they closed, they sold, they would rather not be listed, a sole trader whose
listing names them) had no way to say so.

**Rule.**

- **Member and listed.** A business the network verified is a **member**: it may call the network
  (pings, receipts, first contacts, presentations, answers to reports and contests) and is scored
  every night. A member is **listed**, in the directory, its hourly order and its counts, unless it
  left the directory or was set aside (A2.4). §6 defines both.
- **Leaving and coming back.** `POST /v1/instances/{domain}/listing`, signed `sdi-instance/1` by
  that domain: `{"listed": false}` leaves, `{"listed": true}` comes back. The answer is
  `200 {domain, listed, delisted_at, dormant_since, shown_from}`. Asking for what already holds
  changes nothing. At most 10\* changes a day; more is `429 rate_limited`.
- **An inbox that cannot sign** says the same in its manifest: `"directory": {"listed": false}`.
  The network acts when what the manifest says changes, not on every fetch: `false` leaves; `true`,
  or saying nothing, comes back, but only from a leaving the manifest made. A signed call always
  wins: a signed leaving is undone only by a signed coming back, and a signed coming back holds
  until the manifest says something new.
- **At once, and back by the next hour.** A business that leaves is gone from `GET /v1/businesses`
  at once (a cached page may show it for a few minutes more), even inside the hour whose order it
  was in; its detail answers `404` and says it left the directory. It is left out of the next
  hourly order and of the counts. One that comes back is in the order by the next `:00`
  (`shown_from`), where its record puts it.
- **Nothing else changes.** Leaving takes nothing from the record. The business is scored every
  night as before, its customers keep the credit of their kept promises there, its promises still
  close (R30 still counts an unclosed one while it is answering), reports about it are still taken
  and it may still answer them, and it keeps presenting its customers. Coming back starts no new
  hold (R31): its verification date stays.
- **Where it stands.** `GET /v1/instances/{domain}/status` and the signed ping (`listing: {listed,
  delisted_at, dormant_since}`) say whether it is listed, and if not, why.

**Tiago's decisions.** N2: a business that left keeps everything but its place in the directory.
R8, R9: every record is kept; nobody is removed against their will. R17: the
rules say who is listed (`order.member`, `order.listed`, `order.leaving`). R25 (positive first):
leaving is the business's own act and costs it nothing.

**Still open.**

- The detail of a business that left is a `404`, so an agent that meets it some other way cannot
  read its record here. A business with a poor record could leave to keep it from such agents while
  it still deals with customers who find it elsewhere; its record is still kept and counted. Showing
  a business that left as "not in the directory" with its record would close this, at the cost of
  the owner's wish to be out of it.
- The network cannot tell a business that closed from one that only wants out; both are simply not
  listed.

**Text changed:** the rules in one screen (8), §6, §7.1, §7.3, §9, §14.

### A2.4 A business that stops answering

**Why.** R12 keeps a silent business listed for ever, after the answering ones, "not answering since
…". An inbox that closed years ago stays in every search near its place, and the directory fills
with businesses nobody can reach. ADR-012 promised a statement of reasons and 30 days' notice before
a business is taken out of the directory.

**Rule (rules version 5).**

- **Silence.** A listed member with neither a ping that counts (A1.2: a signed one, once it has
  signed) nor a good fetch of its manifest (changed, or a `304`) for 90 days\* is **set aside**: out
  of the directory, its hourly order and its counts, like a business that left. A business that left
  the directory (A2.3) has nothing to be set aside from: while it is out, it is neither written to
  nor set aside.
- **Notice.** When its profile's `contact_email` is one address, the network writes to it once, at
  60 days of silence: the inbox has not answered since that date, and if it has not answered by a
  date at least 30\* days later the business will be set aside until it answers; nothing is
  deleted. A business is never set aside sooner than 30 days after that warning was sent: a warning
  counts once the mail service took it, and when it cannot be sent, the network tries again every
  hour, and waits. A `contact_email` is only what a manifest says, so the network writes to any one
  address (a `+` tag and gmail's dots folded, as in A1.4) at most once a day\*, however many
  businesses name it; the others wait in the same way. When the business is set aside, the network
  writes once more with the reason: not shown since that date, because its inbox has not answered
  since that date; nothing deleted; it comes back by itself. A business with no contact address is
  set aside at 90 days, and its status says so.
- **Back by itself.** The moment it answers, by a ping that counts or a good manifest fetch, it is
  listed again, in the order by the next `:00`, and its next silence is warned afresh. An unsigned
  ping does not wake a business that signs (A1.2).
- **Nothing taken.** Being set aside takes nothing from the record. It is scored every night as
  before, and time lowers the weight of its evidence as it lowers everyone's (R29). While silent it
  is not answering, so R30 counts no unclosed promise against it; its nine days start again when it
  answers, as always.
- **The fetching goes on.** The network fetched a manifest every six hours and stopped after 30 days
  of failures. It now keeps fetching, weekly after those 30 days, for as long as the business is a
  member, so an inbox that comes back is seen even if it never pings.

**Tiago's decisions.** N3. R8, R29: nothing drops to zero and nothing is removed; a silent business is
only not shown. R12 gains a limit: silent 24 hours, a business sorts after the answering ones;
silent 90 days, it is set aside until it answers. R25 (positive first): being set aside never lowers
a score and undoes itself, and nobody who can be warned is set aside without the warning. N4: a
business that comes back after 90 days or more set aside with none of the keys it had proven starts
a new record, and the old one is kept and never shown, at the cost of an inbox that lost its keys
and was silent that long starting again from nothing.

**Still open.**

- N4 is accepted and not built: until it is, a new owner who serves a manifest at the domain of a
  business that went silent inherits its record. It comes with the rules version that brings it.
- An unsigned ping counts for a business that has never signed (R18), and anyone may send one, so
  anyone can keep such a business from being set aside.
- A contact address the mail service always refuses keeps its business listed, and is tried every
  hour, after every business with something new to do, so it holds no other business back.

**Text changed:** the rules in one screen (5), §1 (R10–R12), §6, §14.

### A2.5 The business profile, and searching near a place

**Why.** A listing says a name, a town and little else. An assistant asked for "a hairdresser near
me that is open now" cannot tell what a business does, whether it is open, or what can be booked
there, so it guesses, or sends the person somewhere else. The inbox already keeps the business's
opening hours, its closures and its services; the network did not ask for them.

**Rule.**

- **What a profile may say.** The manifest's `profile` gains `hours`, the inbox's own weekly
  windows and closures exactly as it keeps them, with the IANA time zone they are in, and
  `services`, each service's name and how it is taken (`booking`, `order`, `quote_request`); prices
  and durations stay at the inbox, where they are current. Its `categories` are named from a small,
  public categories list (`packages/spec/vocab/categories.json`: 28 slugs, each with English and
  Portuguese labels and synonyms); anything else a profile names is kept as a free tag.
- **Checked one field at a time.** A network keeps a field only when it is well formed and drops a
  bad one alone: a bad field never fails the manifest, the verification or the listing
  (`docs/protocol/network.md` §4.6; the cases are `vectors/profile.json`). Text is cleaned of
  control characters, of characters that reorder it and of invisible tag characters, so that what
  a reader sees is what it says; a web address is kept only as `http` or `https`, and only with
  none of those characters in it.
- **Shown, never scored.** A listing carries `address` (the street only when the inbox published
  one), `tags`, `hours` (closures that have not ended), `open_now` and `services`. Nothing in a
  profile moves a business up or down; `never_used` already says so.
- **Searches only leave out.** `category` is a slug, found by its slug, a label or a synonym, or else
  a tag. `open_now=true` keeps the businesses open at that moment by the hours they published, in
  their own time zone, a closure winning over the hours. A business that published no hours is left
  out of such a search, never shown as closed. Like `near`, these narrow the hourly order and never
  reorder it (`order.filters`).
- **Kept current.** A signed ping may carry `manifest_sha256`, the SHA-256 of the manifest as the
  inbox serves it. When it is not what the network holds, and nothing was fetched in the last ten
  minutes, the network fetches the manifest at once. Such a fetch that fails counts for nothing: not
  towards `unreachable`, and it does not end the business's answering spell. Only the business's
  own signature can ask for it, at most once in ten minutes, and the network makes at most 20 such
  fetches a minute across every business: a fetch holds one of its few workers, and subdomains
  cost nothing, so many businesses asking at once could otherwise hold up every other fetch and the
  hourly order. A hint over that budget is dropped and may be sent again with the next ping.

**Tiago's decisions.** R25 (positive first): a profile only helps a business be found, and a field it
gets wrong costs it that field only. The street is shown when the inbox publishes it, with a warning
to the owner where it is entered (N10); a business without hours is left out of an `open_now` search,
since the person asked for certainty (N11); the categories list is the one published (N12).

**Still open.**

- `open_now` is as of the answer; a cached page may be a few minutes old. Nothing checks that a
  business keeps the hours it publishes.
- Categories are what a business says of itself. One could name ten categories it does not serve to
  appear in their searches; it gains presence in a filtered list, never a place in the order.
- The categories list has English and Portuguese only; another language comes by a change to it.

**Text changed:** the rules in one screen (5), §6 (filters), §7.1, §7.2, §7.3, §7.4, §8.4.

### A2.6 Searching by words and by language

**Why.** `q` matched a business's name or its town and nothing else, as one piece of text. A person
who asked for "a hairdresser in Alfama" found nothing: not a business named "Ana's Salon" whose
description says Alfama, nor one listed under hair and beauty, in either language of the categories
list. A search could not ask for a language at all.

**Rule.**

- **Every word, anywhere the business describes itself.** `q` keeps a business whose name, city,
  description, categories (with each category's labels and synonyms, in every language of the list),
  tags and services' names hold every word of it, ignoring capitals and accents, each word anywhere in
  that text. A word is a run of letters and digits; words of one letter, and a short published list of
  words that say nothing about a business ("in", "near", "de", "perto" and the like), are ignored. `q`
  is at most 80 characters and 8 words, and a `q` with nothing left to look for is refused rather than
  read as "everything".
- **Language.** `language` keeps a business that speaks that language or a variant of it (RFC 4647
  basic filtering: `pt` keeps `pt` and `pt-br`; `pt-br` keeps only `pt-br`).
- **Still only a filter.** How well a business matches orders nothing: the businesses a search keeps
  come in the hourly order, and a business that repeats a word ten times in its description is found
  exactly as one that says it once.

**Tiago's decisions.** R25 (positive first): a word a business did not write is no mark against it;
the search only finds more businesses for more people. The list of ignored words is the one
`docs/protocol/network.md` §4.3 publishes, accepted with the amendment; a change to it is a rules
change.

**Still open.** Words are matched as written, in the business's language: "haircut" does not find a
business that wrote only "corte", unless the categories list carries the word as a synonym.

**Text changed:** the rules in one screen (5), §6 (filters), §7.1.

### A2.7 Assistants

**Why.** Most people who book through this network will not see it: their assistant does the finding.
An assistant that has to scrape pages or guess an API gets less right than one that is handed the
directory in the form it reads, and a directory it reads badly is one where a business that answers
and keeps its promises is not found.

**Rule.**

- **Three doors, one answer.** A network offers an MCP server at `POST /mcp` with three read-only
  tools: `search_businesses` (`GET /v1/businesses`, the same filters, order and cursors),
  `get_business` (`GET /v1/businesses/{domain}`) and `list_categories` (`GET /v1/categories`). It
  describes the same reads at `GET /openapi.json` and in plain words at `GET /llms.txt`. No key, no
  session, and the same answer for everyone: an assistant cannot be shown a different order from the
  one the rules publish.
- **Nothing is booked here.** A result names the business's own inbox (its MCP and REST doors, when
  they are https and read as they go: no space, control or hidden character, and written as plain
  URIs, so that no client checking an answer refuses it, and every other business on the page with
  it, for one business's door), and the assistant
  books, orders or asks there. The search is all the network learns
  from it, and it keeps none of it; what it learns of a booking or an order is the business's signed
  receipt afterwards (§3.2): that it was promised and how it ended, never what was said.
- **What an assistant needs.** Each business comes as a card: what it does, where, today's hours in
  its own time zone and whether it is open now, what its inbox takes, where to book, and its standing
  in one plain sentence. The tools' schemas are public (`packages/spec/schemas/mcp-*.json`), and
  `vectors/mcp.json` pins down how a card is derived from a listing.
- **Positive first.** A tier in words is never a mark against a business: no standing yet is said to
  be where every business starts. The words carry no count of broken promises; `get_business`
  carries the count of every outcome in its structured answer, as the listing always has, and its
  text does not list them.
- **A business's words are its own.** What a business wrote about itself (name, description, city,
  services, tags) reaches an assistant as data: in the text of a result it comes after the network's
  own words, inside a block marked for each answer with a boundary no business can know, and the
  server tells assistants so. Any other door is quoted there too: the network's own words name only
  a door on the business's domain, or one short label under it, with a short plain path: a host
  and a path are text the business chose, and so kept short they say hardly more than the domain
  itself. A business that writes instructions into its description cannot pass
  them off as the network's, nor buy its way up the order with them.

**Tiago's decisions.** Accepted as proposed with the amendment: the 2026-07-28 MCP revision and the
four before it, on one endpoint, and 60 calls a minute per address. Our network's server is written
on the standard library, with no MCP library (N14).

**Still open.**

- Reviews are not in any tool yet; when they come (ADR-019), the tools say how they work before any
  appears.
- An assistant's own honesty is outside the network's reach: it can still misreport what it was
  given. The marked block and the instructions make the honest reading the easy one.

**Text changed:** §7.1, §7.4.

### A2.8 A page for a person

**Why.** Most customers never use an assistant for their record, and many never learn that a network
exists: they booked with a business, and a day later an email brought them a code. Everything §2.3
gives a person (seeing their record and every business shown it, contesting an outcome, revoking a
pass, a new key, stopping a business, erasure) needed an assistant that speaks the API. The rights
those calls serve belong to the person, not to their software, and §12 lists the notice that tells
them so.

**Rule.**

- **A page, not a new call.** A network should serve a person a page on its own origin at `/me`, and
  the notice at `/me/about`. The person signs in with an emailed code (§2.3) and reads their
  `GET /v1/person` in plain words: how things went at each business, which businesses were shown
  their record and when, the assistants that can show it, the businesses they stopped. From the
  page they contest a broken outcome about them, revoke a pass, stop a business or let it again
  (A2.1), get a new key by email, download their record exactly as `GET /v1/person` answers it, and
  erase it (A2.2). Each is one of the person's own calls, with the same effect, so the page can do
  nothing an assistant could not.
- **The person's words.** The page uses none of the protocol's words. A key is "your code", as the
  key email calls it; a pass is "an assistant that can show your record"; the evidence about them is
  "what businesses told us happened"; a contest is "This isn't right". A stop the business made is
  shown as the business's, on its word. A pass's label is someone else's word too (the `agent.label`
  a business sent at first contact or an exchange, or whatever the holder of the key chose): the page
  only quotes it, set apart from its own text, and names the business that gave it; a pass with no
  label, or the one recovery made, is named in the page's own words. The page speaks the person's
  language, and so does the code email it sends.
- **Safe without software.** No script. The session is the one §2.3 makes, in a cookie only the
  network's own host receives and no script reads; a form is taken only from the network's own
  pages, and a signed-in form also carries a token bound to the session. No page is stored or sent
  as a referrer. Erasing asks for a sign-in from the last hour, as the call does.
- **The notice.** `/me/about` says who runs the network and how to reach them, where the data comes
  from, what is kept and why, the legal basis and the right to object, who sees it, for how long,
  and where to complain.
- **Where a customer finds it.** The page the key email links to may link to `<network origin>/me`
  beside the network's name (§12).

**Tiago's decisions.** R15 and R22: a person's record is theirs to see, correct and take away, and
now without software. R25 (positive first): the page only shows, corrects, stops and deletes. A
person may stop a business themselves from the page (N6).

**Still open.**

- The notice's words are a draft until they are checked against the privacy notice they sit beside.

**Text changed:** §2.3, §7.1, §12.

### A2.9 A customer's contest

**Why.** §3.4 lets a person contest a broken outcome about them, and it counted half until the
business withdrew it. While a customer says a record about them is wrong, and before anyone has
looked again, the record should not be used against them (GDPR Art. 18(1)(a)); counting it, even
half, uses it. A business that never answered kept half a broken outcome on the customer's record
for ever.

**Rule (rules version 5).**

- **While the contest is open, the outcome counts for nothing**: not against the customer, and not
  in the counts of the business's listing. The person's record shows the row's `state` as
  `contested`.
- **The business answers.** `POST /v1/contests/{id}/response`, signed `sdi-instance/1` by the business
  that recorded the outcome. `{"answer": "withdraw"}` takes the outcome back at any time, and it never
  counts again. `{"answer": "dispute"}` says the outcome is right, and is taken while the contest is
  open and within 14 days\* of its filing; disputed, the outcome counts half (`d` = 0.5), as §3.4
  said of every contest. The answer is `200 {id, status, answer}`, `status` `withdrawn` or
  `disputed`; the same answer again gives the same result; a dispute once the contest is no longer
  open, or past its 14 days, is `422 contest_window`.
- **Not answered in time, the customer wins.** A contest the business has not disputed 14 days\*
  after it was filed is `upheld`: the outcome never counts again. The business may still withdraw
  it.
- **One outcome, whichever receipt says it.** A contest is of the customer's broken outcome on that
  item. A business that records it again, by another receipt, records the same outcome, and the
  contest holds for the new receipt as for the old: nothing while it is open, half once disputed,
  never once upheld or withdrawn. Otherwise saying it twice would make any contested outcome count
  in full. A kept outcome recorded after it takes the broken one back, and the contest touches
  nothing of it.
- **Where it stands.** The business's signed ping lists each open contest with `respond_by`, the
  last moment it may dispute it. The person's record gives each row's `contest_status`: `open`,
  `disputed`, `withdrawn` or `upheld`.
- **Before version 5.** A network takes `dispute` as soon as it builds this, and until version 5 is
  in force an open or disputed contest counts half, as §3.4 said, none is upheld, and a broken
  outcome recorded again by another receipt counts in full. A contest filed before version 5 takes
  effect has its 14 days from when it does.

**How a contest counts** (the text rules version 5 publishes under `weights.contest_weighs`, with
`timing.contest_days`, 14):

> a customer may contest a broken outcome about them, and while the contest is open the outcome
> counts for nothing; the business that recorded it may withdraw it at any time, and then it never
> counts; it may dispute the contest within contest_days of its filing (of this version taking
> effect, for a contest filed before), and then the outcome counts d; a contest it has not disputed
> by then is upheld, and the outcome never counts again

**Tiago's decision (Q2, 26 Sep 2026).** A contested outcome does not count while the contest is open;
if the business does not answer within 14 days, the contest wins and the outcome no longer counts;
if the business disputes it, it counts half. R15 holds: a customer's record is theirs, and what
they say is wrong is not used against them while it is looked at again. R25 (positive first): a
contest only ever takes weight away from a broken outcome. R6 is unchanged: a report against a
business, and its 14 days to dispute it, stay as §3.4 says.

**Still open.**

- A customer may contest every broken outcome about them, and each then counts nothing until the
  business answers; a business that disputes in time restores half. Nothing limits how often a
  customer contests.
- A business that is set aside, or has stopped answering, still has only 14 days: a contest filed
  while its inbox is down is upheld unanswered.

**Text changed:** the rules in one screen (1), §3.4, §5 (`d`), §5.3, §7.1, §7.3, §7.4, §10, §14.

### A2.10 Customers not scored, for now

**Why.** A customer's score is worked out from what businesses record about them, and shown to the
next business they deal with, which may treat them differently for it. Tiago has paused that on our
network while the legal questions it raises are answered.

**Rule.** A network may score no customer for a time, and says so. While it does not:

- the nightly run scores businesses only, reads no customer's score from before, and every customer
  weighs in a business's score as one with no record (`c` = 1);
- a presentation, a first contact and `GET /v1/person` give the person object as for a person with
  no record: `tier` `new`, and `score`, `kept`, `broken` and `businesses` 0, with `scored: false`;
  `email_proven`, `since`, `unusual_use` and `rules` are as always, and a presentation over the
  day's limit (§7.2) gives its last result again the same way, never a score from before the pause;
- nobody is established (§4), so no report is taken (§3.4) and no acknowledgement verifies by the
  delegated route;
- every rules version from 3 that the network serves at `/v1/ranking` carries `customer_scoring`:

> paused: this network scores no customer and tells no business anything about a customer that comes
> from their outcomes. Keys and passes are issued and presented as before, and a presentation
> answers as for a person with no record: tier new, score and every count 0, and scored false. In a
> business's score every customer weighs as one with no record (c = 1). Nobody is established, so no
> report is taken and no acknowledgement verifies by the delegated route. Businesses are scored by
> these rules otherwise unchanged. Scoring customers again is a rules change, announced like any
> other.

Keys and passes are still issued and presented, receipts are still taken, the directory still runs,
and businesses are scored by the rules in force. A network that scores customers answers `scored:
true`, and one built before this amendment sends no `scored`. Scoring customers again is a change of
the rules, announced as §11 says.

**Tiago's decision (Q11, 26 Sep 2026).** Our network scores no customer, and presents no customer's
standing from what happened, until he switches it on and it has been announced. Businesses are
scored as these rules say. R25 (positive first): the pause only removes what could count against a
customer.

**Still open.**

- With nobody established, a customer cannot report a business that did not keep its promise, and
  no acknowledgement verifies, so every business's record is its own word for now.
- A business's customers no longer lend its record their weight (`c` = 1 for each), so a business
  whose customers have strong records counts a little less confidence than it would.
- The customer scores a network stored before the pause are kept (§9) and never read while it
  holds; whether to delete them is open.

**Text changed:** the rules in one screen (7), §5.3, §7.3.

### A2 in the rules version

Nothing in A2.1 or A2.2 changes how a business is ordered or scored; they change who evidence is
about. A2.3 changes who is listed, at the business's own word. A2.4 and A2.9 are the network's
rules, and take effect with rules version 5: at once when no more than one business is a member of
the network when it publishes it, otherwise at 00:00 UTC on the sixteenth day after (N1), announced
meanwhile as §11 says. Rules version 5 (`"0.1.2"`) publishes `order.member`, `order.listed` (now the
directory's own predicate), `order.leaving`, `order.set_aside`, `timing.dormant_days` (90),
`timing.dormant_notice_days` (30), `timing.contest_days` (14), `limits.listing_changes_per_day` (10),
the stand-in text above under `weights.stand_ins`, the contest text above under
`weights.contest_weighs`, and `order.filters` (A2.5, A2.6: what a search may ask, all of which only
leaves businesses out, with the words `q` ignores), with a changelog entry, which says why when it
took effect the day it was published. A2.7 and A2.8 add nothing to the rules: the tools are another
way to read the same order, and the page another way to make the person's own calls. A network that
builds A2.1 and A2.3 before then already applies them, because a customer's wish must never lower a
business and a business may always leave, and its changelog says so. A2.10 is not part of any
version: while a network scores no customer, every version from 3 that it serves says so in
`customer_scoring`.

The receipts ADR-018 adds for a change to a promise and for a refund (`amended`, `refund`), and what
they count, are not in version 5: they will come as a later amendment, in rules version 6.
