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
| `cancel_item` | `POST /v1/items/{id}/cancel` | Cancel an item you created, within the business's cancellation window. |
| `send_message` | `POST /v1/messages` | Start a conversation, or reply on an item you own with `item_id`. |
| `acknowledge_receipt` | `POST /v1/items/{id}/receipt-ack` | Counter-sign a receipt on your item with your agent's own Ed25519 key, so both sides hold it. See [Receipts](/docs/receipts/). |

Create calls take `payload` (the typed fields, schema.org names in camelCase), an optional `contact` (`name`, `email`, `phone`, `locale`), an optional free-text `message`, and `idempotency_key`.

## Owner operations

Authenticate with an owner API key or an OAuth 2.1 access token as a Bearer token, or with the owner session from the app.

| Operation | REST | Does |
| --- | --- | --- |
| `list_items` | `GET /v1/owner/items` | Items newest first. Filters: `type`, `state`, `needs_human`, `open_only` (default true), `sandbox`, full-text `q`. Paged. |
| `get_item` | `GET /v1/owner/items/{id}` | One item with its typed fields, events, conversation and the valid next transitions. |
| `transition_item` | `POST /v1/owner/items/{id}/transitions` | Fire one of the item's events with its `input`, a `reason` and `expected_version`. |
| `reply` | `POST /v1/owner/items/{id}/replies` | Reply to the customer, or leave an internal note with `internal: true`. |
| `get_settings` | `GET /v1/owner/settings` | The settings document and its version. |
| `update_settings` | `PUT /v1/owner/settings` | Change settings: the document you send is merged over the current one, so send only what changes, with `expected_version`. `null` removes a key, so its default applies again. Networks are keyed by origin: `{"networks": {"https://network.example.com": {"enabled": true}}}` adds or switches on one and leaves the others as they are. |
| `get_networks` | `GET /v1/owner/networks` | Each network in settings: on or off, what it gets, whether it has verified this instance, the last ping it took, the last error in a few words, and its receipts published, waiting and refused. |

Three more owner operations are in the capability set and arrive with the owner app: `update_availability`, `update_catalogue` and `run_setup_step`.

## Conventions

**Idempotency.** Every mutation from an agent or an API client carries an idempotency key, in the body as `idempotency_key` or in the `Idempotency-Key` header. The scope is the caller and the door, so keys never collide across principals. Same key and same request: the stored answer is replayed with status `200` and `Idempotent-Replayed: true`. Same key and a different request: `422 idempotency_mismatch`.

**Access tokens.** A create call from a caller without an account returns `accessToken`. Send it back as `access_token` (query or body) or as the `x-access-token` header to read or cancel the item. It is a capability, not an identity: whoever holds it may act on that one item.

**Versions.** Item views carry `version`. Send `expected_version` on a transition to be refused with `409 version_conflict` if a colleague, a rule or an agent moved the item first.

**Errors** are RFC 9457 problem documents, `application/problem+json`, with `type` (`https://surfingdog.ai/problems/<code>`), `title`, `status`, `detail`, `code` and, for input problems, `fields` listing `path`, `problem` (`missing` or `invalid`) and `message`. Codes and statuses: `invalid_input` 422, `not_found` 404, `not_allowed` 403, `wrong_state` 409, `unknown_event` 400, `guard_failed` 409, `slot_taken` 409, `version_conflict` 409, `idempotency_mismatch` 422, `unauthorized` 401. In MCP the same document comes back in `structuredContent.error` with `isError: true`, and the text names the fields to fix.

**Paging.** List endpoints take `cursor` and `limit` (1 to 100, default 50) and return `items` and a `cursor` for the next page.

**Money and time.** Amounts are integers in minor units with an ISO 4217 `currency`. Instants are ISO 8601 with an offset. Durations are minutes.

**Caching.** The profile and the manifest are cacheable for five minutes, services and products for one minute. Everything else is uncacheable.

**Sandbox.** An instance in test mode, a request with the `x-sandbox: 1` header, or a `sandbox.` hostname marks the item as sandbox: same machines, no real notifications.

## MCP

Both servers are stateless per request, so a client connects with a plain `POST` per call. Tools carry annotations (`readOnlyHint`, `idempotentHint`, `destructiveHint`) and short server instructions:

- public: start with `get_business_profile`, then `list_services` or `list_products`; for a booking, `check_availability`, then `create_booking` with an idempotency key you generate and keep; keep the access token;
- owner: `list_items` shows what needs a person, `get_item` shows the full story, `transition_item` moves an item with one of the events its view lists, `reply` speaks to the customer; never invent facts about availability or prices.

## Discovery

- `/.well-known/agent-inbox.json`: the [manifest](/docs/manifest/), listing the REST, OpenAPI and MCP doors. The email door is not in it.
- `/.well-known/oauth-protected-resource/mcp/owner` and `/.well-known/oauth-authorization-server`: OAuth 2.1 metadata for the owner MCP.
- `/healthz`: `{ "ok": true, "version": "…" }`.
- `POST /v1/email/inbound`: raw MIME from a mail provider's webhook or a forwarder, with the instance's shared secret in `X-Inbox-Email-Secret`.

## SDK

`@surfingdog/sdk` (MIT) is on npm. Today it carries the [webhook verifier](/docs/webhooks/) and the event types; the typed REST client, generated from the OpenAPI document with `openapi-typescript` and `openapi-fetch`, lands beside them. Until then, any OpenAPI client works.
