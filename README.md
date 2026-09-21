# Surfing Dog Inbox

An open-source, self-hostable **typed inbox for businesses**. It receives messages, quote
requests, orders and bookings from people and from AI agents — through email, a web form, REST
and MCP (and every agent protocol we can reasonably speak) — and turns them into structured
items with a lifecycle that can be handled by rules, by the owner, or by the owner's own AI.

Status: **the first release in progress.** The core, the REST + MCP doors, email in, sessions, OAuth for the
owner's AI and network membership work on both runtimes; the owner app, passkeys, receipts and the
setup wizard are being built. A demo instance runs at https://inbox.surfingdog.ai and the network at
https://network.surfingdog.ai. Read the ADRs in [docs/adr/](docs/adr/) first.

- `apps/inbox` — the product: a Hono server + React SPA that runs on Cloudflare Workers and on Node/Bun.
- `packages/core` — domain model, state machines, rules, receipts (AGPL-3.0).
- `packages/platform` — the five runtime interfaces (Db, Blob, Jobs, MailIn, MailOut) and their adapters.
- `packages/spec` — manifest, receipt and review formats with test vectors (MIT).
- `packages/sdk` — typed client for the public and owner APIs (MIT).
- `packages/ui` — design tokens, glass utilities and the kit page.
- `docs/` — ADRs and plans.

Licence: AGPL-3.0 for the server and app; MIT for `packages/spec`, `packages/sdk` and the connector SDK.

## Run it

```bash
pnpm install
pnpm dev            # Node, SQLite in ./data/inbox.db, http://localhost:8787
pnpm dev:workers    # the same app on workerd (D1, Queues, cron)
pnpm test           # every test on Node and on Workers
```

The Node build is one file: `pnpm --filter @surfingdog/inbox build:server` writes `apps/inbox/dist/server.mjs`.
Run it with `node server.mjs` and these variables:

| Variable | What |
|---|---|
| `INBOX_DB` | SQLite file (default `./data/inbox.db`) |
| `INBOX_PUBLIC_URL` | The https URL people and agents reach you at. Behind a proxy set it, or pass `X-Forwarded-Proto`. |
| `INBOX_STATIC` | Static files directory (the owner app) |
| `INBOX_OWNER_EMAIL` | Comma-separated addresses that may create the first account by email link |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_TOKEN`, `MAIL_FROM` | Real email through Cloudflare Email Service (`MAIL_FROM_NAME` optional) |
| `RESEND_API_KEY` | Real email through Resend instead; with neither, mail is printed to the console |
| `PORT`, `HOST` | Listen address (default 8787 on all interfaces) |

CLI: `node server.mjs create-owner-key` prints an owner API key, `seed-demo` adds a demo bike shop
to an empty instance, `seed-showcase` the same shop with a week of items, `network-ping` reports to
the network now. `pnpm --filter @surfingdog/inbox shots` captures the owner app for the website.

Sign in at `/login` with an address from `INBOX_OWNER_EMAIL` (a link is emailed; in development the
mail is printed to the console, so set `INBOX_OWNER_EMAIL=you@example.com pnpm dev` and copy the link) or
with an owner key.

## Email in

Every instance accepts raw MIME at `POST /v1/email/inbound` with the shared secret from Settings
(`email.inboundSecret`) in `X-Inbox-Email-Secret`. Point a Mailgun route, a Postmark/SES inbound
webhook or a forwarder at it. On Cloudflare, Email Routing delivers straight to the Worker's
`email()` handler, no webhook needed. Messages are threaded by `In-Reply-To`/`References`, by a plus
address (`inbox+<item id>@…`) or by a `[SDI-<item id>]` subject token, and deduplicated on
`Message-ID`.

## Join a network

Settings → Network. `network.url` is the directory this instance reports to (default
`https://network.surfingdog.ai`; any directory that implements `POST /v1/instances` and
`POST /v1/instances/{domain}/ping` works) and `network.join` is the switch, off by default. When on,
the instance registers its domain once (the network verifies it by fetching
`/.well-known/agent-inbox.json` and checking that `instance` is your https origin) and then sends,
every hour, its software version, runtime and the number of bookings, orders, quotes and messages
created in the last 24 hours. Nothing about customers leaves the instance.
