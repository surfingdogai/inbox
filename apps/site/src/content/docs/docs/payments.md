---
title: Payments
description: Connect your own Stripe or Mollie account. Orders you accept get a link to pay into it, and are marked paid once the platform confirms it. The money never passes your Inbox; refunds stay in your dashboard.
---

Connect your own Stripe or Mollie account, and the orders you accept get a link to pay into it. When the customer pays, the platform tells your Inbox, your Inbox checks with the platform, and the order is marked paid. The money goes straight from your customer to your account: it never passes your Inbox, nor Surfing Dog.

Settings → Integrations → **Stripe** or **Mollie**.

## What it does, and what it never does

- **Accepted orders get a link.** When you accept an order, or a customer accepts your quote, your Inbox makes a link for what it comes to in your account and emails it to the customer in your name, in the same email as the acceptance and your words with it (if the platform is slow to answer, the link follows in a second email). Agents see it on the order too.
- **One link at a time, for the amount it comes to.** No link is made while a change to the order waits for an answer. Once payment is asked for, the total is fixed: more is a second order, less a refund. If the order is cancelled, its link is switched off; if a bank payment fails, that link is switched off and a new one sent.
- **Every currency in its own minor unit.** Your Inbox keeps each amount in its currency's own unit, as ISO 4217 counts it: KSh 45.00, ¥4,500, KWD 4.500. Each platform is asked in its own count of that currency, from a table with a test for every currency it lists. A currency the platform does not list, or counts two ways (Stripe and dinars, Stripe and Ugandan shillings, Mollie and Kenyan shillings), gets no link, and you are told once, with the reason; the customer pays you another way.
- **Paid means the platform said so.** A webhook is never believed on its word: Stripe's signature is checked, and in every case your Inbox asks the platform, with your key, before it marks anything paid.
- **The receipt says what was paid.** A paid order's receipt carries the amount the platform confirmed, and how it was paid when the platform says.
- **Refunds stay in your dashboard.** Your Inbox never refunds, charges or moves money. A paid order links to the payment's own page in Stripe or Mollie: **Refund in Stripe**.
- **Test keys for test orders.** A test-mode key makes links only for test orders, a live key only for real ones.
- **Your own link stays yours.** If you ask for payment with a link of your own, your Inbox leaves that order alone.
- **Nothing about your customer is sent from here.** No name, email or address goes to the platform with the link, and the link is named by your catalogue's own product names, or "Order 4F2K9Q", never by words a customer typed: the platform asks for what it needs on its own page.
- **One platform sends your links.** Connect Stripe and Mollie both and the one you connected last sends the links of its mode (live or test); switch links on for the other in **Change** to send them from it instead. Links already sent keep working either way.

Orders you accepted before connecting keep what they had: a business paid on delivery is never asked to pay by surprise. To send one of them a link, ask for payment on the order without a link of your own. Bookings, and quotes that become bookings, get no link yet.

If a payment arrives that cannot go on its order (paid after the order was cancelled, paid twice, or another amount), you get one email with the payment's page, so you can refund it there. If the platform will not make a link (an amount below its minimum, a currency it does not take), you get one email, and the order waits for you as accepted; it is tried again when you ask for payment, or when the total, the currency or the connection changes.

A refund you owe on an order paid through the platform is made in its dashboard: the refund shows **Refund €45.00 in Stripe**, and **Refunded in Stripe** records it in one click, against the payment. With Mollie, whose key can read refunds, a refund made in Mollie's dashboard marks the refund done on its own, within about an hour.

## Stripe

Create a **restricted key** for your Inbox in Stripe: **Developers → API keys → Create restricted key**, and give it only this:

| Permission | |
| --- | --- |
| Payment Links | Write |
| Products | Write |
| Prices | Write |
| Webhook Endpoints | Write |
| Checkout Sessions | Read |

Every other permission starts at *None*; leave it there, and paste the key (`rk_live_…`, or `rk_test_…` to try it first). Your Inbox checks every permission before it keeps anything, and names any that are missing. A secret key (`sk_…`) is refused: it can do anything in your account. It never uses Stripe Connect.

With *Webhook Endpoints: Write*, your Inbox adds its webhook to your account itself, and looks at it on every sync while a link waits to be paid: one Stripe switched off is switched on again, and one removed is said in Settings and by email. Without it, add it yourself in **Developers → Webhooks**: the address and the three `checkout.session` events are under **More options** in Settings, and so is the field for its signing secret (`whsec_…`). On a hosted inbox, the webhook is added once your inbox is live on its own address; until then your Inbox asks Stripe about each link on its five-minute sync.

Your Inbox does not ask Stripe which account a key belongs to, so one Stripe account connects per mode: one live, one test. To change the key, use **Change → New key** on the connection (or the Stripe tile): your orders and their links stay as they are.

## Mollie

Paste your profile's **API key**: in Mollie, **Developers → API keys**, the *Live API key* (or the *Test API key* to try it first). Each link tells Mollie where to report its payment, so there is nothing else to set up.

Mollie reports a payment without a signature, only its id; your Inbox then asks Mollie, with your key, what was paid on that link. If you want Mollie to sign its reports as well, add a webhook in **Developers → Webhooks** for `https://<your-inbox>/v1/hooks/mollie` with the `payment-link.paid` event, and give its signing secret over the API (`values.webhook_secret` when you connect): signed reports are then checked by it, and read back from Mollie the same way.

## For agents

An accepted order that waits for payment is in state `awaiting_payment`, with the link in `payload.paymentUrl`: give it to your person. Once the platform confirms the payment the order moves to `paid`, and its receipt (`knd: paid`) carries `amt` and, when known, `pay`. A payment link is the business's own: pay only there.

## Secrets

The key and any signing secret are sealed with your `INBOX_SECRET_KEY` (AES-256-GCM) before they are stored, and no answer of any door ever carries them back, to you or to your AI. Without `INBOX_SECRET_KEY` nothing can be connected. Every call to Stripe or Mollie goes over https to a public address with the same checks as [calendars](/docs/calendars/#secrets). Your Inbox needs its own public `https://` address for the platform to reach it: `INBOX_PUBLIC_URL`, or the Inbox address in Settings.

## Over the API

```bash
# Connect Stripe
curl -X POST https://<your-instance>/v1/owner/integrations \
  -H "authorization: Bearer sdi_own_…" -H 'content-type: application/json' \
  -d '{ "kind": "stripe", "values": { "api_key": "rk_live_…" } }'

# An order's links, what was paid, and where to refund it
curl https://<your-instance>/v1/owner/items/<id>/payments -H "authorization: Bearer sdi_own_…"
```

`PATCH /v1/owner/integrations/{id}` with `{"pay_on": false}` stops new links (`true` makes this connection the one that sends them, and stops the other of its mode). `DELETE …/{id}` disconnects: it makes no new link at once, switches off the links still waiting to be paid (a few at once, the rest within two hours, tried again when the platform does not answer: `links_closing` says how many are left), and keeps hearing of their payments until then; then the webhook your Inbox added is removed, and you get one email naming the orders that were left waiting on a link that no longer works, and any link that could not be switched off. The platforms report to `POST /v1/hooks/stripe` and `POST /v1/hooks/mollie`. `GET …/items/{id}/payments` says, in `none`, why an order that could have a link has none. Your AI, over the owner MCP, can `list_integrations` and `list_payments`; it records no payment and connects nothing.
