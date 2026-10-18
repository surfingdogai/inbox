=== Surfing Dog Inbox ===
Contributors: surfingdog
Tags: ai agents, llms.txt, agent inbox, structured data, mcp
Requires at least: 6.0
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.1.0
License: MIT
License URI: https://opensource.org/licenses/MIT

Lets AI agents find your agent inbox from your website. One setting.

== Description ==

Your agent inbox answers at its own address, like inbox.yourdomain.com. This plugin makes your website lead AI agents there:

* a link in every page's head (`<link rel="agent-inbox">`) and the same as an HTTP Link header;
* structured data on your front page (schema.org, with a potentialAction pointing to the inbox);
* `/llms.txt`, when your site has none of its own, with your site's name and the inbox's line;
* `/.well-known/agent-inbox.json`: a copy of your inbox's manifest, refreshed twice a day and checked before it is served, or a redirect to it.

Settings → Agent inbox has the one setting (the inbox's address: inbox.yourdomain.com unless you set another), what is published, and Check, which asks Surfing Dog's checker whether agents can find your inbox and what is missing, robots.txt included.

= What it contacts =

* Your inbox's own manifest, at the address you set, twice a day at most, to keep its copy.
* Surfing Dog's checker (network.surfingdog.ai), only when you press Check: it receives your site's domain and the inbox's address, and reads your site's public pages as a browser would.

Nothing else. No tracking, no account.

= What you still add yourself =

A DNS record where your domain's DNS is: type TXT, name `_agent-inbox`, value as the settings page shows. And if your robots.txt keeps out AI assistants (ChatGPT-User, Claude-User, Perplexity-User…), Check says which, with the lines that let them in.

== Installation ==

1. Plugins → Add New Plugin → Upload Plugin, choose the plugin's zip, then Activate.
2. Settings → Agent inbox: check the address, and save.
3. Press Check.

WordPress must answer at the root of your domain for `/llms.txt` and `/.well-known/agent-inbox.json`; in a subdirectory, the link and the structured data are still published.

== Frequently Asked Questions ==

= My site already has an llms.txt =

A file on disk, or one another plugin serves first, stays as it is. Add the line the settings page shows to it.

= Does it change robots.txt? =

No. It tells you what to change, if anything.

== Changelog ==

= 0.1.0 =
* The link, the structured data, llms.txt and the copy of the manifest, from one setting; and Check.
