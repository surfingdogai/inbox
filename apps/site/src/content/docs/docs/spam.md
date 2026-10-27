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

A booking or an order is never put aside, at most held. A held booking holds no time: another customer can book and be confirmed for the same slot. A held request lapses by its own clock, silently.

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
| The three filters | | on from the start, each with its learning week |
| The AI check | | Claude Haiku from Anthropic, which we pay for |

The $10 supports the open-source inbox, the open network, and keeping access to AI agents from being locked in a connector store. There is no price for each filter.

Settings → Spam names who reads. Anthropic does not use what it is sent to train its models, and deletes it within 30 days, unless its safety checks flag it for breaking its usage policy (then it may keep it up to two years, and the checks' scores up to seven) or the law requires keeping it. That is Anthropic's standard commercial retention, not a zero-retention arrangement. Until the AI check is switched on for hosted inboxes, Settings says so, and the filters look for known phrases.

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

On Pro, each inbox has a day's and a month's room for AI checks (150 and 1,500 unless your host says otherwise), counted across every server, and the host has a daily ceiling for all inboxes together. When room runs out, Settings says until when the AI check rests, and the filters look for known phrases until then.

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
- Your **privacy page** gains a short "Keeping out spam" section while a model may read, and loses it when none may.

## Your emails and your phone

- **A morning email** at nine, your time, when something new was held: who, what they asked for, why, and a link to Held. Switch it off in Settings → Spam.
- **A summary on Mondays** at eight when something was put aside: how many, how many are held, and the three that looked most like customers.
- **Your phone** hears nothing of what is held or put aside, except once, with no name, of a booking request held for a time in the next 48 hours. It lists Held and Spam, and lets you press Let it in, Not spam or Spam. Filters are switched on the web, signed in.

## Your own AI

The owner MCP's `spam_status` reads the filters, this month's counts, who reads, the AI check's room and the lists. `list_items` with `screen: "held"` lists what waits; put-aside requests are listed when asked for, never by default. Switching a filter, letting something in and the lists are a person's, signed in: never your AI's, a rule's or a key's.

## Removing data

Erasing a customer removes the filter's verdicts on their requests, their prints, the AI check's answers about their words, their rows on the lists and their handles' history. A download of your inbox keeps the verdicts, the lists, when each filter was on and the day counts; never the prints, the handles, the cached answers, or your model's key.

**Keep what's put aside**: **Keep them** (the default), 90 days or 30 days. Nothing is deleted on its own, a bot's form messages included; nothing you brought back is ever removed.
