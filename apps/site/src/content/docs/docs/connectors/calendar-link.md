---
title: Share your bookings
description: A private calendar link to your confirmed bookings, for a booking site's calendar sync, Google Calendar or a phone. When you are booked and for what, never who booked.
sidebar:
  order: 5
---

Your Inbox makes a private link to a calendar of your confirmed bookings. Paste it where another site or app imports a calendar by link: a booking site's calendar sync, Google Calendar, a phone. What your Inbox books then closes that time there too.

With a [calendar link](/docs/calendars/#a-calendar-link) the other way, a guesthouse on two booking sites, or a studio with a second booking page, keeps both sides closed for the same time.

Settings → Integrations → **Share your bookings** → **Make a link**.

## Making the link

1. Press **Make a link**.
2. Press **Copy link** on its line.
3. Paste it where the other site or app imports a calendar by link. Booking sites often call it *Import calendar* or *Sync calendars*; Google Calendar, *From URL*; a phone, *Subscribe*.

Other sites fetch the link from your Inbox's own https address, so it can be made once your Inbox has one: on your own server, set it under Settings → General, **Inbox address**; on a hosted Inbox, once it is live at its own address. Until then the card says **Needs this inbox's address first**.

The link is shown to you, signed in, and to nobody else: not to your AI, and not to keys you gave other systems. Opening the card again shows where it is: **Show my link**.

## What it shows

- **Confirmed bookings**, from 30 days back to 18 months ahead. A cancelled one leaves the calendar; a moved one moves.
- **The service's name and the times.** A booking that covers whole days in your time zone is an all-day event, the way booking sites block nights.
- **Never who booked**, how to reach them, or a price. A calendar link travels: anyone who has it can read it.

Each booking keeps one id for its whole life, so the other side updates it rather than adding it twice. Your Inbox knows those ids for its own: a calendar that copies them back to it blocks nothing twice.

The other side looks again on its own schedule: minutes on some, a few hours on others. Until then, a time just booked here is still open there.

## A new link, or none

- **New link**: the old one stops at once, wherever it was pasted. Paste the new one where the old one was.
- **Disconnect**: the link stops at once.

Your Inbox reads nothing and writes nothing anywhere for this: the link is the whole connection. It follows [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545).
