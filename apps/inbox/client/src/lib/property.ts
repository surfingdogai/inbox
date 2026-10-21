import type { NightsGrid, OwnerSetup, TodayView } from "@surfingdog/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ownerCall } from "./api";
import { formatMoney } from "./format";
import type { Item } from "./types";

/**
 * A place to stay, as its owner sets it up and runs it (ADR-033 §11, S1–S16): the calls, the query
 * hooks, and the few words and sums the screens share, kept here so they are tested once.
 */

export type { NightsGrid, OwnerSetup, TodayView };
export type PropertyView = NonNullable<OwnerSetup["setup"]>;
export type StayPayload = Extract<Item, { type: "stay" }>["payload"];
export type StayQuoteView = NonNullable<StayPayload["quote"]>;
type Body = Record<string, unknown>;

const enc = encodeURIComponent;

export const propertyApi = {
  setup: (id?: string) => ownerCall<OwnerSetup>("GET", "/v1/owner/property", { query: { id } }),
  save: (body: Body) => ownerCall<{ id: string }>("PUT", "/v1/owner/property", { body, idempotent: true }),
  room: (body: Body) => ownerCall<{ id: string }>("POST", "/v1/owner/property/rooms", { body, idempotent: true }),
  archiveRoom: (id: string) =>
    ownerCall<{ archived: true }>("DELETE", `/v1/owner/property/rooms/${enc(id)}`, { idempotent: true }),
  plan: (body: Body) => ownerCall<{ id: string }>("POST", "/v1/owner/property/rate-plans", { body, idempotent: true }),
  rates: (body: Body | Body[]) => ownerCall<{ saved: true }>("PUT", "/v1/owner/property/rates", { body }),
  fees: (body: Body) => ownerCall<{ saved: true }>("PUT", "/v1/owner/property/fees", { body }),
  extra: (body: Body) => ownerCall<{ id: string }>("POST", "/v1/owner/property/extras", { body, idempotent: true }),
  allotment: (body: Body) => ownerCall<{ saved: true }>("PUT", "/v1/owner/property/allotments", { body }),
  closure: (body: Body) => ownerCall<{ saved: true }>("PUT", "/v1/owner/property/closures", { body }),
  calendar: (body: Body) => ownerCall<{ saved: boolean }>("PUT", "/v1/owner/property/calendars", { body }),
  nights: (from?: string, days = 14) =>
    ownerCall<NightsGrid>("GET", "/v1/owner/property/nights", { query: { from, days } }),
  today: (date?: string) => ownerCall<TodayView>("GET", "/v1/owner/property/today", { query: { date } }),
  sync: () => ownerCall<{ rows: number }>("POST", "/v1/owner/property/sync", { body: {} }),
  systemProperties: (connectorId: string) =>
    ownerCall<SystemProperties>("GET", `/v1/owner/property/system/${enc(connectorId)}`),
  mapSystem: (body: Body) =>
    ownerCall<{ property_id: string; rooms: number }>("POST", "/v1/owner/property/system", {
      body,
      idempotent: true,
    }),
  draftQuote: (
    itemId: string,
    rooms?: readonly { index: number; room_type_id: string; rate_plan_id?: string }[],
    price?: { value: number; currency: string },
  ) =>
    ownerCall<{ quote: StayQuoteView | null; reason?: string; lang?: string }>(
      "POST",
      `/v1/owner/stays/${enc(itemId)}/draft-quote`,
      { body: { ...(rooms ? { rooms } : {}), ...(price ? { price } : {}) } },
    ),
};

export interface SystemProperty {
  readonly id: string;
  readonly name: string;
  readonly rooms: readonly {
    id: string;
    name: string;
    units: number;
    /**
     * The system holds no price for it (`true`): never offered from here until it has one; or only prices
     * set by the number of guests or the stay (`rules`): guests ask first, and the owner confirms each.
     */
    unpriced?: true | "rules";
    /** What the system adds to its price: the owner adds the same in Taxes & fees. */
    charges?: readonly ("cleaning" | "tax" | "deposit" | "extra")[];
  }[];
}

/** What a property system shows to match: its properties and rooms, and where its prices are set there. */
export interface SystemProperties {
  readonly prices_at: string | null;
  readonly properties: readonly SystemProperty[];
}

const CHARGE_WORDS = { cleaning: "a cleaning fee", tax: "tax", deposit: "a security deposit", extra: "an extra" };

/** "a cleaning fee and tax": the charges a system adds to a room, in a few words. */
export function chargeWords(charges: readonly (keyof typeof CHARGE_WORDS)[]): string {
  const words = charges.map((c) => CHARGE_WORDS[c]);
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : (words[0] ?? "");
}

export const pk = {
  setup: ["property"] as const,
  nights: (from: string | undefined, days: number) => ["property", "nights", from ?? "", days] as const,
  today: ["property", "today"] as const,
  system: (id: string) => ["property", "system", id] as const,
};

/** The property as set up, or null when there is none yet (an inbox that is not a place to stay). */
export function useProperty(enabled = true) {
  return useQuery({ queryKey: pk.setup, queryFn: () => propertyApi.setup(), staleTime: 30_000, enabled });
}

export function useNights(from: string | undefined, days: number, enabled = true) {
  return useQuery({
    queryKey: pk.nights(from, days),
    queryFn: () => propertyApi.nights(from, days),
    enabled,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

export function useToday(enabled: boolean) {
  return useQuery({ queryKey: pk.today, queryFn: () => propertyApi.today(), enabled, staleTime: 60_000 });
}

export function useSystemProperties(connectorId: string | null) {
  return useQuery({
    queryKey: pk.system(connectorId ?? ""),
    queryFn: () => propertyApi.systemProperties(connectorId ?? ""),
    enabled: connectorId !== null,
    staleTime: 60_000,
  });
}

/** Any write to the property: the setup, the Nights grid and Today read again after it. */
export function usePropertyWrite<A>(fn: (arg: A) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["property"] });
      void qc.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
}

/**
 * The plan a first price goes on, from the wizard or an empty Rates tab: room only, free to cancel until
 * 7 days before arrival, nothing now, the rest at the property.
 */
export const STANDARD_PLAN = {
  name: "Standard",
  meal: "room_only",
  policy: { preset: "free_until", days: 7, after: "first_night", no_show: "full" },
  deposit: { kind: "none" },
  balance: { when: "at_property" },
  guarantee: "none",
} as const;

// ——— Words ————————————————————————————————————————————————————————————————————————————————

export const KIND_WORDS: Readonly<Record<string, string>> = {
  hotel: "Hotel",
  bnb: "Bed and breakfast",
  guesthouse: "Guesthouse",
  hostel: "Hostel",
  rental: "Holiday rental",
  apartment: "Apartment",
  campsite: "Campsite",
  ryokan: "Ryokan",
  other: "Another kind",
};

export const BED_WORDS: Readonly<Record<string, string>> = {
  double: "Double",
  single: "Single",
  queen: "Queen",
  king: "King",
  bunk: "Bunk",
  sofa_bed: "Sofa bed",
  futon: "Futon",
  cot: "Cot",
};

export const AMENITY_WORDS: Readonly<Record<string, string>> = {
  private_bathroom: "Private bathroom",
  air_conditioning: "Air conditioning",
  heating: "Heating",
  kitchen: "Kitchen",
  balcony: "Balcony",
  sea_view: "Sea view",
  desk: "Desk",
  wifi: "Wi-Fi",
  washer: "Washer",
  parking: "Parking",
  step_free: "Step-free",
  onsen: "Onsen",
};

export const MEAL_WORDS: Readonly<Record<string, string>> = {
  room_only: "Room only",
  breakfast: "Breakfast included",
  half_board: "Half board",
  full_board: "Full board",
  all_inclusive: "All inclusive",
};

export const RULE_WORDS: Readonly<Record<string, string>> = {
  no_smoking: "No smoking",
  no_parties: "No parties",
  quiet_hours: "Quiet hours",
  no_visitors_after: "No visitors late",
  shoes_off: "Shoes off inside",
};

export const EXTRA_WORDS: Readonly<Record<string, string>> = {
  breakfast: "Breakfast",
  parking: "Parking",
  cot: "Cot",
  late_checkout: "Late check-out",
  early_checkin: "Early check-in",
  pet: "Pet",
  towels: "Towels",
  other_on_site: "Something else here",
};

export const BASIS_WORDS: Readonly<Record<string, string>> = {
  per_stay: "per stay",
  per_night: "per night",
  per_room_night: "per room, per night",
  per_person_night: "per guest, per night",
  percent_of_room: "of the room price",
};

/** The free-cancellation choices, one press each: what an owner says, as the inbox keeps it. */
export const FREE_DAYS = [1, 2, 3, 7, 14, 30] as const;
export type AfterFee = "first_night" | "half" | "full";
export type NoShowFee = "first_night" | "full";

export interface PolicyChoice {
  readonly preset: "free_until" | "non_refundable" | "custom";
  readonly days?: (typeof FREE_DAYS)[number];
  readonly after?: AfterFee;
  readonly no_show?: NoShowFee;
}

/** "free_until:7:first_night:full" as the choice it was made from. */
export function policyChoiceOf(preset: string): PolicyChoice {
  if (preset === "non_refundable") return { preset: "non_refundable" };
  const [name, days, after, noShow] = preset.split(":");
  if (name === "free_until") {
    const d = Number(days) as (typeof FREE_DAYS)[number];
    return {
      preset: "free_until",
      days: FREE_DAYS.includes(d) ? d : 7,
      after: (["first_night", "half", "full"].includes(after ?? "") ? after : "first_night") as AfterFee,
      no_show: (noShow === "first_night" ? "first_night" : "full") as NoShowFee,
    };
  }
  return { preset: "custom" };
}

const AFTER_WORDS: Readonly<Record<AfterFee, string>> = {
  first_night: "the first night",
  half: "half the stay",
  full: "the whole stay",
};

/** A policy in one sentence, as a guest reads it: "Free to cancel until 7 days before; after that, the first night." */
export function policyWords(choice: PolicyChoice): string {
  if (choice.preset === "non_refundable") return "Non-refundable: cancelling costs the whole stay.";
  if (choice.preset === "custom") return "Your own steps.";
  const days = choice.days ?? 7;
  const after = AFTER_WORDS[choice.after ?? "first_night"];
  const noShow = choice.no_show === "first_night" ? "the first night" : "the whole stay";
  return `Free to cancel until ${days} day${days === 1 ? "" : "s"} before arrival; after that, ${after}. A no-show costs ${noShow}.`;
}

export interface DepositChoice {
  readonly kind: "none" | "first_night" | "percent" | "full";
  readonly value?: number;
}
export interface BalanceChoice {
  readonly when: "at_property" | "days_before";
  readonly days?: number;
}

/** How a stay on a plan is paid, in one line: "20% now, the rest 7 days before arrival". */
export function paymentWords(deposit: DepositChoice, balance: BalanceChoice, guarantee: "none" | "card"): string {
  const now =
    deposit.kind === "none"
      ? guarantee === "card"
        ? "A card to hold the stay, nothing taken now"
        : "Nothing now"
      : deposit.kind === "first_night"
        ? "The first night now"
        : deposit.kind === "full"
          ? "Everything now"
          : `${deposit.value ?? 0}% now`;
  if (deposit.kind === "full") return now;
  const rest =
    balance.when === "days_before"
      ? `the rest ${balance.days ?? 7} day${balance.days === 1 ? "" : "s"} before arrival`
      : "the rest at the property";
  return `${now}, ${rest}`;
}

/** Monday 1 … Sunday 64, as the rates and the rooms kept for direct guests count days. */
export const WEEKDAYS = [
  { bit: 1, short: "Mon" },
  { bit: 2, short: "Tue" },
  { bit: 4, short: "Wed" },
  { bit: 8, short: "Thu" },
  { bit: 16, short: "Fri" },
  { bit: 32, short: "Sat" },
  { bit: 64, short: "Sun" },
] as const;
export const EVERY_DAY = 127;

export function weekdayWords(mask: number): string {
  if (mask === EVERY_DAY) return "every night";
  if (mask === 48) return "Friday and Saturday nights";
  if (mask === 31) return "Sunday to Thursday nights";
  return WEEKDAYS.filter((d) => mask & d.bit)
    .map((d) => d.short)
    .join(", ");
}

/**
 * What one cell of the Nights grid is, for its tone, its mark and its words: a closure first; then stays
 * and holds against the rooms there are; the rooms still free for direct guests (those kept, less those
 * taken), which is the number the cell shows; another calendar's hint never fills a room, it only says so.
 */
export type CellTone = "closed" | "full" | "some" | "held" | "free";

export function cellOf(
  cell: NightsGrid["rooms"][number]["cells"][number],
  units: number,
): { tone: CellTone; words: string; mark: string } {
  if (cell.closed) return { tone: "closed", words: "Closed", mark: "×" };
  const taken = cell.stays.length;
  const held = cell.holds.length;
  const left = Math.max(0, units - taken - held);
  const direct = cell.kept ? Math.max(0, cell.kept - taken - held) : null;
  const parts: string[] = [];
  if (taken) parts.push(`${taken} booked`);
  if (held) parts.push(`${held} held`);
  if (direct !== null) parts.push(`${direct} of ${cell.kept} kept still free for direct guests`);
  if (cell.hint) parts.push(`${cell.hint} shows it taken`);
  const words = parts.length ? parts.join(" · ") : `${units} free`;
  const mark = direct !== null ? String(direct) : "";
  if (left === 0 && taken > 0 && held === 0) return { tone: "full", words, mark };
  if (left === 0) return { tone: "held", words, mark };
  if (taken || held) return { tone: "some", words: `${words} · ${left} free`, mark };
  return { tone: "free", words, mark };
}

/** A season's row, as the owner reads it: "Chambre Jasmin · 19 Nov – 4 Dec · Friday and Saturday nights · 1,100.00 MAD a night". */
export function seasonWords(
  s: { readonly fromDate: string; readonly toDate: string; readonly weekdays: number; readonly nightly: number },
  room: string,
  currency: string,
  locale?: string,
): string {
  const range = (() => {
    const a = new Date(`${s.fromDate}T12:00:00Z`);
    const b = new Date(`${s.toDate || s.fromDate}T12:00:00Z`);
    try {
      return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).formatRange(a, b);
    } catch {
      return `${s.fromDate} – ${s.toDate}`;
    }
  })();
  const nights = weekdayWords(s.weekdays);
  return [
    room,
    range,
    nights.charAt(0).toUpperCase() + nights.slice(1),
    `${formatMoney({ value: s.nightly, currency }, locale)} a night`,
  ].join(" · ");
}

/**
 * The sheet that keeps rooms for direct guests (S10) saves only once the owner says those rooms are
 * closed on every other channel: without it two guests could book the last one.
 */
export function allotmentReady(a: {
  readonly units: number;
  readonly from: string;
  readonly to: string;
  readonly closedElsewhere: boolean;
}): string | null {
  if (!a.closedElsewhere) return "Close these rooms on your other channels first, then tick the box.";
  if (!a.from || !a.to) return "Choose the first and last night.";
  if (a.to < a.from) return "The last night comes after the first.";
  if (!Number.isInteger(a.units) || a.units < 0) return "Choose how many rooms.";
  return null;
}

/** A quote's sums for the composer (S13): what is paid now, later, at the property, and the total. */
export function quoteSums(q: StayQuoteView): {
  total: string;
  now: string | null;
  later: string | null;
  atProperty: string | null;
} {
  const money = (v: number) => formatMoney({ value: v, currency: q.currency });
  const sum = (type: string) => q.schedule.filter((s) => s.type === type).reduce((a, s) => a + s.amount.value, 0);
  const now = sum("immediate");
  const later = sum("deferred");
  const there = sum("at_property");
  return {
    total: money(q.total.value),
    now: now ? money(now) : null,
    later: later ? money(later) : null,
    atProperty: there ? money(there) : null,
  };
}

/** Where a stay stands with the property's own system, for the detail panel (S12). */
export function systemWords(p: StayPayload, state: string): string | null {
  if (p.external) return `In the property's system as ${p.external.externalId}`;
  if (state === "booking") return "Being written to the property's system";
  if (state === "write_refused") return "The property's system refused it: a person looks";
  return null;
}

/** The minutes a hold has left, or null once it has lapsed. */
export function holdMinutesLeft(p: StayPayload, now = Date.now()): number | null {
  if (!p.hold) return null;
  const left = Math.round((Date.parse(p.hold.until) - now) / 60_000);
  return left > 0 ? left : null;
}

/** A schedule entry's state in a word, for the detail panel. */
export function scheduleWord(status: string): string {
  switch (status) {
    case "paid":
      return "paid";
    case "at_property":
      return "at the property";
    case "waived":
      return "waived";
    case "refund_owed":
      return "to refund";
    default:
      return "due";
  }
}

/** Add `n` days to a local date ("2026-12-12"), never shifted by a zone. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
