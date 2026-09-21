# ADR-005 — Email in and out, per target

**Status:** accepted (21 Sep 2026)

## Decision
One `MailOut` interface with providers chosen in the wizard from a Zod config schema:
- **Cloudflare target:** Cloudflare Email Service (`send_email` binding) when the account is on
  Workers Paid and the domain is a Cloudflare zone; otherwise Resend, Postmark or SMTP.
- **Node target:** SMTP by default (any provider), with Postmark, SES, Mailgun and Resend adapters.
- **Hosted:** Cloudflare Email Service from `<slug>@mail.surfingdog.ai`, Reply-To the business.
- Two sender modes: "from our domain + Reply-To" (zero setup) and "from your domain" (DKIM CNAME
  and SPF include wizard). Never send From a business domain without its DKIM.

`MailIn` takes raw MIME from three setups, in order of ease: forwarding from the existing mailbox
to the instance's address; a subdomain MX; a provider inbound webhook. Cloudflare Email Routing
requires the domain to be a Cloudflare zone, so a Workers self-hoster without one uses a provider
webhook. Parsing: `postal-mime` 3, thread by headers, dedupe on Message-ID, strip quoted replies
with a vendored copy of `email-reply-parser` (its published build imports Node's `createRequire`).

## Why
Cloudflare Email Sending is public beta, Paid-only, 3,000 messages a month included then $0.35 per
thousand, any recipient after domain onboarding, DKIM automatic; our platform already uses it. Resend
runs on Workers and has inbound on all plans but stores all data in the US even on its EU region.
Postmark has no EU option; Mailgun has an EU region; SES is cheapest.
