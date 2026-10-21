---
title: Beds24
description: Connect your own Beds24 with an invite code. Your rooms and what is free come in, and each stay is written to Beds24 before anything is promised, so a room is never sold twice.
sidebar:
  order: 10
---

**New:** built from Beds24's documentation. Your first stays are checked against Beds24 as they are written.

For hotels, guesthouses, B&Bs, hostels and holiday rentals that keep their rooms in Beds24. Your Inbox reads what Beds24 says is free, and writes each stay there first.

Settings → **Property** → **Connect your system** → **Beds24**.

## Connect

1. In Beds24, open **Settings → Marketplace → API** and press **Generate invite code** ([Beds24's API page](https://beds24.com/control3.php?pagetype=apiv2)).
2. Choose these, as Beds24 names them:
   - **Bookings:** Read and Write
   - **Bookings personal:** Read and Write
   - **Bookings financial:** Read and Write
   - **Inventory:** Read
   - **Properties:** Read
3. Leave the IP address empty. If your properties are linked, tick **Allow linked properties**.
4. Paste the code here. It works for 24 hours.
5. Choose your property and match its rooms.

Give every room a daily price in Beds24 (**Prices → Daily Price Rules**): a room without one is never offered or booked from here until it has one.

## What it does, and what it never does

- **Your rooms, read once.** You choose which Beds24 property this is, and match each of its rooms to yours, or make them here, named and counted as Beds24 has them. A room you made here that is not in Beds24 is no longer offered once you connect: match it to keep it.
- **Fees and taxes, the same total.** A room Beds24 adds a cleaning fee or tax to is pointed out: add the same in Taxes & fees, so guests here pay the same total.
- **What is free, from Beds24.** Read from your Beds24 calendar every 15 minutes for the next two months, every few hours for the year, and again at the moment a guest's assistant holds or books.
- **At your Beds24 price.** Guests are quoted a daily price from your Beds24 calendar that is the whole room's for a night: for the room's full capacity, nothing added per extra guest, and no minimum stay, stay length or booking window of its own. The first such one (Daily price 1 before Daily price 2) is used for every night of a stay. A room priced per person, for fewer guests than it sleeps, or only for some stays, is on request: guests ask, and you confirm each one with its price. Beds24 does not price bookings an app makes, so each booking carries the total your guest agreed.
- **A stay is written to Beds24 first.** Your Inbox checks the nights in Beds24, asks Beds24 to refuse them if the room is gone, writes the booking, then reads it back. If another channel took the room in that moment, your Inbox cancels its own booking and nothing is promised: the guest is told the room could not be booked.
- **What was paid, for the front desk.** Each booking says what the guest paid in your Inbox and what is left to pay at the property.
- **Cancelled, never deleted.** A cancelled stay is cancelled in Beds24 and stays there, as cancelled, with its history.
- **Guests' details only for confirmed stays,** and only to your own Beds24: their name as they gave it, their email and phone.
- **Light on Beds24.** It shares your 100 credits per five minutes with your other apps and always keeps some for bookings.
- **Never your money.** No card details, no deposit, no commission is ever sent to Beds24.

If Beds24 also emails guests about new bookings, your Inbox already sends the confirmation: check those auto emails so guests get one, not two.

Stays in a currency with three decimals (such as JOD, KWD or BHD) are not written to Beds24 yet: you confirm those yourself.

## A stay with a deposit due

A stay with a deposit due goes into Beds24 as confirmed, flagged **Deposit due**, so the room is off sale on every channel. If the deposit isn't paid in time, your Inbox cancels it.

## Confirming at once

A newly connected Beds24 starts with you confirming each request. Once a first stay has gone into Beds24 and been read back, you can switch on **Confirm at once when your system says a room is free**. If Beds24 adds a cleaning fee or tax to your rooms, you first say they are covered in Taxes & fees.

## Changes made in Beds24

Changes made in Beds24 or on another channel are picked up within 15 minutes, and checked again the moment a guest books.

## What it reads, and what it writes

| | |
| --- | --- |
| Reads | your properties (name, currency), their rooms (name, how many, how many sleep in one, fees and taxes set on them, each daily price's rule and the offer that sells it), the calendar (units free, minimum and maximum stay, closed nights, no-arrival and no-departure nights, daily prices), how many bookings each room has on a stay's nights, and the bookings your Inbox wrote |
| Writes | one booking per room of each stay (a group for several rooms), with its dates, guests, price, your Inbox's reference, a note, and what was paid; for a confirmed stay, the guest's name, email and phone; later, its new dates or its cancellation |
| Never keeps | your Beds24 bookings from other channels, or their guests |

Every call goes to `beds24.com` and nowhere else.

## Disconnecting

Disconnecting gives your Inbox's access back to Beds24 at once. Bookings already written stay in Beds24: they are yours.

## Built from

Built from Beds24's [API V2 documentation](https://wiki.beds24.com/index.php/API_V2.0) and [OpenAPI file](https://beds24.com/api/v2/apiV2.yaml).
