---
title: How AI agents pay a business
description: A customer's AI assistant can pay an order you accepted straight into your own Stripe account, with a one-time token from its platform, for exactly the total the customer confirmed. One switch, one Stripe permission, no card numbers.
draft: true
---

A customer asks their AI assistant to order three sourdough loaves from your bakery. The assistant orders through your Inbox, its person confirms the total, and you (or your rules) accept the order. Then the assistant pays for it itself: its platform holds the person's card, and hands your Inbox a **one-time token** made for your business and that total. Your Inbox charges it once, on your own Stripe account. The order is marked paid, the customer gets their receipt, and the money is in your Stripe balance like any other payment.

Nobody opens a link. No card number reaches the assistant or your Inbox. The money never passes your Inbox, nor Surfing Dog.

Settings → Integrations → **Stripe** → **Change** → **Let AI assistants pay you directly**.

## What it does, and what it never does

- **Only orders you accepted.** Nothing is charged for an order that waits for you, or for one with a change waiting for an answer. Once you or your rules accept it, the assistant can pay.
- **Exactly the total the customer confirmed.** The assistant sends back the fingerprint of the terms its person said yes to (`terms_sha`). If the order changed since, nothing is charged and the assistant is told to ask its person again.
- **Once.** One payment per order, however often the assistant tries, and even if two try at once. The same token sent twice is one payment.
- **Into your own Stripe account.** One PaymentIntent on your account, made with your restricted key. Never Stripe Connect. Refunds stay in Stripe, from the payment's own page.
- **Test keys for test orders.** A test-mode key charges only test orders, with Stripe's test tokens. A live key charges only real ones.
- **The token is never kept.** It is used for the one charge and only its fingerprint is stored. No name, email or address goes to Stripe from your Inbox.
- **Your payment link still works.** Orders you accept still get their link. If the assistant pays first, the link is closed. If the assistant cannot pay (its platform does not support it, or the card asks its holder to confirm), it gives its person the link.

## Switch it on

You need three things in Stripe, and one switch in your Inbox:

1. **A Stripe profile.** Assistants' platforms ask Stripe for a token made for your profile. Find or create it at [dashboard.stripe.com/profiles](https://dashboard.stripe.com/profiles). Its ID starts with `profile_`.
2. **One more permission on your key.** Edit the restricted key you gave your Inbox (Developers → API keys) and set **PaymentIntents** to **Write**.
3. **Stripe's terms for agent payments.** Stripe may ask you to accept its agentic-commerce seller terms, and to confirm each assistant's platform in your dashboard, in the same mode (test or live). That is between you and Stripe.

Then, in your Inbox: **Change** on the Stripe connection, switch on **Let AI assistants pay you directly**, and paste your profile ID. Your Inbox checks the key for the permission with a request that makes nothing, and tells you if it is missing. Switch it off at any time: it takes effect at once, and assistants are sent your payment link instead.

Only you can switch it, in person. Your AI and your integration keys cannot.

It works where Stripe offers it: the US, Canada, the UK, Switzerland, Norway and most of Europe.

## What you see

- On the connection: whether it is on, and how many orders assistants paid this way.
- On each order: **Paid by the customer's assistant**, with the amount and how it was paid, and **Refund in Stripe**, which opens the payment's own page there. A payment that did not go through is one quiet line: nothing was charged.
- If a payment arrives for an order that was cancelled in the meantime, it is kept, and a note on the order tells you to refund it in Stripe.
- If your key loses the permission, your Inbox switches agent payments off itself and tells you why.

## For agents

When `get_item_status` (MCP) or `GET /v1/items/{id}` (REST) shows `payment.agent` on an accepted order, the business takes a payment straight from your platform:

```json
"payment": {
  "state": "due",
  "amount": { "value": 18900, "currency": "NOK" },
  "payment_url": "https://buy.stripe.com/…",
  "agent": {
    "handler": "stripe_spt",
    "psp": "stripe",
    "business_profile": "profile_…",
    "environment": "livemode",
    "amount": { "value": 18900, "currency": "NOK" },
    "platform_amount": { "value": 18900, "currency": "nok" },
    "terms_sha": "…",
    "binding_id": "<item id>"
  },
  "human": "You can pay Fjordbrød Bakery now: NOK 189.00."
}
```

Get a Stripe shared payment token (`spt_…`) from your platform for `business_profile` and `platform_amount`, on your person's yes to that total. Then call `pay_order` (MCP) or `POST /v1/items/{id}/pay` (REST) with the item's `access_token`, `terms_sha`, `payment: { handler: "stripe_spt", token }` and an idempotency key you keep. `200` is paid, with the order and its receipt. `202` is on its way: read the status again until it is paid.

A refusal names what to do next, and `details.human` is what to tell your person, in the business's words:

| Code | Status | What to do |
| --- | --- | --- |
| `payment_declined` | 402 | Nothing was charged. Ask your person for another card, and pay with a new token. |
| `authentication_required` | 402 | The card asks its holder to confirm. Give your person `details.payment_url`. |
| `terms_changed` | 409 | The order changed. Show your person the order as it is now, and get a token for its total. |
| `not_accepted_yet` | 409 | Read the status again shortly. |
| `in_progress` | 409 | Retry with the same idempotency key. |
| `agent_pay_unavailable` | 409 | Give your person `payment_url`. |
| `token_invalid`, `token_expired`, `token_used`, `token_limit` | 422 | Get a new token for this business, mode and total. |
| `too_many_attempts` | 429 | Give your person `payment_url`. |
| `platform_unavailable` | 503 | Retry with the same token and idempotency key. It is never charged twice. |

Pay only with a token. Never send a card number.

## Over the API

```bash
# Switch it on (the owner in person, signed in)
curl -X PATCH https://<your-instance>/v1/owner/integrations/<id> \
  -H 'content-type: application/json' \
  -d '{ "agent_pay": true, "agent_profile": "profile_…" }'

# What assistants paid on an order
curl https://<your-instance>/v1/owner/items/<id>/payments -H "authorization: Bearer sdi_own_…"
```

A missing permission comes back in `agent_pay.missing` (`["PaymentIntents: Write"]`), and nothing is switched on. Your business profile lists `acp_delegated` among its payments while the switch is on, so networks that read it know assistants can pay you.

See also [Payments](/docs/payments/), for payment links.
