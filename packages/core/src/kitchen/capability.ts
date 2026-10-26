import {
  ALLERGENS_VOCABULARY,
  allergenLabel,
  DIETARY_CONFLICTS,
  DIETARY_TAGS,
  dietaryConflicts,
  type GetMenuInput,
  type GetMenuOutput,
  isAllergenCode,
  type Jurisdiction,
  jurisdictionOf,
  type KitchenProfile,
  type ListOrderSlotsInput,
  type ListOrderSlotsOutput,
  policySchema,
  tableRulesSchema,
} from "@surfingdog/spec";
import { z } from "zod";
import { basePoint, matchZone } from "../area/index";
import type { ConnectorCapabilities } from "../connectors/capability";
import type { SnapshotMenuItem } from "../connectors/setup-snapshot";
import type { Db } from "../db";
import { ulid } from "../ids";
import { afterEdit, allergenFingerprint, confirmedBy, mayConfirmAllergens } from "../menu/allergens";
import { type MenuFields, type MenuSettings, menuFieldsSchema, menuOf, optionGroupsProblem } from "../menu/schema";
import { kitchenProfile, menuView } from "../menu/view";
import { addDays, dateIn, instantOf } from "../util/zoned";
import { type Caller, isCustomer, isPerson, nowOf } from "../write/caller";
import { WriteError } from "../write/errors";
import { type KitchenContext, kitchenContext, type MenuProduct, menuProducts } from "./context";
import { checkOrder, type KitchenAdds, prepareOrder } from "./order";
import { elsewhereOrders, pauseConnected } from "./pos";
import { type ProgressStage, setOrderProgress } from "./progress";
import { methodsOf, pausedUntil } from "./settings";
import { daySlots } from "./slots";
import { planTable, type TablePlan, tableServiceOf } from "./tables";
import { kitchenWords } from "./words";

/**
 * Restaurants, takeaways, bakeries and cafés (ADR-036): the doors that read the menu and the slots, the
 * checks an order for a time and a table pass on the way in, and the owner's menu, allergens, sold out
 * today, tables, pause and progress. What a customer's agent is told speaks as the business.
 */

/** The owner's edit of one item's place on the menu. */
export const setMenuItemInput = z.object({
  product_id: z.string().min(1).max(64),
  menu: menuFieldsSchema.nullable().describe("The item's menu fields; null takes it off the menu."),
});
export type SetMenuItemInput = z.infer<typeof setMenuItemInput>;

export const confirmAllergensInput = z.object({
  product_id: z.string().min(1).max(64),
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe("The fingerprint of the lists the person was shown (the owner's menu view gives it)."),
});

export const soldOutInput = z.object({ product_id: z.string().min(1).max(64), sold_out: z.boolean() });

export const pauseInput = z
  .object({
    minutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).optional(),
    rest_of_day: z.literal(true).optional(),
    resume: z.literal(true).optional(),
  })
  .refine((p) => [p.minutes !== undefined, p.rest_of_day, p.resume].filter(Boolean).length === 1, {
    message: "minutes, rest_of_day or resume: one of them",
  });

export const progressInput = z.object({
  stage: z.enum(["preparing", "ready", "out_for_delivery"]),
  eta_at: z.iso.datetime({ offset: true }).optional(),
});

export const tableRulesInput = z.object({
  service_id: z.string().min(1).max(64),
  /** Off: the service counts bookings again, as any other. */
  tables: tableRulesSchema.extend({ policy: policySchema.nullable().optional() }).nullable(),
});

export const importMenuInput = z.object({
  connection_id: z.string().min(1).max(64),
  items: z.array(z.string().min(1).max(100)).min(1).max(300).describe("The tool's ids of the items to keep."),
});

function person(caller: Caller, what: string): void {
  if (!isPerson(caller) || caller.principal?.via === "oauth") {
    throw new WriteError(
      "not_allowed",
      `Only a person at the business can ${what}, in the app. Tell the owner in a note what you suggest.`,
      { details: { reason: "person_only", draft_for_owner: true } },
    );
  }
}

function ownerSide(caller: Caller): void {
  if (isCustomer(caller)) throw new WriteError("not_allowed", "this is the business's");
}

export interface OwnerMenuItem {
  readonly product: Pick<MenuProduct, "id" | "name" | "description" | "price" | "active" | "source" | "externalId">;
  readonly menu: MenuFields | null;
  /** What a person confirms when they press confirm: the fingerprint of the lists shown. */
  readonly fingerprint: string | null;
  readonly sold_out_today: boolean;
}

/** Settings → Menu, as the owner's app reads it: every product, the sections, and the words to choose from. */
export interface OwnerMenu {
  readonly items: OwnerMenuItem[];
  readonly sections: MenuSettings["sections"];
  readonly dayparts: MenuSettings["dayparts"];
  readonly vocabulary: {
    /** The list the business declares by, from its country; null: none the vocabulary has. */
    readonly where: Jurisdiction | null;
    readonly law: { readonly name: string; readonly law: string; readonly source: string } | null;
    readonly allergens: readonly {
      readonly code: string;
      readonly parent: string | null;
      readonly label: string;
      /** Named by the law where the business is. */
      readonly mandatory: boolean;
      /** Every jurisdiction whose law names it: where the business's has no list, these come first. */
      readonly mandatory_in: readonly string[];
      /** Asked for there, not required (Japan's twenty). */
      readonly recommended: boolean;
    }[];
    readonly dietary: readonly string[];
    /** The allergens each dietary tag cannot sit beside, by the list they are in (spec `DIETARY_CONFLICTS`). */
    readonly dietary_conflicts: Readonly<
      Record<string, { readonly contains: readonly string[]; readonly mayContain: readonly string[] }>
    >;
  };
}

/** A table service's capacity when no covers are set aside: every table is a person's to confirm. */
const TABLES_ON_REQUEST = 1000;

export class FoodCapabilities {
  constructor(
    private readonly db: Db,
    private readonly deps: {
      readonly connectors: ConnectorCapabilities;
      /** Writes a part of the settings as the inbox itself (a person's pause, which any person may press). */
      readonly writeSettings: (doc: Record<string, unknown>, now: number) => Promise<void>;
    },
  ) {}

  /** Whether the menu doors are offered: something is on the menu, or the kitchen takes orders for a time. */
  async offered(): Promise<boolean> {
    const ctx = await kitchenContext(this.db);
    if (ctx.settings.kitchen.enabled) return true;
    const { rows } = await this.db.client.query({
      sql: "SELECT 1 FROM products WHERE menu IS NOT NULL AND active = 1 LIMIT 1",
      params: [],
      method: "all",
    });
    return rows.length > 0;
  }

  getMenu(input: GetMenuInput, now: number): Promise<GetMenuOutput> {
    return menuView(this.db, input, now);
  }

  /** `list_order_slots`: the slots of a day an order can still have, and for delivery the zone it falls in. */
  async listOrderSlots(input: ListOrderSlotsInput, now: number, lang: string): Promise<ListOrderSlotsOutput> {
    const ctx = await kitchenContext(this.db);
    const w = kitchenWords(lang, ctx.name);
    const k = ctx.settings.kitchen;
    const method = input.method ?? "pickup";
    const base = { date: input.date, method, slots: [] as ListOrderSlotsOutput["slots"] };
    if (!k.enabled) return { ...base, answer: "closed", words: w.notForATime };
    const methods = methodsOf(k, ctx.settings.area.zones.length);
    if (!methods.includes(method)) {
      return {
        ...base,
        answer: method === "delivery" ? "no_delivery" : "closed",
        words: method === "delivery" ? w.noDelivery : w.chooseMethod(methods),
      };
    }
    let zone: ListOrderSlotsOutput["zone"];
    if (method === "delivery") {
      const site = {
        ...(input.postal_code ? { postalCode: input.postal_code } : {}),
        ...(input.country ? { country: input.country.toUpperCase() } : {}),
        ...(input.lat !== undefined && input.lng !== undefined ? { point: { lat: input.lat, lng: input.lng } } : {}),
      };
      if (!site.postalCode && !site.point) return { ...base, answer: "on_request", words: w.addressUnknown };
      const z = matchZone(ctx.settings.area.zones, basePoint(ctx.settings.area, ctx.premises), site);
      if (!z) return { ...base, answer: "outside", words: w.noDeliveryThere };
      zone = {
        name: z.zone.name,
        ...(z.zone.fee ? { fee: z.zone.fee } : {}),
        ...(z.zone.minimumOrder ? { minimum_order: z.zone.minimumOrder } : {}),
        ...(z.zone.etaMin !== undefined ? { eta_min: z.zone.etaMin } : {}),
      };
    }
    const day = await daySlots(this.db, ctx, { date: input.date, now });
    const slots = day.slots.slice(0, 200).map((s) => ({
      start: new Date(s.start).toISOString(),
      end: new Date(s.end).toISOString(),
      left: s.left,
    }));
    const paused = day.pausedUntil !== null ? { paused_until: new Date(day.pausedUntil).toISOString() } : {};
    const earliest = { earliest: new Date(day.earliest).toISOString() };
    if (slots.length === 0) {
      const answer = day.reason === "paused" ? "paused" : "closed";
      return {
        ...base,
        answer,
        ...earliest,
        ...(zone ? { zone } : {}),
        ...paused,
        words:
          answer === "paused" && day.pausedUntil !== null ? w.paused(day.pausedUntil, ctx.timezone) : w.closedThatDay,
      };
    }
    const first = day.slots[0] as { start: number };
    return {
      ...base,
      answer: "open",
      ...earliest,
      slots,
      ...(zone ? { zone } : {}),
      ...paused,
      words: w.slotsOpen(slots.length, first.start, ctx.timezone),
    };
  }

  /** `get_business_profile`'s `kitchen`: how the business takes orders and tables; null when it does not. */
  async profile(now: number): Promise<KitchenProfile | null> {
    const ctx = await kitchenContext(this.db);
    const { rows } = await this.db.client.query({
      sql: "SELECT id FROM services WHERE capacity_unit = 'people' AND active = 1 ORDER BY sort, name LIMIT 1",
      params: [],
      method: "all",
    });
    const table = rows[0] ? await tableServiceOf(this.db, String(rows[0][0])) : null;
    const tables = table
      ? {
          max_party: table.rules.maxParty,
          ...(table.rules.quoteAbove ? { quote_above: table.rules.quoteAbove } : {}),
          confirms: table.rules.setAside ? ("set_aside" as const) : ("on_request" as const),
        }
      : undefined;
    return kitchenProfile(ctx, now, tables);
  }

  /** Checks a customer's order for a time before they are asked to confirm it; null when it is not the kitchen's. */
  async checkOrder(
    caller: Caller,
    payload: unknown,
    o: { readonly lang: string; readonly locationId?: string | null | undefined },
  ): Promise<{ ctx: KitchenContext; products: Map<string, MenuProduct> } | null> {
    if (!isCustomer(caller) || !payload || typeof payload !== "object") return null;
    return checkOrder(this.db, payload as Parameters<typeof checkOrder>[1], { now: nowOf(caller), ...o });
  }

  /** What the inbox adds to a checked order as it takes it: its places and why it waits. */
  prepareOrder(
    checked: { ctx: KitchenContext; products: Map<string, MenuProduct> },
    payload: unknown,
    locationId: string | null | undefined,
  ): Promise<KitchenAdds> {
    return prepareOrder(this.db, checked, payload as Parameters<typeof prepareOrder>[2], { locationId });
  }

  /** What a customer's booking of a table becomes; null when the service is not a table. */
  async planTable(caller: Caller, payload: unknown, lang: string): Promise<TablePlan | null> {
    if (!isCustomer(caller) || !payload || typeof payload !== "object") return null;
    const p = payload as { reservationFor?: { serviceId?: unknown }; partySize?: number; startTime?: string };
    const serviceId = typeof p.reservationFor?.serviceId === "string" ? p.reservationFor.serviceId : null;
    if (!serviceId || typeof p.startTime !== "string") return null;
    const table = await tableServiceOf(this.db, serviceId);
    if (!table) return null;
    return planTable(this.db, table, { partySize: p.partySize, startTime: p.startTime }, lang, nowOf(caller));
  }

  /* --- the owner's ---------------------------------------------------------------- */

  /** Settings → Menu: every product, on the menu or not, with what a person would confirm. */
  async ownerMenu(caller: Caller): Promise<OwnerMenu> {
    ownerSide(caller);
    const ctx = await kitchenContext(this.db);
    const today = dateIn(nowOf(caller), ctx.timezone);
    const rows = await menuProducts(this.db, { all: true });
    const items: OwnerMenuItem[] = [];
    for (const p of rows) {
      items.push({
        product: {
          id: p.id,
          name: p.name,
          description: p.description,
          price: p.price,
          active: p.active,
          source: p.source,
          externalId: p.externalId,
        },
        menu: p.menu,
        fingerprint: p.menu ? await allergenFingerprint(p.menu) : null,
        sold_out_today: p.soldOutOn === today,
      });
    }
    const where = jurisdictionOf(ctx.settings.directory.address.addressCountry);
    return {
      items,
      sections: ctx.settings.menu.sections,
      dayparts: ctx.settings.menu.dayparts,
      vocabulary: {
        where,
        law: where ? ALLERGENS_VOCABULARY.jurisdictions[where] : null,
        allergens: ALLERGENS_VOCABULARY.allergens.map((a) => ({
          code: a.code,
          parent: a.parent,
          label: allergenLabel(a.code, "en"),
          mandatory: where ? a.mandatory_in.includes(where) : false,
          mandatory_in: a.mandatory_in,
          recommended: where ? a.recommended_in.includes(where) : false,
        })),
        dietary: [...DIETARY_TAGS],
        dietary_conflicts: DIETARY_CONFLICTS as OwnerMenu["vocabulary"]["dietary_conflicts"],
      },
    };
  }

  /**
   * Puts a product on the menu, changes its place there, or takes it off. A person's: what each option
   * adds, the caps set aside and made to order are money and promises. Allergens that changed are
   * unconfirmed again, whoever changed them; nothing here confirms them.
   */
  async setMenuItem(caller: Caller, input: SetMenuItemInput): Promise<OwnerMenuItem> {
    person(caller, "change the menu");
    const now = nowOf(caller);
    const before = await this.product(input.product_id);
    if (input.menu === null) {
      await this.db.client.query({
        sql: "UPDATE products SET menu = NULL, updated_at = ? WHERE id = ?",
        params: [now, before.id],
        method: "run",
      });
      return this.item(before.id, now);
    }
    const problem = optionGroupsProblem(input.menu.optionGroups);
    if (problem) {
      throw new WriteError("invalid_input", problem, {
        fields: [{ path: "menu.optionGroups", problem: "invalid", message: problem }],
      });
    }
    // A dietary tag its own allergens contradict is never kept: agents would tell a coeliac it is safe.
    const conflicts = dietaryConflicts(input.menu.dietary, input.menu.allergens);
    if (conflicts.length) {
      const fields = conflicts.map((c) => ({
        path: "menu.dietary",
        problem: "invalid" as const,
        message: `${DIETARY_WORDS[c.tag] ?? c.tag}, but it ${c.list === "contains" ? "contains" : "may contain"} ${allergenLabel(c.code, "en").toLowerCase()}: take one off.`,
      }));
      throw new WriteError("invalid_input", fields.map((f) => f.message).join(" "), { fields });
    }
    const menu: MenuFields = { ...input.menu, allergens: afterEdit(before.menu, input.menu, caller) };
    // Withdrawal (ADR-018 §7; 2011/83/EU art. 16(c), (d)): a dish made to order is the `personalised`
    // exception, and any other dish on the menu the `perishable` one, as prepared food does not keep.
    // Only what the inbox set follows the menu; an exception the owner chose stays theirs.
    const withdrawal = menu.madeToOrder
      ? before.withdrawal === "standard" || before.withdrawal === "perishable"
        ? "personalised"
        : null
      : before.withdrawal === "standard" || (before.withdrawal === "personalised" && before.menu?.madeToOrder)
        ? "perishable"
        : null;
    await this.db.client.query({
      sql: `UPDATE products SET menu = ?, ${withdrawal ? "withdrawal = ?, " : ""}updated_at = ? WHERE id = ?`,
      params: [JSON.stringify(menu), ...(withdrawal ? [withdrawal] : []), now, before.id],
      method: "run",
    });
    return this.item(before.id, now);
  }

  /** A person confirms an item's allergens, exactly as they were shown them. */
  async confirmAllergens(caller: Caller, input: z.infer<typeof confirmAllergensInput>): Promise<OwnerMenuItem> {
    if (!mayConfirmAllergens(caller)) {
      throw new WriteError(
        "not_allowed",
        "Only a person at the business, signed in to the app, confirms allergens. Tell the owner which dishes to check.",
        { details: { reason: "person_only", guard: "allergens", draft_for_owner: true } },
      );
    }
    const now = nowOf(caller);
    const p = await this.product(input.product_id);
    // The menu exactly as stored: the confirm writes only over these bytes, so a change another person
    // saved a moment ago is never written back as confirmed.
    const { rows } = await this.db.client.query({
      sql: "SELECT menu FROM products WHERE id = ?",
      params: [p.id],
      method: "all",
    });
    const stored = typeof rows[0]?.[0] === "string" ? (rows[0][0] as string) : null;
    const read = menuOf(stored);
    const changed = () =>
      new WriteError("guard_failed", "The allergens changed since you looked: check them again before you confirm.", {
        details: { guard: "allergens_changed" },
      });
    if (!read || stored === null) throw new WriteError("invalid_input", "This product is not on the menu.");
    if ((await allergenFingerprint(read)) !== input.fingerprint) throw changed();
    const menu: MenuFields = { ...read, allergens: confirmedBy(read, caller, now) };
    const done = await this.db.client.query({
      sql: "UPDATE products SET menu = ?, updated_at = ? WHERE id = ? AND menu = ?",
      params: [JSON.stringify(menu), now, p.id, stored],
      method: "run",
    });
    if (done.changes !== 1) throw changed();
    return this.item(p.id, now);
  }

  /** "Sold out today": back on sale tomorrow by itself. Anyone at the business, their AI too. */
  async setSoldOut(caller: Caller, input: z.infer<typeof soldOutInput>): Promise<OwnerMenuItem> {
    ownerSide(caller);
    const now = nowOf(caller);
    const p = await this.product(input.product_id);
    const ctx = await kitchenContext(this.db);
    await this.db.client.query({
      sql: "UPDATE products SET sold_out_on = ?, updated_at = ? WHERE id = ?",
      params: [input.sold_out ? dateIn(now, ctx.timezone) : null, now, p.id],
      method: "run",
    });
    return this.item(p.id, now);
  }

  /** A service's table rules: covers in people, the largest party, a deposit, covers set aside, a policy. */
  async setTableRules(caller: Caller, input: z.infer<typeof tableRulesInput>): Promise<unknown> {
    person(caller, "change how tables are booked");
    const now = nowOf(caller);
    const { rows } = await this.db.client.query({
      sql: "SELECT id FROM services WHERE id = ?",
      params: [input.service_id],
      method: "all",
    });
    if (!rows[0]) throw new WriteError("not_found", "no such service");
    if (input.tables === null) {
      await this.db.client.query({
        // Counting bookings again: one at a time where the inbox kept no limit of its own for tables.
        sql: `UPDATE services SET capacity_unit = 'bookings', table_rules = NULL,
                     capacity = CASE WHEN capacity >= ? THEN 1 ELSE capacity END, updated_at = ? WHERE id = ?`,
        params: [TABLES_ON_REQUEST, now, input.service_id],
        method: "run",
      });
      return { service_id: input.service_id, tables: null };
    }
    const t = input.tables;
    // The covers set aside are the places the inbox sells a sitting, and nothing more: the service's
    // capacity, in people. A larger party, or any party when none are set aside, is a person's to seat
    // (`kitchen/guard.ts`), and a person's confirm is never held to this number. Without covers set aside
    // the inbox counts no limit of its own: the person who confirms each table knows the room.
    const capacity = t.setAside ?? TABLES_ON_REQUEST;
    // A table is for a set date: the dated-leisure exception to withdrawal (2011/83/EU art. 16(l)).
    await this.db.client.query({
      sql: `UPDATE services SET capacity_unit = 'people', table_rules = ?, capacity = ?,
                   withdrawal = CASE WHEN withdrawal = 'standard' THEN 'dated_leisure' ELSE withdrawal END,
                   updated_at = ? WHERE id = ?`,
      params: [JSON.stringify(t), Math.min(TABLES_ON_REQUEST, capacity), now, input.service_id],
      method: "run",
    });
    return { service_id: input.service_id, tables: t };
  }

  /** Pause orders: 15, 30 or 60 minutes, or the rest of the day; resume. Any person at the business. */
  async pause(
    caller: Caller,
    input: z.infer<typeof pauseInput>,
  ): Promise<{ paused_until: string | null; systems: unknown }> {
    if (!isPerson(caller)) {
      throw new WriteError("not_allowed", "Pausing orders is a person's: press it in the app.", {
        details: { reason: "person_only" },
      });
    }
    const now = nowOf(caller);
    const ctx = await kitchenContext(this.db);
    let until: number | null = null;
    if (input.minutes) until = now + input.minutes * 60_000;
    if (input.rest_of_day) until = instantOf(addDays(dateIn(now, ctx.timezone), 1), "00:00", ctx.timezone);
    await this.deps.writeSettings(
      {
        kitchen: {
          pause: until === null ? null : { until: new Date(until).toISOString(), by: caller.actor.id.slice(0, 120) },
        },
      },
      now,
    );
    const systems = await pauseConnected(this.db, this.deps.connectors, until, now);
    return { paused_until: until === null ? null : new Date(until).toISOString(), systems };
  }

  /** The kitchen's progress on an order: preparing, ready, out for delivery. */
  setProgress(caller: Caller, itemId: string, input: z.infer<typeof progressInput>) {
    ownerSide(caller);
    return setOrderProgress(this.db, caller, {
      itemId,
      stage: input.stage as ProgressStage,
      ...(input.eta_at ? { etaAt: input.eta_at } : {}),
    });
  }

  /** Orders taken in the business's own ordering system, for its eyes only. */
  async ordersElsewhere(caller: Caller) {
    ownerSide(caller);
    return { orders: await elsewhereOrders(this.db, nowOf(caller)) };
  }

  /** Whether orders are paused now, and until when, for the inbox's home. */
  async kitchenNow(caller: Caller): Promise<{ enabled: boolean; paused_until: string | null; pause_pos: boolean }> {
    ownerSide(caller);
    const ctx = await kitchenContext(this.db);
    const until = pausedUntil(ctx.settings.kitchen, nowOf(caller));
    return {
      enabled: ctx.settings.kitchen.enabled,
      paused_until: until === null ? null : new Date(until).toISOString(),
      pause_pos: ctx.settings.kitchen.pausePos,
    };
  }

  /**
   * Keeps the items a person picked from a tool's menu (`setup_in`), read again now from the tool: never
   * what the browser sent. Prices are the business's own, as its tool has them; allergens arrive
   * unconfirmed, and a person confirms each dish.
   */
  async importMenu(caller: Caller, input: z.infer<typeof importMenuInput>): Promise<{ kept: number; updated: number }> {
    person(caller, "bring in a menu");
    const now = nowOf(caller);
    const snapshot = await this.deps.connectors.setupSnapshot(caller, input.connection_id);
    const kind = snapshot.source.kind;
    const wanted = new Set(input.items);
    const ctx = await kitchenContext(this.db);
    let kept = 0;
    let updated = 0;
    const sections = [...ctx.settings.menu.sections];
    for (const section of snapshot.menu ?? []) {
      const sectionId = slug(section.name);
      for (const item of section.items) {
        if (!wanted.has(item.externalId)) continue;
        if (!sections.some((s) => s.id === sectionId))
          sections.push({ id: sectionId, name: section.name.slice(0, 120), sort: sections.length });
        const menu = menuFromSnapshot(item, sectionId);
        const { rows } = await this.db.client.query({
          sql: "SELECT id, menu FROM products WHERE source = ? AND external_id = ?",
          params: [kind, item.externalId],
          method: "all",
        });
        const price = item.price ?? null;
        if (rows[0]) {
          const id = String(rows[0][0]);
          const before = menuOf(rows[0][1]);
          const next = mergeImported(before, menu, item, caller, kind);
          await this.db.client.query({
            sql: `UPDATE products SET name = ?, description = ?, ${price ? "price = ?, " : ""}menu = ?, updated_at = ? WHERE id = ?`,
            params: [
              item.name.slice(0, 200),
              item.description ?? null,
              ...(price ? [JSON.stringify(price)] : []),
              JSON.stringify(next),
              now,
              id,
            ],
            method: "run",
          });
          updated++;
        } else {
          if (!price) continue;
          const next: MenuFields = { ...menu, allergens: { ...menu.allergens, status: "unconfirmed", source: kind } };
          await this.db.client.query({
            sql: `INSERT INTO products (id, name, description, price, source, external_id, active, menu, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            params: [
              ulid(),
              item.name.slice(0, 200),
              item.description ?? null,
              JSON.stringify(price),
              kind,
              item.externalId,
              JSON.stringify(next),
              now,
              now,
            ],
            method: "run",
          });
          kept++;
        }
      }
    }
    if (sections.length !== ctx.settings.menu.sections.length) {
      await this.deps.writeSettings({ menu: { sections: sections.slice(0, 50) } }, now);
    }
    return { kept, updated };
  }

  private async product(id: string): Promise<MenuProduct> {
    const all = await menuProducts(this.db, { all: true });
    const p = all.find((x) => x.id === id);
    if (!p)
      throw new WriteError("not_found", "no such product", {
        fields: [{ path: "product_id", problem: "invalid", message: "unknown product" }],
      });
    return p;
  }

  private async item(id: string, now: number): Promise<OwnerMenuItem> {
    const p = await this.product(id);
    const ctx = await kitchenContext(this.db);
    return {
      product: {
        id: p.id,
        name: p.name,
        description: p.description,
        price: p.price,
        active: p.active,
        source: p.source,
        externalId: p.externalId,
      },
      menu: p.menu,
      fingerprint: p.menu ? await allergenFingerprint(p.menu) : null,
      sold_out_today: p.soldOutOn === dateIn(now, ctx.timezone),
    };
  }
}

const DIETARY_WORDS: Readonly<Record<string, string>> = {
  vegan: "Vegan",
  vegetarian: "Vegetarian",
  gluten_free: "Gluten free",
  dairy_free: "Dairy free",
  nut_free: "Nut free",
};

/**
 * A dish brought in again from the tool it came from: the tool's name, price and option groups (with its
 * ids) are taken, and every field the owner set here is kept (its section, sort, caps, notice, days,
 * dayparts, age limit, what it is made to order with). Its allergens stay as they are when the tool sends
 * none, and become unconfirmed only when the tool's lists differ from them.
 */
export function mergeImported(
  before: MenuFields | null,
  fromTool: MenuFields,
  item: SnapshotMenuItem,
  caller: Caller,
  kind: string,
): MenuFields {
  if (!before) return { ...fromTool, allergens: afterEdit(null, fromTool, caller, kind) };
  const sent = item.allergens !== undefined;
  const lists = sent ? fromTool.allergens : before.allergens;
  // A choice the owner gave allergens to keeps them, matched by the tool's id.
  const groups = fromTool.optionGroups.map((g) => {
    const was = before.optionGroups.find((x) => x.externalId !== undefined && x.externalId === g.externalId);
    return {
      ...g,
      choices: g.choices.map((c) => {
        const prior = was?.choices.find((x) => x.externalId !== undefined && x.externalId === c.externalId);
        return prior?.allergens ? { ...c, allergens: prior.allergens } : c;
      }),
    };
  });
  const dietary = item.dietary !== undefined ? fromTool.dietary : before.dietary;
  const next: MenuFields = {
    ...before,
    optionGroups: groups,
    dietary,
    ...(fromTool.externalGroupId ? { externalGroupId: fromTool.externalGroupId } : {}),
    allergens: { ...before.allergens, contains: lists.contains, mayContain: lists.mayContain },
  };
  return { ...next, allergens: afterEdit(before, next, caller, kind) };
}

/** A section's id from its name: lower-case letters, digits and dashes. */
export function slug(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || `s-${Math.abs(hash(name)).toString(36)}`;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** A tool's item as a menu's fields: its groups and choices with the tool's ids, its allergens unconfirmed. */
export function menuFromSnapshot(item: SnapshotMenuItem, section: string): MenuFields {
  const groups = (item.optionGroups ?? []).slice(0, 20).map((g, gi) => ({
    id: `g${gi + 1}`,
    name: g.name.slice(0, 120) || `Options ${gi + 1}`,
    min: Math.max(0, Math.min(50, g.min)),
    max: Math.max(1, Math.min(50, Math.max(g.max, g.min, 1))),
    externalId: g.externalId.slice(0, 100),
    choices: g.choices.slice(0, 60).map((c, ci) => ({
      id: `c${ci + 1}`,
      name: c.name.slice(0, 120) || `Choice ${ci + 1}`,
      ...(c.priceDelta > 0 ? { priceDelta: Math.trunc(c.priceDelta) } : {}),
      ...(c.default ? { default: true } : {}),
      externalId: c.externalId.slice(0, 100),
    })),
  }));
  const valid = groups.filter((g) => g.choices.length > 0);
  return menuFieldsSchema.parse({
    section,
    ...(item.groupExternalId ? { externalGroupId: item.groupExternalId.slice(0, 100) } : {}),
    optionGroups: valid,
    allergens: {
      contains: (item.allergens?.contains ?? []).filter(isAllergenCode),
      mayContain: (item.allergens?.mayContain ?? []).filter(isAllergenCode),
      status: "unconfirmed",
    },
    dietary: (item.dietary ?? []).filter((t): t is (typeof DIETARY_TAGS)[number] =>
      (DIETARY_TAGS as readonly string[]).includes(t),
    ),
  });
}
