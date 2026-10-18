# ADR-021 — The reference: a vocabulary of what agents can do, versioned specs, a monthly census

**Status:** proposed, 15 October 2026; amended 18 October 2026 after review. The minimum sample of
100, the census's day, what a city needs, and the census's licence are proposals until accepted.

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
   (`/spec/capabilities/v<N>.json`), the latest at `/spec/capabilities.json`, with a changelog of one
   shape (version, date, published or amended, summary). Version 1 is archived as it was last served,
   as amended on 13 October 2026. The published schema reads a capability, a kind of door, a request
   kind and a part of the journey as any lower-case name, so a later version that adds one does not
   fail a validator; the closed lists of this version stay in the code.
3. **Examples are held to the checker, and the name rule has vectors.** Every example name in the
   vocabulary is read as its capability by the door registry a network checks with; Surfing Dog's
   network tests this, so the vocabulary never promises what the checker does not do. The same test
   writes `vectors/capability-names.json`: every example, and names that look like a capability and
   meet another or none, each with what it meets, so two checkers can agree without reading each
   other's code.
4. **A commerce profile counts where the business really sells.** A commerce platform's profile that
   every site on it gets is not enough on its own, for ordering, paying, the catalogue, availability,
   tracking and returns alike (the founder's decision of 15 October 2026, the network's score rules
   version 3 as revised that day). A name that reads documentation meets no capability. **Version 2
   ships with those rules**: it is deployed with, or after, the network that applies them, and its
   published date is the day it is deployed. A network that served version 2 while counting the
   blanket profile would contradict the definitions it links to.
5. **Specs are versioned documents.** The manifest is versioned by its own identifier
   (`surfingdog-inbox/0`), receipts by their claims version (`ver`), and each page says the day it
   last changed and keeps a changelog, by date. Fields and values are added; a change that would
   break a reader comes with a new identifier. A value that widens what a field takes (a day may
   close at `24:00`) is additive: a reader written before it may refuse that one value, and the page
   says so.
6. **Schemas have addresses.** Every JSON Schema in `packages/spec/schemas` carries a `$id` at
   `https://surfingdog.ai/spec/schemas/<name>.json`, where the site serves it, byte for byte, to any
   origin. The MCP tools' schemas, served inside a network's `tools/list`, carry none. Each file has
   one address.
7. **Anyone can check their own.** `checkManifest`, `checkReceipt` and `checkAcknowledgement` in
   `@surfingdog/spec` say whether a document holds to the specs and why not, with the codes a network
   answers; the vectors decide them. `/spec/check/` runs the same code in the browser and sends
   nothing anywhere. A receipt checked without its keys is said to hold in form only: its signature
   was not checked. `@surfingdog/sdk`'s `verifyReceipt` reads the claims the same way.
8. **A census, once a month, counts what agents can do.** It counts through the directory's own
   counting (one function, shared with `/v1/stats`: the same population, agent-ready, capabilities,
   doors and levels), by the whole, country, kind of business, website platform, where the sites
   came from, and city. It counts websites, not businesses: the sites checked include popular sites
   that are not businesses, and the method says what the population holds. It names no website. A
   breakdown is published only with at least 100 sites checked; small counts within it are published
   as they are, since each counts public features of websites and no row names one. A city is marked
   partial until 80% of its list is read. A change from the previous edition is shown as a change in
   share, in percentage points, since the sites checked grow from month to month. Its counts are open
   data under the ODbL; the specs and code are MIT, like the rest of this repository.
9. **An edition counts one set of rules, the honest one, and the one a person read.** An edition
   records the score rules it was counted under by version, revision date and content hash, and how
   many of the checked were scored under them. It is not taken while the scores move to new rules
   (fewer than 99% scored under them, or the levels being worked out again), and it is published only
   under score rules version 3 as revised on 15 October 2026 or later. Publishing names the draft read
   by the time it was taken, so counts nobody read are never published; a draft taken before its
   month ended goes out only with a note saying why. Once published its counts never change (the
   database refuses any write, delete or truncate), and a mistake withdraws it with a note.

## Why

A reference is only worth something if it is precise, stable and checkable. Precise: a capability
has to mean the same thing on a result page, in a census and in another company's checker. Stable:
a dataset that reads "can:book" in October must mean the same in March, so ids are frozen and
versions kept. Checkable: anyone can test their manifest or receipts against the same code and
vectors we use, and the vocabulary's examples are tested against the checker itself.

The census counts actions, not standards: whether an agent can book, order, ask or pay, not which
files a site serves. That is the question a business and an agent builder care about, and it follows
from the same counts the directory already shows, so the numbers agree everywhere. Its draft of
October 2026, taken before the honest counts, read a website platform's blanket shopping file as
orders at thousands of sites that sell nothing, and put its agent-ready headline about four times
too high; decision 9 makes such a draft impossible to publish.

## Consequences

- `packages/spec` 0.5: the vocabulary's schema grows optional fields (a version 1 document still
  reads), `conformance.ts`, the census's schemas (`census-edition`, `census-editions`), the MCP tool
  `get_census`'s schemas, the vectors `capability-names.json` and `census-edition.json`, and `$id`s.
- The site serves `/spec/` (the pages and the files) and `/spec/check/`.
- A network that publishes a census follows protocol §4.16; it is optional.
- Surfing Dog's census pages live on the network, at `/census/<edition>` on the site's address.
- The October 2026 draft is not published unless the honest counts run and the levels are worked
  out again before its take window closes (3 November 2026); otherwise the census starts with
  November 2026.

## Open

- Whether the census's counts should be CC BY 4.0, as an earlier note on readiness asked, rather
  than the ODbL the directory's data uses.
- Whether a city waits until most of its list is read before it is shown at all; today it shows
  once 100 of its sites are checked, marked partial below 80%.
