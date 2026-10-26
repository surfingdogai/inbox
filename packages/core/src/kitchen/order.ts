import type { Statement } from "@surfingdog/platform";
import type { Fulfil, KitchenHold, KitchenMark, Tip } from "@surfingdog/spec";
import { basePoint, matchZone, type Site } from "../area/index";
import type { Db } from "../db";
import type { ItemFlags, Money } from "../domain/types";
import { allergensConfirmed } from "../menu/allergens";
import { priceOptions } from "../menu/options";
import type { MenuFields } from "../menu/schema";
import { addDays, dateIn } from "../util/zoned";
import type { FieldProblem } from "../write/errors";
import { WriteError } from "../write/errors";
import { claimStatements } from "../write/slots";
import { type KitchenContext, kitchenContext, type MenuProduct, productsById, productsBySku } from "./context";
import { methodsOf, pausedUntil } from "./settings";
import { capKey, dayBucket, daySlots, freePlaces, orderSlotKey, slotAt, takenPlaces, weekdayOf } from "./slots";
import { kitchenMoney, kitchenWords, type Words } from "./words";

/**
 * An order for a time, as the kitchen takes it (ADR-040). Before the customer confirms anything the
 * order is checked (`checkOrder`): the kitchen is not paused, the slot is one it offers and has room,
 * delivery reaches the address and the order is over the zone's minimum, each item is served then, is
 * not sold out today and is ordered with its notice, and a tip is one the business takes. Once they
 * confirm, the order takes its places in the same batch as it is written (`prepareOrder`): its slot,
 * and each item's daily cap where the business set one aside. What it could not take, and what needs
 * a person (an allergen nobody confirmed, made to order, a kitchen that accepts by hand), is written on
 * the order (`kitchen`), and only a person accepts it then.
 */

interface OrderLike {
  readonly orderedItem?: readonly {
    readonly productId?: string | undefined;
    readonly sku?: string | undefined;
    readonly quantity: number;
    readonly options?: readonly unknown[] | undefined;
    readonly note?: string | undefined;
    readonly brief?: unknown;
  }[];
  readonly fulfil?:
    | {
        readonly method: Fulfil["method"];
        readonly slot?: { readonly start: string } | undefined;
        readonly geo?: Fulfil["geo"];
      }
    | undefined;
  readonly tip?: { readonly percent?: number | undefined; readonly amount?: Money | undefined } | undefined;
  readonly shippingAddress?:
    | { readonly postalCode?: string | undefined; readonly addressCountry?: string | undefined }
    | undefined;
}

type LineOptions = Parameters<typeof priceOptions>[1];

/** Whether an order is the kitchen's to judge: it is for a time, or names something on the menu. */
export function kitchenOrder(payload: OrderLike, products: ReadonlyMap<string, MenuProduct>): boolean {
  if (payload.fulfil || payload.tip) return true;
  return (payload.orderedItem ?? []).some(
    (l) =>
      (l.options?.length ?? 0) > 0 || l.note !== undefined || l.brief !== undefined || productOf(l, products)?.menu,
  );
}

function productOf(
  line: { readonly productId?: string | undefined; readonly sku?: string | undefined },
  products: ReadonlyMap<string, MenuProduct>,
): MenuProduct | undefined {
  if (line.productId !== undefined) return products.get(line.productId);
  if (line.sku !== undefined) return products.get(`sku:${line.sku}`);
  return undefined;
}

/** The products an order's lines name, by id and by `sku:<sku>`. */
export async function linesProducts(db: Db, payload: OrderLike): Promise<Map<string, MenuProduct>> {
  const lines = payload.orderedItem ?? [];
  const byId = await productsById(
    db,
    lines.flatMap((l) => (l.productId !== undefined ? [l.productId] : [])),
  );
  const bySku = await productsBySku(
    db,
    lines.flatMap((l) => (l.productId === undefined && l.sku !== undefined ? [l.sku] : [])),
  );
  const out = new Map(byId);
  for (const [sku, p] of bySku) out.set(`sku:${sku}`, p);
  return out;
}

function refuse(words: string, path: string, reason: string, details: Record<string, unknown> = {}): never {
  throw new WriteError("invalid_input", words, {
    fields: [{ path, problem: "invalid", message: words }],
    details: { reason, ...details },
  });
}

/** The delivery site an order names: its address's postal code and country, its point. */
export function siteOfOrder(payload: OrderLike): Site {
  const a = payload.shippingAddress;
  const g = payload.fulfil?.geo;
  return {
    ...(a?.postalCode ? { postalCode: a.postalCode } : {}),
    ...(a?.addressCountry ? { country: a.addressCountry.toUpperCase() } : {}),
    ...(g ? { point: { lat: g.latitude, lng: g.longitude } } : {}),
  };
}

/** The delivery zone an order's address falls in, the first that holds it. */
export function zoneOf(ctx: KitchenContext, payload: OrderLike) {
  const area = ctx.settings.area;
  return matchZone(area.zones, basePoint(area, ctx.premises), siteOfOrder(payload));
}

/**
 * Checks an order for a time before anything is promised or written, in the business's words. Throws
 * the refusal; returns the context it read, for `prepareOrder`.
 */
export async function checkOrder(
  db: Db,
  payload: OrderLike,
  o: { readonly now: number; readonly lang: string; readonly locationId?: string | null | undefined },
): Promise<{ ctx: KitchenContext; products: Map<string, MenuProduct> } | null> {
  const products = await linesProducts(db, payload);
  if (!kitchenOrder(payload, products)) return null;
  const ctx = await kitchenContext(db);
  const w = kitchenWords(o.lang, ctx.name);
  const k = ctx.settings.kitchen;
  const lines = payload.orderedItem ?? [];
  const f = payload.fulfil;
  if (f && !k.enabled) refuse(w.notForATime, "payload.fulfil", "not_for_a_time");
  if (k.enabled && !f)
    refuse(w.chooseMethod(methodsOf(k, ctx.settings.area.zones.length)), "payload.fulfil", "fulfil_missing");
  const now = o.now;
  // A tip only where the business takes them.
  if (payload.tip && !k.tips.enabled) refuse(w.noTips, "payload.tip", "no_tips");
  if (!f) return { ctx, products };

  const methods = methodsOf(k, ctx.settings.area.zones.length);
  if (!methods.includes(f.method)) refuse(w.chooseMethod(methods), "payload.fulfil.method", "method_not_offered");
  const paused = pausedUntil(k, now);
  if (!f.slot) refuse(w.chooseSlot, "payload.fulfil.slot", "slot_missing");
  const start = Date.parse(f.slot.start);
  if (paused !== null && start < paused)
    refuse(w.paused(paused, ctx.timezone), "payload.fulfil.slot.start", "paused", {
      paused_until: new Date(paused).toISOString(),
    });
  const slot = Number.isFinite(start) ? slotAt(ctx, start) : null;
  if (!slot) refuse(w.notASlot, "payload.fulfil.slot.start", "not_a_slot");
  const date = dateIn(start, ctx.timezone);
  const notice = Math.max(0, ...lines.map((l) => productOf(l, products)?.menu?.noticeMin ?? 0));
  const day = await daySlots(db, ctx, { date, now, noticeMin: notice, locationId: o.locationId });
  if (start < day.earliest)
    refuse(w.tooSoon(day.earliest, ctx.timezone, notice > 0), "payload.fulfil.slot.start", "too_soon", {
      earliest: new Date(day.earliest).toISOString(),
    });
  if (day.reason === "too_far") refuse(w.tooFar(k.daysAhead), "payload.fulfil.slot.start", "too_far");
  if (!day.slots.some((s) => s.start === start)) {
    throw new WriteError(
      "slot_taken",
      w.slotFull(
        day.slots.slice(0, 3).map((s) => s.start),
        ctx.timezone,
      ),
      {
        details: { reason: "slot_full", next: day.slots.slice(0, 3).map((s) => new Date(s.start).toISOString()) },
      },
    );
  }

  // Each item is on sale, served then, made that day, not sold out, and not past what it can be ordered as.
  const today = dateIn(now, ctx.timezone);
  lines.forEach((l, i) => {
    const p = productOf(l, products);
    const m = p?.menu;
    if (!p || !m) return;
    const at = `payload.orderedItem.${i}`;
    // Off sale (the menu keeps it for later): `get_menu` hides it, and an agent that knows its id is told so.
    if (!p.active) refuse(w.notAvailable(p.name), at, "not_available");
    if (p.soldOutOn === today && date === today) refuse(w.soldOut(p.name), at, "sold_out");
    if (m.availableDays.length > 0 && !m.availableDays.includes(weekdayOf(date)))
      refuse(w.notThatDay(p.name), at, "not_that_day");
    if (m.blackout.includes(date)) refuse(w.notThatDay(p.name), at, "not_that_day");
    if (!servedAt(ctx, m, start)) refuse(w.notServedThen(p.name), at, "not_served_then");
  });

  if (f.method === "delivery") {
    const zone = zoneOf(ctx, payload);
    if (!zone) refuse(w.noDeliveryThere, "payload.shippingAddress", "outside_zones");
    const minimum = zone.zone.minimumOrder;
    if (minimum) {
      // The food as the menu prices it: each item with what its options add, in the minimum's currency.
      const currency = minimum.currency.toUpperCase();
      let subtotal = 0;
      for (const l of lines) {
        const p = productOf(l, products);
        if (!p) continue;
        if (p.price.currency !== currency) refuse(w.noDeliveryThere, "payload.shippingAddress", "minimum_currency");
        const delta = p.menu ? priceOptions(p.menu, l.options as LineOptions, currency, "").unitDelta : 0;
        subtotal += (p.price.value + delta) * l.quantity;
      }
      if (subtotal < minimum.value)
        refuse(w.belowMinimum(zone.zone.name, minimum), "payload.orderedItem", "below_minimum");
    }
  }
  return { ctx, products };
}

/** Whether an item is served at an instant: no dayparts, or one of them holds it. */
export function servedAt(ctx: KitchenContext, m: MenuFields, at: number): boolean {
  if (m.dayparts.length === 0) return true;
  const parts = ctx.settings.menu.dayparts.filter((d) => m.dayparts.includes(d.name));
  if (parts.length === 0) return true;
  const date = dateIn(at, ctx.timezone);
  const wd = weekdayOf(date);
  const minutes = minutesIn(at, ctx.timezone);
  return parts.some((d) => {
    const from = toMin(d.from);
    const to = toMin(d.to);
    if (from < to) return d.days.includes(wd) && minutes >= from && minutes < to;
    // Past midnight (22:00 to 02:00): from its start on its own days, and until its end the morning after.
    return (d.days.includes(wd) && minutes >= from) || (d.days.includes(weekdayOf(addDays(date, -1))) && minutes < to);
  });
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function minutesIn(ms: number, zone: string): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(ms));
  return (
    Number(parts.find((p) => p.type === "hour")?.value ?? 0) * 60 +
    Number(parts.find((p) => p.type === "minute")?.value ?? 0)
  );
}

/** What the inbox adds to an order as it takes it: the kitchen's mark, the places it claims, flags. */
export interface KitchenAdds {
  readonly payload: Record<string, unknown>;
  readonly claims: { resourceKey: string; claims: [number, number][] }[];
  readonly flags: Partial<ItemFlags>;
}

/**
 * The places an order takes and why it waits, once the customer confirmed it. Its slot is claimed (the
 * create's batch decides a race); each item with a daily cap takes one place per unit while there are
 * enough, else the order waits for a person (`over_cap`) and takes none.
 */
export async function prepareOrder(
  db: Db,
  checked: { ctx: KitchenContext; products: Map<string, MenuProduct> },
  payload: OrderLike,
  o: { readonly locationId?: string | null | undefined },
): Promise<KitchenAdds> {
  const { ctx, products } = checked;
  const k = ctx.settings.kitchen;
  const hold = new Set<KitchenHold>();
  const claims: { resourceKey: string; claims: [number, number][] }[] = [];
  const lines = payload.orderedItem ?? [];
  const start = payload.fulfil?.slot ? Date.parse(payload.fulfil.slot.start) : Number.NaN;
  if (Number.isFinite(start)) {
    const key = orderSlotKey(o.locationId);
    const taken = await takenPlaces(db, key, start, start);
    const place = freePlaces(taken.get(start), k.perSlot, 1);
    // The check found room a moment ago; gone now, the create is told the slot was taken.
    if (!place)
      throw new WriteError("slot_taken", "that slot was taken a moment ago", { details: { reason: "slot_full" } });
    claims.push({ resourceKey: key, claims: place.map((ord) => [start, ord] as [number, number]) });
  }
  // The daily caps, summed per product over the order's lines.
  const units = new Map<string, number>();
  for (const l of lines) {
    const p = productOf(l, products);
    if (p?.menu?.dailyCap) units.set(p.id, (units.get(p.id) ?? 0) + l.quantity);
  }
  if (units.size > 0) {
    const date = dateIn(Number.isFinite(start) ? start : Date.now(), ctx.timezone);
    const bucket = dayBucket(date, ctx.timezone);
    for (const [productId, n] of units) {
      const p = products.get(productId);
      const cap = p?.menu?.dailyCap ?? 0;
      const key = capKey(productId);
      const taken = await takenPlaces(db, key, bucket, bucket);
      const places = freePlaces(taken.get(bucket), cap, n);
      if (!places) {
        hold.add("over_cap");
        continue;
      }
      claims.push({ resourceKey: key, claims: places.map((ord) => [bucket, ord] as [number, number]) });
    }
  }
  for (const l of lines) {
    const m = productOf(l, products)?.menu;
    if (!m) continue;
    if (!allergensConfirmed(m)) hold.add("allergens_unconfirmed");
    if (m.madeToOrder) hold.add("made_to_order");
  }
  // A line naming something not on the menu has no allergens anyone confirmed either.
  if (lines.some((l) => !productOf(l, products)?.menu) && lines.some((l) => productOf(l, products)?.menu)) {
    hold.add("allergens_unconfirmed");
  }
  if (k.accept === "owner") hold.add("owner_accepts");
  const mark: KitchenMark = { instant: hold.size === 0, hold: [...hold] };
  // What waits for a person because of the dish or the caps is marked for one, whatever the rules say.
  const forAPerson = mark.hold.some((h) => h !== "owner_accepts");
  return { payload: { kitchen: mark }, claims, flags: forAPerson ? { needsHuman: true } : {} };
}

/**
 * A person accepts an order that was over a daily cap (`over_cap`): it takes every place still free
 * under that cap for its day, as many as it can, so the orders after it wait for a person as well and
 * automation never sells past what was set aside. Its places go back if it is cancelled or declined.
 */
export async function overCapClaims(
  db: Db,
  order: {
    readonly id: string;
    readonly payload: {
      readonly orderedItem: readonly { readonly productId?: string | undefined; readonly quantity: number }[];
      readonly fulfil?: { readonly slot?: { readonly start: string } | undefined } | undefined;
      readonly kitchen?: { readonly hold: readonly string[] } | undefined;
    };
  },
  now: number,
): Promise<Statement[]> {
  if (!order.payload.kitchen?.hold.includes("over_cap")) return [];
  const ids = order.payload.orderedItem.flatMap((l) => (l.productId ? [l.productId] : []));
  const products = await productsById(db, ids);
  const ctx = await kitchenContext(db);
  const start = order.payload.fulfil?.slot ? Date.parse(order.payload.fulfil.slot.start) : Number.NaN;
  const bucket = dayBucket(dateIn(Number.isFinite(start) ? start : now, ctx.timezone), ctx.timezone);
  const units = new Map<string, number>();
  for (const l of order.payload.orderedItem) {
    const cap = l.productId ? products.get(l.productId)?.menu?.dailyCap : null;
    if (l.productId && cap) units.set(l.productId, (units.get(l.productId) ?? 0) + l.quantity);
  }
  const out: Statement[] = [];
  for (const [productId, n] of units) {
    const key = capKey(productId);
    const cap = products.get(productId)?.menu?.dailyCap ?? 0;
    const taken = await takenPlaces(db, key, bucket, bucket);
    const { rows } = await db.client.query({
      sql: "SELECT COUNT(*) FROM slot_claims WHERE resource_key = ? AND item_id = ?",
      params: [key, order.id],
      method: "all",
    });
    if (Number(rows[0]?.[0] ?? 0) > 0) continue;
    const free: number[] = [];
    for (let o = 0; o < cap && free.length < n; o++) if (!taken.get(bucket)?.has(o)) free.push(o);
    if (free.length)
      out.push(
        ...claimStatements(
          key,
          order.id,
          free.map((o) => [bucket, o] as [number, number]),
        ),
      );
  }
  return out;
}

/**
 * What an order for a time adds to its lines' total, priced as the business prices it (ADR-040): the
 * fee of the zone its address falls in, and a tip as a share of the food or an amount, never more than
 * the food. The slot's end and the zone are written on the fulfilment. Nothing here refuses: the check
 * did, before the customer was asked to confirm.
 */
export async function orderExtras(
  db: Db,
  payload: OrderLike,
  subtotal: Money,
): Promise<{ fulfil?: Fulfil | undefined; tip?: Tip | undefined; add: number; problems: FieldProblem[] }> {
  if (!payload.fulfil && !payload.tip) return { add: 0, problems: [] };
  const ctx = await kitchenContext(db);
  const problems: FieldProblem[] = [];
  let add = 0;
  let fulfil: Fulfil | undefined;
  if (payload.fulfil) {
    const f = payload.fulfil;
    const start = f.slot ? Date.parse(f.slot.start) : Number.NaN;
    const slot = Number.isFinite(start) ? slotAt(ctx, start) : null;
    const base: Fulfil = {
      method: f.method,
      ...(f.slot ? { slot: { start: f.slot.start, ...(slot ? { end: new Date(slot.end).toISOString() } : {}) } } : {}),
      ...(f.geo ? { geo: f.geo } : {}),
    };
    fulfil = base;
    if (f.method === "delivery") {
      const z = zoneOf(ctx, payload);
      if (z) {
        const fee = z.zone.fee;
        if (fee && fee.value > 0) {
          if (fee.currency.toUpperCase() !== subtotal.currency) {
            problems.push({
              path: "payload.fulfil",
              problem: "invalid",
              message: `the delivery fee is in ${fee.currency}`,
            });
          } else add += fee.value;
        }
        fulfil = {
          ...base,
          zone: { name: z.zone.name },
          ...(fee && fee.value > 0 ? { fee: { value: fee.value, currency: fee.currency.toUpperCase() } } : {}),
          ...(z.zone.etaMin !== undefined ? { etaMin: z.zone.etaMin } : {}),
        };
      }
    }
  }
  let tip: Tip | undefined;
  if (payload.tip) {
    const t = payload.tip;
    const amount =
      t.percent !== undefined
        ? Math.round((subtotal.value * t.percent) / 100)
        : t.amount && t.amount.currency.toUpperCase() === subtotal.currency
          ? t.amount.value
          : null;
    if (amount === null) {
      problems.push({ path: "payload.tip.amount", problem: "invalid", message: `a tip in ${subtotal.currency}` });
    } else {
      const capped = Math.min(Math.max(0, Math.trunc(amount)), subtotal.value);
      add += capped;
      tip = {
        ...(t.percent !== undefined ? { percent: t.percent } : {}),
        amount: { value: capped, currency: subtotal.currency },
      };
    }
  }
  return { ...(fulfil ? { fulfil } : {}), ...(tip ? { tip } : {}), add, problems };
}

/** What an order for a time says in a summary: how and when, the zone and its fee, the tip. */
export function fulfilWords(
  payload: { readonly fulfil?: Fulfil | undefined; readonly tip?: Tip | undefined },
  w: Words,
  zone: string,
  lang: string,
): string[] {
  const out: string[] = [];
  const f = payload.fulfil;
  if (f) {
    const at = f.slot ? Date.parse(f.slot.start) : Number.NaN;
    out.push(w.fulfilLine(f.method, Number.isFinite(at) ? at : null, zone));
    if (f.fee) out.push(w.feeLine(f.zone?.name ?? "", kitchenMoney(f.fee, lang)));
  }
  if (payload.tip?.amount && payload.tip.amount.value > 0) out.push(w.tipLine(kitchenMoney(payload.tip.amount, lang)));
  return out;
}
