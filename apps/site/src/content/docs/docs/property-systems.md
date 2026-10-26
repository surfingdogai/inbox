---
title: Property systems
description: Where your rooms already live. Which systems your Inbox will connect to, what works today, and what a connection does.
---

A property system (a property management system or a channel manager) is where a place to stay keeps its rooms, its calendar and its bookings. Connected, your Inbox reads what is free from it and writes each stay to it first, so a room is never sold twice.

Settings → **Property** → **Connect your system**.

## What works today

**Calendar links, one per room.** Each listing on Airbnb, Booking.com or Vrbo has a calendar link. Add it in Settings → Property → **Calendar links**, choosing which room it is in the same sheet. The nights it shows as taken appear as hints: in the Nights grid, to guests' assistants as *likely taken*, and as a request for you to look. A link lags hours behind, so a hint never confirms or refuses a stay on its own.

**Beds24** (new): [connect with an invite code](/docs/connectors/beds24/).

**Hostaway** (being built, not in a release yet): [connect with your account ID and API key](/docs/connectors/hostaway/).

**Smoobu** (built, switched off until Smoobu's go-ahead): [how it connects, with your API key and secret](/docs/connectors/smoobu/).

## Coming

Each of these is shown as **Soon** until its connection is built and released, and none is described as working before then:

| System | Its developer documentation |
| --- | --- |
| Guesty | <https://open-api-docs.guesty.com/> |
| Mews | <https://docs.mews.com/connector-api/> |
| apaleo | <https://api.apaleo.com/> |
| Cloudbeds | <https://developers.cloudbeds.com/> |

A system that only connects through a partner programme is shown as **Needs setup** until that is in place, with nothing to press.

## What a connection will do

- **Your rooms, read once.** You choose which property in your system this is, and match each of its rooms to yours (or make them here, named and counted as your system has them).
- **What is free, kept fresh.** Read every 15 minutes while stays are near, every few hours otherwise, and asked again at the moment a guest holds or books; if your system does not answer then, the stay is on request. A change your system announces is read again before anything is offered.
- **Stays written there first.** A stay waits until your system has taken it. If it refuses, or another booking took the room a moment before, nothing is promised: the guest is told the room could not be booked, and may ask again. A change of dates is written there before it is made here; if your system refuses it, the stay keeps its dates in both places, never cancelled.
- **Never on an answer it cannot check.** A system that takes a booking even on a full night must say so itself (its own overbooking flag); the inbox reads it back, and takes its own booking back if it oversold, or if it cannot read it back at all.
- **Nothing at once until you say so.** A newly connected system starts with you answering each request. Confirming at once can be switched on only after a first stay has been written and read back, and only while your system's answer is recent (5, 15 or 60 minutes, your choice).
- **Guests' details only for confirmed stays,** and only to your own system: a stay written while its deposit was due is written again as confirmed, with its guest, once paid.
- **The same money and time.** A property here and in your system keep the same currency and time zone; a mapping that differs is refused until they match.

## Building one

Every connection is built against the same contract and checked against a local fake of the system, from the system's own documentation, never with a property's real credentials. The contract and the fake are in the repository (`packages/adapters/test/property/`).
