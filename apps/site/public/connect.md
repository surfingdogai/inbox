# Connect the software a business already uses: instructions for an AI agent

You are the AI of a business that runs a Surfing Dog Inbox. The person wants the inbox to work with
software they already use: an online shop, a booking tool, a calendar, a CRM, a reservation system.
This file says what you can connect today, with the exact calls, and what is not built yet.

Read the whole file first. Then ask the person which tools they use, with the product name and plan
for each. Tell them in a few sentences what you can connect, how, and what you cannot. Do not begin
until they answer.

**Before you start.** You need the owner MCP at `https://<inbox>/mcp/owner`. If you are not
connected, do Step 4 of https://surfingdog.ai/install.md first. Call `get_profile` to check. This
work uses the scopes `inbox:read`, `inbox:write`, `events:read`, `catalogue:write`,
`availability:write`, `settings:read`, `setup:run` and `integrations:write`. If the person's client
lets them choose scopes when they connect, they grant these. If the owner has switched on refusing
calls outside scopes and a call is refused, they reconnect with these scopes.

**What only the person does.** Making or revoking a key, adding or changing a webhook endpoint, and
changing where alerts and emails go are done by the person, in the owner app. The inbox refuses
them from you whatever your scopes: customers' messages reach you, and one could ask you to send the
business's data somewhere. So you give the person the exact values and they paste them in. You can
still list endpoints, test them, replay what they missed, and pause one.

Below, `<inbox>` is the inbox's own address, such as `inbox.theirdomain.com`.

---

## What works today, and what is coming

**Works today.**

- Named integration keys, one per system, each with scopes and a one-click revoke (Settings → Keys).
- Signed webhooks out, per event type, with up to five extra headers, a test delivery and replay.
- Every event says who caused it (`data.actor`), through which door (`data.channel`) and whether it
  is a test item (`data.sandbox`). A sync uses this to ignore its own writes.
- The events feed: `list_events`, or `GET /v1/owner/events`, read forward with a cursor.
- Owner MCP and REST for services, products, opening hours, closed days, rules, settings, items and
  their transitions, and replies.
- Product feeds: a CSV or Google Merchant XML file at a public URL, imported every six hours.
- The email door: mail sent or forwarded to the inbox's address becomes a message.
- An idempotency key on every owner write.

**Not built yet.** When the person needs one of these, say it is coming, in one plain line. Never
work around it in a way that pretends it exists.

- Recording a booking or an order that happened in another system.
- Storing another system's id on an inbox item or customer.
- Create-or-update a product by SKU in one call.
- Webhooks from other platforms straight into the inbox. Today they go to a bridge (Zapier, Make,
  n8n), and the bridge calls the inbox.
- Busy-time blocks and calendar feeds. Today the inbox only knows whole closed days.
- A hosted booking form, and a widget for the business's website.
- Native connectors for Shopify, WooCommerce, Google Calendar, Stripe and Mollie. They are on the
  requests board, https://surfingdog.ai/requests, where the person can vote for them.

---

## Rules for you

1. **One key per system.** Zapier gets a key, the shop gets another. The person makes it in
   Settings → Keys → New key: tell them the name and the preset. The key is shown to them once, and
   they paste it straight into the other system. Never put the owner's own key, or your own
   sign-in, into another product.
2. **The narrowest preset that works.**

   | Preset | Scopes | For |
   |---|---|---|
   | `automation` | `inbox:read inbox:write events:read` | Zapier, Make, n8n reading and moving items |
   | `shop_sync` | adds `catalogue:write` | A flow that also writes products |
   | `calendar_sync` | adds `availability:write` | A flow that also writes closed days |
   | `read_only` | `inbox:read events:read settings:read` | Reports and dashboards |

   Today a call outside a key's scopes still goes through, and it is logged. The owner can switch
   on refusing such calls in Settings → Keys, and a later release will refuse them for everyone.
   Pick the narrow preset anyway: the owner sees every call outside it.
3. **Ask first** before you change a setting in another system, send an email for the person, or
   turn on anything that costs money, such as a paid Zapier plan.
4. **Other platforms' secrets stay out of the inbox.** A Shopify token or a HubSpot key goes into
   the bridge, or into your own connector for that platform. Never into inbox settings, notes or
   replies.
5. **An idempotency key on every write,** and the same key again on a retry. From a bridge, use the
   event's id: `Idempotency-Key: zap-01K5RJ3B4C5D6E7F8G9H0JKMNP`. The same key twice does the work
   once.
6. **Skip your own echo.** When an event's `data.actor.id` is the id of the key a sync uses, the
   event is that sync's own write coming back. Drop it, or the two systems will loop.
7. **Thin events by default.** A thin event carries the item's id, type, state and a URL, and no
   customer data. Choose `payload_style: "full"` only after the person understands that it sends
   customers' names, email addresses and phone numbers to that URL, on every event.
8. **Test every connection, in each direction it runs,** before you say it works. Use sandbox
   items, never a real customer.
9. **Say what does not sync.** When a platform has no API on the person's plan, or only opens it to
   approved partners, tell them.

---

## The building blocks

### A. Inbox → their software: a webhook

The person adds the endpoint in Settings → Integrations → Where events go: the URL, the events
(say `booking.confirm` and `booking.cancel`) and thin payloads. Then you check it:

```
list_webhooks {}
send_test_event {"webhook_id": "…"}
list_webhook_deliveries {"webhook_id": "…"}
```

- The person sees the signing secret once, when they add the endpoint. Code can check it with
  `verifyWebhook` from `@surfingdog/sdk`, or any Standard Webhooks library. No-code tools cannot.
  For those, the receiver reads the item back with its key, so a forged call can only make it read
  real data.
- For a receiver that checks a header instead (n8n Header Auth, Pipedream), the person adds it with
  the endpoint, such as `Authorization: Bearer <a long random string>`. Up to five, sealed, never
  shown again.
- `send_test_event` should answer `Delivered: HTTP 2xx`. Its type is `inbox.test`, and no item
  exists behind it. Receivers should skip it.
- Event types are `<item type>.<event>`: `booking.create`, `booking.confirm`,
  `order.record_payment`, `quote_request.accept`, `message.create`. Patterns work: `booking.*`,
  `*.create`, `*`. The full list is at https://surfingdog.ai/docs/webhooks/.
- The URL must be public https and answer 2xx. A redirect counts as a failure. Failed deliveries
  are retried for about a day, then marked failed. `replay_missing_webhook_deliveries {"webhook_id": "…",
  "since": "2026-09-20T00:00:00Z"}` sends what an endpoint missed.

The receiver then reads the item:

```
GET https://<inbox>/v1/owner/items/<data.id>
Authorization: Bearer <integration key>
```

It gets the item with its typed fields (`item.payload`), the customer (`party`: name, email, phone and
`verified`), and `transitions`, the events the item accepts now.

### B. Their software → inbox: HTTP with an integration key

Base URL `https://<inbox>/v1/owner`. Headers `Authorization: Bearer <integration key>` and
`Idempotency-Key: <one per request>`.

| To | Call |
|---|---|
| Find items | `GET /items?type=order&state=awaiting_payment` (also `q` for full-text search) |
| Move an item on | `POST /items/{id}/transitions` `{"event": "confirm"}` |
| Record a payment | `POST /items/{id}/transitions` `{"event": "record_payment", "input": {"paymentRef": "shopify:#1042", "amount": {"value": 4500, "currency": "EUR"}}}` |
| Ask for payment with a link | `POST /items/{id}/transitions` `{"event": "request_payment", "input": {"paymentUrl": "https://…"}}` |
| Leave a note for the team | `POST /items/{id}/replies` `{"body": "…", "internal": true}` |
| Add or change a product | `POST /products`, `PATCH /products/{id}` |
| Set closed days | `PUT /availability/closures` |

Fire only an event that the item's `transitions` list names. Amounts are whole numbers in minor
units: 45.00 EUR is `{"value": 4500, "currency": "EUR"}`. Over MCP the same move is
`transition_item {"item_id": "…", "event": "record_payment", "input": {…}, "idempotency_key": "…"}`.

### C. Polling: the events feed

For anything that cannot receive a webhook: a job behind a firewall, a scheduled script, or you,
between chats.

```
list_events {"cursor": "<the last next_cursor>", "types": ["booking.*", "order.*"], "limit": 100}
GET https://<inbox>/v1/owner/events?cursor=…&types=booking.*,order.*&limit=100
```

Events come oldest first. Keep the `next_cursor` and send it next time. `null` means you are up to
date: keep the cursor you had. There is nothing to acknowledge, and reading again is harmless if you
skip event ids you have seen. Keep the cursor in the bridge's own storage, or in your notes. If it
is lost, start again with `since` set to the time of the last run.

### D. The catalogue

With a feed:

```
add_feed {"url": "https://shop.example/feed.xml", "name": "Wix shop"}
import_feed_now {"feed_id": "…"}
list_feeds
```

- It reads CSV (comma, semicolon, tab or pipe) and Google Merchant XML. It refreshes every six
  hours.
- `list_feeds` should show a product count close to the shop's, and no `last_error`.
- Products that leave the feed are taken off sale, never deleted. A feed never touches products
  typed in by hand.
- Pass `currency` when the feed's prices have none and differ from the business currency.
- You add feeds yourself over the owner MCP. No key is needed, because the inbox fetches the URL.

Without a feed:

1. `list_products`, and build a map from `sku` to product `id`.
2. For each product in the shop: when its SKU is in the map,
   `upsert_product {"product_id": "…", "name": "…", "price": {…}, "stock": 12}`. When it is not,
   `upsert_product {"sku": "…", "name": "…", "price": {"value": 1299, "currency": "EUR"}, "stock": 12}`.
3. A SKU is unique in the inbox. If a create fails with "that SKU is already used", find that
   product and update it.
4. A product with no SKU in the shop: ask the person first. Without a SKU, the next run cannot find
   it and makes a second copy.
5. A product that left the shop: `archive_product`, after asking. Never delete.

### E. The email door

Mail sent to the inbox's address becomes a message item. That address was set up in Step 2 of
install.md, often `inbox@theirdomain.com`. A confirmation forwarded from another platform arrives
the same way, so the person sees other systems' bookings in one place.

What to know today:

- It is always a message. It never becomes a booking or an order, and it does not block a slot.
- Use an automatic forward: a filter or rule on the platform's sender address. A mail forwarded by
  hand is cut at its first `From:` line, so only the forward's own note survives.
- Forward only that sender. Forwarding everything can loop with the inbox's own notification
  emails.
- Each mail is a new item. A change or a cancellation arrives as another message.
- Attachments are not kept.
- Never reply to these items. A reply goes to the platform's sender address.
- Check the rules with `list_rules`. A rule that answers new messages on its own would answer the
  platform too.
- **Gmail:** first add the inbox as a forwarding address, under Settings → Forwarding and POP/IMAP.
  Gmail sends a confirmation code to that address, so it lands in the inbox as a message: find it
  with `list_items {"type": "message"}` and give the person the code. Then a filter on the
  platform's sender, with the action Forward it
  ([help](https://support.google.com/mail/answer/10957)).
- **Microsoft 365:** forwarding to an outside address is off by default in most organisations. An
  admin has to allow it
  ([docs](https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-policies-external-email-forwarding)).

---

## The recipes

Each recipe says the direction, the speed, the key, the steps with who does each one, the test, the
limits and how to undo it.

### 1. Automation tools: Zapier, Make, n8n

Use one when the person wants a link that runs on its own, or wants to reach an app you cannot reach
yourself.

- **Direction:** both. Inbox → app by webhook. App → inbox by an HTTP step with a key.
- **Speed:** instant.
- **Key:** `automation`. Use `shop_sync` if the flow writes products, `calendar_sync` if it writes
  closed days.

**Steps.**

1. Person, in Settings → Keys: a new key named `Zapier` with the `automation` preset. Read its `id`
   with `list_api_keys`: it is the `data.actor.id` of this flow's own writes.
2. Person, in the tool: make the trigger and give you its URL.
   - Zapier: Webhooks by Zapier → Catch Hook.
   - Make: Webhooks → Custom webhook.
   - n8n: a Webhook node with Authentication set to Header Auth. Use its Production URL.
3. Person, in Settings → Integrations: add that URL for `booking.confirm`, with thin payloads. For
   n8n, they add a header with the same name and value as the n8n credential.
4. You: `send_test_event {"webhook_id": "…"}`. The tool now has a sample of the event's shape. No
   item is behind it, so test the next step with a sandbox message (see Test, below).
5. Person or you: add a step that reads the item. A GET on `data.url` with
   `Authorization: Bearer <key>`.
   - Zapier: Webhooks by Zapier → Custom Request.
   - Make: HTTP → Make a request, with the key in an API Key keychain.
   - n8n: an HTTP Request node with a Bearer Auth credential.
6. Add a filter right after the trigger: stop when the type is `inbox.test`, or when
   `data.actor.id` is the key's id.
7. Then the steps in the target app. To write back to the inbox, one more HTTP step:
   `POST https://<inbox>/v1/owner/items/{{data.id}}/transitions`, with the event's `id` as the
   `Idempotency-Key`.

**Who can build the flow.** For Make and n8n, you can build it yourself if the person connects you
to their MCP server: Make's, which needs a paid plan to edit scenarios, or n8n's, from version 2.13.
In n8n the person still creates the credential that holds the key, by hand. Zapier's MCP runs
actions. Building Zaps through it is only in early access, so give the person a click-list, or a
prompt for Zapier Copilot.

**Test.** Make a sandbox message and watch the flow run:

```bash
curl -s -X POST https://<inbox>/v1/messages -H 'x-sandbox: 1' -H 'content-type: application/json' \
  -d '{"body": "Test for the new Zap", "contact": {"name": "Test", "email": "test@example.com"}}'
```

If the flow listens to other events, ask the person to add `message.create` to the endpoint for the
test in Settings → Integrations, and to take it out afterwards. Sandbox items still send the owner the usual
email, so tell the person a test is coming. For the way back, have the flow fire `close` on that
message. `get_item` should then show it closed, by the key's name.

**Limits.**

- Zapier's webhook steps need the Professional plan or above.
- Make switches off a webhook with no scenario attached after five days.
- By default the inbox only calls public https addresses. A self-hosted n8n with no public URL
  polls instead: a Schedule Trigger calling `GET /v1/owner/events` (block C).
- No-code tools cannot check the signature. Keep thin events and read the item back with the key.

**Undo.** Pause the endpoint at once with `update_webhook {"webhook_id": "…", "active": false}`; the
person removes it in Settings → Integrations and revokes the key in Settings → Keys. Turn off the
Zap, scenario or workflow.

**Docs.** Zapier [Catch Hook](https://help.zapier.com/hc/en-us/articles/8496288690317-Trigger-Zaps-from-webhooks),
[Custom Request](https://help.zapier.com/hc/en-us/articles/8496326446989-Send-webhooks-in-Zaps),
[Copilot](https://help.zapier.com/hc/en-us/articles/15703650952077-Create-Zaps-with-Copilot).
Make [webhooks](https://help.make.com/webhooks), [HTTP](https://apps.make.com/http),
[MCP server](https://help.make.com/make-mcp-server). n8n
[Webhook node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/),
[HTTP credentials](https://docs.n8n.io/integrations/builtin/credentials/httprequest/),
[MCP server](https://docs.n8n.io/connect/connect-to-n8n-mcp-server/).

### 2. CRMs: HubSpot, Pipedrive, Zoho, Brevo

The goal: every customer and request in the inbox lands in the CRM exactly once.

- **Direction:** inbox → CRM. The other way there is little to do today: the inbox has no customer
  fields a CRM could write to, and links to other systems' ids are coming.
- **Speed:** instant through a bridge. Only when you run it through your own connectors.
- **Key:** `automation` for a bridge. None when you do it yourself.

**Two ways.**

- **Through a bridge** (recipe 1). Subscribe the webhook to what the CRM should see, for example
  `["*.create", "booking.confirm", "quote_request.accept", "order.record_payment"]`. The flow reads
  the item, then uses the CRM's own "create or update contact" step, then adds a deal or an
  activity.
- **Yourself,** with the CRM's own MCP server beside the inbox's owner MCP. HubSpot, Pipedrive, Zoho
  and Brevo all have one. Run it when the person asks, or on a schedule if your client can run one:
  1. `list_events {"cursor": "…", "types": ["*.create", "booking.confirm", "order.record_payment"]}`.
  2. For each item: `get_item`. The customer is in `party`.
  3. Find or make the contact, matching on email. Then one deal or activity per inbox item.
  4. Record the CRM link on the item as a team note:
     `reply {"item_id": "…", "internal": true, "body": "HubSpot deal 1234: https://…"}`. Before you
     make a deal, read the item's notes and skip it if one already names a deal. Until links to other
     systems' ids exist, this is how you avoid a second deal.
  5. Save the `next_cursor` only after the item is done.

**What goes where.**

| Inbox | In the CRM |
|---|---|
| `quote_request` | A deal (or a lead) at the first stage; move it on `quote` and `accept` |
| `booking` | A meeting or activity at `item.payload.startTime` |
| `order` paid | A won deal with the amount |
| `message` | A note on the contact |

**Matching on email.**

- HubSpot: create or update a contact by email
  ([contacts API](https://developers.hubspot.com/docs/api-reference/crm/contacts)). Its search runs
  behind recent writes, so never search right after a create to check for a duplicate
  ([search](https://developers.hubspot.com/docs/api-reference/search/guide)).
- Pipedrive: no upsert. Search persons by email with an exact match, then create
  ([persons](https://developers.pipedrive.com/docs/api/v1/Persons)).
- Zoho: upsert, which matches on email by default
  ([upsert](https://www.zoho.com/crm/developer/docs/api/v8/upsert-records.html)).
- Brevo: create the contact with `updateEnabled: true`
  ([contacts](https://developers.brevo.com/reference/createcontact)).

**Limits.**

- An email in the inbox is not always proven. `party.verified` says whether it is. Put that on the
  CRM record, as a tag or a field, so staff do not merge history on trust.
- Never add a customer to a marketing list. The inbox does not record consent.
- Amounts are minor units in the inbox. Divide by 100 for most currencies, and pass the currency.
- Never delete CRM records. Ask the person.

**Test.** A sandbox message from `test@example.com` (recipe 1). Check the CRM has one contact, then
send a second sandbox message from the same address and check it still has one.

**Undo.** Pause the endpoint (`update_webhook` with `active: false`); the person removes it and
revokes the key in the owner app. Turn the bridge's flow off. Remove test contacts by hand.

**Docs.** MCP servers: [HubSpot](https://developers.hubspot.com/changelog/remote-hubspot-mcp-server-is-now-generally-available),
[Pipedrive](https://www.pipedrive.com/en/newsroom/pipedrive-launches-native-mcp-server-bringing-crm-workflows-directly-into-ai-assistants),
[Zoho](https://www.zoho.com/crm/developer/docs/mcp/overview.html),
[Brevo](https://developers.brevo.com/docs/mcp-protocol).

### 3. An online shop's catalogue: Wix, Squarespace, WooCommerce, Shopify

The goal: an agent that asks what the business sells gets the same products and prices as the shop.

- **Direction:** shop → inbox. Products, prices, and stock where the source has it.
- **Speed:** every six hours with a feed. Only when you run it without one.
- **Key:** none. You do this over the owner MCP.

**Where the products come from.**

- **Wix:** Wix Stores gives a Google Catalog link, a product feed URL
  ([help](https://support.wix.com/en/article/wix-stores-adding-a-product-feed-to-your-google-merchant-center-catalog)).
  Use it with `add_feed`.
- **Squarespace:** the data feed URL from its Facebook and Instagram product sync. Physical products
  only ([help](https://support.squarespace.com/hc/en-us/articles/360001257067-Syncing-products-with-Facebook-and-Instagram)).
  Use it with `add_feed`.
- **WooCommerce:** it has no feed URL of its own. If a Google product feed plugin is installed, use
  that plugin's CSV or XML URL. If not, the person makes a read-only REST key (WooCommerce →
  Settings → Advanced → REST API), you read `GET /wp-json/wc/v3/products`, and you use the route
  without a feed ([REST API](https://woocommerce.github.io/woocommerce-rest-api-docs/)). The REST key
  stays with you, never in the inbox.
- **Shopify:** it publishes no feed URL; its Google channel sends products to Google directly
  ([help](https://help.shopify.com/en/manual/online-sales-channels/marketplaces/google/getting-setup/syncing-products)).
  Read the products through Shopify's own connector for Claude or ChatGPT
  ([help](https://help.shopify.com/en/manual/ai-powered-tools/connecting-ai-tools)), or from the
  CSV the person exports from Products → Export
  ([help](https://help.shopify.com/en/manual/products/import-export/export-products)). Then use the
  route without a feed. Each variant with its own price is its own product, with the variant's SKU.

**Steps with a feed.**

1. Get the URL from the person. Open it once: each product should have an id or SKU, a title and a
   price.
2. `add_feed {"url": "…", "name": "Wix shop"}`, then `import_feed_now`, then `list_feeds`.
3. The Wix and Squarespace feed formats are not confirmed. If `list_feeds` shows no products or an
   error, `remove_feed` and use the route without a feed.

**Steps without a feed:** block D.

**Test.** `list_products`, and compare a few products with the shop: name, price, stock.

**Limits.**

- This is one way: products in. Orders placed in the shop do not appear in the inbox. Recording
  them is coming.
- The route without a feed runs only when you run it.
- Pick one route per catalogue. A feed never touches products you typed in, and it will not take a
  SKU another product already has.

**Undo.** `remove_feed {"feed_id": "…"}` takes the feed's products off sale and keeps them. Products
you made: `archive_product`.

**Optional: inbox orders paid through the shop.** A bridge (recipe 1) that holds the shop's own
credentials can do this today. First check `list_rules`: a rule that fires `request_payment` on its
own must stop doing that, or the order is already waiting for payment with no link when the bridge
tries.

1. On `order.accept`, it reads the order and creates an unpaid order in the shop with the inbox item
   id in a note or attribute. Shopify: a draft order, whose `invoiceUrl` is the pay link. WooCommerce:
   an order with status `pending`, whose `payment_url` is the pay link.
2. It fires `request_payment {"paymentUrl": "<the pay link>"}` on the inbox item.
3. On the shop's own "order paid" trigger in the bridge, it fires `record_payment
   {"paymentRef": "shopify:#1042", "amount": {…}}` on the item named in the note.

### 4. Booking tools and calendars: Google Calendar, Outlook, Calendly, Cal.com, Fresha

Start by agreeing with the person which system is the diary for each person or room: the one that
decides whether a slot is free.

**Inbox bookings into the calendar the other tools check.** Works today, instantly, through a bridge.

1. Key: `automation`, since the flow only reads bookings. Bridge: recipe 1.
2. Person, in Settings → Integrations: an endpoint for the flow's URL with the events
   `booking.confirm`, `booking.accept`, `booking.cancel`, `booking.cancel_late` and
   `booking.cancel_by_business`, and thin payloads. `accept` is the customer taking a time the
   business proposed, so it confirms the booking too.
3. The flow reads the item. On `confirm` or `accept`, it creates a calendar event from
   `item.payload.startTime` to `item.payload.endTime`, with the inbox item id in the description. On any
   cancel, it finds the event by that id and deletes it.
4. Calendly and Cal.com check a connected Google or Outlook calendar for conflicts, so these events
   block time there too. Fresha does the same through its Google sync
   ([help](https://www.fresha.com/help-center/knowledge-base/calendar/101373-sync-your-fresha-calendar)).
   Calendly has no other way in: it has no API to set busy time
   ([docs](https://developer.calendly.com/docs/api-guides/view-event-type-and-user-calendar-availability-data)).

**Their bookings into the inbox.** There are no busy-time blocks yet, so the inbox cannot see time
booked elsewhere. What works today:

- For a service sold in both places, stop the inbox confirming on its own. `list_rules` shows the
  rules. There may be more than one that confirms bookings. Switch each one off
  (`upsert_rule {"rule_id": "…", "enabled": false}`), or send its whole definition back with this
  condition added to its `all` list:
  `{"path": "item.payload.reservationFor.serviceId", "op": "neq", "value": "<service id>"}`. Check
  with `test_rule`. Bookings then wait as requests. The person, or you, checks the diary and fires
  `confirm`, `propose` or `decline`.
- A whole day booked out, or a day off: `set_closures`. It replaces the whole list, so read
  `get_availability` first and send the old closures with the new one.
- Forward the other tool's confirmation emails into the inbox (block E), so they are in one place.
- In a chat, read the other calendar through your own connector before you confirm anything.

Coming: busy-time blocks, calendar feeds, and recording bookings made elsewhere.

**Test.** Find a free time with `GET https://<inbox>/v1/availability?service_id=…&from=…&to=…`.
Create a sandbox booking there with `POST /v1/bookings`, the `x-sandbox: 1` header and no contact.
The owner still gets the usual email. Confirm it with
`transition_item`: the event should appear in the calendar. Fire `cancel_by_business`: it should go.

**Limits.** Keep the diary rule. If two systems both take bookings for the same person or room on
their own, one of them will double-book.

**Undo.** Pause the endpoint (`update_webhook` with `active: false`); the person removes it and
revokes the key in the owner app. Switch the rule back on if you switched it off.

**Docs.** Google Calendar [events](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert),
Outlook [events](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0).

### 5. Restaurants: TheFork, OpenTable, Resy, SevenRooms, Zenchef, Tock

Most reservation platforms open their systems only to approved partners. Say so, and use the inbox
for what it does well today.

**What works today.**

- The inbox takes what the platforms handle badly: large parties, private dining and events as
  quote requests, questions and allergies as messages, and requests from customers' agents.
- Forward the platform's notification emails, if the restaurant gets them (block E). TheFork Manager
  can email new bookings
  ([help](https://support.theforkmanager.com/s/article/Where-can-I-find-my-reservation-notifications)).
  For the others, check with one real booking.
- If the restaurant also takes table bookings in the inbox, never let it confirm them on its own
  while the same tables are sold on a platform. Switch off auto-confirm (recipe 4). Staff confirm
  after checking the book. Recipe 4 also puts inbox bookings in a staff calendar.

**What a restaurant can ask for.** Draft the email for the owner to send. Do not send it yourself.

- TheFork: its B2B API is open to restaurants. Ask integrations@thefork.com
  ([docs](https://docs.thefork.io/B2B-API/introduction)).
- Zenchef: API documentation on request from help@zenchef.com
  ([help](https://help.zenchef.com/hc/en-gb/articles/27690768125597-Zenchef-API)).
- Tock: the account owner asks api-integration@resy.com.

The inbox side of these, recording reservations made there, is coming.

**What will not work.** Tell the person plainly.

- OpenTable, SevenRooms and Resy: approved partners only
  ([OpenTable](https://www.opentable.com/restaurant-solutions/api-partners/),
  [SevenRooms](https://api-docs.sevenrooms.com/)).
- Toast Tables has no reservation API
  ([docs](https://doc.toasttab.com/doc/cookbook/apiIntegrationChecklistReservation.html)).
- Delivery apps (Uber Eats, Deliveroo, Glovo, Just Eat): partners only. Live delivery orders will
  not appear in the inbox. Never accept or reject a delivery order from an automation.

---

## When you are done

Show the person `list_webhooks` and `list_api_keys`. Then tell them, for each system:

- what syncs, and in which direction;
- how fast: instant, every six hours, or only when you run it;
- what does not sync, and which of it is coming;
- which key it uses, and how to switch it off.

Documentation: https://surfingdog.ai/docs/ · Webhooks: https://surfingdog.ai/docs/webhooks/ · API:
https://surfingdog.ai/docs/api/
