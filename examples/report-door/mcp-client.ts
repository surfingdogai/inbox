// Find a business through the network's MCP server, use its MCP door, and report how it went, with
// the MCP TypeScript SDK.
//
//   npm install @surfingdog/sdk@^0.4.0 @modelcontextprotocol/sdk
//   npx tsx mcp-client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { flushDoorReports, generateAgentKey, reporterCredit, signingFetch, trackDoor } from "@surfingdog/sdk";

const NETWORK = "network.surfingdog.ai";

// Your agent's own key. Keep it (it holds your credit); here a fresh one for the example.
const key = await generateAgentKey();

// 1. Find a business that takes bookings, reading the directory signed. A report earns a point only
//    for a business your own signed reads returned, and once your points make you a contributor these
//    reads count against your own, larger allowance. signingFetch signs requests to the network only
//    (network.surfingdog.ai and surfingdog.ai).
const search = new Client({ name: "example-agent", version: "1.0.0" });
await search.connect(
  new StreamableHTTPClientTransport(new URL("https://surfingdog.ai/mcp"), { fetch: signingFetch({ key }) }),
);
const found = await search.callTool({
  name: "search_businesses",
  arguments: { query: "bike repair", accepts: ["book"] },
});

// A member's inbox is reached at the card's inbox.mcp; any other business's MCP door is in its doors.
type Door = { type: string; url: string };
type Card = { domain: string; inbox?: { mcp?: string; rest?: string }; doors?: Door[] };
const businesses = (found.structuredContent as { businesses?: Card[] } | undefined)?.businesses ?? [];
const doorOf = (b: Card): Door | undefined =>
  b.inbox?.mcp ? { type: "inbox", url: b.inbox.mcp } : b.doors?.find((d) => d.type === "mcp");
const business = businesses.find((b) => doorOf(b) !== undefined);
const door = business && doorOf(business);
if (!business || !door) throw new Error("no business with an MCP door in this search");

// 2. Use the door, wrapped: trackDoor times the call, reads how it went (a tool error, a refusal such
//    as slot_taken, a timeout, no answer) and reports it. The result comes back untouched. The door is
//    signed only when it is a Surfing Dog Inbox, which verifies your key (sdi-agent/1); any other
//    business's server gets no key, so no business sees one key across all you call.
const shop = new Client({ name: "example-agent", version: "1.0.0" });
const doorFetch = door.type === "inbox" ? signingFetch({ key, origins: [new URL(door.url).origin] }) : undefined;
await shop.connect(new StreamableHTTPClientTransport(new URL(door.url), doorFetch ? { fetch: doorFetch } : {}));
// The door exactly as you used it: the address you connected to.
const report = { network: NETWORK, domain: business.domain, door, key };
const tools = await trackDoor({ ...report, op: "find" }, () => shop.listTools());
console.log(
  "tools:",
  tools.tools.map((t) => t.name),
);
// A booking, the same way: op from the capability vocabulary, tool as the door named it.
//   await trackDoor({ ...report, op: "book", tool: "create_booking" }, () =>
//     shop.callTool({ name: "create_booking", arguments: { service: "repair", start_time: "…" } }));

// 3. Send what is queued before the process ends (in a Worker: ctx.waitUntil(flushDoorReports())).
await flushDoorReports();

// 4. Your credit: your points in the network's window, and whether you read on your own allowance yet.
console.log(await reporterCredit({ key, network: NETWORK }));
