# Surfing Dog Inbox for WordPress

A WordPress plugin that points AI agents from a business's website to its agent inbox, from one
setting (the inbox's address, `inbox.<domain>` unless set). Once the address is saved and the inbox
answers there with its manifest, it publishes the lines of ADR-024 and
`packages/spec/vectors/discovery.json`:

- `<link rel="agent-inbox">` in every page's head, and the same as an HTTP `Link` header;
- schema.org structured data on the front page, with a `potentialAction` pointing to the inbox;
- `/llms.txt`, when nothing else answers it (WordPress would answer 404);
- `/.well-known/agent-inbox.json`, the same way: a copy of the inbox's manifest, checked before it is
  kept (an agent inbox's, naming the inbox's address as its own).

The copy is fetched by WP-Cron twice a day and when the address is saved, never while a visitor
waits; a failed fetch waits 15 minutes; with no good copy for a week, nothing is published.

With WooCommerce active (ADR-032), Settings → Agent inbox also offers **Connect WooCommerce**, which
opens the inbox's Settings → Integrations with its WooCommerce card open
(`https://<inbox>/settings/integrations?connect=woocommerce`); llms.txt gains the shop's line (agents
order through the inbox once it is connected to the shop); and, while the inbox is connected to the shop
(one of its webhooks delivers to the saved address), WooCommerce's own processing and completed emails
stay quiet for the orders the inbox made (`_sdi_ref`), since the inbox sends its own receipt and says
when the order is on its way. Refund and cancellation emails always go: the inbox does not send those.
The plugin makes no key and sends nothing for it: WooCommerce makes the key on its own Approve page.

Settings → Agent inbox also has Check, which asks Surfing Dog's checker (`GET /v1/discovery/{domain}`)
what is in place and what is missing, robots.txt included, only when pressed.

## Tests

    php surfingdog-inbox/tests/run.php

WordPress's functions are stood in for; nothing reaches the network. CI runs it on every change
(`.github/workflows/ci.yml`, job `wordpress`), with `php -l` on every file.

## A zip to install

    cd integrations/wordpress && zip -r surfingdog-inbox.zip surfingdog-inbox -x 'surfingdog-inbox/tests/*'

Then Plugins → Add New Plugin → Upload Plugin.

**Not submitted to wordpress.org.** `readme.txt` is in its format, and `wordpress-org/README.md` holds
the rest of the package: the assets to make, and the review checklist. The listing needs a
wordpress.org account, and the founder's yes.
