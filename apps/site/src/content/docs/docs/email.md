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

Add the address your customers use and where it lives — Gmail, Google Workspace, Outlook.com, Microsoft 365, iCloud Mail, IONOS, Zoho Mail, cPanel or another provider. The page reads the likely one from the address, and shows that provider's steps with your inbox's address already in them.

- **Confirmations.** Gmail, Google Workspace and Zoho email a code before they forward anything. It arrives in your inbox and shows on the page: type the code in your provider, or open its link. The inbox never opens it for you, and it only shows one for an address you are setting up.
- **Check forwarding.** Sends a short email to your address. If forwarding works it comes straight back, and the page says *Forwarding works*. It is sent to your address with a `+` code first: when that comes back too, your customers' replies can go to your own address, with the code, and still find their conversation.
- **Microsoft 365** holds back forwarding outside your company until your admin allows it. The steps say where.

Forwarding sends new mail from the moment it is on. Your mailbox can keep its own copy.

## Answer by email

Every alert about a new request or message quotes what the customer wrote. Reply to it from your mailbox, and your answer goes to the customer from your business, in the same conversation. It works only from the address you sign in with or are alerted at, only for that alert, and never for an automatic reply such as an out-of-office. Files attached to your answer stay on the request: they are not sent on.

Your own address is never shown to a customer.

## Who replies go out from

- **Hosted:** in your business's name, from the inbox's sending address. Customers' replies come back to the conversation.
- **Hosted, from your own address:** once an address of yours forwards here and passed its check, choose it under *Replies go out from*. The page shows the DNS records to add — three that sign your email and two for a subdomain that takes returned email; your domain's own SPF record is left as it is — and checks them. Email goes from your address once they check out, and from the inbox's sending address until then.
- **Your own server:** from `MAIL_FROM`, through the mail service you set up. That service's own records sign for your domain.

## What the inbox does with what arrives

- **Its own email coming back** — an alert sent to an address that forwards here — is recognised and dropped, so nothing loops.
- **Out-of-office and returned emails** never start a conversation and are never answered. A returned email marks the email it returns as not delivered, and the request asks for you.
- **Spam:** an email that failed its sender's own checks (DMARC), or that a server marked as spam on its way, is put aside as spam. Nobody is told and nothing is answered. You can take it out.
- **Attachments** are kept for you to download: up to 10 files and 15 MB an email, 10 MB a file. Files that run, such as `.exe` or macro documents, are named but never kept. They are erased with the customer.

## Your own server

Write the inbox's address in Settings → Email. Mail reaches the inbox one of two ways:

- **On Cloudflare:** route the address to the Worker in Email Routing. The Worker takes it in.
- **Anywhere:** a forwarder or a provider's inbound webhook posts the raw email to `POST /v1/email/inbound`, with the secret from Settings (`email.inboundSecret`) in `X-Inbox-Email-Secret`. Conversation addresses are plus addresses of the inbox's, so route the whole address, `+` included.

Pulling a mailbox over IMAP is not built yet.

The decisions behind this page are in [ADR-026](https://github.com/surfingdogai/inbox/blob/main/docs/adr/026-email-channel.md).
