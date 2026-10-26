import type { AreaSummary, AttachmentRef, Settings, WorkProfile } from "@surfingdog/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ownerCall } from "./api";
import type { Weekly } from "./types";

/**
 * Trades (ADR-039): where the business works, how it takes work, a request's files and its job tool,
 * as the owner sees them. The calls, the query hooks, and the few words the screens share, kept here so
 * they are tested once. Type-only imports from core: nothing of the server is bundled.
 */

export type AreaDoc = Settings["area"];
export type WorkDoc = Settings["work"];

/** How a country's postal codes are written, for the chooser: a start ("SW1") and a code it covers. */
export interface PostalShape {
  readonly example: string;
  readonly covers: string;
}

export interface WorkView {
  readonly area: AreaDoc;
  readonly work: WorkDoc;
  /** Whether this is a trade: it said where it works or how it takes work, or has a job tool. */
  readonly trade?: boolean | undefined;
  /** The countries whose postal codes are matched, each with how its codes are written. */
  readonly postal?: Readonly<Record<string, PostalShape>> | undefined;
  readonly public: { readonly area: AreaSummary; readonly work: WorkProfile | null };
  readonly job_tools: readonly {
    readonly id: string;
    readonly kind: string;
    readonly name: string;
    /** It can say the business's opening hours, to start from. */
    readonly starts?: boolean | undefined;
  }[];
  readonly expiring: readonly { readonly connection_id: string; readonly kind: string; readonly expires_at: string }[];
}

export type FileView = AttachmentRef & { readonly url: string; readonly expires_at: string };

export interface JobToolView {
  readonly mode: WorkDoc["jobTool"];
  readonly tools: readonly { readonly id: string; readonly kind: string; readonly name: string }[];
  readonly sent: readonly {
    readonly connection_id: string;
    readonly outcome: string;
    readonly external_id: string | null;
    readonly url: string | null;
  }[];
}

export interface PushOutcomeView {
  readonly connectorId: string;
  readonly kind: string;
  readonly status: "written" | "pending" | "refused" | "busy" | "skipped";
  readonly url?: string;
  readonly note: string;
}

const enc = encodeURIComponent;

/** What a job tool says of the business, to start from (`GET /v1/owner/integrations/:id/setup`). */
export interface ToolSetupView {
  readonly source: { readonly kind: string; readonly account: string; readonly readAt: number; readonly zone?: string };
  readonly hours?: Weekly | undefined;
}

export const tradesApi = {
  work: () => ownerCall<WorkView>("GET", "/v1/owner/work"),
  setup: (connectionId: string) => ownerCall<ToolSetupView>("GET", `/v1/owner/integrations/${enc(connectionId)}/setup`),
  files: (itemId: string) => ownerCall<{ files: FileView[] }>("GET", `/v1/owner/items/${enc(itemId)}/files`),
  jobTool: (itemId: string) => ownerCall<JobToolView>("GET", `/v1/owner/items/${enc(itemId)}/job-tool`),
  send: (itemId: string) =>
    ownerCall<{ outcomes: PushOutcomeView[] }>("POST", `/v1/owner/items/${enc(itemId)}/job-tool`, {
      body: {},
      idempotent: true,
    }),
};

export function useWork() {
  return useQuery({ queryKey: ["work"], queryFn: tradesApi.work, staleTime: 30_000 });
}

/** A request's files: the links work ten minutes, so they are read again before they run out. */
export function useItemFiles(itemId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["files", itemId],
    queryFn: () => tradesApi.files(itemId),
    enabled,
    staleTime: 8 * 60_000,
    refetchInterval: 8 * 60_000,
  });
}

export function useJobTool(itemId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["job-tool", itemId],
    queryFn: () => tradesApi.jobTool(itemId),
    enabled,
    staleTime: 15_000,
    // While a request is on its way into a job tool, look again until it has landed or was refused.
    refetchInterval: (q) =>
      q.state.data?.sent.some((s) => s.outcome === "pending" || s.outcome === "unknown") ? 10_000 : false,
  });
}

export function useSendToJobTool(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => tradesApi.send(itemId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["job-tool", itemId] }),
  });
}

/* --- words ------------------------------------------------------------------------ */

export const URGENCY_WORDS: Readonly<Record<string, string>> = {
  emergency: "Emergency",
  within_24h: "Within 24 h",
  this_week: "This week",
  flexible: "Flexible",
};

export const VISIT_WORDS: Readonly<Record<string, string>> = {
  needed: "Visit first",
  not_needed: "No visit needed",
  unsure: "Visit: not sure",
};

const TOOL_NAMES: Readonly<Record<string, string>> = {
  servicem8: "ServiceM8",
  housecallpro: "Housecall Pro",
  fergus: "Fergus",
  jobber: "Jobber",
};

export function toolName(kind: string): string {
  return TOOL_NAMES[kind] ?? kind;
}

/** Where a site stands against the area, as the item's line says it: "Inside your area · ≤ 10 km". */
export function areaLine(
  check: { status: string; by: string; within_km?: number | undefined } | undefined,
): string | null {
  if (!check) return null;
  if (check.by === "anywhere") return null;
  if (check.status === "inside")
    return check.within_km ? `Inside your area · ≤ ${check.within_km} km` : "Inside your area";
  if (check.status === "outside") return "Outside your area";
  return check.by === "radius" ? "Area not checked: no location sent" : "Area not checked: postal code not recognised";
}

/** What the mode sends, in the owner's words. */
export const MODE_WORDS: Readonly<Record<WorkDoc["jobTool"], { label: string; line: string }>> = {
  every: { label: "Every request", line: "Each request goes in as it arrives." },
  accepted: { label: "Only ones I take on", line: "A request goes in when you quote it, or press Send." },
  never: { label: "Never", line: "Nothing goes in on its own." },
};

/** The radius chips, in km. */
export const RADIUS_CHIPS = [5, 10, 25, 50, 100] as const;

/** A postal prefix as the server keeps it: capitals, no spaces or dashes. */
export function normalisePrefix(raw: string): string {
  return raw.toUpperCase().replace(/[\s.\-–—]/g, "");
}

/** The area in a sentence, as agents are told it (never the base). */
export function areaSentence(a: AreaSummary): string {
  const outside =
    a.outside === "decline" ? "Requests from outside are declined." : "You decide on requests from outside.";
  if (a.mode === "anywhere") return "Agents are told you work anywhere.";
  if (a.mode === "radius") return `Agents are told you work within ${a.radius_km} km. ${outside}`;
  const list = (a.postal ?? []).map((p) => `${p.prefix} (${p.country})`);
  return list.length
    ? `Agents are told you work in ${list.slice(0, 6).join(", ")}${list.length > 6 ? ` and ${list.length - 6} more` : ""}. ${outside}`
    : "Add a postal code to say where you work.";
}

/** How a stage is paid, in a few words. */
export function stageWhen(type: "immediate" | "deferred" | "at_property"): string {
  return type === "immediate" ? "Now" : type === "at_property" ? "On site" : "By a date";
}

/**
 * The amounts of a quote in stages, the last being the rest: the total less the stages before it. Null
 * for the last when the others come to the total or more, so the owner sees what to change.
 */
export function balanceOf(total: number, earlier: readonly number[]): number | null {
  const rest = total - earlier.reduce((n, v) => n + v, 0);
  return rest > 0 ? rest : null;
}

/** Whether prices are usually quoted before tax in a country (the US, Canada): the quote starts that way there. */
export function pricesBeforeTax(country: string | null | undefined): boolean {
  return country === "US" || country === "CA";
}

/**
 * Noon on a day in the business's own time zone, as an instant: when a stage is due, whatever zone the
 * owner's device is in. A zone the browser does not know is taken as UTC.
 */
export function noonIn(day: string, zone: string | undefined): string {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12, 0, 0);
  if (!zone) return new Date(guess).toISOString();
  try {
    // The zone's offset at that moment: how far its wall clock is from UTC's.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(guess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    return new Date(guess - (wall - guess)).toISOString();
  } catch {
    return new Date(guess).toISOString();
  }
}

/** Whether two weeks of opening hours are the same, day by day, whatever order their keys are in. */
export function sameWeek(
  a: Readonly<Record<string, readonly (readonly [string, string])[]>>,
  b: Readonly<Record<string, readonly (readonly [string, string])[]>>,
): boolean {
  const days = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const d of days) {
    const x = a[d] ?? [];
    const y = b[d] ?? [];
    if (x.length !== y.length) return false;
    if (x.some((r, i) => r[0] !== y[i]?.[0] || r[1] !== y[i]?.[1])) return false;
  }
  return true;
}

/* --- the setup's question: where a trade works ------------------------------------- */

export interface AreaDraft {
  readonly mode: "postal" | "radius" | null;
  readonly country: string;
  readonly postal: readonly { readonly country: string; readonly prefix: string }[];
  readonly radiusKm: number;
  readonly base: {
    readonly from: "device";
    readonly point: { lat: number; lng: number };
    readonly label: string;
  } | null;
}

export const WIZARD_RADII = [10, 25, 50] as const;

export function emptyArea(country: string): AreaDraft {
  return { mode: null, country, postal: [], radiusKm: 25, base: null };
}

/** What the setup saves of it: the area, or nothing when it was skipped or is not complete. */
export function areaDocOf(d: AreaDraft): { area: Record<string, unknown> } | null {
  if (d.mode === "postal" && d.postal.length > 0) return { area: { mode: "postal", postal: [...d.postal] } };
  if (d.mode === "radius" && d.base) return { area: { mode: "radius", radiusKm: d.radiusKm, base: d.base } };
  return null;
}

/** Whether the step can be left as it stands: a choice made whole, or none (skipped). */
export function areaReady(d: AreaDraft): boolean {
  return d.mode === null || areaDocOf(d) !== null;
}
