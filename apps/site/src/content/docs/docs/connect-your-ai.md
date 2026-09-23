---
title: Connect your AI
description: Let Claude, ChatGPT or any MCP client work your inbox on your behalf through the owner MCP.
---

Every instance serves two MCP servers. The public one at `/mcp` is for customers' agents and needs no login. The **owner MCP** at `/mcp/owner` is for you and the AI you trust: it lists what needs a person, shows an item's full story, moves items through their states, replies to customers and edits settings. It is stateless per request (MCP spec 2026-07-28), and its tools are generated from the same schemas as the REST API.

Two ways in: an API key, which works today, or OAuth 2.1 with a login, which the server supports and the owner app will complete once its sign-in creates a session.

## Today: an owner API key

An owner key is a bearer token that starts with `sdi_own_`. On your server:

```bash
node apps/inbox/dist/server.mjs create-owner-key laptop
```

The key is printed once and stored hashed. It is the same key the owner app takes at `/login`. Send it as `Authorization: Bearer sdi_own_…` to `/mcp/owner` or to any `/v1/owner/*` route; for Claude Code, for example:

```bash
claude mcp add --transport http --header "Authorization: Bearer sdi_own_…" inbox https://<your-instance>/mcp/owner
```

Any MCP client that can send a header works the same way. Agent keys (`sdi_agent_…`) exist for customers' agents that want a stable identity on the public doors.

Without a command line, on a Cloudflare install for example, sign in to the owner app by email and create a key under **Settings → Keys**. Keys made there are integration keys: named, limited to the scopes you pick, and revocable in one click. Give each system its own; see [Keys and scopes](/docs/api/#keys-and-scopes).

## OAuth 2.1

The instance is its own authorization server, so a consumer product connects with a login rather than a pasted key ([ADR-004](https://github.com/surfingdogai/inbox/blob/main/docs/adr/004-owner-auth.md)). A client discovers it from the protected resource:

```
GET /.well-known/oauth-protected-resource/mcp/owner
GET /.well-known/oauth-authorization-server
```

What it supports: authorization code with PKCE (S256, required); public clients only; **Client ID Metadata Documents** first, which means the `client_id` is the `https` URL of a JSON document describing the client, fetched by the instance and cached; dynamic client registration (`POST /oauth/register`) as the fallback for clients that still use it; opaque hashed tokens; access tokens that last an hour and refresh tokens that last thirty days and rotate on every use, with reuse detection; one consent screen listing the scopes in plain words.

Scopes: `inbox:read`, `inbox:write`, `events:read`, `catalogue:write`, `availability:write`, `settings:read`, `settings:write`, `setup:run`, `integrations:write`, `keys:write`, `offline_access`. A client that asks for none gets `inbox:read inbox:write settings:read offline_access`. An AI that will set the business up should ask for the scopes it needs. Today a call outside them still goes through and is recorded under Settings → Keys, where the owner sees it; the owner can switch on refusing them, and a later release refuses them for everyone.

In the history and in every event, the AI appears as itself: actor `owner_ai` with the app's name, not as you.

Endpoints: `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`. The authorization step needs an owner session in the browser, which comes from a magic link by email (`POST /auth/magic-link`, then `GET /auth/verify`; the first address to sign in on a fresh instance becomes its owner). The owner app offers both ways in: the emailed link, which creates that session, and an owner API key for people who only ever use the API. Passkey sign-in is being built.

### Claude

In Claude, go to Settings, then Connectors, and add a custom connector with your owner MCP URL, `https://<your-instance>/mcp/owner`. Claude fetches the metadata, sends you to your instance to sign in and approve the scopes, and connects. Claude uses a Client ID Metadata Document, so nothing needs to be registered by hand.

### ChatGPT

In ChatGPT, enable developer mode in the connector settings, then create a connector with the same URL and choose OAuth. Sign in on your instance when asked.

### Other clients

Cursor, VS Code and any client that speaks Streamable HTTP with OAuth 2.1 work the same way. Clients that cannot do OAuth use an API key.

## What the owner tools do

There are 42 owner tools:

| Tool | Does |
| --- | --- |
| `list_items` | Items newest first, filtered by type, state or `needs_human`, or searched with `q`. |
| `get_item` | One item with its typed fields, event history, conversation and the valid next transitions. |
| `transition_item` | Fire one of the events the item lists (`confirm`, `propose`, `decline`, `quote`, …); pass `expected_version` to avoid racing a colleague. |
| `reply` | Send a reply to the customer, or an internal note with `internal: true`. |
| `get_profile`, `update_profile` | The business's name, domain, time zone, currency and languages. |
| `list_services`, `upsert_service`, `archive_service` | Bookable services. |
| `list_products`, `upsert_product`, `archive_product` | Products. |
| `get_availability`, `set_opening_hours`, `clear_service_hours`, `set_closures` | Opening hours and closed days. |
| `list_rules`, `list_rule_presets`, `apply_rule_preset`, `upsert_rule`, `delete_rule`, `test_rule` | What happens on its own. |
| `list_webhooks`, `create_webhook`, `update_webhook`, `rotate_webhook_secret`, `delete_webhook`, `send_test_event`, `list_webhook_deliveries`, `replay_webhook_delivery`, `replay_missing_webhook_deliveries`, `list_events` | Where events go, and the event stream. See [Webhooks](/docs/webhooks/). |
| `list_feeds`, `add_feed`, `import_feed_now`, `remove_feed` | Product feeds. See [Feeds](/docs/feeds/). |
| `list_api_keys`, `create_api_key`, `revoke_api_key` | Integration keys. The AI may create and revoke them only once you switch on **Let my AI create keys** in Settings → Keys. |
| `get_settings` | The settings document and its version, without its secrets. |
| `update_settings` | Change settings: send only the sections that change, with `expected_version`; the rest keeps its values, and `null` removes a key. Networks are keyed by origin, so adding or switching off one leaves the others alone. |
| `get_networks` | The networks this inbox reports to and how each is doing: last ping, last error, receipts published. |

The server's instructions to the model are short: never invent facts about availability or prices; read them first; give each system its own key; send an `idempotency_key` with every write, so a retry never does it twice. Every refusal names the fields to fix.
