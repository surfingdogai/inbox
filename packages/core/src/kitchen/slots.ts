import { WEEKDAYS } from "@surfingdog/spec";
import { isClosed } from "../capabilities/closures";
import type { Db } from "../db";
import { addDays, dateIn, daysBetween, instantOf, isLocalDate, isoWeekday } from "../util/zoned";
import type { KitchenContext } from "./context";
import { pausedUntil } from "./settings";

/**
 * Slots for orders and the places they hold (ADR-036). A kitchen's slots run inside the business's
 * opening hours, every `slotMin` minutes, each taking `perSlot` orders through the inbox. An order
 * claims its slot as `order-slot:<location>:<start>` in `slot_claims` (the row's resource key is
 * `order-slot:<location>`, its bucket the slot's start), and the daily cap of each item it orders as
 * `menu-cap:<product>:<day>` (bucket: the local day's midnight), one place per unit. The primary key
 * decides a race: two orders for the last place, one gets it and the other is told the slot was taken.
 * A slot is never oversold through the inbox; the kitchen's other orders are its own to count.
 */

export const ORDER_SLOT_PREFIX = "order-slot:";
export const MENU_CAP_PREFIX = "menu-cap:";

export function orderSlotKey(locationId: string | null | undefined): string {
  return `${ORDER_SLOT_PREFIX}${locationId ?? "main"}`;
}

export function capKey(productId: string): string {
  return `${MENU_CAP_PREFIX}${productId}`;
}

/** A local day's weekday key: `mon` … `sun`. */
export function weekdayOf(date: string): (typeof WEEKDAYS)[number] {
  return WEEKDAYS[isoWeekday(date) - 1] as (typeof WEEKDAYS)[number];
}

/** The midnight a local day starts at: the bucket its daily caps are counted in. */
export function dayBucket(date: string, zone: string): number {
  return instantOf(date, "00:00", zone);
}

/** The slots of a local day inside the opening hours, before anything is taken: [start, end) in ms. */
export function slotGrid(ctx: KitchenContext, date: string): { start: number; end: number }[] {
  if (!isLocalDate(date) || isClosed(ctx.closures, date)) return [];
  const step = ctx.settings.kitchen.slotMin * 60_000;
  const out: { start: number; end: number }[] = [];
  for (const [open, close] of ctx.weekly[weekdayOf(date)] ?? []) {
    const from = instantOf(date, open, ctx.timezone);
    const to =
      close === "24:00" ? instantOf(addDays(date, 1), "00:00", ctx.timezone) : instantOf(date, close, ctx.timezone);
    for (let s = from; s + step <= to; s += step) out.push({ start: s, end: s + step });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The places taken under one key between two buckets, by bucket. */
export async function takenPlaces(
  db: Db,
  resourceKey: string,
  from: number,
  to: number,
  exceptItemId = "",
): Promise<Map<number, Set<number>>> {
  const { rows } = await db.client.query({
    sql: "SELECT bucket_start, ordinal, item_id FROM slot_claims WHERE resource_key = ? AND bucket_start >= ? AND bucket_start <= ?",
    params: [resourceKey, from, to],
    method: "all",
  });
  const taken = new Map<number, Set<number>>();
  for (const r of rows) {
    if (String(r[2]) === exceptItemId) continue;
    const b = Number(r[0]);
    let set = taken.get(b);
    if (!set) {
      set = new Set();
      taken.set(b, set);
    }
    set.add(Number(r[1]));
  }
  return taken;
}

/** The lowest `units` free places of `capacity`, or null when fewer are free. */
export function freePlaces(taken: ReadonlySet<number> | undefined, capacity: number, units: number): number[] | null {
  const out: number[] = [];
  for (let o = 0; o < capacity && out.length < units; o++) if (!taken?.has(o)) out.push(o);
  return out.length === units ? out : null;
}

/** The first instant an order placed now can be ready: the kitchen's preparation and the longest notice. */
export function earliestReady(ctx: KitchenContext, now: number, noticeMin: number): number {
  return now + (ctx.settings.kitchen.prepMin + Math.max(0, noticeMin)) * 60_000;
}

export interface DaySlots {
  /** Why there are none: the day is shut, too far ahead, in the past, or orders are paused all of it. */
  readonly reason?: "closed" | "too_far" | "past" | "paused" | undefined;
  readonly slots: readonly { start: number; end: number; left: number }[];
  readonly earliest: number;
  readonly pausedUntil: number | null;
}

/** The slots of a day an order can still have: after the earliest, not paused, with places left. */
export async function daySlots(
  db: Db,
  ctx: KitchenContext,
  o: {
    readonly date: string;
    readonly now: number;
    readonly noticeMin?: number | undefined;
    readonly locationId?: string | null | undefined;
  },
): Promise<DaySlots> {
  const k = ctx.settings.kitchen;
  const earliest = earliestReady(ctx, o.now, o.noticeMin ?? 0);
  const paused = pausedUntil(k, o.now);
  const today = dateIn(o.now, ctx.timezone);
  if (!isLocalDate(o.date) || daysBetween(today, o.date) < 0)
    return { reason: "past", slots: [], earliest, pausedUntil: paused };
  if (daysBetween(today, o.date) > k.daysAhead) return { reason: "too_far", slots: [], earliest, pausedUntil: paused };
  const grid = slotGrid(ctx, o.date);
  if (grid.length === 0) return { reason: "closed", slots: [], earliest, pausedUntil: paused };
  const first = grid[0] as { start: number };
  const last = grid[grid.length - 1] as { start: number };
  const taken = await takenPlaces(db, orderSlotKey(o.locationId), first.start, last.start);
  const open = grid.filter((s) => s.start >= earliest && (paused === null || s.start >= paused));
  const slots = open
    .map((s) => ({ ...s, left: Math.max(0, k.perSlot - (taken.get(s.start)?.size ?? 0)) }))
    .filter((s) => s.left > 0);
  const reason = slots.length === 0 && paused !== null && grid.some((s) => s.start >= earliest) ? "paused" : undefined;
  return { ...(reason ? { reason } : {}), slots, earliest, pausedUntil: paused };
}

/** Whether an instant is a slot's start on its day's grid, and the slot. */
export function slotAt(ctx: KitchenContext, start: number): { start: number; end: number } | null {
  const date = dateIn(start, ctx.timezone);
  return slotGrid(ctx, date).find((s) => s.start === start) ?? null;
}
