# ADR-020 — The reference: a vocabulary of what agents can do, versioned specs, a monthly census

**Status:** proposed, 15 October 2026. The founder asked for this work that day; the numbers in it
(the minimum sample of 100, the census's day, what a city needs) are proposals until he says yes.

## Context

What an agent can do at a business is already counted in three places: the checker's result pages,
`/v1/stats` and the leaderboards. Each reads the capability vocabulary (`vocab/capabilities.json`),
but version 1 of it says only an id, a label and a question. What "book" means, what has to be seen
before anyone says a business takes bookings, and how an MCP tool, an A2A skill, an OpenAPI
operation or a UCP profile carries it lived in the network's door registry and in nobody's words.
The manifest and the receipts had schemas and vectors, but no document that said which version you
were reading, what changed, or how to check your own. And nothing counted, month by month, what
agents can actually do.

## Decision

1. **The capability vocabulary is the reference for what an agent can do at a business.** Version
   2 gives each of the twenty capabilities a definition, other words for it, what `partial` means
   for it, what has to be seen at each step of the evidence ladder (declared, tested, proven), what
   is not enough, and how each kind of door carries it, by example names. It names the directory
   request kind each maps to (`ask` is `message`, `quote` is `negotiate`). The kinds of door, what
   never counts as a door and how names are read are written down too.
2. **Ids never change.** A capability is added, never renamed or removed; version 2 changes none of
   version 1's ids, journeys, labels or questions. Every version stays published at its own address
   (`/spec/capabilities/v<N>.json`), the latest at `/spec/capabilities.json`, with a changelog.
3. **Examples are held to the checker.** Every example name in the vocabulary is read as its
   capability by the door registry a network checks with; Surfing Dog's network tests this, so the
   vocabulary never promises what the checker does not do.
4. **Order needs something the business really sells.** A commerce platform's profile that every
   site on it gets is not enough on its own (the founder's decision of 15 October 2026).
5. **Specs are versioned documents.** The manifest is versioned by its own identifier
   (`surfingdog-inbox/0`), receipts by their claims version (`ver`), and each page says the day it
   last changed and keeps a changelog. Fields and values are added; a change that would break a
   reader comes with a new identifier.
6. **Schemas have addresses.** Every JSON Schema in `packages/spec/schemas` carries a `$id` at
   `https://surfingdog.ai/spec/schemas/<name>.json`, where the site serves it, byte for byte. The MCP
   tools' schemas, served inside a network's `tools/list`, carry none.
7. **Anyone can check their own.** `checkManifest`, `checkReceipt` and `checkAcknowledgement` in
   `@surfingdog/spec` say whether a document holds to the specs and why not, with the codes a network
   answers; the vectors decide them. `/spec/check/` runs the same code in the browser and sends
   nothing anywhere.
8. **A census, once a month, counts what agents can do.** It counts through the directory's own
   counting (one function, shared with `/v1/stats`), by the whole, country, kind of business,
   website platform and city. It names no business. A breakdown is published only with at least
   100 sites checked. An edition is taken as a draft at the end of its month, read by a person and
   published by them; once published its counts never change, and a mistake withdraws it with a
   note. Its counts are open data under the ODbL; the specs and code are MIT, like the rest of this
   repository.

## Why

A reference is only worth something if it is precise, stable and checkable. Precise: a capability
has to mean the same thing on a result page, in a census and in another company's checker. Stable:
a dataset that reads "can:book" in October must mean the same in March, so ids are frozen and
versions kept. Checkable: anyone can test their manifest or receipts against the same code and
vectors we use, and the vocabulary's examples are tested against the checker itself.

The census counts actions, not standards: whether an agent can book, order, ask or pay, not which
files a site serves. That is the question a business and an agent builder care about, and it follows
from the same counts the directory already shows, so the numbers agree everywhere.

## Consequences

- `packages/spec` 0.5: the vocabulary's schema grows optional fields (a version 1 document still
  reads), `conformance.ts`, the census's schemas (`census-edition`, `census-editions`), and `$id`s.
- The site serves `/spec/` (the pages and the files) and `/spec/check/`.
- A network that publishes a census follows protocol §4.16; it is optional.
- Surfing Dog's census pages live on the network, at `/census/<edition>` on the site's address.

## Open

- Whether the census waits for the honest counts (decision 4 applied by the network) before its
  first edition is published. It should: the draft of October 2026 still counts the platform
  profile as orders.
- Whether a city waits until most of its list is read; today a city shows once 100 of its sites
  are checked, with how many of its list that is.
