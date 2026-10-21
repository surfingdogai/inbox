---
title: Hostaway
description: Connect Hostaway with your own account ID and API key. Your listings and free nights come in, every booking goes into Hostaway first, and your Inbox never takes a card, sets a price or charges a commission.
sidebar:
  order: 11
---

Hostaway keeps your listings, their calendars and your reservations. Connected, your Inbox reads what is free from Hostaway and puts every booking into Hostaway first, so a night is never sold twice.

Settings → **Integrations** → **Property system** → **Hostaway**. If Hostaway says **Soon**, your Inbox hasn't been updated yet. Hosted inboxes get it with the next update.

## Connect it

1. Open Hostaway → **Settings → Hostaway API → Create**. Name it **Surfing Dog Inbox** and pick **Hostaway Public API** as the partner.
2. Copy the **account ID** and the **API key**. The key is shown only once.
3. In your Inbox: Settings → **Integrations** → **Property system** → **Hostaway**. Paste both and press **Connect**. The key is sealed: it is never shown again, to you or to your AI.
4. In Settings → **Property**, press **Choose the property**: pick your property in Hostaway and match each listing to one of your rooms, or make the rooms here, named as Hostaway has them.

## Good to know

- **One listing is one room.** Listings in the same town, currency and time zone are one property: flats in Osaka and in Tokyo are two.
- **A stay of several rooms** is one reservation per room in Hostaway, written whole or not at all: if one room cannot be booked, the others are cancelled again.
- **Every booking goes into Hostaway first.** Your Inbox checks the nights in Hostaway just before, and right after. If another channel took a night in that moment, your Inbox cancels its own reservation and the guest is told it did not go through.
- **At first you confirm each booking yourself.** Instant booking can be switched on once one booking has gone into Hostaway and come back.
- **Some things are done in Hostaway.** A change of room, a room added to or taken from a booked stay, and a cancellation Hostaway does not take: you are told on the stay.
- **Never a card, a price or a commission.** The guest pays you, at the price you set.

**Check your Hostaway automations.** Bookings from your Inbox are direct bookings in Hostaway, with the guest's email once confirmed. If Hostaway sends messages or payment requests for direct bookings, the guest may get them too, including a request to pay for a stay already paid through your Inbox. A confirmed booking goes into Hostaway with the guest's details before your Inbox has read it back, so in the rare moment another channel takes the same night, Hostaway may write to the guest before your Inbox cancels its booking. Look at Hostaway's automated messages and payment rules for the direct channel.

<details>
<summary>How it works in detail</summary>

### What it reads

- **Your listings.** Archived listings, and listings with no currency or time zone yet, are left out. A property keeps its first listing, with that listing's currency and time zone: if its town is renamed, the property stays. If that first listing is archived, or its currency or time zone changes in Hostaway, you are asked to choose the property again, so a night is never priced in the wrong money.
- **Every night, as the calendar has it.** Free, taken (by a reservation from any channel) or closed, its minimum and maximum stay, and whether arrival or departure is closed that day. Read every 15 minutes while stays are near, every few hours otherwise, and again the moment a guest holds or books.
- **Its nightly price,** as one rate, *Hostaway's nightly price*, less any weekly or monthly discount Hostaway gives a stay. A price with a part smaller than its currency's unit (24,900.5 kr.) is not offered: round it in Hostaway.

### What it writes

- **A direct booking.** Each room of a stay is a reservation on Hostaway's direct channel, with **Surfing Dog Inbox** as its source, at its share of the price your Inbox quoted. The guest's name, email, phone and requests go only once the stay is confirmed.
- **Your host note.** Each reservation's host note reads like *Booked direct via Surfing Dog Inbox · ref HB7Q2K [sd-…]*, with *room 1 of 2* for a stay of several rooms. Leave the part in brackets: it is how a booking is found again after an answer that never came, so the same stay is never written twice.
- **No hold.** A stay with its deposit still due is an ordinary reservation, marked *deposit due* in its note. It keeps its nights until it is paid or cancelled.
- **Changes of dates** go into Hostaway before they are made here. If Hostaway does not take them, the stay keeps its dates in both places.
- **Cancellations** are made as the host and never deleted. A reservation cancelled in Hostaway is never booked again over it.
- **Never** a card, a payment, a fee or tax line of its own, a commission, or Hostaway's option to ignore its overbooking protection.

### What it hears

- **One webhook, made for you,** at your Inbox's own address, with a login and password made for it alone. You add nothing. Hostaway disables a webhook that fails for five days running; your Inbox turns it back on.
- **A hint, never the truth.** A webhook says which reservation changed; your Inbox reads that reservation and its nights from Hostaway itself. Guest messages stay in Hostaway.

### Limits

When Hostaway asks your Inbox to wait, it waits until the time Hostaway gives, and twice as long each time it is asked again soon after. Meanwhile, guests' assistants are answered from what was read last, and nothing confirms at once on nights not read recently.

</details>

## Disconnecting

The webhook is removed and the access is given back. To end it in Hostaway too, delete the **Surfing Dog Inbox** key in **Settings → Hostaway API**. Reservations already written stay in Hostaway: they are yours.

## Not yet

- **A multi-unit listing** is sold one unit at a time.
- **Guest messages** from Hostaway in your Inbox.

Built from Hostaway's public API reference, <https://api.hostaway.com/documentation>, and tested against a local copy of it; not yet tried on a live account. See [Property systems](/docs/property-systems/) for what every connection does.
