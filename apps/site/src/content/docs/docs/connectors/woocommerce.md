---
title: WooCommerce
description: Connect your WordPress shop with one press on its own Approve page. Your products and stock come in; orders you accept go into WooCommerce and are paid at your shop's own checkout.
sidebar:
  order: 1
---

Your WooCommerce shop already has your products, your stock, your checkout and your payment methods. Connected, your Inbox uses them: agents see what you sell, and an order you accept goes into WooCommerce, where your customer pays at your own checkout.

Settings → Integrations → **WooCommerce** → **Connect your shop**.

## Connecting

1. Your shop's address is filled in from Settings → Business website. Change it if your shop is somewhere else.
2. Press **Connect your shop**. WooCommerce opens its own Approve page in your WordPress admin (sign in there if it asks).
3. Press **Approve**. You come back to your Inbox, connected.

WooCommerce makes a key for your Inbox, named *Agent inbox (inbox.yourdomain.com)*, and sends it straight to your Inbox. You never copy it, and nobody else holds it. It is encrypted before it is stored, and never shown again. Your Inbox checks it with your shop a moment later, on its first sync; if something is wrong, the connection says what.

**With the WordPress plugin:** Settings → Agent inbox → **Connect WooCommerce** opens the same drawer in your Inbox.

**Before your Inbox is live at its own address,** your shop can't reach it to send the key. The drawer says so and opens on the keys below.

**If the Approve page doesn't work** (your WordPress uses plain permalinks): **More options** → **Paste the keys instead**.

1. In WordPress: WooCommerce → Settings → Advanced → REST API → **Add key**.
2. Description *Agent inbox*, Permissions **Read/Write**, then **Generate API key**.
3. Copy the consumer key and the consumer secret into your Inbox.

Your shop must answer over https. Your Inbox calls nothing else.

**Connecting again** (Change → **Approve again**) makes a new key. Your Inbox keeps its webhooks and reminds you, on the connection, to remove the earlier key.

## What it reads, and what it writes

| | |
| --- | --- |
| **Reads** | Your products and their variations: name, SKU, barcode (the GTIN, UPC, EAN or ISBN field), price, stock, whether they are on sale, their page and the link to their picture. Your shop's currency, and whether its prices include tax. Your shop's list of states or provinces, to write an address the way your shop does. The orders your Inbox made, and their refunds. Its own webhooks. |
| **Writes** | The orders you accept, as **pending** orders. Its webhooks (three: orders updated, products updated, products deleted). A private note on each order it makes. |
| **Never** | Orders your shop takes at its own checkout. Your customers' accounts. Your prices, stock or settings. Card details: your customers pay at your checkout, with your payment methods. |

## Your catalogue

- **What is on sale comes in.** Published, purchasable products and each variation of a variable product ("Pizza Calabresa – Large"). Drafts, private products and anything binned come in off sale. Grouped and external products are not sold by your checkout, so they are left out.
- **Stock** is WooCommerce's count where it counts stock, and out of stock where you marked it so.
- **Prices** are your shop's current prices, sale prices included, in your shop's currency.
- **Kept up to date.** What changed is read every few minutes, and at once when WooCommerce says a product changed; everything every six hours. A product you unpublish or bin comes off sale within minutes; one deleted for good, at the next full read.

## Orders

- **An order you accept goes into WooCommerce, pending,** at the prices your customer accepted, with their name, email, phone, address and note: what fulfilling it needs, in your own shop. WooCommerce sends your customer nothing for a pending order.
- **The address as your shop writes it.** A state or province is written as your shop's own code for it (ON, MH, SP), so your shop's tax rates for it apply.
- **Your customer pays at your checkout.** Your Inbox emails them, in your name, the order's own link to pay in your shop. The money goes to your payment provider, as for any order in your shop. Your Inbox never touches it, and never adds a fee.
- **Paid means WooCommerce says so.** When your customer pays, WooCommerce tells your Inbox; your Inbox asks WooCommerce, with your key, before it marks anything paid. Cash on delivery counts as paid once you complete the order.
- **Completing the order in WooCommerce** marks it fulfilled here. Refunds stay in WooCommerce; a refund you make there marks the one your Inbox owes as done.
- **If your shop cancels an unpaid order,** the link closes and the order waits for you here: your customer is not told their order ended. If you cancel it here first, the pending order in WooCommerce is cancelled too.
- **Tax.** If your prices include tax, the order comes to exactly what your customer accepted. If your shop adds tax at checkout, the connection says so, and each order's total comes to you first: you send your customer the shop's total, who accepts it or not. Nobody pays more than they accepted.
- **One shop sends the links.** With WooCommerce connected, orders are paid at your shop's checkout, and Stripe or Mollie links stop. Links already sent keep working.

**Your customer hears from you once.** With the WordPress plugin, WooCommerce's own processing and completed emails for orders your Inbox made stay quiet, since your Inbox sends its own receipt and says when the order is on its way. Refunds and cancellations you make in WooCommerce are emailed by WooCommerce as usual, as are bank transfer details, invoices and your notes. Without the plugin, your customer may get both receipts.

## Disconnecting

Settings → Integrations → **WooCommerce** → **Disconnect**. Your Inbox removes its webhooks from your shop and takes its products off sale. Unpaid orders your Inbox made are cancelled in WooCommerce, since it can no longer hear that they were paid. Paid orders stay, in WooCommerce and here.

WooCommerce doesn't let an app remove its own key. Remove it yourself in WooCommerce → Settings → Advanced → REST API: the key named *Agent inbox*.

## Good to know

- WooCommerce sends its webhooks through WordPress's scheduler, so on a quiet site they can arrive minutes late. Your Inbox also asks your shop every few minutes, so nothing is missed.
- WooCommerce switches a webhook off after several failed deliveries. Your Inbox switches its own back on.
- Orders in a currency your shop doesn't sell in are not written into it.
- Shops in currencies with no minor unit (yen, won, dong, Chilean pesos) work like any other. Currencies counted in thousandths (Kuwaiti or Bahraini dinars) can't be connected yet.

[WooCommerce REST API](https://woocommerce.github.io/woocommerce-rest-api-docs/) · [Webhooks](https://woocommerce.com/document/webhooks/) · [Keys](https://woocommerce.com/document/woocommerce-rest-api/)
