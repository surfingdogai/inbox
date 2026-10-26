import { runMigrations } from "@surfingdog/platform";
import {
  ALLERGEN_CODES,
  ALLERGENS_VOCABULARY,
  allergenLabel,
  type CataloguePage,
  cataloguePageSchema,
  expandAllergens,
  JURISDICTIONS,
  jurisdictionOf,
  mandatoryAllergens,
} from "@surfingdog/spec";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import type { CreateOrderInput } from "../src/capabilities/types";
import type { ConnectorCapabilities } from "../src/connectors/capability";
import { ConnectorError, type OrdersWriter, type PosOrderRef, type RunContext } from "../src/connectors/sdk";
import type { SetupSnapshot } from "../src/connectors/setup-snapshot";
import { resolveWrite } from "../src/connectors/write-first";
import { renderCustomerMail } from "../src/customer/mail";
import { createDb, type Db } from "../src/db";
import { customerCopyProblems } from "../src/i18n/customer-words";
import { ulid } from "../src/ids";
import { menuFromSnapshot, mergeImported } from "../src/kitchen/capability";
import { kitchenContext } from "../src/kitchen/context";
import { servedAt } from "../src/kitchen/order";
import { applyPosState, posCancelHandler, posStatusStep, pushOrder, registerFoodResolver } from "../src/kitchen/pos";
import { tableWords } from "../src/kitchen/tables";
import { kitchenWords } from "../src/kitchen/words";
import { allergenWords } from "../src/menu/allergens";
import type { MenuFields } from "../src/menu/schema";
import { menuFieldsSchema } from "../src/menu/schema";
import { runRulesForEvent } from "../src/rules/engine";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { items } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { readSettings } from "../src/settings/schema";
import { WriteError } from "../src/write/errors";
import { type Caller, transitionItem } from "../src/write/index";
import { withdrawalOf } from "../src/write/returns";
import { rowToItem } from "../src/write/views";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * Restaurants, takeaways, bakeries and cafés (ADR-040), end to end on the capabilities: the allergen
 * vocabulary and who may confirm a dish's allergens; a menu's options priced from the menu; an order
 * with an allergen nobody confirmed waiting for a person everywhere; the last place in a slot going to
 * one order; daily caps set aside; delivery zones, their fees and minimums; the pause; sold out today;
 * a kitchen's progress inside fulfilling; tables by covers, with a deposit per person and a policy.
 * Fixtures (plan §4.8): Pizzería Volcán (Mexico City, MXN), Seoul Crunch Chicken (Busan, KRW), Hokuto
 * Bakery (Sapporo, JPY), Monsoon Café (Bengaluru, INR), Taverna Kyma (Thessaloniki, EUR).
 */

// Each test builds a business on a fresh database: on workerd's local D1, on a busy machine, that alone
// takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const MIN = 60_000;
const DAY = 86_400_000;

const person = (t: number, kind: "owner" | "staff" = "owner"): Caller => ({
  actor: { kind, id: kind === "owner" ? "u1" : "u2", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
  principal: { via: "session", id: "s1", name: kind, scopes: ["*"], userId: kind === "owner" ? "u1" : "u2" },
});
const assistant = (t: number): Caller => ({
  actor: { kind: "owner_ai", id: "app1", channel: "mcp_owner" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
  principal: { via: "oauth", id: "app1", name: "An assistant", scopes: ["*"], userId: "u1" },
});
const integration = (t: number): Caller => ({
  actor: { kind: "integration", id: "key1", channel: "rest" },
  actsAs: "owner",
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
  principal: { via: "api_key", id: "key1", name: "A till", scopes: ["*"], userId: null, keyKind: "integration" },
});
const customer = (t: number): Caller => ({
  actor: { kind: "customer_agent", id: `anon:${ulid()}`, channel: "mcp_public" },
  tier: "anonymous",
  sandbox: false,
  now: () => t,
});

interface Shop {
  readonly db: Db;
  readonly caps: Capabilities;
}

async function shop(o: {
  name: string;
  currency: string;
  timezone: string;
  language: string;
  t: number;
  kitchen?: Record<string, unknown>;
  area?: Record<string, unknown>;
  hours?: [string, string];
}): Promise<Shop> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const caps = confirming(
    new Capabilities(db, createSecretBox(["food-test-instance-key-0123456789abcdef"]), "https://kitchen.example"),
  );
  await db.client.query({
    sql: "INSERT OR REPLACE INTO business (id, name, timezone, currency, languages, created_at, updated_at) VALUES ('self', ?, ?, ?, ?, ?, ?)",
    params: [o.name, o.timezone, o.currency, JSON.stringify([o.language]), o.t, o.t],
    method: "run",
  });
  await caps.updateSettings(person(o.t), {
    doc: {
      business: { name: o.name, currency: o.currency, timezone: o.timezone, languages: [o.language] },
      kitchen: { enabled: true, prepMin: 20, slotMin: 15, perSlot: 4, accept: "caps", ...(o.kitchen ?? {}) },
      ...(o.area ? { area: o.area } : {}),
    },
  });
  const [open, close] = o.hours ?? ["10:00", "22:00"];
  const day = [[open, close]];
  await db.client.query({
    sql: "INSERT INTO availability_rules (id, service_id, kind, weekly, created_at) VALUES (?, NULL, 'open', ?, ?)",
    params: [ulid(), JSON.stringify({ mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day }), o.t],
    method: "run",
  });
  return { db, caps };
}

const menu = (m: Partial<MenuFields> & { allergens?: Partial<MenuFields["allergens"]> }): MenuFields =>
  menuFieldsSchema.parse(m);

async function dish(
  s: Shop,
  t: number,
  p: { name: string; price: number; currency: string; menu: Partial<MenuFields> },
  confirm = true,
) {
  const row = await s.caps.setup.createProduct(person(t), {
    name: p.name,
    price: { value: p.price, currency: p.currency },
    active: true,
  });
  const item = await s.caps.food.setMenuItem(person(t), { product_id: row.id, menu: menu(p.menu) });
  if (!confirm) return item;
  return s.caps.food.confirmAllergens(person(t), { product_id: row.id, fingerprint: item.fingerprint as string });
}

const line = (
  id: string,
  name: string,
  quantity: number,
  price: { value: number; currency: string },
  extra: Record<string, unknown> = {},
) => ({
  productId: id,
  name,
  quantity,
  price,
  ...extra,
});

const order = (
  lines: ReturnType<typeof line>[],
  fulfil: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) =>
  ({
    payload: {
      orderedItem: lines,
      totalPrice: { value: 1, currency: lines[0]?.price.currency ?? "EUR" },
      fulfil,
      ...extra,
    },
    contact: { name: "A customer", email: `c${ulid().toLowerCase().slice(-8)}@example.com` },
  }) as unknown as CreateOrderInput;

async function firstSlot(s: Shop, t: number, date: string, method = "pickup"): Promise<string> {
  const r = await s.caps.food.listOrderSlots({ date, method: method as "pickup" }, t, "en");
  const first = r.slots[0];
  if (!first) throw new Error(`no slot on ${date}: ${r.words}`);
  return first.start;
}

async function rules(db: Db, itemId: string, now: number) {
  const { rows } = await db.client.query({
    sql: "SELECT id FROM item_events WHERE item_id = ? AND seq = 1",
    params: [itemId],
    method: "all",
  });
  return runRulesForEvent(db, { itemId, eventId: String(rows[0]?.[0]), trigger: "item.created", now });
}

async function itemOf(db: Db, id: string) {
  const { rows } = await db.client.query({
    sql: "SELECT state, payload, flags FROM items WHERE id = ?",
    params: [id],
    method: "all",
  });
  const r = rows[0] ?? [];
  return {
    state: String(r[0]),
    payload: JSON.parse(String(r[1])) as Record<string, unknown>,
    flags: JSON.parse(String(r[2])) as { needsHuman?: boolean },
  };
}

async function claims(db: Db, prefix: string): Promise<number> {
  const { rows } = await db.client.query({
    sql: "SELECT COUNT(*) FROM slot_claims WHERE resource_key LIKE ?",
    params: [`${prefix}%`],
    method: "all",
  });
  return Number(rows[0]?.[0] ?? 0);
}

async function refused(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof WriteError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("the allergen vocabulary (vocab/allergens.json)", () => {
  it("holds the EU and UK 14, the US 9 with sesame, Canada's, ANZ's required names and Japan's 9 and 20", () => {
    const parents = (j: (typeof JURISDICTIONS)[number]) =>
      mandatoryAllergens(j).filter((c) => !ALLERGENS_VOCABULARY.allergens.find((a) => a.code === c)?.parent);
    expect(parents("EU").sort()).toEqual(
      [
        "celery",
        "crustaceans",
        "eggs",
        "fish",
        "gluten",
        "lupin",
        "milk",
        "molluscs",
        "mustard",
        "peanuts",
        "sesame",
        "soy",
        "sulphites",
        "tree_nuts",
      ].sort(),
    );
    expect(mandatoryAllergens("GB")).toEqual(mandatoryAllergens("EU"));
    expect(mandatoryAllergens("US").sort()).toEqual(
      ["crustaceans", "eggs", "fish", "milk", "peanuts", "sesame", "soy", "tree_nuts", "wheat"].sort(),
    );
    expect(mandatoryAllergens("CA")).toEqual(
      expect.arrayContaining(["mustard", "sulphites", "triticale", "molluscs", "sesame"]),
    );
    expect(mandatoryAllergens("AU")).toEqual(
      expect.arrayContaining(["lupin", "pine_nut", "macadamia", "brazil_nut", "barley", "oats", "rye"]),
    );
    expect(mandatoryAllergens("JP").sort()).toEqual(
      ["buckwheat", "cashew", "crab", "eggs", "milk", "peanuts", "shrimp", "walnut", "wheat"].sort(),
    );
    expect(ALLERGENS_VOCABULARY.allergens.filter((a) => a.recommended_in.includes("JP"))).toHaveLength(20);
    for (const a of ALLERGENS_VOCABULARY.allergens) {
      for (const lang of ALLERGENS_VOCABULARY.languages) expect(a.labels[lang], `${a.code} ${lang}`).toBeTruthy();
      if (a.parent) expect(ALLERGEN_CODES).toContain(a.parent);
    }
    for (const j of JURISDICTIONS) expect(ALLERGENS_VOCABULARY.jurisdictions[j].source).toMatch(/^https:\/\//);
  });

  it("names the list a business declares by from its country: an EU member's is the EU's", async () => {
    expect(jurisdictionOf("GR")).toBe("EU");
    expect(jurisdictionOf("gb")).toBe("GB");
    expect(jurisdictionOf("JP")).toBe("JP");
    expect(jurisdictionOf("MX")).toBeNull();
    expect(jurisdictionOf("EU")).toBeNull();
    expect(jurisdictionOf(undefined)).toBeNull();
    const t = Date.parse("2026-11-04T10:00:00Z");
    const s = await shop({ name: "Taverna Kyma", currency: "EUR", timezone: "Europe/Athens", language: "el", t });
    await s.caps.updateSettings(person(t), { doc: { directory: { address: { addressCountry: "GR" } } } });
    const m = await s.caps.food.ownerMenu(person(t));
    expect(m.vocabulary.where).toBe("EU");
    expect(m.vocabulary.law?.source).toMatch(/^https:\/\/eur-lex\.europa\.eu\//);
    expect(m.vocabulary.allergens.filter((a) => a.mandatory && a.parent === null)).toHaveLength(14);
    expect(m.vocabulary.allergens).toHaveLength(ALLERGEN_CODES.length);
  });

  it("reads a part as its whole too, and names each in the customer's language", () => {
    expect(expandAllergens(["walnut", "wheat"])).toEqual(["gluten", "wheat", "tree_nuts", "walnut"]);
    expect(expandAllergens(["shrimp"])).toEqual(["crustaceans", "shrimp"]);
    expect(allergenLabel("sesame", "ja")).toBe("ごま");
    expect(allergenLabel("milk", "el")).toBe("Milk");
  });
});

// Pizzería Volcán, Mexico City: a Wednesday, 11:00 there.
const VOLCAN_T = Date.parse("2026-11-04T17:00:00Z");
const MXN = (v: number) => ({ value: v, currency: "MXN" });
const volcan = () =>
  shop({ name: "Pizzería Volcán", currency: "MXN", timezone: "America/Mexico_City", language: "es", t: VOLCAN_T });

const PIZZA: Partial<MenuFields> = {
  section: "pizzas",
  optionGroups: [
    {
      id: "size",
      name: "Tamaño",
      min: 1,
      max: 1,
      choices: [
        { id: "chica", name: "Chica", default: true },
        { id: "grande", name: "Grande", priceDelta: 6000, opens: "masa" },
      ],
    },
    {
      id: "masa",
      name: "Masa",
      min: 1,
      max: 1,
      choices: [
        { id: "delgada", name: "Delgada" },
        { id: "gruesa", name: "Gruesa" },
      ],
    },
    {
      id: "extras",
      name: "Extras",
      min: 0,
      max: 4,
      halves: true,
      choices: [
        { id: "pina", name: "Piña", priceDelta: 1500, halfDelta: 900 },
        { id: "chorizo", name: "Chorizo", priceDelta: 2000, allergens: { contains: ["mustard"], mayContain: [] } },
      ],
    },
  ],
  allergens: { contains: ["wheat", "milk"], mayContain: ["sesame"], status: "unconfirmed" },
  dietary: [],
};

describe("allergens: confirmed only by a person at the business, as shown", () => {
  it("arrive unconfirmed whoever writes them; the owner's AI and another system's key never confirm; staff in person do", async () => {
    const s = await volcan();
    const p = await s.caps.setup.createProduct(person(VOLCAN_T), {
      name: "Pizza al pastor",
      price: MXN(18900),
      active: true,
    });
    const set = await s.caps.food.setMenuItem(person(VOLCAN_T), { product_id: p.id, menu: menu(PIZZA) });
    expect(set.menu?.allergens.status).toBe("unconfirmed");
    const fp = set.fingerprint as string;
    for (const who of [assistant(VOLCAN_T), integration(VOLCAN_T), customer(VOLCAN_T)]) {
      const e = await refused(s.caps.food.confirmAllergens(who, { product_id: p.id, fingerprint: fp }));
      expect(e.code).toBe("not_allowed");
    }
    // A fingerprint of other lists than the ones there now: checked again first.
    const stale = await refused(
      s.caps.food.confirmAllergens(person(VOLCAN_T, "staff"), { product_id: p.id, fingerprint: "0".repeat(64) }),
    );
    expect(stale.details?.guard).toBe("allergens_changed");
    const ok = await s.caps.food.confirmAllergens(person(VOLCAN_T, "staff"), { product_id: p.id, fingerprint: fp });
    expect(ok.menu?.allergens).toMatchObject({ status: "confirmed", confirmedBy: "staff" });
    // A change that leaves the allergens as they were keeps them confirmed; a choice's allergen changes them.
    const moved = await s.caps.food.setMenuItem(person(VOLCAN_T), {
      product_id: p.id,
      menu: menu({ ...PIZZA, sort: 3 }),
    });
    expect(moved.menu?.allergens.status).toBe("confirmed");
    const groups = structuredClone(PIZZA.optionGroups) as MenuFields["optionGroups"];
    (groups[2] as MenuFields["optionGroups"][number]).choices[0] = {
      id: "pina",
      name: "Piña",
      priceDelta: 1500,
      allergens: { contains: ["sulphites"], mayContain: [] },
    };
    const changed = await s.caps.food.setMenuItem(person(VOLCAN_T), {
      product_id: p.id,
      menu: menu({ ...PIZZA, optionGroups: groups }),
    });
    expect(changed.menu?.allergens.status).toBe("unconfirmed");
    // The owner's AI does not change the menu at all: what each option adds is money.
    expect(
      (await refused(s.caps.food.setMenuItem(assistant(VOLCAN_T), { product_id: p.id, menu: menu(PIZZA) }))).code,
    ).toBe("not_allowed");
  });

  it("are told to agents as they are: unconfirmed is ask the business, parts read as their whole", async () => {
    const s = await volcan();
    await dish(s, VOLCAN_T, { name: "Pizza al pastor", price: 18900, currency: "MXN", menu: PIZZA });
    await dish(
      s,
      VOLCAN_T,
      {
        name: "Agua de jamaica",
        price: 3500,
        currency: "MXN",
        menu: { section: "bebidas", dietary: ["vegan", "gluten_free"] },
      },
      false,
    );
    const m = await s.caps.food.getMenu({}, VOLCAN_T);
    const items = m.sections.flatMap((x) => x.items);
    const pizza = items.find((i) => i.name === "Pizza al pastor");
    expect(pizza?.allergens).toEqual({
      status: "confirmed",
      contains: ["gluten", "wheat", "milk"],
      may_contain: ["sesame"],
    });
    expect(pizza?.options.find((g) => g.id === "masa")?.opened_by).toEqual({ group_id: "size", choice_id: "grande" });
    const agua = items.find((i) => i.name === "Agua de jamaica");
    expect(agua?.allergens.status).toBe("unconfirmed");
    expect(agua?.dietary).toEqual([{ tag: "vegan" }, { tag: "gluten_free", status: "unconfirmed" }]);
    // Said in the business's own language.
    expect(m.words).toBe(
      "Los alérgenos sin confirmar aún no los ha revisado Pizzería Volcán: pregunta a Pizzería Volcán antes de fiarte de ellos.",
    );
  });
});

describe("an order's options, priced from the business's menu", () => {
  it("adds what each choice adds, a half at its half price, and opens a group only with its choice", async () => {
    const s = await volcan();
    await s.caps.setup.applyPreset(person(VOLCAN_T), { preset: "food", replace: true });
    const p = await dish(s, VOLCAN_T, { name: "Pizza al pastor", price: 18900, currency: "MXN", menu: PIZZA });
    const slot = await firstSlot(s, VOLCAN_T, "2026-11-04");
    const made = await s.caps.createOrder(
      customer(VOLCAN_T),
      order(
        [
          line(p.product.id, "Pizza", 1, MXN(1), {
            options: [
              { groupId: "size", choiceId: "grande" },
              { groupId: "masa", choiceId: "gruesa" },
              { groupId: "extras", choiceId: "pina", portion: "left" },
            ],
            note: "sin cebolla",
          }),
        ],
        { method: "pickup", slot: { start: slot } },
      ),
    );
    const it0 = await itemOf(s.db, made.view.item.id);
    const l = (
      it0.payload.orderedItem as {
        price: { value: number };
        options: { name: string; priceDelta?: { value: number } }[];
      }[]
    )[0];
    expect(l?.price.value).toBe(18900 + 6000 + 900);
    expect(l?.options.map((o) => o.name)).toEqual(["Grande", "Gruesa", "Piña"]);
    expect((it0.payload.totalPrice as { value: number }).value).toBe(25800);
    expect((it0.payload.fulfil as { slot: { end: string } }).slot.end).toBe(
      new Date(Date.parse(slot) + 15 * MIN).toISOString(),
    );
    // What the options add is the menu's list price, never above it: the kitchen's rule takes it at once.
    await rules(s.db, made.view.item.id, VOLCAN_T);
    expect((await itemOf(s.db, made.view.item.id)).state).toBe("accepted");

    const missing = await refused(
      s.caps.createOrder(
        customer(VOLCAN_T),
        order([line(p.product.id, "Pizza", 1, MXN(1), { options: [{ groupId: "size", choiceId: "grande" }] })], {
          method: "pickup",
          slot: { start: slot },
        }),
      ),
    );
    expect(missing.fields?.[0]?.message).toBe("choose 1 of Masa");
    const closed = await refused(
      s.caps.createOrder(
        customer(VOLCAN_T),
        order([line(p.product.id, "Pizza", 1, MXN(1), { options: [{ groupId: "masa", choiceId: "gruesa" }] })], {
          method: "pickup",
          slot: { start: slot },
        }),
      ),
    );
    expect(closed.fields?.map((f) => f.message)).toContain("Masa comes only with the choice that opens it");
    const half = await refused(
      s.caps.createOrder(
        customer(VOLCAN_T),
        order(
          [
            line(p.product.id, "Pizza", 1, MXN(1), {
              options: [{ groupId: "size", choiceId: "chica", portion: "left" }],
            }),
          ],
          { method: "pickup", slot: { start: slot } },
        ),
      ),
    );
    expect(half.fields?.[0]?.message).toBe("Tamaño is not made in halves");
  });
});

describe("unconfirmed allergens: request mode, everywhere", () => {
  it("an order with a dish nobody confirmed waits for a person: no rule, no assistant, no key accepts it", async () => {
    const s = await volcan();
    await s.caps.setup.applyPreset(person(VOLCAN_T), { preset: "food", replace: true });
    const pizza = await dish(s, VOLCAN_T, { name: "Pizza al pastor", price: 18900, currency: "MXN", menu: PIZZA });
    const agua = await dish(
      s,
      VOLCAN_T,
      { name: "Agua de jamaica", price: 3500, currency: "MXN", menu: { section: "bebidas" } },
      false,
    );
    const slot = await firstSlot(s, VOLCAN_T, "2026-11-04");

    const fine = await s.caps.createOrder(
      customer(VOLCAN_T),
      order([line(pizza.product.id, "Pizza", 1, MXN(1))], { method: "pickup", slot: { start: slot } }),
    );
    expect((await itemOf(s.db, fine.view.item.id)).payload.kitchen).toEqual({ instant: true, hold: [] });
    await rules(s.db, fine.view.item.id, VOLCAN_T);
    expect((await itemOf(s.db, fine.view.item.id)).state).toBe("accepted");

    const held = await s.caps.createOrder(
      customer(VOLCAN_T),
      order([line(pizza.product.id, "Pizza", 1, MXN(1)), line(agua.product.id, "Agua", 2, MXN(1))], {
        method: "pickup",
        slot: { start: slot },
      }),
    );
    const before = await itemOf(s.db, held.view.item.id);
    expect(before.payload.kitchen).toEqual({ instant: false, hold: ["allergens_unconfirmed"] });
    expect(before.flags.needsHuman).toBe(true);
    await rules(s.db, held.view.item.id, VOLCAN_T);
    expect((await itemOf(s.db, held.view.item.id)).state).toBe("received");
    for (const who of [assistant(VOLCAN_T), integration(VOLCAN_T)]) {
      const e = await refused(transitionItem(s.db, who, { itemId: held.view.item.id, event: "accept" }));
      expect(e.details?.guard).toBe("kitchen");
    }
    await transitionItem(s.db, person(VOLCAN_T), { itemId: held.view.item.id, event: "accept" });
    expect((await itemOf(s.db, held.view.item.id)).state).toBe("accepted");
  });

  it("a kitchen that accepts each order by hand marks every order for its owner; a rule never accepts one", async () => {
    const s = await shop({
      name: "Pizzería Volcán",
      currency: "MXN",
      timezone: "America/Mexico_City",
      language: "es",
      t: VOLCAN_T,
      kitchen: { accept: "owner" },
    });
    await s.caps.setup.applyPreset(person(VOLCAN_T), { preset: "food", replace: true });
    const pizza = await dish(s, VOLCAN_T, { name: "Pizza al pastor", price: 18900, currency: "MXN", menu: PIZZA });
    const slot = await firstSlot(s, VOLCAN_T, "2026-11-04");
    const made = await s.caps.createOrder(
      customer(VOLCAN_T),
      order([line(pizza.product.id, "Pizza", 1, MXN(1))], { method: "pickup", slot: { start: slot } }),
    );
    await rules(s.db, made.view.item.id, VOLCAN_T);
    const after = await itemOf(s.db, made.view.item.id);
    expect(after.payload.kitchen).toEqual({ instant: false, hold: ["owner_accepts"] });
    expect(after.state).toBe("received");
    expect(after.flags.needsHuman).toBe(true);
  });
});

describe("slots: the last place goes to one order", () => {
  it("two orders for the last place in a slot: one is taken, the other is told the slot is full; a cancel frees it", async () => {
    const s = await shop({
      name: "Pizzería Volcán",
      currency: "MXN",
      timezone: "America/Mexico_City",
      language: "es",
      t: VOLCAN_T,
      kitchen: { perSlot: 1 },
    });
    const pizza = await dish(s, VOLCAN_T, { name: "Pizza al pastor", price: 18900, currency: "MXN", menu: PIZZA });
    const slot = await firstSlot(s, VOLCAN_T, "2026-11-04");
    const ask = () =>
      s.caps.createOrder(
        customer(VOLCAN_T),
        order([line(pizza.product.id, "Pizza", 1, MXN(1))], { method: "pickup", slot: { start: slot } }),
      );
    const [a, b] = await Promise.allSettled([ask(), ask()]);
    const won = [a, b].filter((r) => r.status === "fulfilled");
    const lost = [a, b].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(WriteError);
    expect(((lost[0] as PromiseRejectedResult).reason as WriteError).code).toBe("slot_taken");
    expect(await claims(s.db, "order-slot:")).toBe(1);
    const after = await s.caps.food.listOrderSlots({ date: "2026-11-04", method: "pickup" }, VOLCAN_T, "es");
    expect(after.slots.some((x) => x.start === slot)).toBe(false);
    const id = (won[0] as PromiseFulfilledResult<{ view: { item: { id: string } } }>).value.view.item.id;
    await transitionItem(s.db, person(VOLCAN_T), { itemId: id, event: "decline" });
    expect(await claims(s.db, "order-slot:")).toBe(0);
    await ask();
  });

  it("offers no slot before the kitchen's time, nor one past how far ahead it takes orders", async () => {
    const s = await volcan();
    const r = await s.caps.food.listOrderSlots({ date: "2026-11-04", method: "pickup" }, VOLCAN_T, "en");
    expect(Date.parse(r.slots[0]?.start ?? "")).toBeGreaterThanOrEqual(VOLCAN_T + 20 * MIN);
    expect(r.earliest).toBe(new Date(VOLCAN_T + 20 * MIN).toISOString());
    const far = await s.caps.food.listOrderSlots({ date: "2026-11-20", method: "pickup" }, VOLCAN_T, "en");
    expect(far.answer).toBe("closed");
    expect(far.slots).toEqual([]);
  });
});

// Hokuto Bakery, Sapporo: Wednesday 09:00 there.
const HOKUTO_T = Date.parse("2026-11-04T00:00:00Z");
const JPY = (v: number) => ({ value: v, currency: "JPY" });

describe("daily caps and made to order (a bakery)", () => {
  it("takes at once what fits the places set aside, then waits for a person; a declined order gives its places back", async () => {
    const s = await shop({
      name: "Hokuto Bakery",
      currency: "JPY",
      timezone: "Asia/Tokyo",
      language: "ja",
      t: HOKUTO_T,
      hours: ["08:00", "19:00"],
    });
    const melon = await dish(s, HOKUTO_T, {
      name: "メロンパン",
      price: 280,
      currency: "JPY",
      menu: {
        section: "pan",
        dailyCap: 3,
        allergens: { contains: ["wheat", "eggs", "milk"], mayContain: [], status: "unconfirmed" },
      },
    });
    const slot = await firstSlot(s, HOKUTO_T, "2026-11-04");
    const two = await s.caps.createOrder(
      customer(HOKUTO_T),
      order([line(melon.product.id, "メロンパン", 2, JPY(280))], { method: "pickup", slot: { start: slot } }),
    );
    expect((await itemOf(s.db, two.view.item.id)).payload.kitchen).toEqual({ instant: true, hold: [] });
    expect(await claims(s.db, "menu-cap:")).toBe(2);
    const over = await s.caps.createOrder(
      customer(HOKUTO_T),
      order([line(melon.product.id, "メロンパン", 2, JPY(280))], { method: "pickup", slot: { start: slot } }),
    );
    const o = await itemOf(s.db, over.view.item.id);
    expect(o.payload.kitchen).toEqual({ instant: false, hold: ["over_cap"] });
    expect(o.flags.needsHuman).toBe(true);
    expect(await claims(s.db, "menu-cap:")).toBe(2);
    const last = await s.caps.createOrder(
      customer(HOKUTO_T),
      order([line(melon.product.id, "メロンパン", 1, JPY(280))], { method: "pickup", slot: { start: slot } }),
    );
    expect((await itemOf(s.db, last.view.item.id)).payload.kitchen).toEqual({ instant: true, hold: [] });
    await transitionItem(s.db, person(HOKUTO_T), { itemId: two.view.item.id, event: "decline" });
    expect(await claims(s.db, "menu-cap:")).toBe(1);
  });

  it("a custom cake needs its notice, is on request, and is the personalised exception", async () => {
    const s = await shop({
      name: "Hokuto Bakery",
      currency: "JPY",
      timezone: "Asia/Tokyo",
      language: "ja",
      t: HOKUTO_T,
      hours: ["08:00", "19:00"],
    });
    const cake = await dish(s, HOKUTO_T, {
      name: "誕生日ケーキ",
      price: 4800,
      currency: "JPY",
      menu: {
        section: "cakes",
        madeToOrder: true,
        noticeMin: 2 * 24 * 60,
        brief: { servings: { min: 4, max: 12 }, messageMax: 20 },
      },
    });
    const { rows } = await s.db.client.query({
      sql: "SELECT withdrawal FROM products WHERE id = ?",
      params: [cake.product.id],
      method: "all",
    });
    expect(rows[0]?.[0]).toBe("personalised");
    const tomorrow = await firstSlot(s, HOKUTO_T, "2026-11-05").catch(() => null);
    if (tomorrow) {
      const soon = await refused(
        s.caps.createOrder(
          customer(HOKUTO_T),
          order([line(cake.product.id, "ケーキ", 1, JPY(4800))], { method: "pickup", slot: { start: tomorrow } }),
        ),
      );
      expect(soon.details?.reason).toBe("too_soon");
    }
    const later = await firstSlot(s, HOKUTO_T, "2026-11-07");
    const made = await s.caps.createOrder(
      customer(HOKUTO_T),
      order([line(cake.product.id, "ケーキ", 1, JPY(4800), { brief: { servings: 8, message: "おたんじょうび" } })], {
        method: "pickup",
        slot: { start: later },
      }),
    );
    const item = await itemOf(s.db, made.view.item.id);
    expect(item.payload.kitchen).toEqual({ instant: false, hold: ["made_to_order"] });
    expect(item.payload.totalPrice as { value: number; currency: string }).toEqual(JPY(4800));
  });
});

// Seoul Crunch Chicken, Busan: Wednesday 12:00 there.
const BUSAN_T = Date.parse("2026-11-04T03:00:00Z");
const KRW = (v: number) => ({ value: v, currency: "KRW" });
const BUSAN = { lat: 35.1796, lng: 129.0756 };

const crunch = () =>
  shop({
    name: "Seoul Crunch Chicken",
    currency: "KRW",
    timezone: "Asia/Seoul",
    language: "ko",
    t: BUSAN_T,
    kitchen: { methods: { pickup: true, delivery: true }, tips: { enabled: true, choices: [0, 5, 10] } },
    area: {
      mode: "anywhere",
      base: { from: "device", point: BUSAN },
      zones: [
        {
          name: "Haeundae",
          mode: "postal",
          postal: [{ country: "KR", prefix: "48" }],
          fee: KRW(3000),
          minimumOrder: KRW(15000),
          etaMin: 40,
        },
        { name: "Seomyeon", mode: "radius", radiusKm: 8, fee: KRW(4000), etaMin: 30 },
      ],
    },
  });

describe("delivery zones, their fees, minimums and tips", () => {
  it("adds the zone's fee and a tip on the food to the total, as the business prices them", async () => {
    const s = await crunch();
    const chicken = await dish(s, BUSAN_T, {
      name: "후라이드 치킨",
      price: 18000,
      currency: "KRW",
      menu: { section: "chicken", allergens: { contains: ["wheat", "soy"], mayContain: [], status: "unconfirmed" } },
    });
    const slots = await s.caps.food.listOrderSlots(
      { date: "2026-11-04", method: "delivery", postal_code: "48058", country: "KR" },
      BUSAN_T,
      "en",
    );
    expect(slots.zone).toEqual({ name: "Haeundae", fee: KRW(3000), minimum_order: KRW(15000), eta_min: 40 });
    const made = await s.caps.createOrder(
      customer(BUSAN_T),
      order(
        [line(chicken.product.id, "치킨", 1, KRW(18000))],
        { method: "delivery", slot: { start: slots.slots[0]?.start } },
        {
          shippingAddress: {
            streetAddress: "Haeundae-ro 1",
            addressLocality: "Busan",
            postalCode: "48058",
            addressCountry: "KR",
          },
          tip: { percent: 10 },
        },
      ),
    );
    const p = (await itemOf(s.db, made.view.item.id)).payload;
    expect(p.fulfil).toMatchObject({ method: "delivery", zone: { name: "Haeundae" }, fee: KRW(3000), etaMin: 40 });
    expect(p.tip).toEqual({ percent: 10, amount: KRW(1800) });
    expect(p.totalPrice).toEqual(KRW(18000 + 3000 + 1800));
    // A ring from the kitchen's own cell, by the point the agent sent.
    const ring = await s.caps.food.listOrderSlots(
      { date: "2026-11-04", method: "delivery", lat: 35.1577, lng: 129.0594 },
      BUSAN_T,
      "en",
    );
    expect(ring.zone?.name).toBe("Seomyeon");
  });

  it("refuses an address outside every zone and an order under the zone's minimum, in the business's words", async () => {
    const s = await crunch();
    const radish = await dish(s, BUSAN_T, { name: "치킨무", price: 2000, currency: "KRW", menu: { section: "sides" } });
    const outside = await s.caps.food.listOrderSlots(
      { date: "2026-11-04", method: "delivery", postal_code: "06236", country: "KR" },
      BUSAN_T,
      "en",
    );
    expect(outside.answer).toBe("outside");
    const slot = await firstSlot(s, BUSAN_T, "2026-11-04");
    const far = await refused(
      s.caps.createOrder(
        customer(BUSAN_T),
        order(
          [line(radish.product.id, "무", 10, KRW(2000))],
          { method: "delivery", slot: { start: slot } },
          { shippingAddress: { postalCode: "06236", addressCountry: "KR" } },
        ),
      ),
    );
    expect(far.message).toBe(
      "Seoul Crunch Chicken does not deliver to that address: choose collection, or another address.",
    );
    const small = await refused(
      s.caps.createOrder(
        customer(BUSAN_T),
        order(
          [line(radish.product.id, "무", 1, KRW(2000))],
          { method: "delivery", slot: { start: slot } },
          { shippingAddress: { postalCode: "48058", addressCountry: "KR" } },
        ),
      ),
    );
    expect(small.details?.reason).toBe("below_minimum");
    const noAddress = await s.caps.food.listOrderSlots({ date: "2026-11-04", method: "delivery" }, BUSAN_T, "en");
    expect(noAddress.answer).toBe("on_request");
  });
});

// Monsoon Café, Bengaluru: Wednesday 09:30 there.
const BLR_T = Date.parse("2026-11-04T04:00:00Z");
const INR = (v: number) => ({ value: v, currency: "INR" });

describe("a café: the pause, sold out today, and progress", () => {
  it("pauses for any person at the business, never their AI, and tells agents until when", async () => {
    const s = await shop({
      name: "Monsoon Café",
      currency: "INR",
      timezone: "Asia/Kolkata",
      language: "en",
      t: BLR_T,
      kitchen: { slotMin: 10, prepMin: 10 },
      hours: ["07:00", "20:00"],
    });
    const chai = await dish(s, BLR_T, {
      name: "Masala chai",
      price: 9000,
      currency: "INR",
      menu: { section: "drinks" },
    });
    expect((await refused(s.caps.food.pause(assistant(BLR_T), { minutes: 30 }))).code).toBe("not_allowed");
    const paused = await s.caps.food.pause(person(BLR_T, "staff"), { minutes: 30 });
    expect(paused.paused_until).toBe(new Date(BLR_T + 30 * MIN).toISOString());
    const slots = await s.caps.food.listOrderSlots({ date: "2026-11-04", method: "pickup" }, BLR_T, "en");
    expect(Date.parse(slots.slots[0]?.start ?? "")).toBeGreaterThanOrEqual(BLR_T + 30 * MIN);
    expect(slots.paused_until).toBe(paused.paused_until);
    const inPause = new Date(BLR_T + 20 * MIN).toISOString();
    const e = await refused(
      s.caps.createOrder(
        customer(BLR_T),
        order([line(chai.product.id, "Chai", 1, INR(9000))], { method: "pickup", slot: { start: inPause } }),
      ),
    );
    expect(e.message).toBe("Monsoon Café is not taking orders until 10:00.");
    const profile = await s.caps.getBusinessProfile();
    expect(profile.kitchen?.paused_until).toBeDefined();
    await s.caps.food.pause(person(BLR_T), { resume: true });
    expect(
      (await s.caps.food.listOrderSlots({ date: "2026-11-04", method: "pickup" }, BLR_T, "en")).paused_until,
    ).toBeUndefined();
  });

  it("sold out today comes back tomorrow by itself", async () => {
    const s = await shop({
      name: "Monsoon Café",
      currency: "INR",
      timezone: "Asia/Kolkata",
      language: "en",
      t: BLR_T,
      hours: ["07:00", "20:00"],
    });
    const bun = await dish(s, BLR_T, { name: "Benne dosa", price: 12000, currency: "INR", menu: { section: "food" } });
    await s.caps.food.setSoldOut(assistant(BLR_T), { product_id: bun.product.id, sold_out: true });
    const today = (await s.caps.food.getMenu({}, BLR_T)).sections[0]?.items[0];
    expect(today).toMatchObject({ sold_out_today: true, available_now: false });
    const slot = await firstSlot(s, BLR_T, "2026-11-04");
    const e = await refused(
      s.caps.createOrder(
        customer(BLR_T),
        order([line(bun.product.id, "Dosa", 1, INR(12000))], { method: "pickup", slot: { start: slot } }),
      ),
    );
    expect(e.details?.reason).toBe("sold_out");
    const tomorrow = (await s.caps.food.getMenu({}, BLR_T + DAY)).sections[0]?.items[0];
    expect(tomorrow).toMatchObject({ sold_out_today: false, available_now: true });
  });

  it("says preparing and ready inside fulfilling, with the order's machine unchanged", async () => {
    const s = await shop({
      name: "Monsoon Café",
      currency: "INR",
      timezone: "Asia/Kolkata",
      language: "en",
      t: BLR_T,
      hours: ["07:00", "20:00"],
    });
    const chai = await dish(s, BLR_T, {
      name: "Masala chai",
      price: 9000,
      currency: "INR",
      menu: { section: "drinks" },
    });
    const slot = await firstSlot(s, BLR_T, "2026-11-04");
    const made = await s.caps.createOrder(
      customer(BLR_T),
      order([line(chai.product.id, "Chai", 2, INR(9000))], { method: "pickup", slot: { start: slot } }),
    );
    await transitionItem(s.db, person(BLR_T), { itemId: made.view.item.id, event: "accept" });
    await s.caps.food.setProgress(person(BLR_T), made.view.item.id, { stage: "preparing" });
    const ready = await s.caps.food.setProgress(person(BLR_T + 5 * MIN), made.view.item.id, { stage: "ready" });
    expect(ready.state).toBe("fulfilling");
    expect(ready.type === "order" && ready.payload.progress?.stage).toBe("ready");
    const e = await refused(s.caps.food.setProgress(person(BLR_T), made.view.item.id, { stage: "out_for_delivery" }));
    expect(e.code).toBe("invalid_input");
    const { rows } = await s.db.client.query({
      sql: "SELECT event FROM item_events WHERE item_id = ? ORDER BY seq",
      params: [made.view.item.id],
      method: "all",
    });
    expect(rows.map((r) => r[0])).toEqual(expect.arrayContaining(["create", "accept", "start_fulfilment", "progress"]));
  });
});

// Taverna Kyma, Thessaloniki: Wednesday 12:00 there.
const KYMA_T = Date.parse("2026-11-04T10:00:00Z");
const EUR = (v: number) => ({ value: v, currency: "EUR" });

async function kyma(setAside: number | undefined) {
  const s = await shop({
    name: "Taverna Kyma",
    currency: "EUR",
    timezone: "Europe/Athens",
    language: "el",
    t: KYMA_T,
    hours: ["12:00", "23:00"],
  });
  const table = await s.caps.setup.createService(person(KYMA_T), {
    name: "Τραπέζι",
    duration_min: 90,
    buffer_before_min: 0,
    buffer_after_min: 0,
    granularity_min: 30,
    capacity: 1,
    active: true,
    sort: 0,
  });
  await s.caps.food.setTableRules(person(KYMA_T), {
    service_id: table.id,
    tables: {
      maxParty: 8,
      quoteAbove: 12,
      deposit: { perPerson: EUR(1000), fromParty: 6 },
      ...(setAside !== undefined ? { setAside } : {}),
      policy: {
        steps: [{ before: { hours: 24 }, fee: { kind: "none" } }],
        after: { kind: "full" },
        noShow: { kind: "full" },
      },
    },
  });
  return { ...s, table };
}

const tableFor = (serviceId: string, party: number, start: string) => ({
  payload: {
    reservationFor: { serviceId, name: "Τραπέζι" },
    startTime: start,
    endTime: new Date(Date.parse(start) + 90 * MIN).toISOString(),
    partySize: party,
  },
  contact: { name: "Eleni", email: `e${ulid().toLowerCase().slice(-8)}@example.com` },
});

describe("tables by covers", () => {
  it("counts covers in people, takes a deposit per person from a size, and a large party is a request for a price", async () => {
    const s = await kyma(20);
    const evening = "2026-11-05T17:00:00Z"; // 19:00 in Thessaloniki
    const four = await s.caps.createBooking(customer(KYMA_T), tableFor(s.table.id, 4, evening));
    expect((await itemOf(s.db, four.view.item.id)).payload.deposit).toBeUndefined();
    const six = await s.caps.createBooking(customer(KYMA_T), tableFor(s.table.id, 6, evening));
    const p6 = (await itemOf(s.db, six.view.item.id)).payload;
    expect(p6.deposit).toEqual({ amount: EUR(6000), refundable: true });
    expect((p6.policy as { steps: unknown[] }).steps).toHaveLength(1);
    const ten = await refused(s.caps.createBooking(customer(KYMA_T), tableFor(s.table.id, 10, evening)));
    expect(ten.details?.reason).toBe("party_too_large");
    const fourteen = await s.caps.createBooking(customer(KYMA_T), tableFor(s.table.id, 14, evening));
    expect(fourteen.view.item.type).toBe("quote_request");
    expect(fourteen.note).toMatch(/request for a price/);
    // Covers: 20 set aside; confirmed tables of 8 and 8 leave 4, so a table for 6 is not offered.
    for (const n of [8, 8]) {
      const b = await s.caps.createBooking(customer(KYMA_T), tableFor(s.table.id, n, evening));
      await transitionItem(s.db, person(KYMA_T), { itemId: b.view.item.id, event: "confirm" });
    }
    const free = await s.caps.checkAvailability(
      { service_id: s.table.id, from: "2026-11-05T16:00:00Z", to: "2026-11-05T19:00:00Z", party_size: 6 },
      { now: KYMA_T },
    );
    expect(free.slots.some((x) => x.startTime === "2026-11-05T17:00:00.000Z")).toBe(false);
    const forFour = await s.caps.checkAvailability(
      { service_id: s.table.id, from: "2026-11-05T16:00:00Z", to: "2026-11-05T19:00:00Z", party_size: 4 },
      { now: KYMA_T },
    );
    expect(forFour.slots.some((x) => x.startTime === "2026-11-05T17:00:00.000Z")).toBe(true);
  });

  it("without covers set aside, no rule and no assistant confirms a table: a person does", async () => {
    const s = await kyma(undefined);
    const b = await s.caps.createBooking(customer(KYMA_T), tableFor(s.table.id, 2, "2026-11-05T17:00:00Z"));
    const e = await refused(transitionItem(s.db, assistant(KYMA_T), { itemId: b.view.item.id, event: "confirm" }));
    expect(e.details?.guard).toBe("tables");
    await transitionItem(s.db, person(KYMA_T), { itemId: b.view.item.id, event: "confirm" });
    expect((await itemOf(s.db, b.view.item.id)).state).toBe("confirmed");
  });
});

describe("tables: instant only inside the covers set aside", () => {
  it("a party larger than the covers set aside goes to a person, who seats it from the room", async () => {
    const s = await kyma(6);
    await s.caps.setup.applyPreset(person(KYMA_T), { preset: "food", replace: true });
    const { rows } = await s.db.client.query({
      sql: "SELECT capacity, withdrawal FROM services WHERE id = ?",
      params: [s.table.id],
      method: "all",
    });
    // The covers set aside, and nothing more; a table is for a set date (dated leisure).
    expect(rows[0]).toEqual([6, "dated_leisure"]);
    const evening = "2026-11-05T17:00:00Z";
    const eight = await s.caps.createBooking(customer(KYMA_T), tableFor(s.table.id, 8, evening));
    await rules(s.db, eight.view.item.id, KYMA_T);
    const held = await itemOf(s.db, eight.view.item.id);
    expect(held.state).toBe("requested");
    expect(held.flags.needsHuman).toBe(true);
    const e = await refused(transitionItem(s.db, assistant(KYMA_T), { itemId: eight.view.item.id, event: "confirm" }));
    expect([e.details?.guard, e.details?.reason]).toEqual(["tables", "over_set_aside"]);
    await transitionItem(s.db, person(KYMA_T), { itemId: eight.view.item.id, event: "confirm" });
    expect((await itemOf(s.db, eight.view.item.id)).state).toBe("confirmed");
    // The eight took the six set aside: a party of two at the same sitting is a person's too.
    const two = await s.caps.createBooking(customer(KYMA_T), tableFor(s.table.id, 2, evening));
    await rules(s.db, two.view.item.id, KYMA_T);
    expect((await itemOf(s.db, two.view.item.id)).state).toBe("requested");
    // Another sitting: four fit in the six, and the rule confirms them.
    const four = await s.caps.createBooking(customer(KYMA_T), tableFor(s.table.id, 4, "2026-11-05T19:00:00Z"));
    await rules(s.db, four.view.item.id, KYMA_T);
    expect((await itemOf(s.db, four.view.item.id)).state).toBe("confirmed");
  });

  it("with no covers set aside, a person confirms as many tables in a sitting as the room holds", async () => {
    const s = await kyma(undefined);
    const evening = "2026-11-05T17:00:00Z";
    for (const _ of [1, 2, 3]) {
      const b = await s.caps.createBooking(customer(KYMA_T), tableFor(s.table.id, 6, evening));
      await transitionItem(s.db, person(KYMA_T), { itemId: b.view.item.id, event: "confirm" });
      expect((await itemOf(s.db, b.view.item.id)).state).toBe("confirmed");
    }
  });
});

describe("what an order is checked for, before it is taken", () => {
  it("an item off sale is refused even by its id, though get_menu hides it", async () => {
    const s = await volcan();
    const pizza = await dish(s, VOLCAN_T, { name: "Pizza al pastor", price: 18900, currency: "MXN", menu: PIZZA });
    await s.db.client.query({
      sql: "UPDATE products SET active = 0 WHERE id = ?",
      params: [pizza.product.id],
      method: "run",
    });
    const slot = await firstSlot(s, VOLCAN_T, "2026-11-04");
    const e = await refused(
      s.caps.createOrder(
        customer(VOLCAN_T),
        order([line(pizza.product.id, "Pizza", 1, MXN(1))], { method: "pickup", slot: { start: slot } }),
      ),
    );
    expect(e.details?.reason).toBe("not_available");
    expect(e.message).toBe("Pizza al pastor is not on sale now.");
  });

  it("the zone's minimum counts what the options add", async () => {
    const s = await crunch();
    const chicken = await dish(s, BUSAN_T, {
      name: "양념 치킨",
      price: 10000,
      currency: "KRW",
      menu: {
        section: "chicken",
        optionGroups: [
          { id: "size", name: "크기", min: 0, max: 1, choices: [{ id: "big", name: "큰", priceDelta: 6000 }] },
        ],
      },
    });
    const slot = await firstSlot(s, BUSAN_T, "2026-11-04");
    const to = { shippingAddress: { streetAddress: "Haeundae-ro 1", postalCode: "48058", addressCountry: "KR" } };
    const small = await refused(
      s.caps.createOrder(
        customer(BUSAN_T),
        order([line(chicken.product.id, "치킨", 1, KRW(1))], { method: "delivery", slot: { start: slot } }, to),
      ),
    );
    expect(small.details?.reason).toBe("below_minimum");
    const big = await s.caps.createOrder(
      customer(BUSAN_T),
      order(
        [line(chicken.product.id, "치킨", 1, KRW(1), { options: [{ groupId: "size", choiceId: "big" }] })],
        { method: "delivery", slot: { start: slot } },
        to,
      ),
    );
    expect((await itemOf(s.db, big.view.item.id)).payload.totalPrice).toEqual(KRW(16000 + 3000));
  });

  it("a daypart past midnight serves its late hours, on its days and the morning after", async () => {
    const s = await volcan();
    await s.caps.updateSettings(person(VOLCAN_T), {
      doc: { menu: { dayparts: [{ name: "Noche", days: ["fri"], from: "22:00", to: "02:00" }] } },
    });
    const ctx = await kitchenContext(s.db);
    const m = menu({ section: "noche", dayparts: ["Noche"] });
    // Friday 6 November 2026, Mexico City (UTC-6).
    expect(servedAt(ctx, m, Date.parse("2026-11-07T05:00:00Z"))).toBe(true); // Fri 23:00
    expect(servedAt(ctx, m, Date.parse("2026-11-07T07:30:00Z"))).toBe(true); // Sat 01:30
    expect(servedAt(ctx, m, Date.parse("2026-11-07T08:30:00Z"))).toBe(false); // Sat 02:30
    expect(servedAt(ctx, m, Date.parse("2026-11-06T18:00:00Z"))).toBe(false); // Fri 12:00
    expect(servedAt(ctx, m, Date.parse("2026-11-08T05:00:00Z"))).toBe(false); // Sat 23:00
  });
});

describe("a person who accepts an order over a daily cap gives it what was left", () => {
  it("so automation never sells past what was set aside", async () => {
    const s = await shop({
      name: "Hokuto Bakery",
      currency: "JPY",
      timezone: "Asia/Tokyo",
      language: "ja",
      t: HOKUTO_T,
      hours: ["08:00", "19:00"],
    });
    const melon = await dish(s, HOKUTO_T, {
      name: "メロンパン",
      price: 280,
      currency: "JPY",
      menu: { section: "pan", dailyCap: 10 },
    });
    const slot = await firstSlot(s, HOKUTO_T, "2026-11-04");
    const ask = (n: number) =>
      s.caps.createOrder(
        customer(HOKUTO_T),
        order([line(melon.product.id, "メロンパン", n, JPY(280))], { method: "pickup", slot: { start: slot } }),
      );
    await ask(7);
    const five = await ask(5);
    expect((await itemOf(s.db, five.view.item.id)).payload.kitchen).toEqual({ instant: false, hold: ["over_cap"] });
    await transitionItem(s.db, person(HOKUTO_T), { itemId: five.view.item.id, event: "accept" });
    expect(await claims(s.db, "menu-cap:")).toBe(10);
    const three = await ask(3);
    expect((await itemOf(s.db, three.view.item.id)).payload.kitchen).toEqual({ instant: false, hold: ["over_cap"] });
    await transitionItem(s.db, person(HOKUTO_T), {
      itemId: five.view.item.id,
      event: "record_cancel",
      input: { note: "電話でキャンセル" },
    });
    expect(await claims(s.db, "menu-cap:")).toBe(7);
  });
});

describe("the menu's own word: allergens, dietary tags and withdrawal", () => {
  it("refuses a dietary tag the dish's own allergens contradict", async () => {
    const s = await shop({
      name: "Hokuto Bakery",
      currency: "JPY",
      timezone: "Asia/Tokyo",
      language: "ja",
      t: HOKUTO_T,
    });
    const row = await s.caps.setup.createProduct(person(HOKUTO_T), {
      name: "Melon pan",
      price: JPY(280),
      active: true,
    });
    const e = await refused(
      s.caps.food.setMenuItem(person(HOKUTO_T), {
        product_id: row.id,
        menu: menu({
          section: "pan",
          dietary: ["gluten_free", "vegan", "nut_free"],
          allergens: { contains: ["wheat", "milk", "eggs"], mayContain: ["almond"], status: "unconfirmed" },
        }),
      }),
    );
    expect(e.status).toBe(422);
    expect(e.fields?.map((f) => [f.path, f.message])).toEqual([
      ["menu.dietary", "Gluten free, but it contains wheat: take one off."],
      ["menu.dietary", "Vegan, but it contains milk: take one off."],
      ["menu.dietary", "Nut free, but it may contain almond: take one off."],
    ]);
  });

  it("a dish on the menu is the perishable exception: the confirm step and the email say so, not 14 days", async () => {
    const s = await shop({
      name: "Monsoon Café",
      currency: "INR",
      timezone: "Asia/Kolkata",
      language: "en",
      t: BLR_T,
      hours: ["07:00", "20:00"],
    });
    const dosa = await dish(s, BLR_T, { name: "Benne dosa", price: 12000, currency: "INR", menu: { section: "food" } });
    const { rows } = await s.db.client.query({
      sql: "SELECT withdrawal FROM products WHERE id = ?",
      params: [dosa.product.id],
      method: "all",
    });
    expect(rows[0]?.[0]).toBe("perishable");
    const slot = await firstSlot(s, BLR_T, "2026-11-04");
    const input = order([line(dosa.product.id, "Dosa", 1, INR(12000))], { method: "pickup", slot: { start: slot } });
    const bare = new Capabilities(
      s.db,
      createSecretBox(["food-test-instance-key-0123456789abcdef"]),
      "https://kitchen.example",
    );
    const ask = await refused(bare.createOrder(customer(BLR_T), input));
    const summary = String(ask.details?.summary);
    expect(summary).toContain("This cannot be returned: it does not keep.");
    expect(summary).not.toContain("withdraw within");
    const made = await s.caps.createOrder(customer(BLR_T), input);
    await transitionItem(s.db, person(BLR_T), { itemId: made.view.item.id, event: "accept" });
    const [row] = await s.db.orm.select().from(items).where(eq(items.id, made.view.item.id));
    const item = rowToItem(row as NonNullable<typeof row>);
    const settings = await readSettings(s.db);
    const right = await withdrawalOf(s.db, item, settings, BLR_T);
    expect([right.available, right.exception]).toEqual([false, "perishable"]);
    const mail = renderCustomerMail({
      item,
      event: "accept",
      lang: "en",
      timezone: "Asia/Kolkata",
      business: "Monsoon Café",
      withdrawal: {
        available: false,
        until: null,
        kind: "goods",
        exception: right.exception && right.exception !== "standard" ? right.exception : null,
        law: "eu",
        days: 14,
      },
      now: BLR_T,
    });
    expect(mail.text).toContain("This cannot be returned: it does not keep.");
    expect(mail.text).not.toContain("withdraw within");
  });

  it("an order's emails list each line with its choices, how and when, the fee and the tip, adding up to the total", async () => {
    const s = await crunch();
    const chicken = await dish(s, BUSAN_T, {
      name: "양념 치킨",
      price: 18000,
      currency: "KRW",
      menu: {
        section: "chicken",
        optionGroups: [
          { id: "sauce", name: "소스", min: 0, max: 1, choices: [{ id: "hot", name: "매운맛", priceDelta: 1000 }] },
        ],
      },
    });
    const slots = await s.caps.food.listOrderSlots(
      { date: "2026-11-04", method: "delivery", postal_code: "48058", country: "KR" },
      BUSAN_T,
      "en",
    );
    const made = await s.caps.createOrder(
      customer(BUSAN_T),
      order(
        [
          line(chicken.product.id, "치킨", 2, KRW(1), {
            options: [{ groupId: "sauce", choiceId: "hot" }],
            note: "no radish",
          }),
        ],
        { method: "delivery", slot: { start: slots.slots[0]?.start } },
        {
          shippingAddress: { streetAddress: "Haeundae-ro 1", postalCode: "48058", addressCountry: "KR" },
          tip: { percent: 10 },
        },
      ),
    );
    const [row] = await s.db.orm.select().from(items).where(eq(items.id, made.view.item.id));
    const item = rowToItem(row as NonNullable<typeof row>);
    const mail = renderCustomerMail({
      item,
      event: "create",
      lang: "en",
      timezone: "Asia/Seoul",
      business: "Seoul Crunch Chicken",
      now: BUSAN_T,
    });
    expect(mail.text).toContain("2 × 양념 치킨 (매운맛) “no radish” —");
    expect(mail.text).toMatch(/Delivery: [A-Z][a-z]+day/);
    expect(mail.text).toContain("Delivery (Haeundae): ₩3,000.");
    expect(mail.text).toContain("Tip: ₩3,800.");
    // The lines, the fee and the tip add up to the total the email gives.
    expect(19000 * 2 + 3000 + 3800).toBe((item.payload as { totalPrice: { value: number } }).totalPrice.value);
  });

  it("a confirm writes only over what the person was shown: a change saved a moment before wins", async () => {
    const s = await volcan();
    const pizza = await dish(
      s,
      VOLCAN_T,
      { name: "Pizza al pastor", price: 18900, currency: "MXN", menu: PIZZA },
      false,
    );
    const query = s.db.client.query.bind(s.db.client);
    // Another person adds peanuts between the confirm's read and its write.
    s.db.client.query = (async (q: Parameters<typeof query>[0]) => {
      if (/AND menu = \?/.test(q.sql)) {
        s.db.client.query = query;
        await s.caps.food.setMenuItem(person(VOLCAN_T, "staff"), {
          product_id: pizza.product.id,
          menu: menu({
            ...PIZZA,
            allergens: { contains: ["wheat", "milk", "peanuts"], mayContain: ["sesame"], status: "unconfirmed" },
          }),
        });
      }
      return query(q);
    }) as typeof s.db.client.query;
    const e = await refused(
      s.caps.food.confirmAllergens(person(VOLCAN_T), {
        product_id: pizza.product.id,
        fingerprint: pizza.fingerprint as string,
      }),
    );
    s.db.client.query = query;
    expect(e.details?.guard).toBe("allergens_changed");
    const now = (await s.caps.food.ownerMenu(person(VOLCAN_T))).items.find((i) => i.product.id === pizza.product.id);
    expect(now?.menu?.allergens).toMatchObject({ contains: ["wheat", "milk", "peanuts"], status: "unconfirmed" });
  });

  it("a dish brought in again keeps everything the owner set here", () => {
    const before = menu({
      section: "pasteles",
      dailyCap: 6,
      madeToOrder: true,
      noticeMin: 2880,
      availableDays: ["fri", "sat"],
      dayparts: ["Tarde"],
      sort: 3,
      brief: { messageMax: 30 },
      allergens: { contains: ["wheat", "eggs"], mayContain: [], status: "confirmed", confirmedBy: "owner" },
      optionGroups: [
        {
          id: "g1",
          name: "Tamaño",
          min: 1,
          max: 1,
          externalId: "TG-1",
          choices: [
            { id: "c1", name: "Grande", externalId: "TC-1", allergens: { contains: ["milk"], mayContain: [] } },
          ],
        },
      ],
    });
    const item = {
      externalId: "T-CAKE",
      name: "Pastel de tres leches",
      price: MXN(52000),
      optionGroups: [
        {
          externalId: "TG-1",
          name: "Tamaño",
          min: 1,
          max: 1,
          choices: [{ externalId: "TC-1", name: "Grande", priceDelta: 8000 }],
        },
      ],
    };
    const next = mergeImported(before, menuFromSnapshot(item, "pasteles"), item, person(VOLCAN_T), "toast");
    expect(next).toMatchObject({ section: "pasteles", dailyCap: 6, madeToOrder: true, noticeMin: 2880, sort: 3 });
    expect(next.availableDays).toEqual(["fri", "sat"]);
    expect(next.allergens.status).toBe("confirmed");
    expect(next.optionGroups[0]?.choices[0]).toMatchObject({ priceDelta: 8000, allergens: { contains: ["milk"] } });
    const changed = mergeImported(
      before,
      menuFromSnapshot({ ...item, allergens: { contains: ["wheat"], status: "unconfirmed" } }, "pasteles"),
      { ...item, allergens: { contains: ["wheat"], status: "unconfirmed" } },
      person(VOLCAN_T),
      "toast",
    );
    expect(changed.allergens).toMatchObject({ contains: ["wheat"], status: "unconfirmed", source: "toast" });
  });
});

/* --- the kitchen's own till ------------------------------------------------------------------ */

/** A till as the inbox sees it through its connectors: one connection, the writer given. */
async function till(s: Shop, kind: string, title: string, writer: OrdersWriter) {
  const id = `conn_${kind}`;
  await s.db.client.query({
    sql: "INSERT INTO connectors (id, kind, name, status, config_public, created_at, updated_at) VALUES (?, ?, ?, 'active', '{}', ?, ?)",
    params: [id, kind, title, VOLCAN_T, VOLCAN_T],
    method: "run",
  });
  const definition = {
    kind,
    title,
    group: "pos",
    capabilities: ["orders_out", "status_in"],
    auth: "form",
    orders: writer,
  };
  const ctx = {
    inbox: { id: "inb_volcan" },
    marker: "m",
    secret: {},
    extra: {},
    now: VOLCAN_T,
  } as unknown as RunContext;
  const connectors = {
    async contextFor() {
      return { definition, ctx, status: "active" };
    },
  } as unknown as ConnectorCapabilities;
  registerFoodResolver(connectors);
  return { id, connectors, definition, ctx };
}

async function notes(db: Db, itemId: string): Promise<string[]> {
  const { rows } = await db.client.query({
    sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND direction = 'note' ORDER BY created_at, id",
    params: [itemId],
    method: "all",
  });
  return rows.map((r) => String(r[0]));
}

async function acceptedOrder(s: Shop) {
  const pizza = await dish(s, VOLCAN_T, { name: "Pizza al pastor", price: 18900, currency: "MXN", menu: PIZZA });
  const slot = await firstSlot(s, VOLCAN_T, "2026-11-04");
  const made = await s.caps.createOrder(
    customer(VOLCAN_T),
    order([line(pizza.product.id, "Pizza", 1, MXN(1))], { method: "pickup", slot: { start: slot } }),
  );
  await transitionItem(s.db, person(VOLCAN_T), { itemId: made.view.item.id, event: "accept" });
  return made.view.item.id;
}

const silent = (idempotent: boolean): OrdersWriter => ({
  ...(idempotent ? { idempotent: true } : {}),
  async put(): Promise<PosOrderRef> {
    throw new ConnectorError("unreachable", "no answer");
  },
  async find() {
    return null;
  },
  async status() {
    return null;
  },
});

async function journal(db: Db, itemId: string): Promise<{ id: string; outcome: string }[]> {
  const { rows } = await db.client.query({
    sql: "SELECT id, outcome FROM connector_writes WHERE item_id = ? ORDER BY attempt",
    params: [itemId],
    method: "all",
  });
  return rows.map((r) => ({ id: String(r[0]), outcome: String(r[1]) }));
}

describe("a till that never answers: written once more where it can be, else a person looks", () => {
  it("one that answers a repeat as the same order is written again, then a person is told", async () => {
    const s = await volcan();
    const t = await till(s, "toast", "Toast", silent(true));
    const itemId = await acceptedOrder(s);
    const first = await pushOrder(s.db, t.connectors, itemId, VOLCAN_T);
    expect(first.map((o) => o.status)).toEqual(["pending"]);
    expect((await notes(s.db, itemId)).at(-1)).toMatch(/^Toast has not answered about this order yet/);
    const [w1] = await journal(s.db, itemId);
    expect(await resolveWrite(s.db, String(w1?.id), VOLCAN_T + 6 * MIN)).toBe("never found: not written");
    const { rows } = await s.db.client.query({
      sql: "SELECT dedupe_key FROM jobs WHERE kind = 'pos_push' ORDER BY created_at",
      params: [],
      method: "all",
    });
    expect(rows.map((r) => r[0])).toContain(`pos_push:${itemId}:again`);
    await pushOrder(s.db, t.connectors, itemId, VOLCAN_T + 7 * MIN);
    const second = (await journal(s.db, itemId))[1];
    await resolveWrite(s.db, String(second?.id), VOLCAN_T + 13 * MIN);
    expect((await notes(s.db, itemId)).at(-1)).toBe("Toast did not answer about this order, twice: check it in Toast.");
    expect((await itemOf(s.db, itemId)).flags.needsHuman).toBe(true);
  });

  it("one that may take it twice is never written again: a person checks it there", async () => {
    const s = await volcan();
    const t = await till(s, "clover", "Clover", silent(false));
    const itemId = await acceptedOrder(s);
    await pushOrder(s.db, t.connectors, itemId, VOLCAN_T);
    const [w1] = await journal(s.db, itemId);
    await resolveWrite(s.db, String(w1?.id), VOLCAN_T + 6 * MIN);
    expect((await notes(s.db, itemId)).at(-1)).toBe(
      "Clover did not answer about this order: check it in Clover. It was not sent again, so it is never made twice.",
    );
    const { rows } = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM jobs WHERE dedupe_key = ?",
      params: [`pos_push:${itemId}:again`],
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBe(0);
  });

  it("an order cancelled here after it went in is marked for a person to cancel it there too", async () => {
    const s = await volcan();
    const t = await till(s, "toast", "Toast", {
      ...silent(true),
      async put() {
        return { externalId: "ord-1", status: "pending" };
      },
    });
    const itemId = await acceptedOrder(s);
    expect((await pushOrder(s.db, t.connectors, itemId, VOLCAN_T)).map((o) => o.status)).toEqual(["written"]);
    await transitionItem(s.db, person(VOLCAN_T), {
      itemId,
      event: "record_cancel",
      input: { note: "Llamó para cancelar" },
    });
    const { rows } = await s.db.client.query({
      sql: "SELECT id, kind, payload FROM jobs WHERE kind = 'pos_cancel'",
      params: [],
      method: "all",
    });
    expect(rows).toHaveLength(1);
    await posCancelHandler()(
      { id: String(rows[0]?.[0]), kind: "pos_cancel", payload: { itemId } } as never,
      {
        db: s.db,
        now: VOLCAN_T + MIN,
      } as never,
    );
    expect((await notes(s.db, itemId)).at(-1)).toBe(
      "This order was cancelled here: cancel it in Toast too, so the kitchen does not make it.",
    );
  });

  it("an order waiting on its pay link is not sent as one to pay at the door", async () => {
    const s = await volcan();
    const t = await till(s, "deliverect", "Deliverect", silent(true));
    const itemId = await acceptedOrder(s);
    await s.db.client.query({
      sql: "UPDATE items SET state = 'awaiting_payment' WHERE id = ?",
      params: [itemId],
      method: "run",
    });
    expect(await pushOrder(s.db, t.connectors, itemId, VOLCAN_T)).toEqual([]);
    expect(await journal(s.db, itemId)).toEqual([]);
  });

  it("a till's refusal marks the order for a person once, with what it said; every open order is asked about in turn", async () => {
    const s = await volcan();
    const asked: string[] = [];
    const t = await till(s, "toast", "Toast", {
      ...silent(true),
      async status(_ctx, ref) {
        asked.push(ref.externalId);
        return null;
      },
    });
    const itemId = await acceptedOrder(s);
    for (let n = 1; n <= 25; n++) {
      await s.db.client.query({
        sql: `INSERT INTO connector_writes (id, connector_id, item_id, op, owner, attempt, idem_key, request_sha, outcome, external_id, created_at, updated_at)
              VALUES (?, ?, ?, 'order', 'food', ?, ?, 'sha', 'written', ?, ?, ?)`,
        params: [ulid(), t.id, itemId, n, `k${n}`, `ord-${n}`, VOLCAN_T, VOLCAN_T + n],
        method: "run",
      });
    }
    const step = (now: number) =>
      posStatusStep({ db: s.db, connectorId: t.id, kind: "toast", definition: t.definition as never, ctx: t.ctx, now });
    await step(VOLCAN_T + MIN);
    expect(asked).toHaveLength(20);
    await step(VOLCAN_T + 2 * MIN);
    expect(asked.slice(20, 25).sort()).toEqual(["ord-21", "ord-22", "ord-23", "ord-24", "ord-25"]);
    expect(await applyPosState(s.db, t.id, "ord-3", { status: "rejected", reason: "sin masa" }, VOLCAN_T)).toBe(true);
    expect(await applyPosState(s.db, t.id, "ord-3", { status: "rejected", reason: "sin masa" }, VOLCAN_T)).toBe(false);
    expect((await notes(s.db, itemId)).filter((n) => n.startsWith("Toast did not take"))).toEqual([
      "Toast did not take this order: sin masa",
    ]);
  });
});

describe("a menu brought in from a till, in the signed catalogue feed (ADR-029)", () => {
  it("reaches a network already reading the feed: a dish brought in, or repriced, moves to the feed's end", async () => {
    const t = Date.parse("2026-10-26T09:00:00Z");
    const domain = "inbox.trattoria.example";
    const s = await shop({ name: "Trattoria Sole", currency: "EUR", timezone: "Europe/Rome", language: "it", t });
    const snapshot = (price: number, more = false): SetupSnapshot => ({
      source: { kind: "flipdish", account: "acct-1", readAt: t },
      menu: [
        {
          name: "Pizze",
          items: [
            { externalId: "m-1", name: "Margherita", price: EUR(price) },
            ...(more ? [{ externalId: "m-2", name: "Diavola", price: EUR(1300) }] : []),
          ],
        },
      ],
    });
    const read = async (after?: string) => {
      const out: CataloguePage["items"][number][] = [];
      let cursor = after;
      for (let n = 0; n < 50; n++) {
        const r = await s.caps.catalogue.changes(
          { ...(cursor ? { after: cursor } : {}), limit: 1 },
          { domain, url: `https://${domain}/v1/catalogue/changes?limit=1${cursor ? `&after=${cursor}` : ""}`, now: t },
        );
        if (r.status !== 200) throw new Error(`the feed answered ${r.status}`);
        const page = cataloguePageSchema.parse(JSON.parse(r.body));
        out.push(...page.items);
        if (page.next_cursor === null) return { items: out, cursor };
        cursor = page.next_cursor;
      }
      throw new Error("the feed never ended");
    };
    const shown = (items: CataloguePage["items"]) =>
      items.map((i) => (i.state === "listed" ? `${i.name}@${i.price.value}` : i.id));
    const snap = vi.spyOn(s.caps.connectors, "setupSnapshot");
    snap.mockResolvedValue(snapshot(1100));
    await s.caps.food.importMenu(person(t), { connection_id: "c1", items: ["m-1", "m-2"] });
    // Two dishes the owner typed in after it, so a network's cursor is past the import.
    await s.caps.setup.createProduct(person(t), { name: "Tiramisù", price: EUR(600), active: true });
    await s.caps.setup.createProduct(person(t), { name: "Espresso", price: EUR(200), active: true });
    const first = await read();
    expect(shown(first.items)).toEqual(expect.arrayContaining(["Margherita@1100", "Tiramisù@600", "Espresso@200"]));

    // The till reprices the Margherita and adds the Diavola; the owner keeps both.
    snap.mockResolvedValue(snapshot(1250, true));
    expect(await s.caps.food.importMenu(person(t), { connection_id: "c1", items: ["m-1", "m-2"] })).toEqual({
      kept: 1,
      updated: 1,
    });
    // The network asks again from where it stopped, as the protocol says.
    const next = await read(first.cursor);
    expect(shown(next.items)).toEqual(expect.arrayContaining(["Margherita@1250", "Diavola@1300"]));
  });
});

describe("a restaurant that takes its orders on its own site (doors elsewhere, ADR-035)", () => {
  it("offers no slot an order could not be made for here, and says where orders go", async () => {
    const s = await volcan();
    await s.db.client.query({ sql: "UPDATE business SET domain = 'pizzeriavolcan.mx'", params: [], method: "run" });
    const pizza = await dish(s, VOLCAN_T, { name: "Pizza al pastor", price: 18900, currency: "MXN", menu: PIZZA });
    const before = await firstSlot(s, VOLCAN_T, "2026-11-04");
    await s.caps.updateSettings(person(VOLCAN_T), {
      doc: { doorsElsewhere: [{ itemType: "order", url: "https://pizzeriavolcan.mx/pedidos" }] },
    });
    expect((await s.caps.getBusinessProfile()).item_types).not.toContain("order");
    const slots = await s.caps.food.listOrderSlots({ date: "2026-11-04", method: "pickup" }, VOLCAN_T, "es");
    expect(slots).toMatchObject({ answer: "closed", slots: [] });
    expect(slots.words).toContain("https://pizzeriavolcan.mx/pedidos");
    // What list_order_slots no longer offers, create_order refuses too, naming the same place.
    const no = await refused(
      s.caps.createOrder(
        customer(VOLCAN_T),
        order([line(pizza.product.id, "Pizza", 1, MXN(1))], { method: "pickup", slot: { start: before } }),
      ),
    );
    expect(no.message).toContain("https://pizzeriavolcan.mx/pedidos");
    // The menu still reads here: what is in a dish is asked about here too.
    expect(await s.caps.food.offered()).toBe(true);
    expect(await s.caps.food.orderDoorElsewhere()).toBe("https://pizzeriavolcan.mx/pedidos");
  });
});

describe("what customers read, in the business's words (the copy lint)", () => {
  it("names no software, network, receipt, pass, key or inbox, in any of the seven languages", () => {
    for (const lang of ["en", "es", "fr", "de", "it", "pt", "ja"]) {
      const w = kitchenWords(lang, "Taverna Kyma");
      const at = Date.parse("2026-11-05T17:00:00Z");
      const strings = [
        w.notForATime,
        w.chooseMethod(["pickup", "delivery"]),
        w.noTips,
        w.chooseSlot,
        w.paused(at, "Europe/Athens"),
        w.notASlot,
        w.tooSoon(at, "Europe/Athens", true),
        w.tooFar(7),
        w.slotFull([at], "Europe/Athens"),
        w.soldOut("Μουσακάς"),
        w.notAvailable("Μουσακάς"),
        w.notThatDay("Μουσακάς"),
        w.notServedThen("Μουσακάς"),
        w.noDeliveryThere,
        w.belowMinimum("Kalamaria", EUR(1500)),
        w.fulfilLine("delivery", at, "Europe/Athens"),
        w.feeLine("Kalamaria", "2,00 €"),
        w.tipLine("1,00 €"),
        w.slotsOpen(3, at, "Europe/Athens"),
        w.closedThatDay,
        w.noDelivery,
        w.addressUnknown,
        w.takenElsewhere("https://tavernakyma.gr/order"),
        w.tableQuote(14),
        w.tableTooLarge(8),
        allergenWords("Taverna Kyma", lang),
        tableWords(
          {
            deposit: { amount: EUR(6000), refundable: true },
            policy: {
              steps: [{ until: "2026-11-04T19:00:00+02:00", fee: EUR(0) }],
              after: EUR(6000),
              noShow: EUR(6000),
              zone: "Europe/Athens",
            },
          },
          { lang },
        ),
      ];
      expect(customerCopyProblems(strings, lang), lang).toEqual([]);
    }
  });
});
