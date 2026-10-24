# ADR-029 — Spam filters

**Status:** proposed, 24 October 2026. The core pipeline, its signals, the AI check behind a port, every
door, the hosted plumbing and the metering are built and tested; the owner app's screens, the phone app,
the site's pages and the WordPress plugin are not yet. Every open business decision ships switched off
(§12). Amends ADR-026 §7 and the inbox's own form (§4).

## Context

An inbox that agents and strangers can write to gets unwanted mail: sales pitches (search ranking,
links, websites, leads), scams (false invoices, changed bank details, account notices), junk, and form
bots. Today the inbox drops a filled hidden field on its own form, puts aside an email a server marked as
spam, and judges no words at all. Owners want the pitches and scams kept off their desk, and above all
they must never lose a real customer to a filter, whatever language, script or country that customer
writes from.

The decided pricing: *we pay for the AI; the spam filter is a cost per inbox × number of filters
switched on.*

## Decision

1. **Free protection and three filters.** Basic protection is always on, on every door, and needs no AI:
   form bots (a filled hidden field, a form never drawn, one filled faster than anyone types), mail a
   server marked, senders posing as the business or a platform it uses, look-alike domains, disguised
   links, the same words or link domain from many senders, floods of new requests from one sender, and
   senders the owner always puts aside. Three filters the owner switches on, each priced alike: **sales
   pitches**, **scams** and **junk**. Each reads known phrases on its own and, where a model is set up,
   with the AI check; one model call judges all three. Each starts with a **learning week** (anything it
   would put aside is only labelled); switching it off and on within thirty days does not restart it.
   Basic protection's point-based outcomes begin in a learning week from the day the migration runs.
2. **Four verdicts, never a refusal.** *Deliver*; *deliver with a label* (alerted, on Needs you, rules may
   only flag); *hold for proof* (bookings, orders and quote requests: no alert, rule, webhook, slot, pay
   link or drafted quote, and the acknowledgement still goes); *put aside* (messages only: kept, listed,
   explained, one tap back). Nothing the filter does bounces, deletes or answers differently. A booking,
   order or quote request is never put aside, at most held. A held request lapses by its own clock,
   silently.
3. **Strangers only.** Known customers — a strong match (ADR-017 §8.2) with a party the business acted
   on —, a proven mailbox, a trusted handle, anyone on Let through, replies on a thread, and everything
   the business makes are never screened and cost no model call. A trusted sender still gets the checks
   that point at a third party (a server mark, a look-alike, a disguised link, a change of bank details),
   as a label only.
4. **Doors.** The inbox's own form signs each form it draws (an id and an HMAC under the inbox's secret)
   and names its hidden field per form; a filled field puts a message aside and holds a booking, never
   drops it, and the visitor sees the same page whatever was decided, with a way to reach the business
   when it shows one. The form can be embedded on the business's own site, which alone may frame it. A
   key from before a change of secret only counts against a request. A website's own forms come in
   through `POST /v1/forms/submit`, with a key that holds `forms:submit` by name: a scope an AI app is
   never granted, that is refused everything else whether or not scopes are enforced yet. Email adds what
   the receiving server found (DMARC and aligned DKIM only take a point off; a failed check adds one), the
   display name, posing as the business, and answers that would go elsewhere. Agent doors add budgets
   per handle (§6) and a 429 past a ceiling, in the sender's language, with no reason given.
5. **"Confirm it's me".** Every acknowledgement to someone new with an email carries a link to confirm it
   is them, held or not, so being asked tells nobody anything. Opening it changes nothing; its button
   proves the mailbox and lets go a request held for an uncertain reason. A request held for a certain one
   (a trap, no key, a server mark, a wave, a block, like one marked spam) gets no acknowledgement at all,
   so a forged address is never written to. Create answers say where the link went:
   `identity.confirm.sent_to`, masked; the MCP text says so in words.
6. **Signals and deciding.** Certain signals decide alone; the rest are points (a label from 3, put aside
   from 6) with caps: a trusted sender only labelled; a pass lifts and keeps content at a label; Just
   label keeps a filter's verdicts at a label; the learning week labels. Character checks look only for
   disguise: language, script, country, address, name, email provider, spelling, length and "written by an
   AI" are never signals. Repeats count other senders only (prints: SHA-256 and a 64-bit SimHash over
   character 4-grams, in eight bands); a short honest question repeats freely. Per-handle budgets of new
   conversations a day: an agent key 5 (ceiling 50), a vouched key 15 (150), a pass 10 (50), a mailbox 5
   (30), a mail domain 20 (100); a pass widens its mailbox's and domain's.
7. **The AI check.** Behind `JudgePort`; the inbox ships a Messages API adapter on the provider's own SDK
   and a chat-completions adapter (any provider or a local model server). It runs for a stranger's first
   contact with a filter on, no certain signal, enough words and room under the caps. It is sent masked
   text only (addresses, phone numbers, bank and card numbers removed, links down to their domain), the
   sender's domain and never their address, inside a random boundary, with a fresh check value it must
   return; the answer is held to a JSON schema of enums, and no model sentence reaches anyone. Its quotes
   must be found word for word, or they are dropped, and two dropped make it unclear. It is one vote: it
   may put a message aside alone only with high certainty, a verified quote, no customer sign and past
   the learning week. Eight seconds an attempt, one retry after two, twenty in all; any failure lets the
   item through on its local signals.
8. **Words stay home.** Basic protection reads inside the inbox; only domain names leave, to the
   resolver the inbox already uses. The business's privacy page says, while a model may read, that an
   automated check can read new messages without addresses, numbers or bank details and keeps nothing.
9. **Hosted: our model, behind the ledger.** The model and its key live in the shard's environment only
   (`HOSTED_SPAM_MODEL_*`), never in a tenant's file, settings, policy, download, answers or logs, and a
   model key is redacted from every log line. The policy's `spam` block says whether our AI may read for
   an inbox, which filters it may switch on, its day and month caps, how Settings names who reads, and
   billing. Every check is reserved in the shared ledger before it is made: the inbox's day and month
   across every shard, and the runtime's own token budget for the day across every inbox; what a copied
   tenant file says it spent changes nothing. A policy without the block asks no model; a filter it
   withdraws is switched off as the inbox opens. On one's own server the operator sets `SPAM_MODEL_*`,
   and the owner's monthly checks cap applies.
10. **Metered per inbox and per filter.** `spam_days` counts, by UTC day, filter-days (a day a filter was
    on at any moment), AI checks, reuses, cap refusals, failures, tokens, and what was put aside, held,
    labelled, released and brought back. Once billing is on, a month costs, for each filter, its days on
    (at most thirty) at a day's price — the month's price over thirty, rounded up to a cent — and never
    more than the month's price; hosted usage reports the counts under `spam`. A request held or put
    aside is not in `items` until it is let in.
11. **Owners decide, in person.** Filters may carry a price: only the owner or staff, signed in, switch
    them, choose Put aside or Just label, end a learning week, let in, block, or let a domain through —
    never their AI, a rule or a key. The owner's AI may read `spam_status`.

### Amends ADR-026 §7

"The words are never judged" becomes: the words are judged only by filters the owner switched on. A
server's spam mark still puts a stranger's email aside as it arrives, keeping none of its files; from a
sender the business knows it only labels. Files of anything put aside or held stay shut until a person
brings it back.

### Built differently from the plan, and why

- **Decided at the door unless the AI check is needed.** Only a request that will be read by a model is
  written `pending`, with its owner alert, rules and webhooks deferred (a minute, ninety seconds for the
  acknowledgement) and a `spam_screen` job; everything else is decided in the create's own batch.
- **A mail domain's DNS** is looked up only in that job, cached thirty days.
- **Prints** use character 4-grams for every script (word shingles moved too much for one changed
  word), eight bands, and six bits for near.
- **An answer is lent to a near copy.** Beyond reuse for the very same text, an answer that found no
  customer is lent to a text a few bits from it from another sender this week, keeping only the quotes
  that text holds: a reworded run of five hundred costs a few dozen checks, not five hundred. A customer
  answer is never lent, so words sent first can vouch for nobody else.
- **Repeats from a vouched key or a pass** are not counted, and a booking's or order's repeats never make
  a wave: platforms send templated bookings for many real people.
- **No `screened` or `released` events**: the verdict lives in `spam_verdicts`, and the events view hides
  held items until they are let in.
- **The owner MCP** gets `spam_status` only: every other spam action is a person's in person, and would
  always refuse the AI.
- **`forms:submit`** is a key preset for now; the WordPress plugin's OAuth connection is not built.
- **A sixth booking in a day from one address** is held (`many_new`) but gets no acknowledgement that
  day (three acknowledgements an address a day): its sender cannot confirm it until the next one; the
  owner sees it under Held.

## Consequences

- No real customer is lost to a filter: the worst is a labelled, held or put-aside request, kept and
  explained, and every failure lets it through.
- A held request reads exactly as a delivered one, at the door, on every read and on the confirm page.
- Hosted inboxes can offer filters at a cost bounded per inbox and per runtime before any is charged.
- New tables: `spam_verdicts`, `spam_lists`, `spam_prints`, `spam_handles`, `spam_filter_spans`,
  `spam_days`, `spam_cache`, `spam_domains` (migration 0026), and the ledger's `judge_day` and
  `judge_total_day`. Erasing a customer removes their verdicts, prints, list rows and handles; the
  owner's download keeps verdicts, lists, spans and day counts.

## Not decided here (each ships off)

| # | Decision | Ships as |
|---|---|---|
| D1 | The price per filter, a bundle, a free first month | billing `off`, `price: null` |
| D2 | Our AI for hosted inboxes: provider and model, where it runs, retention, the terms | policy `spam.ai: false`: hosted filters read phrases only |
| D3 | Filters on by default for new hosted inboxes | off |
| D4 | Caps: 150 a day and 1,500 a month per inbox, 50 million tokens a day per runtime, the budgets above | as proposed, in the policy |
| D5 | Deleting put-aside items after 30 or 90 days | kept until cleared |
| D6 | A Spam tap also blocking the sender | offered, never automatic |
| D7 | Sharing anything across businesses | nothing shared |
| D8 | Spam data in receipts, standing or ranking | none of it |
| D9 | Naming the model's provider in Settings | generic line; the policy's `reader` may name it |
| D10 | The privacy page line, with counsel | shown only while a model may read |
| D11 | A browser challenge, operator link lists, a DNS blocklist feed | not built |
| D12 | Hosted owners bringing their own model key | off |
| D13 | Switching off filters of owners who do not agree to billing | off with billing |
