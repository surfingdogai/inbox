## What an assistant needs

An assistant can't use a door it can't find. It doesn't click around your site: it reads a few files at places agreed in advance, and follows what they name. A door that is easy to find and hard to misread is the one that gets used.

## Where readers look

These are the places our check reads, and other readers look in most of them too:

| On your domain | What it is |
| --- | --- |
| `/.well-known/mcp/server-card.json` | An MCP server card: where your MCP server is, and what it offers. A proposed convention; a site with several servers can list them at `/.well-known/mcp.json` as `{"servers": [{"url": "…"}]}`. |
| `/.well-known/agent-card.json` | An A2A agent card, for an AI agent of your own. |
| `/.well-known/ucp` and `/.well-known/acp.json` | A UCP or an ACP checkout profile. |
| `/openapi.json` or `/.well-known/openapi.json` | An OpenAPI document that describes your API. |
| `/.well-known/agent-inbox.json` | An agent inbox's manifest. |
| `/.well-known/ai-catalog.json` | An AI catalog that lists your doors in one place. |
| `/llms.txt` | Prose for machines, with a line for each door. |

Your homepage can point to doors as well: `<link rel="mcp" href="…">` for an MCP server, and `<link rel="service-desc" href="…">` for an API document.

## Lines in llms.txt

In `llms.txt`, write one door to a line, with words that say what the address is:

<pre><code>## For AI agents

- MCP server (streamable HTTP): https://agent.yourbusiness.example/mcp
- A2A agent card: https://yourbusiness.example/.well-known/agent-card.json
- OpenAPI document: https://yourbusiness.example/openapi.json
- Product feed: https://yourbusiness.example/feed.xml
- Order lookup API: POST https://yourbusiness.example/api/orders/lookup
- Basket hand-off (an agent fills the basket, a person pays): https://yourbusiness.example/cart/&lt;id&gt;:&lt;qty&gt;</code></pre>

We read a line as a door when its words or its address say what it is: an MCP server, an A2A agent card, a UCP or ACP profile, an OpenAPI document, a product feed, an order lookup, a basket hand-off or another API. A link to documentation about a door, such as a page under `/docs/` or a `.md` file, is read as a page, not as a door. More on the file itself: [what llms.txt does, and doesn't](/guides/llms-txt/).

## On your own domain

Keep every door on your own domain or a subdomain, such as `agent.yourbusiness.example`. A door on an unrelated host is easy to fake, so careful readers set it aside unless your own site leads to it, and they look for your domain in the door's own document. We don't follow an `llms.txt` line to another site; we note the door as declared and not found.

## What counts in the check

A door counts when we find it from your domain and it answers: an MCP server whose tools we can list, an agent card, a checkout profile, an inbox manifest or an API document we can read. What it lets an agent do is read from its tool names, skills and operations, as the other guides list. A door you declare when you claim your listing counts once we've checked it.

We never call your tools, fill in a form or place an order: we read what each door says it does.
