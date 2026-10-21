---
title: Cloudbeds
description: Cloudbeds keeps your rooms, rates and reservations. Once a Cloudbeds partner app is in place, you connect your Inbox from Cloudbeds, and it writes each stay to Cloudbeds before it confirms anything, checking the nights before and after. Until then a hosted inbox shows Cloudbeds as Soon, and stays come to you as requests.
sidebar:
  order: 25
---

**Not switched on yet.** This connection is built and switched off. Cloudbeds asks each technology partner to be evaluated by its partnerships team before it connects to properties, and the hosted inboxes at surfingdog.ai don't have a partner app yet. A hosted inbox shows Cloudbeds as **Soon**; on your own server it says **Needs setup** until its partner app is set. Until then, stays come to you as requests and you confirm each one.

## What it needs

- **A Cloudbeds partner app**, approved by Cloudbeds, with its key delivered automatically when a property connects it. Whoever runs the Inbox server holds the app's id and secret.
- Then, for you: **Continue with Cloudbeds**, approve the app, and choose which of your properties this Inbox is. Cloudbeds hands your Inbox a key of your property's own, which is encrypted before it is stored and never shown again.

A second way, where you paste a key you made in Cloudbeds (Account → Apps & Marketplace → API Credentials), is built too and stays off until Cloudbeds' partner team agrees to it.

The scopes asked for: `read:hotel`, `read:room`, `read:rate`, `read:taxesAndFees`, `read:reservation`, `write:reservation` and `write:guest`.

## What it will do

| | |
| --- | --- |
| **Reads** | Your properties, their time zones and currencies. Room types, shared rooms such as a dorm's beds too, and how many rooms each has. Rate plans without a promo code, what is free night by night and each night's rate. Your taxes and fees, to know whether a rate is what a guest pays. The reservations it made, and the ones on the nights it writes. |
| **Writes** | Each stay, before it is confirmed, with our reference, unconfirmed while its deposit is due and confirmed once paid. The guest's name, email and phone on the reservation once it is paid, so the desk has them at check-in. A note with the stay's reference and what the guest agreed. Changes of dates or rooms. Cancellations, by status. Its webhooks. |
| **Never** | A price: Cloudbeds prices each stay from its rate. A card, a card token or a payment authorization: the payment method is *cash*, meaning you are paid outside Cloudbeds. An email from Cloudbeds to your guest. |

## Prices, taxes and fees

Cloudbeds gives its rates before your own taxes and fees. If your property adds a tax or a fee on top of its rates, your Inbox reads your nights without prices, so a guest is never quoted less than their folio will show: you price those stays yourself. After each write your Inbox reads back the reservation's own total, taxes and fees in, and if it differs from what the guest agreed you get a note on the stay, so the desk checks the folio before charging anything more.

## How it keeps a room from being sold twice

Cloudbeds' documentation does not say that it refuses a booking for a night with no room left, so your Inbox checks on both sides:

- **Before.** The nights are read live just before a stay is written. A night with no room left is refused, and nothing is written.
- **After.** Once Cloudbeds has taken the stay, your Inbox counts the reservations against the rooms on each of its nights: every page of them, each with its own rooms, cancelled ones left out, and its own booking among them, or it promises nothing yet. If another channel took the last room in the seconds between, your Inbox cancels its own booking at once, and nothing is promised: the guest is told the room could not be booked, and may ask again.
- **Never refused once written.** Once Cloudbeds has made the reservation, a status or a note it does not take never turns into a no for the guest while Cloudbeds holds the room.
- **Found again.** Each stay carries our reference, so a booking whose answer was lost is found, and never written twice; one cancelled in Cloudbeds since is never taken for the stay.
- **Each room by its kind.** A stay of several rooms is matched room by room by its type and its guests, whatever order Cloudbeds lists them in (it lists assigned rooms first), so confirming a stay never swaps its rooms.

## Webhooks

Once the connection is kept (its first sync, a moment after you connect), your Inbox subscribes to reservation events at its own address, with a header of its own that Cloudbeds sends with every delivery. A hosted inbox subscribes once it is live at your own address. Your Inbox checks that header in constant time, and that the delivery is about your property, then reads the reservation back from Cloudbeds. A webhook is only a nudge: what is free is read again every few minutes anyway.

## Documentation

- Getting started as a partner: <https://developers.cloudbeds.com/docs/getting-started-as-a-partner-in-5-steps>
- API keys for partners: <https://developers.cloudbeds.com/docs/api-keys-authentication-guide-for-technology-partners>
- Webhooks: <https://developers.cloudbeds.com/docs/webhooks-1>
