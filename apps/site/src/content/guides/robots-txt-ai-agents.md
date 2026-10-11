## What an assistant needs

To act for its person, an assistant, or the crawler that reads for it, has to reach your site and read it. One file decides whether it may: robots.txt says which paths a crawler may read, and its content signals say what may be done with what it reads.

## What robots.txt does

`robots.txt` sits at the root of your site and tells crawlers which paths they may read, in a group for each crawler's name, with `*` for every crawler that has no group of its own. It's a standard ([RFC 9309](https://www.rfc-editor.org/rfc/rfc9309)). Well-behaved crawlers obey it; it doesn't lock anything.

<pre><code>User-agent: *
Allow: /
Disallow: /account/</code></pre>

A `Crawl-delay` line asks a crawler to wait that many seconds between requests. Many crawlers honour it, ours among them.

## Content signals

A content signal is a line in robots.txt that says what may be done with what a crawler reads ([contentsignals.org](https://contentsignals.org)):

<pre><code>User-agent: *
Content-Signal: search=yes, ai-input=no, ai-train=no
Allow: /</code></pre>

- `search`: may it be used for a search index, to show links and short extracts?
- `ai-input`: may it be given to an AI model as input, for example to answer someone's question?
- `ai-train`: may it be used to train or fine-tune a model?

## How our check reads them

Our crawler, SurfingDogBot, reads robots.txt before anything else on each host, and obeys the group for SurfingDogBot, or the `*` group when there isn't one for it. If robots.txt can't be read, we read nothing more. If it keeps crawlers off your homepage, we stop there.

`search=no` stops our crawler. If your site tells AI systems not to use or train on its content (`ai-input=no` or `ai-train=no`), we never name your business or list it publicly, whatever it publishes for machines.

## Letting our crawler in

If your robots.txt keeps every crawler out and you'd like your site checked, add a group for ours:

<pre><code>User-agent: SurfingDogBot
Allow: /</code></pre>

Every request it makes is signed (Web Bot Auth), so a host or a firewall that lets signed bots through can let it in without opening the door to everyone. More in [about our crawler](/bot).

## If you'd rather not be read

Say so, and we respect it. There's nothing else to do:

<pre><code>User-agent: SurfingDogBot
Disallow: /</code></pre>

You can also opt out at [surfingdog.ai/bot](/bot): the crawling stops, and what we hold about your site is deleted.

## What counts in the check

robots.txt and content signals earn no points and cost none. They decide whether we read your site, and whether your business can be named. A bot check that answers in place of your site, such as a challenge page, stops us, as it would stop a customer's assistant.
