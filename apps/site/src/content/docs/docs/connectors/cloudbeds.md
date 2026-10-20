---
title: Cloudbeds
description: Cloudbeds keeps your rooms, rates and reservations. Once a Cloudbeds partner app is in place, you connect your Inbox from Cloudbeds, and it writes each stay to Cloudbeds before it confirms anything, checking the nights before and after. Until then it says Needs setup.
sidebar:
  order: 25
---

**Needs setup.** This connection is built and switched off. Cloudbeds asks each technology partner to be evaluated by its partnerships team before it connects to properties, and none is set up for this service yet. Settings → Property → **Connect your system** shows Cloudbeds as **Needs setup**, with nothing to press. Until then, add each room's calendar link from Cloudbeds, and stays come to you as requests.

## What it needs

- **A Cloudbeds partner app**, approved by Cloudbeds, with its key delivered automatically when a property connects it. Whoever runs the Inbox server holds the app's id and secret.
- Then, for you: **Continue with Cloudbeds**, approve the app, and choose which of your properties this Inbox is. Cloudbeds hands your Inbox a key of your property's own, which is encrypted before it is stored and never shown again.

A second way, where you paste a key you made in Cloudbeds (Account → Apps & Marketplace → API Credentials), is built too and stays off until Cloudbeds' partner team agrees to it.

## What it will do

| | |
| --- | --- |
| **Reads** | Your properties, their time zones and currencies. Room types and how many rooms each has. Rate plans without a promo code, what is free night by night and each night's rate. The reservations it made, and the ones on the nights it writes. |
| **Writes** | Each stay, before it is confirmed, with our reference, unconfirmed while its deposit is due and confirmed once paid. Changes of dates or rooms. Cancellations, by status. Its webhooks. |
| **Never** | A price: Cloudbeds prices each stay from its rate. A card, a card token or a payment authorization: the payment method is *cash*, meaning you are paid outside Cloudbeds. An email from Cloudbeds to your guest. |

## How it keeps a room from being sold twice

Cloudbeds' documentation does not say that it refuses a booking for a night with no room left, so your Inbox checks on both sides:

- **Before.** The nights are read live just before a stay is written. A night with no room left is refused, and nothing is written.
- **After.** Once Cloudbeds has taken the stay, your Inbox counts the reservations against the rooms on each of its nights. If another channel took the last room in the seconds between, your Inbox cancels its own booking at once, and nothing is promised: the guest is told the room could not be booked, and may ask again.
- **Found again.** Each stay carries our reference, so a booking whose answer was lost is found, and never written twice.

## Webhooks

When the connection is made, your Inbox subscribes to reservation events at its own address, with a header of its own that Cloudbeds sends with every delivery. Your Inbox checks that header in constant time, and that the delivery is about your property, then reads the reservation back from Cloudbeds. A webhook is only a nudge: what is free is read again every few minutes anyway.

## Documentation

- Getting started as a partner: <https://developers.cloudbeds.com/docs/getting-started-as-a-partner-in-5-steps>
- API keys for partners: <https://developers.cloudbeds.com/docs/api-keys-authentication-guide-for-technology-partners>
- Webhooks: <https://developers.cloudbeds.com/docs/webhooks-1>
