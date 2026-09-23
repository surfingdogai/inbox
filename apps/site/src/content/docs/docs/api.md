---
title: API
description: The public and owner operations, their REST routes and MCP tools, and the conventions they share.
---

One capability set, several doors. Every operation exists once in the core and is exposed by thin adapters: REST under `/v1` with an OpenAPI 3.1 document, and MCP tools with the same names and the same schemas ([ADR-010](https://github.com/surfingdogai/inbox/blob/main/docs/adr/010-protocols.md)). Whichever door an agent takes, it gets the same item and the same errors.

The live OpenAPI document of our own instance: [inbox.surfingdog.ai/openapi.json](https://inbox.surfingdog.ai/openapi.json). Every instance serves its own at `/openapi.json`.

## Public operations

No authentication. Anonymous callers receive an `accessToken` when they create an item; agents with an agent key (`sdi_agent_…`) are recognised as a stable principal.

| Operation | REST | Does |
| --- | --- | --- |
| `get_business_profile` | `GET /v1/business` | Name, time zone, currency, languages and the item types accepted. |
| `list_services` | `GET /v1/services` | Bookable services with duration and price model. Paged. |
| `list_products` | `GET /v1/products` | Orderable products with prices in minor units. Paged, searchable with `q`. |
| `check_availability` | `GET /v1/availability` | Free start times for a service between `from` and `to` (at most 14 days), optionally for a `party_size`. |
| `request_quote` | `POST /v1/quotes` | Ask for a price on something custom. Creates a `quote_request`. |
| `create_booking` | `POST /v1/bookings` | Request a service at a time. Check availability first. Creates a `booking`. |
| `create_order` | `POST /v1/orders` | Order products. Creates an `order`. |
| `get_item_status` | `GET /v1/items/{id}` | The current state of an item you created, and what you may do next. |
| `cancel_item` | `POST /v1/items/{id}/cancel` | Cancel an item you created. After the business's cancellation window, a confirmed booking is cancelled late where the business records late cancellations, and refused where it does not. |
| `send_message` | `POST /v1/messages` | Start a conversation, or reply on an item you own with `item_id`. |
| `acknowledge_receipt` | `POST /v1/items/{id}/receipt-ack` | Counter-sign a receipt on your item with your agent's own Ed25519 key, so both sides hold it; or, in a request you sign, name it by `receipt_id`. See [Receipts](/docs/receipts/). |
| `verify_customer` | `POST /v1/customers/verify` | Prove you are a customer the business already knows: six digits go to the address it has for you (`202 {sent_to}`), and sending them back as `code` recognises you (`200 {recognised: "strong"}`). |

Create calls take `payload` (the typed fields, schema.org names in camelCase), an optional `contact` (`name`, `email`, `phone`, `locale`), an optional free-text `message`, and `idempotency_key`.

**Who you carry.** Every public call takes `pass` (a person's passes, space-separated, at most 8) and `key` (a person's key, exchanged once for a pass), or the passes in an `Sdi-Pass` header; a `GET` reads only the header. Never put either in a URL. The inbox presents each to the network that issued it, when that network is switched on, and stores none of them: only a hash of a pass, to recognise it again. Create and status answers carry `identity`:

| Field | |
|---|---|
| `recognised` | `strong` (a customer the business knows, proven), `weak` (the email or phone of one, not proven) or `none`. |
| `passes` | Passes to keep, `[{network, pass}]`: a first booking's pass, or the one a key became. Shown in the answer that made them. |
| `verify` | `available` when a one-time code can prove a weak match; `sent_to`, the masked address, once one went out. |
| `networks` | What happened at each network: `issued`, `presented`, `person_exists`, `pending`, `unknown_pass`, `revoked`, `pass_requires_signature`, `carries_secret`, `unreachable`, `rate_limited`, `not_enabled`, `cannot_sign`. |
| `guide` | `https://surfingdog.ai/for-agents.md` |

A first booking or order with an email and nothing carried asks each network that issues for a key, which is emailed to the customer; nothing about the booking waits for it. A network that is slow or down leaves the customer `new` there, never refused. How an agent should use all this is [the agent guide](https://surfingdog.ai/for-agents.md).

**Signed agents.** An agent may sign any request with HTTP Message Signatures (`sdi-agent/1`, Web Bot Auth compatible: its own key in `Sdi-Agent-Key`, or a platform's key named by `Signature-Agent`). An unsigned request is served the same; a signature that does not verify counts as unsigned, and the answer says why in `Sdi-Signature: invalid; reason="…"`. A signed request that changes something is kept once: the same signature again is a retry when it comes from the same client with the same idempotency key (answered as the first time), and `401 replayed_signature` otherwise. A pass reference (`sdpass1_<network>_<id>`) works only in a request signed by a key delegated to it: the inbox forwards that signature to the network, which checks it again, so a signed request must not carry a secret in its URL or its `Sdi-Pass`, nor cover any header but `Content-Digest`, `Content-Type`, `Sdi-Pass` and its key's (`Sdi-Agent-Key` or `Signature-Agent`) (the answer says `carries_secret` and nothing is forwarded). Send an access token in `X-Access-Token` on a signed request. `@surfingdog/sdk` signs requests for you.

## Owner operations

Authenticate with a Bearer token: an owner key, an integration key (see [Keys and scopes](#keys-and-scopes)) or an OAuth 2.1 access token. The owner app uses its session.

| Operation | REST | Does |
| --- | --- | --- |
| `list_items` | `GET /v1/owner/items` | Items newest first. Filters: `type`, `state`, `needs_human`, `open_only` (default true), `sandbox`, full-text `q`. Paged. |
| `get_item` | `GET /v1/owner/items/{id}` | One item with its typed fields, events, conversation, receipts and the valid next transitions. Each event says who caused it (`by`: `kind`, `id`, and the key's or AI app's `name`) and through which door (`channel`). `customer` says who is asking: `match` (`strong`, `weak`, `none`), `possible` (the customer a weak match may be), `known` and `history` (your own record with them), `persons` (per network that presented them: `tier`, `score`, `kept`, `broken`, `businesses`, `since`, `email_proven`, `unusual_use`, and whether it was with this request or `earlier`) and `agent` (how the assistant signed). |
| `transition_item` | `POST /v1/owner/items/{id}/transitions` | Fire one of the item's events with its `input`, a `reason` and `expected_version`. |
| `reply` | `POST /v1/owner/items/{id}/replies` | Reply to the customer, or leave an internal note with `internal: true`. |
| `get_settings` | `GET /v1/owner/settings` | The settings document and its version. Secrets are never returned: a secret that is set reads `(redacted)`, and `redacted` names its path, such as `email.inboundSecret`. Writing the document back as read, or without it, keeps it. |
| `update_settings` | `PUT /v1/owner/settings` | Change settings: the document you send is merged over the current one, so send only what changes, with `expected_version`. `null` removes a key, so its default applies again. Networks are keyed by origin: `{"networks": {"https://network.example.com": {"enabled": true}}}` adds or switches on one and leaves the others as they are. |
| `get_networks` | `GET /v1/owner/networks` | Each network in settings: on or off, whether it gives first-time customers a key (`issue`), what it gets, whether it has verified this instance, the last ping it took, the last error in a few words, the rules it applies, your own `standing` there (`tier`, `score`, `ranked`, and when it said so) from the last signed ping, what became of that ping's signature (`ping_signature`), and its receipts published, waiting, held and refused. |
| `list_api_keys` | `GET /v1/owner/api-keys` | The owner and integration keys: name, scopes, last use, and every call each made outside its scopes. Never a key itself. |
| `create_api_key` | `POST /v1/owner/api-keys` | A named, scoped, revocable integration key. The key is in this answer and in no other. |
| `revoke_api_key` | `DELETE /v1/owner/api-keys/{id}` | Revoke a key at once and for good. |

Setup (profile, services, products, opening hours, closed days, rules) is under `/v1/owner/profile`, `/services`, `/products`, `/availability` and `/rules`, with the MCP tools `update_profile`, `upsert_service`, `upsert_product`, `set_opening_hours`, `set_closures`, `upsert_rule` and their neighbours. Webhooks, deliveries and the event stream are in [Webhooks](/docs/webhooks/); product feeds (`list_feeds`, `add_feed`, `import_feed_now`, `remove_feed`) in [Feeds](/docs/feeds/). The OpenAPI document lists every owner operation with its query parameters, its response schema and its security.

## Keys and scopes

Give every system that calls the inbox its own key: Zapier, a shop, a till, a form plugin. Create one in the owner app under **Settings → Keys**, or with `POST /v1/owner/api-keys`:

```json
{ "name": "Zapier", "preset": "automation" }
```

The answer holds the key (`sdi_own_…`) once. Send it as `Authorization: Bearer …`. It works on `/v1/owner` and `/mcp/owner` until it is revoked or reaches its optional `expires_at`.

| Preset | Scopes | For |
| --- | --- | --- |
| `automation` | `inbox:read inbox:write events:read` | Zapier, Make, n8n |
| `shop_sync` | `catalogue:write inbox:read inbox:write events:read` | A shop or a point of sale |
| `calendar_sync` | `availability:write inbox:read inbox:write events:read` | A calendar or a booking tool |
| `read_only` | `inbox:read events:read settings:read` | Reports and dashboards |

The scopes are `inbox:read`, `inbox:write`, `events:read`, `catalogue:write`, `availability:write`, `settings:read`, `settings:write`, `setup:run` (rules), `integrations:write` (webhooks and feeds) and `keys:write`. OAuth clients ask for the same names. A key never carries `keys:write`: an integration key cannot mint keys.

**The owner's AI** may create and revoke integration keys (`create_api_key`, `revoke_api_key`) only after the owner switches on **Let my AI create keys** in Settings → Keys (`security.aiMayCreateKeys`). It can never create a key with `settings:write`, and it can revoke only keys an AI made: the owner's own keys (the command-line key and every key the owner made in Settings → Keys) are the owner's to revoke. Only the owner, in the owner app, can change the `security` section; a document written back with that section unchanged is accepted and leaves it as it is.

**Scopes are logged first.** In this release a call outside a key's scopes, or outside an AI app's granted scopes, still goes through, and it is recorded: `list_api_keys` shows each key's calls outside its scopes, with the scope it needed, and the same for AI apps. The owner can refuse them now with **Refuse calls outside a key's scopes** (`security.enforceScopes`); a later release turns that on for everyone. An AI that sets things up should ask for the scopes it needs when it connects.

**Limits.** An integration key has a generous bucket of its own, about ten calls a second, so a loop between the inbox and another system cannot run for ever. The owner's own session, keys and AI are not limited.

## Conventions

**Idempotency.** Every write takes an idempotency key: in the `Idempotency-Key` header or as `idempotency_key` in the body on REST, as the `idempotency_key` argument on MCP. That includes the owner's setup writes (services, products, hours, rules, settings, webhooks, feeds, keys). Same key and same request: the stored answer is replayed with status `200` and `Idempotent-Replayed: true`, and nothing is done twice. Same key and a different request: `422 idempotency_mismatch`. The owner's and the owner's AI's keys are scoped to the business, so a retry through MCP of a request first sent through REST is the same request; an integration key's keys are its own, so two systems that pick the same key never collide; a customer's keys are scoped to the customer and the door. An answer that carries a secret (a signing secret, a key) is stored sealed, and a replay shows the secret only to whoever made the first request. Keys are kept for 30 days: they are for retries, not a record.

**Who did it.** Every event, in the history, the [event stream and webhooks](/docs/webhooks/), carries `actor` (`kind`: `owner`, `owner_ai`, `integration`, `connector`, `rule`, `system`, `customer_agent` or `customer_human`; `id`; and `name` for a key or an AI app), the `channel` it came through and `sandbox`. A customer's id is never given out. A two-way sync skips the events whose actor is its own key.

**Access tokens.** A create call from a caller without an account returns `accessToken`. Send it back as `access_token` (query or body) or as the `x-access-token` header to read or cancel the item; on a signed request, only the header or the body. It is a capability, not an identity: whoever holds it may act on that one item. A person's pass does the same for their own items once the business knows them by it (their first booking with it, or a proven match): with the pass in `Sdi-Pass`, the status, cancel and acknowledge doors need no token.

**Versions.** Item views carry `version`. Send `expected_version` on a transition to be refused with `409 version_conflict` if a colleague, a rule or an agent moved the item first.

**Errors** are RFC 9457 problem documents, `application/problem+json`, with `type` (`https://surfingdog.ai/problems/<code>`), `title`, `status`, `detail`, `code` and, for input problems, `fields` listing `path`, `problem` (`missing` or `invalid`) and `message`. Codes and statuses: `invalid_input` 422, `not_found` 404, `not_allowed` 403, `wrong_state` 409, `unknown_event` 400, `guard_failed` 409, `slot_taken` 409, `version_conflict` 409, `idempotency_mismatch` 422, `unauthorized` 401; for one-time codes `nothing_to_verify` 409, `already_verified` 409, `bad_code` 422, `code_expired` 422, `too_many_attempts` 429; `replayed_signature` 401; and `positive_only` 422 for a rule that reads a customer's standing and would refuse, cancel or expire. In MCP the same document comes back in `structuredContent.error` with `isError: true`, and the text names the fields to fix.

**Paging.** List endpoints take `cursor` and `limit` (1 to 100, default 50) and return `items` and `next_cursor`. Pass `next_cursor` back as `cursor` for the next page; it is `null` on the last one.

**Money and time.** Amounts are integers in minor units with an ISO 4217 `currency`. Instants are ISO 8601 with an offset. Durations are minutes.

**Caching.** The profile and the manifest are cacheable for five minutes, services and products for one minute. Everything else is uncacheable.

**Sandbox.** An instance in test mode, a request with the `x-sandbox: 1` header, or a `sandbox.` hostname marks the item as sandbox: same machines, no real notifications.

## MCP

Both servers are stateless per request, so a client connects with a plain `POST` per call. Tools carry annotations (`readOnlyHint`, `idempotentHint`, `destructiveHint`) and short server instructions:

- public: start with `get_business_profile`, then `list_services` or `list_products`; for a booking, `check_availability`, then `create_booking` with an idempotency key you generate and keep; keep the access token;
- owner: `list_items` shows what needs a person, `get_item` shows the full story, `transition_item` moves an item with one of the events its view lists, `reply` speaks to the customer; never invent facts about availability or prices; give each system its own key; send an idempotency key with every write.

## Discovery

- `/.well-known/agent-inbox.json`: the [manifest](/docs/manifest/), listing the REST, OpenAPI and MCP doors. The email door is not in it.
- `/.well-known/oauth-protected-resource/mcp/owner` and `/.well-known/oauth-authorization-server`: OAuth 2.1 metadata for the owner MCP.
- `/healthz`: `{ "ok": true, "version": "…" }`.
- `POST /v1/email/inbound`: raw MIME from a mail provider's webhook or a forwarder, with the instance's shared secret in `X-Inbox-Email-Secret`.

## SDK

`@surfingdog/sdk` (MIT, no dependencies) is on npm. For a business's systems it carries the [webhook verifier](/docs/webhooks/) and the event types. For a customer's agent it carries the person's strings (`parseCredential`, `keepPasses`, `sdiPassHeader`, `passFromKey`), request signing (`generateAgentKey`, `signRequest`, and `requestSignInCode`, `signIn` and `delegate` for the one-time setup at a network) and receipts (`verifyReceipt`, `signAck`). Every one is checked against the published vectors. The typed REST client, generated from the OpenAPI document, lands beside them; until then, any OpenAPI client works.
