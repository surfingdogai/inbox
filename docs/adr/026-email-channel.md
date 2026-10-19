# ADR-026 — The email channel: the business's own addresses, forwarded in, answered from its own domain

**Status:** accepted, 19 October 2026; built the same day. Amends ADR-005 (the hosted sender's Reply-To).

## Context

ADR-005 gave every inbox an email door (`POST /v1/email/inbound`, raw MIME) and a sender. Two things were
missing for a small business that already has an address its customers know (support@ its domain, or a
Gmail):

- **Its existing mailbox could not feed the inbox.** There was no address to forward to, nothing told the
  owner whether forwarding worked, and a provider's forwarding confirmation (Gmail's, Zoho's) arrived as a
  "customer message" or not at all.
- **Replies had nowhere good to go.** A hosted inbox writes from `<slug>@<our mail domain>`, which takes no
  mail. The proposed fix — Reply-To the owner's sign-in address — would have shown customers the owner's
  personal address and taken their answers out of the inbox. It was not shipped.

Businesses expect it the way Intercom does it: forward your existing address into the inbox's own
address, send from your domain when it authorises us, have replies come back into the same conversation,
and let the owner answer notifications by email.

## Decision

1. **Every inbox has an address of its own** (`settings.email.inboundAddress`).
   - Hosted: `<slug>@in.<parent>`, set by the host (the policy's `mail.inbound`) and locked. Email Routing
     on the inbound domain hands every message to the email gateway Worker, which posts it, signed, to the
     hosted router (`POST /v1/inbound/<slug>` on `HOSTED_INBOUND_HOST`, HMAC under `HOSTED_INBOUND_KEY` as
     every internal call is signed, the envelope and the receiving server's verdict in the signed query).
     The router finds the inbox by its slug and hands the message to its shard; the shard takes it in
     through the same code as every other email door. An inbox takes email at every level (an owner sets
     forwarding up before going live); a suspended inbox's email is held (a temporary failure, retried for
     days), a closing or closed one refuses it as an unknown one is refused. The router reads nothing of a
     delivery before its signed headers have the right shape and time and its length fits; it reads at
     most four at once. `postmaster@` and `abuse@` on the inbound domain go to our own inbox.
   - On one's own server: the address the operator's mail routing delivers to the inbox — Email Routing to
     the Worker, or a provider's inbound webhook to `POST /v1/email/inbound` — written in Settings → Email.
   - **Not built:** pulling a mailbox over IMAP as a connector. It is the third way in for a self-hosted
     inbox with no routing of its own; until it exists, such an inbox forwards to an address that is
     routed to it.

2. **Forward your existing address** (Settings → Email). The owner adds the address and its provider
   (detected from the address and its MX records; a chooser, never typed: Gmail, Google Workspace,
   Outlook.com, Microsoft 365, iCloud Mail, Yahoo Mail, Proton Mail, Fastmail, Zoho Mail, IONOS, GoDaddy,
   Hostinger, OVH, cPanel, another provider), and gets that provider's steps with the inbox's address
   in them, starting with "forward only the address customers write to" (a filter or a rule when it
   shares a mailbox with the owner's own mail).
   - **The provider's confirmation is shown, never acted on.** Only a known provider's own sender counts:
     Google's exact address (`forwarding-noreply@google.com`), and the domains Zoho, Yahoo, Proton and
     Fastmail send from; when the receiving server said what it found, only one it found to be from that
     domain (DMARC pass, or a DKIM signature of it). Anything else that looks like a confirmation is an
     ordinary email. A link is shown only for Gmail and only on `mail-settings.google.com`; for every other
     provider the code is shown, never a link. It is named by its sender, not by the provider the owner
     picked. Only an address whose check never came back takes one, one already shown is never written
     over, and one for an address not added yet is held a day and shown once the owner adds it.
   - **A live check.** "Check forwarding" emails the business's own address at its plus form
     (`support+c…@shop.example`) and watches for it to come back through the forward (its token in
     `X-Inbox-Check`, its address or its subject). Back: the forward works. Plus addresses work only when a
     token sent to the plus address came back for that plus address: each token keeps where it went, so a
     late plain check proves nothing about plus. Not back in three minutes: one goes to the plain address.
     Not back in three more: "not arriving yet". Only a check says a forward works: an address named in an
     email's headers is written by its sender and proves nothing. Checking also clears a confirmation the
     owner has dealt with. At most twelve check emails an inbox a day and three checks an address,
     counted from what was sent (removing and adding an address again starts nothing afresh); a hosted
     inbox's host counts them too, against the inbox and against the recipient's daily cap.

3. **Who replies go out from.**
   - Hosted, by default: `<slug>@<our mail domain>` in the business's own name, Reply-To the conversation's
     address (§4). The policy's own Reply-To, kept for older control planes, is dropped when it is the
     owner's sign-in address.
   - Hosted, from the business's own address, when its domain authorises us: the owner chooses an address
     that forwards here and passed its check (that proves the mailbox is theirs; the inbox's own domain is
     proven by its CNAME). The control plane asks the sending service for the domain, shows the exact DNS
     rows — three DKIM CNAMEs, and an MX and an SPF TXT on a bounce subdomain (`sdmail.<domain>`), never the
     domain's own SPF record — with the steps of the provider its name servers name, checks them live, and
     switches the sender once the service has verified the domain. Until then, and if it stops checking
     out, mail goes from our address. If the service stops sending for it (the domain gone, the account
     paused), that email and the ones after go from our address and the control plane is told, so it
     moves the sender to failed. The service's bounce and complaint events suppress the recipient for every
     inbox and, past a threshold, stop the tenant's own-domain sending or pause its mail. Shards hold a key
     that may only send; only the control plane holds the one that adds and removes domains.
   - **Research: Cloudflare Email Sending cannot sign for a customer's domain.** It sends only from domains
     onboarded on the sending account, which must be zones on that account (at most 30 sending or routing
     domains per zone). A business's own domain is not, and Cloudflare for SaaS does not change that. So a
     business's own domain is sent through **Amazon SES** in an EU region (Easy DKIM: three CNAMEs SES
     rotates itself; a custom MAIL FROM so SPF aligns too). Considered: Postmark (no EU data region),
     Resend (keeps data in the US even on its EU sending region), Mailgun EU (a monthly minimum), signing
     DKIM ourselves and relaying raw mail (still needs a relay that sends for any domain: SES again).
     The transport is `sesMailOut` (SES API v2, raw MIME, SigV4 on Web Crypto: no SDK).
   - On one's own server: as before, the operator's mail service (`MAIL_FROM`), whose own DNS rows sign for
     the domain.

4. **Every email carries a conversation's own address.** The item's token (`t` and 16 characters of
   lower-case base32, 80 random bits, kept in `mail_tokens`) after a plus: `name+t…@domain`, as Reply-To on
   every email to the customer. When a forward of the business's own proved plus addresses arrive, the
   conversation's address is the business's (`support+t…@shop.example`), so the customer only ever sees its
   domain; otherwise the inbox's. A reply lands on its item by that token whatever the customer's mail
   program kept; In-Reply-To and References (the item's anchor) still work as before. The older ways in —
   the item's id in a plus address or a subject — join a thread only from the customer's own address now:
   an item's id is not a secret. A hosted sender takes a message's Reply-To only when it is such an
   address on the inbox's domain or the business's connected one: the inbox never makes one on another
   domain (a Gmail address), and one that reaches the sender anyway is moved onto the inbox's own address
   with its token. The Reply-To carries the business's name where the transport can write one.

5. **The owner answers an alert by email.** Each alert carries the item's owner token (`name+o…`) as
   Reply-To and quotes the customer's latest words. An answer becomes the business's reply to the
   customer — sent as every reply is, from the business's sender, with its conversation address — only if
   all of this holds: the address is the alert's own (a secret only the alert carried); the From is an
   address the business's people sign in with or are alerted at; the receiving server, when it says,
   found it from that domain (DMARC pass, or a DKIM signature of the domain; a DMARC fail is refused); and
   a person wrote it (an out-of-office never answers a customer). Quoted history is cut at the first line
   that names one of the inbox's or the owner's addresses, a line of underscores, a quoted header in any
   language mail programs write (`De :`, `Da:`, `Van:`, `Od:`, …) or an attribution line, also wrapped. An
   answer whose words still name the owner's own address is not sent. What the owner attached is kept on
   the item and not sent on, and the item says so. An out-of-office is dropped. Any other answer that is
   not sent is kept on the item as a note for the owner saying why, and the item asks for a person:
   nothing goes to the customer, and nothing is emailed back (two mailboxes could answer each other).

6. **The owner's sign-in address is never shown to a customer.** Not as From, not as Reply-To, not in a
   body. The runtime drops a policy Reply-To that is the owner's address; every reply address is a token
   address.

7. **Protection.**
   - Loops: every email carries the inbox's mark (`X-Inbox-Loop`, a hash of its own id); one that comes
     back is dropped. So is one that passed through more than forty servers. Out-of-office and returned
     emails never become conversations and are never answered (ADR-018 N14); RFC 3834 headers go on
     everything the inbox sends.
   - Bounces: a returned email (a delivery report, a mailer daemon) is kept as a note on the item it
     answers, the email it returns is marked failed with the server's status, and the item asks for a
     person.
   - Mailings and notices: one with a list's headers (`List-Unsubscribe`, `List-Id`, `List-Post`) or from
     a sender that takes no answer (`noreply@`, `notifications@`, …) that answers no conversation is
     dropped: forwarding a whole mailbox brings these, and none is a customer.
   - Spam: a new email that a server it passed through marked as spam (`X-Spam-Flag`, `X-Spam-Status`,
     Microsoft's spam level) is made in the spam state as it arrives: no alert, no rule, no webhook,
     nothing answered, none of its files kept. It waits under Spam in the owner app. A failed DMARC check
     alone is not spam: Email Routing already refuses mail whose sender's policy asks for that, and the
     business's own forward breaks SPF for many honest `p=none` senders. The words are never judged.
   - Attachments: kept for the owner, at most 10 files and 15 MB an email, 10 MB a file, 100 MB an inbox
     (50 MB on a hosted one), and 20 MB a day from one sender and from one sender's domain (except the big
     mail providers' domains, counted by sender), in 256 KiB pieces (no database's value limit is near). A
     file that runs (`.exe`, `.js`, `.one`, `.xll`, macro documents, disk images…), tested on the name as it
     would be saved (no trailing dots or invisible characters), is named and never kept. They download
     only, never render, can be deleted by a person at the business, and go with the customer when the
     customer is erased. A hosted inbox is full by what its database holds, not by its file's size.
   - Limits: the sender's own bucket and the mailbox's (ADR-005) before anything is kept; a temporary
     failure, never a bounce.
   - The receiving server's verdict is a second signal only, and read strictly: from the header fields in
     the order they came (never a `Headers` object, which sorts and joins them), only the topmost
     Authentication-Results, only when its authserv-id is trusted, and none when another field claims that
     id; ARC's results are never read. It is read at all only once the operator set whose results to
     trust (`TRUSTED_AUTHSERV` on the gateway, `EMAIL_AUTHSERV_ID` on a Worker inbox), after a real
     delivery showed the receiving server puts its own on top. Until then no verdict is passed, and the
     secret token and the owner's address are the proof.

## Consequences

- One new migration (0024: `mail_tokens`, `email_forwards`, `email_confirmations_held`,
  `mail_attachments`, `mail_attachment_chunks`); nothing that exists changes. A download keeps them; a provider's confirmation is left out.
- `email.inboundAddress` is where mail goes: the owner's in person (never their AI), locked by a host.
- The hosted policy grows `mail.inbound` and `mail.own`; three events go to the control plane
  (`mail_sender`, `mail_sender_check`, `mail_sender_failed`). A runtime from before ignores them; a control plane from before
  sends neither, and the inbox then has no address of its own and emails as it did.
- The email gateway routes the hosted inbound domain to the router; every other address it already
  serves goes where it went.

## Not decided here

- Whether the hosted inbound domain stays a subdomain of ours (`in.surfingdog.ai`) or moves to the
  business's own (`reply.<domain>`, one more MX record). A conversation's address on the business's own
  domain needs only its forward's plus addresses today.
- Outbound attachments (the owner attaching a file to a reply in the app).
