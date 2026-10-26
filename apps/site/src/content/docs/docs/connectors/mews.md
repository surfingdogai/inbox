---
title: Mews
description: Mews keeps your rooms, rates and reservations. Once a partner token is in place, your Inbox reads what is free from Mews and writes each stay to Mews before it confirms anything. Until then a hosted inbox shows Mews as Soon, and stays come to you as requests.
sidebar:
  order: 23
---

**Not switched on yet.** This connection is built and switched off. Mews gives its Connector API only to certified partners, and the hosted inboxes at surfingdog.ai don't have a partner token yet. A hosted inbox shows Mews as **Soon**; on your own server it says **Needs setup** until its partner token is set. Until it is in place, stays come to you as requests and you confirm each one.

## What it needs

- **A partner token** (Mews calls it a *ClientToken*). Mews issues it to an integration it has certified, and it is the same for every property. Whoever runs the Inbox server holds it, never a property and never the code.
- **Your property's own token** (an *AccessToken*). Mews makes it when your property connects the integration in Mews Marketplace, and sends it to the integration's owner. On a server you run yourself, you paste it in the connection's form.

Mews's public demo environment, with its published tokens, is never called.

## What it will do

| | |
| --- | --- |
| **Reads** | Your property's name, time zone and currency. Its bookable services counted in nights, their room categories and how many rooms each has, the public rates, what is free night by night and each night's price. The reservations it made, to find them again and keep them in step. |
| **Writes** | Each stay, before it is confirmed, with Mews refusing a night it has no room for. A stay that waits for its deposit is held in Mews as *optional*, with a time Mews lets it go by itself. Confirmation once paid; the guest's name and contact only then. Changes and cancellations. A note on each reservation with the stay's reference and what the guest agreed. |
| **Never** | A price: Mews prices each stay from its own rate. A card, or anything that carries one. An email from Mews to your guest: your Inbox writes to them, in your words. |

After each write your Inbox reads back what Mews says the stay comes to. When that differs from what the guest agreed (another rate, another number of guests), you get a note on the stay, so the desk checks the folio before charging anything more.

## How it keeps a room from being sold twice

- **Written first.** A stay is confirmed only after Mews has taken it and said so. If Mews refuses, nothing is promised, and the guest may ask again.
- **Held by Mews itself.** A stay held for a few minutes, or one waiting for its deposit, blocks the room in Mews as an optional reservation. If your Inbox ever fails to let it go, Mews releases it at the time it was given: an hour for a hold, three days at most for a deposit, and never after the arrival.
- **Found again.** Each reservation carries one line in its notes: the stay's reference (*Inbox stay 4F2K9Q*), what the guest agreed, and a tag only your Inbox can make. A reservation Mews let go or cancelled since is never taken for the stay. If Mews takes a stay but its answer is lost, your Inbox finds it by that line, and never writes it twice.
- **A change checked twice.** The new nights are read first, counting the rooms the stay already holds as its own: a night with no room is refused before anything is written, so Mews never shows it oversold to its channels. Read again just after: if another booking took the room in between, the move is put back as it was (its dates, rooms, rate and guests) and refused, and the stay keeps its dates in both places. If Mews will not take it back, you get a note that Mews and your Inbox now hold the stay differently, to set right in Mews.
- **Each room by its kind.** A stay of several rooms is matched room by room by its category and its guests, whatever order Mews lists them in.
- **Cancelled, never deleted.** No cancellation fee is posted in Mews for a cancellation your Inbox makes.

## Limits, and no webhooks yet

Mews allows 200 requests per property token in any 30 seconds. When it asks to wait, your Inbox waits as long as it says, and keeps answering from what it read last.

Mews is read by polling only, for now: what is free over the next two months every 15 minutes, the year ahead every six hours, and the nights of a stay live, just before it is written. Mews sends its webhooks to one address for a whole integration, shared by every property connected to it, while each Inbox connection has an address of its own; webhooks wait for one route that hands each delivery to the property it is about.

## Documentation

- Connector API: <https://docs.mews.com/connector-api/>
- Certification: <https://help.mews.com/s/article/connector-api-certification-what-to-expect>
