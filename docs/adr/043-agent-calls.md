# ADR-043 — The record of agents' calls

**Status:** accepted, 31 October 2026. The decisions are the founder's. It covers our network at
`network.surfingdog.ai`. It adds nothing to the network rules (ADR-017): it changes no order and no
answer, which stays the same for everyone.

## Context

Search is for AI agents first: most of its callers are assistants, over MCP, A2A and the REST API.
To see which searches find nothing, which tools agents call, which clients come and how fast the
answers are, the network has to keep something of each call. A search's words are what show where
search fails. Who sent it is never needed, and is never kept.

## Decision

1. **Every call an agent makes to the directory's doors is one record.** The doors are the MCP
   server (`/mcp`, `/mcp/search`), A2A (`/a2a`), the REST reads (`GET /v1/businesses`,
   `GET /v1/businesses/{domain}`, `GET /v1/products`, `GET /v1/products/gtin/{gtin}/offers`,
   `GET /v1/categories`, `GET /v1/attributes`) and `POST /v1/door-reports`. A browser on a page (the
   site's own search and directory) is a person, not an agent, and is not recorded; nor is a search
   engine's, a link preview's or an SEO tool's crawler (Googlebot, Bingbot and the like).
2. **What a record keeps.** When the call came, which door, which tool or method, how long it took
   and how it ended (answered, or the kind of failure); the kind of client (Claude, ChatGPT, Cursor,
   Gemini, Copilot, another by its product name, or unknown) and its version, as the client names
   itself, kept only when it is shaped like a version; and the AI platform whose published addresses
   the call came from, if any. For a search, also: its words (3); the language and category it
   filtered by; the place the network read in it
   (a town or a country; for a point, only that it was one, never its coordinates); what it asked to
   do, such as book or order; how many businesses it found, in which order, and whether on its first
   page.
3. **A search's words, as typed, with what names or pays someone taken out.** The words are kept as
   the agent typed them, capitals included: street names, house numbers, postcodes, prices, dates,
   years and links stay. Taken out, each replaced by a token:
   - an email address: `[email]`;
   - a phone number, written with its country (`+351 912 345 678`, `00351 912 345 678`) or its area in
     brackets (`(212) 555-0123`), or 9 to 15 digits whole or in groups split one way throughout
     (`912 345 678`, `555-123-4567`, `912/345/678`) or by spaces and then one other way
     (`212 555-0123`), or four pairs (`12 34 56 78`): `[phone]`;
   - a card number, 13 to 19 digits that pass the Luhn check, however its groups are split: `[card]`;
   - an IBAN, whole, in groups or split by dots, dashes or slashes, valid or mistyped, also right after
     a label in the same word (`IBAN:GB82…`): `[iban]`;
   - any other run of 8 or more digits in a row (outside a decimal, and also when joined to a word, as
     in `tel912345678`), or of 16 or more in groups: `[number]`.

   Groups of digits may be split by spaces, dots, any dash, slashes, underscores or commas; a comma
   never joins a phone, only a card or a number of 16 digits or more. A number of 7 digits or fewer
   stays, unless a `+` country code leads it (`25`, `2026`, `1100-148` stay; `+1 555 0199` is a
   phone), and so do a date (`31/10/2026`, `2026-10-31`), a decimal, a ZIP+4, a house number before a
   postcode (`25 1100-148`), a list of years, and fewer than 8 digits joined to a letter (`221B`,
   `SW1A 1AA`). Full-width and small forms (`＠`, `﹫`, `４`) are read as the characters they stand
   for, and invisible characters are removed first, so none can hide a number or an address. At most
   200 characters are kept. A name or a home address typed into a search stays in its words.
4. **Never who sent it.** No IP address, no session id, no full user agent, no key, and no other
   argument of a tool. To count distinct callers, a record keeps an HMAC of the caller's network, its
   IPv4 /24 or IPv6 /48, under the day's key, and a random name of that key. The key is 32 bytes
   drawn at random for each UTC day, held only in the network's memory, never written (so no backup
   holds it) and never derived from another secret, and wiped when the day ends. Once it is gone, no
   one, us included, can try every network against a stored hash, and no caller can be followed from
   one day to the next. A restart draws a new key: on that day a caller seen on both sides of the
   restart counts once for each key, and the report says how many keys each day had. Which client a
   session's `initialize` named is held in memory for a day at most, to name the client of a later
   call on that session, and never written.
5. **Kept without a time limit.** Nothing deletes a record.
6. **Our own traffic is marked.** Calls from our own machines, the uptime monitor, our crawler, our
   tests and evaluation runs (which send a `Surfingdog-Own` header), and calls that carry our admin or
   operations token are kept, flagged as ours, and left out of every count unless we ask for our own.
   Anyone can send the header: it only moves their own calls out of the counts.
7. **Read by asking, with no page.** An admin endpoint, behind our admin token, gives the calls per day
   and door, the distinct callers per day and how many keys hashed them, the calls by tool, client and
   platform, the top searches, the searches that found nothing, the slow calls and the failures. No
   page shows the record.
8. **It never slows or fails a call.** Records are written in batches beside the requests; when the
   writer falls behind, records are dropped and counted, never the call. A clean stop writes what is
   still waiting.

## Consequences

- The privacy page says what is kept, what never is, and that it is kept without a time limit.
- ADR-017 A2.7, part of the published network rules, says of an assistant's search that the network
  keeps none of it. A change to the rules' text is made as ADR-017 §11 says; this ADR is what our
  network keeps.

## Still open

- A search's words can name a person. There is no tool yet to erase one record.
