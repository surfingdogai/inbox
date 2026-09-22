# ADR-014 — Connectors: same SDK everywhere, one-click apps on hosted

**Status:** accepted (21 Sep 2026, Tiago: "connectors is what will give value to our hosted
solution; we can as well add support to the open source to connect to the Shopify API, same with
other software; regarding Shopify, we can redirect the agent to it but can have an app as well")

## Decision
- **One connector SDK in the open source**, MIT, with the same connectors for everyone: Shopify,
  WooCommerce, Google Calendar, Stripe, Mollie next; Microsoft 365, CalDAV, Cal.com, Calendly,
  WordPress after them; more later. A connector declares capabilities, a Zod config schema and sync
  handlers; the settings form and the wizard step render from the schema.
- **Self-hosted instances bring their own credentials**: a Shopify custom app token from the Dev
  Dashboard, a WooCommerce key pair, a Google OAuth client (Workspace "Internal" audience needs no
  verification), a Stripe restricted key, a Mollie profile key. The docs walk through each.
- **Hosted ships the same connectors as one-click apps**: our verified Google OAuth client, a
  public Shopify app with expiring offline tokens, a Stripe App with OAuth, a Mollie OAuth app,
  WooCommerce's authorize flow. No keys to paste, tokens refreshed by us, webhooks registered by us.
  This, with email, backups and the network, is what hosted sells; the core is never crippled.
- **Where a platform already speaks to agents, redirect.** Every Shopify store serves its own
  Storefront MCP and UCP profile, so our manifest and our agent replies point agents there for
  catalogue, cart and checkout. We cover what the platform lacks: quotes, bookings, questions,
  disputes, one inbox across channels, and receipts driven by the platform's order webhooks.
- A Shopify App Store listing (the inbox embedded in the Shopify admin) is a later discussion, not
  part of the connector work.

## Why
Connectors are the recurring reason to pay for hosting: registering and maintaining OAuth apps,
verifications and webhooks is work a small business will not do. Keeping the SDK and the connectors
open keeps self-hosting honest and gives the community a place to add software we will never cover.

## Consequences
Connector tokens are encrypted at rest with an instance key on both editions. Hosted adds a token
vault and a webhook router in the Go control plane. Each connector ships a contract test against a
recorded fixture and a live smoke test behind a secret.
