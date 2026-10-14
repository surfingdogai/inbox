# ADR-003 — Hosted tenancy runs on our own server

**Status:** accepted (21 Sep 2026, after the founder's answer "same domain, same server, root" and the
clarification "we host for them but in our server, not Cloudflare")

## Decision
- Hosted tenants run on our own server with the Inbox's **Node runtime**, **one SQLite
  file per tenant**, hourly encrypted snapshots to object storage in the European Union (Litestream
  replication possibly later; see Amendment 1), behind Caddy and Cloudflare.
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
The founder's call; one box, one deploy path, data on our own servers, no US processor holding message
content. Scale path without a rewrite: shard tenants across boxes by control-plane mapping, or move
the hosted layer to Durable Objects.

## Consequences
Cloudflare Workers remains **self-host target 1** for businesses (Deploy button); the hosted
product is target 2 (Node). Disk on the box is the first constraint (tiles use 138 GB of 320).

## Amendment 1 (13 Oct 2026): setup on our domain, live on the business's own

**Status:** accepted (the founder, 13 Oct 2026: set the inbox up on a subdomain of ours and have the
business use its own domain, through DNS, because the domain is what lets an agent trust a business).
It replaces the hostnames above and the control plane's place; the rest of this record stands.

- **Two addresses per hosted inbox.**
  - *Setup* happens at a generated, neutral name under our domain,
    `<word>-<word>-<4 characters>.surfingdog.ai`. Only the owner can use it: no agent door, no
    manifest, no public business page (a neutral one), no listing, `noindex`.
  - *Live* is a hostname on the business's own domain, `inbox.<domain>` by default. The business
    adds one CNAME from that hostname to a target unique to its inbox,
    `<code>.hosted.surfingdog.ai`, so a record can only ever name one inbox. The record is the proof
    that the domain is the business's; no other proof is asked. Agent doors open when our edge
    reports the hostname and its certificate active, not before, and the manifest then names the
    business's own hostname and domain.
  - Once live, the setup name sends the owner to the own hostname and never serves agents. If the
    record disappears for 72 hours, doors close again until it is back. One live inbox per domain.
- **The control plane is its own service**, at `app.surfingdog.ai`, with its own database: tenants,
  their hostnames and states, signups. It is not the network. The network learns that a hosted inbox
  is live from it, and credits the door only after fetching the manifest itself, as for any inbox.
  An address under our domain is never credited or listed for any business.
- **Reserved names** are never a slug: `app`, `api`, `hosted`, `hosted-origin`, `in`, `mail`, `www`,
  `docs`, `check`, `b`, `network`, `inbox`, `map`, `operators`, `sponsors`, `demo`, `status`,
  `sandbox`, `admin`, `login`, `account`, `billing`, `support`, `help`, `secure`, `abuse`,
  `security`, and every name our zone already uses. A slug or a target code is never reissued.
- **The hosted runtime** is `packages/hosted` (MIT): a router that resolves a host to a tenant
  through the control plane and applies the rules above, and shards that open one SQLite file per
  tenant with `createInbox({policy})`. The inbox enforces closed doors itself too
  (`HostPolicy.agents`), so a mistake in one layer does not open them.
- **Email.** Tenant mail goes from a sending subdomain of its own, apart from the mail that signs
  owners in. No mail to customers before an inbox is live. Email into a hosted inbox
  (`in.surfingdog.ai`) is not part of the pilot.
- **Backups.** Every tenant file hourly, encrypted before it leaves the server. Litestream
  replication is not part of the pilot; it may come later.
