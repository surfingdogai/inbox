---
title: Self-hosted vs hosted
description: The same software either way. What you run, what we run, and what each one includes.
---

The inbox is one codebase with two self-hosting targets and one hosted edition. The core never knows which it is running on. <!-- hosted: open -->Hosted is free during the pilot.<!-- hosted: closed -->Hosted is not open yet; until it is, self-host.<!-- hosted: end -->

| | Deploy to Cloudflare | Your own server | Hosted by us (pilot<!-- hosted: closed -->, not open yet<!-- hosted: end -->) |
| --- | --- | --- | --- |
| Runs on | Cloudflare Workers on your account: D1, Queues, cron | Node 22.16 or newer (Bun later) on any machine, `node:sqlite` | Our own servers, Node runtime, one SQLite file per business |
| Set-up | The Deploy button provisions everything and asks for three values | [One command](/docs/run-it-yourself/) on Ubuntu or Debian, with HTTPS; or the Docker image, on a server or a [platform](/docs/platforms/) | From your website's check result: check what we read, confirm with a code, then add one DNS record |
| Data | Your D1 database | Your SQLite file and blob directory | One database file per business on our servers |
| Email out | Cloudflare Email Sending on Workers Paid, from `MAIL_FROM` on a domain onboarded there; or Resend | Cloudflare Email Sending or Resend; with neither, printed to the console | Included, from an address of ours that carries your business's name |
| Email in | Email Routing (needs a Cloudflare zone) or a provider webhook | Forwarding, a subdomain MX, or a provider webhook | Not in the pilot: requests arrive through the inbox's doors and its page |
| Connectors | The same MIT connector SDK; you bring your own credentials (a calendar's app password, a Google OAuth client, a Stripe restricted key, a Mollie API key…) | Same | The same connectors |
| Backups | Yours (D1 time travel) | Yours: the installer backs up every night; Litestream optional ([Backups](/docs/backups/)) | Done by us: every hour, encrypted |
| Network | Join any network, or none, from settings; the setup suggests network.surfingdog.ai | Same | On network.surfingdog.ai from the day it goes live; switch it off, or add others, from settings |
| Domain | Your Worker route or custom domain | Yours | A hostname on your own domain, such as `inbox.yourbusiness.com`, by one DNS record |
| Cost | Cloudflare's plan; the free plan starts, sending email needs Workers Paid | Your machine | Free during the pilot; confirmed items are counted, and any price comes with 30 days' notice |
| Licence | MIT | MIT | Same software, same licence |

Two things are worth stating plainly. First, the open-source edition is never crippled: every connector, every door and every format in the hosted edition is in the repository. What hosting takes off a small business is the running of it: updates, email, backups and, later, connections to other services ([ADR-014](https://github.com/surfingdogai/inbox/blob/main/docs/adr/014-connectors-strategy.md)). Second, a hosted inbox's data is stored on our own servers and its encrypted backups in object storage, both in the European Union. Requests reach them through an edge network that ends the encrypted connection and opens a new one to our servers, so that network handles message content in transit; the hosted terms say who processes what, and where. The core does not know it is hosted, so the hosted layer can change later without touching it ([ADR-003](https://github.com/surfingdogai/inbox/blob/main/docs/adr/003-hosted-tenancy.md)).

Where a platform already speaks to agents, the inbox redirects rather than competes. A Shopify store already serves agents a storefront MCP and a UCP profile for catalogue, cart and checkout; the inbox covers what the platform lacks, which is quotes, bookings, questions, disputes, one inbox across channels, and receipts driven by the platform's order webhooks.
