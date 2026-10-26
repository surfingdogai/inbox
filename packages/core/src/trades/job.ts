import type { AreaCheck, Job, WorkProfile } from "@surfingdog/spec";
import { type AreaSettings, answerOf, areaSummary, type Point, type Site } from "../area/index";
import { localiser, type Weekly, withinOpening } from "../capabilities/availability";
import type { Db } from "../db";
import type { Settings } from "../settings/schema";
import type { WorkSettings } from "./settings";

/**
 * What a request for a price is checked against before it is taken (ADR-039 §4): its site against the
 * area, and an emergency against the emergency door. Words go to the customer's agent and are relayed
 * to its person: in the business's name, never naming the software.
 */

/** The site a request names: the job's own, else the request's delivery address. */
export function siteOf(payload: {
  readonly job?: { readonly site?: Job["site"] } | undefined;
  readonly deliveryAddress?:
    | { readonly postalCode?: string | undefined; readonly addressCountry?: string | undefined }
    | undefined;
}): Site {
  const address = payload.job?.site?.address ?? payload.deliveryAddress;
  const geo = payload.job?.site?.geo;
  return {
    ...(address?.postalCode ? { postalCode: address.postalCode } : {}),
    ...(address?.addressCountry ? { country: address.addressCountry.toUpperCase() } : {}),
    ...(geo ? { point: { lat: geo.latitude, lng: geo.longitude } } : {}),
  };
}

/** The premises as Settings → Business has them on the map, for a radius measured from them. */
export function premisesOf(settings: Settings): Point | null {
  const g = settings.directory.geo;
  return g ? { lat: g.latitude, lng: g.longitude } : null;
}

/** Whether the business is open now, by its weekly hours in its zone. No hours set: not open. */
export async function openNow(db: Db, timezone: string, now: number): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT weekly FROM availability_rules WHERE kind = 'open' AND service_id IS NULL LIMIT 1",
    params: [],
    method: "all",
  });
  const raw = rows[0]?.[0];
  let weekly: Weekly = {};
  try {
    weekly = (typeof raw === "string" ? JSON.parse(raw) : (raw ?? {})) as Weekly;
  } catch {
    weekly = {};
  }
  try {
    return withinOpening(localiser(timezone), weekly, now, now + 60_000);
  } catch {
    return false;
  }
}

/** How to reach the business at once: its phone, when it gave one. */
const callOn = (b: string, phone?: string) => (phone?.trim() ? `Call ${b} on ${phone.trim()}` : `Call ${b} directly`);

export const JOB_WORDS = {
  outside: (b: string, _phone?: string) =>
    `${b} does not take jobs at this site: it is outside the area ${b} works in.`,
  emergencyOff: (b: string, phone?: string) =>
    `${b} does not take emergency jobs online. ${callOn(b, phone)}, or send it with urgency within_24h.`,
  emergencyClosed: (b: string, phone?: string) =>
    `${b} takes emergency jobs online only while open. ${callOn(b, phone)}, or send it with urgency within_24h.`,
} as const;

export type JobRefusal = keyof typeof JOB_WORDS;

/**
 * Whether a request is taken, and how: refused (a site outside an area that declines, an emergency the
 * door does not take), or taken with what the inbox adds (the area check, a priority, a person
 * needed). An area that cannot tell is "on request", never a refusal: an emergency from a site the
 * area cannot place (a radius, and only a postal code sent) comes first, for a person to decide.
 */
export function judgeRequest(o: {
  readonly area: AreaSettings;
  readonly work: WorkSettings;
  readonly check: AreaCheck;
  readonly urgency: Job["urgency"] | undefined;
  readonly open: boolean;
}):
  | { readonly refused: JobRefusal }
  | { readonly refused: null; readonly priority: 0 | 1 | 2 | 3; readonly needsHuman: boolean } {
  const answer = answerOf(o.area, o.check);
  if (answer === "outside") return { refused: "outside" };
  if (o.urgency === "emergency") {
    if (o.work.emergency === "off") return { refused: "emergencyOff" };
    if (o.work.emergency === "opening_hours" && !o.open) return { refused: "emergencyClosed" };
    return { refused: null, priority: 3, needsHuman: true };
  }
  const priority = o.urgency === "within_24h" ? 2 : 0;
  // Outside, or not known: the business decides, so a person sees it.
  return { refused: null, priority, needsHuman: answer === "on_request" && o.area.mode !== "anywhere" };
}

/**
 * How the trade takes work, as `get_business_profile` says it (spec `workProfileSchema`); null for a
 * business that set none of it (no area, no emergency door, no fees), which says nothing of work.
 */
export function workProfile(settings: Settings): WorkProfile | null {
  const w = settings.work;
  const a = settings.area;
  const said =
    a.mode !== "anywhere" || w.emergency !== "off" || w.callOutFee !== null || w.outOfHours !== null || w.freeEstimates;
  if (!said) return null;
  return {
    area: areaSummary(a),
    emergency: w.emergency,
    ...(w.callOutFee
      ? { call_out_fee: { amount: w.callOutFee.amount, credited_if_accepted: w.callOutFee.creditedIfAccepted } }
      : {}),
    ...(w.outOfHours ? { out_of_hours: { surcharge: w.outOfHours.surcharge } } : {}),
    free_estimates: w.freeEstimates,
    visits: "on_request",
  };
}

/** Whether the business set where it works or how it takes work: a trade, whose job tools come first. */
export function isTrade(settings: Settings): boolean {
  return (
    workProfile(settings) !== null || settings.work.jobTool !== "accepted" || settings.work.visitServiceId !== null
  );
}

/** What the business's public profile says of work, as attributes a network reads (`vocab/attributes.json`). */
export function workAttributes(settings: Settings): Record<string, true> {
  return {
    ...(settings.work.freeEstimates ? { free_estimates: true as const } : {}),
    ...(settings.work.emergency !== "off" ? { emergency_service: true as const } : {}),
  };
}
