# Surfing Dog Inbox for WordPress

A WordPress plugin that lets AI agents find a business's agent inbox from its website, from one
setting (the inbox's address, `inbox.<domain>` unless set). It publishes the lines of ADR-022 and
`packages/spec/vectors/discovery.json`:

- `<link rel="agent-inbox">` in every page's head, and the same as an HTTP `Link` header;
- schema.org structured data on the front page, with a `potentialAction` pointing to the inbox;
- `/llms.txt`, when the site has none of its own;
- `/.well-known/agent-inbox.json`: a copy of the inbox's manifest, refreshed twice a day and checked
  before it is served (an agent inbox's, naming the inbox's address as its own), else a redirect.

Settings → Agent inbox also has Check, which asks Surfing Dog's checker (`GET /v1/discovery/{domain}`)
what is in place and what is missing, robots.txt included, only when pressed.

## Tests

    php surfingdog-inbox/tests/run.php

WordPress's functions are stood in for; nothing reaches the network. CI runs it on every change
(`.github/workflows/ci.yml`, job `wordpress`), with `php -l` on every file.

## A zip to install

    cd integrations/wordpress && zip -r surfingdog-inbox.zip surfingdog-inbox -x 'surfingdog-inbox/tests/*'

Then Plugins → Add New Plugin → Upload Plugin.

**Not submitted to wordpress.org.** `readme.txt` is in its format; the listing needs a wordpress.org
account, and the founder's yes.
