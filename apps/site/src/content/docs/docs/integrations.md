---
title: Integrations
description: What your Inbox connects to today, what waits on another company, and the rules every connection keeps. Your own accounts and keys, paid into your own account, nothing said before it works.
---

Every one in a table, with what is coming: [Integrations](/integrations/).

Settings → **Integrations**. Calendars, payments, shops and checkouts, property systems, job tools, and ordering and tills, each a card. A card says **Connect** only when your Inbox can connect it; one that waits on something says **Soon** or **Needs setup**, with nothing to press.

## Works today

| Card | Connects with | Does |
| --- | --- | --- |
| **Calendar**: iCloud, Fastmail, Nextcloud, any CalDAV | An app password | Busy times in, bookings out ([Calendars](/docs/calendars/)) |
| **Calendar**: Google | Sign in with Google, on a server with a Google client | Busy times in, bookings out |
| **Calendar**: Outlook, or any calendar's link | The link the calendar publishes | Busy times only |
| **Cal.com** | An API key | Busy times in, bookings out |
| **Calendly** | A token, or Sign in with Calendly on a server with a Calendly app | Busy times in; bookings out on its paid plans ([Calendly](/docs/connectors/calendly/)) |
| **Share your bookings** | A private link your Inbox makes | Your bookings, for another site's calendar sync ([Share your bookings](/docs/connectors/calendar-link/)) |
| **Stripe**, **Mollie** | A key of your own account | Orders paid into your account ([Payments](/docs/payments/)) |
| **WooCommerce®** | One press on your shop's Approve page, or its keys | Catalogue in, orders paid at your checkout ([WooCommerce](/docs/connectors/woocommerce/)) |
| **Shopify** | An app you make for your own shop | Catalogue in, orders paid at your checkout ([Shopify](/docs/connectors/shopify/)) |
| **Square** | An access token, or Sign in with Square on a server with a Square app | Bookings, catalogue, and orders paid at your Square checkout ([Square](/docs/connectors/square/)) |
| **Property system**: Beds24, Hostaway | An invite code; an account ID and API key | What is free in, each stay written there first ([Property systems](/docs/property-systems/)) |
| **Ordering and till**: GloriaFood, Flipdish | Keys from your own account | Your menu in, to start from ([Which tills](/docs/ordering/#which-tills)) |
| **Job tool**: ServiceM8 | Your API key | Requests you take on, as jobs ([Job tools](/docs/job-tools/)) |
| Product feeds | The feed's address | Your catalogue, from the feed Google reads ([Feeds](/docs/feeds/)) |
| Webhooks, keys | An endpoint or a key | Zapier, Make, n8n or your own code ([Webhooks](/docs/webhooks/)) |

WooCommerce and its associated designs are trademarks of Automattic Inc.

The calendar, shop, kitchen, stay and trade connections (iCloud and the other CalDAV calendars, Google, Outlook, Cal.com, Calendly, WooCommerce, Shopify, Square, Beds24, Hostaway, GloriaFood, Flipdish and ServiceM8) are built from each one's documentation and tested against a stand-in; not yet run with a real account.

On a hosted inbox, Google says **Soon** until Google has checked our sign-in, and Sign in with Calendly or Square says **Soon** until our app is there; their tokens work meanwhile.

Already take bookings or orders on another site? Settings → General sends agents there for that: [Booked or ordered elsewhere](/docs/connectors/elsewhere/).

## Waiting on another company

Built, and switched off until what each needs is in place:

- **Mews**, **apaleo**, **Cloudbeds** and **Smoobu** ([Property systems](/docs/property-systems/#not-switched-on-yet)).
- **Toast**, **Lightspeed Restaurant**, **Clover** and **Deliverect**, once each one's partner app is approved ([Which tills](/docs/ordering/#which-tills)).
- **Jobber**, through its reviewed app; **Housecall Pro** and **Fergus**, once the server has cleared their API terms ([Job tools](/docs/job-tools/#which-tools)).

## The rules every connection keeps

- **Your own accounts, your own keys.** You paste a key you made, sign in on the platform's own page, or approve a page on your own store. Keys are encrypted before they are stored, and never shown again, to you or to your AI.
- **You are the merchant.** Money goes to your own Stripe, Mollie, shop checkout or till. Your Inbox never takes card details, never adds a fee, and never takes a share.
- **Nobody pays more than they accepted.** If your shop adds tax or delivery on top, the link to pay is held, and you can propose the shop's total to the customer, who accepts it or not.
- **Your customer hears from you.** What a customer sees is in your name. Where a platform lets us, it does not email a customer your Inbox has already told.
- **A webhook is a nudge.** Its signature is checked, and what it says is read back from the platform with your key. Only ids are kept, never what the platform sent about your customer. Your Inbox also looks for itself every few minutes.
- **In person.** Connecting, changing and disconnecting are yours, signed in. Your AI and the keys you hand to other systems can list and sync, nothing more.
