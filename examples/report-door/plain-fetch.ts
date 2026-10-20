// Read a business's REST door and report how it went: fetch for the door, @surfingdog/sdk's trackDoor
// for the report.
//
//   npm install @surfingdog/sdk@^0.4.0
//   npx tsx plain-fetch.ts <domain> <inbox.rest>     a business and its card's inbox.rest, from a search
import { flushDoorReports, trackDoor } from "@surfingdog/sdk";

const [domain, rest] = process.argv.slice(2);
if (!domain || !rest?.startsWith("https://")) {
  // Nothing is sent without a real business: a report about one the network does not list is ignored.
  console.error("usage: npx tsx plain-fetch.ts <domain> <inbox.rest>, as get_business or search_businesses gave them");
  process.exit(2);
}

// The door exactly as you used it: a business's inbox, at the REST address you called.
const door = { type: "inbox", url: rest };

// GET <inbox.rest>/business, the business's public profile: a call that needs nothing from you.
// trackDoor reads a Response by its status, and an error's problem code from a copy, so the body is
// still yours to read.
const res = await trackDoor({ network: "network.surfingdog.ai", domain, door, op: "find" }, () =>
  fetch(`${rest}/business`, { headers: { accept: "application/json" } }),
);
console.log(res.status, await res.text());

await flushDoorReports();
