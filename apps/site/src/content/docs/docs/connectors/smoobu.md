---
title: Smoobu
description: Connect Smoobu with your own API key and secret. Your apartments and free nights come in, every booking goes into Smoobu first, and your Inbox never takes a card, sets a price or charges a commission.
sidebar:
  order: 12
---

Smoobu keeps your apartments, their calendars and your bookings. Connected, your Inbox reads what is free from Smoobu and puts every booking into Smoobu first, so a night is never sold twice.

Smoobu is in Settings → **Integrations** → **Property system**. If it says **Soon**, your Inbox does not have it yet, or it is waiting on Smoobu's go-ahead: Smoobu asks software that connects many accounts to get in touch first.

## Connect it

1. Open Smoobu → **Settings → Advanced → API Keys → Create API Key**. Name it **Inbox**.
2. Press **Generate Secret**, and copy the **API key** and the **API secret**. Smoobu shows the secret only once.
3. In your Inbox: Settings → **Integrations** → **Property system** → **Smoobu**. Paste both and press **Connect**. They are checked with Smoobu first, then sealed: never shown again, to you or to your AI.
4. In Settings → **Property**, press **Choose the property**, pick yours from Smoobu, and match each apartment to a room, or let your Inbox make the rooms with Smoobu's names.

At first you answer every request yourself. Once a first stay has been written to Smoobu and read back, you can switch on confirming at once.

## What it reads

- **Each apartment is a room, of one.** Apartments that share a currency, a time zone and a town are one property here. Three rooms in Jaipur and a cottage in Udaipur show as two: *Jaipur · 3 apartments*, and the cottage by its own name.
- **Who it sleeps, and its beds.** Smoobu says how many an apartment sleeps, not how many may be children, so all but one guest may be. Change it on the room if that is wrong.
- **Every night, as its rates have them.** Free or taken, its minimum stay, and its nightly price, as one rate: *Smoobu's nightly price*.
- **In the apartment's own currency.** Prices stay exactly as Smoobu has them. One with more decimals than its currency allows is not offered.
- **An apartment missing from the list** has no currency in Smoobu yet: give it one there. Your Inbox reads up to 200 apartments from one account.

## What it writes

- **Checked first, read back after.** Just before each booking, your Inbox asks Smoobu whether the nights are free and whether its rules (minimum stay, guests) take the stay. Right after, it reads the bookings on those nights, blocked periods and grouped apartments included. If another channel took a night in that moment, your Inbox cancels its own booking and nothing is promised to the guest.
- **As a Homepage booking,** Smoobu's default channel for bookings made through its API, at the price your Inbox quoted.
- **The guest's name, email, phone and requests** go only once the stay is confirmed, and only to Smoobu.
- **The booking's notes** start with a line like *Direct booking · ref HR4K2Q [#01J…]*, in your Inbox's language, or English. Leave that first line: it is how a booking is found again after an answer that never came, so the same stay is never written twice. If you rewrite the notes, your Inbox leaves them as you wrote them.
- **No hold.** Smoobu documents none. A stay with its deposit still due is an ordinary booking, marked *deposit due* in its notes, which keeps its nights until it is paid or cancelled.
- **Never** a card, a payment or deposit status, a fee or a commission.

**Check your Smoobu automations.** Messages or emails you set up for Homepage bookings will run for these too. A confirmed booking goes into Smoobu with the guest's details before your Inbox has read it back, so in the rare moment another channel takes the same night, Smoobu may write to the guest before your Inbox cancels its booking.

If your Smoobu booking form requires names, a stay whose deposit is still due has none yet: Smoobu refuses it, and the stay stays a request for you to answer.

## Changes and cancellations

- **Guests, the price and the guest's details** are changed in Smoobu too.
- **Other nights or another apartment.** Smoobu does not let another system move a booking, so the change is refused and the stay keeps its nights in both places. Change it in Smoobu and in your Inbox.
- **A booking you move or cancel in Smoobu** frees or takes its nights in your Inbox at the next read, but the stay in your Inbox keeps its dates and stays confirmed. Change or cancel it in your Inbox as well.
- **Cancelling** uses Smoobu's own cancellation, which keeps the booking in Smoobu as cancelled. If Smoobu does not take it, you are told on the stay: cancel it in Smoobu.

## What it hears

- **One webhook, made for you.** Connecting registers your Inbox's address with Smoobu, with a second secret made for this connection alone. You add nothing. If your Inbox moves to its own domain, the webhook moves with it.
- **Only what it needs.** Smoobu sends every event to every address. Your Inbox reads booking and rate events for your account and leaves the rest.
- **A hint, never the truth.** A webhook says which booking or nights changed; your Inbox reads them again from Smoobu.

## Disconnecting

The webhook is removed. To end it in Smoobu too, delete the key in **Settings → Advanced → API Keys**. Bookings already written stay in Smoobu: they are yours.

## Not yet

- A stay of several rooms. Smoobu keeps one apartment per booking, so the guest asks for each room on its own.
- Guest messages from Smoobu in your Inbox.
- A stay that follows a booking moved or cancelled in Smoobu (see above).

## For developers

**Limits.** Smoobu takes 700 requests a minute. `X-RateLimit-Retry-After` is the window's end as a Unix time, and your Inbox waits until then when asked. The list of apartments is read live; their details are kept from a refresh for twelve hours; a quote reads two apartments, never the whole account.

**Signing.** Every request carries `X-API-Key`, `X-Timestamp`, a one-time `X-Nonce` and `X-Signature`, as Smoobu documents them. The older `Api-Key` header stops working on 31 October 2026 and is never sent.

**Switched off until Smoobu's go-ahead.** `SMOOBU_READY` in `packages/adapters/src/connectors/property/smoobu.ts` is false in this release, so the gallery shows **Needs setup** with nothing to press. Smoobu's reference asks anyone whose software serves more than one Smoobu user to contact it first. Still to confirm with Smoobu: whether webhook deliveries are signed; whether `from` and `to` on the bookings list mean overlap or arrival (the read-back covers both); what a failed sign-in looks like from `checkApartmentAvailability` (taken as the key, never as a full night); and whether channel 70 (Homepage) or 13 (Direct booking) suits these bookings.

**How it was built.** From Smoobu's API reference, <https://docs.smoobu.com/>, as it read on 20 October 2026, and checked against a local fake of Smoobu built from it, never against a real account. The adapter, its fake and the excerpt behind each recorded answer are in the repository (`packages/adapters/src/connectors/property/smoobu.ts`, `packages/adapters/test/`). See [Property systems](/docs/property-systems/) for what every connection does.
