---
title: Shopify
description: Connect your own Shopify shop with an app you make for it. Your products come in; a quote or order you accept becomes a draft order, paid at your own Shopify checkout. Shopify keeps your cart and checkout; your Inbox adds messages, quotes and receipts.
sidebar:
  order: 2
---

**Being built.** This connector is not in a release yet.

Shopify already lets assistants shop your cart and pay at your checkout. Your Inbox adds what Shopify does not: questions, quotes and bookings in one place, and a signed receipt for each one. Agents are sent to your Shopify checkout to buy, and to your Inbox for the rest.

Settings → Integrations → **Shopify**.

## What it does, and what it never does

- **Your products come in.** Every variant, priced in your shop's currency, in stock when Shopify counts it, on sale when its product is active. Read again every few minutes, in full every six hours, and at once when Shopify says a product changed.
- **An accepted quote or order becomes a draft order** in your shop, at the prices your customer accepted. The draft's own checkout is the link to pay: your customer pays on Shopify, to you, with your payment methods.
- **Your customer hears from you once.** Your Inbox emails the link in your name. It never asks Shopify to send its invoice email too.
- **Nobody pays more than they accepted.** A delivery fee is a line of the order, so the checkout adds no rate on top, and no discount code. If your shop adds tax at checkout, the link is held, and you can propose the shop's total to your customer, who accepts it or not.
- **Paid means Shopify said so.** A webhook is checked against your app's signature, then the order is read back from Shopify before anything is marked. Only ids are kept, never what Shopify sent about your customer. Your Inbox also asks Shopify itself every few minutes.
- **What happens in Shopify follows.** Paid, fulfilled (with its tracking), delivered and refunded move the order on here. A draft you delete in Shopify before it is paid closes its link, and the order waits for you.
- **Never your money.** No card details, no fee, no share. Refunds are made in Shopify.

## Connect

You make a small app for your own shop in Shopify's Dev Dashboard, and paste its two keys. Nobody else's app stands between your shop and your Inbox.

1. Open the [Dev Dashboard](https://dev.shopify.com/dashboard/) with the account that owns your shop. **Create app** → **Start from Dev Dashboard**. Name it after your Inbox, then **Create**.
2. **Versions**: set **App URL** to `https://shopify.dev/apps/default-app-home`, choose the newest **Webhooks API version**, and tick the scopes `read_products`, `read_orders` and `write_draft_orders`. **Release**.
3. **Install app** (on the **Installs** card), choose your shop, **Install**.
4. **App settings** → **Credentials**: copy the **Client ID** and the **Client secret**.
5. In your Inbox: Settings → Integrations → **Shopify** → **Your app's keys**. Your shop's address (it ends in `.myshopify.com`, under Settings → Domains in Shopify; your admin's address works too), the Client ID and the Client secret. **Connect**.

The app and your shop must be in the same Shopify organization, which they are when you make the app yourself. Your Inbox asks Shopify for a token that lasts a day, and asks again before it lapses.

**An app made in your Shopify admin before 2026** still works: under More options, paste its Admin API access token, with its API key and API secret key in the two fields above.

### Sign in with Shopify

A one-click sign-in needs a Shopify app of whoever runs the server. On a hosted inbox it says **Soon**. On your own server, make an app in the Dev Dashboard with the scopes above, add `https://<your inbox>/oauth/connect/shopify/callback` as its redirect URL, and set `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`. Until then it says **Set up**, and the keys work.

## Send agents to your checkout

Your shop's checkout is where carts are bought. Once your Inbox names it for orders (`doorsElsewhere` in your settings), your manifest sends agents there to buy, and to your Inbox for questions and quotes only. A chooser for it in Settings → General is being built.

## What it reads, and what it writes

| | |
| --- | --- |
| Reads | your shop's name, currency and whether prices include tax; products and variants (name, SKU, price, stock, on sale); the draft orders it made and the orders they became (paid, fulfilled, refunded) |
| Writes | draft orders, tagged `sdi`; the webhooks below, at your connection's own address |
| Never reads | your customers, or any order it did not make |

Webhooks it makes: `orders/paid`, `orders/fulfilled`, `orders/updated`, `orders/cancelled`, `refunds/create`, `draft_orders/delete`, `products/create`, `products/update`, `products/delete`, `app/uninstalled`. A hosted inbox makes them once it is live. Shopify removes one after eight failed deliveries in four hours; your Inbox puts it back within six hours, and checks orders itself meanwhile.

A draft carries your customer's name, email, phone (when written as +country code) and address: what fulfilling needs, to your own shop, and nothing more.

## Limits

- **Money in hundredths.** A shop that sells in a currency counted otherwise (yen, won, dinars) cannot be connected yet.
- **5,000 products** a connection. Past that, the first 5,000 stay and you are told once.
- **Shopify's rate limit.** Every call is in Shopify's Admin API, version 2026-10, within your shop's points per second. When the bucket runs low your Inbox waits a moment, or comes back a little later.
- **A product's own change** (taken off sale, renamed) is read for its first 25 variants at once, and for the rest at the next full read.

## Disconnect

Settings → Integrations → **Shopify** → **Disconnect**. The webhooks it made are removed, open links are closed, and your products here are taken off sale (never deleted: an order may name one). Orders and paid links stay. To end the app's access too, uninstall it in Shopify: **Settings** → **Apps** → the app's menu → **Uninstall**.

## Shopify's own docs

- [Client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant)
- [Create apps in the Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard)
- [GraphQL Admin API](https://shopify.dev/docs/api/admin-graphql) and [its rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits)
- [draftOrderCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/draftOrderCreate)
- [HTTPS webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe/https)
- [Uninstalling apps](https://help.shopify.com/en/manual/apps/uninstalling-apps)
