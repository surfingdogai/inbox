# ADR-042 — Agent payments: a customer's assistant pays an accepted order at the business's own Stripe

**Status:** proposed, 26 October 2026. Builds on ADR-023 (pay links), ADR-036 (money in each currency's
own minor unit, extra key permissions asked for on demand) and ADR-018 §5 (the confirm step and
`terms_sha`). Migration 0034 (`agent_payments`). No spec version: `pay_order` is a door of the inbox, not
a schema of the spec, and the token it reads is already in the payments vocabulary (`acp_delegated`).

## Context

An accepted order gets a payment link in the business's own Stripe or Mollie account (ADR-023), and a
person has to open it. Customers' assistants can now pay themselves: their platform holds the person's
card and hands a seller a one-time, scoped credential instead of a card number. The seller charges it on
its own payment account. Owners and assistants ask for this ("ai agent payments", "agent assisted
payments"), and an assistant that can order but not pay leaves its person half done.

Specifications read on 26 October 2026:

- **Stripe Shared Payment Tokens, seller side**
  (https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens). A Shared Payment Token
  (SPT, `spt_…`) is a grant to use the customer's payment method, granted to the seller's Stripe
  **profile** with usage limits (`currency`, `max_amount`, `expires_at`). The seller charges it with
  `POST /v1/payment_intents` (`amount`, `currency`, `payment_method_data[shared_payment_granted_token]`,
  `confirm=true`) in API version `2026-09-30.preview`. On confirm, Stripe clones the card into a new
  PaymentMethod on the seller's account, so refunds and reporting work as for any payment. Its
  `deactivated_reason` is `consumed`, `expired`, `resolved` or `revoked`. Stripe's agentic-commerce
  seller terms apply. Offered in the US, Canada, the UK, Switzerland, Norway, Liechtenstein and most of
  the EU and EEA.
- **Stripe's UCP payment handler**
  (https://docs.stripe.com/agentic-commerce/protocols/ucp/stripe-payments-handler, handler version
  `2026-06-25`): the seller charges with "a restricted API key that has the PaymentIntents write
  permission", needs a Stripe profile (`profile_…`) and a confirmed commerce relationship with each
  agent, in the same environment. An SPT without `expires_at` lasts one hour.
- **The Agentic Commerce Protocol** (https://github.com/agentic-commerce-protocol/agentic-commerce-protocol,
  release `2026-04-17`, and https://agenticcommerce.dev): checkout sessions, delegated payment, the
  `dev.acp.tokenized.card` handler with `psp: "stripe"`, `payment_data.instrument.credential {type: "spt",
  token}` on complete, discovery at `/.well-known/acp.json`, and flat errors with `payment_declined`,
  `requires_3ds` and resolutions `recoverable`, `requires_buyer_input`, `requires_buyer_review`.
- **AP2, the Agent Payments Protocol** (https://ap2-protocol.org, v0.2): checkout mandates (open
  `mandate.checkout.open.1`, closed `mandate.checkout.1` with a merchant-signed `checkout_jwt` and its
  `checkout_hash`) and payment mandates (`mandate.payment.1`, `transaction_id` the hash of the
  `checkout_jwt`), verified by the credential provider, network and processor rather than the merchant.
- **UCP's AP2 extension** (https://ucp.dev/latest/specification/payment/extensions/ap2-mandates/,
  `dev.ucp.common.payment.ap2_mandate`, `2026-08-25`): the business signs every checkout response
  (`ap2.merchant_authorization`, a detached JWS with ES256, ES384 or ES512, by a `kid` in its profile).

Where agents order today: MCP `create_order` and REST `POST /v1/orders`, with the confirm step (`409
confirm_terms`, then the call again with `terms_sha`); the order is accepted by the owner or by a rule a
moment later; `get_item_status` (`GET /v1/items/{id}`) says what it waits for. There is no ACP door, and
the only UCP door is lodging (ADR-038), with no payment handlers.

## Decisions

### 1. One capability, behind the inbox's own doors

`Capabilities.payOrder` is the one implementation (`connectors/agent-pay.ts`, class `AgentPayments`).
The doors are the ones agents already order through:

- MCP `pay_order`, beside `create_order`, listed only while the business takes payments from
  assistants, with one more sentence in the server's instructions then.
- REST `POST /v1/items/{id}/pay`, with the body of `payOrderInput` and `Idempotency-Key`.
- `get_item_status` gains `payment` for an accepted order: `state` (`due`, `processing`, `paid`),
  `amount`, `payment_url` (the link, while one is open), `human`, and `agent` when it can be paid
  directly now: `handler: "stripe_spt"`, `psp`, `business_profile`, `environment` (`livemode` or
  `testmode`), `amount`, `platform_amount` (the total as Stripe counts it, which is the token's limit),
  `terms_sha` and `binding_id`. `next` then starts with `pay_order`.
- The business profile's `payments` adds `acp_delegated` while the switch is on. Nobody types it: it
  follows the switch, so a network's "assistants can pay here" filter is true.

An ACP checkout door and a UCP shopping door are not built here (§9). When they are, their complete
step calls the same `payOrder`.

### 2. The money moves only in the business's own Stripe account

The charge is one PaymentIntent on the business's account, made with the restricted key the owner gave
(ADR-023). There is no Stripe Connect and no platform account between the business and its money.
Refunds stay in Stripe, from the payment's own page (`dashboard_url`). Mollie documents no equivalent
today: its businesses keep links, and the `PaymentsHandler` methods are optional, so nothing changes
for Mollie.

### 3. Accept, then charge, then record

A charge happens only for an order in `accepted`, `awaiting_payment` or `payment_failed`, with no change
waiting, whose total is above 0. The amount is exactly the order's total under the terms the customer
confirmed: the call sends `terms_sha` back, and it must be the order's agreed one. The checks run in
this order, each refusing before Stripe is asked anything:

1. The scope `inbox:write`, the caller is a customer (the business's keys and its AI are refused), and
   the item is theirs (its access token, a pass it recognises, or the agent key it was made with). An
   `idempotency_key` is required.
2. The order's state, change and total (`already_paid`, `not_accepted_yet`, `wrong_state`,
   `change_pending`).
3. A Stripe connection of the order's mode with the switch on and a profile (`agent_pay_unavailable`).
4. `terms_sha` is the agreed one (`terms_changed`, with the order's current fingerprint).
5. Stripe takes the currency (ADR-036's table).
6. An echoed allowance (ACP's `credential.allowance`) is in the same currency, at least the total, and
   not expired. It can only refuse: Stripe holds the token to its own limits, whatever is echoed.
7. A token seen before is answered as it went (below). Otherwise, at most five declined attempts per
   order and thirty per inbox in a day (`too_many_attempts`), which blunts card testing.

Then the attempt is claimed, charged and recorded. A charge that went through is recorded on the order
as a link's payment is: `record_payment` by the connector, with the PaymentIntent's id and the amount
Stripe took. The receipt `paid` (with `amt` and `pay`), the customer's email and the closing of any open
link follow from the existing paths.

### 4. Once

- **One per order.** `agent_payments_live` is unique on `item_id` while an attempt is `creating`,
  `processing` or `paid`. Two assistants paying at once, or one paying again after the first went
  through, make one charge: the second is told `in_progress` or `already_paid`.
- **One per token.** The token is never kept: only `SHA-256("spt:" + token)`, unique. The same token
  sent again is answered as it went, never charged again.
- **One per attempt.** The PaymentIntent is made with `Idempotency-Key: sdi-<row id>-pi`. When Stripe
  does not answer (5xx, 429, a timeout) the attempt stays `creating`, unclaimed, and the assistant is
  told `platform_unavailable` with `Retry-After`. Its retry with the same token asks Stripe again under
  the same key, so Stripe answers what it did with the first.
- **One per request.** The caller's `idempotency_key` replays the stored answer; the stored request
  holds the token's hash, never the token.

An attempt left `creating` for two hours (past a token's own life), or `processing` for a day, becomes
`unknown`, and the owner is told on the order to check it in Stripe.

### 5. Test keys for test orders

A test order (`flags.sandbox`) is charged only on the test connection and a real order only on the live
one, so a test token never pays a real order, and Stripe refuses a token of the other mode as unknown.
`payment.agent.environment` says which.

### 6. Failures an assistant can act on

Each refusal has a stable code and says what to do next in its message. What the person should hear is
in `details.human`, in the business's words and language (English and Portuguese, the languages the
inbox writes to customers in), and passes the customer-copy check.

| Case | Status | Code | The assistant should |
|---|---|---|---|
| Switch off, no connection of the order's mode, a currency Stripe will not take, nothing to pay, the key lost the permission, Stripe refused for another reason | 409 | `agent_pay_unavailable` (`reason`: `off`, `no_connection`, `currency`, `zero_total`, `connection`, `refused`) | Give its person `payment_url`. |
| Not accepted yet | 409 | `not_accepted_yet` (`waiting_on`, and `retry_after_s` just after it was made) | Read the status again. |
| Paid already | 409 | `already_paid` | Nothing to pay. |
| Declined, cancelled, expired | 409 | `wrong_state` | Nothing to pay. |
| A change waits | 409 | `change_pending` | Wait for the answer. |
| Other terms | 409 | `terms_changed` (`terms_sha`) | Ask its person again; a new token for the new total. |
| Another attempt on its way | 409 | `in_progress` (`retry_after_s`) | Retry with the same key. |
| Not this business's token, nor this mode's | 422 | `token_invalid` | A new token for `business_profile` and `environment`. |
| Expired, used or revoked | 422 | `token_expired`, `token_used` | A new token. |
| Below the total, or another currency | 422 | `token_limit` | A token for `platform_amount`. |
| Declined | 402 | `payment_declined` (`attempts_left`) | Nothing was charged: another card, a new token. |
| The card asks its holder to confirm | 402 | `authentication_required` (`payment_url`) | Send its person to the link. |
| Too many declines today | 429 | `too_many_attempts` | Give its person `payment_url`. |
| Stripe did not answer | 503 | `platform_unavailable` (`Retry-After`) | Retry with the same token and key. |
| Processing | 202 | `state: "processing"` | Read the status until it is paid. |

Stripe's own decline codes (`insufficient_funds`, `fraudulent`, …) are kept on the attempt for the owner
and never told to the assistant. A synchronous decline does not move the order, so no failure email goes
for an attempt the person never left. A payment that was processing and then failed moves the order to
`payment_failed`, as a link's does. `requires_action` is not taken here: the PaymentIntent is cancelled so
it can never be taken later, and the person is sent to the link. Delegated authentication waits for a
platform that documents it.

Stripe does not document the error codes it gives a token it will not charge. The adapter reads the
parameter it names and its words as well as its code (expired; consumed, revoked or deactivated; over a
limit or another currency; else unknown), and a sandbox check is listed below.

### 7. The owner's switch, in person

"Let AI assistants pay you directly" is on the Stripe connection, under the links, in **Change**. It is
`PATCH /v1/owner/integrations/{id}` with `agent_pay` and `agent_profile`, which, like every change to a
connection, is the owner's in person (`requirePerson`): the owner's AI and integration keys are refused.

- **On** asks the key for **PaymentIntents: Write** with a PaymentIntent that has no parameters, so it
  makes nothing (403: missing; 400: it may), in the preview version, so an account Stripe has not opened
  it for says so now. A missing permission is answered, not thrown (`agent_pay.missing`), and nothing is
  written. The Stripe profile ID is required (`profile_…`).
- **The profile ID is typed.** It is the one pasted field here: Stripe documents no way for a
  restricted key to read a profile. When one appears, the field becomes a read.
- **Off** takes effect at once. A disconnect stops it at once too.
- **A key that lost the permission** (a 403 on a charge, or a key Stripe no longer takes) switches it off
  by itself, says why on the connection (`agent_pay.stopped`), and tells the owner once.
- The connection shows how many orders assistants paid. The order's payments show each attempt
  (`agent_payments` on `GET /v1/owner/items/{id}/payments`), with the payment's page in Stripe.

What only the owner can do, outside the inbox, and the switch's copy says: create a Stripe profile,
accept Stripe's agentic-commerce seller terms, add the permission to the key, and confirm each agent
platform's commerce relationship in Stripe in the same mode.

### 8. Data model

Migration 0034 adds `agent_payments` and changes nothing that exists. An inbox whose owner never switches
it on writes no row. One row per attempt: the order, the connection (not a foreign key, so the record
outlives a disconnect), the door, the amount and currency (the inbox's minor units), the mode, the
`terms_sha` it was charged for, the token's hash, the state (`creating`, `processing`, `paid`, `declined`,
`failed`, `cancelled`, `unknown`), Stripe's id, method, amount taken and dashboard page, our failure code
and Stripe's words, a note for the owner, the claim, and when it went on the order. No row holds a
customer's name, email or address, so erasure leaves them, as it leaves paid links; a download carries
them. The connection's switch is in `connectors.config_public`: `$.agentPay`, `$.agentProfile`,
`$.agentPayAt`, `$.agentPayStopped`.

It is not `connector_payments`: that table's machinery reads every row of an item as the order's link
history (one live link per item, a second payment on a link, links closed on disconnect). An agent row
there would change what those mean. A table of its own keeps ADR-023 as it is.

### 9. Stripe's API version

`STRIPE_AGENT_VERSION = "2026-09-30.preview"` is sent on the agent-payment calls only (the charge, the
read-back, the cancel, the probe). Every other call, and the webhook the inbox adds, stays on
`STRIPE_VERSION = "2024-06-20"`. A test pins both. The read-back of a PaymentIntent is lenient: `id`,
`status`, `amount`, `amount_received`, `currency`, `livemode`, `payment_method_types`,
`last_payment_error`. A charge whose answer is for another amount or another mode is refused as a bad
answer, never recorded.

A payment that is processing is read back on each sync (every few minutes) until Stripe says. No
`payment_intent.*` webhook events are added: a card charge answers at once almost always, and
subscribing would send every payment of the business's account to the inbox.

## Consequences

- An assistant can pay an accepted order end to end with no link for a person to open, at the
  business's own Stripe, for exactly what its person confirmed. The person can still pay at the link
  whenever the assistant cannot.
- The owner adds one permission to the key and pastes one ID; nothing else in the inbox changes for
  them, and links keep working beside it.
- The order's link is still made at acceptance, and the acceptance email carries it. Once the assistant
  pays, the link is closed, so a customer who opens it reads the closed link's line (ADR-023) and is
  never charged twice; a payment on the link that crosses the assistant's is the "paid twice" notice
  ADR-023 already sends the owner.

## Not checked against a real account

To verify in a Stripe sandbox before a business uses it:

1. Stripe answers 403 before 400 for the empty PaymentIntent probe on a key without the permission.
2. A restricted key with PaymentIntents: Write can confirm with `shared_payment_granted_token` in
   `2026-09-30.preview`, and Stripe does not ask for a `return_url` for a card that needs no redirect.
3. The error codes for an expired, revoked, consumed, over-limit or foreign token.
4. Whether test profile IDs always start `profile_test_`; until then, mode is enforced by the key.
5. What ChatGPT's ACP handler expects in `config.merchant_id` (`profile_…` or `acct_…`).

## Not decided here

**An ACP checkout door** (behind its own switch, off; hosted off while programmes are closed). Whether
ChatGPT's checkout takes new merchants could not be confirmed, so it waits. Its shape:
`/.well-known/acp.json` (404 unless the switch is on, a Stripe connection takes assistants' payments, the
catalogue has priced products and some rule accepts orders at once), `/v1/acp/checkout_sessions` with
`API-Version: 2026-04-17`, Bearer agent keys the owner mints, ACP's idempotency rules (the ones ADR-038
§3 built for UCP lodging, shared), `capabilities.payment.handlers` with one `dev.acp.tokenized.card`
handler (`psp: "stripe"`, `config.merchant_id` the profile), `ready_for_payment` only when a dry run of
the rules says the order is accepted at once, otherwise `requires_escalation` (`approval_required`).
Complete creates the order, runs its jobs inline (bounded), and calls `payOrder` with the token from
`payment_data.instrument.credential.token`; a decline answers `ready_for_payment` with
`payment_declined` (`recoverable`). A migration (`acp_sessions`) and a decision record of its own.

**UCP payment handlers.** A UCP shopping checkout door, a sibling of `ucp-lodging.ts`, publishes
`payment_handlers: {"com.stripe.payments": [{id, version: "2026-06-25", config: {environment,
business_profile}}]}`; complete's `credential {type: "stripe_payment_token", token}` calls `payOrder`. The
lodging door's deposit (`immediate` in a stay's schedule) could be paid the same way, with a
`payStay(scheduleId)` beside `payOrder`. `com.google.pay` and Apple Pay need their own merchant set-up.

**AP2 mandates.** `terms_sha` already binds a person's yes to exact terms (ADR-018 §5); a closed checkout
mandate is that, signed. When built:

1. A checkout signing key: P-256 (AP2 and UCP need ES256, ES384 or ES512; receipts are Ed25519,
   ADR-016), sealed by the secret box, published in `/.well-known/jwks.json` and a UCP profile's `keys[]`.
2. The confirm answer (and a UCP checkout response) gains `checkout_jwt`, a JWS over the same canonical
   order terms `terms_sha` hashes, so the two agree by construction; for UCP,
   `ap2.merchant_authorization`, a detached JWS over the JCS checkout without `ap2`.
3. `create_order` and `pay_order` take `mandate: {checkout: "<sd-jwt+kb>"}` in place of `terms_sha`:
   the SD-JWT's signature, key binding (`aud`, `nonce`, `sd_hash`) and `exp` are verified, then our own
   `merchant_authorization` by `kid`, then that the terms are the order's. Errors map to UCP's
   `mandate_required`, `mandate_invalid_signature`, `mandate_expired`, `mandate_scope_mismatch` and
   `merchant_authorization_invalid`.
4. The closed mandate's hash is kept as evidence (`agent_payments.mandate_sha`); the receipt's claims do
   not change (`trm` binds the terms already). The answer carries an AP2 checkout receipt signed with the
   P-256 key.
5. The payment mandate is for the credential provider, network and processor. For a Stripe business
   today, AP2's money leg is still a credential Stripe takes (an SPT), charged as here.
6. Only closed mandates first. Open ones (a person's limits set in advance) only where the owner's rules
   accept at once, with the amount range checked against the exact total.

**Saying early that the assistant will pay.** `create_order` could take `pay: "agent"`, so the link and
its email wait a couple of minutes for the assistant's payment before they are made.
