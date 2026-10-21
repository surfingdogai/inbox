import { majorText, parseMajor } from "./actions";
import { minorUnitsOf } from "./currencies";
import { formatMoney } from "./format";
import type { PriceModel, ServiceBody, ServicePrice, ServiceRow } from "./types";

/**
 * A service as the owner edits it and as a list says it, as pure functions so they run in tests on
 * both runtimes. A service is booked (a length, a price or "on request") or asked about (priced by a
 * quote); the price is optional and in the business's currency.
 */

/** 30 → "30 min", 60 → "1 h", 90 → "1 h 30", 1440 → "24 h". */
export function lengthWords(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

/** How a service's price reads: "€45.00", "from €45.00", "€20.00 per person", "price on request". */
export function describePrice(price: ServicePrice | null, currency: string): string {
  if (!price || price.model === "quote" || price.value === undefined) return "price on request";
  const money = formatMoney({ value: price.value, currency: price.currency ?? currency });
  const each = price.per === "person" ? `${money} per person` : money;
  return price.model === "from" ? `from ${each}` : each;
}

/**
 * How a service reads in a list: "Asked for a price", or "45 min · €30.00", with what is not the
 * usual only when it is set (buffers, more than one at a time, slots not every 15 minutes).
 */
export function describeService(s: ServiceRow, currency: string): string {
  if (s.price?.model === "quote") return "Asked for a price";
  const parts = [lengthWords(s.durationMin), describePrice(s.price, currency)];
  if (s.bufferBeforeMin) parts.push(`${s.bufferBeforeMin} min before`);
  if (s.bufferAfterMin) parts.push(`${s.bufferAfterMin} min after`);
  if (s.capacity > 1) parts.push(`${s.capacity} at a time`);
  if (s.granularityMin !== 15) parts.push(`starts every ${s.granularityMin} min`);
  return parts.join(" · ");
}

export interface ServiceDraft {
  readonly name: string;
  readonly description: string;
  /** Booked at a time, or asked about for a price. */
  readonly taken: "book" | "ask";
  readonly duration: string;
  readonly before: string;
  readonly after: string;
  readonly capacity: string;
  readonly granularity: string;
  /** Exact, or starting at; only with an amount. */
  readonly model: Exclude<PriceModel, "quote">;
  /** Major units as typed; empty is on request. */
  readonly price: string;
  /** Whom a price is for: the booking, or each person in it. */
  readonly per: "booking" | "person";
  readonly sort: string;
  readonly active: boolean;
  readonly negotiable: boolean;
  /** The lowest price the owner's AI, rules and other systems may go to, in major units; empty for none. */
  readonly floor: string;
}

const majorOf = (minor: number | null | undefined, currency: string) =>
  minor === null || minor === undefined ? "" : majorText(minor, currency);

/** `currency`: the business's, for a service with no price of its own yet (ADR-032: amounts in its own places). */
export function serviceDraft(
  s: ServiceRow | undefined,
  floor: number | null | undefined,
  currency = "EUR",
): ServiceDraft {
  const money = s?.price?.currency ?? currency;
  return {
    name: s?.name ?? "",
    description: s?.description ?? "",
    taken: s?.price?.model === "quote" ? "ask" : "book",
    duration: String(s?.durationMin ?? 60),
    before: String(s?.bufferBeforeMin ?? 0),
    after: String(s?.bufferAfterMin ?? 0),
    capacity: String(s?.capacity ?? 1),
    granularity: String(s?.granularityMin ?? 15),
    model: s?.price?.model === "from" ? "from" : "fixed",
    price: s?.price?.value !== undefined && s.price.model !== "quote" ? majorText(s.price.value, money) : "",
    per: s?.price?.per === "person" ? "person" : "booking",
    sort: String(s?.sort ?? 0),
    active: s ? s.active === 1 : true,
    negotiable: s ? s.negotiable !== 0 : true,
    floor: majorOf(floor, money),
  };
}

const int = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));

export type ServiceWrite =
  | { readonly body: ServiceBody; readonly floor: number | null | undefined }
  | { readonly problem: string };

/**
 * What a save sends: the row, and the lowest price when the owner changed it (null clears it). An
 * empty amount is "on request": a new service is saved with no price, and one that had a price has it
 * taken off (null). A service asked about is priced by quote, with no amount.
 */
export function serviceWrite(
  d: ServiceDraft,
  opts: { readonly currency: string; readonly isNew: boolean; readonly floor: number | null | undefined },
): ServiceWrite {
  if (!d.name.trim()) return { problem: "Give the service a name." };
  const duration = int(d.duration);
  if (d.taken === "book" && (!Number.isInteger(duration) || duration < 5 || duration > 1440)) {
    return { problem: "Pick a length, or type the minutes (5 to 1440)." };
  }
  const typed = d.price.trim();
  const places = minorUnitsOf(opts.currency);
  const value = typed ? parseMajor(typed, places) : undefined;
  if (d.taken === "book" && typed && value === undefined) {
    return { problem: "Write the price like 45 or 45.50, or leave it empty for on request." };
  }
  const priced = d.taken === "book" && value !== undefined;
  const floorTyped = d.floor.trim();
  const lowest = !priced || d.model !== "fixed" || floorTyped === "" ? null : parseMajor(floorTyped, places);
  if (lowest === undefined) return { problem: "Write the lowest price like 40 or 40.50, or leave it empty." };
  const price: ServicePrice | null =
    d.taken === "ask"
      ? { model: "quote" }
      : value !== undefined
        ? { model: d.model, value, currency: opts.currency, ...(d.per === "person" ? { per: "person" as const } : {}) }
        : null;
  const body: ServiceBody = {
    name: d.name.trim(),
    description: d.description.trim(),
    ...(d.taken === "book" ? { duration_min: duration } : {}),
    buffer_before_min: int(d.before),
    buffer_after_min: int(d.after),
    capacity: int(d.capacity),
    granularity_min: int(d.granularity),
    ...(price ? { price } : opts.isNew ? {} : { price: null }),
    sort: int(d.sort),
    active: d.active,
    negotiable: d.negotiable,
  };
  return { body, floor: lowest !== (opts.floor ?? null) ? lowest : undefined };
}
