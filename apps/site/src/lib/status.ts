/**
 * What works today, what is being built and what is coming: one list, so a state changes in one
 * place. The status section reads it, every pill on the home page reads it, and the listing card
 * draws a door dashed when its door is not live yet.
 *
 * Wording: anything not live is a noun phrase or the future tense. "Agent to agent" appears only
 * as a coming item until delivery ships.
 */
export type State = "live" | "building" | "coming";

export interface Capability {
  id: string;
  label: string;
  state: State;
}

export const STATE_LABEL: Record<State, string> = {
  live: "Live",
  building: "Being built",
  coming: "Coming",
};

/** The date this list was last checked against the running network. */
export const UPDATED = "6 Oct 2026";

export const capabilities: readonly Capability[] = [
  { id: "directory", label: "Directory of businesses with a verified inbox", state: "live" },
  { id: "search", label: "Search it from your AI: MCP, REST or llms.txt", state: "live" },
  { id: "ranking", label: "Ranked by signed receipts under rules version 6; nobody can pay to rank", state: "live" },
  {
    id: "protocol",
    label: "Open protocol, MIT example network, network-check and SDK 0.2.0",
    state: "live",
  },
  { id: "inbox", label: "Open-source inbox, self-hosted", state: "live" },
  { id: "bot", label: "A public page on how our crawler behaves", state: "live" },
  {
    id: "crawler",
    label:
      "A crawler that finds businesses with other agent doors: MCP, A2A, UCP, ACP, OpenAPI; nothing it finds is listed yet",
    state: "building",
  },
  {
    id: "crawled",
    label:
      "Crawled businesses in the directory, with doors, levels, what they accept and a source and date on every fact",
    state: "coming",
  },
  { id: "self-serve", label: "Add, correct or remove your listing from your own AI", state: "coming" },
  { id: "fan-out", label: "One request to up to three businesses, agent to agent", state: "coming" },
  { id: "rules-doors", label: "Ranking rules for other doors", state: "coming" },
  { id: "hosted", label: "A hosted inbox", state: "coming" },
];

/** The state of one capability; a missing id is a typo, so it fails the build rather than lying. */
export function stateOf(id: string): State {
  const found = capabilities.find((c) => c.id === id);
  if (!found) throw new Error(`status.ts has no capability "${id}"`);
  return found.state;
}

/** Doors an agent can use to reach a business, and whether the directory lists each one today. */
export const DOORS: readonly { name: string; state: State }[] = [
  { name: "MCP", state: "live" },
  { name: "REST", state: "live" },
  { name: "OpenAPI", state: "live" },
  { name: "A2A", state: stateOf("crawled") },
  { name: "UCP", state: stateOf("crawled") },
  { name: "ACP", state: stateOf("crawled") },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "21 Sep 2026", in UTC, the same on every machine that builds the site. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
