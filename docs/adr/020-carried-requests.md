# ADR-020 — Carried requests: a network carries a person's request to the business's own inbox

**Status:** accepted, 15 October 2026; built 18 October 2026. Research, not legal advice: who is the
controller of a carried request's personal data (the email address, while it is carried) is a
question for counsel before the first business outside our own is carried to.

## Context

A person asks their AI assistant to ask a business something, get a price, or book a time. The
assistant finds the business in a network's directory (§4.3, §4.7). Until now it then had to connect to
the business's own door itself: its inbox's MCP server or API. Many assistants can only use the servers
their person added as connectors, so in practice the assistant could find the business and not reach it.

The network is one connector most people would add once. It could carry the request to the business's
inbox for them. That puts the network in a place it has always said it is not: between a customer and a
business. ADR-008 and the site say the inbox is the business's own and the network is never in the
middle. A carried request has to keep the substance of that promise, and say plainly where it changes.

## Decision

1. **The promise, in these words.** *"Surfing Dog never touches the money and never keeps what anyone
   writes. When a business allows it, we carry an assistant's request to the business's own inbox and
   keep only a record that it was delivered."* Every page that describes carried requests says it this
   way.
2. **On by default, for every inbox.** Hosted and self-hosted alike, an inbox accepts carried requests
   unless its owner switches them off (`settings.carried.accepted`). The manifest says so only when off
   (`carried_requests: {"accepted": false}`), and every network leaves the inbox be. The inbox's own
   doors, rules and limits apply to a carried request exactly as to any agent's.
3. **One MCP address.** The carrying tools are on the network's one `/mcp`, beside search; `/mcp/search`
   answers the same, for directories that list it by that name. The inbox's owner door (`/mcp/owner`)
   stays where it is, on the inbox.
4. **Three tools, and only what the person asked for.** `ask_business`, `request_quote` and
   `request_booking`. Their descriptions say they are for when the person asked to contact the
   business; no description or answer asks the model to call anything on its own.
5. **Anonymous, with limits.** No sign-in is needed. Limits count the person where the network can tell
   them apart (a directory key, then a session it signed, then the address), per person and business,
   per wider network (an assistant platform's published outbound range counts as one, widely), per email
   address, per business hourly and daily, and the same words to at most three businesses an hour.
   OAuth only where a directory requires it.
6. **Only to an inbox.** A request goes only to a business in the directory whose inbox publishes a
   manifest on its own domain (or one short label under it), through that inbox's public API. Carrying
   to a business without an inbox comes later, if ever, and then only to a business that claimed its
   listing and opted in.
7. **An email address, never a phone number.** The person's contact is the email address they agreed
   to give the business (`consent: true`), and a name if they give one. A phone number is refused in the
   contact and in the words.
8. **Only the verified owner sees what assistants tried.** The network keeps one record per attempt
   (when, which business, which kind, the outcome, the inbox's status code: no sender, no contact, no
   words, no item id), for 400 days. A member's inbox alone is told the last 30 days' counts, in the
   answer to its signed ping, and shows them to its owner: "Assistants tried to reach you through it".
9. **The platform is told nothing about the person.** The answer is the inbox's own item, words and
   access token; never the person's address, the inbox's identity block or the party. Nothing the
   assistant carries for its person (a pass, a key) is forwarded.
10. **No list of a person's requests.** The network keeps none, so it cannot show one. The person's
    request is at the business's inbox, readable with the access token the inbox gave once.
11. **The directories' review rules.** Every tool says all four annotations. The door-report hint
    (`report`) stays in REST and A2A answers and leaves the MCP tools' answers, and `report_door`'s
    description says what it records, not that it must be called. The network serves
    `/.well-known/openai-apps-challenge` when it is given a token, and 404 otherwise.

## Consequences

- The network now handles an email address and a request's words for the second it takes to carry
  them. It writes neither anywhere: not to its database, not to its logs. The limits keep keyed hashes
  in memory, for at most a day.
- A business that switched carried requests off still gets the same agents at its own doors; the
  switch is only about the network carrying.
- An inbox sees a carried request as any anonymous agent's request, from the network's address. Its own
  per-address limits then hold for every carried request together, which suits a small business; a
  network that signs its requests (Web Bot Auth) could be told apart later.
- The protocol gains §4.16, the tools' schemas (`schemas/mcp-ask-business-*.json`,
  `mcp-request-quote-*`, `mcp-request-booking-*`), the manifest's `carried_requests` and the signed
  ping's `carried`.
