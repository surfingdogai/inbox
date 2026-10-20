=== Surfing Dog Inbox ===
Contributors: surfingdog
Tags: ai agents, llms.txt, agent inbox, structured data, mcp
Requires at least: 6.0
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.2.0
License: MIT
License URI: https://opensource.org/licenses/MIT

Points AI agents from your website to your agent inbox, and connects your WooCommerce shop to it without copying a key.

== Description ==

Your agent inbox answers at its own address, like inbox.yourdomain.com. This plugin makes your website point AI agents there:

* a link in every page's head (`<link rel="agent-inbox">`) and the same as an HTTP Link header;
* structured data on your front page (schema.org, with a potentialAction pointing to the inbox);
* `/llms.txt`, when nothing else on your site answers it, with your site's name and the inbox's line;
* `/.well-known/agent-inbox.json`, when nothing else answers it: a copy of your inbox's manifest, checked before it is kept.

It publishes nothing until you save the address in Settings → Agent inbox and your inbox answers there as an agent inbox, so agents are never sent to an inbox that is not there. The copy is refreshed twice a day in the background, never while a visitor waits.

Settings → Agent inbox has the one setting (the inbox's address: inbox.yourdomain.com unless you set another), what is published, and Check, which asks Surfing Dog's checker what is in place and what is missing, robots.txt included.

= With WooCommerce =

* **Connect WooCommerce** opens your inbox with its WooCommerce card open. Press Connect your shop there, then Approve on WooCommerce's own page. Your products and stock come into your inbox, and the orders it accepts go into WooCommerce, paid at your own checkout with your own payment methods.
* Your llms.txt gains one line for your shop: once your inbox is connected to it, agents order through your inbox and your customers pay at your own checkout; before that, orders at your own checkout and questions, quotes and bookings to your inbox.
* Your customer hears from you once. For the orders your inbox made, WooCommerce's own processing and completed emails stay quiet while your inbox is connected, since your inbox sends its own receipt and tells your customer when the order is on its way. Refund and cancellation emails, on-hold emails (with bank transfer details), invoices and your notes go as usual. Developers can turn this off with the `sdi_quiet_store_emails` filter.

The plugin makes no key and sends nothing to connect your shop: WooCommerce makes the key on its own Approve page, for your inbox.

= What you still add yourself =

A DNS record where your domain's DNS is: type TXT, name `_agent-inbox`, value as the settings page shows. And if your robots.txt keeps out AI assistants (ChatGPT-User, Claude-User, Perplexity-User…), Check says which, with the lines that let them in.

== External services ==

This plugin connects to two services, and only these.

**Your own agent inbox**, at the address you save (for example inbox.yourdomain.com). The plugin fetches the inbox's public manifest (`/.well-known/agent-inbox.json`) when you save the address and twice a day in the background (WP-Cron), to publish a checked copy of it. Nothing is sent but the request itself: no personal data, no site data. The inbox is your own (self-hosted or hosted for you); its terms are the ones you agreed to when you set it up. Connect WooCommerce only opens a link to your inbox in your browser.

**Surfing Dog's checker** (network.surfingdog.ai), only when you press Check. It receives your site's domain and your inbox's address, and reads your site's public pages as a browser would. Terms: https://surfingdog.ai/terms · Privacy: https://surfingdog.ai/privacy

No tracking, no analytics, no account.

== Installation ==

1. Plugins → Add New Plugin → Upload Plugin, choose the plugin's zip, then Activate.
2. Settings → Agent inbox: check the address, and save.
3. Press Check.
4. With WooCommerce: press Connect WooCommerce, then Connect your shop in your inbox, then Approve.

WordPress must answer at the root of your domain for `/llms.txt` and `/.well-known/agent-inbox.json`; in a subdirectory, the link and the structured data are still published.

== Frequently Asked Questions ==

= My site already has an llms.txt =

A file on disk, or one another plugin serves, stays as it is: this plugin answers /llms.txt only when nothing else does. Add the line the settings page shows to yours.

= Does it change robots.txt? =

No. It tells you what to change, if anything.

= Does it need WooCommerce? =

No. Without WooCommerce it does everything above but the shop part.

= How do I disconnect my shop? =

In your inbox: Settings → Integrations → WooCommerce → Disconnect. Your inbox removes its webhooks from your shop. Then remove the key it used in WooCommerce → Settings → Advanced → REST API (named Agent inbox).

== Screenshots ==

1. Settings → Agent inbox: the address, and what is published.
2. Check: what is in place and what is missing.
3. With WooCommerce: Connect WooCommerce.
4. In your inbox: Settings → Integrations, WooCommerce, Connect your shop.

== Changelog ==

= 0.2.0 =
* With WooCommerce: Connect WooCommerce, the shop's line in llms.txt, and WooCommerce's own processing and completed emails kept quiet for the orders the inbox made.
* Declared compatible with WooCommerce's order tables (HPOS).

= 0.1.0 =
* The link, the structured data, llms.txt and the copy of the manifest, from one setting; and Check.

== Upgrade Notice ==

= 0.2.0 =
Connect your WooCommerce shop to your agent inbox without copying a key.
