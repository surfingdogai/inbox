---
title: Get your agent inbox
description: Set up a hosted inbox from your check result, then connect it to your own domain with one DNS record. The record, and the steps for each DNS provider.
draft: true
---

<!--
  A draft: not built into the site while the hosted pilot is closed (src/lib/hosted.ts). Switching
  the pilot on sets `draft: false` here and adds this page to the sidebar. The provider steps below
  are checked against each provider's panel, with the date, before that. Compared with the
  providers' help pages on 13 Oct 2026: Cloudflare, GoDaddy, Namecheap, Squarespace Domains, Wix,
  IONOS. Walked in the panel: Cloudflare: not yet · GoDaddy: not yet · Namecheap: not yet ·
  Squarespace Domains: not yet · Wix: not yet · IONOS: not yet · Google Cloud DNS: not yet ·
  Shopify: not yet
-->

A hosted inbox is Surfing Dog Inbox run by us, at an address on your own domain. It takes two steps: set it up from your website's check result, then add one DNS record. It is free during the pilot ([terms](/hosted/terms/)).

## Before you start

- **A domain of your own,** such as `yourbusiness.com`. An address on a platform's domain cannot carry your record.
- **A way to add a DNS record** at that domain: your login at the company that runs your DNS, or someone who has one (your web person, your IT company).
- Health and medical practices cannot join during the pilot.

## 1. Set it up

1. Check your website at [surfingdog.ai/check](/check). On the result, choose **Get your agent inbox**.
2. Check what we read from your website: your kind of business, your hours, one service. Change anything that is wrong. Fields our model read are marked **please check**.
3. Type your email address and choose **Send my code**. New requests go to this address; customers never see it.
4. Enter the six-digit code from the email, or open the email's **Confirm** button.

Your inbox is now set up at a private address of ours, a generated name like `quiet-otter-7k2m.surfingdog.ai`. Nobody but you can open it there. Agents cannot reach it, and nothing about it is listed or indexed. We test it as an agent would, and show you the result: **Tested as an agent: book ✓ quote ✓ message ✓**.

## 2. Add one DNS record

The Connect screen shows your record. It looks like this:

| Type | Name | Target | TTL |
| --- | --- | --- | --- |
| CNAME | `inbox` | `k7m2qxpa.hosted.surfingdog.ai` | leave as it is |

The target is **unique to your inbox**: copy yours from the Connect screen, never from this page or from another business. Your inbox's hostname is then `inbox.yourbusiness.com`. You can choose another name than `inbox` on the Connect screen until the record is seen.

Nothing else on your website or your email changes: the record adds one new name.

The Connect screen tells you who seems to run your DNS, from your domain's name servers. It shows the steps for that provider where we have checked them, and steps that work anywhere otherwise. If it guessed wrong, choose **Not right? Pick yours**.

In the Name field type just `inbox`: most panels add your domain themselves. If the panel shows your domain after the field, do not type it again.

### Cloudflare

1. **DNS → Records → Add record.**
2. Type **CNAME**, Name `inbox`, Target your target.
3. **Proxy status: DNS only** (the grey cloud). A proxied record hides the CNAME, and the connection cannot finish.
4. **Save.**

### GoDaddy

1. **Domain Portfolio →** your domain **→ DNS → Add New Record.**
2. Type **CNAME**, Name `inbox`, Value your target, TTL as it is.
3. **Save.**

### Namecheap

1. **Domain List → Manage →** **Advanced DNS → Add New Record → CNAME Record.**
2. Host `inbox`, Value your target, TTL **Automatic.**
3. **Save All Changes** (the tick).

### Squarespace Domains

This includes domains that moved from Google Domains.

1. **Domains →** your domain **→ DNS.**
2. Under **Custom records**, add a record: Type **CNAME**, Name `inbox`, Data your target.
3. **Save.**

### Wix

1. **Domains →** the **Domain Actions** menu beside your domain **→ Manage DNS Records.**
2. Under **CNAME**, choose **Add Record.**
3. Host Name `inbox`, Value your target.
4. **Save**, then **Save Changes** in the pop-up.

### IONOS

1. **Domains & SSL →** the gear beside your domain **→ DNS → Add record → CNAME.**
2. Hostname `inbox`, Point to your target.
3. **Save.**

If IONOS asks for the subdomain before the record, create `inbox` under **Manage Subdomains**, then open its DNS.

### Google Cloud DNS

1. Open your zone, then **Add standard.**
2. DNS name `inbox`, Resource record type **CNAME**, Canonical name your target **with a final dot** (`k7m2qxpa.hosted.surfingdog.ai.`).
3. **Create.**

### Shopify

1. **Settings → Domains →** your domain **→ Domain settings → Edit DNS settings → Add custom record.**
2. Type **CNAME**, Name `inbox`, Points to your target.
3. **Confirm.**

### Any other provider

Look for the DNS settings of your domain and add a record of type **CNAME**. Providers name the fields differently:

- **Name** may be called Host, Host name, Alias or Record name. Enter `inbox`. When the panel shows your domain after the field, it adds it for you: do not type it again.
- **Target** may be called Value, Points to, Data, Canonical name or Destination. Enter your target exactly.
- **TTL:** leave it as it is.

If the panel offers a proxy or a "flattening" switch for the record, leave it off.

## Someone else runs your DNS

Choose **Someone else runs it** on the Connect screen. It opens an email in your own mail app, addressed to nobody, for you to send to whoever runs your domain; we never send it. It reads:

```text
Subject: One DNS record for yourbusiness.com

Hello,

Could you add this DNS record for yourbusiness.com?

Type: CNAME
Name: inbox
Target: k7m2qxpa.hosted.surfingdog.ai
(If the DNS is on Cloudflare: Proxy status DNS only.)

It connects our agent inbox at inbox.yourbusiness.com. Nothing else on the website changes.
You can see when it works here: https://app.surfingdog.ai/connect/…

Thank you
```

The link at the end shows the record and the status, and nothing about your business or your email. It stops working when your inbox goes live, after 30 days, or when you make a new one.

## What the status means

The Connect screen checks for your record every minute while it is open, and less often after that. **Check now** looks at once.

- **Waiting for the record.** Most providers show a new record within minutes; some take a few hours.
- **Record found. Connecting inbox.yourbusiness.com…** We saw your record and asked for a certificate for your hostname.
- **Issuing the certificate for inbox.yourbusiness.com.** This usually takes a few minutes.
- **Testing as an agent…** We call your inbox from the outside, as an agent would.
- **inbox.yourbusiness.com is live.** Agents can reach it now. We email you once to say so.

## If something is wrong

- **"… is in use already."** The name you chose already has records, so it may be in use. Choose another name, such as `book`. Remove those records if you know nothing uses them.
- **"… points to something else. It should point to your target."** The Target field has a typo or an old value.
- **"… points to another inbox's address."** The target belongs to someone else's inbox. Copy yours from the Connect screen.
- **"The record is proxied by Cloudflare."** Set its Proxy status to **DNS only**. If it is DNS only already, turn off CNAME flattening for all records in DNS Settings.
- **"The record was saved as inbox.yourbusiness.com.yourbusiness.com."** Your panel adds your domain itself: in the Name field type just `inbox`.
- **"Your panel added yourbusiness.com to the end of the target."** Type the target with a dot at the end, such as `k7m2qxpa.hosted.surfingdog.ai.`
- **"… don't all show the record yet."** Your domain's name servers disagree for a moment while the record spreads. It usually settles within minutes.
- **"… is answered by … name servers, not yourbusiness.com's own."** The name is delegated to other name servers. Add the record where your domain's own DNS is managed.
- **"Your provider turned the record into an address."** Some providers flatten a CNAME into an address. Keep it a CNAME for this name.
- **"Still no record after two days."** Check that the Name is exactly the name you chose and the Target exactly your target.
- **"… limits who may issue its certificates (a CAA record)."** Your domain allows some certificate authorities and not others. Add the records the Connect screen shows, and the certificate can be issued.
- **"We can't connect this name."** Write to us and we will look.
- **"Still connecting. We're on it."** A problem on our side; there is nothing for you to do.

## Once it is live

- **Open your inbox** at `https://inbox.yourbusiness.com`. Requests from agents and people arrive there; your rules answer the routine ones.
- **Connect your AI** to `https://inbox.yourbusiness.com/mcp/owner` ([how](/docs/connect-your-ai/)).
- **Join a network** in Settings, if you want to be listed. Nothing is listed until you do.
- **Keep the record.** If it is removed or changed, agents can't reach your inbox there. Put it back within 72 hours and nothing else changes; after that your inbox stops taking requests from agents until the record is back. Meanwhile you can still open your inbox from your account.

## Questions

**Why my own domain?** An agent deciding whether to trust an address looks at its domain. Yours already belongs to your business, and adding a record there shows the inbox is yours. No other proof is needed.

**Does anything else change on my website or my email?** No. The record adds one new name, `inbox.yourbusiness.com`, and touches nothing else.

**What does it cost?** Nothing during the pilot. We count confirmed bookings and accepted orders, and tell you at least 30 days before any charge ([terms](/hosted/terms/)).

**Can I leave?** At any time. Download everything as one file that the open-source inbox opens, then close your inbox, or point `inbox.yourbusiness.com` at an inbox you run yourself ([self-hosted vs hosted](/docs/self-hosted-vs-hosted/)).
