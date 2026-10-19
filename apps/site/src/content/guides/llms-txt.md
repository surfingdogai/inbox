## What an assistant needs

To speak for you, an assistant needs to know what your business is and where the details are. To act for its person, it needs a door. `llms.txt` helps it learn about you, and can point it to a door.

## What it is

`llms.txt` is a proposal from 2024 ([llmstxt.org](https://llmstxt.org)): a Markdown file at `/llms.txt` with your name, a short summary, and links to the pages and documents an AI should read. Think of it as a map of your site, written for a machine.

## What it does

- **It helps an assistant read about you**: what you do, where, for whom, and where the details are.
- **It can name your doors.** A link whose words say what an address is (`- [MCP server](https://…)`) is how many readers, ours included, find a door that has no well-known file of its own. See [findable doors](/guides/findable-agent-doors/) for the lines we read.
- **It can carry a basket hand-off or an order lookup**, which a reader can act on.

## What it doesn't do

- **It doesn't let an assistant ask, book, order or pay.** Those need a door: a tool, an API or an inbox that takes the request.
- **It isn't read by every AI.** Some read it and some don't; it costs little to publish, so it's worth having.
- **It doesn't replace your markup.** Hours, prices and terms are read more reliably as schema.org data ([your details as data](/guides/business-details-for-ai/)).

## What to put in it

<pre><code># Your Business

&gt; A bike workshop: repairs, servicing and parts. Open Monday to Saturday.

## About

- [Services and prices](https://yourbusiness.example/services)
- [Opening hours and where we are](https://yourbusiness.example/visit)

## For AI agents

- [MCP server](https://agent.yourbusiness.example/mcp): streamable HTTP
- [Order lookup API](https://yourbusiness.example/api/orders/lookup): POST, by order number and email</code></pre>

Write each line as a Markdown link, `- [Name](https://…): a short note`, so its words say what it is; keep the addresses on your own domain, and keep the file short. Chrome's Lighthouse fails a file with no Markdown link.

To check yours line by line, see [how to validate your llms.txt](/guides/validate-llms-txt/). To start from a file made for a business like yours, see [llms.txt examples for small businesses](/guides/llms-txt-examples/).

## What counts in the check

On its own, `llms.txt` earns no points: it makes a site readable, not usable. We follow the doors it names on your domain and its subdomains, and each door then counts for what it does.
