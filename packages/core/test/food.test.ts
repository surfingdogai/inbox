import { runMigrations } from "@surfingdog/platform";
import {
  ALLERGEN_CODES,
  ALLERGENS_VOCABULARY,
  allergenLabel,
  expandAllergens,
  JURISDICTIONS,
  jurisdictionOf,
  mandatoryAllergens,
} from "@surfingdog/spec";
import { describe, expect, it, vi } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import type { CreateOrderInput } from "../src/capabilities/types";
import { createDb, type Db } from "../src/db";
import { customerCopyProblems } from "../src/i18n/customer-words";
import { ulid } from "../src/ids";
import { tableWords } from "../src/kitchen/tables";
import { kitchenWords } from "../src/kitchen/words";
import { allergenWords } from "../src/menu/allergens";
import type { MenuFields } from "../src/menu/schema";
import { menuFieldsSchema } from "../src/menu/schema";
import { runRulesForEvent } from "../src/rules/engine";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { createSecretBox } from "../src/secrets/box";
import { WriteError } from "../src/write/errors";
import { type Caller, transitionItem } from "../src/write/index";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * Restaurants, takeaways, bakeries and cafés (ADR-036), end to end on the capabilities: the allergen
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

describe("what customers read, in the business's words (the copy lint)", () => {
  it("names no software, network, receipt, pass, key or inbox, in any of the six languages", () => {
    for (const lang of ["en", "es", "fr", "de", "it", "pt"]) {
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
