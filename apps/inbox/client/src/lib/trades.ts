import type { AreaSummary, AttachmentRef, Settings, WorkProfile } from "@surfingdog/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ownerCall } from "./api";
import type { Weekly } from "./types";

/**
 * Trades (ADR-034): where the business works, how it takes work, a request's files and its job tool,
 * as the owner sees them. The calls, the query hooks, and the few words the screens share, kept here so
 * they are tested once. Type-only imports from core: nothing of the server is bundled.
 */

export type AreaDoc = Settings["area"];
export type WorkDoc = Settings["work"];

export interface WorkView {
  readonly area: AreaDoc;
  readonly work: WorkDoc;
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
  return check.by === "radius" ? "Area not checked: no point for the site" : "Area not checked: postal code not read";
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
  return type === "immediate" ? "Now" : type === "at_property" ? "On the day" : "By a date";
}
