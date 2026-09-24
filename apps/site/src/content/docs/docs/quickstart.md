---
title: Quickstart
description: Deploy to Cloudflare, run on your own server, or join the hosted waitlist. Then make your first calls.
---

Three ways to run the same software. Pick one, then make the first calls at the bottom of this page.

## Deploy to Cloudflare

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/surfingdogai/inbox) copies this repository to your GitHub or GitLab account and deploys it to your Cloudflare account. It creates a D1 database and a queue, and a cron runs every five minutes. The free plan runs it. Sending email needs Workers Paid.

### Before you press it

- A Cloudflare account.
- A secret key. Run `openssl rand -base64 32` and keep the result somewhere safe. The database needs it.
- For email, optional: a domain on Cloudflare, onboarded to Email Sending (dashboard → Email Service → Email Sending → Onboard Domain), on Workers Paid. Pick the address the inbox sends from, like `inbox@yourdomain.com`. You can do this later.

### What it asks

| Value | What to put |
| --- | --- |
| `INBOX_OWNER_EMAIL` | Your email address. Only this address can sign in the first time. |
| `INBOX_SECRET_KEY` | The key from above. It locks stored secrets and signs [receipts](/docs/receipts/). Empty, the inbox runs but stores no secret and issues no receipt. |
| `MAIL_FROM` | The address to send from. Leave it empty if email isn't set up yet. |

Leave the build and deploy commands as they are. The build makes the owner app; the deploy is `npx wrangler deploy`.

### After it deploys

1. Open `https://<worker>.<your-subdomain>.workers.dev/healthz`. Expect `{"ok":true,…}`. Migrations run on the first request.
2. Open `/login` and enter your address. If `MAIL_FROM` works, the link comes by email. If it doesn't, the link is in the Worker's logs, with the reason: open the Worker in the dashboard, go to Logs and search for `sign-in link`, or run `npx wrangler tail <worker>` and ask again. A link works once, for 15 minutes. If the log says your address is not in `INBOX_OWNER_EMAIL`, fix that value under Settings → Variables and Secrets.
3. The setup wizard opens. Your first sign-in saves the address you signed in at as the Inbox address (Settings). Links in emails use it, and receipts name it as their issuer.
4. Your own subdomain: Worker → Settings → Domains & Routes → Add → Custom domain. Then change the Inbox address in Settings, or add `INBOX_PUBLIC_URL` as a secret under Settings → Variables and Secrets.
5. Email later: onboard the domain, then add `MAIL_FROM` as a secret there. Or add `RESEND_API_KEY` to send through Resend. Add these as secrets, not text: the next deploy from your repository removes a plain-text variable.
6. Email in arrives through Email Routing once you route an address to the Worker ([ADR-005](https://github.com/surfingdogai/inbox/blob/main/docs/adr/005-email.md)).

Every push to your copy of the repository deploys again. To update, pull this repository into your copy, and keep your own `database_id` in `wrangler.jsonc`.

## Your own server

Node 22.16, 24 or 26 (`node:sqlite` with FTS5), one process, one SQLite file. A single `npx` command is coming with 0.1; until then, build the owner app and the server bundle from the repository:

```bash
git clone https://github.com/surfingdogai/inbox && cd inbox
pnpm install
pnpm --filter @surfingdog/inbox build            # apps/inbox/dist/client and apps/inbox/dist/server.mjs
node apps/inbox/dist/server.mjs                  # http://0.0.0.0:8787, database in ./data/inbox.db
```

The server serves the owner app from `dist/client` next to the bundle; any path that is neither a door nor a file gets the app shell. Environment variables, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on. |
| `HOST` | `0.0.0.0` | Interface to bind. |
| `INBOX_DB` | `./data/inbox.db` | The SQLite file. Created, and migrated, at boot. |
| `INBOX_STATIC` | `dist/client` beside the bundle | The built owner app to serve. |
| `INBOX_PUBLIC_URL` | derived from the request | The https URL people and agents reach you at. Set it behind a proxy, or forward `X-Forwarded-Proto`; it feeds the manifest, the links in emails and the `iss` of every [receipt](/docs/receipts/). Background jobs have no request to read it from, so without it they use the Inbox address in Settings, which your first sign-in over https fills in. |
| `INBOX_OWNER_EMAIL` | unset | Comma-separated addresses allowed to create the first account by email link. Without it, the first sign-in needs an owner API key. |
| `INBOX_SECRET_KEY` | unset | Seals connector credentials, webhook secrets and the receipt-signing key (AES-256-GCM), and is the source of the pseudonym pepper in receipts. One long random string, or several comma-separated and newest first, so a key can be rotated without downtime. Without it the instance runs as normal, refuses to store a secret rather than store it in the clear, and issues no [receipts](/docs/receipts/). |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_TOKEN`, `MAIL_FROM` | unset | Real email through Cloudflare Email Service (sign-in links, notifications), from an address on a domain onboarded there. `MAIL_FROM_NAME` is optional. |
| `RESEND_API_KEY` | unset | Real email through Resend instead, from `MAIL_FROM`. With neither, mail is printed to the console, sign-in links included. |

A few commands run against the same database and exit:

```bash
node apps/inbox/dist/server.mjs create-owner-key laptop   # prints a new owner API key (sdi_own_…) once
node apps/inbox/dist/server.mjs seed-demo                 # adds a demo bike shop if the instance is empty
node apps/inbox/dist/server.mjs seed-showcase             # the same shop with a week of items, rules and hours
node apps/inbox/dist/server.mjs network-ping              # reports to every network that is on now, not at the next hour
```

Open `/login`: enter an address from `INBOX_OWNER_EMAIL` and click the link you receive, or paste an owner key. Put Caddy or nginx in front for TLS. Jobs run on a one-second loop inside the process. Email in arrives at `POST /v1/email/inbound` as raw MIME, with the shared secret from settings (`email.inboundSecret`) in the `X-Inbox-Email-Secret` header; point a Mailgun route, a Postmark or SES inbound webhook, or a forwarder at it. The machine-readable install guide at [/install.md](/install.md) has a systemd unit and a Caddy site block to copy.

### With Docker

The repository has a `Dockerfile` that does the same build and runs the one file as an unprivileged user. There is no published image yet, so build it from the repository:

```bash
git clone https://github.com/surfingdogai/inbox && cd inbox
docker build -t surfingdog-inbox .
docker run -d --name inbox -p 8787:8787 -v inbox-data:/opt/inbox/data surfingdog-inbox
curl -s localhost:8787/healthz
```

The SQLite file lives in the `inbox-data` volume, so the container can be replaced without losing anything. With no variables at all it answers the public API and the MCP server at `/mcp`. Pass the variables from the table above with `-e`, for a real instance at least these:

```bash
openssl rand -base64 32        # the secret key: store it somewhere safe, the database needs it
docker run -d --name inbox -p 8787:8787 -v inbox-data:/opt/inbox/data \
  -e INBOX_PUBLIC_URL=https://inbox.yourdomain.com \
  -e INBOX_OWNER_EMAIL=you@yourdomain.com \
  -e INBOX_SECRET_KEY='<the key>' \
  surfingdog-inbox
```

The commands above run inside the container, for example `docker exec inbox node /opt/inbox/server.mjs create-owner-key laptop`.

### A public demo

`INBOX_DEMO=1` turns an instance into a demo shop that anyone's AI can book with, like the one on [Try it](/try/). Start it on an empty database: it fills itself with a bike workshop and a week of history. It never emails a customer. The only email it sends is a sign-in link or one summary a night, only to `INBOX_OWNER_EMAIL`, from `MAIL_FROM`. It never contacts a network or sends a webhook. Its rules confirm a booking when the slot is free and accept a small order on their own. It limits what each caller, and everyone together, can send, and at 03:00 UTC it wipes itself and starts again. `/demo/live` shows what arrives, with no names, addresses or messages. On a database that already holds anything it does nothing: no live view, no wipe, and the Node server won't start.

## Hosted by us

Hosted tenancy is not open yet: the same software on our own servers, one database per business, email in and out, backups, one-click connectors and the network bundled. Leave your address on the [waitlist](/#run) and we will write when it opens.

## First calls

The examples hit inbox.surfingdog.ai, which is our own working inbox. Send `x-sandbox: 1` on anything that creates an item there. It is required, not optional, or you will create a real item and a real notification. On your own instance, leave it off.

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
