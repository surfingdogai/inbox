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
   never a key, and a platform's origin only when 5 or more distinct sources from it reported in the
   period. A business cannot single out an agent, or the person behind it, to retaliate against.
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
