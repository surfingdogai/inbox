/**
 * The requests AI agents sent the network, as the site says them: the "agent_requests" block of
 * GET /v1/stats (the network's stats_agents.go), read into one short line. Totals only: the block
 * never names a business, a search or a caller. What it counts, and what it leaves out, is the note
 * at AGENT_REQUESTS_HREF, and the line always links to it.
 *
 * A line is shown only for a count the network took: no block, a malformed one, a count from before
 * 2026 (the zero time), or no requests at all is no line, never a 0. A separate count of the
 * requests from people's own assistants is planned; it is to come as one more key of the block, read
 * here beside these, so the line can grow a part without changing what it says now.
 */

/** The note on what counts. */
export const AGENT_REQUESTS_HREF = "/agent-requests/";

/** What the note says while it has no count to show (none read, or no requests). */
export const AGENT_REQUESTS_WAIT = "The count appears here once the network has one to show.";

/** The block, read. `agents` is the busiest day's distinct callers: a week's cannot be counted. */
export interface AgentRequests {
  windowDays: number;
  requests: number;
  agents: number;
  asOf: string;
}

/** Counts taken before this are no counts: the zero time is what a network that has none sends. */
const EARLIEST = Date.parse("2026-01-01T00:00:00Z");

const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The block, when it is there, whole and counted, with at least one request; anything else is null. */
export function readAgentRequests(stats: unknown): AgentRequests | null {
  if (!stats || typeof stats !== "object") return null;
  const b = (stats as { agent_requests?: unknown }).agent_requests;
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  if (!whole(o.window_days) || o.window_days < 1 || !whole(o.requests) || !whole(o.agents)) return null;
  if (typeof o.as_of !== "string") return null;
  const at = Date.parse(o.as_of);
  if (Number.isNaN(at) || at < EARLIEST) return null;
  if (o.requests === 0) return null;
  return { windowDays: o.window_days, requests: o.requests, agents: o.agents, asOf: o.as_of };
}

const days = (n: number) => (n === 1 ? "in the last day" : `in the last ${n} days`);

/**
 * The line's parts, in order: "173 requests from AI agents in the last 7 days", then "23 agents on
 * the busiest day" (left out when no caller could be counted).
 */
export function agentRequestsParts(x: AgentRequests, format: (n: number) => string): string[] {
  const head =
    x.requests === 1
      ? `1 request from an AI agent ${days(x.windowDays)}`
      : `${format(x.requests)} requests from AI agents ${days(x.windowDays)}`;
  if (x.agents === 0) return [head];
  return [head, x.agents === 1 ? "1 agent on the busiest day" : `${format(x.agents)} agents on the busiest day`];
}

/** The line as one string: "173 requests from AI agents in the last 7 days · 23 agents on the busiest day". */
export function agentRequestsLine(x: AgentRequests, format: (n: number) => string): string {
  return agentRequestsParts(x, format).join(" · ");
}

/**
 * Writes the line into el: each part in a span of its own (`ar-part`) and a dot between them
 * (`ar-sep`), as the site's other dotted lines read, so where the screen is narrow the parts can stack
 * and no dot hangs at a line's end.
 */
export function paintAgentRequests(el: HTMLElement, x: AgentRequests, format: (n: number) => string): void {
  const doc = el.ownerDocument;
  el.replaceChildren(
    ...agentRequestsParts(x, format).flatMap((text, i) => {
      const part = doc.createElement("span");
      part.className = "ar-part";
      part.textContent = text;
      if (i === 0) return [part];
      const sep = doc.createElement("span");
      sep.className = "ar-sep";
      sep.textContent = " · ";
      return [sep, part];
    }),
  );
}

/** The day and time a count was taken, as the note dates it: "4 November 2026, 12:00 UTC". */
export function agentRequestsDate(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}
