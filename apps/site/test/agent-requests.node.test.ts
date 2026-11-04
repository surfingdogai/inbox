import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_REQUESTS_HREF,
  AGENT_REQUESTS_WAIT,
  agentRequestsDate,
  agentRequestsLine,
  agentRequestsParts,
  paintAgentRequests,
  readAgentRequests,
} from "../src/lib/agent-requests";

/**
 * The requests AI agents sent the network, as the site shows them: one line from the "agent_requests"
 * block of GET /v1/stats beside the live counts, hidden without a count, linking to the note on what
 * counts; and the note, the privacy page and ADR-043 saying what the network's count does. Checked
 * without a build, from the sources the build reads.
 */

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const fmt = new Intl.NumberFormat("en").format;

/** The network's answer on 4 November 2026, as the line reads it. */
const SAMPLE = {
  status: { api: "ok" },
  network: { members: 3, members_with_receipts: 1, receipts: 9, receipts_30d: 4 },
  agent_requests: { window_days: 7, requests: 173, agents: 23, as_of: "2026-11-04T12:00:00Z" },
};
const block = (b: Record<string, unknown>) => ({ ...SAMPLE, agent_requests: { ...SAMPLE.agent_requests, ...b } });

describe("the agents' line", () => {
  it("is rendered from the network's block", () => {
    const x = readAgentRequests(SAMPLE);
    expect(x).toEqual({ windowDays: 7, requests: 173, agents: 23, asOf: "2026-11-04T12:00:00Z" });
    if (!x) return;
    expect(agentRequestsLine(x, fmt)).toBe(
      "173 requests from AI agents in the last 7 days · 23 agents on the busiest day",
    );
    expect(agentRequestsLine({ ...x, requests: 12_408, agents: 1_204 }, fmt)).toBe(
      "12,408 requests from AI agents in the last 7 days · 1,204 agents on the busiest day",
    );
  });

  it("is painted as parts, so a phone can stack them", () => {
    type Node = { className: string; textContent: string };
    const made: Node[] = [];
    const el = {
      ownerDocument: {
        createElement: () => {
          const n = { className: "", textContent: "" };
          made.push(n);
          return n;
        },
      },
      kids: [] as Node[],
      replaceChildren(...kids: Node[]) {
        this.kids = kids;
      },
    };
    const x = readAgentRequests(SAMPLE);
    if (!x) throw new Error("no sample");
    paintAgentRequests(el as unknown as HTMLElement, x, fmt);
    expect(el.kids.map((k) => [k.className, k.textContent])).toEqual([
      ["ar-part", "173 requests from AI agents in the last 7 days"],
      ["ar-sep", " · "],
      ["ar-part", "23 agents on the busiest day"],
    ]);
    expect(el.kids.map((k) => k.textContent).join("")).toBe(agentRequestsLine(x, fmt));
  });

  it("says one as one, and leaves out the agents when none could be counted", () => {
    const one = { windowDays: 7, requests: 1, agents: 1, asOf: "2026-11-04T12:00:00Z" };
    expect(agentRequestsParts(one, fmt)).toEqual([
      "1 request from an AI agent in the last 7 days",
      "1 agent on the busiest day",
    ]);
    expect(agentRequestsLine({ ...one, requests: 4, agents: 0 }, fmt)).toBe(
      "4 requests from AI agents in the last 7 days",
    );
    expect(agentRequestsLine({ ...one, requests: 2, windowDays: 1 }, fmt)).toBe(
      "2 requests from AI agents in the last day · 1 agent on the busiest day",
    );
  });

  it("is hidden at zero, and without a count the network took", () => {
    expect(readAgentRequests(block({ requests: 0, agents: 0 }))).toBeNull();
    expect(readAgentRequests(null)).toBeNull();
    expect(readAgentRequests({ status: { api: "ok" } })).toBeNull();
    // A network that has not counted yet, or a block that is not whole, is no count.
    expect(readAgentRequests(block({ as_of: "0001-01-01T00:00:00Z" }))).toBeNull();
    expect(readAgentRequests(block({ as_of: "soon" }))).toBeNull();
    expect(readAgentRequests(block({ requests: "173" }))).toBeNull();
    expect(readAgentRequests(block({ requests: -1 }))).toBeNull();
    expect(readAgentRequests(block({ agents: 2.5 }))).toBeNull();
    expect(readAgentRequests(block({ window_days: 0 }))).toBeNull();
    expect(readAgentRequests({ ...SAMPLE, agent_requests: null })).toBeNull();
    // A key added later beside these (the people's-assistants count) changes nothing here.
    expect(readAgentRequests(block({ assistants: { requests: 2 } }))?.requests).toBe(173);
  });

  it("sits hidden beside the live counts until the browser reads a count, and links to the note", () => {
    const home = read("apps/site/src/components/DirectoryCounts.astro");
    expect(home).toContain(
      '<p class="c-agents" data-agents hidden><a class="c-link" href={AGENT_REQUESTS_HREF}></a></p>',
    );
    expect(home).toContain("const requests = readAgentRequests(stats);");
    expect(home).toContain("paintAgentRequests(agentsLink, requests, fmt.format);");
    expect(home).toMatch(/if \(requests && agents && agentsLink\) \{[\s\S]*?agents\.hidden = false;\s+\}/);
    const live = read("apps/site/src/components/LiveMetrics.astro");
    expect(live).toContain(
      '<p class="agents-line" data-agent-requests hidden><a class="link" href={AGENT_REQUESTS_HREF}></a></p>',
    );
    expect(live).toContain("agentsLine.hidden = !requests;");
    expect(live).toContain("agents(null);");
    expect(AGENT_REQUESTS_HREF).toBe("/agent-requests/");
    expect(read("apps/site/src/components/Footer.astro")).toContain(
      '{ href: "/agent-requests/", label: "Agent requests" }',
    );
  });
});

describe("the note on what counts", () => {
  const page = flat(read("apps/site/src/pages/agent-requests.astro"));

  it("fits a search result and dates the count it was built with", () => {
    const title = page.match(/const TITLE = "([^"]+)"/)?.[1] ?? "";
    const description = page.match(/const DESCRIPTION = "([^"]+)"/)?.[1] ?? "";
    expect(`${title} · Surfing Dog`.length).toBeLessThanOrEqual(60);
    expect(description.length).toBeGreaterThanOrEqual(80);
    expect(description.length).toBeLessThanOrEqual(155);
    expect(page).toContain('"@type": "WebPage"');
    expect(agentRequestsDate("2026-11-04T12:00:00Z")).toBe("4 November 2026, 12:00 UTC");
    expect(agentRequestsDate("2026-11-04T09:05:00Z")).toBe("4 November 2026, 09:05 UTC");
    expect(page).toContain("AGENT_REQUESTS_WAIT");
    expect(AGENT_REQUESTS_WAIT).not.toMatch(/\d/);
  });

  it("says what counts, what does not, and what an agent is, as the network counts them", () => {
    for (const said of [
      "A search, a lookup, a check of a website, or a request to a business, sent by an AI agent over MCP, A2A or the REST API.",
      "Each tool call is one request, answered or not.",
      "Our own traffic: our tests, our monitors and our crawler.",
      "connecting, listing the tools, discovery, pings and asking after a task. And calls to a tool the network does not have.",
      "A caller whose only requests in a day were the same one, five times or more.",
      "so there the same tool counts as the same request",
      "People searching on this website, and search engines' crawlers: they are not agents.",
      "We count an agent by the network it calls from (its address with the last part left off), under a code that changes every day",
      "a week's agents cannot be counted, so we give the busiest day's",
      "so no agent counts twice",
      "Many assistants calling from one company's servers share a network, and count as one.",
      "On 4 November 2026, most requests came from directories and testing tools, not yet from people's own assistants.",
      "A separate count of the requests from people's assistants is planned.",
      "we publish only these two totals: never a search, a business, or a caller",
      "The count is taken at most once an hour.",
    ]) {
      expect(page, said).toContain(said);
    }
    // No claim it cannot back: no "users", no "people" counted as such, no "this week".
    expect(page).not.toMatch(/this week|\busers\b|unique visitors/i);
  });

  it("is what the privacy page and ADR-043 say is published", () => {
    const privacy = flat(read("apps/site/src/pages/privacy.astro"));
    expect(privacy).toContain(
      "Of these records, two totals are public, on this website and in the network's API: how many requests agents sent in the last seven days, and how many different callers came on the busiest day. They name no one and no search;",
    );
    expect(privacy).toContain('<a class="link" href="/agent-requests/">its own page</a>');
    expect(privacy).toContain('const UPDATED = "4 November 2026";');
    const adr = flat(read("docs/adr/043-agent-calls.md"));
    for (const said of [
      "No page shows the record. Two totals of it are public (amendment of 4 November 2026, below).",
      '## Amendment, 4 November 2026: two public totals The founder\'s decision: "Show real requests, labelled".',
      "Totals only: never a record, a search's words, a business or a caller.",
      "a caller whose every such call in its day was the same tool with the same words, five times or more",
      "so no caller counts twice",
    ]) {
      expect(adr, said).toContain(said);
    }
  });
});
