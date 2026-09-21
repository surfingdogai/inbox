# ADR-015 — Connectors, outbound webhooks and the developer event stream

Status: accepted, 21 September 2026. Supersedes nothing; extends ADR-014 (connector strategy).

## Context

Tiago: *"our inbox settings should support feeds and connectors to shopify and other platforms,
this can be great for word press and other platforms. The inbox should as well have api or exposed
end points for developers to connect to it, orders, bookings etc"*.

Three unused tables have been waiting for this since the first schema: `connectors`, `webhooks` and
`webhook_deliveries`. `products.source` and `products.external_id` exist so a catalogue can come
from outside. Primary-source research on Shopify, WooCommerce, WordPress, the points of sale a
small European business actually runs, product feed formats and webhook practice was done on
21 September 2026 and informs every decision below.

## Decisions

### 1. A connector is a row, not a setting

`connectors` is reshaped and stays a first-class table. Connector configuration never goes into the
settings document, because `GET /v1/owner/settings` and the owner MCP `get_settings` tool return
that document verbatim: a client secret there would be handed to every connected AI and into its
context. Settings is also one row under one optimistic version, so a sync writing `last_sync_at`
every quarter of an hour would collide with the owner editing opening hours.

The row keeps a `config_public` mirror alongside the encrypted blob, so the Settings screen can
list what is connected, and the owner can disconnect it, even if the instance key is lost.

### 2. Secrets are sealed with WebCrypto, keyed by `INBOX_SECRET_KEY`

AES-256-GCM. The key is derived per purpose with HKDF-SHA-256 (`connector-config`,
`webhook-secret`), the additional authenticated data binds the ciphertext to its purpose and its
row id, and the stored form is `v1.<base64url iv>.<base64url ciphertext>`. `INBOX_SECRET_KEY` may
hold several comma-separated keys, newest first, so a key can be rotated without downtime.

There is no `node:crypto` in the shared packages and PBKDF2 at a defensible iteration count would
cost about a hundred milliseconds, which the Workers CPU budget cannot pay per request. Direct
`importKey` of the raw environment value was rejected because it forces exactly thirty-two bytes
and reuses one key across connector configs, webhook secrets and, later, the receipt signing keys.

Without a key the instance runs exactly as it does today; connecting something is refused with a
problem document that names the variable. Fail closed, never open.

### 3. Events are thin by default, with a labelled full option per endpoint

A thin event carries `{id, type, timestamp, data: {id, type, state, version, url}}`. A thin event
never goes stale when it is retried ten hours later and never copies a customer's name and address
to a URL somebody pasted once. But a pointer forces every receiver to hold an owner key, and a
webhook a no-code tool cannot read is not useful, so each endpoint carries `payload_style`, and the
Settings screen says in plain words that the full style sends customer data to that address.

### 4. The signature is Standard Webhooks, verbatim

Headers `webhook-id`, `webhook-timestamp` and `webhook-signature: v1,<base64 HMAC-SHA256>`, over
exactly `{id}.{timestamp}.{body}`. Secrets are issued as `whsec_<base64 of 32 random bytes>`.
During a rotation both signatures travel, space separated, for a day.

This is what OpenAI, Anthropic, Google, Twilio, Resend, Clerk and Render already send, so a
developer verifies us with an off-the-shelf library in any language and writes no code. A bare HMAC
of the body, as GitHub sends, is replayable forever by anyone who captures one request. A bespoke
header means every integrator writes their own verifier and gets it wrong.

### 5. Delivery retries for a day, then the endpoint sleeps

Attempts at 0s, 5s, 5m, 30m, 2h, 5h, 10h and 10h, each with a tenth of jitter. Anything that is not
2xx is a failure, including a redirect, which also removes a class of server-side request forgery
for free. An endpoint that has done nothing but fail for five days is deactivated and kept, never
deleted, with every delivery replayable once the address is fixed. Shopify deletes a subscription
after eight failures in four hours and tells nobody; that is the behaviour we are avoiding.

The delivery handler never throws on a failed delivery. It records the attempt and schedules its
own next one, the way the network ping already schedules its successor, so the job runner's generic
backoff stays reserved for our own bugs.

### 6. The polling cursor is a view, not a second events table

`events_v1` is a SQL view over `item_events` and inbound `thread_entries`. Both already have ULID
primary keys, so `WHERE id > ? ORDER BY id LIMIT ?` is an index range scan and replay is free. A
separate events table would mean a dual write on every mutation and a second thing to keep honest.

### 7. Ship order

1. **The secret box.** Nothing else can ship first.
2. **Outbound webhooks and the event cursor.** After this a developer can point Zapier, n8n, Make,
   a Slack bot or their own server at the inbox and receive signed, retried, replayable events for
   every booking, order, quote and message, with no platform, no OAuth and nothing to register.
   This is Tiago's second sentence delivered in full.
3. **Feed import.** One parser for comma-separated and minimal XML feeds covers WooCommerce, Wix,
   PrestaShop, BigCommerce and Shopify through Google, with no credentials at all. It is the
   cheapest way to make the catalogue real.
4. **One platform connector**, with its inbound webhook, reconciliation and polling as the source of
   truth.

Deliberately not in the first release: an app store listing, a connector marketplace, a field
mapping interface, and per-platform surfaces for the agent commerce protocols.

## Consequences

- A new migration reshapes `connectors`, adds `connector_events`, rebuilds `webhooks` and
  `webhook_deliveries`, and adds the `events_v1` view. The three tables are provably empty on every
  live instance, so the migration drops and recreates rather than altering.
- Six job kinds join the runner: fanout, delivery, connector ingest, connector sync, reconcile and
  feed import. Fanout is gated on there being an active endpoint, so an instance with no
  integrations behaves exactly as it does today.
- The owner app gains an Integrations tab with two halves: what is connected, and where events go.
- `packages/sdk` gains an MIT `verifyWebhook` helper so a receiver has no excuse not to check.
- Deliveries and connector events are pruned after thirty days by the existing housekeeping job. An
  unbounded delivery log is how a database reaches its size cap.
