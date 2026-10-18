# ADR-022 — Owners in control, and inboxes found from the domain

**Status:** proposed, 18 October 2026. Built behind no switch; nothing is deployed, and nothing is
submitted to any directory, registry or provider.

## Context

A business's page on a network (`/b/<domain>`) said "claim or correct it from your AI": an owner
without an AI could not claim it, correct what it said, or hide it. And an inbox that answers at
`inbox.<domain>` is invisible to an agent that knows only `<domain>`: ADR-002 named the pointers
(a `<link rel>`, `llms.txt`, DNS) but nothing wrote them for a business, checked them, or told the
owner which were missing.

## Decision

1. **The owner's page.** A network offers `/b/<domain>/owner`, with no AI and no account: prove the
   domain by a TXT record at `_surfingdog-claim.<domain>`, or by a code to an address at the domain:
   a role address (`info@`, `hello@`…) or one the site's own homepage publishes (a `mailto:` link, a
   schema.org `email`), picked, never typed, so a code only ever goes to an address the business
   reads (a typed name waits for the founder's decision). The address that holds a listing's code
   claim can always be sent a code again, so its owner comes back on another day. Then: correct what
   the listing says, or hide it with one control (the result page out: no score, no rank, `noindex`,
   out of every list; and the listing out of the directory, where the proof allows it), or show both
   again. It is the same claim as `register_business` and `update_business`, with every precedence
   rule of §4.12: a weaker proof never takes over a stronger claim (and takes nothing of the earlier
   claimant's with it: its declaration and its doors go), a code never takes a listing found on the
   site out of the directory, and a fresh proof revokes the weaker tokens and the sessions on them.
   Nothing done on the page lifts a site's own request not to be read: that is its own control,
   "Read it again". The proof is kept for twelve hours in a sealed cookie of the network's host alone
   (AES-GCM: its token cannot be read from it); with a listing it is the listing's claim token, shown
   once for the owner's own AI, and a proof alone (a domain with no listing) ends once a listing is
   built.
2. **Corrections are kept, and shown as the business's.** Every correction, from the page or the
   tools, is kept field by field with what was declared or shown before, what it is now, the
   proof's label, who made it (a keyed hash of the claim) and where it came from; the owner's page
   lists them, and says which were made before the current claim. Every fact a listing shows that the
   business said itself carries `via: "business"`, and the result page says when the business last
   said them, marking only the facts read on the site. A listing removed takes its corrections with
   it.
3. **Five ways from the domain to the inbox,** written the same everywhere
   (`vectors/discovery.json`): the domain's own `/.well-known/agent-inbox.json` (a copy of the
   inbox's manifest, or a redirect to it), a line in `llms.txt`, `<link rel="agent-inbox">` (or an
   HTTP `Link` field), a schema.org `potentialAction`, and ADR-002's `_agent-inbox` TXT record. The
   owner app (Settings → Be found), a hosted inbox's Connect page and the WordPress plugin give the
   lines and say the same words (`vectors/discovery-words.json`): where the website is first (picked
   from what the check read), that platform's steps with only the lines it needs, the DNS record
   folded, an email for whoever runs the site, then what the check found. The steps were written from
   the platforms' help pages and have not been walked through in their panels yet; the plugin is not
   downloadable yet, so no step tells an owner to install it. The crawler reads `rel="agent-inbox"`
   as it reads `rel="mcp"`.
4. **A check, asked for.** `GET /v1/discovery/{domain}` (and the MCP tool `check_dns`) says whether
   the inbox's DNS record and manifest answer, whether robots.txt keeps out an AI assistant that
   fetches for a person, and which ways are in place, with the exact fix for each that is not.
   **Ready needs one way on the website**: the DNS pointer alone is state `dns_only`, since few
   agents read it yet, and none of these ways is read by every assistant today: they are open
   conventions, and the words never claim more. It reads as a browser would, never what robots.txt
   keeps its reader off, and nothing at all while robots.txt answers 5xx or 429 or does not answer
   (RFC 9309); it keeps nothing, and what it read is kept a minute, by domain and by host, with a
   site read at most twelve times a minute whoever asks. It never says, in public, whether a host is
   a hosted inbox's. An inbox reads its answer leniently, so a network can grow before inboxes are
   upgraded. The owner app and the plugin ask it only when the owner presses Check. Keeping out
   training crawlers is the owner's choice and never a finding.
5. **`start_inbox`** gives a business's AI the link where the owner sets up a hosted inbox: the link
   carries the domain and nothing else, and the tool never signs anyone up or takes an email.
6. **One-click DNS** (Domain Connect) is prepared, not submitted: one template adds the inbox's CNAME
   and the `_agent-inbox` record, with signed requests. Submitting it, and the WordPress plugin to
   wordpress.org, is the founder's.
7. **The WordPress plugin** publishes nothing until the address is saved and the inbox answers there
   with its manifest; it fetches the copy in the background (WP-Cron, and when the address is saved),
   never while a visitor waits, and answers `/llms.txt` and `/.well-known/agent-inbox.json` only when
   nothing else on the site does.

## Consequences

The result page's owner block links to the owner's page; `/b/<domain>.json` carries `owner.manage`.
A business without an AI can now do everything its AI could, and a self-hosted inbox can be found the
same way a hosted one is. The check is a network's MAY (§4.14a): another network need not offer it.
