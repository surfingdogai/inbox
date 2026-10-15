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

## Amendment 1 — A larger reading allowance for agents that sign their reports

**Status:** proposed, 15 October 2026. The reference values below (the points, the allowances, the
day's limits on new reporters, and the 600 a minute that `GET /v1/businesses` gains) and the open
question at the end await the founder's approval; until then this is neither merged nor deployed.

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
   order stays the same, and the points carry no weight in a ranking, a score, a track record or
   anything a business is told. Point 3 stands: every answer is the same whoever asks.
2. **Signed only.** Points go to a self-held key (sdi-agent/1) or to an agent platform (Web Bot Auth,
   counted by its origin's registrable domain, so one operator's origins are one reporter). An unsigned
   report earns nothing, so a flood of them buys nothing.
3. **Breadth over time, not volume.** A report the network took earns its signer 1 point: one business
   on one UTC day the network received reports at it, however many. The day is the day received, never
   the report's own `at`, so a week cannot be back-dated in one call. A day counts at most 10 points. A
   contributor has 30 points in the last 30 days, on at least 7 different days. A key made today earns
   nothing for a week, and one busy day is never enough.
4. **Never the verdict.** A door that worked earns what a door that failed does. A platform earns
   nothing at a business on its own registrable domain.
5. **The allowance only adds.** The reference values: 1,800 reads a minute, in bursts of 600, for a key;
   6,000 in bursts of 2,000 for a platform; and at most that many of a kind from one address, so many
   keys behind one address read no more than one. When a contributor's own allowance is spent, the
   address's 600 a minute still applies. A contributor's report that a door could not be reached is
   read a little sooner, inside the same two reads a day per door. `GET /v1/businesses` and
   `GET /v1/businesses/{domain}`, which had no limit per address, gain the 600 a minute `/mcp` has (the
   busiest minute in the week before was 27 requests from everyone together).
6. **How a read is signed.** sdi-agent/1 as every signed call is, or Web Bot Auth covering at least
   `@authority` and `Signature-Agent`, which is what Web Bot Auth asks of a bot, by a platform the
   network knows from its reports (a read never makes the network fetch a key directory). A signed read
   or report covers the host it is sent to: the network's own, or a host that serves the same doors
   (for the reference network, `network.surfingdog.ai` and `surfingdog.ai`). A network checks a read's
   signature whoever it names, within a limit of checks a minute per address, and looks up the signer's
   points only once it verified; a read is never refused for its signature, and its answer never says
   what became of it. So no answer, header or delay tells anyone whether some signer is a contributor:
   only the signer can learn that, at `GET /v1/door-reports/me`, which also checks the signature before
   it looks anything up. A read's signature counts once. A report over MCP or A2A is the signer's only
   when its signature covers the whole request, and is checked as `POST /v1/door-reports` checks one.
7. **What is kept.** Per reporter and day: a keyed hash that changes every 30 days (never a key or an
   origin), the day, and how many businesses. Which businesses, only as bits of a keyed hash (4,096 of
   them, so a business twice in a day counts once; two of ten businesses share a bit about once in
   ninety such days) and only until the day ends: the network clears them within minutes of midnight
   UTC. Rows go after 31 days. The table joins nothing to receipts. A day takes points from at most
   20,000 new reporters (none of whose names has points in the window), at most 50 of them from one
   address block, and 100,000 returning ones, so a flood of fresh keys cannot take the day from a
   reporter that already has points, and the table stays under about a gigabyte at worst.

### Why this is safe before door tokens

What can be gamed is throughput, and only up to a ceiling. A farm of keys earns at most a kind's
per-address allowance at each address, after a week of reports per key, and a network runs only a few
searches at once whoever asks. Nothing public moves. When doors sign their answers, points can ask for
door tokens too; until then the numbers above are a network's reference values, published in its
`/report.md`.

**What it invites.** Points cost nothing to make up: a key earns its day's ten with ten signed reports
about listed businesses it never used, because what a report says never matters and nothing yet ties
a report to a use. Made-up reports cannot move anything public (a door is marked failing only by the
network's own reads), and a business sees them only within the limits every report has (for a key,
1,000 a day and 50 a day at one door). But they do reach a business's private counts, and a
contributor's "door is down" asks for its confirm read a little ahead of others, within the door's two
a day. The network's admin page shows, each day, how many reporters earn points, how many are
contributors, how many new reporters the day's limits held back, and how many reads contributors'
allowances took, so a farm shows early. Two ways to make a point cost a use are open, for the founder
to choose before this is accepted: count a business only when the same signer's signed reads returned
it in the 48 hours before (kept in memory, as a keyed hash per reporter), or count only reports that
carry a door's token once doors sign.

### Consequences

- Protocol §4.15 gains the allowance and `GET /v1/door-reports/me` (`401 signature_required` unsigned,
  §9); `vectors/door-reports.json` gains `contributors` (what earns, who is a contributor), applied by
  `reporterCreditOf` and `doorReportEarns`; `GET /v1/door-reports/me` answers the rule as `threshold`,
  the same object as `REPORTER_CREDIT_RULE`.
- `@surfingdog/sdk` gains `trackDoor` (report every use without writing the report), `signingFetch`
  (sign a client's requests to the network, and to no business unless asked) and `reporterCredit`, and
  its queue retries as a network asks (`Retry-After`), up to the 7 days a report is taken.
- The impact assessment gains the points table: what is kept, its rotation, the day's mask, 31 days.
