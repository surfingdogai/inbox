---
title: Payments
description: Connect your own Stripe or Mollie account. Orders you accept get a link to pay into it, and are marked paid once the platform confirms it. The money never passes your Inbox; refunds stay in your dashboard.
---

Connect your own Stripe or Mollie account, and every order you accept gets a link to pay into it. When the customer pays, the platform tells your Inbox, your Inbox checks with the platform, and the order is marked paid. The money goes straight from your customer to your account: it never passes your Inbox, nor Surfing Dog.

Settings → Integrations → **Stripe** or **Mollie**.

## What it does, and what it never does

- **Accepted orders get a link.** When you accept an order, or a customer accepts your quote, your Inbox makes a link for what it comes to in your account and emails it to the customer in your name, usually in the same email as the acceptance. Agents see it on the order too.
- **One link at a time, for the amount now.** If the total changes, the old link is switched off and a new one sent. If the order is cancelled, its link is switched off.
- **Paid means the platform said so.** A webhook is never believed on its word: Stripe's signature is checked, and in every case your Inbox asks the platform, with your key, before it marks anything paid.
- **The receipt says what was paid.** A paid order's receipt carries the amount the platform confirmed, and how it was paid when the platform says.
- **Refunds stay in your dashboard.** Your Inbox never refunds, charges or moves money. A paid order links to the payment's own page in Stripe or Mollie: **Refund in Stripe**.
- **Test keys for test orders.** A test-mode key makes links only for test orders, a live key only for real ones.
- **Your own link stays yours.** If you ask for payment with a link of your own, your Inbox leaves that order alone.
- **Nothing about your customer is sent from here.** No name, email or address goes to the platform with the link: the platform asks for what it needs on its own page.

Orders you accepted before connecting keep what they had. Bookings, and quotes that become bookings, get no link yet.

If a payment arrives that cannot go on its order (paid after the order was cancelled, paid twice, or another amount), you get one email with the payment's page, so you can refund it there. If the platform will not make a link (an amount below its minimum, a currency it does not take), you get one email in its words, and the order waits for you as accepted.

## Stripe

Create a **restricted key** for your Inbox in Stripe: **Developers → API keys → Create restricted key**, and give it only this:

| Permission | |
| --- | --- |
| Payment Links | Write |
| Products | Write |
| Prices | Write |
| Checkout Sessions | Read |
| Webhook Endpoints | Write |

Leave everything else on *None*, and paste the key (`rk_live_…`). Your Inbox checks every permission before it keeps anything, and names any that are missing. A secret key (`sk_…`) is refused: it can do anything in your account. It never uses Stripe Connect.

With *Webhook Endpoints: Write*, your Inbox adds its webhook to your account itself. Without it, add it yourself in **Developers → Webhooks**: the address and the three `checkout.session` events are under **More options** in Settings, and so is the field for its signing secret (`whsec_…`).

A restricted key cannot say which Stripe account it belongs to without a Connect permission, which your Inbox does not ask for, so one Stripe account connects per mode: one live, one test.

## Mollie

Paste your profile's **API key**: in Mollie, **Developers → API keys**, the *Live API key* (or the *Test API key* to try it first). Each link tells Mollie where to report its payment, so there is nothing else to set up.

Mollie reports a payment without a signature, only its id; your Inbox then asks Mollie, with your key, what was paid on that link. To have Mollie sign its reports as well, add a webhook in **Developers → Webhooks** for the address under **More options** with the `payment-link.paid` event, and paste its signing secret there.

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

`PATCH /v1/owner/integrations/{id}` with `{"pay_on": false}` stops new links; `DELETE …/{id}` disconnects (the links still open are switched off, and the webhook your Inbox added is removed). The platforms report to `POST /v1/hooks/stripe` and `POST /v1/hooks/mollie`. Your AI, over the owner MCP, can `list_integrations` and `list_payments`; it records no payment and connects nothing.
