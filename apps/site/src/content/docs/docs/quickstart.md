---
title: Quickstart
description: Deploy to Cloudflare, run on your own server, or join the hosted waitlist. Then make your first calls.
---

Three ways to run the same software. Pick one, then make the first calls at the bottom of this page.

## Deploy to Cloudflare

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/surfingdogai/inbox) opens Cloudflare's deploy flow on the public repository. It reads the `wrangler.jsonc` at the repository root and provisions on your account:

- a D1 database, `surfingdog-inbox`, the one database of your business;
- an R2 bucket, `surfingdog-inbox-blobs`, for raw email and attachments;
- a queue, `surfingdog-inbox-jobs`, plus a cron trigger every five minutes, which drive notifications and rules;
- one secret, `INBOX_SECRET_KEY`, which the flow asks you for.

Migrations run lazily on the first request after a deploy. When the Worker is up, these answer:

```
https://<your-worker>/healthz
https://<your-worker>/.well-known/agent-inbox.json
https://<your-worker>/openapi.json
```

Email out uses Cloudflare Email Service when the Worker has an `EMAIL` binding (Workers Paid, and a domain that is a Cloudflare zone), otherwise Resend when `RESEND_API_KEY` is set; with neither, mail is written to the Worker's logs instead of sent. Email in arrives through Email Routing once you route an address to the Worker ([ADR-005](https://github.com/surfingdogai/inbox/blob/main/docs/adr/005-email.md)).

What is not there yet on this target: the owner app and its setup wizard (the first release). The public doors, the manifest and the MCP servers work today; owner access from a client waits for the sign-in and consent screens, or use the Node target below where an owner key can be minted on the command line.

## Your own server

Node 22.16, 24 or 26 (`node:sqlite` with FTS5), one process, one SQLite file. A single `npx` command is coming with 0.1; until then, build the server bundle from the repository:

```bash
git clone https://github.com/surfingdogai/inbox && cd inbox
pnpm install
pnpm --filter @surfingdog/inbox build:server     # writes apps/inbox/dist/server.mjs
cd apps/inbox
node dist/server.mjs                             # http://0.0.0.0:8787, database in ./data/inbox.db
```

Environment variables, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on. |
| `HOST` | `0.0.0.0` | Interface to bind. |
| `INBOX_DB` | `./data/inbox.db` | The SQLite file. Created, and migrated, at boot. |
| `INBOX_STATIC` | `./public` | Static files (the app) to serve. |
| `INBOX_PUBLIC_URL` | derived from the request | The public origin, used in links inside emails. |
| `RESEND_API_KEY` | unset | Turns on real email through Resend; otherwise mail is logged. |

Two commands run against the same database and exit:

```bash
node dist/server.mjs create-owner-key laptop     # prints a new owner API key (sdi_own_…) once
node dist/server.mjs seed-demo                   # adds the demo business if the instance is empty
```

Put Caddy or nginx in front for TLS. Jobs run on a one-second loop inside the process. The machine-readable install guide at [/install.md](/install.md) has a systemd unit and a Caddy site block to copy.

## Hosted by us

Hosted tenancy opens in a later release: the same software on our server in the EU, one database per business, email in and out, backups, one-click connectors and the network bundled. Leave your address on the [waitlist](/#run) and we will write when it opens.

## First calls

The examples use the demo instance. Add `x-sandbox: 1` to anything that creates an item there, so it is marked as a sandbox item and triggers no real notifications; on your own instance, leave it off.

Read the manifest, then the services:

```bash
curl https://inbox.surfingdog.ai/.well-known/agent-inbox.json
curl https://inbox.surfingdog.ai/v1/services
```

Check availability for a service (the window may span at most 14 days):

```bash
curl "https://inbox.surfingdog.ai/v1/availability?service_id=<id>&from=2026-09-22T00:00:00Z&to=2026-09-23T00:00:00Z"
```

Request a booking. Generate an idempotency key and keep it: the same key with the same body returns the same item (`200` with `Idempotent-Replayed: true`) instead of a second booking.

```bash
curl -X POST https://inbox.surfingdog.ai/v1/bookings \
  -H 'content-type: application/json' -H 'x-sandbox: 1' \
  -d '{
    "payload": {
      "reservationFor": { "serviceId": "<id>", "name": "Full service" },
      "startTime": "2026-09-22T08:00:00Z",
      "endTime": "2026-09-22T09:30:00Z"
    },
    "contact": { "name": "Rita", "email": "rita@example.com" },
    "idempotency_key": "book-rita-0922"
  }'
```

The answer is `201` with the item view (`view.item.state` is `requested`) and, because you have no account here, an `accessToken`. Keep it: it is the only way to read or cancel that item later.

```bash
curl "https://inbox.surfingdog.ai/v1/items/<item id>?access_token=<token>"
curl -X POST "https://inbox.surfingdog.ai/v1/items/<item id>/cancel" \
  -H 'content-type: application/json' -H 'x-access-token: <token>' \
  -d '{ "reason": "Found a closer workshop", "idempotency_key": "cancel-rita-0922" }'
```

Send something wrong and the refusal is a problem document that names the fields:

```json
{
  "type": "https://surfingdog.ai/problems/invalid_input",
  "title": "Invalid input",
  "status": 422,
  "code": "invalid_input",
  "detail": "Missing: payload.endTime, payload.startTime. Add them and retry with the same idempotency key.",
  "fields": [
    { "path": "payload.endTime", "problem": "missing", "message": "Invalid input: expected string, received undefined" },
    { "path": "payload.startTime", "problem": "missing", "message": "Invalid input: expected string, received undefined" }
  ]
}
```

On your own instance, the owner side of the same booking is one call with the owner key:

```bash
curl -X POST https://<your-instance>/v1/owner/items/<item id>/transitions \
  -H "authorization: Bearer sdi_own_…" -H 'content-type: application/json' \
  -d '{ "event": "confirm", "expected_version": 1 }'
```

The same operations are MCP tools at `/mcp` (public) and `/mcp/owner` (owner). See [Connect your AI](/docs/connect-your-ai/) and the [API](/docs/api/) page.
