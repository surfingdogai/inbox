import { builtInConnectors } from "@surfingdog/adapters";
import { DEFAULT_SETTINGS, gallery, mergeSettings, PRESET_KEYS, settingsWriteSchema } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { SOURCE_CARDS, SOURCE_WORDS, sourceRows, VERIFIED_LIVE } from "../client/src/lib/bring";
import { BUSINESS_KINDS, businessKind, chosenKind, kindAlso, matchKinds } from "../client/src/lib/kinds";
import { setupPayments } from "../client/src/lib/payments";
import {
  anyDoor,
  DOOR_GROUPS,
  defaultDoors,
  doorRows,
  doorsStepDoc,
  GENERAL,
  KINDS,
  kindOf,
  offerSections,
  quickKind,
  setupKeyOfSaved,
  setupKindOf,
  startDoors,
  stepsFor,
  termsOf,
  wizardPreset,
} from "../client/src/lib/setup";

/**
 * The setup, all of it: hundreds of kinds of business typed ahead in five languages, or the owner's own words; every
 * door the inbox has, with each kind's defaults and the limits beside them, written as Settings keep them; what the
 * offer step asks for by those doors; and the systems it can be brought from, each said as far along as it is.
 */
describe("the setup's kinds of business", () => {
  it("finds a kind by its name in any of five languages, accents or not, best first", () => {
    expect(matchKinds("tatt")[0]?.id).toBe("tattoo-studio");
    expect(matchKinds("cabeleireiro")[0]?.id).toBe("hair-salon");
    expect(matchKinds("Boulangerie")[0]?.id).toBe("bakery");
    expect(matchKinds("zahnarzt")[0]?.id).toBe("dentist");
    expect(matchKinds("peluqueria")[0]?.id).toBe("hair-salon");
    expect(matchKinds("cafe")[0]?.id).toBe("cafe");
    expect(matchKinds("surf").map((k) => k.id)).toEqual(expect.arrayContaining(["surf-school", "surf-house"]));
    expect(matchKinds("   ")).toEqual([]);
    expect(matchKinds("e", 8).length).toBeLessThanOrEqual(8);
  });

  it("keeps a kind by id with its English name, or the owner's own words, never empty", () => {
    const tattoo = businessKind("tattoo-studio");
    expect(tattoo && chosenKind(tattoo)).toEqual({ id: "tattoo-studio", label: "Tattoo studio" });
    expect(chosenKind("  Hovercraft   tours ")).toEqual({ id: null, label: "Hovercraft tours" });
    expect(chosenKind(" ")).toBeNull();
    expect(chosenKind("x".repeat(80))?.label).toHaveLength(60);
    expect(tattoo && kindAlso(tattoo, "pt-PT")).toBe("Estúdio de tatuagens");
    expect(tattoo && kindAlso(tattoo, "en-GB")).toBe("");
    expect(tattoo && kindAlso(tattoo, "ja")).toBe("");
  });

  it("starts each of hundreds of kinds from a setup the inbox has, and anything else from the general one", () => {
    expect(BUSINESS_KINDS.length).toBeGreaterThanOrEqual(300);
    for (const k of BUSINESS_KINDS) {
      const setup = setupKindOf(k);
      expect(setup.key, k.id).toBe(k.preset);
      if (setup.preset) expect(PRESET_KEYS as readonly string[]).toContain(setup.preset);
    }
    expect(setupKindOf(businessKind("plumber")).key).toBe("trades");
    expect(setupKindOf(businessKind("hotel")).key).toBe("stays");
    expect(setupKindOf(businessKind("wedding-planner"))).toBe(GENERAL);
    expect(setupKindOf(undefined)).toBe(GENERAL);
    // The general kind has no rules of its own: they follow what agents can do.
    expect(GENERAL.preset).toBeNull();
    expect(wizardPreset({ booking: true, quoteRequest: true, message: true }, GENERAL)).toBe("appointments");
    expect(wizardPreset({ booking: false, quoteRequest: true, message: true }, GENERAL)).toBe("trades");
    expect(kindOf("general")).toBe(GENERAL);
    expect(stepsFor("general").map((s) => s.id)).toEqual(["kind", "you", "doors", "offer", "hours", "answering"]);
  });

  it("reads a quick pick as the one kind it is, and a saved kind back as its quick pick", () => {
    expect(quickKind("food")).toEqual({ id: "restaurant", label: "Restaurant" });
    expect(quickKind("stays")).toEqual({ id: "place-to-stay", label: "Place to stay" });
    // A salon, clinic or studio is many kinds: nothing is said until the owner finds theirs.
    expect(quickKind("appointments")).toBeNull();
    for (const k of KINDS) {
      const q = quickKind(k.key);
      if (q) expect(setupKeyOfSaved(q)).toBe(k.key);
    }
    expect(setupKeyOfSaved({ id: "tattoo-studio", label: "Tattoo studio" })).toBe("appointments");
    expect(setupKeyOfSaved({ id: null, label: "Hovercraft tours" })).toBe("general");
    expect(setupKeyOfSaved(null)).toBeNull();
  });

  it("saves what it runs as the settings take it", () => {
    for (const kind of [
      { id: "tattoo-studio", label: "Tattoo studio" },
      { id: null, label: "Hovercraft tours" },
      null,
    ]) {
      expect(settingsWriteSchema.safeParse({ directory: { kind } }).success, JSON.stringify(kind)).toBe(true);
    }
  });
});

describe("the setup's doors", () => {
  const groups = new Set(DOOR_GROUPS.map((g) => g.id));

  it("shows every door the inbox has, grouped, each with what it means for the owner", () => {
    const keys = (key: string) => doorRows(kindOf(key)).map((d) => d.key);
    expect(keys("appointments")).toEqual(["booking", "products", "quoteRequest", "negotiate", "changes", "message"]);
    expect(keys("shop")).toEqual(["booking", "products", "quoteRequest", "negotiate", "changes", "message"]);
    expect(keys("food")).toEqual(["order", "booking", "quoteRequest", "negotiate", "changes", "message"]);
    expect(keys("cafe")).toEqual(["order", "quoteRequest", "negotiate", "changes", "message"]);
    // A place to stay: its stays; its policies are its plans', so no prices of their own or changes here.
    expect(keys("stays")).toEqual(["stay", "quoteRequest", "message"]);
    expect(doorRows(kindOf("food")).find((d) => d.key === "booking")?.label).toBe("Agents can book a table");
    for (const k of [...KINDS, GENERAL]) {
      for (const d of doorRows(k)) {
        expect(groups.has(d.group), d.key).toBe(true);
        expect(d.line.length, `${k.key} ${d.key}`).toBeGreaterThan(10);
      }
    }
  });

  it("starts each kind with its own doors: a shop's products, a place's stays, a price of their own off", () => {
    expect(defaultDoors(kindOf("shop"))).toMatchObject({
      products: true,
      booking: false,
      negotiate: false,
      changes: true,
    });
    expect(defaultDoors(kindOf("appointments"))).toMatchObject({ booking: true, products: false, negotiate: false });
    expect(defaultDoors(kindOf("stays"))).toEqual({ booking: false, quoteRequest: false, message: true, stay: true });
    expect(defaultDoors(kindOf("food"))).toMatchObject({ order: true, booking: true });
    // Run again, a price of their own and changes stay as the owner set them in Settings.
    const set = {
      ...DEFAULT_SETTINGS,
      negotiation: {
        ...DEFAULT_SETTINGS.negotiation,
        priceCounters: true,
        changes: { ...DEFAULT_SETTINGS.negotiation.changes, maxPerItem: 0 },
      },
    };
    expect(startDoors(kindOf("shop"), set)).toMatchObject({ negotiate: true, changes: false, products: true });
    expect(startDoors(kindOf("shop"), DEFAULT_SETTINGS)).toEqual(defaultDoors(kindOf("shop")));
    expect(startDoors(kindOf("stays"), set)).toEqual(defaultDoors(kindOf("stays")));
    expect(anyDoor({ booking: false, quoteRequest: false, message: false, products: true })).toBe(true);
    expect(anyDoor({ booking: false, quoteRequest: false, message: false })).toBe(false);
  });

  it("writes the doors and their limits as Settings keep them, and only what the kind was asked", () => {
    const terms = { ...termsOf(DEFAULT_SETTINGS), cancelMin: 120, discountPct: 10, payments: ["card", "mb_way"] };
    expect(termsOf(DEFAULT_SETTINGS)).toEqual({ cancelMin: 1440, discountPct: 0, maxChanges: 3, payments: [] });
    const salon = doorsStepDoc(
      { ...defaultDoors(kindOf("appointments")), negotiate: true },
      kindOf("appointments"),
      terms,
    );
    expect(salon).toEqual({
      doors: { booking: null, quoteRequest: true, message: null },
      negotiation: { priceCounters: true, ai: { maxDiscountPct: 10 }, changes: { maxPerItem: 3 } },
      booking: { cancellationWindowMin: 120 },
      payments: { accepted: ["card", "mb_way"] },
    });
    // Changes off: a customer's change comes to the owner as their message.
    const shop = doorsStepDoc({ ...defaultDoors(kindOf("shop")), changes: false }, kindOf("shop"), terms);
    expect(shop.negotiation).toEqual({ priceCounters: false, ai: { maxDiscountPct: 10 }, changes: { maxPerItem: 0 } });
    expect(shop.booking).toBeUndefined();
    // A place to stay: its door follows its rooms; nothing about prices of their own or changes is touched.
    const stay = doorsStepDoc(defaultDoors(kindOf("stays")), kindOf("stays"), terms);
    expect(stay.doors).toEqual({ booking: false, quoteRequest: false, message: null, stay: null });
    expect(stay.negotiation).toBeUndefined();
    for (const doc of [salon, shop, stay, doorsStepDoc(defaultDoors(kindOf("food")), kindOf("food"), terms)]) {
      expect(settingsWriteSchema.safeParse(mergeSettings({}, doc)).success, JSON.stringify(doc)).toBe(true);
    }
  });

  it("offers the ways people pay in the business's country, one press each", () => {
    expect(setupPayments("PT")).toEqual([
      "card",
      "cash",
      "bank_transfer",
      "mb_way",
      "multibanco",
      "sepa",
      "apple_pay",
      "paypal",
    ]);
    expect(setupPayments("BR")).toContain("pix");
    expect(setupPayments(null)).toEqual(["card", "cash", "bank_transfer", "apple_pay", "paypal"]);
  });
});

describe("the setup's offer", () => {
  it("asks for what the doors need: services, products, a kitchen's dishes, or nothing", () => {
    expect(offerSections(defaultDoors(kindOf("appointments")), kindOf("appointments"))).toEqual(["services"]);
    expect(offerSections({ ...defaultDoors(kindOf("appointments")), products: true }, kindOf("appointments"))).toEqual([
      "services",
      "products",
    ]);
    expect(offerSections(defaultDoors(kindOf("shop")), kindOf("shop"))).toEqual(["products"]);
    expect(offerSections(defaultDoors(kindOf("bakery")), kindOf("bakery"))).toEqual(["menu"]);
    expect(offerSections({ booking: false, quoteRequest: false, message: true }, GENERAL)).toEqual([]);
  });

  it("says how far along each system is, as this release ships them: none yet verified on a live account", () => {
    const definitions = new Map(builtInConnectors().map((d) => [d.kind, d]));
    const cards = gallery(definitions, { lean: "stays", hookBase: "https://inbox.example.com/v1/hooks/" });
    const rows = sourceRows(cards, [...SOURCE_CARDS.products, ...SOURCE_CARDS.rooms, ...SOURCE_CARDS.menu]);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(VERIFIED_LIVE.size).toBe(0);
    for (const name of ["Shopify", "WooCommerce", "Square", "Beds24", "Hostaway", "GloriaFood", "Flipdish"]) {
      expect(by[name]?.words, name).toBe("Built, not yet verified on a live account");
      expect(by[name]?.hint, name).toBeNull();
    }
    // Partners that let only approved apps connect: waiting on them, with what the server says.
    for (const name of [
      "Mews",
      "apaleo",
      "Cloudbeds",
      "Smoobu",
      "Toast",
      "Lightspeed Restaurant",
      "Clover",
      "Deliverect",
    ]) {
      expect(by[name]?.words, name).toBe(SOURCE_WORDS.partner);
      expect(by[name]?.hint, name).toBeTruthy();
    }
    // One whose connector is not in this release is on its way.
    expect(by.Guesty?.words).toBe(SOURCE_WORDS.soon);
    // Each system once, each opening its own card.
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(by.Beds24?.card).toBe("property");
  });

  it("names the calendar as people know it, and says what the server still needs", () => {
    const cards = gallery(new Map(builtInConnectors().map((d) => [d.kind, d])));
    const rows = sourceRows(cards, SOURCE_CARDS.services);
    expect(rows.map((r) => r.name)).toEqual([
      "Square",
      "Calendly",
      "Cal.com",
      "Google Calendar",
      "iCloud, Outlook or a calendar link",
    ]);
    // Without a Google client on this server, Google needs one; the rest can be connected now.
    const google = rows.find((r) => r.name === "Google Calendar");
    expect(google?.words).toBe(SOURCE_WORDS.setup);
    expect(google?.hint).toContain("Google client");
    expect(rows.find((r) => r.key === "calendar_other")?.words).toBe(SOURCE_WORDS.unverified);
    // A place to stay's calendar is its channels' links, never Google's.
    const stay = sourceRows(cards, ["calendar"], { lodging: true });
    expect(stay.map((r) => r.name)).toEqual(["Calendar links"]);
    expect(stay[0]?.line).toContain("Airbnb");
    // A card this inbox does not offer is left out, never invented.
    expect(sourceRows(cards, ["spaceport"])).toEqual([]);
  });
});
