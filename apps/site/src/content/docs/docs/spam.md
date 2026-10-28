---
title: Spam filter
description: How the inbox keeps sales pitches, scams and junk off your desk without losing a customer, what it reads, what leaves your server and when, connecting your own AI model, and what a sender sees.
---

The inbox screens every request from someone new as it arrives, on every door: email, your own website, and AI agents. What is not from a customer waits under **Spam** or **Held** instead of on your desk, kept for as long as you choose, one tap back. You aren't alerted, except once on your phone for a booking held for the next two days.

Settings → **Spam**. The design is ADR-041 in the repository's `docs/adr`.

## What it never does

- It never refuses, bounces or deletes a request for what it says. The worst a request meets is being put aside or held, kept and explained, and its sender sees the same pages and answers as without a filter; a request held for a certain reason gets no acknowledgement (see [What the sender sees](#what-the-sender-sees)). A sender starting far more new requests in a day than a person would is asked to try again later.
- It never puts aside or holds someone you know: a customer you have answered, confirmed or let in, anyone on **Let through**, a reply in a conversation, and everything your business makes itself. A check that points at a third party (a change of bank details, a look-alike or disguised link) can still label them, and an address on Let through typed where nothing vouches for it is read like a stranger's, labelled at most.
- It never uses language, script, country, name, spelling, length, email provider, time of day or "written by an AI" as a reason. Checks on characters look for disguise and nothing else, such as a Cyrillic letter inside a Latin word.
- Whatever a filter does or fails to do, a request goes through: a check that times out, fails or runs out of room lets it in on what the free protection found.

## Four outcomes

| | You | Your rules, webhooks, phone | The sender |
| --- | --- | --- | --- |
| **Delivered** | alerted as usual | as usual | as usual |
| **Delivered with a label** ("May be a sales pitch") | alerted; on Needs you with a small chip | rules may flag it and do nothing more: nothing is confirmed, quoted, answered or asked for | as usual |
| **Held** (bookings, orders, quote requests) | listed under Held; a morning email if you want one | nothing runs; no time, stock or pay link is taken | as usual ("we have your request"), or nothing when a certain signal held it |
| **Put aside** (messages; a quote request for a certain reason, never otherwise) | listed under Spam with why | nothing runs | a message reads as open, one nobody answered yet; a quote request as received |

A booking or an order is never put aside, at most held. A held booking holds no time: another customer can book and be confirmed for the same slot. A held kitchen order takes no place in its slot or its dishes' daily count; let in, it takes them then, as a new order would, and where they are full by then it waits for a person instead of being accepted at once. A held request lapses by its own clock, silently.

Requests for a stay (rooms and nights) are not screened yet: they arrive as they would without a filter.

**Let it in** (Held) and **Not spam** (Spam) run what was held back, once: the rules and the webhooks. A request held for a bot's signal got no acknowledgement, and gets none after Let it in either. **Looks fine** takes a label off. Each is one press, with **Undo** for six seconds, and teaches the filter: that sender comes straight in from then on.

## Free protection, always on

On every door, on every inbox, with no AI:

- **Form bots**: your form's hidden field filled in (each form names it differently), a form your page never drew, one filled in faster than anyone types.
- **Mail a server marked as spam** on its way. From someone you know it labels, nothing more. An address makes someone known where something vouches for it (a mail server, a pass). Typed at a form, given to an assistant or on mail no server vouches for, it is read as a stranger's is, and labelled at most.
- **Posing as you**: your business's name from an address that isn't yours, an address made to look like yours, answers that would go elsewhere (Reply-To), a display name showing another address.
- **Disguised links**: a link showing one address and going to another; a link that hides where it goes (a bare network address, a name written before the site's).
- **Waves**: the same message, nearly the same message, or the same link from many senders this week. A short honest question repeats freely, and bookings worded the same way by a platform never make a wave.
- **Floods**: more new conversations in a day than a person starts. A sender is known by their agent's own key, their pass, their mailbox and their mail domain, never by their network address, and never by an AI platform's key, which signs for all of that platform's users. An address nothing vouched for (typed at a form, given to an assistant, on mail no server vouched for) is counted apart from the same address's signed mail and never gets anyone refused, and what a bot sent counts against nobody. A request that names nobody at all still counts in a wave.

Its point-based outcomes started with a learning week of their own, from the day your inbox was updated.

## Three filters

| Filter | Catches |
| --- | --- |
| **Sales pitches** | SEO, links and guest posts, sponsored articles, websites, apps, ads, leads, reviews for sale, social growth, loans, outsourcing |
| **Scams** | False invoices, changed bank details, account, domain, listing, legal or copyright notices, review threats, overpayment stories, prizes and jobs, sign-in links. A change of bank details from someone you know is labelled "Check before paying", never put aside |
| **Junk** | Random text, tests, link lists, adult, gambling, crypto and pharmacy promotion |

Each filter looks for known phrases on its own, in many languages, and reads with an AI model where one is set up (one reading judges all three). For each, choose **Put aside** or **Just label**.

On a hosted inbox the three filters come with **Pro**, and start on. On **Free**, basic protection keeps working, with no filters and no AI. On your own server you switch on the ones you want.

**Learning week.** For seven days from the day a filter is switched on (on Pro, the day Pro starts), it labels what it would have put aside and puts nothing aside ("Would have been put aside"). **Start now** ends it. Switching off and on within thirty days does not start it again. A filter you switch off stays off; one switched off because Pro ended comes back as it was when Pro does.

## How it decides

Certain signals decide alone: a hidden field filled in, a form never drawn, a server's mark, a sender you put aside, a wave, a message you marked as spam sent again, or one like it from the same sender. One like it from someone else adds points, nothing more, since assistants write many people's requests the same way. The rest add points: from 3 it labels, from 6 it puts aside or holds. Then each of these can lower the outcome, never raise it:

- someone you know is labelled at most;
- words that name your own services or products keep the outcome at a label;
- a network pass presented keeps what the words alone would do at a label;
- a filter on Just label, or in its learning week, labels;
- the AI check may put a message aside on its own when it is sure, quotes the message word for word, and found nothing a customer would ask; never otherwise.

Under **Why it's here**, an item says the strongest reason in a sentence, the others a tap away, the passages found ("It says: …"), and who decided: the spam filter, the AI check, a mail server, or you.

## The AI check: what is sent, and what never

It runs on a stranger's opening message, with a filter on, when nothing certain decided, the message has words enough, and there is room under the caps.

- **Sent:** the message's text with every email address, phone number, IBAN, account and card number, payment address and link taken out (a link is cut to its domain), in any script's digits, the subject and the sender's name masked the same way, the sender's domain (never their address), the domains its links go to, how many files it has, and your business's name, description, languages and the names of your services and products.
- **Never sent:** addresses, phone numbers, anything about other customers, your settings, attachments.
- **The free protection** sends nothing: what it reads stays on your server. With an AI check, never without one, a new sender's mail domain is looked up in DNS (at a public DNS-over-HTTPS resolver) to see whether it takes mail.
- The text sits between two random boundary lines, with a fresh value the answer must return. The answer is held to a schema of fixed choices; no sentence a model writes reaches you, a customer or your rules. Instructions inside a message change nothing, and a message that talks to an assistant or a filter is never delivered without a label.
- Eight seconds an attempt, one retry after two, twenty seconds in all; any failure lets the request through.
- The same text from another sender this week reuses the answer instead of asking again.

## Hosted: Free and Pro

| | Free | Pro: $10, €10 or £9 a month, taxes included |
| --- | --- | --- |
| Basic protection, Held and Spam, the lists, the emails | yes | yes |
| The three filters | no | on from the start, each with its learning week |
| The AI check | no | Gemini from Google (Gemini 3.1 Flash-Lite), which we pay for |
| [Known spam](#known-spam-shared-between-hosted-inboxes) from other businesses | labelled; your Not spam counts for them | labelled; your Spam and Not spam count for them |

The $10 supports the open-source inbox, the open network, and keeping access to AI agents from being locked in a connector store. There is no price for each filter.

**A Pro we give for free**, such as a beta tester's month, says so in Settings → Spam, with until when. Its filters are on and look for known phrases, and its AI check stays off until the owner turns it on there: turning it on says what it sends. The owner switches it, signed in, and nobody else.

Settings → Spam names who reads. We use Google's Gemini API from a Google Cloud project with billing on, so Google's [terms for paid services](https://ai.google.dev/gemini-api/terms) apply: Google does not use what it is sent to improve its products, and keeps it for [55 days](https://ai.google.dev/gemini-api/docs/usage-policies), only to detect and prevent misuse of its service and for disclosures the law requires; what its checks flag may be read by authorised Google staff. It may be stored for a while or cached in any country where Google has facilities. That is Google's standard retention for the paid Gemini API, not a zero-retention arrangement. Each check is sent with request logging off, so our own Google project keeps no log of it. Until the AI check is switched on for hosted inboxes, Settings says so, and the filters look for known phrases.

## Known spam, shared between hosted inboxes

Hosted inboxes share fingerprints of known spam with each other, never messages. A fingerprint is a set of hash values made from a message's text with its links, email addresses, phone numbers, bank and card numbers and every digit taken out, and the sender's company mail domain where a mail server vouched for the address (never a provider many people share). The host keys each value with a secret of its own before keeping or comparing one: a fingerprint can't be turned back into the message, and nobody without that secret can match one.

- **Compared.** Each new message from someone you haven't dealt with is compared, by its fingerprint, as it arrives. Senders you know, and requests a network's pass speaks for, are not looked up.
- **Known spam** is a message like one that three or more other hosted inboxes marked as Spam within a fortnight, or put aside on their own and were sure of: a bot's form, a server's mark, the same words from many senders, or the AI check sure of it with a passage it quotes. Inboxes count, not addresses: each counts once, however often its owner changes their email address, and none before its account is a week old.
- **A match labels** it ("Seen as spam at other businesses"), on Free and on Pro, with your filters on or off, and on its own does nothing more. It helps put a message aside when this inbox's own checks or its AI check found enough to label it without the match, adding its points to theirs, and never beside less; your filters' learning week, Just label, and the AI check finding a customer still lower it. It never holds a booking or an order, never deletes, never blocks a sender, and never counts in receipts, standing or ranking.
- **A sender's domain** known for spam counts for mail a mail server vouched came from it, never for an address typed at a form or given by an assistant, and adds a few points, labelling nothing alone.
- **Not spam**, Let it in or Looks fine on a match counts against it for everyone, from any hosted inbox, Free included. What a person marked, or what an inbox was sure of on its own, is reported; never what a match labelled or helped put aside, so the list never feeds itself.
- **Free and Pro.** Every hosted inbox reads the list: it costs no AI. Pro inboxes live at the business's own domain report spam to it, and no others, so marks can't be faked by the dozen. A Free inbox's Spam marks stay its own; its Not spam on a match counts, since that can never do more than let a message through.
- **Forgotten** thirty days after it was reported. Erasing a customer takes back what your inbox said of their messages.
- **On your own server** nothing is shared, and nothing others shared is read. A shared list may be offered for your own server later.

Settings → Spam says which of these your inbox does. Your privacy page says, in your name, that each new message is compared by its fingerprint, whether your inbox shares the fingerprints of what you mark as spam, and that a fingerprint can't be turned back into the message.

## Connecting a model

On a **hosted** inbox you connect nothing: on Pro the host's model reads, and you cannot bring your own key there yet.

On **your own server**, either:

- **Settings → Integrations → Your AI model**, the owner's own to set, signed in: choose Anthropic, OpenAI or Google Gemini, paste a key from your account (it is kept sealed under `INBOX_SECRET_KEY` and never shown again, nor downloaded), choose a model from the provider's own list (smaller models cost less and are enough here), and press **Test**: two samples go through, a sales pitch that should be spotted and a customer asking a price in Japanese who should come through. On Google's free tier, what you send may be used to improve its products: use a paid key.
- or the server's environment, which then shows as "Set by your server":

| Variable | |
| --- | --- |
| `SPAM_MODEL_API` | `messages` (the Messages API) or `chat` (any chat-completions API) |
| `SPAM_MODEL_URL` | for `chat`: the API's base, up to and without `/chat/completions`; a model on your own machine, such as `http://127.0.0.1:11434/v1` |
| `SPAM_MODEL_KEY` | the key, where the API needs one |
| `SPAM_MODEL` | the model's id |
| `SPAM_MODEL_NAME` | how Settings names it (optional) |

Without a model, the filters look for known phrases, and the free protection works the same.

**Most checks a month** (your own server): 500, 2,000 (the default), 10,000 or no limit. Your provider charges you for each check; Settings shows this month's checks and the model's time.

## Caps, on a hosted inbox

On Pro, each inbox has a day's and a month's room for AI checks (150 and 1,500 unless your host says otherwise), counted wherever your inbox runs, and the host has a daily ceiling for all the inboxes it runs together. When room runs out, Settings says until when the AI check rests, and the filters look for known phrases until then.

## The lists

- **Let through**: people you marked Not spam, let in or said looks fine. A company's domain can be added from the toast ("Let everyone at {domain} through"); a provider many people share never can.
- **Always put aside**: senders you chose to put aside after pressing Spam. It is never automatic, and a domain is never blocked by inference.

Settings → Spam lists both; each row has **Remove**.

## Your own website's forms

- **The inbox's own form**, on any site: put it in a frame. It carries no script and no puzzle, and no site but your own (the address in your profile or Settings → Be found) may frame it.

  ```html
  <iframe src="https://inbox.yourdomain.com/p/message?embed=1" title="Write to us"
          style="width:100%;min-height:640px;border:0"></iframe>
  ```

  `/p/quote?embed=1` and `/p/book?embed=1` work the same way. Each form is signed as it is drawn, so one sent without opening it is known.

- **Your site's own forms**: make a key with **Website forms** (Settings → Keys). It may do one thing, and it is never given to an AI app: `POST /v1/forms/submit` with what the visitor sent.

  ```json
  {
    "form": "contact",
    "page": "https://yourdomain.com/contact",
    "fields": { "name": "Mei Lin", "email": "mei@example.org", "message": "Do you deliver on Sundays?" },
    "visitor": { "ip": "203.0.113.7", "user_agent": "Mozilla/5.0 …" },
    "signals": { "trap_filled": false, "elapsed_ms": 48000 }
  }
  ```

  It arrives as a message, screened as one sent through the inbox's own form. Each visitor is limited by their own address, the same submission sent twice is one message, and the answer is the same whatever the filter decides.

The inbox's WordPress plugin points AI agents at your inbox. It does not pass your form plugin's messages on yet: until it does, a developer can send them to the forms door as above.

## What the sender sees

The same page after sending, the same answers to their assistant and the same status when they look again as without a filter. A held request reads as received, byte for byte. What differs is below: a request held for a certain reason gets no acknowledgement.

- **Confirm it's me.** Every new customer's acknowledgement (bookings, orders, quote requests) carries one more line and a button: "Please confirm it's you, so we know your request reached the right person." Pressing it proves their address and, if their request was held for an uncertain reason, lets it in. Their later requests are screened as before, with more room for new ones in a day; a sender becomes known when you press Let it in or Not spam. A request held for a certain reason (a bot's form, a server's mark, a wave) gets no acknowledgement at all, so a forged address is never written to.
- **An assistant's answer** says where that email went (`identity.confirm.sent_to`, masked) — see [Getting your person's request seen](/for-agents.md).
- **Too many new requests** from one agent: `429` with `Retry-After`, and a line in the sender's language, with no reason given.
- Your **privacy page** gains a short "Keeping out spam" section while a model may read, or while your hosted inbox reads the shared list of known spam, and loses it when neither is so.

## Your emails and your phone

- **A morning email** at nine, your time, when something new was held: who, what they asked for, why, and a link to Held. Switch it off in Settings → Spam.
- **A summary on Mondays** at eight when something was put aside: how many, how many are held, and the three that looked most like customers.
- **Your phone** hears nothing of what is held or put aside, except once, with no name, of a booking request held for a time in the next 48 hours. It lists Held and Spam, and lets you press Let it in, Not spam or Spam. Filters are switched on the web, signed in.

## Your own AI

The owner MCP's `spam_status` reads the filters, this month's counts, who reads, the AI check's room and the lists. `list_items` with `screen: "held"` lists what waits; put-aside requests are listed when asked for, never by default. Switching a filter, letting something in and the lists are a person's, signed in: never your AI's, a rule's or a key's.

## Removing data

Erasing a customer removes the filter's verdicts on their requests, their prints, the AI check's answers about their words, their rows on the lists and their handles' history, and takes back what your hosted inbox told the shared list of known spam about their messages. A download of your inbox keeps the verdicts, the lists, when each filter was on and the day counts; never the prints, the handles, the cached answers, or your model's key.

**Keep what's put aside**: **Keep them** (the default), 90 days or 30 days. Nothing is deleted on its own, a bot's form messages included; nothing you brought back is ever removed.
