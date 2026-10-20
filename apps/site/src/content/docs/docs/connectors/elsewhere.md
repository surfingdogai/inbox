---
title: Booked or ordered elsewhere
description: Already take bookings on Fresha, OpenTable or TableCheck, or orders in your own Toast or Shopify checkout? Say where, and agents send people there, by name. Messages and price requests still come to your Inbox.
sidebar:
  order: 90
---

If people already book you on a booking platform, or order in your own shop's checkout, keep it that way. Tell your Inbox where, and every AI agent that finds you sends people there for that, saying where by name: **Book at Fresha**, **Order at Toast**. Messages and requests for a price still come to your Inbox.

Settings → General → **What agents can do** → **Booked or ordered somewhere else?**

## Set it

1. Pick the place: your booking platform, your ordering page, your shop, your booking engine, or **Another page**.
2. Check the link. It starts from what your Inbox already knows: the page a network found for you on that platform, or your own website for a shop's own checkout. Otherwise paste the link to your page there, the one you would give a customer.
3. **Save.**

A link pasted from a platform picks that platform for you. Tracking at the end of a link (`utm_source`, `fbclid`, `ref` and the like) is taken off as you paste it: agents send people to the page itself.

Your Inbox says so before you save when a link is not your page there: a link that is not on the platform you picked, the platform's own home page rather than yours, or, for a shop's own checkout, a page that is not on your website.

## The places in the list

- **Salons and wellness**: Fresha, Booksy, Planity, Treatwell, Timely, Phorest, Vagaro.
- **Appointments**: Calendly, Cal.com, SimplyBook.me, Setmore, Acuity Scheduling, Square Appointments.
- **Restaurant tables**: OpenTable, Resy, SevenRooms, TheFork, CoverManager, Tock, TableCheck, Chope.
- **Food ordering**: Toast, ChowNow, Slice, Flipdish, GloriaFood, Square Online.
- **Shops and websites**: Shopify, WooCommerce, Wix.
- **Trades**: Tradify.
- **Booking engines**: SiteMinder, Cloudbeds, Mews, Beds24, Lodgify.

Anything else, a page on your own website included, goes under **Another page**: any https page that is yours. Delivery and booking marketplaces that take a share of each sale are not in the list.

## What changes

- **Agents** read it in your [manifest](/docs/manifest/) and your business profile, over the API and MCP: the kind, the link, and the platform it is on. An agent that asks your Inbox to book or order anyway is told where to go, and nothing is written.
- **Your page** shows **Book at Fresha** (or the page's address, for a page on your own website) in place of times to pick ([Your page](/docs/your-page/)).
- **Your Inbox** stops offering that kind itself. Quotes and messages stay. You can still add a booking or an order yourself.

## What your Inbox reads and writes

Nothing at the platform. There is nothing to sign in to and no key to paste: a door elsewhere is a link. Your Inbox never calls the platform, never changes anything there, and never adds anything to the link.

## Take it back

**Bring back here** on its line. The kind comes back to your Inbox at once (bookings need a service and opening hours to open), and agents are told within minutes. There is nothing to undo at the platform.

## For developers

The setting is `doorsElsewhere` in the settings document (`PUT /v1/owner/settings` with an owner key): at most one entry per kind, `{"itemType": "booking" | "order", "url": "https://…", "platform"?: "fresha"}`. The owner in person or a key with `settings:write` sets it, never the owner's AI. It is published as the manifest's `doors_elsewhere` ([spec](/spec/manifest/)); the platforms are [`vocab/door-platforms.json`](https://github.com/surfingdogai/inbox/blob/main/packages/spec/vocab/door-platforms.json) in `@surfingdog/spec`, with `doorPlatformOf`, `doorPlace` and `cleanDoorUrl`.
