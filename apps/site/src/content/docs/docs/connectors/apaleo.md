---
title: apaleo
description: apaleo keeps your rooms, rates and reservations. Once an apaleo app is in place, you approve your Inbox on apaleo's own page, and it writes each stay to apaleo before it confirms anything. Until then it says Needs setup.
sidebar:
  order: 24
---

**Needs setup.** This connection is built and switched off. A hotel connects an app on apaleo's own page, and the app is registered with apaleo by whoever runs the Inbox server; none is registered for this service yet. Settings → Property → **Connect your system** shows apaleo as **Needs setup**, with nothing to press. Until then, add each room's calendar link from apaleo, and stays come to you as requests.

## What it needs

- **An apaleo connect client**, registered with apaleo, with an https address to come back to. Whoever runs the Inbox server holds its id and secret.
- Then, for you: **Continue with apaleo**, approve on apaleo's page, and choose which of your properties this Inbox is.

A second way, where a hotel makes its own *simple client* in apaleo (Apps → Connected apps), is built too and stays off: apaleo recommends that way only for a hotel's own internal apps.

## What apaleo is asked to allow

Read your rooms (unit groups), rate plans, rates and availability; read offers; read and manage reservations. Never a permission to force a booking past what is free, never payment accounts and never card authorizations.

## What it will do

| | |
| --- | --- |
| **Reads** | Your properties, their time zones and currencies. Unit groups of bedrooms and how many units each has. Rate plans sold direct whose guarantee is a 6 pm hold. What is free night by night and each night's price; a stay's own total from apaleo's offer. |
| **Writes** | Each stay, before it is confirmed, as a direct booking with a 6 pm hold, its reservations carrying our reference. Changes and cancellations through apaleo's own actions. The guest as the primary guest, once the stay is confirmed. |
| **Never** | A price: apaleo prices each stay from its rate plan. A card, a payment account, an authorization or a commission. |

Rate plans whose least guarantee in apaleo is a card or a prepayment are left out: your Inbox never holds a card.

## How it keeps a room from being sold twice

- **Written first, once.** Each booking is sent with a key of its own; apaleo answers the same request with the same booking for 24 hours, so a request sent again never books twice. After that, the booking is found by its reference.
- **Refused when full.** apaleo refuses a night it cannot sell. The booking is never forced.
- **Changed room by room.** For a stay of several rooms, if apaleo refuses the second, the first is put back, so the stay keeps its dates.
- **Your own date.** Every time apaleo gives is read in your property's time zone: a lodge east of the date line keeps its own dates.

apaleo has no holding state for a reservation, so a stay held for a few minutes, or waiting for its deposit, is a reservation your Inbox cancels if it is not paid in time.

## Webhooks

When the connection is made, your Inbox subscribes to reservation events at its own address. apaleo does not sign them: the address is the secret, the account must be yours, and each reservation named is read back from apaleo before anything changes.

## Documentation

- API reference: <https://api.apaleo.com/>
- OAuth: <https://apaleo.dev/guides/oauth-connection/auth-code-grant.html>
- The apaleo Store: <https://apaleo.dev/guides/apaleo-store/listing-your-app>
