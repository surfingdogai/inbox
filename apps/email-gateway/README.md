# Email gateway

Cloudflare Email Routing → this Worker → `POST /v1/email/inbound` on an Inbox, with the Inbox's
shared secret. Nothing is parsed or stored here.

Deploy:

    cd apps/inbox && npx wrangler deploy --config ../email-gateway/wrangler.jsonc
    <the inbox's email.inboundSecret> | npx wrangler secret put INBOX_EMAIL_SECRET --config ../email-gateway/wrangler.jsonc

Then, in Email Routing on the zone, route the address (e.g. `inbox@surfingdog.ai`) to the
Worker `surfingdog-email-gateway`. Plus-addresses (`inbox+<item id>@…`) reach the same rule.
