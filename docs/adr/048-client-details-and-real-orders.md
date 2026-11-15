# ADR-048 — A new request carries its client, is a kind the business takes, and orders what it sells

**Status:** accepted, 15 November 2026. Amends ADR-018 §3.2 (Q5) for an assistant's order, ADR-025 decision 7 and
ADR-017 R26 step 3; extends ADR-044 §2 from times to kinds. Spec 0.18. No migration, no setting.

## Context

An assistant, through an inbox's public MCP door, made a message, an order and a request for a price in two
seconds, each saying only "audit-fixturex", with no name, no email and no phone. The order was for a product the
business does not sell, at a price and in a currency the sender chose (1 AUD; the business prices in EUR), and the
business listed no orders among its item types. The inbox took all three and emailed the owner about each. The
inbox is there to bring a business proper bookings; a request nobody can answer, for something the business does
not sell, is the opposite.

## Decisions

The founder's, 15 November 2026:

1. **A new request carries its client.** An assistant's, or any API client's, new booking, order, request for a
   price, message or stay carries the person's name and an email address or a phone number. Without them it is
   refused, saying exactly what to add, so the assistant asks its person, with their agreement, and tries again.
2. **Only what the business takes.** An assistant's request of a kind the business does not list in `item_types` is
   refused, naming what it takes; the MCP tools for a kind it does not take are not listed.
3. **Orders are for what the business sells.** Each line names a product it sells, priced `fixed`; a price or total
   the request carries is its own, in its currency, unless it takes a price of the customer's own.

## How

- **Who.** `customer_agent` callers on every public door (REST, MCP, stays, UCP), signed or not, with an agent key
  or none, carried by a network or not: `Surfing-Dog-Carried` grants nothing. A person by email, on a form on the
  business's website or on its own page is never refused for this: their address, or the business's own form, is
  how it answers them, and an email whose display name is an address keeps no name. The business's own page asks
  for a name and an email, and holds them to the shape below, saying which one is wrong. The business writes down
  what it knows (the owner, staff, its AI, its keys, a connector, a rule, the system), on these doors only with a
  key or an AI app that may write items (`inbox:write`): a narrower one, a website's forms key or a read-only key,
  is refused outside its scopes (`403 not_allowed`, `details.reason` `outside_scopes`), the forms key whatever the
  owner set, as on every follow-up door. What the business's keys send is held to the shape the doors always held it
  to (a name of at most 200 characters, an email address, a phone of at most 40), in the same words. A follow-up
  belongs to an item that has its client (a reply, details asked for, an answer to an offer, a cancellation, a
  withdrawal, a return, the order or booking an accepted quote makes). A retry of a request already written is
  answered as it was.
- **What counts.** A name: trimmed, 1 to 200 characters, a letter you can see (a name of fillers such as U+3164 is
  none), no `@`. An email address the networks' normalisation takes, with a dot in its domain, at most 254
  characters. A phone: 6 to 20 digits, no letters, nothing else but spaces, `+`, dashes, brackets, dots and slashes,
  at most 40 characters. A name, and an email or a phone; sent but wrong, each is refused. On a request that is not
  a test, a placeholder is refused too: a name that stands for none, a form's label or a test's filler (N/A, null,
  Test, Your name, `{{customer_name}}`, a link, `audit-fixturex`), an address at a domain no mail reaches (`.invalid`,
  `.test`, `.localhost`, `.local`, `.internal` and the like) or a no-reply mailbox, a number of one digit over and
  over or the digits counted up or down (000000, 123456). The documentation names (example.com, example.net,
  example.org, `.example`) are taken: they are how the guides and the tests name a client. A test item (`x-sandbox:
  1`) emails nobody, so it may name a made-up client. Judged and stored trimmed, so a retry with other spaces is
  the same request.
- **Refusals.** `422 invalid_input`, `details.reason` `client_details`, with `details.missing` (`name`,
  `email_or_phone`), `details.invalid` (`name`, `email`, `phone`) and `fields`; `403 not_allowed`,
  `details.reason` `<kind>_not_offered`, with `details.item_types`; for orders `422 product_missing`,
  `unknown_product`, `not_on_sale`, `not_priced`, `currency_not_ours`, `price_not_ours`, `total_not_ours`; for
  bookings `422 currency_not_ours` (a total in another currency than the service's) and `price_not_ours` (a total
  for a service priced from, or with no price, while the business takes no price of the customer's own: it would
  otherwise be stored as the booking's). A different total for a fixed-price service is still only noted. Each
  comes before the confirm step, before files are kept and before any network is asked, and writes nothing. Checked
  early in each create (`requireClient`, `refuseNotOffered`, `checkOrderLines`, `checkBookingPrice`), and all of
  them again where every create of a person goes (`IdentityCapabilities.create`), after its own replay lookup: a
  door whose early lookup found a retry whose key has since been pruned writes nothing they would refuse.
- **Schemas.** `contact` and its `name` are listed as required in the JSON Schema (the MCP tool list,
  `/openapi.json`), with each detail's format and length, and read as sent: nothing about the contact is refused by
  a schema, so every door answers in the client rule's words; no `anyOf`, which some clients cannot take. The MCP
  tools' text names each detail's need in full, so a phone is asked for as readily as an email. An order's line names and prices and its total may be left to the catalogue: a customer's order is first
  read with them optional, and what is stored is read again strictly. `order` is offered only with an active
  product priced `fixed`; the setup plan predicts the same.
- **Tools.** The public MCP lists a create tool only for a kind in `item_types`: `create_order` and
  `quote_shipping` for orders, `check_availability` and `create_booking` for bookings, `request_quote`,
  `request_stay` and `hold_stay` for stays. A place to stay keeps the tools that read (`get_property`,
  `check_stay_availability`, `quote_stay`) and those that follow a stay already made (`book_stay`, `change_stay`)
  wherever it takes its stays: taken at its own booking engine, what is free comes with that page for the dates
  (ADR-037 §6.4). `send_message` is always listed, since it carries the replies, and says it only replies while new
  messages are off. The server's instructions say what to bring before anything new, and where a kind taken elsewhere goes.
  REST keeps every route: the business's keys use them.

## What this changes

- ADR-018 §3.2, Q5: "nothing is refused" holds for the business's own writes and the owner's AI. An assistant's
  order line naming no product, or a product priced from, as a range or on request, is refused, and so is a price
  not the business's while price counters (Q1) are off; with them on it is the customer's offer, as before.
- ADR-025, decision 7: the person's contact is their name and the email address they agreed to give.
- ADR-017 R26, step 3: the person's details are required: a name, and an email or a phone.
- ADR-044 §2: a kind the business does not take is refused as a time it does not offer is.
- ADR-029 decision 7 stands: orders are still made at the business's own door.

## Consequences

Assistants ask their person for a name and an email or a phone before anything new; a phone-only client is answered
by phone, with no email and no network key. A network must carry the person's name (spec 0.18), or its request comes
back refused. A hidden tool answers "not found"; the server's instructions name where a kind taken elsewhere goes.
The demo asks testers' assistants for details too, and still writes to nobody.
