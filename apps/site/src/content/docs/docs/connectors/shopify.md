---
title: Shopify
description: Connect your own Shopify shop with an app you make for it. Your products come in; a quote or order you accept becomes a draft order, paid at your own Shopify checkout. Shopify keeps your cart and checkout; your Inbox adds messages, quotes and receipts.
sidebar:
  order: 2
---

Built from Shopify's documentation and tested against a stand-in; not yet run with a real account.

Shopify already lets assistants shop your cart and pay at your checkout. Your Inbox adds what Shopify does not: questions, quotes and bookings in one place, and a signed receipt for each one. Agents are sent to your Shopify checkout to buy, and to your Inbox for the rest.

Settings → Integrations → **Shopify**.

## What it does, and what it never does

- **Your products come in.** Every variant, priced in your shop's currency, in stock when Shopify counts it, on sale when its product is active. Read again every few minutes, in full every six hours, and at once when Shopify says a product changed.
- **An accepted quote or order becomes a draft order** in your shop, at the prices your customer accepted. The draft's own checkout is the link to pay: your customer pays on Shopify, to you, with your payment methods.
- **Your customer hears from you once.** Your Inbox emails the link in your name. It never asks Shopify to send its invoice email too.
- **Nobody pays more than they accepted.** A delivery fee is a line of the order, so the checkout adds no rate on top, and no discount code. If your shop adds tax at checkout, the link is held, and you can propose the shop's total to your customer, who accepts it or not.
- **Paid means Shopify said so.** A webhook is checked against your app's signature, then the order is read back from Shopify before anything is marked. Shopify's webhooks carry ids only, never your customer's details. Your Inbox also asks Shopify itself every few minutes.
- **What happens in Shopify follows.** Paid, fulfilled (with its tracking), delivered and refunded move the order on here. A draft you delete in Shopify before it is paid closes its link, and the order waits for you.
- **Never your money.** No card details, no fee, no share. Refunds are made in Shopify.

## Connect

You make a small app for your own shop in Shopify's Dev Dashboard, and paste its two keys. Nobody else's app stands between your shop and your Inbox.

1. Open the [Dev Dashboard](https://dev.shopify.com/dashboard/) with the account that owns your shop. **Create app** → **Start from Dev Dashboard**. Name it Inbox, then **Create**.
2. **Versions**: keep the **App URL** Shopify suggests, choose the newest **Webhooks API version**, and tick the scopes `read_products`, `read_orders` and `write_draft_orders`. **Release**.
3. **Install app** (on the **Installs** card), pick your shop, **Install**.
4. **App settings** → **Credentials**: copy the **Client ID** and the **Client secret**.
5. In your Inbox: Settings → Integrations → **Shopify**. Paste the Client ID and the Client secret, then your shop's address: your Shopify admin's address from the browser, or the one ending in `.myshopify.com`. **Connect**.

An app you make for your own shop can read its orders and write your customer's details onto a draft: Shopify gives that to an app in your own organization without a review. Your Inbox asks Shopify for a token that lasts a day, and asks again before it lapses.

**An app made in your Shopify admin before 2026** still works: under More options, paste its Admin API access token. Paste its API key as the Client ID and its API secret key as the Client secret. Shopify signs its updates with that secret, so a wrong one stops them reaching your Inbox (it still asks Shopify itself every few minutes).

### Sign in with Shopify

Only on your own server: make an app in the Dev Dashboard with the scopes above, add `https://<your inbox>/oauth/connect/shopify/callback` as its redirect URL, and set `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`. A **Sign in with Shopify** button then appears beside the keys.

## Send agents to your checkout

Your shop's checkout is where carts are bought. Name it for orders in Settings → General → **What agents can do** ([Booked or ordered elsewhere](/docs/connectors/elsewhere/)), and your manifest sends agents there to buy, and to your Inbox for questions and quotes.

## What it reads, and what it writes

| | |
| --- | --- |
| Reads | your shop's name, currency and whether prices include tax; products and variants (name, SKU, barcode, vendor, price, stock, on sale, the product's page on your online store and its picture's link); the draft orders it made and the orders they became (paid, fulfilled, refunded) |
| Writes | draft orders, tagged `inbox`; the webhooks below, at your connection's own address |
| Never keeps | your customers, or any order it did not make. Shopify tells your Inbox when any order changes, with its id and tags only; your Inbox looks only at orders made from its own drafts, and keeps their ids, nothing else. |

Webhooks it makes, each carrying ids only: `orders/paid`, `orders/fulfilled`, `orders/updated`, `orders/cancelled`, `refunds/create`, `draft_orders/delete`, `products/create`, `products/update`, `products/delete`, `app/uninstalled`. A hosted inbox makes them once it is live. If Shopify refuses one, your Inbox connects anyway and tries again within the hour. Shopify removes one after eight failed deliveries in four hours; your Inbox puts it back within six hours, and checks orders itself meanwhile.

A draft carries your customer's name, email, phone (when written as +country code) and address: what fulfilling needs, to your own shop, and nothing more.

## Limits

- **Money in hundredths.** A shop that sells in a currency counted otherwise (yen, won, dinars) cannot be connected yet.
- **5,000 products** a connection. Past that, the first 5,000 stay and you are told once.
- **Shopify's rate limit.** Every call is in Shopify's Admin API, version 2026-10, within your shop's points per second. When the bucket runs low your Inbox waits a moment, or comes back a little later.
- **A product's own change** (taken off sale, renamed) is read for its first 25 variants at once, and for the rest at the next full read.
- **60 days of orders.** Shopify shows an app only the last 60 days of orders. Your Inbox follows an order for 60 days after it is paid; a refund made in Shopify after that is not read back, so mark it done in your Inbox yourself.
- **A development store** connects in test mode: it takes only test orders, so only orders made in Test mode get a link.

## Disconnect

Settings → Integrations → **Shopify** → **Disconnect**. The webhooks it made are removed, open links are closed, and your products here are taken off sale (never deleted: an order may name one). Open draft orders your Inbox made, and nobody paid, are deleted in Shopify. Orders and paid links stay. To end the app's access too, uninstall it in Shopify: **Settings** → **Apps** → the app's menu → **Uninstall**.

## Shopify's own docs

- [Client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant)
- [Create apps in the Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard)
- [Protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data)
- [GraphQL Admin API](https://shopify.dev/docs/api/admin-graphql) and [its rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits)
- [draftOrderCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/draftOrderCreate)
- [HTTPS webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe/https)
- [Uninstalling apps](https://help.shopify.com/en/manual/apps/uninstalling-apps)
