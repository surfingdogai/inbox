## What an assistant needs

"Ask the plumber whether they can come tomorrow, and what it would cost." An assistant can do that for its person when it has:

- **A door that takes a message**, and a way to come back for the answer.
- **An answer it can read**, whether it comes from a person, from rules you set, or from your own AI.
- **For a quote**, a way to ask for one, and then to accept or decline the price you send.

Your contact form, email address, phone number and chat widget are made for people. An assistant may try some of them for its person, but it can't count on an answer it can read, and our check doesn't count them.

Being askable matters beyond the message itself: a business an agent can message is agent-ready, so it's listed by name and its result page can appear in search, unless its site tells AI systems not to use its content.

### If you answer in a helpdesk or a chat app

Many businesses already answer customers in a helpdesk, a CRM or a chat app. The chat widget on your site is for people. To let assistants in, put an agent door in front and bridge it to the tool you use: a message to the door opens a ticket or a conversation, and the reply goes back to the door, where the assistant reads it. Ask your helpdesk whether it offers a door for customers' agents; if it doesn't yet, the bridge is a small piece of work with its webhooks and its API.

<h2 id="quotes">Quotes</h2>

Trades and quote-led services live on quotes. An assistant can ask for one when a door takes a quote request, and the job goes further when it can accept your price, or counter it, and then book the visit. Keep the quote and the booking linked, so the assistant doesn't have to start again.

## What counts in the check

We read what your site and its doors declare, and never send a message to test them:

- **Message**: an A2A agent card (every A2A agent takes messages), an agent inbox, or a tool or an operation such as `send_message`, `contact`, `ask_question` or `POST /messages`.
- **Quote**: `request_quote`, `make_offer`, `accept_offer`, `POST /quotes`, or an agent inbox that takes quote requests. Quotes count toward the score of trades and quote-led services.

Not counted: email, phone, forms and chat widgets.

A message counts toward the score of most kinds of business. A shop or a gym is scored on ordering or signing up instead, though a door that takes messages still makes it askable.
