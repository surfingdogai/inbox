import type { DatedPolicy, DepositRule, Policy, StaffDay, StaffView } from "@surfingdog/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ownerCall } from "./api";
import type { Money, Weekly } from "./types";

/**
 * Staff in the owner app (ADR-035): who works here, what each gives at what price and length, their
 * own hours and calendar; a day by member of staff; and a service's terms — add-ons, a deposit, a
 * cancellation policy, what must come first. Its own endpoints (`/v1/owner/staff`), beside `api`.
 */

export type { StaffDay, StaffView };

export interface StaffServiceBody {
  readonly service_id: string;
  readonly price_override?: number | null;
  readonly duration_override_min?: number | null;
}

export interface StaffBody {
  readonly name?: string;
  readonly public_name?: string | null;
  readonly photo?: string | null;
  readonly active?: boolean;
  readonly sort?: number;
  readonly services?: readonly StaffServiceBody[];
  readonly hours?: Weekly | null;
}

export const staffApi = {
  list: () => ownerCall<{ items: StaffView[] }>("GET", "/v1/owner/staff"),
  create: (body: StaffBody) => ownerCall<StaffView>("POST", "/v1/owner/staff", { body, idempotent: true }),
  patch: (id: string, body: StaffBody) =>
    ownerCall<StaffView>("PATCH", `/v1/owner/staff/${encodeURIComponent(id)}`, { body, idempotent: true }),
  archive: (id: string) => ownerCall<StaffView>("DELETE", `/v1/owner/staff/${encodeURIComponent(id)}`),
  day: (date: string) => ownerCall<StaffDay>("GET", "/v1/owner/staff/day", { query: { date } }),
  tie: (connectionId: string, resourceId: string | null) =>
    ownerCall<unknown>("PATCH", `/v1/owner/integrations/${encodeURIComponent(connectionId)}`, {
      body: { resource_id: resourceId },
      idempotent: true,
    }),
};

const KEY = ["staff"] as const;

export function useStaff() {
  return useQuery({ queryKey: KEY, queryFn: staffApi.list, staleTime: 30_000 });
}

export function useStaffDay(date: string, enabled: boolean) {
  return useQuery({ queryKey: ["staff-day", date], queryFn: () => staffApi.day(date), enabled, staleTime: 30_000 });
}

export function useStaffWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id?: string; body: StaffBody; archive?: boolean }) =>
      input.archive && input.id
        ? staffApi.archive(input.id)
        : input.id
          ? staffApi.patch(input.id, input.body)
          : staffApi.create(input.body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["staff-day"] });
    },
  });
}

export function useTieCalendar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { connectionId: string; resourceId: string | null }) =>
      staffApi.tie(input.connectionId, input.resourceId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
}

/** Two letters for someone with no photo: "Mei Chen" → "MC", "Ọlá" → "Ọ". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const first = Array.from(parts[0] ?? "")[0] ?? "";
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1] ?? "")[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

/** The name customers see: the first word, as the inbox reads it (core `firstName`). */
export function shownName(name: string, publicName?: string | null): string {
  const word = (publicName?.trim() || name).trim().split(/\s+/u)[0] ?? "";
  return word || "Staff";
}

/**
 * A photo made small enough to keep: drawn at most 320 pixels a side as a JPEG (which carries none of
 * the camera's metadata), smaller in quality until it is under 32 KB. The inbox reads it again.
 */
export async function smallPhoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That file is not a picture."));
      i.src = url;
    });
    const scale = Math.min(1, 320 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of [0.82, 0.7, 0.55, 0.4]) {
      const data = canvas.toDataURL("image/jpeg", q);
      if (data.length * 0.75 < 32 * 1024) return data;
    }
    throw new Error("That picture is too detailed to keep small: choose another.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* --- a service's terms ---------------------------------------------------------- */

/** Cancellation policies to start from, as the owner reads them; "custom" opens the steps. */
export const POLICY_PRESETS: readonly {
  readonly key: string;
  readonly label: string;
  readonly policy: Policy | null;
}[] = [
  { key: "none", label: "The salon's usual rule", policy: null },
  {
    key: "free24",
    label: "Free until 24 h before",
    policy: {
      steps: [{ before: { hours: 24 }, fee: { kind: "none" } }],
      after: { kind: "percent", value: 50 },
      noShow: { kind: "full" },
    },
  },
  {
    key: "free48",
    label: "Free until 48 h, then 50 %",
    policy: {
      steps: [{ before: { hours: 48 }, fee: { kind: "none" } }],
      after: { kind: "percent", value: 50 },
      noShow: { kind: "full" },
    },
  },
  {
    key: "keep",
    label: "Deposit kept under 24 h",
    policy: {
      steps: [{ before: { hours: 24 }, fee: { kind: "none" } }],
      after: { kind: "none" },
      noShow: { kind: "full" },
      deposit: { refundable: false },
    },
  },
];

export function policyKey(p: Policy | null | undefined): string {
  if (!p) return "none";
  const s = JSON.stringify(p);
  return POLICY_PRESETS.find((x) => x.policy && JSON.stringify(x.policy) === s)?.key ?? "custom";
}

/** A policy in a few words, for the service line: "Free until 24 h · then 50 % · no-show: full". */
export function policyWords(p: Policy | null | undefined): string {
  if (!p) return "";
  const fee = (f: Policy["after"]) =>
    f.kind === "none"
      ? "free"
      : f.kind === "full"
        ? "full price"
        : f.kind === "percent"
          ? `${f.value ?? 0} %`
          : f.kind === "units"
            ? `${f.value ?? 1} visit`
            : "a fixed fee";
  const steps = p.steps.map((s) =>
    s.fee.kind === "none"
      ? `free until ${s.before.hours !== undefined ? `${s.before.hours} h` : `${s.before.days} days`} before`
      : `${fee(s.fee)} until ${s.before.hours ?? s.before.days}`,
  );
  return [...steps, `then ${fee(p.after)}`, `no-show: ${fee(p.noShow)}`].join(" · ");
}

export const DEPOSIT_PRESETS: readonly {
  readonly key: string;
  readonly label: string;
  readonly rule: DepositRule | null;
}[] = [
  { key: "none", label: "No deposit", rule: null },
  { key: "p20", label: "20 %", rule: { kind: "percent", value: 20 } },
  { key: "p50", label: "50 %", rule: { kind: "percent", value: 50 } },
  { key: "fixed", label: "A fixed amount", rule: { kind: "amount", value: 0 } },
];

export function depositKey(rule: DepositRule | null | undefined): string {
  if (!rule) return "none";
  if (rule.kind === "amount") return "fixed";
  return DEPOSIT_PRESETS.find((p) => p.rule?.kind === "percent" && p.rule.value === rule.value)?.key ?? "p20";
}

/** A booking's dated policy, for the owner: each step's last moment in the business's zone, and its fee. */
export function datedSteps(dated: DatedPolicy, money: (m: Money) => string, when: (iso: string) => string): string[] {
  const out = dated.steps.map((s) =>
    s.fee.value === 0 ? `Free until ${when(s.until)}` : `${money(s.fee)} until ${when(s.until)}`,
  );
  const after = dated.after.value === 0 ? "free" : money(dated.after);
  // Booked after every step had passed: only what cancelling costs now.
  out.push(
    dated.steps.length > 0 ? `then ${after}` : dated.after.value === 0 ? "Free to cancel" : `Cancelling costs ${after}`,
  );
  out.push(`no-show ${money(dated.noShow)}`);
  return out;
}

/** Minutes since local midnight of an instant in a zone, for placing it on a day's column. */
export function minutesIn(iso: string, zone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(iso));
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return h * 60 + m;
  } catch {
    return 0;
  }
}

/** Today's date in a zone, YYYY-MM-DD. */
export function todayIn(zone: string, now = Date.now()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}
