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

1. **One line per door per day, kept for good.** For every door type the history may show (any type of
   [`vocab/doors.json`](../../packages/spec/vocab/doors.json) and a platform's door; never `llms.txt`, an experimental
   type or a page, which the public never sees, so nothing is kept of them), a network keeps one row a day with counts
   only: how many of its reads concluded something, how many answered, failed (by class, in the vocabulary of
   [`vocab/door-report-classes.json`](../../packages/spec/vocab/door-report-classes.json)) or were blocked; of its
   daily checks, how many answered and how many were missed; the median time its own reads took to get an answer; and
   the protocol version a crawl saw, when it looks like a version (words a site wrote are never kept). Plus, per door,
   the first and last day a read found it answering. No page content, no address, no agent, no person. The raw reads
   keep their own shorter retention (90 days on our network).
2. **Only the network's own reads, and only its own timing for checks.** A read counts as the door state machine
   counts it (§4.8): a probe's answer, failure or blocked read; a crawl's answer, and its failure where the crawl
   decides; a public check's answer, never its failure. A read thrown away because its control read failed, or never
   answered, is no read. Nothing an agent reports enters the history: door reports stay private to the business and
   only make the network look again ([ADR-019](019-door-reports.md) §2). A read a report asks for is a read of the
   door like any other, but it is **never a daily check**: a daily check is the network's scheduled daily read and
   only that (a read that was also the daily read then due counts, whatever else asked for it). A confirm read the
   crawl, an agent's report or the business asked for, and a recovery read after a failed one, are not checks. So
   someone who knows when a door is down for maintenance cannot time reports, or the reads that follow them, to make
   its days missed: a report only ever makes the network look again.
3. **What the public sees.** For each door type at each host of a business: the first and last day a read found it
   answering, on how many days, and whether a door of that type is there now. A door the crawl reads about once a
   month says so by its count ("Seen answering on 3 days from 16 Aug 2026 to 24 Sep 2026"), never as if it had
   answered every day between. For a door the network reads every day (a member's, a claimed listing's: they asked to
   be listed), its daily checks: a check is missed when it failed, or when it was blocked while the door is down by
   the network's reads (at least three reads blocked in a row over at least 48 hours, the rule our published rules
   already use to count a member's inbox down); a day is checked
   when a check concluded, and answered only when none of that day's was missed, so a failure and an answer fifteen
   minutes later is a day missed. From 14\* checked days the share of days answered shows, floored to the whole
   percent (99% for 199 of 200, never 100% with a day missed), with the days themselves and the last 90 days as a
   line: "Answered every check on 97% of days checked since 3 Oct 2026 (41 of 42)." Below 14 days nothing is said,
   and no sentence says why. A door last checked more than 7\* days ago says "from … to …" instead of "since". Other
   blocked reads, latency, read counts and failure classes stay private. An off-site door the crawl could not tie to
   the site is never shown.
4. **Where.** A listing's detail (`GET /v1/businesses/{domain}`) and `get_business` carry `door_history` for the doors
   the listing shows; a site's current result (`/b/<domain>` and its JSON, `check_business`, once it is scored) for
   every door type at every host a read found answering. Omitted when there is nothing to say, and never on a result
   its owner hid. The result page leaves the section out while it would say nothing its doors do not (every door seen
   on one day, still there, with no checks).
5. **Not a rate of agents' reports.** What agents report never shows as a share, a rate or a count of uses: a business
   can report its own successes, so only failures from independent sources may ever go public (§4.15). This share
   comes from the network's own scheduled reads alone, whose time neither the business nor any agent can choose.
6. **Retention.** For good, as receipts are ([ADR-017](017-reputation-and-ranking.md) §9). A site that opts out of the
   crawl has its whole history deleted at once, nothing is written for it after (not even by a read in flight when it
   opted out), and a nightly pass deletes it again should a restored copy bring it back. A found entry that leaves the
   directory after 180 days unchecked (§4.11) keeps its history, which shows again with the site's next result.
7. **What came before.** The history starts with the build that writes it. Once, a network rebuilds what it still
   holds from before: its own reads of the last 90 days (a daily check only by its kind, since which reads were also
   the daily read was not stored before), and the day each stored door was first found and last found answering. A
   crawl's dated record of a site is not used: it says a document was fetched, not that the door answered. A day
   nothing survives for stays empty; nothing is filled in.

## Size

Measured on PostgreSQL 18 with rows shaped like ours: a day row is about 96 bytes with its index, a door row about
280. Of the 57,500 doors our network stores, about 31,000 are of the types kept; llms.txt files, booking platforms'
pages and WebMCP are the rest. Read about monthly, plus the daily set, that is about 1,000 day rows a day, some 35 MB
a year; ten times the doors, about 0.4 GB a year. The rebuild of what came before writes about 31,000 doors and
31,000 day rows (some 12 MB). Reading one door read daily for ten years takes about 2 ms. A door's row is moved, not
made again, by each read, so its numbering never runs out however often doors are read.

## Open: a sole trader's data

- **Legitimate interest.** A business's domain and its door's dates can be personal data of a sole trader who runs it.
  The assessment weighs keeping counts and dates for good (no content, no person) against the interest of agents and
  their people in knowing whether a business's door has worked, with opting out as the way to erase it at once.
- **A question for counsel.** Is a door's dated history, kept for good and shown with a business's listing, personal
  data of a sole trader; if so, is legitimate interest the right basis, and is the crawler's notice (`/bot`) enough
  information for them?

## Consequences

- The protocol's §4.8 gains "History", §4.10 the `door_history` member, and §4.11 the exception to its 180 days.
- `packages/spec` 0.4.1 holds the schema (`doorHistorySchema`), a reference function (`doorHistoryOf`) and
  [`vectors/door-history.json`](../../packages/spec/vectors/door-history.json), written by
  [`scripts/gen-door-history-vectors.py`](../../packages/spec/scripts/gen-door-history-vectors.py), an implementation
  of its own; a network that shows a door's history is held to their numbers and `checks`, and words its `summary`
  its own way.
- The crawler's notice and the privacy page say what is kept and for how long.
