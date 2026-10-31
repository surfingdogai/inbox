# ADR-045 — Stripe Pay: paid to the business's own Stripe profile, outside the inbox

**Status:** proposed, 31 October 2026. Builds on Settings → Payments and the payments vocabulary (spec 0.7),
ADR-023 (pay links: the owner records a payment made another way) and ADR-042 (what the status door says of an
order's payment). Spec 0.13: `vocab/payments.json` version 3 and the profile's `pay_to`. No migration: the setting
lives in the settings document.

## Context

Stripe Pay was announced on 27 October 2026 (https://docs.stripe.com/cli/pay, read 31 October 2026): instant
business-to-business transfers to a Stripe profile, named by its handle (`@recipient`) or its profile network id
(`profile_…`). It is in preview for eligible businesses in the US and the UK, for same-currency transfers in USD, GBP
and USDC. The sender needs a funded Stripe financial account; the recipient a Stripe financial account, or a bank
account for payouts linked to its Stripe profile. A transfer is sent from the Stripe Dashboard or with the Stripe
CLI's `stripe pay`, which has `--agent`, `--json` and `--dry-run`, and Stripe's guidance to agents is to add `--yes`
"only after the user confirms the recipient, amount, currency, and source financial account". Agents find a recipient
they were not given in Stripe Directory, and "Don't guess the recipient".

What Stripe does not document: the rules for a handle (every one it shows is lower-case letters and digits:
`@neon`, `@youdotcom`), whether a transfer carries a note or reference, and any way for the recipient's software to
learn of a transfer.

## Decisions

1. **A setting with the handle, not a tick.** Settings → Payments has a Stripe Pay part under the ticks:
   the business's handle (or profile id) and the currencies it takes there (USD, GBP, USDC; it starts from the
   business's own currency when it is one of them). `settings.payments.stripePay` is `{to, currencies}`, off while
   `to` is empty; `stripe_pay` is never in `accepted`. Like the rest of `payments`, only the owner in person changes
   it (`OWNER_ONLY_SETTINGS`): a customer's message must never get the owner's AI to send payments to another
   handle. The handle is typed: Stripe documents no way to read it.
2. **What a handle is.** `@` and 1 to 50 lower-case letters, digits, `_`, `.` or `-`, starting and ending with a
   letter or digit, read in lower case with the `@` added when it was left off; or `profile_` and up to 100 letters,
   digits and `_`, kept as written (`stripePayRecipient`, spec). Anything else is refused: a URL, a space, an email
   address. A handle is never read from a website, nor made up from a name.
3. **Declared, so the network can read it.** The vocabulary gains `stripe_pay` among the ways a person pays (no
   mark, no handler: only the business's word declares it), and the profile gains `pay_to`
   (`[{method, to, currencies}]`, at most eight). The manifest and the business profile publish `stripe_pay` in
   `payments` and the handle in `pay_to` while it is set; a reader keeps a `pay_to` entry only for a method it knows
   that `payments` names too (`readPayTo`). A setup plan never fills it in, and drops `stripe_pay` if it names it.
4. **Offered where an order is payable.** An accepted order that is due, with no change waiting, in a currency the
   business takes by Stripe Pay, has `payment.pay_to` on the status door (REST and MCP): `{method: "stripe_pay",
   to, amount, reference, confirm: ["to", "amount", "currency", "from"], marked_paid_by: "business", human}`:
   `confirm` is the four things Stripe's guidance names, `from` being the payer's source financial account. The
   amount is exactly the order's total in its currency, and the reference is the order's six characters. `human`
   says it in the business's voice, and says who can use it, since most customers have no Stripe business account
   ("If you pay from a Stripe business account, you can pay with Stripe Pay to @harbour: £29.00, reference 4F2K9Q.
   We mark it paid once it reaches us."); the emails about paying (accepted, waiting for payment, payment failed)
   carry the same line. While the business takes it in its own currency (so that an order can offer it), the MCP
   server says who can pay this way (a Stripe business account with a funded financial account, in preview in the
   US and the UK), that the agent confirms those four things with its person before anything is sent, and that it
   adds the reference to the transfer if Stripe lets it and, either way, tells the business it paid with
   `send_message`, giving the reference: Stripe documents no note on a transfer. Settings → Payments says so when
   none of the ticked currencies is the business's own: the profile still names the handle, but no order offers
   it. Never for a test order (the
   transfer is real money), nor an order in another currency; USDC is listed for the business but no order is in
   USDC, so it is offered only in USD and GBP.
5. **Nothing checks it here, and the inbox says so.** No money passes through the inbox, and Stripe documents no
   way for it to see a transfer. The owner records the payment on the order (Record payment, as for any way paid
   outside the inbox), and the setting's words, the agent's and the customer's say that the business marks it paid.

## Consequences

- A business on Stripe in the US or the UK can be paid by other businesses, and their agents, to its own handle,
  with no link to make. The money never touches the inbox.
- A network reads the handle from the business's own manifest only: searchable as `accepts=stripe_pay`, and shown
  with its address in `get_business`.
- Payments are not matched to orders automatically, and a customer can say they paid when they have not: the
  owner checks the money in Stripe before recording it. If Stripe later documents a way for a recipient to learn of
  a Stripe Pay transfer, recording it could follow, as ADR-023 does for links. Stripe's Treasury API has received
  credits on a financial account, with events; whether a Stripe Pay transfer arrives as one, and with what, is not
  documented, so nothing here relies on it yet.

## Not decided here

- Whether a USD order may be paid in USDC.
- Whether a stay's deposit, or a booking with a price, is offered Stripe Pay.
- Other ways paid to an address of the business's own (a PayPal.me link, a Pix key, a Venmo handle): `pay_to`
  takes them as methods, each with its own rules, when one is wanted.
