## What an assistant needs

- **To know how payment works** before it commits its person: pay now, pay a deposit, pay on arrival, or pay by invoice.
- **A way to pay that doesn't need a card number.** In many places, the EU, the UK and India among them, a card payment the customer starts needs strong authentication: a second step such as a code or a banking app. An agent typing a card number into a checkout stalls at that step, and it holds a number it should never see.
- **A credential made for agents**: a token or a mandate the person approves once, usually with a passkey or their banking app, limited to a merchant, an amount or a period. The agent presents it, and the payment provider checks it.

This changes month by month. What follows was written in October 2026; check with your provider before you choose.

## Cards and wallets

The card networks issue tokens for agents: Mastercard Agent Pay and Visa Intelligent Commerce are their programmes, reached through your payment provider rather than directly. Payment providers publish their own agent payments too, such as Stripe's Shared Payment Tokens for the Agentic Commerce Protocol, Adyen's agentic commerce APIs and Mollie's support for ACP's delegated payment. Ask your provider, and the wallets you accept, which of these they support, and where.

## Payments from a bank account

Many countries have account-to-account payments with a mandate: the payer sets the limits once, and can change or withdraw them. Pix Automático in Brazil, UPI AutoPay in India, PayTo in Australia, SEPA Direct Debit across Europe, and Direct Debit and Variable Recurring Payments in the UK all work this way. Whether a scheme lets an agent use a mandate, and on what terms, differs from one to the next; ask your bank or your provider.

## Open protocols

- **UCP payment handlers** and **ACP delegated payment** carry an agent's payment inside a checkout made for agents (see [selling](/guides/sell-through-ai-assistants/)).
- **AP2**, the Agent Payments Protocol, describes mandates a person signs for an agent.
- **x402** settles a payment over HTTP, mostly in stablecoins. It suits software and APIs more than a shop or a salon today.

## A payment link is a fine start

The agent fills the basket or makes the booking, and a person pays on your own checkout; no card details go near the agent. Say on your booking or order page how payment works, and add `paymentAccepted` to your business markup. Each counts as partly, and a door that pays counts in full.

## What counts in the check

We read what your site and its doors declare, and never pay for anything:

- **Pays**: UCP payment handlers, ACP delegated payment, AP2 or x402 on a door, or a pay tool such as `pay`, `create_payment` or `checkout`.
- **Partly**: `paymentAccepted` in your business markup; payment terms in words (an invoice, a deposit, pay at the venue); a checkout link or payment marks on your pages; payments you declare when you claim your listing.

Payment is often the biggest step left once an assistant can book or order with you.
