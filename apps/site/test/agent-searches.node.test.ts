import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What the network keeps of the searches AI agents send it, as the privacy page and ADR-043 say it:
 * the words as typed, with email addresses, phone numbers and card and bank numbers taken out, with no
 * time limit, never who sent them, no IP address, no session.
 */

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const privacy = flat(read("apps/site/src/pages/privacy.astro"));

/** The page's network section, from its heading to the next one. */
const networkSection = (() => {
  const from = privacy.indexOf('id="network-h"');
  const to = privacy.indexOf('<h2 class="h-section">Changes</h2>', from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return privacy.slice(from, to);
})();

/** The Searches bullet, where Search is. */
const searchesBullet = (() => {
  const from = privacy.indexOf("<b>Searches.</b>");
  const to = privacy.indexOf("</li>", from);
  expect(from).toBeGreaterThan(0);
  return privacy.slice(from, to);
})();

describe("agents' searches, as the site says them", () => {
  it("are kept in the network's words: as typed, the private numbers out, no time limit, never who sent them", () => {
    expect(networkSection).toContain(
      "The words of the searches AI agents send it, as typed, with email addresses, phone numbers and card and bank numbers taken out, with no time limit, to improve search: never who sent them, and no IP address.",
    );
  });

  it("say what a record keeps", () => {
    for (const said of [
      "we keep a record of the call, to improve search, with no time limit",
      "its words as the agent typed them, with email addresses, phone numbers, card numbers and bank account numbers (IBANs) taken out",
      "Street names, house numbers, postcodes, prices, dates and years stay as typed",
      "any other run of eight or more digits in a row too, unless it is the decimals of a number",
      "which door it came through (MCP, A2A or the REST API) and which tool it called",
      "how many businesses it found",
      "how long it took and how it ended",
    ]) {
      expect(searchesBullet, said).toContain(said);
    }
  });

  it("say what a record never keeps", () => {
    for (const said of [
      "Never your IP address, a session, or anything else that says who sent it",
      "with a secret key drawn at random each day, held only in our server's memory and destroyed when the day ends",
      "no one, us included, can work a code back to an address or match it with another day's",
      "A search on this website's own pages is not recorded, nor are the reads of a search engine's crawler.",
      "with nothing of what it asked",
    ]) {
      expect(searchesBullet, said).toContain(said);
    }
    expect(privacy).toContain("an agent's searches are recorded as above");
    expect(privacy).toContain("each call's record keeps only the kind of assistant, as above");
    expect(privacy).not.toContain("which kind of assistant a session said it is; none of it is written down");
  });

  it("no longer say they are kept 90 days, with links or every number removed", () => {
    for (const gone of [
      "for 90 days, to improve search",
      "kept for 90 days, masked",
      "links and every other number taken out",
      "emails, numbers and links removed",
      "does not keep your searches",
      "are used to answer and then dropped",
    ]) {
      expect(privacy, gone).not.toContain(gone);
    }
    expect(privacy).toContain("never keeps who searched");
  });

  it("is what ADR-043 decides", () => {
    const adr = flat(read("docs/adr/043-agent-calls.md"));
    for (const said of [
      "**Kept without a time limit.** Nothing deletes a record.",
      "The words are kept as the agent typed them",
      "No IP address, no session id, no full user agent",
      "a card number, 13 to 19 digits that pass the Luhn check",
      "an IBAN, whole, in groups or split by dots, dashes or slashes",
      "drawn at random for each UTC day, held only in the network's memory, never written",
      "No page shows the record.",
    ]) {
      expect(adr, said).toContain(said);
    }
  });
});
