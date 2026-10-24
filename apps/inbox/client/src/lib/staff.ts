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

/** The name customers see, as the inbox reads it (core `publicNameOf`): the one chosen, whole, else the first word. */
export function shownName(name: string, publicName?: string | null): string {
  const chosen = publicName?.trim();
  if (chosen) return chosen;
  return name.trim().split(/\s+/u)[0] || "Staff";
}

/** One line of a booking's block on the day by staff: what it is, when it starts, or who it is for. */
export interface BlockLine {
  readonly id: "what" | "when" | "who";
  readonly clock?: string | undefined;
  readonly text: string;
}

/**
 * What a booking's block on the day by staff says, as far as its height allows: the start and the
 * service first (in a lane it shares with another booking, the service alone, so its name is not lost
 * behind the time, and the start under it), then the customer. A line that does not fit is left out,
 * never cut through: a block of half an hour is one line.
 */
export function blockLines(b: {
  readonly clock: string;
  readonly service: string;
  readonly customer?: string | null | undefined;
  /** The block's height in pixels: about 14.5 a line, under 8 of padding and border. */
  readonly height: number;
  /** Side by side with another booking: half the column or less. */
  readonly narrow: boolean;
}): BlockLine[] {
  const fits = Math.max(1, Math.floor((b.height - 8) / 14.5));
  const lines: BlockLine[] = b.narrow
    ? [
        { id: "what", text: b.service },
        { id: "when", clock: b.clock, text: "" },
      ]
    : [{ id: "what", clock: b.clock, text: b.service }];
  if (b.customer) lines.push({ id: "who", text: b.customer });
  return lines.slice(0, fits);
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

/**
 * Cancellation policies to start from, as the owner reads them, each label naming its fee; "custom" is
 * one set elsewhere, kept as it is. "Your usual policy": the business-wide cancellation window.
 */
export const POLICY_PRESETS: readonly {
  readonly key: string;
  readonly label: string;
  readonly policy: Policy | null;
}[] = [
  { key: "none", label: "Your usual policy", policy: null },
  {
    key: "free24",
    label: "Free until 24 h, then 50%",
    policy: {
      steps: [{ before: { hours: 24 }, fee: { kind: "none" } }],
      after: { kind: "percent", value: 50 },
      noShow: { kind: "full" },
    },
  },
  {
    key: "free48",
    label: "Free until 48 h, then 50%",
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

/** A share in the owner's words: "30%". */
export function percentText(value: number): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 1 }).format(value / 100);
  } catch {
    return `${value}%`;
  }
}

/** Said after a fee where a deposit the policy keeps may be more than it, as the inbox charges it. */
const OR_KEPT = " (or the deposit, if more)";

/**
 * A policy in a few words, for the service line and under its choice: "free until 24 h before · then
 * 50% · no-show: full price". A deposit the policy keeps is said as kept once cancelling is not free,
 * and beside every fee from then on, since the more of the two is charged.
 */
export function policyWords(p: Policy | null | undefined): string {
  if (!p) return "";
  const fee = (f: Policy["after"]) =>
    f.kind === "none"
      ? "free"
      : f.kind === "full"
        ? "full price"
        : f.kind === "percent"
          ? percentText(f.value ?? 0)
          : f.kind === "units"
            ? `${f.value ?? 1} visit`
            : "a fixed fee";
  const before = (s: Policy["steps"][number]) =>
    s.before.hours !== undefined ? `${s.before.hours} h` : `${s.before.days} days`;
  const keeps = p.deposit?.refundable === false;
  const lastFree = p.steps.reduce((at, s, i) => (s.fee.kind === "none" ? i : at), -1);
  const charged = (f: Policy["after"], i: number) =>
    `${fee(f)}${keeps && i > lastFree && f.kind !== "full" ? OR_KEPT : ""}`;
  const steps = p.steps.map((s, i) =>
    s.fee.kind === "none" ? `free until ${before(s)} before` : `${charged(s.fee, i)} until ${before(s)} before`,
  );
  const kept = keeps && p.after.kind === "none";
  return [
    ...steps,
    kept ? "then the deposit is kept" : `then ${charged(p.after, p.steps.length)}`,
    `no-show: ${fee(p.noShow)}`,
  ].join(" · ");
}

export const DEPOSIT_PRESETS: readonly {
  readonly key: string;
  readonly label: string;
  readonly rule: DepositRule | null;
}[] = [
  { key: "none", label: "No deposit", rule: null },
  { key: "p20", label: "20%", rule: { kind: "percent", value: 20 } },
  { key: "p50", label: "50%", rule: { kind: "percent", value: 50 } },
  { key: "fixed", label: "A fixed amount", rule: { kind: "amount", value: 0 } },
];

/** The chip a service's deposit is on; "custom" for a share no chip holds (30%), kept as it is. */
export function depositKey(rule: DepositRule | null | undefined): string {
  if (!rule) return "none";
  if (rule.kind === "amount") return "fixed";
  return DEPOSIT_PRESETS.find((p) => p.rule?.kind === "percent" && p.rule.value === rule.value)?.key ?? "custom";
}

/**
 * A booking's dated policy, for the owner: each step's last moment in the business's zone, and its fee.
 * A deposit the policy keeps is said as kept once cancelling is no longer free, as the customer read it,
 * and beside a smaller fee from then on.
 */
export function datedSteps(
  dated: DatedPolicy,
  money: (m: Money) => string,
  when: (iso: string) => string,
  opts: { readonly depositKept?: boolean; readonly deposit?: Money | undefined } = {},
): string[] {
  const lastFree = dated.steps.reduce((at, s, i) => (s.fee.value === 0 ? i : at), -1);
  const deposit = opts.deposit;
  const charged = (m: Money, i: number) =>
    `${money(m)}${
      opts.depositKept === true &&
      i > lastFree &&
      !(deposit && deposit.currency === m.currency && m.value >= deposit.value)
        ? OR_KEPT
        : ""
    }`;
  const out = dated.steps.map((s, i) =>
    s.fee.value === 0 ? `Free until ${when(s.until)}` : `${charged(s.fee, i)} until ${when(s.until)}`,
  );
  const kept = opts.depositKept === true && dated.after.value === 0;
  const after = kept
    ? "the deposit is kept"
    : dated.after.value === 0
      ? "free"
      : charged(dated.after, dated.steps.length);
  // Booked after every step had passed: only what cancelling costs now.
  out.push(
    dated.steps.length > 0
      ? `then ${after}`
      : kept
        ? "Cancelling keeps the deposit"
        : dated.after.value === 0
          ? "Free to cancel"
          : `Cancelling costs ${after}`,
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
