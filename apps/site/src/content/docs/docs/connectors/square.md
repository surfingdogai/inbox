---
title: Square
description: Connect your own Square account. Busy times and bookings stay in step with Square Appointments, your items come in, and an order you accept is paid at your own Square checkout.
sidebar:
  order: 3
---

**Being built.** This connector is not in a release yet.

For salons, barbers, cafés, restaurants, trades and gyms that run their day on Square. Your Inbox reads your Square, and writes into it what you confirm.

Settings → Integrations → **Square**.

## What it does, and what it never does

- **Busy times come from Square.** What Square would not book (closed hours, time off, a team member already booked) is taken off the times your Inbox offers. Read every few minutes, and at once when Square says a booking changed.
- **A booking you confirm goes into Square**, with whoever Square says is free then, or the team member you chose. Moved or cancelled here, it moves or goes there too. Through **Sign in with Square** this works on every plan; with an access token, on Appointments Plus or Premium (see [Limits](#limits)).
- **Square never messages your customer.** Square texts and emails the customer of every booking an app makes. So each customer of your Inbox has a record in Square under their name and your location's own phone number, with no email: your Square calendar shows who is coming, and Square's messages reach you.
- **Your items come in.** Each variation, priced and counted at your location, on sale while Square sells it there.
- **An order you accept becomes a Square order** with its own link to pay: Square's checkout, in your name, paid into your account. A pickup at its time (or as soon as you can), or a shipment to your customer's address.
- **Nobody pays more than they accepted.** If Square adds the tax you set on an item, the link is held, and you can propose Square's total to your customer, who accepts it or not.
- **Paid means Square said so.** A webhook is checked against its signature, then the order and its payment are read back from Square before anything is marked. Only ids are kept. Your Inbox also asks Square itself every few minutes. A link is closed only while its order is unpaid.
- **What happens in Square follows.** Ready, picked up, shipped (with its tracking) and refunded move the order on here.
- **Never your money.** No card details, no fee (Square's `app_fee_money` is never set), no share. Refunds are made in Square.

## Connect

**Sign in with Square** comes first where it is offered: one press, on Square's own page. On a hosted Inbox it says **Soon**; until then, you make a small app of your own in Square and paste its token. Nobody else's app stands between your Square and your Inbox.

1. Open the [Square Developer Console](https://developer.squareup.com/apps) with your Square login, and create an app. Name it Inbox.
2. In the app, open **Credentials**, switch to **Production**, press **Show** beside the access token and copy it.
3. In your Inbox: Settings → Integrations → **Square**. Paste it, then **Connect**.
4. If you have more than one location, choose one; and who takes bookings: **whoever is free**, or one team member.

The token opens your whole Square account. Your Inbox only reads your business, items and team, and adds bookings and orders.

A Sandbox token from the same page connects in test mode: only orders made in Test mode get a link.

Square asks for a phone number on every booking. Give your location one in your Square Dashboard, under **Locations**. Until it has one, the location says so in **Change**.

### Sign in with Square

On your own server: make an app in the Square Developer Console, add `https://<your inbox>/oauth/connect/square/callback` as its redirect URL, and set `SQUARE_CLIENT_ID` and `SQUARE_CLIENT_SECRET`. **Sign in with Square** is then the first way to connect. Square keeps webhook subscriptions for an app's own token, so a sign-in hears of changes by asking every few minutes.

## Which service a booking goes to

By its name and length: a 45-minute **Haircut** here goes to the 45-minute **Haircut** in Square. If several Square services are as long and none has the same name, the booking is not added and your Inbox says which: name one in Square as it is here. A service with a cancellation fee cannot be booked by an app; Square says so, and so does your Inbox.

## What it reads, and what it writes

| | |
| --- | --- |
| Reads | your business name; your open locations (name, currency, phone); whether Square Appointments is on, and your plan; your services, their length and who takes them; who is free when; items and variations (name, SKU, price, stock); the orders, payments and refunds of the links it made |
| Writes | bookings, and a customer record for each customer they are for (their name and your location's phone, no email); orders with their links to pay; one webhook subscription, at your connection's own address |
| Never keeps | your Square customers, or any order or booking it did not make. A webhook is kept as its id, its topic and the ids it names. |

Webhook topics: `booking.created`, `booking.updated`, `order.updated`, `order.fulfillment.updated`, `payment.updated`, `refund.updated`, `catalog.version.updated`, `inventory.count.updated`. A hosted inbox adds the subscription once it is live.

An order carries your customer's name, email, phone (when written with its country code) and address: what fulfilling needs, to your own Square, and nothing more. A booking carries only their name, on its customer record and in its note.

## Limits

- **Bookings and your plan.** Square adds bookings from an access token on Appointments Plus or Premium only. On Appointments Free your busy times still come from Square, your Inbox adds no bookings, and its row says why; Sign in with Square adds them on every plan.
- **Bookings you approve.** If Square asks you to accept each booking, the ones your Inbox adds may wait for you in Square too.
- **Busy times are read for one service**: the one most of your team take (the shortest of those), or the shortest the chosen team member takes. A service only some of your team take may still be refused at a time Square shows as free for another.
- **A booking moved** to a time its team member is not free (an overlap with its own old time included) is booked anew with whoever is free, and the old one cancelled after. If Square will not cancel the old one (its cancellation window has closed), the move is not made: move it in Square.
- **Every currency counted in cents, or in none.** Yen, won and other currencies without cents are priced exactly and paid in whole units. A currency counted in thousandths (Kuwaiti dinars) comes in with its items off sale, and gets no links.
- **Items are priced by Square.** An item of your catalogue is sold at Square's price; if your Inbox shows another, the link is held.
- **5,000 products** a connection. Past that, the first 5,000 stay and you are told once.
- **Each sync** asks Square up to three times, for the next 93 days, every five minutes.

## Disconnect

Settings → Integrations → **Square** → **Disconnect**. The webhook subscription is removed, open links are closed, and your products here are taken off sale (never deleted: an order may name one). Bookings and paid orders stay in Square. If you pasted an access token, delete your Inbox app in the Square Developer Console to switch it off; a sign-in is given back to Square at once.

## Square's own docs

- [Access tokens](https://developer.squareup.com/docs/build-basics/access-tokens)
- [Bookings API](https://developer.squareup.com/docs/bookings-api/what-it-is) and [creating bookings](https://developer.squareup.com/docs/bookings-api/use-the-api)
- [Catalog search](https://developer.squareup.com/docs/catalog-api/search-catalog-objects)
- [Checkout with an order](https://developer.squareup.com/docs/checkout-api/square-order-checkout) and [deleting a link](https://developer.squareup.com/docs/checkout-api/manage-checkout)
- [Fulfillments](https://developer.squareup.com/docs/orders-api/fulfillments)
- [Monetary amounts](https://developer.squareup.com/docs/build-basics/common-data-types/working-with-monetary-amounts)
- [Webhook subscriptions](https://developer.squareup.com/docs/webhooks/webhook-subscriptions-api) and [their signatures](https://developer.squareup.com/docs/webhooks/step3validate)
- [OAuth](https://developer.squareup.com/docs/oauth-api/receive-and-manage-tokens)
