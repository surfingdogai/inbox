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
   type, a door a generic adapter found or a page, which the public never sees, so nothing is kept of them), a network
   keeps one row a day with counts only: how many of its reads concluded something, how many answered, failed (by
   class, in the vocabulary of [`vocab/door-report-classes.json`](../../packages/spec/vocab/door-report-classes.json))
   or were blocked; of its daily checks, how many answered, were missed and were refused; the median time its own reads
   took to get an answer; and the protocol version a crawl saw, when it has the shape of one (a date, or up to four
   dotted numbers: words a site wrote are never kept). Plus, per door, the first and last day a read found it
   answering. A door is kept by its URL without the query or fragment, so a key a site put in its URL is never kept,
   and a site has at most 64 doors (the most any site has today is 13), so one that names a new URL at every read
   cannot grow its rows. No page content, no agent, nothing a customer wrote; of a person, at most what a sole
   trader's own web addresses say (below). The raw reads keep their own shorter retention (90 days on our network).
2. **Only the network's own reads, and only its own timing for checks.** A read counts as the door state machine
   counts it (§4.8): a probe's answer, failure or blocked read; a crawl's answer, and its failure where the crawl
   decides; a public check's answer, never its failure. A read thrown away because its control read failed, or never
   answered, is no read. Nothing an agent reports enters the history: door reports stay private to the business and
   only make the network look again ([ADR-019](019-door-reports.md) §2). A read a report asks for is a read of the
   door like any other, but it is **never a daily check**: a daily check is the network's scheduled daily read and
   only that (a read that was also the daily read then due counts, whatever else asked for it). A confirm read the
   crawl, an agent's report or the business asked for, and a recovery read after a failed one, are not checks. The
   daily read keeps its time of day: it is due a day after it was due, not after it was made, so a read a report asks
   for a few minutes before it (which holds it back by the network's ten minutes between reads of a door or a host)
   moves it neither that day nor the next. So someone who knows when a door is down for maintenance cannot time
   reports, or the reads that follow them, to make its days missed, nor walk its check into that window: a report only
   ever makes the network look again.
3. **What the public sees.** For each door type at each host of a business, the doors there now first: the first and
   last day a read found it answering, on how many days, and whether a door of that type is there now. A door the
   crawl reads about once a month says so by its count ("Seen answering on 3 days since 16 Aug 2026, last on 24 Sep
   2026"; for one not there now, "on 3 days from 9 Aug 2026 to 6 Oct 2026"), never as if it had answered every day
   between, nor as gone when it is not. The count is of every day a read of ours found it answering, including reads
   someone else asked for (a confirm read after a report, a public check): it says on how many days we saw it answer,
   not how often we looked, and since only answers count, choosing when we look can add true days and hide none. For
   a door the network reads every day (a member's, a claimed listing's: they asked to be listed), its daily checks: a
   check is missed when it failed, or when it was blocked while the door is down by the network's reads (at least
   three reads blocked in a row over at least 48 hours, the rule our published rules already use to count a member's
   inbox down), and refused when it was blocked otherwise (a 403, a 429, a challenge page). A day is checked when a
   check concluded; it is missed when one of its checks was missed, else refused when one was refused, else answered.
   So a failure and an answer fifteen minutes later is a day missed, and a site that refuses the network's read on
   its bad days only hides nothing: a refused day is never an answered one, and says why. From 14 checked days the
   share of days answered shows, floored to the whole percent (99% for 199 of 200, never 100% with a day missed or
   refused), with the days themselves and the last 90 days as a line: "Answered every check on 41 of 42 days checked
   since 3 Oct 2026 (97%)", or "… on 15 of 20 days checked since 29 Sep 2026 (75%; refused our check on 5)". The count
   comes first: on two weeks of days, a percentage alone would claim more than it knows. Below 14 days nothing is
   said, and no sentence says why. A door last checked more than 7\* days ago says "from … to …" instead of "since".
   14 and 90 are the protocol's numbers, held by the vectors; 7 is ours. Other blocked reads, latency, read counts and
   failure classes stay private. An off-site door the crawl could not tie to the site is never shown.
4. **Where.** A listing's detail (`GET /v1/businesses/{domain}`) and `get_business` carry `door_history` for the doors
   the listing shows; a site's current result (`/b/<domain>` and its JSON, `check_business`, once it is scored) for
   every door type at every host a read found answering. Omitted when there is nothing to say, and never on a result
   its owner hid. The result page leaves the section out while it would say nothing its doors do not (every door seen
   on one day, still there, with no checks).
5. **Not a rate of agents' reports.** What agents report never shows as a share, a rate or a count of uses: a business
   can report its own successes, so only failures from independent sources may ever go public (§4.15). This share
   comes from the network's own scheduled reads alone, whose time neither the business nor any agent can choose. Our
   network decided earlier that, before any platform is recognised, the public sees failures only and never a success
   rate; that was decided for agents' reports, and until the founder confirms it does not cover this share, our
   network writes and works out the share but leaves `checks` and `summary` out of what it shows: listings and
   results show the days each door was seen answering. Writing it cannot wait (a day not written is lost for good);
   showing it can.
6. **Retention.** For good, as receipts are ([ADR-017](017-reputation-and-ranking.md) §9). A site that opts out of the
   crawl has its whole history deleted at once, nothing is written for it after (not even by a read in flight when it
   opted out), and a nightly pass deletes it again should a restored copy bring it back. A found entry that leaves the
   directory after 180 days unchecked (§4.11) keeps its history, which shows again with the site's next result. A door
   no read ever found answering has nothing to show: it goes once neither the crawl nor the probes keep it and it has
   not been read for 30 days.
7. **What came before.** The history starts with the build that writes it. Once, a network rebuilds what it still
   holds from before: its own reads of the last 90 days (a daily check only by its kind, since which reads were also
   the daily read was not stored before; a daily check blocked is rebuilt as refused, since whether the door was down
   by our reads then was not stored, and either way the day is not answered), the day each stored door was first found
   (unless a read says the read that found it failed: the door's first failure is that moment, or the crawl's own read
   of it then failed), and the day it was last found answering. A crawl's dated record of a site is not used: it says
   a document was fetched, not that the door answered. A day nothing survives for stays empty; nothing is filled in.
   Until the rebuild has run, the reads it needs are kept past their 90 days, for a week at most, and our operators
   are told if it has not run an hour on.

## Size

Measured on PostgreSQL 18 with rows shaped like ours: a day row is about 96 bytes with its index, a door row about
280. On 18 October 2026 our network stored 94,804 doors of 567,082 sites; 52,516 are of the types kept (llms.txt
files, booking platforms' pages and WebMCP are the rest), 17 of them with a query in their URL, and no site had more
than 13. Read about monthly, plus the daily set, that is about 1,750 day rows a day in steady state, some 60 MB a
year; while a city's sites are crawled for the first time it was 7,000 to 12,300 a day (14 to 17 October), which
would be about 350 MB a year if it never stopped. Ten times the doors, about 0.6 GB a year in steady state. The
rebuild of what came before writes about 52,600 doors and 63,300 day rows (some 21 MB; a read-only count of it took
about 2 s), and no site reaches the cap.
Reading one door read daily for ten years takes about 2 ms. A door's row is moved, not made again, by each read, so
its numbering never runs out however often doors are read, and a site has at most 64.

## Open: a sole trader's data

- **Legitimate interest.** A business's domain and its door's dates can be personal data of a sole trader who runs it.
  The assessment weighs keeping counts and dates for good (no content, and of a person nothing beyond the site's own
  web addresses) against the interest of agents and their people in knowing whether a business's door has worked,
  with opting out as the way to erase it at once. The public notices say only that: they never claim the history
  names no person.
- **A question for counsel.** Is a door's dated history, kept for good and shown with a business's listing, personal
  data of a sole trader; if so, is legitimate interest the right basis, and is the crawler's notice (`/bot`) enough
  information for them?

## Consequences

- The protocol's §4.8 gains "History", §4.10 the `door_history` member, and §4.11 the exception to its 180 days.
- `packages/spec` 0.4.1 holds the schema (`doorHistorySchema`), a reference function (`doorHistoryOf`) and
  [`vectors/door-history.json`](../../packages/spec/vectors/door-history.json), written by
  [`scripts/gen-door-history-vectors.py`](../../packages/spec/scripts/gen-door-history-vectors.py), an implementation
  of its own; a network that shows a door's history is held to their numbers and `checks`, and words its `summary`
  its own way (the vectors mark it informative).
- The crawler's notice and the privacy page say what is kept and for how long.
