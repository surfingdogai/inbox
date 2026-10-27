# ADR-041 — Spam filters

**Status:** proposed, 24 October 2026. The core pipeline, its signals, the AI check behind a port, every
door, the hosted plumbing, the metering, the owner app's screens, the owner's two emails, the phone app
and the site's pages are built and tested; the WordPress plugin's connection is not yet. The founder
decided the open business questions on 27 October 2026; the table at the end says how each ships. Known
spam shared between hosted inboxes (D7) is built as §16 says. Stay requests are not screened yet (§17).
Amends ADR-026 §7 and the inbox's own form (§4).

## Context

An inbox that agents and strangers can write to gets unwanted mail: sales pitches (search ranking,
links, websites, leads), scams (false invoices, changed bank details, account notices), junk, and form
bots. Today the inbox drops a filled hidden field on its own form, puts aside an email a server marked as
spam, and judges no words at all. Owners want the pitches and scams kept off their desk, and above all
they must never lose a real customer to a filter, whatever language, script or country that customer
writes from.

The decided pricing (27 October 2026, replacing a cost per inbox × filters switched on): *a hosted
inbox is on Free or Pro. Free keeps basic protection, with no AI. Pro, $10, €10 or £9 a month with
taxes included, includes the three filters, read by our AI, which we pay for. There is no price for
each filter.*

## Decision

1. **Free protection and three filters.** Basic protection is always on, on every door, and needs no AI:
   form bots (a filled hidden field, a form never drawn, one filled faster than anyone types), mail a
   server marked, senders posing as the business or a platform it uses, look-alike domains, disguised
   links, the same words or link domain from many senders, floods of new requests from one sender, and
   senders the owner always puts aside. Three filters: **sales pitches**, **scams** and **junk**. On
   one's own server the owner switches them on; on a hosted inbox they come with Pro and start on. Each reads known phrases on its own and, where a model is set up,
   with the AI check; one model call judges all three. Each starts with a **learning week** (anything it
   would put aside is only labelled); switching it off and on within thirty days does not restart it.
   Basic protection's point-based outcomes begin in a learning week from the day the migration runs.
2. **Four verdicts, never a refusal.** *Deliver*; *deliver with a label* (alerted, on Needs you, rules may
   only flag); *hold for proof* (bookings, orders and quote requests: no alert, rule, webhook, slot, pay
   link or drafted quote, and the acknowledgement still goes); *put aside* (messages only: kept, listed,
   explained, one tap back). Nothing the filter does bounces, deletes or answers differently. A booking,
   order or quote request is never put aside, at most held. A held kitchen order (ADR-040) takes no
   place in its slot or its dishes' daily caps; let in, by a person or by its sender's confirmation, it
   takes them then under the rules a new order meets, and where one is full by then it takes none of
   that one and waits for a person (`over_cap`) instead of being accepted at once: never past what the
   kitchen set aside. A held request lapses by its own clock, silently. Its sender reads what was put aside as one nobody answered yet: a message open, a quote
   request received (then expired as its request lapses), with that state's own actions and "waiting on
   us".
3. **Strangers only.** Known customers — a strong match (ADR-017 §8.2) with a party the business acted
   on —, a handle a person trusted, anyone on Let through, replies on a thread, and everything the
   business makes are never screened and cost no model call. A mailbox its sender proved is still a
   stranger's: pitchers use real mailboxes because they want replies. An address on Let through, or a
   mailbox a person trusted, makes a request known only where something vouched for the address (mail
   a server authenticated with DMARC or aligned DKIM, a pass that proved it): typed at a form, given to an
   assistant or on mail nobody signed, it is read as a stranger's is, since anyone can type it, and only
   ever labelled, since a person let it through. A trusted sender
   still gets the checks that point at a third party (a server mark, a look-alike, a disguised link, a
   change of bank details), as a label only; a request of theirs under an address nothing vouched for is
   also labelled for a failed DMARC and for a scam's phrases, since it may not be theirs.
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
   proves the mailbox and lets go that one request if it was held for an uncertain reason. Their later
   requests are screened as before, with budgets three times as wide; a proof made after anything from
   that mailbox was marked spam widens nothing. Only a person's Let it in or Not spam makes a sender known. A request held for a certain one
   (a trap, no key, a server mark, a wave, a block, a message like one marked spam: that very text, or
   one from the sender it was marked for) gets no acknowledgement at all,
   so a forged address is never written to. Create answers say where the link went:
   `identity.confirm.sent_to`, masked; the MCP text says so in words.
6. **Signals and deciding.** Certain signals decide alone; the rest are points (a label from 3, put aside
   from 6) with caps: a trusted sender only labelled; a pass lifts and keeps content at a label; Just
   label keeps a filter's verdicts at a label; the learning week labels. Character checks look only for
   disguise: language, script, country, address, name, email provider, spelling, length and "written by an
   AI" are never signals. Repeats count other senders only (prints: SHA-256 and a 64-bit SimHash over
   character 4-grams, in eight bands); a short honest question repeats freely. A text near one marked
   spam from another sender adds points (4), never decides alone, and a booking's or an order's like one
   marked holds it at most, never certain: assistants write many people's requests the same way. Per-handle budgets of new
   conversations a day: an agent's own key (`Sdi-Agent-Key`) 5 (ceiling 50), a pass 10 (50), a mailbox 5
   (30), a mail domain 20 (100); a pass widens its mailbox's and domain's. A platform's key (Web Bot
   Auth's `Signature-Agent`) signs for every one of its users, so it is no sender, whether a network
   recognises the platform (`vouched`) or not: it never makes a request wait on its own, is on no list,
   is trusted by nobody, and only a flood of 1,500 new conversations a day (500 for a platform nobody
   recognises) answers 429; its users are counted by their own mailbox, pass or carried code, and the
   same words sent under it still make a wave. A request that names nobody (no mailbox, no key of its own, no
   pass) is a sender of its own for repeats, so unsigned copies of one pitch still make a wave. A request
   under an address nothing vouched for (mail no DMARC pass or aligned DKIM vouched for, a form, an
   assistant no pass proves it for) is counted apart from that address's vouched mail, and what is
   counted there makes a request wait but never refuses one; a request a certain bot signal decided (a hidden field, a form never drawn, a
   server's mark, a wave, a block), or one that what a bot did at the form puts aside alone (a forged
   key sent in a moment), counts against nobody, so forgeries never spend a real sender's budget. The AI
   check finding a customer takes its points off what the filters found, never off the free
   protection's, and a filter on Just label or learning only lowers what its own points were needed
   for: a filter switched on only ever puts more aside. A link to the business's own site, a platform it
   uses or a host everyone links to (a map's share link, a profile, a drive, a booking or review site's
   page; the big sites on the country domains they run too, never their name on a domain anyone may
   register) makes no message "only links"; shorteners are known by their full host, and count in a
   shared link domain like any other. On a shared host, one chat number, channel, site, shared document
   or form there (`wa.me/…`, `t.me/…`, `docs.google.com/forms/…`) counts as a shared link domain would,
   kept as a keyed hash. Words aimed
   at an AI count in the sender's name as in the text, and need an addressee or a verdict dictated; a
   name of the business's own offer may carry a short ending ("classes") or Korean particles.
7. **The AI check.** Behind `JudgePort`; the inbox ships a Messages API adapter on the provider's own SDK
   and a chat-completions adapter (any provider or a local model server). It runs for a stranger's first
   contact with a filter on, no certain signal, enough words and room under the caps. It is sent masked
   text only (addresses, phone numbers, bank, account and card numbers and payment addresses removed,
   in any script's digits and letters with their marks, in full-width forms, two numbers written one
   after the other each on its own, links down to their domain, characters drawn as nothing taken out), the subject and the sender's name masked the same way, the sender's domain and
   never their address, inside a random boundary, with a fresh check value it must
   return; the answer is held to a JSON schema of enums, and no model sentence reaches anyone. Its quotes
   must be found word for word, or they are dropped, and two dropped make it unclear. It is one vote: it
   may put a message aside alone only with high certainty, a verified quote, no customer sign and past
   the learning week. Eight seconds an attempt, one retry after two, twenty in all; any failure lets the
   item through on its local signals.
8. **Words stay home.** Basic protection reads inside the inbox; only domain names leave, to the
   resolver the inbox already uses. The business's privacy page says, while a model may read, that an
   automated check can read new messages without addresses, numbers or bank details. Where the host's
   model reads (D2) it adds what Anthropic's API does with them, as its terms say: no training on them,
   deleted within 30 days unless its safety checks flag them (then up to two years) or the law
   requires keeping them. It never says a service keeps nothing, and says nothing of what a model the
   business set up itself keeps.
9. **Hosted: Free and Pro, our model behind the ledger.** The policy's `plan` (`free` or `pro`; absent,
   or a plan the runtime does not know, is Free) says what the inbox has. Pro: the three filters, on
   from the start (D3), read by Claude Haiku (`claude-haiku-5-5`) on our own Anthropic key. Free: no
   filters and no AI; basic protection is the same on both. The key lives in the shard's environment
   only (`HOSTED_SPAM_ANTHROPIC_KEY`; `HOSTED_SPAM_MODEL` may name another model), never in a tenant's
   file, settings, policy, download, answers or logs, and a model key is redacted from every log line.
   Without it no model is asked, and Settings says the AI check isn't on yet. The policy's `spam` block
   keeps what the control plane may still set: `ai: false` stops our AI for an inbox, and the day and
   month caps (150 and 1,500 unless it says otherwise). Every check is reserved in the shared ledger
   before it is made: the inbox's day and month across every shard, and the runtime's own token budget
   for the day across every inbox; what a copied tenant file says it spent changes nothing. A hosted
   inbox takes no owner's own key; a filter its plan no longer includes is switched off by the system
   as the inbox opens, and comes back as it was if the plan does. On one's own server the operator sets
   `SPAM_MODEL_*`, and the owner's monthly checks cap applies.
10. **Metered per inbox, charged by nothing.** `spam_days` counts, by UTC day, filter-days (a day a
    filter was on at any moment), AI checks, reuses, cap refusals, failures, tokens, and what was put
    aside, held, labelled, released and brought back; hosted usage reports the counts under `spam`, for
    what Pro costs to run. Nothing is charged by them: Pro includes the filters. A request held or put
    aside is not in `items` until it is let in.
11. **Owners decide, in person.** What reads a stranger's words is the owner's choice: only the owner or
    staff, signed in, switch the filters, choose Put aside or Just label, end a learning week, let in,
    block, or let a domain through — never their AI, a rule or a key. The model's key decides where strangers' messages are sent: the
    owner alone sets, replaces or removes it, as for anything that sends data somewhere new. The owner's
    AI may read `spam_status`.

### Known spam, shared between hosted inboxes (§16, D7)

Decided 27 October 2026: inboxes share fingerprints of known spam with each other, never content.

1. **The fingerprint.** MinHash (thirty-two functions, eight bands of four) of the character 4-grams of
   the text, masked as the AI check's is (addresses, phone numbers, bank, card and payment numbers), with
   links masked whole, with or without a scheme, normalised as prints are, and every run of digits one
   `#`; under 100 characters or 50 distinct pieces, none. With it, the sender's registrable company mail
   domain, only where a mail server vouched for the address (DMARC or aligned DKIM): never a provider many
   share, nor a throwaway one. The inbox hands the raw bands to its host's `SharedSpamPort` and keeps none.
2. **Keyed by the host.** The hosted runtime keys every band, the domain, the owner (the control plane's
   `owner_account.id`, else the inbox's own tenant id: never the owner's address, which an owner can
   change, so each new one would mint a reporter), the inbox (its tenant id) and the item (inbox and
   item) with HMAC-SHA256 under a key derived from the ledger's, and keeps them in the ledger every shard
   opens (`spam_share_owners`, `spam_share_reports`, `spam_share_bands`). No tenant file, policy, download or answer holds the key or
   a fingerprint, and nothing kept can be turned back into a message or matched without the key. Two
   fingerprints match when they share two bands of eight: a copy with other links, numbers and addresses
   shares all eight, one reworded a little most of them, one on the same topic none.
3. **Counting.** A fingerprint is known spam for an inbox once the reports of three reporters or more
   fall within one fortnight, less one for every reporter who said Not spam on a match of it. A reporter
   is an inbox of a distinct owner: the count is the fewer of the distinct owners and the distinct
   inboxes, the reading inbox's own and its owner's never among them, so one account's several inboxes
   count once, and so does one inbox whatever owner it names. A report is kept only from an owner whose
   account was a week old when they made it: as old as the policy's `owner_account.created_at`, else as
   old as this runtime's first opening of the inbox. Everything is forgotten thirty days after it was
   reported. A sender's domain is known the same way, from the reports that named it.
4. **What is reported**, by a `spam_share` job that reads the item as it is when it runs: a person's Spam;
   or what the filter put aside on its own and is sure of (a certain `trap`, `no_key`, `server_marked` or
   `wave`, or the AI check's high certainty with a verified quote and no customer sign), past any learning
   week. A person's Not spam, Let it in or Looks fine on an item a shared match labelled is a word against
   it; any other later word takes back what the inbox said. Never what the owner's Always put aside, a
   look-alike, or points (a shared match's among them) put aside: the list never feeds itself. Erasing a
   customer queues the job for their items, and it takes back what was said.
5. **What a match does** (the founder's rule, 27 October 2026: a shared match can never on its own put a
   message aside or hold a booking or an order). `shared_spam` is 3 points, never certain: a label
   ("Seen as spam at other businesses") on Free and Pro, with the filters on or off. It counts under the
   filter most reporters named (Junk when none did) when that filter is on, so its learning week and Just
   label apply, else under the free protection; either way the AI check finding a customer takes it off,
   as it does a filter's points, and the business's own offer named lowers it. `shared_domain` adds 2
   points and labels nothing alone, and counts only for mail a mail server vouched for (DMARC or aligned
   DKIM): an address typed at a form or given by an assistant names no domain, neither looked up nor
   reported. In `decide`, where the shared points are needed to reach the aside band, the band stays a
   label unless a signal of this inbox's own checks or of the AI has points of its own; on a booking or
   an order the shared points never hold it at all, since assistants write many people's notes alike.
   A quote request, which its sender can confirm, may be held by the two together. Known senders are
   never looked up, nor requests a pass or a vouched platform speaks for, as for repeats; a lookup that
   fails is no match. Never a deletion, a block, a refusal, or anything in receipts, standing or ranking.
6. **Free and Pro.** Every hosted inbox reads the list: a lookup costs no AI. Only a Pro inbox live at the
   business's own domain, and not read-only, reports known spam (`contributes`): marks that cost a plan
   and a domain each can't be faked by the dozen, which with the week and the three reporters keeps the
   list hard to poison. Every inbox that is not read-only, Free too, reports its Not spam on a match
   (`disputes`), decided simply on 27 October 2026: a word against a match can only let more through, so
   it needs no plan. Its cost, accepted: Free inboxes made to dispute one pitch can lower it for everyone,
   which errs toward delivering. A Free inbox's Spam marks stay its own.
7. **Said plainly.** Settings → Spam (`status.shared`: `off`, `reads`, `reads_and_shares`) says what the
   inbox does. The business's privacy page says, as the business and naming no product, that each new
   message from someone it hasn't heard from is compared by its fingerprint with those of messages other
   businesses marked as spam, and that a fingerprint can't be turned back into the message, in one of
   two wordings: an inbox that reads (`reads`) shares no fingerprint of what it marks as spam and says
   so, only a word when a match wasn't spam; one that contributes (`reads_and_shares`) shares those of
   what it marks, and of matches that weren't. The hosted processing agreement and the owner's privacy
   notice say so too.
8. **One's own server** has no port: nothing is shared, and nothing others shared is read. A shared list
   may be offered there later, behind the same port.
9. **Per machine, for now.** The ledger is one SQLite file per machine, opened by its shards. The shared
   list and the runtime's daily token ceiling (D4) live there, so they are per runtime: with a
   second machine each keeps its own list and its own ceiling, and inboxes on different machines share
   nothing. An inbox's day and month caps hold, since an inbox runs on one machine at a time. Moving
   both to the control plane comes before a second machine.

### Not screened yet (§17)

Stay requests (ADR-037) are not in `SCREENED_TYPES`: they arrive as they would without a filter, safe but
unfiltered. Screening them needs more than a type in a set: a request held like a booking with its
hold on nights label-only, the held-soon push and phone payload for an arrival within 48 hours, "Confirm
it's me" in the stay acknowledgement in its six languages, Held's words for a stay, and tests for each.
It is left for its own change.

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
- **Undo sends nothing.** Let it in, Not spam, Looks fine and Spam wait six seconds on the owner's
  screen before they are sent, so Undo leaves no trace anywhere (no list, no print, no rule run);
  another press, an answer to the item, leaving the inbox or closing the page sends what waits at once,
  and on the phone leaving the item or the app going to the background; nothing else does. The
  follow-up a toast offers (a company's domain through, a sender always aside, another time) sends the
  act first. A Let it in that an answer already did is done, with nothing said; the toast sits above
  an item's action bar.
- **Spam lists everything put aside**: `state: spam` on the owner's list also takes what the filter put
  aside, including a held booking a person sent there, which keeps its own state. Each listed row carries
  the filter's summary (chip, cause, certain, may be a customer, who sent it), and Held lists what may
  be a customer first: the AI check found one or wasn't sure, held only for many new requests, or its
  words name the business's own offer and nothing certain held it.
- **The owner's own model** on one's own server is kept in `spam_model` (one row, the key sealed under
  `model-key`, never downloaded); the provider calls are the host's (`ModelKit`): the Messages API on
  the provider's own SDK, and chat completions for the other two. The model list is the provider's own.
  A hosted inbox, or a server with `SPAM_MODEL_*` set, takes none.
- **The owner's two emails** (`spam_held_digest`, `spam_weekly`) are scheduled by the quarter-hour
  sweep at their hour in the business's time, one job a day and one a Monday, and decide as they run.
- **The phone** reads the filter at `/v1/phone/spam` and may switch the two emails there; filters are
  switched on the web. A held booking for a time within 48 hours queues one notification, only where a
  phone listens, and only while it is still held; it never names the sender or says their words,
  whatever the phone shows of others.
- **Spam is never red** in the owner app or the phone: Mark as spam and the Spam state are in ink.

## Consequences

- No real customer is lost to a filter: the worst is a labelled, held or put-aside request, kept and
  explained, and every failure lets it through.
- A held request reads exactly as a delivered one, at the door, on every read and on the confirm page.
- What Pro's AI check costs us is bounded per inbox and per runtime, whatever an inbox's file says.
- New tables: `spam_verdicts`, `spam_lists`, `spam_prints`, `spam_handles`, `spam_filter_spans`,
  `spam_days`, `spam_cache`, `spam_domains` (migration 0033), and the ledger's `judge_day`,
  `judge_total_day` and `judge_told` (the control plane is told once per cap, inbox and day) and
  `spam_share_owners`, `spam_share_reports` and `spam_share_bands` (§16), made as a shard opens it. Erasing a
  customer removes their verdicts, prints (every screened request has one, whoever it names), the AI
  check's cached answers for their words, list rows and handles; handles nobody trusted are pruned
  after a month unseen. The owner's download keeps verdicts, lists, spans and day counts.

## Decided, 27 October 2026

| # | Question | The founder's decision, and how it ships |
|---|---|---|
| D1 | The price per filter, a bundle, a free first month | No price per filter. Free keeps basic protection; Pro ($10, €10 or £9 a month, taxes included) includes the three filters. The policy's `plan`; Settings, the docs and the site say so, with what the $10 supports. The hosted terms' price section ("free during the pilot") is the billing change's to rewrite to Free and Pro; this one leaves it as it is, and the site ships with both. |
| D2 | Our AI for hosted inboxes: provider and model, where it runs, retention, the terms | Claude Haiku (`claude-haiku-5-5`) through Anthropic's API on our own key, `HOSTED_SPAM_ANTHROPIC_KEY`: off, and said so, until it is set. Anthropic's standard commercial retention applies (no training; deleted within 30 days unless flagged under its usage policy, then up to two years, or kept by law); never "keeps nothing". The processing agreement names Anthropic as a sub-processor. |
| D3 | Filters on by default for new hosted inboxes | On for Pro, each starting with its learning week (labels only, then puts aside). Nothing is deleted automatically; Not spam is one tap. A filter a person switched off stays off. |
| D4 | Caps: 150 a day and 1,500 a month per inbox, 50 million tokens a day per runtime, the budgets above | Kept, in the policy's `spam` block. |
| D5 | Deleting put-aside items after 30 or 90 days | Kept ("Keep them") unless the owner chooses 90 or 30 days. Nothing is deleted on its own (27 October 2026): a bot's form messages, once gone after seven days, are kept like the rest. |
| D6 | A Spam tap also blocking the sender | offered, never automatic |
| D7 | Sharing anything across businesses | Inboxes share fingerprints of known spam with each other, never content (§16): keyed MinHash fingerprints in the hosted ledger, known once inboxes of three other owners (the control plane's account id, else the tenant id; never an address) with week-old accounts reported one within a fortnight, less every Not spam on a match, forgotten after thirty days. Per machine for now. Every hosted inbox reads; Pro inboxes live at their own domain report spam; every inbox, Free too, reports Not spam on a match. Off on one's own server. |
| D8 | Spam data in receipts, standing or ranking | none of it |
| D9 | Naming the model's provider in Settings | Named plainly: "Claude Haiku, by Anthropic". |
| D10 | The privacy page line | Shown while a model may read, or while the inbox reads the host's shared list of known spam. For our model, Anthropic's retention as above; for the shared list, that each new stranger's message is compared by fingerprint, in two wordings: an inbox that only reads, and one whose Spam marks are shared too. |
| D11 | A browser challenge, operator link lists, a DNS blocklist feed | not built |
| D12 | Hosted owners bringing their own model key | later; off |
| D13 | Switching off filters of owners who do not agree to billing | Gone with the per-filter price: Free has no filters, and the plan switches them off as the system. |
| D14 | Beta testers | Pro free for a month with no card: the control plane's admin setting per inbox, with an end date. The inbox reads only `plan`, `pro` until the control plane says `free`. |
| D15 | A shared match deciding on its own | Never: it labels ("Seen as spam at other businesses"), and adds its points only beside a signal of the inbox's own or the AI's; it never holds a booking or an order. A known spam domain counts only for mail a mail server vouched for (§16.5). |
| D16 | Free inboxes' Not spam on a shared match | Counts against the match, like any inbox's (§16.6). |
