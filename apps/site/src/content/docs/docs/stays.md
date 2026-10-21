---
title: A place to stay
description: Hotels, guesthouses, B&Bs, hostels and holiday rentals. Rooms, rates, policies, taxes and fees set once; requests answered with your own total; a stay confirmed at once only where a room cannot be sold twice.
---

Your Inbox takes stays the way a place to stay sells them: nights between two dates, rooms for so many guests, a total with every tax and fee in it, and your own cancellation policy. Guests' assistants ask, quote and book through it; you answer from the app, or let your rules draft the answer for you.

Settings → **Property**, or **A place to stay** in the setup wizard.

## What you set up

- **The place** — what kind it is, the town, the currency, check-in and check-out times, how soon you answer, and how long a quote holds. How long a guest has to pay what is due, and how long a guest's assistant may hold a room, show only where they apply.
- **Rooms** — each kind of room once: how many you have, how many sleep in one, the beds, what is in it. The setup wizard asks a price a night with each, and puts it on a standard plan (room only, free to cancel until 7 days before, nothing now).
- **Plans** — what a stay includes (room only, breakfast…), what cancelling costs (free until a few days before, or non-refundable), and when it is paid: nothing now, the first night, a share, or everything; the rest at the property or some days before arrival.
- **Prices** — a price a night per room and plan, for so many guests, and seasons or weekends that differ.
- **Taxes and fees** — a tourist or city tax, a cleaning fee: per stay, per night, per guest, or a share of the room price, collected with the booking or at the property. Every one is in the total a guest sees.
- **House rules and arrival** — quiet hours, children and pets, how to find you, and the door code, key box or Wi-Fi, which are sealed when saved and sent only to confirmed guests, two days before.

Until you have prices, you type a price for each request in its quote; your taxes and fees are added to it.

## How a stay is confirmed

You choose, and the inbox says it back in one sentence, the same sentence guests' assistants are given.

- **You answer each request** (where everyone starts). A guest asks for dates; you send a quote with your total, your policy dated for those nights, what is due when, and until when it holds. If they accept in time, the room is theirs.
- **Rooms you keep for direct guests.** Close some rooms on your other channels for some nights, then keep them here: Availability → **Nights** → **Keep rooms for direct guests**. Inside those nights a guest's assistant books at once. It saves only once you tick that they are closed everywhere else.
- **Your property system.** Once your system is connected, a stay is written there first. Nothing is confirmed at once until you switch it on, and you can only after a first stay has been written there and read back. See [Property systems](/docs/property-systems/).

A calendar link from another channel (Airbnb, Booking.com, Vrbo) is a hint: the night shows as likely taken and you are asked to look. It never confirms or refuses a stay on its own.

## Money

- Deposits, balances and a card to hold a stay all go through **your own payment account** (Settings → Payments). Each has its own link, sent when it is due; a deposit's link closes when the time to pay ends.
- Paying at the property works everywhere, with nothing to connect. Until a payment account is connected, a plan asks nothing before arrival: its quotes say everything is paid at the property, and you are told why.
- A payment that arrives after the time to pay ended confirms the stay only inside the rooms you keep for direct guests, where nothing can have sold them since (or, with your system connected, once your system takes the stay again). Anywhere else the inbox writes down a refund you owe, with the amount, and refunds nothing itself: you may have sold those nights elsewhere. You refund it from your own account.
- A payment in another currency than the stay's is never counted: it waits for you to look at it.

## Changes and cancellations

A guest asking to change dates sees the new total and what it means to pay or get back before anything is sent to you. A guest cancelling a confirmed stay sees what it costs under your policy, as of now, and confirms it first. You can write down a cancellation made by phone as of when the guest asked; only you, not your AI, can charge less than your policy says.

## Your day

- **Today** (the inbox's first screen): who arrives, with their arrival window, who leaves, who is staying, and what is still to pay at the property.
- **Nights** (Availability): each room type by the next two weeks, with stays, holds, the rooms still free for direct guests, closed nights and other calendars' hints. A place to stay takes nights, not hours: the opening hours appear only once you also offer something booked by the hour.

## What your AI may do

Your own AI may fill in rooms, prices, taxes, fees and extras that guests are not offered yet, read the Nights grid and Today, and draft a quote from your rates. It sends a quote, or says yes to a change, only where a room cannot be sold twice (rooms you keep for direct guests, or your system confirming at once); anywhere else it is kept as a draft for you, since only you can check your other channels. How stays are confirmed, rooms kept for direct guests, policies, deposits, a card to hold a stay and your registration number are yours alone, in the app.

## Your guests' words

Guests are written to in English, Spanish, French, German, Italian or Portuguese: theirs when they gave one, else the first language you chose. Money and dates are written as that language writes them where you are (Spanish in Mexico, Portuguese in Brazil). Japanese, Chinese, Arabic, Turkish, Indonesian and Thai are next; until then those guests read English.

The private arrival details go only in their own email, two days before arrival by default, and only to a confirmed guest: never in a reply, whoever asks for them.

## Your page, as agents read it

Your inbox's front page carries your place as schema.org reads it (the place, its rooms, and a price only where a stay is booked at once, a night with every tax and fee in it). The page itself is not indexed by search engines; the block is there for agents, and for your own site to copy.

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

## UCP Lodging (off for now)

[UCP Lodging](https://ucp.dev/draft/specification/lodging/booking/) is a draft booking standard some AI platforms are starting to use. While it is a draft it is off, and hosted inboxes keep it off. On your own server, `INBOX_UCP_LODGING=on` turns it on (it needs `INBOX_SECRET_KEY`).

It offers only rooms that confirm at once: rooms you keep for direct guests, or rooms your connected system confirms instantly. If you answer each request yourself, your rooms are not offered there, since the standard needs a firm total up front; assistants still reach you as before.

- A platform asks for your rooms and dates and gets your total, every tax and fee in it, with what is paid now, later and at the property, and your cancellation policy for those nights. A tax or fee you collect yourself, and your cancellation terms, are shown to the guest before they book.
- Once the guest gives a name and an email or phone, the room is held for your hold time. Booking confirms the stay, or sends the guest to your own payment page when a deposit or a card is due. No card reaches your inbox, and only you charge.

The stays these sessions make are ordinary stays: they appear in your inbox, follow your rules, and are yours to cancel or change. You keep the lead guest's name and contact and the other guests' names, as on every stay; the ids a platform gives each guest are kept only encrypted, with the session, and go with the stay if you erase the guest.
