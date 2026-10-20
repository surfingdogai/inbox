---
title: Smoobu
description: Connect Smoobu with your own API key and secret. Your apartments and what is free come in, each stay is written to Smoobu before it is confirmed, and your Inbox never takes a card, sets a price or charges a commission.
---

Smoobu keeps your apartments, their calendars and your bookings. Connected, your Inbox reads what is free from Smoobu and writes each stay there first, so a night is never sold twice.

Smoobu shows in Settings → **Integrations** → **Property system** once your Inbox runs a release that includes it. Until then it says **Soon**. A server can also hold it back while its operator is in touch with Smoobu, which asks to hear from anyone whose software connects many accounts: it then says **Needs setup** beside a system that is ready, or **Soon**, and has nothing to press.

## Connect it

1. In Smoobu: **Settings → Advanced → API Keys → Create API Key**. Name it after your Inbox.
2. Press **Generate Secret**, and copy the **API key** and the **API secret**. Smoobu shows the secret only once.
3. In your Inbox: Settings → **Integrations** → **Property system** → **Smoobu**. Paste both and press **Connect**. They are checked with Smoobu before anything is kept, and both are sealed: never shown again, to you or to your AI.
4. In Settings → **Property**, press **Choose the property**: choose which property in Smoobu is yours, and match each apartment to one of your rooms, or make the rooms here, named as Smoobu has them.

Nothing confirms at once yet. You answer each request until you switch confirming at once on, and you can only once a first stay has been written to Smoobu and read back.

## What it reads

- **Each apartment is a room, of one.** The apartments that share a currency, a time zone and a town are one property here. An account with three rooms in Jaipur and a cottage in Udaipur shows two: *Jaipur · 3 apartments* and the cottage by its own name. An apartment with no currency yet is left out.
- **Who it sleeps, and its beds.** Smoobu says how many people an apartment sleeps, not how many may be children, so any of them but one may be. Change it on the room if you need to.
- **Every night, as its rates have them.** Free or taken, its minimum stay, and its nightly price, as one rate, *Smoobu's nightly price*. Read every 15 minutes while stays are near, every few hours otherwise, and again the moment a guest holds or books.
- **Money in each currency's own unit.** ₹6,500.50 is 650050 paise, TSh 185,000 is 18500000 cents, C$214.50 is 21450 cents. A price with a part smaller than its currency's unit is not offered.

## What it writes

- **Checked first, read back after.** Just before each booking, your Inbox asks Smoobu whether the nights are free and whether its own rules (minimum stay, guests) take the stay. Right after, it reads the bookings on those nights, blocked periods and grouped apartments included. If another channel took a night in that moment, your Inbox cancels its own booking at once and nothing is promised to the guest.
- **On Smoobu's default channel,** at the price your Inbox quoted, in the apartment's own currency. A stay in another currency is not written. The guest's name, email, phone and requests go only once the stay is confirmed, and only to Smoobu.
- **Your booking's notes.** Each booking's notes read like *Direct booking · ref HR4K2Q [sd-…]*, in your Inbox's language. Leave the part in brackets: it is how a booking is found again after an answer that never came, so the same stay is never written twice. If you rewrite the notes, your Inbox leaves them as you wrote them.
- **No hold.** Smoobu documents none. A stay with its deposit still due is an ordinary booking, marked *deposit due* in its notes, which keeps its nights until it is paid or cancelled.
- **Changes.** Guests, the price and the guest's details are written to Smoobu. Smoobu does not let another system move a booking to other nights or another apartment: such a change is refused, the stay keeps its nights in both places, and you make it in Smoobu, where your Inbox reads it back.
- **Cancellations.** With Smoobu's own cancellation, which keeps the booking in Smoobu as cancelled. If Smoobu does not take one, you are told on the stay: cancel it in Smoobu.
- **Never** a card, a payment or deposit status, a fee or price element of its own, or a commission.

If your Smoobu booking form requires names, a stay whose deposit is still due has none yet, so Smoobu refuses it and the stay stays a request for you to answer.

## What it hears

- **One webhook, made for you.** Connecting registers your Inbox's own address with Smoobu, with a second secret on it made for this connection alone, sealed and never shown. You add nothing. If your Inbox moves to its own domain, the webhook moves with it.
- **Only what it needs.** Smoobu sends every event to every address. Your Inbox reads booking and rate events for your own account, and answers the rest (messages, online check-in, price elements) without reading them.
- **A hint, never the truth.** A webhook says which booking or which nights changed; your Inbox reads them from Smoobu with your key. One that comes twice, or before the one it follows, changes nothing.

## Limits

Smoobu takes 700 requests a minute. Every answer says how many are left; your Inbox keeps some for guests who are booking, and when Smoobu asks it to wait, it waits until the minute Smoobu gives. Meanwhile guests' assistants are answered from what was read last, and nothing is confirmed at once on nights that were not read recently.

## Signing

Every request is signed with your key and secret as Smoobu documents it: a timestamp, a one-time value and a signature over the request. Smoobu's older single-key header stops working on 31 October 2026 and is never used.

## Disconnecting

The webhook is removed. To end it in Smoobu too, delete your Inbox's key in **Settings → Advanced → API Keys**. Bookings already written stay in Smoobu: they are yours.

## Not yet

- A stay of several rooms. Smoobu keeps one apartment per booking, so a stay of several apartments is not written there and is not booked; the guest can ask for each room on its own.
- Guest messages from Smoobu in your Inbox.

## How it was built

From Smoobu's API reference, <https://docs.smoobu.com/>, as it read on 20 October 2026, and checked against a local fake of Smoobu built from that reference, never against a real account. The adapter, its fake and the excerpt behind each recorded answer are in the repository (`packages/adapters/src/connectors/property/smoobu.ts`, `packages/adapters/test/`). See [Property systems](/docs/property-systems/) for what every connection does.
