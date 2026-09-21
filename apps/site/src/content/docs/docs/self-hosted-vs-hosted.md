---
title: Self-hosted vs hosted
description: The same software either way. What you run, what we run, and what each one includes.
---

The inbox is one codebase with two self-hosting targets and one hosted edition. The core never knows which it is running on. Hosted opens in a later release; until then, self-host.

| | Deploy to Cloudflare | Your own server | Hosted by us (a later release) |
| --- | --- | --- | --- |
| Runs on | Cloudflare Workers on your account: D1, R2, Queues, cron | Node 22.16 or newer (Bun later) on any machine, `node:sqlite` | Our own servers, Node runtime, one SQLite file per business |
| Set-up | The Deploy button provisions everything and asks for one secret | Build the server bundle, run one process, put Caddy or nginx in front | A slug, a magic link |
| Data | Your D1 database and R2 bucket | Your SQLite file and blob directory | One database per tenant on our servers, replicated with Litestream to object storage |
| Email out | Cloudflare Email Service on Workers Paid with a Cloudflare zone; otherwise Resend, Postmark or SMTP | SMTP by default, or a provider adapter | Included, from `<slug>@mail.surfingdog.ai` with Reply-To the business, or your own domain with DKIM |
| Email in | Email Routing (needs a Cloudflare zone) or a provider webhook | Forwarding, a subdomain MX, or a provider webhook | Included: `<slug>@in.surfingdog.ai` |
| Connectors (the next release) | The same MIT connector SDK; you bring your own credentials (a Shopify custom app token, a Google OAuth client, a Stripe restricted key…) | Same | The same connectors as one-click apps through our registered OAuth apps; tokens refreshed and webhooks registered by us |
| Backups | Yours (D1 time travel, R2) | Yours; Litestream or nightly snapshots are the documented path | Done by us |
| Network | Join any network, or none, from settings | Same | Our network bundled: directory listing, receipts, reviews |
| Domain | Your Worker route or custom domain | Yours | `<slug>.surfingdog.ai`, or your own hostname through Cloudflare for SaaS |
| Cost | Cloudflare's plan; the free plan starts, sending email needs Workers Paid | Your machine | Flat plus per confirmed item, metered from day one; announced with a later release |
| Licence | AGPL-3.0 | AGPL-3.0 | Same software, same licence |

Two things are worth stating plainly. First, the open-source edition is never crippled: every connector, every door and every format in the hosted edition is in the repository. What hosted sells is the work a small business will not do, which is registering and maintaining OAuth apps, verifications, webhooks, email and backups, plus the network features bundled ([ADR-014](https://github.com/surfingdogai/inbox/blob/main/docs/adr/014-connectors-strategy.md)). Second, hosted is not on Cloudflare: it runs on our own server so that no US processor holds message content, and it can move to Cloudflare Durable Objects later without touching the core ([ADR-003](https://github.com/surfingdogai/inbox/blob/main/docs/adr/003-hosted-tenancy.md)).

Where a platform already speaks to agents, the inbox redirects rather than competes. A Shopify store already serves agents a storefront MCP and a UCP profile for catalogue, cart and checkout; the inbox covers what the platform lacks, which is quotes, bookings, questions, disputes, one inbox across channels, and receipts driven by the platform's order webhooks.
