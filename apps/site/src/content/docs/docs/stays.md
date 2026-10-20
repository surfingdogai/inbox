---
title: A place to stay
description: Hotels, guesthouses, B&Bs, hostels and holiday rentals. Rooms, rates, policies, taxes and fees set once; requests answered with your own total; a stay confirmed at once only where a room cannot be sold twice.
---

Your Inbox takes stays the way a place to stay sells them: nights between two dates, rooms for so many guests, a total with every tax and fee in it, and your own cancellation policy. Guests' assistants ask, quote and book through it; you answer from the app, or let your rules draft the answer for you.

Settings → **Property**, or **A place to stay** in the setup wizard.

## What you set up

- **The place** — what kind it is, the currency, check-in and check-out times, how soon you answer, how long a quote holds and how long a guest has to pay what is due.
- **Rooms** — each kind of room once: how many you have, how many sleep in one, the beds, what is in it.
- **Plans** — what a stay includes (room only, breakfast…), what cancelling costs (free until a few days before, or non-refundable), and when it is paid: nothing now, the first night, a share, or everything; the rest at the property or some days before arrival.
- **Prices** — a price a night per room and plan, for so many guests, and seasons or weekends that differ.
- **Taxes and fees** — a tourist or city tax, a cleaning fee: per stay, per night, per guest, or a share of the room price, collected with the booking or at the property. Every one is in the total a guest sees.
- **House rules and arrival** — quiet hours, children and pets, how to find you, and the door code, key box or Wi-Fi, which are sealed when saved and sent only to confirmed guests, two days before.

Until you have prices, every request waits for your own quote.

## How a stay is confirmed

You choose, and the inbox says it back in one sentence, the same sentence guests' assistants are given.

- **You answer each request** (where everyone starts). A guest asks for dates; you send a quote with your total, your policy dated for those nights, what is due when, and until when it holds. If they accept in time, the room is theirs.
- **Rooms you keep for direct guests.** Close some rooms on your other channels for some nights, then keep them here: Availability → **Nights** → **Keep rooms for direct guests**. Inside those nights a guest's assistant books at once. It saves only once you tick that they are closed everywhere else.
- **Your property system.** Once your system is connected, a stay is written there first. Nothing is confirmed at once until you switch it on, and you can only after a first stay has been written there and read back. See [Property systems](/docs/property-systems/).

A calendar link from another channel (Airbnb, Booking.com, Vrbo) is a hint: the night shows as likely taken and you are asked to look. It never confirms or refuses a stay on its own.

## Money

- Deposits, balances and a card to hold a stay all go through **your own payment account** (Settings → Payments). Each has its own link, sent when it is due; a deposit's link closes when the time to pay ends.
- Paying at the property works everywhere, with nothing to connect.
- If a payment arrives after the stay lapsed and the nights went to someone else, the inbox writes down a refund you owe, with the amount, and refunds nothing itself. You refund it from your own account.

## Changes and cancellations

A guest asking to change dates sees the new total and what it means to pay or get back before anything is sent to you. A guest cancelling a confirmed stay sees what it costs under your policy, as of now, and confirms it first. You can write down a cancellation made by phone as of when the guest asked; only you, not your AI, can charge less than your policy says.

## Your day

- **Today** (the inbox's first screen): who arrives, with their arrival window, who leaves, who is staying, and what is still to pay at the property.
- **Nights** (Availability): each room type by the next two weeks, with stays, holds, rooms kept for direct guests, closed nights and other calendars' hints.

## What your AI may do

Your own AI may fill in rooms, prices, taxes, fees and extras that guests are not offered yet, read the Nights grid and Today, and draft a quote from your rates. How stays are confirmed, rooms kept for direct guests, policies, deposits, a card to hold a stay and your registration number are yours alone, in the app.

## If you take bookings elsewhere already

If your booking engine is where stays should go, keep them there. For now this is a settings write over the [API](/docs/api/), with your owner key; the app's screen for it comes later:

```json
{"doc": {"doorsElsewhere": [{
  "itemType": "stay",
  "url": "https://engine.example.net/your-place",
  "urlTemplate": "https://engine.example.net/your-place?in={check_in}&out={check_out}&adults={adults}"
}]}}
```

Guests' assistants are then sent to your engine with the dates they asked for filled in (`{check_in}`, `{check_out}`, `{adults}`, `{children}`, `{rooms}`). Your own AI cannot change this: it sends your guests to another address.
