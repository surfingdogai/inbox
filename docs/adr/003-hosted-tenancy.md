# ADR-003 — Hosted tenancy runs on our own server

**Status:** accepted (21 Sep 2026, after Tiago's answer "same domain, same server, root" and the
clarification "we host for them but in our server, not Cloudflare")

## Decision
- Hosted tenants run on our own server with the Inbox's **Node runtime**, **one SQLite
  file per tenant**, Litestream replication to object storage, behind Caddy and Cloudflare.
- The **Go network app is the control plane**: businesses/tenants, plans, Stripe billing,
  hostnames. The Node process resolves `hostname → tenant` from it with an in-process cache.
- Hostnames: `surfingdog.ai` (site, docs, directory), `app.surfingdog.ai` (owner app),
  `<slug>.surfingdog.ai` (tenant instances; reserved slugs: map, app, api, network, in, mail, www,
  docs, hello), `network.surfingdog.ai` (API), `in.surfingdog.ai` (email-in). Customer subdomains
  via Cloudflare for SaaS custom hostnames with the box as fallback origin (100 free, then $0.10
  each, 50,000 per zone below Enterprise).
- Email-in: Cloudflare Email Routing catch-all on `in.surfingdog.ai` → a tiny Email Worker →
  signed POST of the raw MIME to the box (the `MailIn` provider-webhook path). Email-out:
  Cloudflare Email Service from `<slug>@mail.surfingdog.ai` with Reply-To the business.
- The core does not know it is multi-tenant: the hosted wrapper implements the same platform
  interfaces.

## Alternative kept on file
One Cloudflare Durable Object (SQLite, 10 GB, unlimited objects, ~500 req/s each) per tenant on
Workers, with `drizzle-orm/durable-sqlite`. It is the natural fit for millions of tenants on
Cloudflare and the design is kept in the original research notes. D1-per-tenant is not an option: 50,000
databases per account.

## Why
Tiago's call; one box, one deploy path, data on our own servers, no US processor holding message
content. Scale path without a rewrite: shard tenants across boxes by control-plane mapping, or move
the hosted layer to Durable Objects.

## Consequences
Cloudflare Workers remains **self-host target 1** for businesses (Deploy button); the hosted
product is target 2 (Node). Disk on the box is the first constraint (tiles use 138 GB of 320).
