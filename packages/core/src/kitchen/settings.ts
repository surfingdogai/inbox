import { z } from "zod";

/**
 * Settings → Kitchen (ADR-036): how a restaurant, a takeaway, a bakery or a café takes orders for a time.
 * Each is a choice, never a typed code:
 *
 * - `enabled`: orders are taken for a slot (pickup, delivery, eating in); off, orders are as a shop's.
 * - `prepMin`: how long the kitchen needs, so the first slot an order can have is at least that far off.
 * - `slotMin` and `perSlot`: slots of 10, 15, 30 or 60 minutes inside the opening hours, and how many
 *   orders one slot takes through the inbox. What the kitchen set aside: a slot is never oversold here.
 * - `daysAhead`: how far ahead an order may be for.
 * - `methods`: collection, delivery (with its zones, Settings → Area) and eating in.
 * - `accept`: `owner`, a person accepts each order (the default); `caps`, orders inside the slot's places
 *   and each item's daily cap confirm at once, and everything else waits for a person.
 * - `tips`: whether a customer may add a tip, and the chips they are offered (a share of the food). It
 *   goes on the business's own pay link.
 * - `pause`: orders stop until then ("not taking orders until 21:30"), pressed on the inbox's home.
 * - `pausePos`: pausing pauses the connected ordering system too (Flipdish), when one can be.
 *
 * What the kitchen confirms and what it charges are the owner's: only the owner in person changes these
 * (`settings/guard.ts`). Pausing has a door of its own, open to every person at the business.
 */

export const SLOT_LENGTHS = [10, 15, 30, 60] as const;
export const PAUSE_CHOICES_MIN = [15, 30, 60] as const;
export const TIP_CHOICES = [0, 5, 10, 15] as const;

export const kitchenSettingsSchema = z
  .object({
    enabled: z.boolean().default(false).describe("Take orders for a time: collection, delivery, eating in."),
    prepMin: z.number().int().min(0).max(240).default(20).describe("How long the kitchen needs, in minutes."),
    slotMin: z
      .union([z.literal(10), z.literal(15), z.literal(30), z.literal(60)])
      .default(15)
      .describe("How long each slot is."),
    perSlot: z.number().int().min(1).max(200).default(4).describe("How many orders one slot takes here."),
    daysAhead: z.number().int().min(0).max(60).default(7).describe("How far ahead an order may be for, in days."),
    methods: z
      .object({
        pickup: z.boolean().default(true),
        delivery: z.boolean().default(false),
        dineIn: z.boolean().default(false),
      })
      .prefault({}),
    accept: z
      .enum(["owner", "caps"])
      .default("owner")
      .describe("owner: you accept each order. caps: orders inside the places you set aside confirm at once."),
    tips: z
      .object({
        enabled: z.boolean().default(false),
        choices: z
          .array(z.number().int().min(0).max(50))
          .min(1)
          .max(6)
          .default([...TIP_CHOICES]),
      })
      .prefault({}),
    pause: z
      .object({
        until: z.iso.datetime({ offset: true }),
        /** Who pressed it, as the history names them. */
        by: z.string().max(120).optional(),
      })
      .nullable()
      .default(null),
    pausePos: z.boolean().default(false).describe("Pausing here pauses your ordering system too, where it can be."),
  })
  .prefault({});
export type KitchenSettings = z.infer<typeof kitchenSettingsSchema>;

/** Whether orders are paused at an instant, and until when. */
export function pausedUntil(k: KitchenSettings, now: number): number | null {
  if (!k.pause) return null;
  const until = Date.parse(k.pause.until);
  return Number.isFinite(until) && until > now ? until : null;
}

/** The ways an order may be fulfilled here now. */
export function methodsOf(k: KitchenSettings, zones: number): ("pickup" | "delivery" | "dine_in")[] {
  const out: ("pickup" | "delivery" | "dine_in")[] = [];
  if (k.methods.pickup) out.push("pickup");
  // Delivery needs somewhere to deliver: a zone in Settings → Area.
  if (k.methods.delivery && zones > 0) out.push("delivery");
  if (k.methods.dineIn) out.push("dine_in");
  return out;
}
