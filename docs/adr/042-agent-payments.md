# ADR-042 — Agent payments: a customer's assistant pays an accepted order at the business's own Stripe

**Status:** proposed, 26 October 2026. Builds on ADR-023 (pay links), ADR-036 (money in each currency's
own minor unit, extra key permissions asked for on demand) and ADR-018 §5 (the confirm step and
`terms_sha`). Migration 0034 (`agent_payments`). No spec version: `pay_order` is a door of the inbox, not
a schema of the spec, and the business profile's payments do not change (§1).

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
  `deactivated_reason` is `consumed`, `expired`, `resolved` or `revoked`. "By using SPTs, you agree to
  the terms of service": nothing to accept first. Offered in the US, Canada, the UK, Switzerland, Norway,
  Liechtenstein and most of the EU and EEA. Its agent side ("Handle next actions",
  https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens?agent-seller=agent): a token
  "can transition to the requires_action state when a payment created by the seller needs additional
  customer action", the agent's platform handles it with its person, and Stripe then continues
  processing; it "usually happens for redirect payment methods such as Klarna and Affirm, and it might
  happen when card payments require 3D Secure".
- **Stripe's idempotent requests** (https://docs.stripe.com/api/idempotent_requests): Stripe saves the
  status and body of the first request with a key once the endpoint has begun, "including 500 errors",
  and answers every retry with it. A request that conflicted with one still running under the key (409
  `idempotency_error`) keeps nothing; a key sent again with other parameters is refused (400
  `idempotency_error`).
- **Orchestrated Commerce Agreements**
  (https://docs.stripe.com/agentic-commerce/agents/embedded, "Manage seller relationships"): "An OCA is a
  required connection between your agent and a seller that enables agentic commerce flows. Only a
  seller can initiate an OCA request." The agent approves it.
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
- The business profile's `payments` adds nothing. `acp_delegated` names ACP's delegated payment, whose
  token is minted against a checkout session (`allowance.checkout_session_id` is required) and handed
  over only in `POST /checkout_sessions/{id}/complete`, after discovery at `/.well-known/acp.json`; an ACP
  platform that trusted the listing would find no such door here and could not pay. A token for this
  door (a Stripe SPT at `pay_order`) waits for a version of the payments vocabulary; until then the doors
  say it themselves: the MCP server lists `pay_order`, and the status door `payment.agent`.

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
6. An echoed allowance (the token's `usage_limits` as Stripe gave them to the platform: `max_amount`,
   `currency`, and `expires_at` in seconds since 1970, or a date and time) is in the same currency, at
   least the total, and not expired. It can only refuse: Stripe holds the token to its own limits,
   whatever is echoed. ACP passes no allowance to a seller, so none is expected.
7. A token seen before is answered as it went (below). Otherwise, at most five declined attempts per
   order and thirty per inbox in a day (`too_many_attempts`), which blunts card testing. The doors give
   paying its own rate class too (`pay`: thirty at once and sixty an hour per address), so a script
   trying cards is shut before it reaches those.

Then the attempt is claimed, charged and recorded. A charge that went through is recorded on the order
as a link's payment is: `record_payment` by the connector, with the PaymentIntent's id and the amount
Stripe took. The receipt `paid` (with `amt` and `pay`), the customer's email and the closing of any open
link follow from the existing paths.

### 4. Once

- **One per order.** `agent_payments_live` is unique on `item_id` while an attempt is `creating`,
  `processing`, `unknown` or `paid`. Two assistants paying at once, one paying again after the first went
  through, or another token while nobody knows what the first did, make one charge: the second is told
  `in_progress` or `already_paid`. The status door says `processing` for an attempt that holds the order
  and `paid` for one paid but not yet on the order, and offers neither the link nor `agent` then.
- **One per token.** The token is never kept: only `SHA-256("spt:" + token)`, unique. The same token
  sent again is answered as it went, never charged again.
- **One per attempt.** The PaymentIntent is made with `Idempotency-Key: sdi-<row id>-pi`, and carries
  `metadata[sdi_pay]` (the row's id) whatever the key. When Stripe does not say what it did, the attempt
  stays `creating`, holding the order, and the assistant is told `platform_unavailable` with
  `Retry-After`: retry with the same token and key, never a new token. Which key the retry goes under
  follows from what Stripe keeps:
  - **No answer** (a timeout, a cut connection), an edge's 502, 503 or 504, or a 409 `idempotency_error`
    (the first request still runs): the same key, which Stripe answers as it did the first. The claim
    is kept until it ends (two minutes from the ask), so no retry reaches Stripe while the first may
    still run.
  - **A 500**, or a 400 `idempotency_error`: Stripe answers the same to every retry with the key, so the
    retry goes under a new one (`sdi-<row id>-pi-<n>`, `agent_payments.retry_key`), after the inbox
    looks for a charge of the attempt's (Stripe's search, by `metadata[sdi_pay]`). It sends the same
    token, which pays once: if the first ask spent it, Stripe refuses it, and nothing is charged twice.
  - **A 429**: nothing was done, and the same key asks again after `Retry-After`.
  - **A refusal of a retry** (the token spent, unknown, an answer that cannot be read, the key refused)
    may be about what the first ask did, so it is never a failure: the attempt holds the order
    (`in_progress`) for three minutes, past the search's lag, and is looked for again.
- **One per request.** The caller's `idempotency_key` replays the stored answer; the stored request
  holds the token's hash, never the token.

An attempt Stripe never answered is looked up by the sync a few minutes after it was last asked
(`asked_at`), by the inbox's own id for it. Found, it is settled as it stands, so a charge whose answer
was lost is recorded, never made twice. Not found a quarter of an hour after the last ask, it was never
made: the order is free for another token, and a retry with the same token asks under a new key. Until
then no other token is charged for the order. An attempt still `creating` two hours after its last ask,
or still `processing` after a day, becomes `unknown` and the owner is told on the order to check it in
Stripe; `unknown` still holds the order, and the sync still reads it back hourly, so a payment that goes
through later is recorded, and one never made frees the order. The owner can settle it on the order
too (record the payment, or cancel).

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
| Another attempt on its way, or one Stripe has not yet said the outcome of | 409 | `in_progress` (`retry_after_s`) | Retry with the same token and key after `retry_after_s`. |
| Not this business's token, nor this mode's | 422 | `token_invalid` | A new token for `business_profile` and `environment`. |
| Expired, used or revoked (Stripe answers the three alike), or held by another payment | 422 | `token_used`; `token_expired` when the echoed allowance has expired, before Stripe is asked | A new token. |
| Below the total, or another currency | 422 | `token_limit` | A token for `platform_amount`. |
| Declined | 402 | `payment_declined` (`attempts_left`) | Nothing was charged: another card, a new token. |
| Declined because the card needs its holder, and the PaymentIntent cannot ask them | 402 | `authentication_required` (`payment_url`) | Send its person to the link. |
| Too many declines today | 429 | `too_many_attempts` | Give its person `payment_url`. |
| Stripe did not say what it did | 503 | `platform_unavailable` (`Retry-After`) | Retry with the same token and key, never a new token. |
| Processing, or the card asks its holder to confirm (3D Secure, a redirect) | 202 | `state: "processing"` | Its platform shows its person the step Stripe asks for; read the status until it is paid. |

Stripe's own decline codes (`insufficient_funds`, `fraudulent`, …) are kept on the attempt for the owner
and never told to the assistant. A synchronous decline does not move the order, so no failure email goes
for an attempt the person never left. A payment that was processing and then failed moves the order to
`payment_failed`, as a link's does.

A PaymentIntent in `requires_action` waits for its card holder, as Stripe's flow for these tokens has it:
the agent's platform is told and shows its person the step (a 3D Secure challenge, a redirect for Klarna
or Affirm), and Stripe goes on once they do. A sandbox answers it with `next_action.type`
`shared_payment_token_action` and asks the seller for no `return_url`; the token is held by that payment
meanwhile, and let go if it is cancelled. The inbox answers `202 processing` and reads it back on each
sync until Stripe says. Strong customer authentication applies in the UK and the EEA, so this is the
common case there, not an edge. One its holder has not confirmed an hour after the ask (past a token's
own life) is cancelled, so it is never taken later, and read again: one confirmed meanwhile is paid;
one stopped is `cancelled` (`authentication_required`), and the order is due again. ACP's own
`authentication_required` checkout status and delegated authentication belong to the ACP door (Not
decided here).

Stripe does not document the error codes it gives a token it will not charge, and a sandbox gives a
code only for an unknown one (below): the adapter reads the parameter it names and its words as well as
its code, with the token taken out of them (over the limit or another currency; expired; deactivated or
held by another payment; else unknown).

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

What only the owner can do, outside the inbox, and the switch's copy says: create a Stripe profile, add
the permission to the key, and start an Orchestrated Commerce Agreement with each AI platform they want
to be paid through, in Stripe and in the same mode. The seller starts it and the platform approves it;
a platform cannot ask for one, so an owner who waits for a request never gets one, and that platform's
tokens for the business fail. Stripe's terms for SPTs are accepted by using them.

### 8. Data model

Migration 0034 adds `agent_payments` and changes nothing that exists. An inbox whose owner never switches
it on writes no row. One row per attempt: the order, the connection (not a foreign key, so the record
outlives a disconnect), the door, the amount and currency (the inbox's minor units), the mode, the
`terms_sha` it was charged for, the token's hash, the state (`creating`, `processing`, `paid`, `declined`,
`failed`, `cancelled`, `unknown`), Stripe's id, method, amount taken and dashboard page, our failure code
and Stripe's words (with any token they name taken out), a note for the owner, which idempotency key it
is asked under (`retry_key`) and when it was last asked (`asked_at`), the claim, and when it went on the
order. No row holds a
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

## Checked in a Stripe sandbox

On 27 October 2026, against a Stripe sandbox with its secret test key (`sk_test_…`), in
`2026-09-30.preview`, with tokens from Stripe's seller test helper (`POST
/v1/test_helpers/shared_payment/granted_tokens` with `payment_method`, `usage_limits[currency]`,
`usage_limits[max_amount]` and `usage_limits[expires_at]`, between now and 90 days ahead). Tokens, ids
and log links are left out below. What a sandbox's secret key cannot show is said as not checked.

1. **The probe.** An empty `POST /v1/payment_intents` answers `400 invalid_request_error`
   `parameter_missing` (`param: "amount"`) for a key that may write PaymentIntents, and makes nothing. An
   unknown version answers `400` "Invalid Stripe API version: …" with no code, which the probe reads as
   the version refused. **Not checked:** that a restricted key without PaymentIntents: Write gets 403
   before that 400. It needs such a key, made in the Dashboard. If Stripe answered 400 first, the switch
   would come on, and the first charge's 403 would switch it off again and tell the owner (§7), so
   nothing is charged either way.
2. **The charge.** `amount`, `currency`, `confirm=true`,
   `payment_method_data[shared_payment_granted_token]`, `description`, `metadata[sdi_pay]` and an
   `Idempotency-Key` answer `200` with `object: "payment_intent"`, `status: "succeeded"`,
   `amount_received` the amount, `capture_method: "automatic_async"`, `payment_method_types: ["card"]`, a
   new `payment_method` and the token in `shared_payment_granted_token`. No `return_url` was asked, for a
   card that needs no step nor for one that does (7). The token reads back `deactivated_reason:
   "consumed"` with `usage_details.amount_captured` the amount. The same request under the same key
   answers the same PaymentIntent. **Not checked:** the same with a restricted key holding only
   PaymentIntents: Write.
3. **Refusals.** Every one is `400 invalid_request_error`. Only an unknown token has a code:
   - none this account knows (another account's, a made-up one): `code: "resource_missing"`, `param:
     "payment_method_data[shared_payment_granted_token]"`, "No such shared_payment_token: '…'";
   - expired, consumed and revoked alike, no code: "The shared payment granted token cannot be used
     because it is already in a deactivated state." The token's own `deactivated_reason` says which
     (`expired`, `consumed`, `revoked`), but the charge's answer does not, so the inbox says `token_used`
     for all three;
   - held by a payment waiting on its holder, no code: "The provided shared payment granted token is
     currently being used for another payment intent.";
   - over its limit, no code: "The requested amount is greater than the remaining amount capturable with
     this shared payment granted token." (an amount under the limit is charged);
   - another currency, no code: "This shared payment granted token can only be used to process payments
     in `eur`."

   This found a bug, fixed with tests: the adapter looked for `shared_payment` or `granted_token` with an
   underscore, and Stripe's words have spaces, so each of the last four was taken for a refusal about
   something else (`agent_pay_unavailable`, `refused`), and the assistant was sent to the link instead of
   being told to get a new token; and "can only be used" would have been read as a spent token.
   The fake Stripe of the tests now answers in these words.
4. **Profile IDs.** Not answered: Stripe has no API that reads an account's own profile (`GET
   /v1/profiles` is an unknown URL), and its docs give no rule. Every test profile Stripe shows starts
   `profile_test_` (the sandbox seller profile in its agent docs; the test helper's
   `agent_details.network_business_profile`), and its live examples `profile_`. The inbox takes any
   `profile_…` and relies on the key for the mode, so nothing waits on it.
5. **ChatGPT's `config.merchant_id`.** Not answerable in a sandbox, and no public document says it. ACP's
   payment-handler RFC shows a Stripe `acct_…` there; Stripe's own handlers name a `profile_…`
   (`business_profile` for UCP); OpenAI's commerce docs say neither. It matters only to the ACP door,
   which is not built (Not decided here).
6. **A spent token under a new key.** After the charge in 2, the same token in the same request under
   a new `Idempotency-Key` answers `400` "… already in a deactivated state." and makes no second
   PaymentIntent (a search by `metadata['sdi_pay']` finds only the first, so the search the inbox uses
   works in this version too). Asking again under a new key after a 500 charges nothing twice.
7. **Cards that ask their holder.** `pm_card_threeDSecure2Required`, `pm_card_authenticationRequired`,
   `pm_card_authenticationRequiredOnSetup` and
   `pm_card_authenticationRequiredChargeDeclinedInsufficientFunds` answer `200` `status:
   "requires_action"`, `next_action: {type: "shared_payment_token_action"}`, no `return_url` asked;
   `pm_card_threeDSecureOptional` is charged at once. The token stays active and held: another
   PaymentIntent with it is refused as being used for another payment; once the waiting one is cancelled
   (`200 canceled`; cancelling again is `400 payment_intent_unexpected_state`, which the inbox lets be),
   the token is free again. A declined card (`402 card_error`, `card_declined` with a `decline_code`, the
   PaymentIntent in `requires_payment_method` in the error) leaves the token active too. **Not checked:**
   redirect methods. The seller test helper refuses a Klarna payment method ("A `return_url` is required
   when creating a shared payment token") and refuses `return_url` as an unknown parameter, so the
   `return_url` is the token's, given by the agent's platform when it makes it, and a seller sandbox
   cannot make one; nor, without a restricted key, which of these a restricted key reaches.

Still to check before a real business uses it, with a restricted sandbox key the owner makes in the
Dashboard: 1 (403 before 400, with the permission set to None) and 2 and 7 (the same requests with only
PaymentIntents: Write). A redirect method needs an agent's platform to make the token.

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
3. `create_order` takes `mandate: {checkout: "<sd-jwt+kb>"}` in place of `terms_sha`: the SD-JWT's
   signature, key binding (`aud`, `nonce`, `sd_hash`) and `exp` are verified, then our own
   `merchant_authorization` by `kid`, then that the terms are the order's. Errors map to UCP's
   `mandate_required`, `mandate_invalid_signature`, `mandate_expired`, `mandate_scope_mismatch` and
   `merchant_authorization_invalid`. The checkout mandate is the business's to verify; the payment
   mandate is not (item 5).
4. The closed mandate's hash is kept as evidence (`agent_payments.mandate_sha`); the receipt's claims do
   not change (`trm` binds the terms already). The answer carries an AP2 checkout receipt signed with the
   P-256 key.
5. The payment mandate is not ours to verify, nor something Stripe takes today. UCP's AP2 extension
   carries it in `payment.instruments[*].credential.token` as a composite token, and "the business
   passes the token (composite object) to their Payment Handler / PSP", which verifies it; AP2 has it
   verified by the credential provider, the network and the merchant's processor. Stripe documents no
   PaymentIntent parameter that takes or checks a payment mandate: `com.stripe.payments` takes a
   credential of type `stripe_payment_token` or `pk_payment_token` only. So `pay_order` cannot charge an
   AP2 composite as `payment_method_data[shared_payment_granted_token]`, and a bare SPT in its place
   drops the payment mandate and does not conform. AP2 payments for a Stripe business wait for Stripe
   (or a processor the business uses) to verify payment mandates; until then the inbox can take AP2's
   checkout mandate on `create_order` and be paid as here, with an SPT, saying it is not AP2's payment
   leg.
6. Only closed mandates first. Open ones (a person's limits set in advance) only where the owner's rules
   accept at once, with the amount range checked against the exact total.

**Saying early that the assistant will pay.** `create_order` could take `pay: "agent"`, so the link and
its email wait a couple of minutes for the assistant's payment before they are made.
