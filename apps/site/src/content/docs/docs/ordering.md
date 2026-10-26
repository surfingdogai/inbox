---
title: Restaurants, bakeries and cafés
description: Your menu with its options and allergens, orders to collect or have delivered at a time your kitchen can make, the pause, tables by covers, and the ordering system or till you already run.
---

A customer's assistant can read your menu, pick a time your kitchen can make, choose a size and a crust, ask for no onions, and add a tip, then place the order with you. You set the prices, what each option adds, how many orders a slot takes, and what your dishes contain. Nobody takes a share of an order, and you are paid on your own payment link.

Settings → **Menu** and **Kitchen**. Setting up a restaurant, a bakery or a café asks for your first dishes, with their prices: add the rest, and their allergens, in Settings → Menu.

## Your menu

- **A dish**: **+ A dish** at the foot of a section, its name and price, then the rest in its editor. It is a product like any other, so Settings → Services → Products lists it too.
- **Sections**, in your order: Starters, Pizzas, Drinks.
- **Options** on a dish: a size, a crust, a milk, extras. Each group says whether it is required and how many may be chosen, and each choice what it adds. A choice can open one other group (a large pizza opens its crust). A group can take **halves**, for half-and-half, with a half price of its own where you want one. What each option adds is always the menu's, whatever an assistant sends.
- **When it is made**: the days of the week, how far ahead it must be ordered (a birthday cake: 2 days), a **daily limit** for what you set aside, and **made to order** for something made for one customer. Made-to-order dishes come to you to decide, and are not returnable.
- **An age limit**, for alcohol.
- **Dietary tags**: vegan, vegetarian, gluten free and the rest. A tag the dish's own allergens contradict cannot be chosen: gluten free on a dish that contains wheat, or may.
- **Sold out today**: one press beside the dish. It is back on tomorrow by itself.
- **Returns**: a dish on the menu does not keep, so it is not returnable; your customers are told so before they order, and in their emails. A table is for a set date, and the same holds.

You can start from the menu in your ordering system: Settings → Menu → **Bring in your menu**, then tick the dishes to keep. Your prices stay as your system has them. Bringing a dish in again takes its name, price and options from your system and keeps everything you set here: its limits, days, notice and allergens.

## Allergens

What a dish **contains**, and what it **may contain** from shared kitchens or oil, pressed in a grid. Where you are decides which come first: the fourteen in the EU and the UK, the nine in the US, Canada's, Australia and New Zealand's, Japan's. Every one of the 46 is under **All**, with each nut and cereal.

- **Never guessed.** Your Inbox never reads a dish's name for allergens. Lists brought in from your ordering system, or written by your assistant, arrive **not confirmed**.
- **Only you or your staff confirm**, in the app: **Confirm allergens**, then **Confirm, as shown**. Your assistant cannot, and neither can another system's key. Changing a dish's allergens, or a choice's, makes them not confirmed again, and a confirm never holds for lists someone changed while you looked.
- **Not confirmed means ask.** Assistants tell people to ask you, never that a dish is free from anything, and an order with such a dish waits for you to accept it.

## Orders for a time

Switch on **Take orders for a time**, then choose:

- **How people get it**: collection, delivery, eating in.
- **Ready at the earliest in**: the first time offered is at least that far off.
- **Slots** of 10, 15, 30 or 60 minutes inside your opening hours, and **orders per slot**, kept for orders from agents: walk-ins and your till are separate. A slot is never sold twice: of two assistants asking for its last place, one gets it and the other is told that time is full.
- **How far ahead** people may order.
- **Who accepts**: you accept each order (where every kitchen starts), or orders inside what you set aside are accepted at once. Anything else waits for you: a full slot, a dish past its daily limit, something made to order, allergens you have not confirmed. Accept one past a dish's daily limit and the rest of that day's limit goes to it, so the orders after it wait for you too.
- **Tips**: people may add one, from the choices you pick, on your own payment link.

### Delivery zones

Settings → Kitchen → **Delivery zones**, inside out: an address goes in the first zone it falls in. Each zone is a distance from your premises or a set of postal codes, with its delivery fee, a minimum order and how long it is on the road. An address outside every zone is told you do not deliver there. Your own drivers deliver: your Inbox never calls a courier.

### The pause

Busy? On the inbox's home, **Pause** for 15, 30 or 60 minutes or the rest of today, and **Resume**. Anyone at the business can press it, on a phone too. Assistants are told when you take orders again. With Flipdish connected, Settings → Kitchen → **Pause** → **Close my Flipdish store too while paused** closes the store you chose for the same time; resuming opens only what the pause closed, never a closure you set in Flipdish.

### How far an order is

On today's orders, and on each order: **Start preparing**, **Mark ready**, and for a delivery **Out for delivery**. The customer's assistant sees it. An order for another day says its day ("Tomorrow, 08:00"), and with nothing left today the kitchen card names the next day that has orders.

## Tables

Settings → Kitchen → **Tables**, on a service such as *Dinner*: book it **by covers**, with the largest party, a request for a price above a party size, a **deposit per person** from a party size, and the **covers set aside** for bookings through here. A party that fits in what is left of those covers, in a free sitting, is confirmed at once; a larger one, and every table when none are set aside, comes to you, and you seat it from the whole room.

## Bakeries and cafés

A bakery's cakes can ask for the writing on them, how many it serves and a flavour, and a photo of what it should look like. A café's orders ahead come in slots of 10 minutes, and a pastry can be sold out today with one press.

## Which tills

| System | How it connects | What it does | Its developer documentation |
| --- | --- | --- | --- |
| GloriaFood | Your own keys, from its admin panel: Others → 3rd party integrations | Your menu, to start from. Orders accepted in GloriaFood, shown to you only if you switch it on, with no customer details | <https://github.com/GlobalFood/integration_docs> |
| Flipdish | An app you make in your own Flipdish account: its client ID and secret | Your menu and collection hours, to start from; your store closed while you pause | <https://developers.flipdish.com/docs/api-overview> |
| Toast | **Not yet**: a Toast partner app on the server | Your menu, and orders you accept written into your till | <https://doc.toasttab.com/openapi/> |
| Lightspeed Restaurant (K-Series) | **Not yet**: a Lightspeed partner app | Your menu by location, and orders you accept as to-go orders | <https://api-docs.lsk.lightspeed.app/> |
| Clover | **Not yet**: a Clover App Market app | Your menu, and orders you accept as Clover orders | <https://docs.clover.com/dev/docs/create-an-atomic-order> |
| Deliverect | **Not yet**: a certified Deliverect channel, and the webhook secret from its Integration settings | Orders you accept into your Deliverect channel, and its word on how far they are | <https://developers.deliverect.com/v3.0-ordering-experience/docs/channel-api-overview> |

Nothing to press shows a button that goes nowhere: a system that needs its partner app on the server says **not yet** until it is there; until then, GloriaFood and Flipdish connect with what you make in your own account. On your own server: `TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET` and `TOAST_API_HOST`; `LIGHTSPEED_CLIENT_ID` and `LIGHTSPEED_CLIENT_SECRET`; `CLOVER_CLIENT_ID` and `CLOVER_CLIENT_SECRET`; `DELIVERECT_CLIENT_ID`, `DELIVERECT_CLIENT_SECRET` and `DELIVERECT_CHANNEL` (with `DELIVERECT_STAGING=1` against its staging).

## What a connection does

- **Your menu, to start from.** Read when you ask, never changed on its own. Allergens come in not confirmed.
- **Orders you accept, once.** An order goes into your till when you accept it, or once it is paid when it goes through your payment link, never twice: a retry or a lost answer finds the one already there, or is answered by your till as the same order. Where neither holds (Clover), an order whose answer never came is left for you to check there, and you are told.
- **Nothing left out.** A dish or a choice your till does not know is not sent without it: the order is marked for you to put in by hand.
- **Your till's word.** Accepted or refused in your till comes back as a note on the order; Deliverect's progress becomes the order's. An order cancelled here after it went in is marked for you to cancel it in your till too.
- **No card data, no courier, no marketplace.** Payment stays on your own payment link, delivery with your own drivers.

## Building one

Every ordering system is built from its published reference and checked against a local fake of it (`packages/adapters/test/fakes/pos.ts`), never with a business's real account. Decisions: [ADR-036](https://github.com/surfingdogai/inbox/blob/main/docs/adr/036-food.md).
