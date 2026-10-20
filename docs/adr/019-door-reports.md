# ADR-019 — Door reports are measurements of machines, not reviews

**Status:** accepted, 13 October 2026. Research, not legal advice: the impact assessment item and the
question for counsel below come before a network shows anything public from door reports.

## Context

An agent that books, orders or asks at a business knows how the business's door answered: whether it
answered at all, whether the operation was done, refused or failed, whether it needed a person, and how
long it took. Spec 0.4 lets an agent tell a network so, in one call, signed or not
([protocol §4.15](../protocol/network.md)), and writes down how a network's own reads move a door
between live, failing and gone (§4.8).

ADR-012 sets the rules for reviews, and says an agent-filed review needs its person's confirmation.
ADR-017 sets the rules for reputation: promises against delivery, from receipts. A door report sits
beside both, and needs its own place, so that it is not read as either.

## Decision

1. **A door report measures a machine.** It says whether a door answered and how; never anything about
   a person, never whether a promise was kept, never taste. It is not a review in ADR-012's sense, so
   ADR-012's rule that an agent-filed review needs its person's confirmation does not apply to it. A
   report that a promise was broken (`POST /v1/reports`) is a different call and stays under ADR-012
   and ADR-017, unchanged.
2. **Only the network's own reads move anything public.** A report reaches the business privately, and
   a report that a door is down can make the network read it. Nothing an agent says lowers a door,
   moves a business in the order or shows on its listing by itself. A rival who floods reports gets the
   network to look, within a small daily budget, and nothing more.
3. **Reward taking part, never the verdict.** What an agent gets for reporting is the same for a
   success and a failure: the network reads doors again, so the agent's own searches send it to doors
   that work. Every answer stays the same whoever asks.
4. **Pseudonymous, with no person and no content.** The body is strict: a member the protocol does not
   name refuses the whole call, so no pass, key, email, name, phone, address, message, body, IP address,
   item id, free-text reason or trace can travel in it, even by mistake. A customer's declined payment
   or address is a `customer_side` refusal before anything is kept. A network keeps counts per door,
   day, class and proof; rows only for door-signed and platform-signed reports; the source as a keyed
   hash, separated by purpose and changed every 30 days; standing in a table of its own, the only place
   a key meets receipts; rows for 30 days, then daily totals.
5. **The business never learns who reported.** It sees counts to the day and incidents to the hour,
   never a key, and a platform's origin only when 5 or more distinct sources (keys) from it reported
   within one period of the source hash, over 7 days or more. It sees only its own doors, never
   another business's on a host they share. A business cannot single out an agent, or the person
   behind it, to retaliate against.
6. **Said honestly.** Door reports are called pseudonymous, never "no personal data": a self-held key's
   keyed hash, with times and the domains it reported on, may be personal data of the person behind the
   agent. The guide for agents asks every agent to tell its person that it reports how doors answer.
7. **What door reports do not do.** They measure the first mile. They never prove a booking was
   honoured; that is promise evidence, from receipts, acknowledgements and the network's own checks of
   unclosed promises (ADR-017).

## Before anything is public

- **Impact assessment.** The data protection impact assessment ADR-012 calls for gains an item for door
  reports: what is kept (above), the keyed hash and its rotation, the 30-day retention, the separate
  standing table, the linkage risk between a key's reports and the receipts that name it, and the
  business-facing limits of point 5.
- **A question for counsel.** Is a self-held key's rotating keyed hash, kept with report times and
  business domains, personal data of the person behind the agent; if so, is legitimate interest the
  right basis for keeping it, and is the agent's in-band notice to its person enough information for
  them? And when a door's failures are shown publicly, is that personal data of a sole trader who runs
  the business?

## Consequences

- ADR-012 gains a note pointing here: its review rules are for reviews of people and promises, and door
  reports are neither.
- The protocol, the published vocabulary of classes and the vectors (`packages/spec`) decide what a
  report may carry and what it may do; a network that keeps more than §4.15 allows is not implementing
  the protocol.
- An agent's SDK may report automatically (`reportDoor`, on by default), because a report carries
  nothing about the person it acts for.
- A door's history, kept for good, is built from the network's own reads alone; no report enters it
  ([ADR-020](020-door-history.md)).

## Amendment 1 — A larger reading allowance for agents that sign their reports

**Status:** accepted, 19 October 2026. Proposed on 15 October and revised on 18 October after review;
on 19 October the founder approved the reference values below (the points, the allowances, the day's
limits on new reporters, the table's size, and the 600 a minute that `GET /v1/businesses` gains) and
the choice in "What it invites": a point costs a search (3).

### Context

Point 3 rewards reporting with re-checked doors. That helps every agent the same, so it gives no one a
reason to sign. Signatures matter: an unsigned report cannot be told apart from a flood, and the
stronger evidence this ADR looks forward to (door tokens, independent platforms) needs agents that
already sign. The earlier plan held any reward back until platforms were sending door-signed reports.
That cannot happen before agents have a reason to sign, so the reward comes first, as limits only, and
needs no door token.

### Decision

1. **Limits only.** An agent whose signed reports earn it enough points (a *contributor*) reads the
   directory on an allowance of its own: `/mcp`, `/a2a`, `GET /v1/businesses` and
   `GET /v1/businesses/{domain}`. Nothing else changes. The answers stay the same byte for byte, the
   order stays the same, a contributor's report that a door is down asks for the same confirm read as
   anyone's, and the points carry no weight in a ranking, a score, a track record or anything a
   business is told. Point 3 stands: every answer is the same whoever asks.
2. **Signed only.** Points go to a self-held key (sdi-agent/1) or to an agent platform (Web Bot Auth,
   counted by its origin's registrable domain, so one operator's origins are one reporter). An unsigned
   report earns nothing, so a flood of them buys nothing.
3. **A point costs a search.** A report the network took earns its signer 1 point only for a business
   the same signer's own signed reads of the network returned today or yesterday (UTC): a search or a
   lookup that listed it. A report about a business the signer never found there earns nothing, though
   it is taken as any report is.
4. **Breadth over time, not volume.** A point is one business on one UTC day the network received
   reports at it, however many. The day is the day received, never the report's own `at`, so a week
   cannot be back-dated in one call. A day counts at most 10 points. A contributor has 30 points in the
   last 30 days, on at least 7 different days. A key made today earns nothing for a week, and one busy
   day is never enough.
5. **Never the verdict.** A door that worked earns what a door that failed does. A platform earns
   nothing at a business on its own registrable domain.
6. **The allowance only adds.** The reference values: 1,800 reads a minute, in bursts of 600, for a key;
   6,000 in bursts of 2,000 for a platform; and at most that many of a kind from one address, so many
   keys behind one address read no more than one. When a contributor's own allowance is spent, the
   limits everyone has still apply: the address's 600 a minute, and on `/mcp` the limits a network
   keeps per person and per assistant platform (ADR-025). `GET /v1/businesses` and `GET /v1/businesses/{domain}`, which
   had no limit per address, gain the 600 a minute `/mcp` has (the busiest minute in the week before
   15 October was 27 requests from everyone together).
7. **How a read is signed.** sdi-agent/1 as every signed call is, or Web Bot Auth covering at least
   `@authority` and `Signature-Agent`, which is what Web Bot Auth asks of a bot, by a platform the
   network knows from its reports (a read never makes the network fetch a key directory). A signed read
   or report covers the host it is sent to: the network's own, or a host that serves the same doors
   (for the reference network, `network.surfingdog.ai` and `surfingdog.ai`). A network checks a read's
   signature whoever it names, within a limit of checks a minute per address, and looks up the signer's
   points only once it verified; a read is never refused for its signature, and its answer never says
   what became of it. So no answer, header or delay tells anyone whether some signer is a contributor:
   only the signer can learn that, at `GET /v1/door-reports/me`, which also checks the signature before
   it looks anything up. A read's signature counts once: replayed, the read is anyone's, and spends
   nothing of its signer's. A report over MCP or A2A is the signer's only when its signature covers the
   whole request, and is checked as `POST /v1/door-reports` checks one.
8. **What is kept.** Per reporter and day: a keyed hash that changes every 30 days (never a key or an
   origin), the day, and how many businesses. Which businesses, only as bits of a keyed hash (4,096 of
   them, so a business twice in a day counts once; two of ten businesses share a bit about once in
   ninety such days) and only until the day ends: the network clears them within a minute of midnight
   UTC. Rows go after 31 days. The table joins nothing to receipts. Of a signed read, nothing is written:
   in memory, that its signature was used, until it expires, and for today and yesterday a keyed hash
   of the signer with each business it was answered with, in a fixed bit array (8 MiB a day) that names
   neither; a restart forgets it.
9. **Bounds.** A day takes points from at most 20,000 new reporters (none of whose names has points in
   the window), at most 50 of them from one address block (an IPv4 /24, an IPv6 /32: a /48 is what one
   customer gets, and a farm can hold thousands). A reporter with points always earns. Once a day the
   network keeps, of each 30-day period's reporters, the 100,000 with the most points (of two with as
   many, the one that reported first in the period) and deletes the rest, so a reporter with points is
   pushed out only by that many others with more, never by fresh keys. The table then holds about 3.2
   million rows at worst; at about 240 bytes a row with its index (measured on 310,000), under a
   gigabyte.

### Why this is safe before door tokens

What can be gamed is throughput, and only up to a ceiling. A farm of keys earns at most a kind's
per-address allowance at each address, after a week of searches and reports per key, and a network
runs only a few searches at once whoever asks. Nothing public moves. When doors sign their answers,
points can ask for door tokens too; until then the numbers above are a network's reference values,
published in its `/report.md`.

**What it invites.** A point still costs little: a key earns its day's ten with a search that lists
ten businesses and ten signed reports about them, because what a report says never matters and
nothing yet ties a report to a use of the door. Made-up reports cannot move anything public (a door is
marked failing only by the network's own reads, and a contributor's "door is down" is read no sooner
than anyone's), and a business sees them only within the limits every report has (for a key, 1,000 a
day and 50 a day at one door). But they do reach a business's private counts. A farm with keys behind
enough address blocks can spend the day's 20,000 new reporters every day, so that no genuinely new
reporter earns until it stops; and a farm with more than 100,000 keys, each reporting as much as a
reporter with points, can push that reporter out of the table. The network's admin page shows, each
day, how many reporters earn points, how many are contributors, how many new reporters the day's
limits held back, how many reports named a business the signer's reads had not returned, how many rows
the ranking deleted, and how full the memory of reads is, so a farm shows early. The founder chose,
on 19 October 2026, the search the reference network asks for (3, as built) over waiting for doors to
sign; once they do, a point can ask for a report that carries a door's token too.

### Consequences

- Protocol §4.15 gains the allowance and `GET /v1/door-reports/me` (`401 signature_required` unsigned,
  §9); spec 0.8.1. `vectors/door-reports.json` gains `contributors` (what earns, who is a contributor),
  applied by `reporterCreditOf` (which takes a network's own rule) and `doorReportEarns`;
  `GET /v1/door-reports/me` (`schemas/door-reports-me.json`) answers the network's rule as `threshold`,
  the reference one being `REPORTER_CREDIT_RULE`, and its guide as `guide`.
- `@surfingdog/sdk` gains `trackDoor` (report every use without writing the report; an A2A task's state
  says how it went), `signingFetch` (sign a client's requests to the network, and to no business unless
  asked) and `reporterCredit` (`DoorReportsMe`), and its queue retries as a network asks
  (`Retry-After`), up to the 7 days a report is taken. Where a door's signed outcome token travels is
  not specified yet, so `trackDoor` reads one only where the caller says (`tokenOf`).
- The impact assessment gains the points table (what is kept, its rotation, the day's mask, 31 days)
  and the memory of signed reads.
