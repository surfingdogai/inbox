---
title: What an AI agent can do at a business
description: "The capability vocabulary, version 2: what an AI agent can do at a business, what has to be seen before anyone says a business offers it, and how each kind of agent door carries it."
---

<!-- Written from packages/spec/vocab/capabilities.json by apps/site/src/lib/spec-capabilities.ts. Edit the JSON, then run UPDATE_SPEC_PAGES=1 pnpm vitest run apps/site/test/spec.node.test.ts. -->

**Version 2**, published 15 October 2026. As JSON: [the latest](/spec/capabilities.json) · [version 2](/spec/capabilities/v2.json) · [version 1](/spec/capabilities/v1.json) · [its JSON Schema](/spec/schemas/capabilities.json) · [how names are read, as vectors](/spec/vectors/capability-names.json). MIT licence.

The things an AI agent can do for a person at a business, from finding it to getting a refund. Each one has a definition, what has to be seen before anyone may say a business offers it, and how it is met through each kind of agent door. The ids never change: a capability is added, never renamed.

## How to read it {#how-to-read-it}

A capability is in one of four states at a business:

| State | Meaning |
| --- | --- |
| `yes` | An agent can do it through a door the business published. |
| `partial` | An agent can start it and a person has to finish it, it sits behind the customer's own account, or payment is only described. |
| `no` | Nothing the business published lets an agent do it. |
| `na` | It does not apply to this kind of business, like ordering at a dentist. |

How anyone knows, from weakest to strongest:

| Evidence | Meaning |
| --- | --- |
| `declared` | The business's own site or door says so: its structured data, its pages, its manifest or its registration, or a door that meets it by what its protocol implies. Nobody has carried it out. |
| `tested` | A network's own read of the door, signed as its crawler, saw the door answer and list it (a tool, a skill, an operation or a kind of item) in the 7 days before. A read lists what a door offers and does nothing else: nobody has carried it out. |
| `proven` | Someone other than the business carried it out and signed what happened: a receipt the customer's agent counter-signed, or the signed reports of agent platforms a network recognises. |

Unless a capability says otherwise below, its `tested` step is: A network's read of the door saw it answer and list it.

**Surfing Dog's network.** It gives `declared` and `tested` today, and its result pages lead with `message`, `book`, `order`, `signup`, `cancel`, `negotiate`. These are the network's choices, not part of what the capabilities mean.

## Doors {#doors}

A capability is met through a door an agent can use. Each kind of door is read by one thing:

<dl class="spec-doors">
<dt><a href="https://surfingdog.ai/spec/manifest/">Agent inbox</a> · read by item type</dt>
<dd>The manifest at /.well-known/agent-inbox.json lists the kinds of request the inbox takes (item_types). Each kind meets the capabilities it carries: a booking meets book, and changing, cancelling and following it.</dd>
<dt><a href="https://modelcontextprotocol.io">MCP server</a> · read by tool</dt>
<dd>A tool whose name says the action. A tool the server marks read-only, or one whose name only reads (get, list, search), meets only the capabilities that read.</dd>
<dt><a href="https://a2a-protocol.org">A2A agent</a> · read by skill</dt>
<dd>Any agent card can be sent a message. A skill whose name says the action meets that capability too.</dd>
<dt><a href="https://www.openapis.org">OpenAPI</a> · read by operation</dt>
<dd>An operation, by its method and path or its operationId. POST adds create, PUT and PATCH add update, DELETE adds delete. An operation by GET only reads.</dd>
<dt>REST API · read by endpoint</dt>
<dd>An endpoint the business documents for agents, read as an OpenAPI operation is.</dd>
<dt><a href="https://ucp.dev">UCP</a> · read by capability</dt>
<dd>The capabilities a UCP profile names, by the last part of each name (dev.ucp.shopping.checkout is checkout): checkout means orders, catalog means a catalogue and stock, order means following an order, return means returns, and payment handlers mean payment. A profile counts only on a site that shows it sells (products or offers with prices on its own pages, or a cart that works): a website platform that serves the same profile on every site it hosts gives none of these on its own.</dd>
<dt><a href="https://www.agenticcommerce.dev">ACP</a> · read by capability</dt>
<dd>Checkout means orders. Delegated payment (delegated_payment) means payment. A profile counts only on a site that shows it sells (products or offers with prices on its own pages, or a cart that works).</dd>
<dt><a href="https://github.com/webmachinelearning/webmcp">WebMCP</a> (experimental) · read by tool</dt>
<dd>A tool a web page registers for the browser's agent, read as an MCP tool is. Experimental: it counts toward a score and never toward a readiness level.</dd>
</dl>

An email address, a phone number, a text or chat-app link, a web form or a page written for people never meets a capability. A person can use them; an agent cannot rely on them.

A tool, skill or operation name is split into words (create_booking and createBooking are the same two words). The action and its object must both be there, each in its own word: book alone, or create with booking. Words that name something else rule it out: a tool that cancels a cart is not cancelling an order. A name that says it reads documentation (doc, docs, documentation, readme) meets no capability.

## Before {#journey-before}

### Find {#find}

`find` · also about, hours, location, profile

*Can an agent read who the business is, its opening hours and where it is?*

Read who the business is, where it is or which area it serves, and when it is open, as data.

**Partial:** Only part of it is data, such as a name and an address with no hours.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | schema.org data on the business's own site (LocalBusiness or one of its types, with an address or opening hours), or a tool, skill or operation that reads the business's details. |
| `tested` | A network's read of the door saw it answer and list a tool, skill or operation that reads the business's details. |
| `proven` | Signed reports from agent platforms a network recognises, saying that such a read answered. |

Not enough:

- Hours or an address that are only in the text of a page, or in an image.

Through each kind of door, for example:

- MCP server: `get_business_profile`, `get_store_hours`
- A2A agent: `business-info`
- OpenAPI: `GET /business`, `getStoreInfo`
- REST API: `GET /location`

### Catalogue {#catalogue}

`catalogue` · also menu, products, services, price list

*Can an agent read its services, products or menu, with prices?*

Read what the business sells or offers, with prices: its products, its services or its menu.

**Partial:** Items without prices, or prices only behind the customer's account.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | schema.org Product, Offer, Menu or Service data with prices on the business's own site, a product feed, a UCP or ACP catalogue with items in it on a site that shows it sells (products or offers with prices on its own pages, or a cart that works), or a tool, skill or operation that lists products, services or a menu. |
| `tested` | A network's read of the door saw it answer and list a tool, skill or operation that lists them. |
| `proven` | Signed reports from agent platforms a network recognises, saying that such a listing answered. |

Not enough:

- A menu or price list that is only a PDF or an image.
- A commerce profile that names a catalogue and lists nothing the business sells.
- A commerce platform's profile that every site on that platform gets, on a site with no prices and no cart.

Through each kind of door, for example:

- MCP server: `list_services`, `list_products`, `search_products`, `get_menu`
- A2A agent: `product-search`
- OpenAPI: `GET /products`, `listServices`
- REST API: `GET /menu`
- UCP: `catalog`
- WebMCP: `search_products`

### Availability {#availability}

`availability` · also free slots, openings, stock

*Can an agent check free slots or stock?*

Check what is free before asking for it: open times for a booking, rooms or seats, or whether something is in stock.

**Partial:** Only behind the customer's own account.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | A tool, skill or operation that checks free times or stock, an agent inbox that takes bookings, or a UCP catalogue with stock on a site that shows it sells (products or offers with prices on its own pages, or a cart that works). |
| `proven` | Signed reports from agent platforms a network recognises, saying that a check answered with times or stock. |

Not enough:

- A calendar shown as a picture or a widget for people.
- A commerce platform's profile that every site on that platform gets, on a site with no prices and no cart.

Through each kind of door, for example:

- Agent inbox: `booking`
- MCP server: `check_availability`, `get_available_slots`
- A2A agent: `check-availability`
- OpenAPI: `GET /availability`, `getSlots`
- REST API: `GET /slots`
- UCP: `catalog`

### Message {#message}

`message` · also ask, contact, enquire · a directory's `accepts=ask`

*Can an agent send the business a message and get an answer?*

Send the business a question or a request in words and get an answer back through the same door, before buying or after it.

**Partial:** The message goes in and no answer can come back through the door.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | An agent inbox that takes messages, an A2A agent card, or a tool, skill or operation that sends the business a message or opens a support request. |
| `proven` | Signed reports from agent platforms a network recognises, saying that a message was taken, and the business's answer reached them. |

Not enough:

- An email address, a phone number, a chat-app link or a contact form for people.
- A chat widget that only a person in a browser can use.

Through each kind of door, for example:

- Agent inbox: `message`
- MCP server: `send_message`, `contact_business`, `create_support_ticket`
- A2A agent: `SendMessage (any agent card)`
- OpenAPI: `POST /messages`, `createInquiry`
- REST API: `POST /contact`

### Negotiate {#negotiate}

`negotiate` · also quote, offer, counter-offer, estimate · a directory's `accepts=quote`

*Can an agent ask for a quote, make an offer or get a counter-offer?*

Ask for a quote, and answer one: accept it, decline it or propose something else, such as another time or another price.

**Partial:** A quote can be asked for and the answer comes only by email or phone.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | An agent inbox that takes quote requests, or a tool, skill or operation that asks for a quote or answers an offer. |
| `proven` | Signed reports from agent platforms a network recognises, saying that a quote request was taken and answered. |

Not enough:

- A price calculator that only shows a number and takes no request.

Through each kind of door, for example:

- Agent inbox: `quote_request`
- MCP server: `request_quote`, `accept_offer`, `decline_offer`
- A2A agent: `request-quote`
- OpenAPI: `POST /quotes`, `createQuoteRequest`
- REST API: `POST /quote`

## Doing it {#journey-doing}

### Book {#book}

`book` · also reserve, appointment, schedule · a directory's `accepts=book`

*Can an agent make a booking, with its details?*

Make a booking for a person (a time, a table, a room, a seat or an appointment) with the details it needs, and get back that it is booked or requested, with a reference.

**Partial:** The agent can only fill in a booking that a person completes, or only behind the customer's own account.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | An agent inbox that takes bookings, or a tool, skill or operation that makes a booking. |
| `proven` | A signed receipt of a confirmed booking that the customer's agent counter-signed, or signed reports from agent platforms a network recognises, saying that a booking was made. |

Not enough:

- A booking page or a booking widget for people.
- A tool that only lists free times: that is availability.

Through each kind of door, for example:

- Agent inbox: `booking`
- MCP server: `create_booking`, `book_appointment`, `reserve_table`
- A2A agent: `book-table`
- OpenAPI: `POST /bookings`, `createReservation`
- REST API: `POST /appointments`
- WebMCP: `book_table`

### Order {#order}

`order` · also buy, purchase, checkout · a directory's `accepts=order`

*Can an agent place an order, with its options?*

Place an order for goods or food with its options and quantities, and get back that it is placed or accepted, with a reference.

**Partial:** The agent can fill a basket and hand a link to a person who completes the order.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | An agent inbox that takes orders, a UCP or ACP checkout, or a tool, skill or operation that places an order, together with something the business really sells: products or offers with prices on its own site, or a cart that works. |
| `proven` | A signed receipt of an accepted or paid order that the customer's agent counter-signed, or signed reports from agent platforms a network recognises, saying that an order was placed. |

Not enough:

- A commerce platform's profile that every site on that platform gets, on a site with no prices and no cart.
- A tool that changes, cancels or returns an order that exists: that is change, cancel or return.

Through each kind of door, for example:

- Agent inbox: `order`
- MCP server: `create_order`, `place_order`, `checkout`
- A2A agent: `place-order`
- OpenAPI: `POST /orders`, `createCheckout`
- REST API: `POST /cart/checkout`
- UCP: `checkout`
- ACP: `checkout`
- WebMCP: `add_to_cart`

### Sign up {#signup}

`signup` · also register, enrol, join, create account

*Can an agent sign the person up: an account, a membership, a class, a course or a newsletter list for the business's own service?*

Sign the person up for the business's own service: an account, a membership, a class, a course or a newsletter.

**Partial:** The agent can start a sign-up that a person finishes.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | A tool, skill or operation that signs a person up, or a schema.org RegisterAction or JoinAction. |
| `proven` | Signed reports from agent platforms a network recognises, saying that a sign-up went through. |

Not enough:

- Signing in, or anything that only logs a person in.
- Registering a tool, a webhook, a key or a device, or adding staff.

Through each kind of door, for example:

- MCP server: `sign_up`, `create_account`, `join_membership`
- A2A agent: `enrol-in-class`
- OpenAPI: `POST /register`, `registerCustomer`
- REST API: `POST /signup`

### Pay {#pay}

`pay` · also payment, pay online · a directory's `accepts=pay`

*Can an agent pay, and is it clear how payment happens?*

Pay for a booking or an order, or learn exactly how payment happens: on the spot, through a payment the agent can make, or through a link a person completes.

**Partial:** How to pay is described and a person has to pay.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | UCP payment handlers or ACP delegated payment on a site that shows it sells (products or offers with prices on its own pages, or a cart that works), or a tool, skill or operation that takes a payment. |
| `proven` | A signed receipt of a paid order or booking that the customer's agent counter-signed. |

Not enough:

- Card logos or a payment page for people.
- A commerce platform's profile that every site on that platform gets, on a site with no prices and no cart.

Through each kind of door, for example:

- MCP server: `pay_order`, `create_payment`
- A2A agent: `pay-invoice`
- OpenAPI: `POST /payments`, `completeCheckout`
- REST API: `POST /pay`
- UCP: `payment_handlers`
- ACP: `delegated_payment`

## After {#journey-after}

### Change {#change}

`change` · also reschedule, modify, amend

*Can an agent change a booking or an order?*

Change a booking or an order that exists: another time, another size, another address. A request to change that comes back with a reference the agent can follow counts the same as a change made at once.

**Partial:** Only behind the customer's own account.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | An agent inbox that takes bookings or orders, or a tool, skill or operation that changes or reschedules one. |
| `proven` | A signed receipt of an agreed change (an amended receipt), or signed reports from agent platforms a network recognises, saying that a change went through. |

Not enough:

- Changing a cart before it is an order.

Through each kind of door, for example:

- Agent inbox: `booking`, `order`
- MCP server: `reschedule_booking`, `update_order`
- A2A agent: `reschedule`
- OpenAPI: `PATCH /bookings/{id}`, `modifyOrder`
- REST API: `PUT /orders/{id}`

### Cancel {#cancel}

`cancel` · also call off, void

*Can an agent cancel a booking or an order?*

Cancel a booking or an order that exists. A request to cancel that comes back with a reference the agent can follow counts the same as cancelling at once.

**Partial:** Only behind the customer's own account.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | An agent inbox that takes bookings or orders, or a tool, skill or operation that cancels one. |
| `proven` | A signed receipt of the cancellation's outcome, or signed reports from agent platforms a network recognises, saying that a cancellation went through. |

Not enough:

- Cancelling a cart, a basket or a checkout.
- A cancellation policy: that is policies.

Through each kind of door, for example:

- Agent inbox: `booking`, `order`
- MCP server: `cancel_item`, `cancel_booking`, `cancel_order`
- A2A agent: `cancel-reservation`
- OpenAPI: `DELETE /bookings/{id}`, `cancelOrder`
- REST API: `POST /orders/{id}/cancel`

### Track {#track}

`track` · also status, where is my order

*Can an agent see the status of a booking, an order or a delivery?*

Follow a booking, an order or a delivery: whether it is confirmed, where it is, when it arrives.

**Partial:** Only behind the customer's own account.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | An agent inbox that takes bookings or orders, a UCP order capability on a site that shows it sells (products or offers with prices on its own pages, or a cart that works), or a tool, skill or operation that reads a status. |
| `proven` | Signed reports from agent platforms a network recognises, saying that a status read answered. |

Not enough:

- A tracking page a person opens from an email.
- A commerce platform's profile that every site on that platform gets, on a site with no prices and no cart.

Through each kind of door, for example:

- Agent inbox: `booking`, `order`
- MCP server: `get_item_status`, `track_order`
- A2A agent: `order-status`
- OpenAPI: `GET /orders/{id}/status`, `getShipmentStatus`
- REST API: `GET /track/{id}`
- UCP: `order`

### Return or refund {#return}

`return` · also refund, exchange, withdraw

*Can an agent start a return, a refund or an exchange?*

Start a return, a refund or an exchange. A request that comes back with a reference the agent can follow counts the same as a refund made at once.

**Partial:** Only behind the customer's own account.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | An agent inbox that takes refunds, a UCP return capability on a site that shows it sells (products or offers with prices on its own pages, or a cart that works), or a tool, skill or operation that starts a return or a refund. |
| `proven` | A signed receipt of the refund's promise or its outcome, or signed reports from agent platforms a network recognises, saying that a return was started. |

Not enough:

- A returns policy: that is policies.
- A commerce platform's profile that every site on that platform gets, on a site with no prices and no cart.

Through each kind of door, for example:

- Agent inbox: `refund`
- MCP server: `request_return`, `create_refund`
- A2A agent: `start-return`
- OpenAPI: `POST /returns`, `requestRefund`
- REST API: `POST /orders/{id}/return`
- UCP: `return`

### Receipt {#receipt}

`receipt` · also invoice, proof of purchase

*Can an agent get a receipt or an invoice?*

Get a receipt or an invoice for what was booked, ordered or paid.

**Partial:** Only behind the customer's own account, or only by email.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | An agent inbox that takes orders (it gives signed receipts), or a tool, skill or operation that returns a receipt or an invoice. |
| `proven` | A signed receipt the customer's agent counter-signed. |

Not enough:

- A receipt only sent to a person's email.

Through each kind of door, for example:

- Agent inbox: `order`
- MCP server: `get_receipt`, `get_invoice`
- A2A agent: `get-receipt`
- OpenAPI: `GET /orders/{id}/invoice`, `getReceipt`
- REST API: `GET /invoices/{id}`

### Feedback {#feedback}

`feedback` · also review, rating

*Can an agent leave feedback or a review?*

Leave feedback or a review with the business itself.

**Partial:** Only behind the customer's own account.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | A tool, skill or operation that leaves feedback or a review. |
| `proven` | Signed reports from agent platforms a network recognises, saying that feedback was taken. |

Not enough:

- A link to a review site run by someone else.

Through each kind of door, for example:

- MCP server: `leave_review`, `submit_feedback`
- A2A agent: `leave-feedback`
- OpenAPI: `POST /reviews`
- REST API: `POST /feedback`

## Ongoing {#journey-ongoing}

### Membership {#subscription}

`subscription` · also subscription, plan

*Can an agent pause, resume or end a membership or subscription?*

Manage a membership or a subscription that exists: pause it, resume it, change the plan or end it.

**Partial:** Only behind the customer's own account.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | A tool, skill or operation that pauses, resumes, changes or ends a membership or subscription. |
| `proven` | Signed reports from agent platforms a network recognises, saying that the change went through. |

Not enough:

- A page that says to email the business to cancel.

Through each kind of door, for example:

- MCP server: `pause_subscription`, `cancel_membership`
- A2A agent: `renew-membership`
- OpenAPI: `PATCH /subscriptions/{id}`
- REST API: `POST /memberships/{id}/pause`

### Vouchers {#vouchers}

`vouchers` · also gift card, coupon, loyalty

*Can an agent use a gift card, a voucher or loyalty points?*

Use or check a gift card, a voucher, a promotion code or loyalty points.

**Partial:** Only behind the customer's own account.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | A tool, skill or operation that redeems or checks a voucher, a gift card or points. |
| `proven` | Signed reports from agent platforms a network recognises, saying that a voucher was taken. |

Not enough:

- A promotion code printed on a page.

Through each kind of door, for example:

- MCP server: `redeem_voucher`, `apply_gift_card`
- A2A agent: `redeem-voucher`
- OpenAPI: `POST /vouchers/redeem`
- REST API: `POST /loyalty/redeem`

### Waitlist {#waitlist}

`waitlist` · also waiting list

*Can an agent join a waitlist?*

Join a waitlist for a time, a table, a class or a product, and leave it.

**Partial:** Only behind the customer's own account.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | A tool, skill or operation that joins a waitlist. |
| `proven` | Signed reports from agent platforms a network recognises, saying that a place on the list was taken. |

Not enough:

- A form for people to leave their email.

Through each kind of door, for example:

- MCP server: `join_waitlist`
- A2A agent: `join-waitlist`
- OpenAPI: `POST /waitlist`
- REST API: `POST /waitinglist`

### Support {#support}

`support` · also complaint, ticket, dispute

*Can an agent raise a complaint or a problem with an order?*

Raise a complaint or a problem with a booking or an order, and follow it.

**Partial:** A problem can be raised and nothing comes back through the door.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | An agent inbox that takes messages, or a tool, skill or operation that opens a support ticket or a complaint. |
| `proven` | Signed reports from agent platforms a network recognises, saying that a ticket was opened and answered. |

Not enough:

- A help centre of articles for people.

Through each kind of door, for example:

- Agent inbox: `message`
- MCP server: `create_support_ticket`, `file_complaint`
- A2A agent: `open-ticket`
- OpenAPI: `POST /tickets`
- REST API: `POST /complaints`

## Policies {#journey-policies}

### Policies {#policies}

`policies` · also terms, returns policy, cancellation policy

*Can an agent read the cancellation, return, deposit or no-show policy?*

Read the terms that matter before and after: cancellation, returns, deposits, no-shows and delivery.

**Partial:** The policy is on a page an agent can read and not as data or through a door.

| Evidence | What has to be seen |
| --- | --- |
| `declared` | schema.org MerchantReturnPolicy or similar data, a policy in the inbox's terms, or a tool, skill or operation that reads a policy. |
| `proven` | Signed reports from agent platforms a network recognises, saying that the policy read answered. |

Not enough:

- A policy only in a PDF.

Through each kind of door, for example:

- MCP server: `get_policies`, `get_return_policy`
- A2A agent: `policies`
- OpenAPI: `GET /policies`
- REST API: `GET /terms`

## Changelog {#changelog}

- **Version 2**, published 15 October 2026. Each capability now has a definition, other words for it, what partial means for it, what has to be seen at each step of the evidence ladder, what is not enough, and how each kind of agent door meets it, with example names. Message, negotiate, book, order and pay name the kind of request a directory filters by (ask, quote, book, order, pay). The door kinds, what never counts as a door and how names are read are written down. Order, pay, the catalogue, availability, tracking and returns need something the business really sells when they rest on a UCP or ACP profile: a commerce platform's profile that every site on it gets is not enough on its own. A name that reads documentation meets nothing. No capability was added, renamed or removed: every id, label and question is as in version 1.
- **Version 1**, amended 13 October 2026. Tested is produced: a network's own read of a door that saw it answer and list a capability in the 7 days before.
- **Version 1**, published 7 October 2026. Twenty capabilities in five parts of a customer's journey, each with a label and a question, the states yes, partial, no and na, and the evidence ladder declared, tested, proven.

Version 1 is kept as it was last served, as amended on 13 October 2026 ([`/spec/capabilities/v1.json`](/spec/capabilities/v1.json)).

Ids never change: a capability is added, never renamed or removed. What counts toward a score, and how much, is a score's own rules, published apart ([the agentic score's](https://surfingdog.ai/v1/score-rules)).
