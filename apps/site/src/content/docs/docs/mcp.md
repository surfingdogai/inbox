---
title: Surfing Dog MCP server
description: One remote MCP server for any AI assistant. Find businesses, check a website, and, where a business has its own inbox, send it a question, a quote request or a booking request. No sign-in.
---

Surfing Dog's MCP server is at **`https://surfingdog.ai/mcp`** (also `https://network.surfingdog.ai/mcp`, and the same server at `/mcp/search`). Streamable HTTP, no sign-in, the same answer for everyone. Add it to your assistant as a custom connector: [the steps for each assistant](/assistants/).

> Surfing Dog never touches the money and never keeps what anyone writes. When a business allows it, we carry an assistant's request to the business's own inbox and keep only a record that it was delivered.

## Tools

- `search_businesses`, read-only: finds businesses by a few words, a place, a category, a language, opening hours and what their doors take.
- `get_business`, read-only: one business, with its doors, hours, address and track record.
- `list_categories` and `list_attributes`, read-only: the categories and attributes a search takes.
- `check_business`: how far an AI agent can go with a website, and its agentic score. Idempotent, open world.
- `ask_business`: sends a business your person's question, to its own inbox. Not destructive, idempotent, open world.
- `request_quote`: asks a business for a price, in its own inbox. The same.
- `request_booking`: a service's free times in the business's own time (nothing is sent), or a request for one of them, which the business confirms. The same.
- `report_door`: records, privately for the business, how its door went when you used one.
- `register_business` and `update_business`: for a business's own AI, to put it in the directory, correct it or take it out, with proof of its domain. `update_business` is destructive.

Every tool states `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`. Their schemas are published in the [protocol](https://github.com/surfingdogai/inbox/tree/main/packages/spec/schemas) (`mcp-*.json`).

## Carried requests

`ask_business`, `request_quote` and `request_booking` are for when your person asks you to contact a business. They go only to a business in the directory that has its own inbox, and only when its inbox says it takes them (an inbox from before the owner's switch says nothing, and is carried nothing). The business can answer your person by email.

- **Contact.** An email address your person agreed to give the business (`consent: true`), and a name if they want one. Never a phone number.
- **The answer** is the inbox's own: the request as it keeps it, its words, and an access token to read the request's state at the inbox, given once.
- **A priced booking** first answers with the business's terms (`outcome: "confirm"`). Show them to your person; send `terms_sha` only after their yes.
- **What we keep:** when, to which business, the kind of request, and how it went. Not who sent it, and not what it said. Nothing about your person goes back to your assistant's platform, and there is no list of anyone's requests.
- **The inbox is told** that a network carried the request (`Surfing-Dog-Carried: 1`), with a code for its sender that changes daily and differs for each inbox (`Surfing-Dog-Carried-For`), so it can hold one sender to its limits. It does not say who the sender is.
- **A business** switches them off in its inbox under Settings → Networks; its manifest says `carried_requests: {"accepted": true}` or `{"accepted": false}`.

An example, as JSON-RPC:

```bash
curl -s https://surfingdog.ai/mcp -H 'Content-Type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {"name": "request_booking", "arguments": {"domain": "bikes.example", "service": "Puncture repair"}}}'
```

## Limits

Counted per person where we can tell people apart: by a directory key, else by the session `initialize` gives (signed, stored nowhere), else by the address. An assistant platform's published outbound range is many people, not a trusted caller: each address in it keeps its own allowance inside the range's. Each number is the most in any minute, hour or day, and a request one limit refuses counts against none.

- Reading: 600 requests a minute per address (1,200 inside a platform's range), 300 per person.
- `check_business`, `register_business`, `update_business`: 60 a minute per person, and their own limits.
- Carried requests: 20 an hour per person; 3 an hour to one business per person and per email address; 60 an hour per address and per wider network (an assistant platform's whole range: 200); 12 a day per email address; 4 an hour from one place to one business; 12 an hour and 60 delivered a day per business from everyone; the same words to at most 5 businesses an hour.
- Free times: 60 an hour per person, 10 from one place to one business, 60 per business.
- One JSON-RPC message per request, at most 16 KB.

## More

- In plain words, for an AI: [network.surfingdog.ai/llms.txt](https://network.surfingdog.ai/llms.txt).
- The server card: [/.well-known/mcp/server-card.json](https://surfingdog.ai/.well-known/mcp/server-card.json).
- The protocol, §4.7 and §4.16: [network.md](https://github.com/surfingdogai/inbox/blob/main/docs/protocol/network.md).
- [Privacy](/privacy/), [terms](/terms/), [support](/support/).
