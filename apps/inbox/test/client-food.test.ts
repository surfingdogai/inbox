import { describe, expect, it } from "vitest";
import {
  allergenLine,
  allergenRows,
  confirmSentence,
  conflictOf,
  foodKind,
  freshId,
  fulfilLine,
  type GroupDraft,
  groupDrafts,
  groupsWrite,
  nextKitchenDay,
  nextStages,
  type OptionGroup,
  type OwnerMenu,
  ordersForToday,
  pauseLine,
  sameAllergens,
  slugOf,
  tablesWrite,
  tipLine,
  toggleAllergen,
} from "../client/src/lib/food";
import { formatDateTime, slotShort, slotWhen } from "../client/src/lib/format";
import {
  DISH_SECTIONS,
  dishPlan,
  doorsFor,
  doorsStepDoc,
  isKitchen,
  KINDS,
  kindOf,
  stepsFor,
} from "../client/src/lib/setup";
import type { ItemView } from "../client/src/lib/types";

/**
 * The owner's kitchen screens (ADR-036), the parts that decide something: the allergen grid (a dish
 * contains a thing or may contain it, never both; the law's list first), what an option adds in each
 * currency's own places (won and yen have none, pesos two), the next press for the kitchen, today's
 * orders in slot order in the business's own zone, the pause in words, and a table's rules. Fixtures
 * from Mexico City (MXN), Busan (KRW), Sapporo (JPY), Bengaluru (INR) and Thessaloniki (EUR).
 */

const VOCAB: OwnerMenu["vocabulary"]["allergens"] = [
  {
    code: "gluten",
    parent: null,
    label: "Cereals containing gluten",
    mandatory: true,
    recommended: false,
    mandatory_in: ["EU"],
  },
  { code: "wheat", parent: "gluten", label: "Wheat", mandatory: false, recommended: false, mandatory_in: ["US"] },
  { code: "milk", parent: null, label: "Milk", mandatory: true, recommended: false, mandatory_in: ["EU"] },
  { code: "sesame", parent: null, label: "Sesame", mandatory: true, recommended: false, mandatory_in: ["EU"] },
  { code: "tree_nuts", parent: null, label: "Tree nuts", mandatory: true, recommended: false, mandatory_in: ["EU"] },
  { code: "walnut", parent: "tree_nuts", label: "Walnut", mandatory: false, recommended: false, mandatory_in: [] },
  { code: "buckwheat", parent: null, label: "Buckwheat", mandatory: false, recommended: false, mandatory_in: ["JP"] },
  { code: "peach", parent: null, label: "Peach", mandatory: false, recommended: false, mandatory_in: [] },
];
const label = (code: string) => VOCAB.find((a) => a.code === code)?.label ?? code;

describe("the allergen grid", () => {
  it("says what a person confirms in a sentence, may-contain included", () => {
    const name = (c: string) =>
      ({ wheat: "Wheat", milk: "Milk", eggs: "Eggs", pork: "Pork", soy: "Soy", almond: "Almond" })[c] ?? c;
    expect(
      confirmSentence("Curry pan", { contains: ["wheat", "milk", "eggs", "pork", "soy"], mayContain: [] }, name),
    ).toBe("Curry pan contains wheat, milk, eggs, pork and soy, and nothing it may contain.");
    expect(confirmSentence("Melon pan", { contains: ["wheat"], mayContain: ["almond"] }, name)).toBe(
      "Melon pan contains wheat, and may contain almond.",
    );
  });

  it("does not offer a dietary tag the dish's own allergens contradict", () => {
    const glutenFree = { contains: ["gluten", "wheat", "rye"], mayContain: ["gluten", "wheat"] };
    expect(conflictOf(glutenFree, { contains: ["wheat", "milk"], mayContain: [] })).toEqual({
      code: "wheat",
      list: "contains",
    });
    expect(conflictOf(glutenFree, { contains: ["milk"], mayContain: ["wheat"] })).toEqual({
      code: "wheat",
      list: "mayContain",
    });
    expect(conflictOf(glutenFree, { contains: ["milk"], mayContain: [] })).toBeNull();
    expect(conflictOf(undefined, { contains: ["wheat"], mayContain: [] })).toBeNull();
  });

  it("puts a code in one column only: may contain moves to contains, and back out", () => {
    let lists = { contains: [] as readonly string[], mayContain: [] as readonly string[] };
    lists = toggleAllergen(lists, "sesame", "mayContain");
    expect(lists).toEqual({ contains: [], mayContain: ["sesame"] });
    lists = toggleAllergen(lists, "sesame", "contains");
    expect(lists).toEqual({ contains: ["sesame"], mayContain: [] });
    lists = toggleAllergen(lists, "sesame", "contains");
    expect(lists).toEqual({ contains: [], mayContain: [] });
  });

  it("shows the law's list first, then what the dish already has, and everything when asked", () => {
    const lists = { contains: ["walnut"], mayContain: [] };
    expect(allergenRows(VOCAB, lists, false).map((a) => a.code)).toEqual([
      "gluten",
      "milk",
      "sesame",
      "tree_nuts",
      "walnut",
    ]);
    expect(allergenRows(VOCAB, lists, true)).toHaveLength(VOCAB.length);
  });

  it("offers the ones some law names where the country has no list (Bengaluru), not Japan's asked-for twenty", () => {
    const none = VOCAB.map((a) => ({ ...a, mandatory: false }));
    expect(allergenRows(none, { contains: [], mayContain: [] }, false).map((a) => a.code)).toEqual([
      "gluten",
      "milk",
      "sesame",
      "tree_nuts",
      "buckwheat",
    ]);
  });

  it("says the dish's lists in a line, and that none were stated", () => {
    expect(allergenLine({ contains: ["milk", "wheat"], mayContain: ["sesame"] }, label)).toBe(
      "Contains milk, wheat · May contain sesame",
    );
    expect(allergenLine({ contains: [], mayContain: [] }, label)).toBe("No allergens stated");
  });

  it("sees the same lists in any order as unchanged, so the confirm press is offered", () => {
    expect(
      sameAllergens({ contains: ["milk", "gluten"], mayContain: [] }, { contains: ["gluten", "milk"], mayContain: [] }),
    ).toBe(true);
    expect(sameAllergens({ contains: ["milk"], mayContain: [] }, { contains: ["milk"], mayContain: ["sesame"] })).toBe(
      false,
    );
  });
});

describe("options, in each currency's own places", () => {
  const before: OptionGroup[] = [
    {
      id: "size",
      name: "Tamaño",
      min: 1,
      max: 1,
      externalId: "71",
      choices: [
        { id: "chica", name: "Chica" },
        {
          id: "grande",
          name: "Grande",
          priceDelta: 6000,
          externalId: "9002",
          allergens: { contains: [], mayContain: [] },
        },
      ],
    },
  ];

  it("shows pesos with two places and writes them back as centavos, keeping the till's ids", () => {
    const drafts = groupDrafts(before, 2);
    expect(drafts[0]?.choices.map((c) => c.adds)).toEqual(["", "60.00"]);
    const written = groupsWrite(drafts, before, "MXN");
    expect("groups" in written && written.groups[0]).toMatchObject({
      externalId: "71",
      choices: [
        { id: "chica", name: "Chica" },
        { id: "grande", priceDelta: 6000, externalId: "9002" },
      ],
    });
  });

  it("reads won and yen in whole units", () => {
    const sauce: GroupDraft = {
      id: "g1",
      name: "소스",
      min: 0,
      max: 2,
      halves: true,
      choices: [
        { id: "c1", name: "양념", adds: "1000", opens: "" },
        { id: "c2", name: "간장", adds: "1,500", opens: "" },
      ],
    };
    const krw = groupsWrite([sauce], [], "KRW");
    expect("groups" in krw && krw.groups[0]?.choices.map((c) => c.priceDelta)).toEqual([1000, 1500]);
    expect("groups" in krw && krw.groups[0]?.halves).toBe(true);
    const jpy = groupsWrite(
      [{ ...sauce, name: "トッピング", choices: [{ id: "c1", name: "あんこ", adds: "120", opens: "" }] }],
      [],
      "JPY",
    );
    expect("groups" in jpy && jpy.groups[0]?.choices[0]?.priceDelta).toBe(120);
  });

  it("says which amount does not read, and drops empty choices and groups", () => {
    const bad = groupsWrite(
      [
        {
          id: "g1",
          name: "Milk",
          min: 0,
          max: 1,
          halves: false,
          choices: [{ id: "c1", name: "Oat", adds: "abc", opens: "" }],
        },
      ],
      [],
      "INR",
    );
    expect(bad).toEqual({ problem: "Milk: Oat adds an amount that does not read." });
    const empty = groupsWrite(
      [{ id: "g1", name: "", min: 0, max: 1, halves: false, choices: [{ id: "c1", name: "", adds: "", opens: "" }] }],
      [],
      "EUR",
    );
    expect(empty).toEqual({ groups: [] });
  });

  it("caps how many may be chosen at the choices there are", () => {
    const r = groupsWrite(
      [
        {
          id: "g1",
          name: "Extras",
          min: 3,
          max: 9,
          halves: false,
          choices: [{ id: "c1", name: "Feta", adds: "1.50", opens: "" }],
        },
      ],
      [],
      "EUR",
    );
    expect("groups" in r && r.groups[0]).toMatchObject({ min: 1, max: 1, choices: [{ priceDelta: 150 }] });
  });
});

describe("sections", () => {
  it("names a section from its words, accents and all", () => {
    expect(slugOf("Pizzas al horno")).toBe("pizzas-al-horno");
    expect(slugOf("Γλυκά")).toBe("section");
    expect(slugOf("Café & Pâtisserie")).toBe("cafe-patisserie");
    expect(freshId("Pizzas", ["pizzas"])).toBe("pizzas-2");
  });
});

const order = (id: string, state: string, start: string, extra: Record<string, unknown> = {}) =>
  ({
    item: {
      id,
      type: "order",
      state,
      payload: { orderedItem: [], fulfil: { method: "pickup", slot: { start } }, ...extra },
    },
    party: undefined,
  }) as unknown as ItemView;

describe("the kitchen's day", () => {
  it("lists today's orders for a time in slot order, in the business's zone", () => {
    // 23:30 UTC on 3 Nov is 08:30 on 4 Nov in Sapporo: today there, tomorrow in UTC.
    const now = Date.parse("2026-11-03T23:00:00Z");
    const views = [
      order("b", "accepted", "2026-11-04T01:30:00Z"),
      order("a", "fulfilling", "2026-11-03T23:30:00Z"),
      order("c", "requested", "2026-11-04T00:00:00Z"),
      order("d", "accepted", "2026-11-05T00:00:00Z"),
    ];
    expect(ordersForToday(views, "Asia/Tokyo", now).map((v) => v.item.id)).toEqual(["a", "b"]);
  });

  it("with nothing left today, names the next day that has orders and its first time", () => {
    // Osaka, 20:00: today is done, and three orders wait for tomorrow morning.
    const now = Date.parse("2026-11-03T11:00:00Z");
    const views = [
      order("x", "accepted", "2026-11-03T23:30:00Z"),
      order("y", "accepted", "2026-11-03T23:00:00Z"),
      order("z", "paid", "2026-11-04T02:00:00Z"),
      order("later", "accepted", "2026-11-05T23:00:00Z"),
      order("open", "requested", "2026-11-03T22:00:00Z"),
    ];
    expect(ordersForToday(views, "Asia/Tokyo", now)).toEqual([]);
    expect(nextKitchenDay(views, "Asia/Tokyo", now)).toEqual({ line: "Tomorrow · 3 orders, first at 08:00", count: 3 });
    expect(nextKitchenDay([], "Asia/Tokyo", now)).toBeNull();
  });

  it("offers the next press: Preparing and Ready, then Out for delivery for a delivery only", () => {
    expect(nextStages("requested", undefined, "pickup")).toEqual([]);
    expect(nextStages("accepted", undefined, "pickup")).toEqual(["preparing", "ready"]);
    expect(nextStages("fulfilling", { stage: "preparing", at: "2026-11-04T00:00:00Z" }, "pickup")).toEqual(["ready"]);
    expect(nextStages("fulfilling", { stage: "ready", at: "2026-11-04T00:00:00Z" }, "pickup")).toEqual([]);
    expect(nextStages("fulfilling", { stage: "ready", at: "2026-11-04T00:00:00Z" }, "delivery")).toEqual([
      "out_for_delivery",
    ]);
  });

  it("says the pause in the owner's words, and nothing once it has ended", () => {
    const now = Date.parse("2026-11-04T01:00:00Z"); // 19:00 in Mexico City
    expect(pauseLine("2026-11-04T01:30:00Z", "America/Mexico_City", now)).toBe("Paused until 19:30");
    expect(pauseLine("2026-11-04T06:00:00Z", "America/Mexico_City", now)).toBe("Paused for the rest of today");
    expect(pauseLine("2026-11-04T00:30:00Z", "America/Mexico_City", now)).toBeNull();
    expect(pauseLine(null, "America/Mexico_City", now)).toBeNull();
  });

  it("puts how and when in a line, with the zone and its fee, and the day unless it is today", () => {
    const fulfil = {
      method: "delivery" as const,
      slot: { start: "2026-11-04T10:45:00Z" },
      zone: { name: "Kalamaria" },
      fee: { value: 250, currency: "EUR" },
    };
    const morning = Date.parse("2026-11-04T06:00:00Z"); // 08:00 in Thessaloniki
    expect(fulfilLine(fulfil, "Europe/Athens", morning)).toMatch(
      /^Delivery · Today, 12:45 · Kalamaria · €2\.50 delivery$/,
    );
    // A bakery in Osaka, the evening before: the order is for tomorrow, and says so.
    const osaka = Date.parse("2026-11-03T11:00:00Z"); // 20:00 there
    expect(fulfilLine({ method: "pickup", slot: { start: "2026-11-03T23:00:00Z" } }, "Asia/Tokyo", osaka)).toBe(
      "Collection · Tomorrow, 08:00",
    );
    // Further ahead, the day and the date (in the runtime's own words for them).
    expect(slotWhen("2026-11-06T01:00:00Z", "Asia/Tokyo", osaka)).toBe(
      formatDateTime("2026-11-06T01:00:00Z", "Asia/Tokyo"),
    );
    expect(slotWhen("2026-11-06T01:00:00Z", "Asia/Tokyo", osaka)).toMatch(/10:00$/);
    expect(slotShort("2026-11-03T23:00:00Z", "Asia/Tokyo", osaka)).toBe("Tomorrow 08:00");
    expect(slotShort("2026-11-03T12:30:00Z", "Asia/Tokyo", osaka)).toBe("21:30");
    expect(tipLine({ percent: 10 })).toBe("10%");
    expect(tipLine(undefined)).toBeNull();
  });
});

describe("tables and the kinds a setup offers", () => {
  it("writes a table's rules with the deposit in minor units, or counts bookings again", () => {
    expect(
      tablesWrite(
        { on: true, maxParty: 12, quoteAbove: 20, setAside: 40, deposit: { perPerson: "10", fromParty: 6 } },
        "EUR",
      ),
    ).toEqual({
      maxParty: 12,
      quoteAbove: 12,
      setAside: 40,
      deposit: { perPerson: { value: 1000, currency: "EUR" }, fromParty: 6 },
    });
    expect(tablesWrite({ on: false, maxParty: 8, quoteAbove: null, setAside: null, deposit: null }, "EUR")).toBeNull();
    expect(
      tablesWrite(
        { on: true, maxParty: 8, quoteAbove: null, setAside: null, deposit: { perPerson: "", fromParty: 6 } },
        "KRW",
      ),
    ).toEqual({ problem: "The deposit per person does not read as an amount." });
  });

  it("shows the Menu and Kitchen tabs to a kitchen only", () => {
    expect(foodKind({ kitchen: { enabled: true } })).toBe(true);
    expect(foodKind({ kitchen: { enabled: false }, menu: { sections: [{}] } })).toBe(true);
    expect(foodKind({ kitchen: { enabled: false }, menu: { sections: [] } })).toBe(false);
    expect(foodKind(undefined)).toBe(false);
  });

  it("asks a kitchen for its first dishes, priced and in a section, and its orders for a time", () => {
    for (const key of ["food", "bakery", "cafe"]) {
      expect(isKitchen(key)).toBe(true);
      expect(stepsFor(key).find((st) => st.id === "offer")?.label).toBe("Dishes");
      const doors = doorsFor(kindOf(key)).map((d) => d.key);
      expect(doors[0]).toBe("order");
      // Only a restaurant books tables.
      expect(doors.includes("booking")).toBe(key === "food");
    }
    expect(isKitchen("appointments")).toBe(false);
    expect(doorsFor(kindOf("bakery")).find((d) => d.key === "quoteRequest")?.line).toBe(
      "A cake made to order, a catering order.",
    );
    expect(kindOf("cafe")?.doors.quoteRequest).toBe(false);
    const bakery = kindOf("bakery");
    expect(
      doorsStepDoc({ booking: false, quoteRequest: true, message: true, order: false }, bakery).kitchen,
    ).toMatchObject({
      enabled: false,
      daysAhead: 14,
    });
    const plan = dishPlan(
      [
        { name: "Sourdough loaf", price: "650", section: "Bread" },
        { name: "", price: "", section: "" },
        { name: "Melon pan", price: "280", section: "Pastries" },
      ],
      "JPY",
      [{ id: "bread", name: "Bread", sort: 0 }],
    );
    expect(plan).toEqual({
      products: [
        { body: { name: "Sourdough loaf", price: { value: 650, currency: "JPY" }, active: true }, section: "bread" },
        { body: { name: "Melon pan", price: { value: 280, currency: "JPY" }, active: true }, section: "pastries" },
      ],
      sections: [
        { id: "bread", name: "Bread", sort: 0 },
        { id: "pastries", name: "Pastries", sort: 1 },
      ],
    });
    // A dish is never saved free by mistake.
    expect(dishPlan([{ name: "Flat white", price: "", section: "Coffee" }], "AUD", [])).toEqual({
      problem: "Flat white needs a price. Write a price like 45,50 or 45.50.",
    });
    expect(DISH_SECTIONS.cafe).toContain("Coffee");
  });

  it("starts a restaurant, a bakery and a café with their rules and their kitchen on", () => {
    for (const key of ["food", "bakery", "cafe"]) {
      const kind = KINDS.find((k) => k.key === key);
      expect(kind?.preset).toBe(key);
      expect(kind?.connect[0]).toBe("pos");
      expect((kind?.settings?.kitchen as { enabled?: boolean } | undefined)?.enabled).toBe(true);
    }
  });
});
