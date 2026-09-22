# Install Surfing Dog Inbox — instructions for an AI agent

You are installing **Surfing Dog Inbox** for the person you are working for. They own a business.
When you are finished, their business has an inbox at its own subdomain that takes bookings,
orders, quote requests and messages from people and from other AI agents, over REST, MCP and
email.

Read this whole file before you start. Then tell the person, in two or three sentences, which of
the two paths below you are taking and what it will cost them. Do not begin until they answer.

**Rules for you, the agent.**

- Never invent a value. Every secret in here is generated, never guessed.
- Verify each step with the command given before moving to the next. If a check fails, stop and
  report it rather than carrying on.
- Anything that costs money, changes DNS, or sends mail on their behalf: ask first, in plain
  words, and wait.
- At the end, run the final checklist and show the person its output.

---

## Step 0. Decide where it runs

Ask the person which they want. Both are fully supported; the software is identical.

| | **Cloudflare Workers** | **Their own server** |
|---|---|---|
| Good when | They have no server and want it managed | They have a VPS, or want the data on their own machine |
| Cost | Workers Paid, about $5/month, plus usage | Whatever the server costs |
| Needs | A Cloudflare account, the domain on Cloudflare | A Linux box, Node 22.16+, 24 or 26, and a domain |
| Database | D1 | One SQLite file |

If they have no preference and no server, take Cloudflare.

---

## Path A — Cloudflare Workers

### A1. Prerequisites

Confirm, and tell the person what is missing:

```bash
node --version    # 22.16+, 24 or 26
npx wrangler --version
```

They need a Cloudflare account on the **Workers Paid** plan, their domain on Cloudflare, and
**R2 enabled** (dash.cloudflare.com → R2 → Enable; it is a product switch, not a permission).

### A2. Get the code

```bash
git clone https://github.com/surfingdogai/inbox && cd inbox && pnpm install
```

### A3. Create the three resources

Wrangler will open a browser to sign in the first time.

```bash
npx wrangler d1 create surfingdog-inbox
npx wrangler r2 bucket create surfingdog-inbox-blobs
npx wrangler queues create surfingdog-inbox-jobs
```

`d1 create` prints a `database_id`. Put it in `wrangler.jsonc` in place of the zeros. This is the
only hand edit in this path.

### A4. Secrets

Generate the sealing key; do not invent one. It encrypts connector credentials, webhook
secrets and the receipt-signing key at rest; without it the inbox issues no receipts.

```bash
openssl rand -base64 32 | npx wrangler secret put INBOX_SECRET_KEY
```

Ask the person which email address should be able to sign in as the owner, then:

```bash
printf 'THEIR_EMAIL' | npx wrangler secret put INBOX_OWNER_EMAIL
```

### A5. Build and deploy

```bash
pnpm --filter @surfingdog/inbox build:client
npx wrangler deploy
```

Migrations run by themselves on the first request. Verify:

```bash
curl -s https://surfingdog-inbox.<their-subdomain>.workers.dev/healthz
```

Expect `{"ok":true,"version":"0.1.0"}`. Anything else: stop, show them the output.

### A6. Their own subdomain

Ask which subdomain they want. `inbox.theirdomain.com` is the convention. Then in the Cloudflare
dashboard: **Workers & Pages → surfingdog-inbox → Settings → Domains & Routes → Add → Custom
domain**. Cloudflare creates the DNS record and the certificate.

Or add it to `wrangler.jsonc` and redeploy:

```jsonc
"routes": [{ "pattern": "inbox.theirdomain.com", "custom_domain": true }]
```

Verify, and only continue when it answers:

```bash
curl -s https://inbox.theirdomain.com/healthz
```

Then tell the instance its own address, so links in its emails are right:

```bash
printf 'https://inbox.theirdomain.com' | npx wrangler secret put INBOX_PUBLIC_URL
npx wrangler deploy
```

---

## Path B — Their own server

### B1. Prerequisites

```bash
node --version    # must be 22.16+, 24 or 26
```

### B2. Build a single file

```bash
git clone https://github.com/surfingdogai/inbox && cd inbox && pnpm install
pnpm --filter @surfingdog/inbox build
```

That writes `apps/inbox/dist/server.mjs` and `apps/inbox/dist/client`. Copy both to the server.

### B3. Configuration

Generate the sealing key:

```bash
openssl rand -base64 32
```

Write `/opt/inbox/.env`, readable only by the service user:

```bash
INBOX_DB=/opt/inbox/data/inbox.db
INBOX_PUBLIC_URL=https://inbox.theirdomain.com
INBOX_OWNER_EMAIL=them@theirdomain.com
INBOX_SECRET_KEY=<the key you just generated>
PORT=8787
```

### B4. Run it under systemd

```ini
[Unit]
Description=Surfing Dog Inbox
After=network-online.target

[Service]
User=inbox
WorkingDirectory=/opt/inbox
EnvironmentFile=/opt/inbox/.env
ExecStart=/usr/bin/node /opt/inbox/server.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now inbox && curl -s localhost:8787/healthz
```

### B5. Subdomain and TLS

Point an A record for `inbox.theirdomain.com` at the server, then put a reverse proxy in front.
Caddy gets a certificate on its own:

```
inbox.theirdomain.com {
  reverse_proxy localhost:8787
}
```

Verify from outside the server:

```bash
curl -s https://inbox.theirdomain.com/healthz
```

---

## Step 1. Sign the owner in

```bash
curl -s https://inbox.theirdomain.com/login
```

Tell the person to open `/login` and enter the address you set as `INBOX_OWNER_EMAIL`. They get a
link by email. If no mail provider is configured yet, the link is printed in the server's log, so
read it from there and give it to them.

Alternatively mint a key. On their own server:

```bash
node /opt/inbox/server.mjs create-owner-key laptop
```

It prints `sdi_own_…` once. Give it to the person and tell them to store it; it is not shown again.

---

## Step 2. Email in

This is what makes the inbox an inbox: a customer can simply write to it.

### First, the shared secret

Generate one and put it in the instance's settings. It is what proves an inbound message came
from the gateway and not from a stranger.

```bash
SECRET=$(openssl rand -base64 32 | tr -d '/+=' | head -c 40)
# A settings write is a merge: send only what you change and everything else keeps its value.
# Read the current version first; a write with a stale version is refused, never silently applied.
VERSION=$(curl -s https://inbox.theirdomain.com/v1/owner/settings -H "authorization: Bearer $OWNER_KEY" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
curl -s -X PUT https://inbox.theirdomain.com/v1/owner/settings \
  -H "authorization: Bearer $OWNER_KEY" -H 'content-type: application/json' \
  -d "{\"expected_version\":$VERSION,\"doc\":{\"email\":{\"inboundSecret\":\"$SECRET\"}}}"
```

The answer contains the new `version`. If it says the version did not match, someone changed the
settings in between: read them again and use the version they give you.

### Then, a way for mail to reach it

The inbound door is `POST /v1/email/inbound`. It takes a raw MIME message with the secret in the
`X-Inbox-Email-Secret` header. Any of these feed it:

- **Cloudflare Email Routing**, if the domain is on Cloudflare. Enable Email Routing on the zone,
  deploy the gateway Worker in `apps/email-gateway`, set `INBOX_EMAIL_SECRET` on it to the secret
  above and `INBOX_INBOUND_URL` to the instance's inbound URL, then add a routing rule sending
  `inbox@theirdomain.com` to that Worker.
- **Mailgun**, a route with a forward action pointing at the inbound URL.
- **Postmark or SES**, an inbound webhook pointing at the same URL.
- **A forwarder** on any existing mailbox.

Verify without waiting for real mail:

```bash
printf 'From: a@example.com\r\nTo: inbox@theirdomain.com\r\nSubject: Test\r\nMessage-ID: <t1@example.com>\r\n\r\nHello\r\n' \
| curl -s -X POST https://inbox.theirdomain.com/v1/email/inbound \
  -H 'content-type: message/rfc822' -H "x-inbox-email-secret: $SECRET" --data-binary @-
```

Expect `{"outcome":"created","itemId":"…"}`. A `401` means the secret does not match.

Then have the person send one real email to the address and confirm it appears in the inbox. Only
that proves the last hop.

### Email out, optional

Without it, sign-in links and notifications are written to the log instead of sent. Either:

```bash
RESEND_API_KEY=…                                  # Resend
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_EMAIL_TOKEN=… MAIL_FROM=inbox@theirdomain.com   # Cloudflare
```

---

## Step 3. Set the business up

Do this through the owner app at `/settings`, or over the API. The inbox answers agents from what
is in here, so it is worth doing properly. Ask the person for each; do not invent any of it.

1. **Profile** — name, timezone, currency, languages.
2. **Services** — what can be booked: duration, buffers, capacity, price.
3. **Opening hours** — and any closures.
4. **Products** — what can be ordered. If their shop publishes a product feed, connect it instead
   and the catalogue fills itself: Settings → Integrations → Connect a feed.
5. **Rules** — start from a preset (`appointments`, `trades`, `shop`) and change it with them.

---

## Step 4. Connect their AI

The owner's own AI answers inside the rules they set. In Claude, ChatGPT or any MCP client, add a
connector pointing at:

```
https://inbox.theirdomain.com/mcp/owner
```

It signs in with OAuth. The public tools, for their customers' agents, are at `/mcp` and need no
sign-in.

---

## Final checklist

Run all of these and show the person the output.

```bash
BASE=https://inbox.theirdomain.com
curl -s $BASE/healthz
curl -s $BASE/.well-known/agent-inbox.json | head -c 300
curl -s $BASE/openapi.json | head -c 120
curl -s $BASE/v1/services
```

Expect, in order: `{"ok":true,…}`; a manifest whose `instance` is their URL; an OpenAPI document;
and their services. If `instance` is wrong, `INBOX_PUBLIC_URL` is wrong and every link the inbox
sends will be wrong with it.

Then tell the person:

- the address of their inbox, and that `/login` is where they sign in;
- that their owner key, if you minted one, is shown once and you have given it to them;
- what is not set up yet, naming each thing, rather than implying everything is done.

## If something breaks

- `/healthz` fails → the process is not running, or the proxy is not reaching it.
- The manifest shows the wrong `instance` → set `INBOX_PUBLIC_URL` and redeploy.
- `401` on the inbound email door → the secret in settings and the secret on the gateway differ.
- `403` writing settings → the owner key is wrong or expired.
- A version conflict on settings → read the current settings and retry with the version it gives.

Documentation: https://surfingdog.ai/docs/ · Source: https://github.com/surfingdogai/inbox
