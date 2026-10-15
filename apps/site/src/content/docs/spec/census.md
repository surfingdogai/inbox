---
title: The census of what AI agents can do
description: "How the monthly census counts what AI agents can do at the businesses we checked, and the format of its open data. Method version 1."
---

**Method version 1**, 15 October 2026. JSON Schemas: [an edition](/spec/schemas/census-edition.json), [the list of editions](/spec/schemas/census-editions.json). The counts are open data under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

Once a month we count how many of the business websites we checked an AI agent can do each thing with: send a message, book, order, pay, and the rest of [the capability vocabulary](/spec/capabilities/). The census counts. It never names a business.

## Who is counted

Every business website our crawler has read and scored, except:

- a site whose owner hid its result,
- a site that asked not to be read,
- the kinds of business the directory leaves out: adult services, gambling, weapons, tobacco, cannabis and vaping, payday loans and bail bonds.

The sites come from public lists of popular websites, open place data, links the crawler follows, and anyone who checks a site. This is not a random sample of the world's businesses: it leans toward sites that are popular or that public place data knows. Say so wherever you use the numbers.

## What is counted

| Metric | Counts |
| --- | --- |
| `checked` | business websites read |
| `agent_ready` | of those, the ones an agent can reach through a door: askable or above, or a business in the directory. A site that tells AI systems not to use its content is never counted as agent-ready. |
| `can:<capability>` | of the agent-ready, those where an agent can do it: its state is `yes`, through a door the business published, and not on experimental evidence alone |
| `door:<type>` | of the agent-ready, those with a live door of that type: `inbox`, `mcp`, `a2a`, `openapi`, `ucp`, `acp`, `webmcp` |
| `level:<name>` | of those checked, how many reached each readiness level |
| `places` | for a city: how many places its list holds, read or not, so you can see how much of the city the counts cover |

A capability's state comes from the score rules in force when the edition is taken, and the edition names their version. A state is declared (the business's own site or door says so) or tested (our own read saw the door list it). Neither means an agent carried it out.

## Breakdowns

- **Country**: the country the site's address data names; else its country domain (`.fr` is France, `.uk` the United Kingdom; `.io`, `.co`, `.ai` and other domains sold as names are no country); else the region of its page's language. A site with none is counted under `none`.
- **Kind of business**: the directory's category group. Software, API and AI companies are a kind of their own. A site whose kind we could not tell is counted under `none`.
- **Platform**: the website builder or shop system we read on the site's own pages, `none` when we saw none.
- **City**: sites of places in that city in [Overture Maps](https://overturemaps.org) places data: restaurants, cafés and bars, hotels, hair and beauty, dentists, clinics, shops and gyms.
- **Minimum sample**: a country, kind of business, platform or city is published only when we checked at least 100 of its sites. Each edition says how many were left out.

## Editions

- An edition records one month and is named for it: `2026-10`.
- It is taken as a draft on the first day of the next month, just after midnight UTC. A person reads it, then publishes it.
- Once published, its counts never change. If a mistake is found, the edition is marked withdrawn, stays readable, and says why.

## The data

- `GET https://surfingdog.ai/v1/census` lists the editions.
- `GET https://surfingdog.ai/v1/census/{edition}` is one edition as JSON; `https://surfingdog.ai/census/{edition}.csv` the same rows as CSV, with the header `edition,scope,key,metric,value`.
- Rows are long: one count per scope, key and metric. Every published key has a row for every metric, zero included.
- Credit "Surfing Dog (surfingdog.ai)". A database you make from it is shared under the same licence. City counts also rest on data from the Overture Maps Foundation.

## Changelog

- **Method version 1**, 15 October 2026.
