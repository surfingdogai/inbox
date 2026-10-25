---
title: Email
description: Your inbox's own address, your existing address forwarded to it, replies that land in the right conversation, answering alerts by email, and sending from your own domain.
---

Customers write to the address they already know. You forward it to your inbox's own address, and every conversation carries on there: their replies come back to the same request, and you can answer from your mailbox or from the inbox.

Settings → **Email**.

## Your inbox's address

Every inbox has an address of its own. On a hosted inbox it is set for you. On your own server it is the address your mail routing delivers to the inbox (see [Your own server](#your-own-server)).

Each conversation gets an address of its own too: your inbox's, with a code after a `+`. Every email to a customer carries it as the address to reply to, so their answer lands on their request even when their mail program drops the rest. The code is random and is never the request's number.

## Forward your existing address

Add the address your customers use and where it lives — Gmail, Google Workspace, Outlook.com, Microsoft 365, iCloud Mail, Yahoo Mail, Proton Mail, Fastmail, Zoho Mail, IONOS, GoDaddy, Hostinger, OVH, cPanel or another provider. The page reads the likely one from the address, and shows that provider's steps with your inbox's address already in them.

Forward only the address customers write to. If it shares a mailbox with your own mail, forward just its mail with a filter or a rule: the steps say how. Newsletters and notices that reach the inbox anyway are dropped, never answered.

- **Confirmations.** Gmail and Google Workspace email a code and a link before they forward anything, and Zoho a code. They show on the page, named by the provider that sent them: open the link (it only ever opens `mail-settings.google.com`) or copy the code into your provider, then press *Check forwarding*. Only a confirmation from the provider's own sender is shown this way, never one that merely looks like it. The inbox never opens or types anything for you.
- **Check forwarding.** Sends a short email to your address. If forwarding works it comes straight back, and the page says *Forwarding works*. It is sent to your address with a `+` code first: when that comes back too, your customers' replies can go to your own address, with the code, and still find their conversation. A few emails can still be refused on the way: those whose senders sign nothing, when your forward does not rewrite the sender. Gmail and Microsoft 365 forwards keep them working. Checks are limited to a few a day.
- **Microsoft 365** holds back forwarding outside your company until your admin allows it, and a shared mailbox is forwarded by your admin. The steps say where.

Forwarding sends new mail from the moment it is on. Your mailbox can keep its own copy.

## Answer by email

Every alert about a new request or message quotes what the customer wrote. Reply to it from your mailbox, and your answer goes to the customer from your business, in the same conversation. It works only from the address you sign in with or are alerted at, only for that alert, and never for an automatic reply such as an out-of-office. Files attached to your answer stay on the request: they are not sent on.

Your own address is never shown to a customer.

## Who replies go out from

- **Hosted:** in your business's name, from the inbox's sending address. When your inbox has an address of its own, customers' replies come back to the conversation. Until then, set *Customers reply to* in Settings to a mailbox at your own domain (such as `hello@yourshop.com`) and their replies go there; without one, emails to customers don't ask for a reply.
- **Hosted, from your own address** (when your host offers it): once an address of yours forwards here and passed its check, choose it under *Replies go out from*. The page shows the DNS records to add — three that sign your email and two for a subdomain that takes returned email; your domain's own SPF record is left as it is, and none of them changes where your email goes — with your DNS provider's steps, *Copy all* and *Send to my web person*, and checks them. Email goes from your address once they check out, and from the inbox's sending address until then.
- **Your own server:** from `MAIL_FROM`, through the mail service you set up. That service's own records sign for your domain.

## What the inbox does with what arrives

- **Its own email coming back** — an alert sent to an address that forwards here — is recognised and dropped, so nothing loops.
- **Out-of-office and returned emails** never start a conversation and are never answered. A returned email marks the email it returns as not delivered, and the request asks for you.
- **Mailings and notices** — a newsletter, a shop's or a bank's notice, anything from a `noreply` address — that answer no conversation are dropped: nobody is told and nothing is answered.
- **Spam:** an email a server on its way marked as spam is put aside, unanswered, unless it comes from someone you know, when it is only labelled. It waits under Spam, where you can take it out. The [spam filter](/docs/spam/) says what else it keeps off your desk.
- **Attachments** are kept for you to download, or delete: up to 10 files and 15 MB an email, 10 MB a file, and a limit for what one sender leaves in a day. Files that run, such as `.exe` or macro documents, are named but never kept. Nothing of spam is kept. They are erased with the customer.
- **Answers by email that are not sent** — from another address, one its mail server could not show was yours, or one that still has your own address in it — are kept on the request as a note for you, saying why. Answer from the inbox instead.

## Your own server

Write the inbox's address in Settings → Email. Mail reaches the inbox one of two ways:

- **On Cloudflare:** in Email Routing, route the address to the Worker and turn on **Subaddressing** (Email Routing → Settings), so its conversation addresses (`inbox+t…@`) reach it too. A catch-all to the Worker also works.
- **Anywhere:** a forwarder or a provider's inbound webhook posts the raw email to `POST /v1/email/inbound`, with the secret from Settings (`email.inboundSecret`) in `X-Inbox-Email-Secret`. Conversation addresses are plus addresses of the inbox's, so route the whole address, `+` included.

Pulling a mailbox over IMAP is not built yet.

The decisions behind this page are in [ADR-026](https://github.com/surfingdogai/inbox/blob/main/docs/adr/026-email-channel.md).
