import {
  ALLERGEN_CLAIMS,
  expandAllergens,
  type GetMenuInput,
  type GetMenuOutput,
  type KitchenProfile,
  type MenuItemView,
} from "@surfingdog/spec";
import { areaSummary } from "../area/index";
import type { Db } from "../db";
import { type KitchenContext, kitchenContext, type MenuProduct, menuProducts } from "../kitchen/context";
import { servedAt } from "../kitchen/order";
import { methodsOf, pausedUntil } from "../kitchen/settings";
import { weekdayOf } from "../kitchen/slots";
import { dateIn } from "../util/zoned";
import { allergenView, allergenWords } from "./allergens";
import type { MenuFields } from "./schema";

/**
 * The menu as an agent reads it (`get_menu`, ADR-040): sections in the business's order, each item with
 * its price, its options and what each adds, its allergens with whether a person confirmed them, its
 * dietary tags (the ones about allergens only as sure as its allergens), an age limit, the dayparts it
 * is served in, whether it is available now and whether it is sold out today. Prices are the business's.
 */

export function itemView(
  p: MenuProduct,
  m: MenuFields,
  ctx: KitchenContext,
  at: number,
  sectionName: string,
): MenuItemView {
  const today = dateIn(at, ctx.timezone);
  const soldOut = p.soldOutOn === today;
  const made = m.availableDays.length === 0 || m.availableDays.includes(weekdayOf(today));
  const allergens = allergenView(m.allergens);
  const opener = new Map<string, { group_id: string; choice_id: string }>();
  for (const g of m.optionGroups)
    for (const c of g.choices) if (c.opens) opener.set(c.opens, { group_id: g.id, choice_id: c.id });
  return {
    id: p.id,
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    price: p.price,
    section: sectionName,
    options: m.optionGroups.map((g) => ({
      id: g.id,
      name: g.name,
      min: g.min,
      max: g.max,
      ...(g.halves ? { halves: true } : {}),
      ...(opener.has(g.id) ? { opened_by: opener.get(g.id) as { group_id: string; choice_id: string } } : {}),
      choices: g.choices.map((c) => ({
        id: c.id,
        name: c.name,
        ...(c.priceDelta ? { price_delta: { value: c.priceDelta, currency: p.price.currency } } : {}),
        ...(c.default ? { default: true } : {}),
        ...(c.allergens && (c.allergens.contains.length || c.allergens.mayContain.length)
          ? {
              allergens: {
                contains: expandAllergens(c.allergens.contains),
                may_contain: expandAllergens(c.allergens.mayContain),
              },
            }
          : {}),
        ...(c.opens ? { opens: c.opens } : {}),
      })),
    })),
    allergens,
    dietary: m.dietary.map((tag) => (ALLERGEN_CLAIMS.has(tag) ? { tag, status: allergens.status } : { tag })),
    ...(m.ageRestricted !== null ? { age_restricted: m.ageRestricted } : {}),
    ...(m.dayparts.length ? { dayparts: m.dayparts } : {}),
    available_now: p.active && !soldOut && made && !m.blackout.includes(today) && servedAt(ctx, m, at),
    sold_out_today: soldOut,
    ...(m.noticeMin > 0 ? { notice_min: m.noticeMin } : {}),
    ...(m.availableDays.length ? { available_days: m.availableDays } : {}),
    ...(m.madeToOrder ? { made_to_order: true } : {}),
    ...(m.brief
      ? {
          brief: {
            ...(m.brief.servings ? { servings: m.brief.servings } : {}),
            ...(m.brief.flavours?.length ? { flavours: m.brief.flavours } : {}),
            ...(m.brief.messageMax ? { message_max: m.brief.messageMax } : {}),
            ...(m.brief.photo ? { photo: true } : {}),
          },
        }
      : {}),
    ...(m.combo ? { combo: m.optionGroups.map((g) => ({ group: g.name, quantity: Math.max(1, g.min) })) } : {}),
  };
}

/** How the business takes orders, as `get_business_profile`'s `kitchen` says it; null when it does not. */
export function kitchenProfile(
  ctx: KitchenContext,
  now: number,
  tables?: KitchenProfile["tables"],
): KitchenProfile | null {
  const k = ctx.settings.kitchen;
  if (!k.enabled && !tables) return null;
  const zones = ctx.settings.area.zones;
  const paused = pausedUntil(k, now);
  const methods = k.enabled ? methodsOf(k, zones.length) : [];
  return {
    methods,
    prep_min: k.prepMin,
    slot_min: k.slotMin,
    confirms: k.accept === "caps" ? "within_caps" : "on_request",
    ...(paused !== null ? { paused_until: new Date(paused).toISOString() } : {}),
    ...(k.tips.enabled ? { tips: { choices: k.tips.choices } } : {}),
    ...(methods.includes("delivery")
      ? {
          delivery: {
            zones: zones.map((z) => ({
              name: z.name,
              ...(z.mode === "radius" && z.radiusKm !== undefined ? { radius_km: z.radiusKm } : {}),
              ...(z.mode === "postal" && z.postal ? { postal: z.postal } : {}),
              ...(z.fee ? { fee: z.fee } : {}),
              ...(z.minimumOrder ? { minimum_order: z.minimumOrder } : {}),
              ...(z.etaMin !== undefined ? { eta_min: z.etaMin } : {}),
            })),
          },
        }
      : {}),
    ...(tables ? { tables } : {}),
    allergens: allergenWords(ctx.name, ctx.language),
  };
}

/** `get_menu`: what is on the menu, by section. */
export async function menuView(db: Db, input: GetMenuInput, now: number): Promise<GetMenuOutput> {
  const ctx = await kitchenContext(db);
  const at = input.at ? Date.parse(input.at) : now;
  const sections = [...ctx.settings.menu.sections].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const byId = new Map(sections.map((s) => [s.id, s]));
  const items = (await menuProducts(db)).filter((p) => p.active && p.menu);
  const wanted = input.section?.trim().toLowerCase();
  const groups = new Map<string, { id: string; name: string; items: MenuItemView[] }>();
  for (const p of items) {
    const m = p.menu as MenuFields;
    if (input.daypart && m.dayparts.length > 0 && !m.dayparts.includes(input.daypart)) continue;
    const section = byId.get(m.section) ?? {
      id: m.section,
      name: m.section === "menu" ? "Menu" : m.section,
      sort: 10_000,
    };
    if (wanted && section.id.toLowerCase() !== wanted && section.name.toLowerCase() !== wanted) continue;
    let g = groups.get(section.id);
    if (!g) {
      g = { id: section.id, name: section.name, items: [] };
      groups.set(section.id, g);
    }
    g.items.push(itemView(p, m, ctx, at, section.name));
  }
  const order = (id: string) => byId.get(id)?.sort ?? 10_000;
  const profile = kitchenProfile(ctx, now);
  return {
    currency: ctx.currency,
    sections: [...groups.values()].sort((a, b) => order(a.id) - order(b.id) || a.name.localeCompare(b.name)),
    dayparts: ctx.settings.menu.dayparts,
    ...(profile ? { kitchen: profile } : {}),
    words: allergenWords(ctx.name, ctx.language),
  };
}

/** Where a kitchen delivers, as agents may be told: the area's public summary, never the base. */
export function deliverySummary(ctx: KitchenContext) {
  return areaSummary(ctx.settings.area);
}
