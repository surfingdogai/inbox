# ADR-020 — A door's history is kept for good

**Status:** accepted, 15 October 2026 (keeping it for good is the founder's decision of that day; the numbers
marked \* are defaults the founder may change). Research, not legal advice: a legitimate-interest assessment and a
question for counsel are open (below).

## Context

A network reads the doors businesses publish for agents (§4.8 of the [network protocol](../protocol/network.md)): its
crawl reads every site it knows about once a month or so, and its own probes read the doors of members and claimed
listings every day. Until now it kept those reads for a short time: each probe for 90 days, a crawled site's dated
record for 13 months, and the latest copy of its files. A year on, nothing could say since when a business has had an
MCP server, or whether its inbox answered on the days it was checked. That kind of dated history cannot be rebuilt
later by anyone: a network that throws it away loses it, and a newcomer cannot buy it.

## Decision

1. **One line per door per day, kept for good.** For every door it reads, a network keeps one row a day with counts
   only: how many of its reads concluded something, how many answered, failed (by class, in the vocabulary of
   [`vocab/door-report-classes.json`](../../packages/spec/vocab/door-report-classes.json)) or were blocked; of its
   reads of the daily set, how many answered and failed; the median time its own reads took to get an answer; and the
   protocol version a crawl saw. Plus, per door, the first and last day a read found it answering. No page content,
   no address, no agent, no person. The raw reads keep their own shorter retention (90 days on our network).
2. **Only the network's own reads.** A read counts as the door state machine counts it (§4.8): a probe's answer,
   failure or blocked read; a crawl's answer, and its failure where the crawl decides; a public check's answer, never
   its failure. A read thrown away because its control read failed, or never answered, is no read. Nothing an agent
   reports enters the history: door reports stay private to the business and only make the network look again
   ([ADR-019](019-door-reports.md) §2).
3. **What the public sees.** For each door type at each host of a business: the first and last day a read found it
   answering, and whether a door of that type is there now. For a door the network reads every day (a member's, a
   claimed listing's: they asked to be listed), its daily checks: a day is checked when a read of the daily set
   concluded, and answered only when every one of them that day answered, so a failure and an answer fifteen minutes
   later is a day missed. From 14\* checked days the share of days answered shows, floored to the whole percent (99%
   for 199 of 200, never 100% with a day missed), with the days themselves and the last 90 days as a line: "Answered
   97% of daily checks since 3 Oct 2026 (41 of 42 days)." Below 14 days nothing is said, and no sentence says why.
   A door last checked more than 7\* days ago says "from … to …" instead of "since". Blocked reads, latency, read
   counts and failure classes stay private.
4. **Where.** A listing's detail (`GET /v1/businesses/{domain}`) and `get_business` carry `door_history` for the doors
   the listing shows; a site's current result (`/b/<domain>` and its JSON, `check_business`, once it is scored) for
   every door type at every host a read found answering. Omitted when there is nothing to say, and never on a result
   its owner hid.
5. **Not a rate of agents' reports.** What agents report never shows as a share, a rate or a count of uses: a business
   can report its own successes, so only failures from independent sources may ever go public (§4.15). This share
   comes from the network's own reads alone, which neither the business nor any agent can make.
6. **Retention.** For good, as receipts are ([ADR-017](017-reputation-and-ranking.md) §9). A site that opts out of the
   crawl has its whole history deleted at once, and again by a nightly pass should a restored copy bring it back. A
   found entry that leaves the directory after 180 days unchecked (§4.11) keeps its history, which shows again with
   the site's next result.
7. **What came before.** The history starts with the build that writes it. Once, a network rebuilds what it still
   holds from before: its own reads of the last 90 days, the day each stored door was first found and last found
   answering, and the crawl's dated record of each site. A day nothing survives for stays empty; nothing is filled in.

## Size

Measured on PostgreSQL 18 with rows shaped like ours: a day row is about 96 bytes with its index, a door row about
280. At today's 55,000 doors read about monthly, plus the daily set, that is about 2,000 day rows a day, some 70 MB a
year; ten times the doors, about 0.7 GB a year. Reading one door read daily for ten years takes about 2 ms.

## Open: a sole trader's data

- **Legitimate interest.** A business's domain and its door's dates can be personal data of a sole trader who runs it.
  The assessment weighs keeping counts and dates for good (no content, no person) against the interest of agents and
  their people in knowing whether a business's door has worked, with opting out as the way to erase it at once.
- **A question for counsel.** Is a door's dated history, kept for good and shown with a business's listing, personal
  data of a sole trader; if so, is legitimate interest the right basis, and is the crawler's notice (`/bot`) enough
  information for them?

## Consequences

- The protocol's §4.8 gains "History", §4.10 the `door_history` member, and §4.11 the exception to its 180 days.
- `packages/spec` holds the schema (`doorHistorySchema`), a reference function (`doorHistoryOf`) and
  [`vectors/door-history.json`](../../packages/spec/vectors/door-history.json), written by an implementation of its
  own; a network that shows a door's history is held to them.
- The crawler's notice and the privacy page say what is kept and for how long.
