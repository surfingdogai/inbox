---
title: The census of what AI agents can do
description: "How the monthly census counts what AI agents can do at the websites we checked, and the format of its open data. Method version 1."
---

**Method version 1**, last changed 18 October 2026. JSON Schemas: [an edition](/spec/schemas/census-edition.json), [the list of editions](/spec/schemas/census-editions.json) · an example: [`census-edition.json`](/spec/vectors/census-edition.json). The counts are open data under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): credit "Surfing Dog census, surfingdog.ai, CC BY 4.0".

Once a month we count how many of the websites we checked an AI agent can do each thing with: send a message, book, order, pay, and the rest of [the capability vocabulary](/spec/capabilities/). The census counts. It never names a website.

## Who is counted

Every website our crawler has read and scored, except:

- a site whose owner hid its result,
- a site that asked not to be read,
- the kinds of business the directory leaves out: adult services, gambling, weapons, tobacco, cannabis and vaping, payday loans and bail bonds.

The sites come from:

- **public lists**: places with a website in open place data from [Overture Maps](https://overturemaps.org), and the most visited sites in the Chrome UX Report;
- **the MCP Registry**, a list of servers made for agents;
- **links** our crawler followed;
- **checks** people asked for, and businesses in the directory.

Each edition counts the sites from each of these on its own (`source`). Most of the sites are businesses; some are not, like governments, universities and encyclopedias, which are among the most visited sites. A list chosen for its agent doors, like the MCP Registry, has a high share by how it was chosen. This is not a random sample of the world's websites: say so wherever you use the numbers.

## What is counted

| Metric | Counts |
| --- | --- |
| `checked` | websites read |
| `agent_ready` | of those, the ones an agent can reach through a door: askable or above, or a business in the directory with its own inbox. A site that tells AI systems not to use its content is never counted as agent-ready, unless it runs its own inbox in the directory. |
| `can:<capability>` | of the agent-ready, those where an agent can do it: its state is `yes`, through a door the site published, and not on experimental evidence alone |
| `door:<type>` | of the agent-ready, those with a live door of that type: `inbox`, `mcp`, `a2a`, `openapi`, `ucp`, `acp`, `webmcp` |
| `level:<name>` | how many reached each readiness level: `none`, `listed` and `readable` among those checked, `askable` and above among the agent-ready |
| `no_ai` | of those checked, the sites whose doors reach askable or above and that ask AI systems to stay away |
| `places` | for a city: how many places its list holds, read or not, so you can see how much of the city the counts cover |
| `pay_read` | for the whole, a country and a city: of those checked, the sites whose ways to pay we read |
| `pay:<token>` | of those, the sites that show a way to pay at all: a token of [the payments vocabulary](https://github.com/surfingdogai/inbox/blob/main/packages/spec/vocab/payments.json), such as `card`, `apple_pay`, `paypal` or `x402` |
| `pay_declared:<token>` | of those, the sites that declared it themselves; `pay:<token>` minus `pay_declared:<token>` is those where it was only seen |

The levels and `no_ai` add up to `checked`. A way to pay is declared when the business says so itself: its own structured data (schema.org `paymentAccepted`), its inbox's settings, its registration, or its own shop profile (UCP payment handlers, ACP delegated payment, an agent payment protocol its door declares in its structure). It is only seen when it does not, but a payment provider's own code, button, payment icon or hosted checkout link is on its pages, its Apple Pay domain file is on its site, or its shop platform's standard profile lists it (the handlers a platform gives nearly every store). A page's words are never counted, and seen never means an agent paid there. A card brand counts as a card: `pay:card` holds every site that shows one, and each brand has its own rows. The census page leaves out `ucp_handlers`, the protocol itself, and shows the brands only in the data. A capability's state comes from the score rules in force when the edition is taken; the edition names their version, the day they were last revised (`score_rules.revised`: a version amended in place counts differently), their content's hash and how many of the sites checked were scored under them. An edition is never taken while the scores are moving to new rules. A state is declared (the site's own pages or door say so) or tested (our own read saw the door list it). Neither means an agent carried it out.

## Breakdowns

- **Country**: the country the site's address data names; else its country domain (`.fr` is France, `.uk` the United Kingdom; `.io`, `.co`, `.ai` and other domains sold as names are no country); else the region of its page's language. A site with none is counted under `none`.
- **Kind of business**: the directory's category group. Software, API and AI companies are a kind of their own. A site whose kind we could not tell is counted under `none`. Online shops are partly recognised by their agent doors (a shopping protocol's profile, a shop platform's door), so their share is high by construction.
- **Platform**: the website builder or shop system we read on the site's own pages, `none` when we saw none.
- **Source**: where the site came from, as above: `seed` (the public lists), `registry`, `discovered`, `checked`.
- **City**: the ten cities we have sampled so far. Each city's list is a random sample of up to 25,000 places with a website in seven kinds (restaurants, cafés and bars; hotels; hair and beauty; dentists; clinics; shops; gyms) from [Overture Maps](https://overturemaps.org) places data; the edition names the lists (`method.places_sources`). A city's `places` is its list's size, not how many businesses it has. A city is partial until we have read 80% of its list (`method.city_read`).
- **Minimum sample**: a country, kind of business, platform, source or city is published only when we checked at least 100 of its sites. Each edition says how many were left out. Within a published key, small counts are published as they are: each counts public features of websites, and no row names one.

## Editions

- An edition records one month and is named for it: `2026-10`.
- It is taken as a draft once the month has ended, on the next month's first day after 00:30 UTC. A person reads it, then publishes that draft, named by when it was taken (`as_of`). A draft taken before its month ended is published only with a note saying why (`publish_note`).
- Once published, its counts never change. If a mistake is found, the edition is marked withdrawn, stays readable, and says why.
- A change from the previous edition is a change in share, in percentage points of those checked (or of the agent-ready, for doors): the sites checked change from month to month, so a count can grow while its share does not.

## The data

- `GET https://surfingdog.ai/v1/census` lists the editions.
- `GET https://surfingdog.ai/v1/census/{edition}` is one edition as JSON; `https://surfingdog.ai/census/{edition}.csv` the same rows as CSV, with the header `edition,scope,key,metric,value`. The MCP tool `get_census` answers the same, cut to one scope or key.
- Rows are long: one count per scope, key and metric. Every published key has a row for every metric of its scope, zero included (the payment metrics are counted for the whole, countries and cities). A reader skips a scope or a metric it does not know: both are added to, never renamed.
- The counts are open data under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/) (CC BY 4.0): use them for anything, crediting "Surfing Dog census, surfingdog.ai, CC BY 4.0". City counts rest on Overture Maps places data: credit "© Overture Maps Foundation" with them (`licence.credits`). The directory's own data stays under the Open Database License 1.0.

## Changelog

- **18 October 2026**: ways to pay, for the whole, each country and each city: `pay_read`, `pay:<token>` and `pay_declared:<token>`, and the edition names the tokens it counts (`payments`). The schema's `metric` is from now on any lower-case name with at most one key after a colon, so a reader that validates editions does not refuse one with a metric added later (0.6's named each metric, and refuses these: move to 0.7).
- **18 October 2026**: websites, not businesses; where the sites came from (`source`); the levels from askable up among the agent-ready, and `no_ai`; the score rules by revision, hash and share; changes in percentage points; cities partial below 80% of their list; a draft published by when it was taken; the counts under CC BY 4.0, credited "Surfing Dog census, surfingdog.ai, CC BY 4.0" (the founder's decision of this day; the ODbL before). Nothing was published before.
- **15 October 2026**: method version 1.
