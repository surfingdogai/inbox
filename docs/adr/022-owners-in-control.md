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
   domain by a TXT record at `_surfingdog-claim.<domain>`, or by a code to an address at the domain
   (the owner picks the name before `@<domain>`; the domain is never typed, so a code never goes
   anywhere else). Then: correct what the listing says, hide the result page (no score, no rank,
   `noindex`, out of every list), take the listing out of the directory, or put it back. It is the
   same claim as `register_business` and `update_business`, with every precedence rule of §4.12: a
   weaker proof never takes over a stronger claim, a code never takes a listing found on the site
   out of the directory, and a fresh proof revokes the weaker tokens and the sessions on them. The
   proof is kept for twelve hours in a cookie of the network's host alone; with a listing it is the
   listing's claim token, shown once for the owner's own AI.
2. **Corrections are kept, and shown as the business's.** Every correction, from the page or the
   tools, is kept field by field with what was declared or shown before, what it is now, the
   proof's label and where it came from; the owner's page lists them. Every fact a listing shows
   that the business said itself carries `via: "business"`, and the result page says "from the
   business" beside it. A listing removed takes its corrections with it.
3. **Five ways from the domain to the inbox,** written the same everywhere
   (`vectors/discovery.json`): the domain's own `/.well-known/agent-inbox.json` (a copy of the
   inbox's manifest, or a redirect to it), a line in `llms.txt`, `<link rel="agent-inbox">` (or an
   HTTP `Link` field), a schema.org `potentialAction`, and ADR-002's `_agent-inbox` TXT record. The
   owner app (Settings → Be found), a hosted inbox's Connect page and the WordPress plugin give the
   lines, with the steps on WordPress, Shopify, Wix and Squarespace and an email for whoever runs the
   site. The crawler reads `rel="agent-inbox"` as it reads `rel="mcp"`.
4. **A check, asked for.** `GET /v1/discovery/{domain}` (and the MCP tool `check_dns`) says whether
   the inbox's DNS record and manifest answer, whether robots.txt keeps out an AI assistant that
   fetches for a person, and which ways are in place, with the exact fix for each that is not. It
   reads as a browser would, never what robots.txt keeps its reader off, and keeps nothing; an
   answer is kept a minute. The owner app and the plugin ask it only when the owner presses Check.
   Keeping out training crawlers is the owner's choice and never a finding.
5. **`start_inbox`** gives a business's AI the link where the owner sets up a hosted inbox: the link
   carries the domain and nothing else, and the tool never signs anyone up or takes an email.
6. **One-click DNS** (Domain Connect) is prepared, not submitted: one template adds the inbox's CNAME
   and the `_agent-inbox` record, with signed requests. Submitting it, and the WordPress plugin to
   wordpress.org, is the founder's.

## Consequences

The result page's owner block links to the owner's page; `/b/<domain>.json` carries `owner.manage`.
A business without an AI can now do everything its AI could, and a self-hosted inbox can be found the
same way a hosted one is. The check is a network's MAY (§4.14a): another network need not offer it.
