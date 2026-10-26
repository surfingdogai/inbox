import type { KitchenSettings, MenuFields, OptionGroup, OwnerMenu, OwnerMenuItem, Settings } from "@surfingdog/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseMoney } from "./actions";
import { ownerCall } from "./api";
import { formatClock, formatMoney, localDateKey, slotShort, slotWhen } from "./format";
import type { ItemOf, ItemView, Money } from "./types";

/**
 * Restaurants, takeaways, bakeries and cafés (ADR-040), as the owner sees them: the menu and its
 * allergens, the kitchen's settings, the pause, an order's progress. The calls, the query hooks, and the
 * few words the screens share, kept here so they are tested once. Type-only imports from core.
 */

export type { MenuFields, OptionGroup, OwnerMenu, OwnerMenuItem };
export type KitchenDoc = KitchenSettings;
export type MenuSettingsDoc = Settings["menu"];
export type OrderItem = ItemOf<"order">;

export interface KitchenNow {
  readonly enabled: boolean;
  readonly paused_until: string | null;
  readonly pause_pos: boolean;
}

export interface PauseAnswer {
  readonly paused_until: string | null;
  readonly systems: readonly { readonly kind: string; readonly outcome: string }[];
}

export interface ElsewhereOrderView {
  readonly connector_id: string;
  readonly external_id: string;
  readonly accepted_at: string | null;
  readonly view: {
    readonly kind?: string;
    readonly method?: string;
    readonly lines?: readonly { readonly name: string; readonly quantity: number }[];
    readonly total?: Money;
    readonly for?: string;
  };
}

export interface MenuSnapshot {
  readonly source: { readonly kind: string; readonly account: string; readonly readAt: number };
  readonly menu?:
    | readonly {
        readonly name: string;
        readonly items: readonly {
          readonly externalId: string;
          readonly name: string;
          readonly price?: Money | null;
        }[];
      }[]
    | undefined;
}

const enc = encodeURIComponent;

export const foodApi = {
  menu: () => ownerCall<OwnerMenu>("GET", "/v1/owner/menu"),
  setItem: (productId: string, menu: MenuFields | null) =>
    ownerCall<OwnerMenuItem>("PUT", `/v1/owner/menu/items/${enc(productId)}`, { body: { menu }, idempotent: true }),
  confirm: (productId: string, fingerprint: string) =>
    ownerCall<OwnerMenuItem>("POST", `/v1/owner/menu/items/${enc(productId)}/allergens/confirm`, {
      body: { fingerprint },
      idempotent: true,
    }),
  soldOut: (productId: string, soldOut: boolean) =>
    ownerCall<OwnerMenuItem>("POST", `/v1/owner/menu/items/${enc(productId)}/sold-out`, {
      body: { sold_out: soldOut },
      idempotent: true,
    }),
  snapshot: (connectionId: string) =>
    ownerCall<MenuSnapshot>("GET", `/v1/owner/integrations/${enc(connectionId)}/setup`),
  importMenu: (connectionId: string, items: readonly string[]) =>
    ownerCall<{ kept: number; updated: number }>("POST", "/v1/owner/menu/import", {
      body: { connection_id: connectionId, items },
      idempotent: true,
    }),
  tables: (serviceId: string, tables: Record<string, unknown> | null) =>
    ownerCall<unknown>("PUT", `/v1/owner/services/${enc(serviceId)}/tables`, { body: { tables }, idempotent: true }),
  kitchen: () => ownerCall<KitchenNow>("GET", "/v1/owner/kitchen"),
  pause: (body: { minutes: 15 | 30 | 60 } | { rest_of_day: true } | { resume: true }) =>
    ownerCall<PauseAnswer>("POST", "/v1/owner/kitchen/pause", { body, idempotent: true }),
  progress: (itemId: string, stage: ProgressStage) =>
    ownerCall<unknown>("POST", `/v1/owner/items/${enc(itemId)}/progress`, { body: { stage }, idempotent: true }),
  elsewhere: () => ownerCall<{ orders: ElsewhereOrderView[] }>("GET", "/v1/owner/pos-orders"),
};

export function useMenu() {
  return useQuery({ queryKey: ["menu"], queryFn: foodApi.menu, staleTime: 15_000 });
}

export function useKitchenNow(enabled = true) {
  return useQuery({
    queryKey: ["kitchen"],
    queryFn: foodApi.kitchen,
    enabled,
    staleTime: 15_000,
    // A pause ends on its own: look again around then.
    refetchInterval: 60_000,
  });
}

export function usePause() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: foodApi.pause,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["kitchen"] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export function useProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { itemId: string; stage: ProgressStage }) => foodApi.progress(v.itemId, v.stage),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ["items"] });
      void qc.invalidateQueries({ queryKey: ["item", v.itemId] });
      void qc.invalidateQueries({ queryKey: ["today"] });
    },
  });
}

export function useMenuWrite() {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ["menu"] });
  return {
    set: useMutation({
      mutationFn: (v: { productId: string; menu: MenuFields | null }) => foodApi.setItem(v.productId, v.menu),
      onSuccess: done,
    }),
    confirm: useMutation({
      mutationFn: (v: { productId: string; fingerprint: string }) => foodApi.confirm(v.productId, v.fingerprint),
      onSuccess: done,
    }),
    soldOut: useMutation({
      mutationFn: (v: { productId: string; soldOut: boolean }) => foodApi.soldOut(v.productId, v.soldOut),
      onSuccess: done,
    }),
  };
}

/**
 * Whether the business is a kitchen, for the Menu and Kitchen tabs: it takes orders for a time, or its
 * menu has sections. A salon or a shop never sees them; a link straight to either still opens it.
 */
export function foodKind(
  doc:
    | { readonly kitchen?: { readonly enabled?: boolean }; readonly menu?: { readonly sections?: readonly unknown[] } }
    | undefined,
): boolean {
  return doc?.kitchen?.enabled === true || (doc?.menu?.sections?.length ?? 0) > 0;
}

/** A dish's menu fields as it is first put on the menu: in a section, its allergens for the owner to state. */
export const EMPTY_MENU: MenuFields = {
  section: "menu",
  sort: 0,
  optionGroups: [],
  allergens: { contains: [], mayContain: [], status: "unconfirmed" },
  dietary: [],
  ageRestricted: null,
  dayparts: [],
  combo: false,
  noticeMin: 0,
  dailyCap: null,
  availableDays: [],
  blackout: [],
  madeToOrder: false,
  brief: null,
};

/* --- words ------------------------------------------------------------------------ */

export type ProgressStage = "preparing" | "ready" | "out_for_delivery";

/** Where an order stands in the kitchen, as a state. */
export const STAGE_WORDS: Readonly<Record<ProgressStage, string>> = {
  preparing: "Preparing",
  ready: "Ready",
  out_for_delivery: "Out for delivery",
};

/** The press that moves it there, as an action. */
export const STAGE_ACTIONS: Readonly<Record<ProgressStage, string>> = {
  preparing: "Start preparing",
  ready: "Mark ready",
  out_for_delivery: "Out for delivery",
};

export const METHOD_WORDS: Readonly<Record<string, string>> = {
  pickup: "Collection",
  delivery: "Delivery",
  dine_in: "Eat in",
};

/** Why an order waits for a person, in the owner's words (`payload.kitchen.hold`). */
export const HOLD_WORDS: Readonly<Record<string, string>> = {
  allergens_unconfirmed:
    "Allergens on this order are not confirmed yet: check them with the kitchen before you accept.",
  over_cap: "Over what you set aside for this slot or day: accept only if the kitchen can make it.",
  made_to_order: "Made to order: you decide on each one.",
  owner_accepts: "You accept each order (Settings → Kitchen).",
};

export const DIETARY_WORDS: Readonly<Record<string, string>> = {
  vegan: "Vegan",
  vegetarian: "Vegetarian",
  gluten_free: "Gluten free",
  dairy_free: "Dairy free",
  nut_free: "Nut free",
  halal: "Halal",
  kosher: "Kosher",
  spicy: "Spicy",
};

/** How long ahead an item must be ordered, one press each. */
export const NOTICE_CHOICES: readonly { readonly min: number; readonly label: string }[] = [
  { min: 0, label: "None" },
  { min: 60, label: "1 h" },
  { min: 240, label: "4 h" },
  { min: 1440, label: "1 day" },
  { min: 2880, label: "2 days" },
  { min: 4320, label: "3 days" },
  { min: 10080, label: "1 week" },
];

export const AGE_CHOICES = [null, 16, 18, 19, 20, 21] as const;

export const WEEKDAY_WORDS: readonly (readonly [string, string])[] = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
];

/** A section's id from its name: lower case, letters and digits, `-` between words. */
export function slugOf(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "section";
}

/** A section id not taken yet: "pizzas", then "pizzas-2". */
export function freshId(name: string, taken: readonly string[]): string {
  const base = slugOf(name);
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${Date.now() % 10_000}`;
}

/* --- allergens ------------------------------------------------------------------- */

export interface AllergenLists {
  readonly contains: readonly string[];
  readonly mayContain: readonly string[];
}

/**
 * One press in the grid: a code goes into a column, or comes out of it. A dish contains it or may
 * contain it, never both: choosing one takes it out of the other.
 */
export function toggleAllergen(lists: AllergenLists, code: string, column: "contains" | "mayContain"): AllergenLists {
  const other = column === "contains" ? "mayContain" : "contains";
  const on = lists[column].includes(code);
  const next = on ? lists[column].filter((c) => c !== code) : [...lists[column], code];
  return {
    [column]: next,
    [other]: lists[other].filter((c) => c !== code),
  } as unknown as AllergenLists;
}

type Vocab = OwnerMenu["vocabulary"]["allergens"];

/**
 * The rows of the grid: the ones the law names where the business is, and any the dish already has;
 * with `all`, every one. Where the vocabulary has no list for the
 * country, the ones some law names come first (never Japan's twenty asked-for ones), their parts with `all`.
 */
export function allergenRows(vocab: Vocab, lists: AllergenLists, all: boolean): Vocab {
  const chosen = new Set([...lists.contains, ...lists.mayContain]);
  const named = vocab.some((a) => a.mandatory);
  const first = (a: Vocab[number]) => (named ? a.mandatory : a.parent === null && a.mandatory_in.length > 0);
  // In the vocabulary's order, so a part (wheat, walnut) sits under what it is a part of.
  return all ? [...vocab] : vocab.filter((a) => first(a) || chosen.has(a.code));
}

/** The dish's allergens in a line: "Contains milk, wheat · May contain sesame", or that none were stated. */
export function allergenLine(lists: AllergenLists, label: (code: string) => string): string {
  const names = (codes: readonly string[]) => codes.map((c) => label(c).toLowerCase()).join(", ");
  const parts: string[] = [];
  if (lists.contains.length) parts.push(`Contains ${names(lists.contains)}`);
  if (lists.mayContain.length) parts.push(`May contain ${names(lists.mayContain)}`);
  return parts.length ? parts.join(" · ") : "No allergens stated";
}

/** The allergen of the dish's lists a dietary tag cannot sit beside, if one is there. */
export function conflictOf(
  rule: { readonly contains: readonly string[]; readonly mayContain: readonly string[] } | undefined,
  lists: AllergenLists,
): { code: string; list: "contains" | "mayContain" } | null {
  if (!rule) return null;
  for (const list of ["contains", "mayContain"] as const) {
    const code = lists[list].find((c) => rule[list].includes(c));
    if (code) return { code, list };
  }
  return null;
}

/**
 * What a person confirms, in a sentence: "Curry pan contains wheat, milk and soy, and nothing it may
 * contain." or "…and may contain almond."
 */
export function confirmSentence(name: string, lists: AllergenLists, label: (code: string) => string): string {
  const words = (codes: readonly string[]) => {
    const n = codes.map((c) => label(c).toLowerCase());
    return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
  };
  const contains = lists.contains.length ? `contains ${words(lists.contains)}` : "contains none of these allergens";
  const may = lists.mayContain.length ? `may contain ${words(lists.mayContain)}` : "nothing it may contain";
  return `${name} ${contains}, and ${may}.`;
}

/** Whether two sets of lists say the same, whatever order they were chosen in. */
export function sameAllergens(a: AllergenLists, b: AllergenLists): boolean {
  const eq = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && [...x].sort().join("|") === [...y].sort().join("|");
  return eq(a.contains, b.contains) && eq(a.mayContain, b.mayContain);
}

/* --- the editor's draft ------------------------------------------------------------ */

export interface ChoiceDraft {
  readonly id: string;
  readonly name: string;
  /** What it adds, as typed, in the currency's major unit: "2.50", "60". */
  readonly adds: string;
  readonly opens: string;
}

export interface GroupDraft {
  readonly id: string;
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly halves: boolean;
  readonly choices: readonly ChoiceDraft[];
}

const majorText = (minor: number | undefined, e: number) => (minor ? (minor / 10 ** e).toFixed(e) : "");

/** The option groups as the editor shows them, the money in the currency's own places. */
export function groupDrafts(groups: readonly OptionGroup[], exponent: number): GroupDraft[] {
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    min: g.min,
    max: g.max,
    halves: g.halves === true,
    choices: g.choices.map((c) => ({
      id: c.id,
      name: c.name,
      adds: majorText(c.priceDelta, exponent),
      opens: c.opens ?? "",
    })),
  }));
}

/**
 * The option groups to save, from the editor's draft, keeping what the editor does not show (a choice's
 * allergens, its till id, a deal's product) from the groups as they were. Null with the reason when an
 * amount does not read.
 */
export function groupsWrite(
  drafts: readonly GroupDraft[],
  before: readonly OptionGroup[],
  currency: string,
): { groups: OptionGroup[] } | { problem: string } {
  const out: OptionGroup[] = [];
  for (const g of drafts) {
    const was = before.find((b) => b.id === g.id);
    const choices: OptionGroup["choices"] = [];
    for (const c of g.choices) {
      if (!c.name.trim()) continue;
      const prior = was?.choices.find((x) => x.id === c.id);
      let priceDelta: number | undefined;
      if (c.adds.trim()) {
        const m = parseMoney(c.adds, currency);
        if (!m) return { problem: `${g.name || "An option group"}: ${c.name} adds an amount that does not read.` };
        priceDelta = m.value > 0 ? m.value : undefined;
      }
      const { priceDelta: _p, opens: _o, ...kept } = prior ?? { id: c.id, name: c.name };
      choices.push({
        ...kept,
        id: c.id,
        name: c.name.trim(),
        ...(priceDelta !== undefined ? { priceDelta } : {}),
        ...(c.opens ? { opens: c.opens } : {}),
      });
    }
    if (!g.name.trim() || choices.length === 0) continue;
    const max = Math.max(1, Math.min(50, g.max, choices.length));
    out.push({
      ...(was?.externalId ? { externalId: was.externalId } : {}),
      id: g.id,
      name: g.name.trim(),
      min: Math.min(g.min, max),
      max,
      ...(g.halves ? { halves: true } : {}),
      choices,
    });
  }
  return { groups: out };
}

/** A new id for a group or a choice, not taken on the item. */
export function nextId(prefix: string, taken: readonly string[]): string {
  for (let n = 1; n < 1000; n++) if (!taken.includes(`${prefix}${n}`)) return `${prefix}${n}`;
  return `${prefix}${Date.now() % 100_000}`;
}

/* --- orders -------------------------------------------------------------------------- */

/**
 * The order's fulfilment in a line, with its day unless it is today: "Collection · Today, 19:30",
 * "Collection · Tomorrow, 08:00", "Delivery · Fri 23 Oct, 19:45 · Centro · MX$35.00 delivery".
 */
export function fulfilLine(
  fulfil: OrderItem["payload"]["fulfil"],
  tz: string | undefined,
  now: number = Date.now(),
): string | null {
  if (!fulfil) return null;
  const parts = [METHOD_WORDS[fulfil.method] ?? fulfil.method];
  if (fulfil.slot) parts.push(slotWhen(fulfil.slot.start, tz, now));
  if (fulfil.zone) parts.push(fulfil.zone.name);
  if (fulfil.fee && fulfil.fee.value > 0) parts.push(`${formatMoney(fulfil.fee)} delivery`);
  return parts.join(" · ");
}

/** The tip in a few words: "10%", or the amount. */
export function tipLine(tip: OrderItem["payload"]["tip"]): string | null {
  if (!tip) return null;
  if (tip.amount) return formatMoney(tip.amount);
  return tip.percent ? `${tip.percent}%` : null;
}

const KITCHEN_STATES = new Set(["accepted", "paid", "fulfilling"]);

/**
 * The next press for the kitchen on an order: Preparing, then Ready, then (for a delivery) Out for
 * delivery. None before it is accepted, or once it is out or done.
 */
export function nextStages(
  state: string,
  progress: OrderItem["payload"]["progress"],
  method: string | undefined,
): ProgressStage[] {
  if (!KITCHEN_STATES.has(state)) return [];
  const at = progress?.stage;
  if (at === "out_for_delivery") return [];
  if (at === "ready") return method === "delivery" ? ["out_for_delivery"] : [];
  if (at === "preparing") return ["ready"];
  return ["preparing", "ready"];
}

/** Today's orders for a time, earliest first: what the kitchen makes next, with its Ready button. */
export function ordersForToday(views: readonly ItemView[], tz: string | undefined, now: number): ItemView[] {
  const today = localDateKey(now, tz);
  return views
    .filter((v) => {
      if (v.item.type !== "order" || !KITCHEN_STATES.has(v.item.state)) return false;
      const start = v.item.payload.fulfil?.slot?.start;
      return start !== undefined && localDateKey(start, tz) === today;
    })
    .sort((a, b) => slotOf(a).localeCompare(slotOf(b)));
}

const slotOf = (v: ItemView) => (v.item.type === "order" ? (v.item.payload.fulfil?.slot?.start ?? "") : "");

/**
 * When today has no orders left, the next day that has: "Tomorrow · 3 orders, first at 08:00", for a
 * bakery that takes orders days ahead. Null when no later order is open.
 */
export function nextKitchenDay(
  views: readonly ItemView[],
  tz: string | undefined,
  now: number,
): { readonly line: string; readonly count: number } | null {
  const today = localDateKey(now, tz);
  const later = views
    .filter((v) => {
      if (v.item.type !== "order" || !KITCHEN_STATES.has(v.item.state)) return false;
      const start = v.item.payload.fulfil?.slot?.start;
      return start !== undefined && localDateKey(start, tz) > today;
    })
    .sort((a, b) => slotOf(a).localeCompare(slotOf(b)));
  const first = later[0] ? slotOf(later[0]) : "";
  if (!first) return null;
  const day = localDateKey(first, tz);
  const that = later.filter((v) => localDateKey(slotOf(v), tz) === day);
  const when = slotShort(first, tz, now);
  const [dayWords, clock] = when.includes(" ")
    ? [when.slice(0, when.lastIndexOf(" ")), when.slice(when.lastIndexOf(" ") + 1)]
    : ["", when];
  return {
    line: `${dayWords} · ${that.length} ${that.length === 1 ? "order" : "orders"}, first at ${clock}`,
    count: that.length,
  };
}

/** The pause in the owner's words: "Paused until 21:30", "Paused for today". */
export function pauseLine(until: string | null, tz: string | undefined, now: number): string | null {
  if (!until) return null;
  const at = Date.parse(until);
  if (!Number.isFinite(at) || at <= now) return null;
  return localDateKey(at, tz) === localDateKey(now, tz)
    ? `Paused until ${formatClock(until, tz)}`
    : "Paused for the rest of today";
}

/* --- tables ------------------------------------------------------------------------ */

export interface TablesDraft {
  readonly on: boolean;
  readonly maxParty: number;
  readonly quoteAbove: number | null;
  readonly setAside: number | null;
  readonly deposit: { readonly perPerson: string; readonly fromParty: number } | null;
}

/** What Settings → Kitchen saves of a table service: its rules, or null to count bookings again. */
export function tablesWrite(d: TablesDraft, currency: string): Record<string, unknown> | null | { problem: string } {
  if (!d.on) return null;
  const out: Record<string, unknown> = { maxParty: d.maxParty };
  if (d.quoteAbove !== null) out.quoteAbove = Math.min(d.quoteAbove, d.maxParty);
  if (d.setAside !== null) out.setAside = d.setAside;
  if (d.deposit) {
    const m = parseMoney(d.deposit.perPerson, currency);
    if (!m || m.value <= 0) return { problem: "The deposit per person does not read as an amount." };
    out.deposit = { perPerson: m, fromParty: d.deposit.fromParty };
  }
  return out;
}
