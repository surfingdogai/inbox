# Email gateway

Cloudflare Email Routing → this Worker → the inbox the address is for. Nothing is parsed or stored here
(ADR-005, ADR-026).

- An address routed here for one inbox (e.g. `hello@example.org`) goes to `INBOX_INBOUND_URL`
  (`POST /v1/email/inbound` on that inbox) with that inbox's shared secret.
- An address on the hosted inbound domain (`HOSTED_INBOUND_DOMAIN`, e.g. `in.example.org`) goes to the
  hosted router: `<slug>@…` is an inbox's own address and `<slug>+<token>@…` one of its conversations.
  The Worker posts it to `HOSTED_INBOUND_URL` + `/v1/inbound/<slug>`, signed with `HOSTED_INBOUND_KEY`
  (the router's own `HOSTED_INBOUND_KEY`), with the envelope and the receiving server's verdict in the
  signed query. An address on that domain that names no inbox is refused.

What the sending server is told: taken; a temporary failure (it retries for days) when the inbox or the
router cannot take it now, or the signature is not accepted (ours to fix, never a bounce); refused, with
the reason, when the inbox says no for good.

## Deploy

    cd apps/inbox && npx wrangler deploy --config ../email-gateway/wrangler.jsonc
    <the inbox's email.inboundSecret> | npx wrangler secret put INBOX_EMAIL_SECRET --config ../email-gateway/wrangler.jsonc

Then, in Email Routing on the zone, route the address (e.g. `inbox@example.org`) to the Worker
`surfingdog-email-gateway`. Plus-addresses (`inbox+<token>@…`) reach the same rule.

## Hosted inboxes

1. Set `HOSTED_INBOUND_DOMAIN` and `HOSTED_INBOUND_URL` in `wrangler.jsonc` (`vars`), and the key:
   `<the router's HOSTED_INBOUND_KEY> | npx wrangler secret put HOSTED_INBOUND_KEY --config ../email-gateway/wrangler.jsonc`.
   Deploy. Until the next step, nothing reaches the new path.
2. On the router: `HOSTED_INBOUND_HOST` (the host name of `HOSTED_INBOUND_URL`) and the same
   `HOSTED_INBOUND_KEY`; a DNS record for that host to the router, proxied, like the inboxes' own.
3. Enable Email Routing on the inbound domain (a subdomain of a zone is enough: Email Routing → Settings →
   Add subdomain), and set its catch-all to *Send to a Worker* → `surfingdog-email-gateway`. Email
   Routing adds the domain's MX and SPF records.
4. Send a test email to an inbox's own address and look for it in that inbox; a reply to its
   acknowledgement lands on the same request.
