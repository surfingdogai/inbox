// Ask a business's REST door for its free times and report how it went: fetch and @surfingdog/sdk.
//
//   npm install @surfingdog/sdk
//   npx tsx plain-fetch.ts <domain> <inbox URL>     a business and its inbox, as a search listed them
import { flushDoorReports, trackDoor } from "@surfingdog/sdk";

const [domain, inbox] = process.argv.slice(2);
if (!domain || !inbox) {
  // Nothing is sent without a real business: a report about one the network does not list is ignored.
  console.error("usage: npx tsx plain-fetch.ts <domain> <inbox URL>, from a search (search_businesses)");
  process.exit(2);
}

// The door exactly as the network listed it: for a business's inbox, type inbox and the address used.
const door = { type: "inbox", url: inbox };

// trackDoor reads a Response by its status, and an error's problem code (slot_taken, outside_limits…)
// from a copy, so the body is still yours to read.
const res = await trackDoor({ network: "network.surfingdog.ai", domain, door, op: "availability" }, () =>
  fetch(`${inbox}/v1/availability?service=repair`, { headers: { accept: "application/json" } }),
);
console.log(res.status, await res.text());

await flushDoorReports();
