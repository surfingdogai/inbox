---
title: Booked or ordered elsewhere
description: Already take bookings on Fresha, OpenTable or TableCheck, or orders in your own Toast or Shopify checkout? Say where, and agents send people there, by name. Messages and price requests still come to your Inbox.
sidebar:
  order: 90
---

If people already book you on a booking platform, or order in your own shop's checkout, keep it that way. Tell your Inbox where, and every AI agent that finds you sends people there for that, saying where by name: **Book at Fresha**, **Order at Toast**. Messages and requests for a price still come to your Inbox.

Settings → General → **What agents can do** → **Take bookings or orders on another site?**

## Set it

1. Paste the link to your booking page or your shop: the one you would give a customer. A link from a platform in the list picks that platform for you.
2. If your platform gives you a direct booking link for your own website (Fresha, Treatwell and OpenTable do), paste that one rather than your page in its marketplace. When a network already found your page there, your Inbox starts from it: check it, and change it for your direct link if you have one.
3. For a shop on your own website (Shopify, WooCommerce, Wix…), pick it from the list. The link starts from your website; add your website in General first, so agents know the shop is yours.
4. **Save.**

Tracking at the end of a link (`utm_source`, `fbclid`, `gclid` and the like) is taken off as you paste it: agents send people to the page itself.

Your Inbox says so before you save when a link is not your page there: a link that is not on the platform you picked, one of the platform's own pages (its home, its sign-in, its prices) rather than yours, or, for a shop on your own website, a page that is not on it. A page of yours on a platform the list doesn't know goes under **Another page**, named by its address.

## The places in the list

- **Salons and wellness**: Fresha, Booksy, Planity, Treatwell, Timely, Phorest, Vagaro.
- **Appointments**: Calendly, Cal.com, SimplyBook.me, Setmore, Acuity Scheduling, Square Appointments.
- **Restaurant tables**: OpenTable, Resy, SevenRooms, TheFork, CoverManager, Tock, TableCheck, Chope.
- **Food ordering**: Toast, ChowNow, Slice, Flipdish, GloriaFood.
- **Shops and websites**: Shopify, WooCommerce, Wix, Square Online.
- **Trades**: Tradify.
- **Hotels and rentals**: SiteMinder, Cloudbeds, Mews, Beds24, Lodgify.

Anything else, a page on your own website included, goes under **Another page**: any https page that is yours. What a platform charges you is between you and it. Your Inbox takes nothing and adds nothing to the link.

## What changes

- **Agents** read it in your [manifest](/docs/manifest/) and your business profile, over the API and MCP: the kind, the link, and the platform it is on. An agent that asks your Inbox to book or order anyway is told where to go, and nothing is written.
- **Your page** shows **Book at Fresha** (or the page's address, for a page on your own website) in place of times to pick ([Your page](/docs/your-page/)).
- **Your Inbox** stops offering that kind itself. Messages, and requests for a price when you take them, stay. You can still add a booking or an order yourself.

## What your Inbox reads and writes

Nothing at the platform. There is nothing to sign in to and no key to paste: a door elsewhere is a link. Your Inbox never calls the platform, never changes anything there, and never adds anything to the link.

## Take it back

**Take bookings here** on its line brings bookings back to your Inbox at once (they need a service and opening hours to open), and agents are told within minutes. **Remove** stops sending orders there. There is nothing to undo at the platform.

## For developers

The setting is `doorsElsewhere` in the settings document (`PUT /v1/owner/settings` with an owner key): at most one entry per kind, `{"itemType": "booking" | "order", "url": "https://…", "platform"?: "fresha"}`. The owner in person or a key with `settings:write` sets it, never the owner's AI. It is published as the manifest's `doors_elsewhere` ([spec](/spec/manifest/)); the platforms are [`vocab/door-platforms.json`](https://github.com/surfingdogai/inbox/blob/main/packages/spec/vocab/door-platforms.json) in `@surfingdog/spec`, with `doorPlatformOf`, `doorPlace` and `cleanDoorUrl`.
