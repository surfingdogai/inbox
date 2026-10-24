---
title: Integrations
description: What your Inbox connects to today, what is being built, and the rules every connection keeps. Your own accounts and keys, paid into your own account, nothing said before it works.
---

Settings → **Integrations**. Calendars, payments, and shops and tills, each a card. A card says **Connect** only when your Inbox can connect it. What is being built says **Soon**. Nothing else is listed.

## Works today

| Card | Connects with | Does |
| --- | --- | --- |
| **Calendar**: iCloud, Fastmail, Nextcloud, any CalDAV | An app password | Busy times in, bookings out ([Calendars](/docs/calendars/)) |
| **Calendar**: Google | Sign in with Google, on a server with a Google client | Busy times in, bookings out |
| **Calendar**: Outlook, or any calendar's link | The link the calendar publishes | Busy times only |
| **Cal.com** | An API key | Busy times in, bookings out |
| **Stripe**, **Mollie** | A key of your own account | Orders paid into your account ([Payments](/docs/payments/)) |
| Product feeds | The feed's address | Your catalogue, from the feed Google reads ([Feeds](/docs/feeds/)) |
| Webhooks, keys | An endpoint or a key | Zapier, Make, n8n or your own code ([Webhooks](/docs/webhooks/)) |

On a hosted inbox, Google says **Soon** until Google has checked our sign-in.

## Booking systems

A salon's own booking system, written to first: each booking is confirmed here only once the system took it ([Salons](/docs/salons/)).

| Card | Status |
| --- | --- |
| **Phorest** | Not available yet: you will connect with the API access Phorest gives your salon ([Phorest](/docs/connectors/phorest/)) |
| **Mindbody** | Not available yet: Mindbody has to approve it first ([Mindbody](/docs/connectors/mindbody/)) |

## Being built

**WooCommerce**, **Shopify**, **Square**, **Calendly**, and a **calendar link to share** (your bookings, for any calendar or a booking site's import). And, in Settings → General, sending agents to your page on another booking or ordering site for one kind of request.

## The rules every connection keeps

- **Your own accounts, your own keys.** You paste a key you made, or approve a page on your own store. Keys are encrypted before they are stored, and never shown again, to you or to your AI.
- **You are the merchant.** Money goes to your own Stripe, Mollie, shop checkout or till. Your Inbox never takes card details, never adds a fee, and never takes a share.
- **Nobody pays more than they accepted.** If your shop adds tax or delivery on top, the link to pay is held, and you can propose the shop's total to the customer, who accepts it or not.
- **Your customer hears from you.** What a customer sees is in your name. Where a platform lets us, it does not email a customer your Inbox has already told.
- **A webhook is a nudge.** Its signature is checked, and what it says is read back from the platform with your key. Only ids are kept, never what the platform sent about your customer. Your Inbox also looks for itself every few minutes.
- **In person.** Connecting, changing and disconnecting are yours, signed in. Your AI and the keys you hand to other systems can list and sync, nothing more.
