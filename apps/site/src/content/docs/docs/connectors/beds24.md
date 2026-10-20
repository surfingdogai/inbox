---
title: Beds24
description: Connect your own Beds24 with an invite code. Your rooms and what is free come in, and each stay is written to Beds24 before anything is promised, so a room is never sold twice.
sidebar:
  order: 10
---

**Being built.** This connector is not in a release yet.

For hotels, guesthouses, B&Bs, hostels and holiday rentals that keep their rooms in Beds24. Your Inbox reads what Beds24 says is free, and writes each stay there first.

Settings → **Property** → **Connect your system** → **Beds24**.

## What it does, and what it never does

- **Your rooms, read once.** You choose which Beds24 property this is, and match each of its rooms to yours, or make them here, named and counted as Beds24 has them.
- **What is free, from Beds24.** Read from your Beds24 calendar every 15 minutes for the next two months, every few hours for the year, and again at the moment a guest's assistant holds or books.
- **A stay is written to Beds24 first.** Your Inbox checks the nights in Beds24, asks Beds24 to refuse them if the room is gone, writes the booking, then reads it back. If another channel took the room in that moment, your Inbox cancels its own booking and nothing is promised: the guest is told the room could not be booked.
- **At your price.** Beds24 does not price bookings an app makes, so each booking carries the total your guest agreed.
- **Cancelled, never deleted.** A cancelled stay is cancelled in Beds24 and stays there, as cancelled, with its history.
- **Guests' details only for confirmed stays,** and only to your own Beds24: their name as they gave it, their email and phone.
- **Never your money.** No card details, no deposit, no commission is ever sent to Beds24.

## Connect

1. In Beds24, open **Settings**, then **Marketplace**, then **API** ([Beds24's API page](https://beds24.com/control3.php?pagetype=apiv2)).
2. Create an invite code with bookings and inventory: read inventory, read properties, all bookings and read bookings personal.
3. In your Inbox, paste it under **Beds24**, then **Connect**. A code works for 24 hours.
4. Choose your property, and match its rooms.

A code's permissions cannot be changed later. For others, make a new code and connect again.

Give every room a price in Beds24: Beds24's calendar says nothing of a room without one, so it is never offered or booked from here until it has one.

## A stay with something to pay now

Beds24's documentation does not say which of its booking statuses keeps a room off sale while a deposit is awaited. So nothing is ever held in Beds24: a stay waiting for its deposit is written as **confirmed**, flagged **Deposit due**, with a note that your Inbox cancels it if it is not paid. Once it is paid, the flag comes off and the guest's details go in.

## Confirming at once

A newly connected Beds24 starts with you answering each request. **Confirm at once from Beds24** can be switched on only after a first stay has been written to Beds24 and read back as written: found again by its own reference, with its dates, room and price.

## Credits

Beds24 gives each account 100 credits every five minutes, shared by everything connected to it. Your Inbox reads the credits Beds24 says are left, never lets a regular read take the last 30, so a guest holding or booking always finds some, and waits as long as Beds24 asks when they run out.

## Changes made in Beds24

Your Inbox's own address for Beds24's booking webhook is coming with the connection's settings. Until then, a change made in Beds24 or on another channel is seen at the next read, within 15 minutes, and always at the moment a guest holds or books.

When you add it, under **Settings → Properties → Access → Booking webhook**: choose the version without personal data, and never send card details. A webhook only tells your Inbox which booking to read again; it is never believed on its own.

## What it reads, and what it writes

| | |
| --- | --- |
| Reads | your properties (name, currency), their rooms (name, how many, how many sleep in one), the calendar (units free, minimum and maximum stay, closed nights, no-arrival and no-departure nights, daily prices), and the bookings your Inbox wrote |
| Writes | one booking per room of each stay (a group for several rooms), with its dates, guests, price, your Inbox's reference and a note; later, its new dates or its cancellation |
| Never keeps | your Beds24 bookings from other channels, or anything of a guest a webhook carries. A webhook is kept as its booking's id and the nights to read again. |

Every call goes to `beds24.com` and nowhere else.

## Disconnecting

Disconnecting gives your Inbox's access back to Beds24 at once. Bookings already written stay in Beds24: they are yours. If you added the webhook, remove it in Beds24.

## Built from

Beds24's [API V2 documentation](https://wiki.beds24.com/index.php/API_V2.0) and its [OpenAPI file](https://beds24.com/api/v2/apiV2.yaml), checked against a local copy of Beds24 that speaks the same paths, never against a real account.
