---
title: Mews
description: Mews keeps your rooms, rates and reservations. Once a partner token is in place, your Inbox reads what is free from Mews and writes each stay to Mews before it confirms anything. Until then it says Needs setup.
sidebar:
  order: 23
---

**Needs setup.** This connection is built and switched off. Mews gives its Connector API only to certified partners, and none is set up for this service yet. Settings → Property → **Connect your system** shows Mews as **Needs setup**, with nothing to press. Until it is in place, add each room's calendar link from Mews, and stays come to you as requests.

## What it needs

- **A partner token** (Mews calls it a *ClientToken*). Mews issues it to an integration it has certified, and it is the same for every property. Whoever runs the Inbox server holds it, never a property and never the code.
- **Your property's own token** (an *AccessToken*). Mews makes it when your property connects the integration in Mews Marketplace, and sends it to the integration's owner. On a server you run yourself, you paste it in the connection's form.

Mews's public demo environment, with its published tokens, is never called.

## What it will do

| | |
| --- | --- |
| **Reads** | Your property's name, time zone and currency. Its bookable services counted in nights, their room categories and how many rooms each has, the public rates, what is free night by night and each night's price. The reservations it made, to find them again and keep them in step. |
| **Writes** | Each stay, before it is confirmed, with Mews refusing a night it has no room for. A stay that waits for its deposit is held in Mews as *optional*, with a time Mews lets it go by itself. Confirmation once paid; the guest's name and contact only then. Changes and cancellations. |
| **Never** | A price: Mews prices each stay from its own rate. A card, or anything that carries one. An email from Mews to your guest: your Inbox writes to them, in your words. |

## How it keeps a room from being sold twice

- **Written first.** A stay is confirmed only after Mews has taken it and said so. If Mews refuses, nothing is promised, and the guest may ask again.
- **Held by Mews itself.** A stay held for a few minutes, or one waiting for its deposit, blocks the room in Mews as an optional reservation. If your Inbox ever fails to let it go, Mews releases it at the time it was given: an hour for a hold, three days at most for a deposit, and never after the arrival.
- **Found again.** Each reservation carries one line in its notes: the stay's reference (*Inbox stay 4F2K9Q*) and a tag only your Inbox can make. If Mews takes a stay but its answer is lost, your Inbox finds it by that line, and never writes it twice.
- **A change checked twice.** Moving a stay is written to Mews first. If the new nights leave Mews with more bookings than rooms, the move is put back and refused, and the stay keeps its dates in both places.
- **Cancelled, never deleted.** No cancellation fee is posted in Mews for a cancellation your Inbox makes.

## Limits and webhooks

Mews allows 200 requests per property token in any 30 seconds. When it asks to wait, your Inbox waits as long as it says, and keeps answering from what it read last.

Mews sends webhooks to one address per integration, with a shared secret in that address. Your Inbox checks the secret, and that the delivery is about your property, then reads each reservation it names back from Mews. A webhook is only a nudge: what is free is read again every few minutes anyway.

## Documentation

- Connector API: <https://docs.mews.com/connector-api/>
- Certification: <https://help.mews.com/s/article/connector-api-certification-what-to-expect>
