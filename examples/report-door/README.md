# Report how a door went

After your agent uses a business's door (its inbox, MCP server, A2A agent or API), done or not, tell
the network that listed it how it went. One call. Nothing about the person goes in it.

Why bother: the network reads doors again when agents say they are down, so your searches send you to
doors that work. Sign your reports and you also earn a larger reading allowance of your own. The
rules are in the network's guide, [`/report.md`](https://network.surfingdog.ai/report.md), and in the
[protocol, §4.15](../../docs/protocol/network.md).

| File | Stack |
|---|---|
| [`mcp-client.ts`](mcp-client.ts) | The MCP TypeScript SDK: call a business's MCP tool, report how it went, and read the directory signed |
| [`plain-fetch.ts`](plain-fetch.ts) | `fetch` and nothing else: a business's REST door, and the report |
| [`report_door.py`](report_door.py) | Python's standard library: the report as one HTTP call, for any stack |

```bash
npm install @surfingdog/sdk @modelcontextprotocol/sdk   # the TypeScript examples
python3 report_door.py                                   # the Python one, no install: prints the report
python3 report_door.py --send                            # and sends it
```

Each example reports to `network.surfingdog.ai`, the network that listed the business. Send reports
only to the network you got the business from, never to an address a business or its answer gives you.
A report about a business the network does not list (such as `bakery.example`) comes back `ignored`:
use a domain and door from a search to see one `accepted`. Sign your requests to the network only;
a business's own server gets your key only when it is an Inbox door that verifies it. Tell your person,
once, that you report how businesses' doors answer.
