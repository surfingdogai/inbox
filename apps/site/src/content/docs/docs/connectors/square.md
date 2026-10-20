---
title: Square
description: Connect your own Square account with a token of your own. Busy times and bookings stay in step with Square Appointments, your items come in, and an order you accept is paid at your own Square checkout.
sidebar:
  order: 3
---

**Being built.** This connector is not in a release yet.

For salons, barbers, cafés, restaurants, trades and gyms that run their day on Square. Your Inbox reads your Square, and writes into it what you confirm.

Settings → Integrations → **Square**.

## What it does, and what it never does

- **Busy times come from Square.** What Square would not book (closed hours, time off, a team member already booked) is taken off the times your Inbox offers. Read every few minutes, and at once when Square says a booking changed.
- **A booking you confirm goes into Square**, with whoever Square says is free then, or the team member you chose. Moved or cancelled here, it moves or goes there too.
- **Your customer hears from you once.** Square texts and emails the customer of every booking an app makes. So each booking your Inbox writes is held by one customer record, **Inbox bookings**, under your location's own phone number and with no email: Square's messages reach you. The booking's note says who it is for.
- **Your items come in.** Each variation, priced and counted at the location you choose, on sale while Square sells it there.
- **An order you accept becomes a Square order** with its own link to pay: Square's checkout, in your name, paid into your account. A pickup at its time (or as soon as you can), or a shipment to your customer's address.
- **Nobody pays more than they accepted.** If Square adds the tax you set on an item, the link is held, and you can propose Square's total to your customer, who accepts it or not.
- **Paid means Square said so.** A webhook is checked against its signature, then the order and its payment are read back from Square before anything is marked. Only ids are kept. Your Inbox also asks Square itself every few minutes.
- **What happens in Square follows.** Ready, picked up, shipped (with its tracking) and refunded move the order on here.
- **Never your money.** No card details, no fee (Square's `app_fee_money` is never set), no share. Refunds are made in Square.

## Connect

You make a small app of your own in Square and paste its token. Nobody else's app stands between your Square and your Inbox.

1. Open the [Square Developer Console](https://developer.squareup.com/apps) with your Square login, and create an app. Name it Inbox.
2. In the app: **Credentials** → **Production** → **Production access token** → **Show**. Copy it.
3. In your Inbox: Settings → Integrations → **Square**. Paste it, then **Connect**.
4. Choose your **location**, and who takes bookings: **whoever is free**, or one team member.

A Sandbox token from the same page connects in test mode: only orders made in Test mode get a link.

Square asks for a phone number on every booking. Give your location one in your Square Dashboard, under **Locations**, before you confirm the first.

### Sign in with Square

Only on your own server: make an app in the Square Developer Console, add `https://<your inbox>/oauth/connect/square/callback` as its redirect URL, and set `SQUARE_CLIENT_ID` and `SQUARE_CLIENT_SECRET`. A **Sign in with Square** button then appears beside the token. Square keeps webhook subscriptions for an app's own token, so a sign-in hears of changes by asking every few minutes. On a hosted inbox it says **Soon**.

## Which service a booking goes to

By its name and length: a 45-minute **Haircut** here goes to the 45-minute **Haircut** in Square. If several Square services are as long and none is named the same, choose one in **Change** → **Service**. A service with a cancellation fee cannot be booked by an app; Square says so, and so does your Inbox.

## What it reads, and what it writes

| | |
| --- | --- |
| Reads | your business name; your open locations (name, currency, phone); whether Square Appointments is on, and how it books; your services, their length and who takes them; who is free when; items and variations (name, SKU, price, stock); the orders, payments and refunds of the links it made |
| Writes | bookings, and the one customer record that holds them; orders with their links to pay; one webhook subscription, at your connection's own address |
| Never keeps | your Square customers, or any order or booking it did not make. A webhook is kept as its id, its topic and the ids it names. |

Webhook topics: `booking.created`, `booking.updated`, `order.updated`, `order.fulfillment.updated`, `payment.updated`, `refund.updated`, `catalog.version.updated`, `inventory.count.updated`. A hosted inbox adds the subscription once it is live.

An order carries your customer's name, email, phone (when written with its country code) and address: what fulfilling needs, to your own Square, and nothing more. A booking carries only their name, in its note.

## Limits

- **Square Appointments Free** books as a customer would: only when Square says someone is free, and a booking whose cancellation window has passed is cancelled in Square, by you.
- **Busy times are read for one service**: the one bookings go to, or the shortest. A service only some of your team takes may still be refused at a time Square shows as free for another.
- **Money in hundredths.** A shop in a currency counted otherwise (yen, won) comes in with its items off sale, and gets no links yet. Bookings work.
- **Items are priced by Square.** An item of your catalogue is sold at Square's price; if your Inbox shows another, the link is held.
- **5,000 products** a connection. Past that, the first 5,000 stay and you are told once.

## Disconnect

Settings → Integrations → **Square** → **Disconnect**. The webhook subscription is removed, open links are closed, and your products here are taken off sale (never deleted: an order may name one). Bookings and paid orders stay in Square. The token stays in your app in the Square Developer Console until you delete that app there; a sign-in is given back to Square at once.

## Square's own docs

- [Access tokens](https://developer.squareup.com/docs/build-basics/access-tokens)
- [Bookings API](https://developer.squareup.com/docs/bookings-api/what-it-is) and [creating bookings](https://developer.squareup.com/docs/bookings-api/use-the-api)
- [Catalog search](https://developer.squareup.com/docs/catalog-api/search-catalog-objects)
- [Checkout with an order](https://developer.squareup.com/docs/checkout-api/square-order-checkout)
- [Fulfillments](https://developer.squareup.com/docs/orders-api/fulfillments)
- [Webhook subscriptions](https://developer.squareup.com/docs/webhooks/webhook-subscriptions-api) and [their signatures](https://developer.squareup.com/docs/webhooks/step3validate)
- [OAuth](https://developer.squareup.com/docs/oauth-api/receive-and-manage-tokens)
