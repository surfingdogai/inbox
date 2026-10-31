import { parseMajor } from "./actions";
import { minorUnitsOf } from "./currencies";
import { type BusinessKind, businessKind, type ChosenKind, type KindPreset } from "./kinds";
import type { ConnectorGroup, PresetKey, ProductBody, ServiceBody, Settings } from "./types";

/**
 * What the setup wizard's "What you offer" step sends, as pure functions so they run in tests on
 * both runtimes. A price is read the way the owner typed it (`parseMajor`): `45,50` is forty-five
 * fifty, never free. A price that does not read as one stops the step and says how to write it;
 * nothing is saved at 0 by mistake.
 */
export interface OfferDraft {
  readonly name: string;
  readonly minutes: string;
  readonly price: string;
}

export type OfferBodies =
  | { readonly kind: "services"; readonly bodies: readonly ServiceBody[] }
  | { readonly kind: "products"; readonly bodies: readonly ProductBody[] }
  | { readonly problem: string };

export const PRICE_HINT = "Write a price like 45,50 or 45.50.";

export function offerBodies(
  offers: readonly OfferDraft[],
  sells: "services" | "products",
  currency: string,
  /** The services are asked about for a price, not booked (agents can ask for a price and not book). */
  asked = false,
): OfferBodies {
  const wanted = offers.filter((o) => o.name.trim());
  const priced: { offer: OfferDraft; value: number | undefined }[] = [];
  for (const o of wanted) {
    const typed = o.price.trim();
    const value = typed ? parseMajor(typed, minorUnitsOf(currency)) : undefined;
    if (typed && value === undefined) return { problem: `${o.name.trim()}: ${PRICE_HINT}` };
    // A product is sold at a price: one without is not saved as free.
    if (sells === "products" && value === undefined)
      return { problem: `${o.name.trim()} needs a price. ${PRICE_HINT}` };
    priced.push({ offer: o, value });
  }
  if (sells === "services" && asked) {
    return {
      kind: "services",
      bodies: priced.map(({ offer }) => ({
        name: offer.name.trim(),
        active: true,
        price: { model: "quote" as const },
      })),
    };
  }
  if (sells === "services") {
    return {
      kind: "services",
      bodies: priced.map(({ offer, value }) => ({
        name: offer.name.trim(),
        duration_min: Math.max(5, Number(offer.minutes) || 60),
        active: true,
        ...(value !== undefined ? { price: { model: "fixed" as const, value, currency } } : {}),
      })),
    };
  }
  return {
    kind: "products",
    bodies: priced.map(({ offer, value }) => ({
      name: offer.name.trim(),
      price: { value: value ?? 0, currency },
      active: true,
    })),
  };
}

/** The address owner emails go to, as the wizard saves it: trimmed, and null when left empty. */
export function ownerEmailDoc(typed: string): { notifications: { ownerEmail: string | null } } {
  const email = typed.trim();
  return { notifications: { ownerEmail: email || null } };
}

/**
 * What agents can do, as the wizard asks it: the three switches of Settings, a kitchen's orders for a time, and the
 * other doors the inbox has: ordering products, asking for a stay, a price of their own, changes to what was agreed.
 */
export interface WizardDoors {
  readonly booking: boolean;
  readonly quoteRequest: boolean;
  readonly message: boolean;
  /** A kitchen's orders for a time (`kitchen.enabled`): collection or delivery, at a time it can make. */
  readonly order?: boolean | undefined;
  /**
   * Whether the business sells products. Not a door of Settings: ordering opens on its own once a product is listed
   * and stays open while one is, so this only says whether the offer step asks for some (`withListed`).
   */
  readonly products?: boolean | undefined;
  /** A place to stay's requests for dates (`doors.stay`): open once it has rooms. */
  readonly stay?: boolean | undefined;
  /** A price of the customer's own taken as their answer (`negotiation.priceCounters`, off out of the box). */
  readonly negotiate?: boolean | undefined;
  /** Changes to a confirmed booking or an accepted order (`negotiation.changes.maxPerItem` above 0). */
  readonly changes?: boolean | undefined;
}

/**
 * The settings write the wizard's switches make (`settings.doors`): booking and messages follow
 * what the inbox holds when on (a booking still needs a service and hours), off is off; asking for
 * a price on opens it before anything is listed.
 */
export function wizardDoorsDoc(d: WizardDoors): { doors: Record<string, boolean | null> } {
  return {
    doors: {
      booking: d.booking ? null : false,
      quoteRequest: d.quoteRequest,
      message: d.message ? null : false,
      // A stay's door follows the rooms when on, as booking follows services and hours.
      ...(d.stay !== undefined ? { stay: d.stay ? null : false } : {}),
    },
  };
}

/**
 * What a business runs, as the setup's first question asks it (ADR-036): each kind sets the rules to
 * start from, what agents can do to begin with, and which systems "Connect your system" shows first.
 * A later kind (a place to stay) is one more entry here.
 */
export interface SetupKind {
  readonly key: string;
  readonly label: string;
  /** One line under the chip: what kind of business it is. */
  readonly line: string;
  /** The rules it starts from; none for `general`, whose rules follow what agents can do. */
  readonly preset: PresetKey | null;
  readonly doors: WizardDoors;
  /** The integration groups its businesses run their days in, shown first when connecting. */
  readonly connect: readonly ConnectorGroup[];
  /** Cards of those groups it has no use for. */
  readonly skip?: readonly string[];
  /** Settings the kind starts with, merged when the owner says what agents can do (a kitchen's). */
  readonly settings?: Readonly<Record<string, unknown>> | undefined;
}

export const KINDS: readonly SetupKind[] = [
  {
    key: "appointments",
    label: "A salon, clinic or studio",
    line: "Booked at a time: treatments, consultations, classes.",
    preset: "appointments",
    doors: { booking: true, quoteRequest: true, message: true },
    connect: ["booking", "calendars"],
  },
  {
    key: "trades",
    label: "A trade",
    line: "Jobs you quote for and visits you arrange.",
    preset: "trades",
    doors: { booking: false, quoteRequest: true, message: true },
    connect: ["work", "calendars"],
  },
  {
    key: "projects",
    label: "Building and renovation",
    line: "Larger jobs quoted in stages, often after a visit.",
    preset: "projects",
    doors: { booking: false, quoteRequest: true, message: true },
    connect: ["work", "calendars"],
  },
  {
    key: "food",
    label: "A restaurant or takeaway",
    line: "Orders to collect or have delivered, and tables.",
    preset: "food",
    doors: { booking: true, quoteRequest: true, message: true, order: true },
    connect: ["pos", "payments"],
    settings: { kitchen: { enabled: true, methods: { pickup: true, delivery: false, dineIn: false } } },
  },
  {
    key: "bakery",
    label: "A bakery",
    line: "Bread and cakes ordered ahead, cakes made to order.",
    preset: "bakery",
    doors: { booking: false, quoteRequest: true, message: true, order: true },
    connect: ["pos", "payments"],
    settings: { kitchen: { enabled: true, prepMin: 60, slotMin: 30, daysAhead: 14 } },
  },
  {
    key: "cafe",
    label: "A café",
    line: "Coffee and food ordered ahead, ready when they arrive.",
    preset: "cafe",
    doors: { booking: false, quoteRequest: false, message: true, order: true },
    connect: ["pos", "payments"],
    settings: { kitchen: { enabled: true, prepMin: 10, slotMin: 10, daysAhead: 1 } },
  },
  {
    key: "shop",
    label: "A shop",
    line: "Things people order, to collect or to deliver.",
    preset: "shop",
    doors: { booking: false, quoteRequest: false, message: true },
    connect: ["shops", "payments"],
  },
  {
    // A place to stay (ADR-037): stays have their own door, opened by the property it sets up; times
    // and prices for a request are not how a room is let, so those doors start closed.
    key: "stays",
    label: "A place to stay",
    line: "A hotel, a guesthouse, a B&B, holiday rentals.",
    preset: "stays",
    doors: { booking: false, quoteRequest: false, message: true },
    connect: ["lodging", "calendars"],
    // A stay is nights, never minutes: no booking calendar takes one.
    skip: ["calcom", "calendly"],
  },
];

/**
 * A room as the setup wizard first asks for it: what it is called, how many, how many sleep in it, and
 * what a night costs (optional: without one, each request waits for a price of the owner's own).
 */
export interface WizardRoom {
  readonly id: number;
  name: string;
  units: string;
  sleeps: string;
  price?: string;
}

/**
 * The rooms to make, with each one's price a night in minor units (null where none was typed), or what
 * is missing: a name each, at least one, numbers that are numbers, prices that are amounts.
 */
export function wizardRoomBodies(
  rooms: readonly WizardRoom[],
  propertyId: string,
  currency = "EUR",
): { bodies: Record<string, unknown>[]; prices: (number | null)[] } | { problem: string } {
  const named = rooms.filter((r) => r.name.trim());
  if (named.length === 0) return { problem: "Name at least one kind of room." };
  const prices: (number | null)[] = [];
  for (const r of named) {
    const typed = r.price?.trim() ?? "";
    if (!typed) {
      prices.push(null);
      continue;
    }
    const value = parseMajor(typed, minorUnitsOf(currency));
    if (value === undefined || value <= 0)
      return { problem: `"${typed}" is not a price a night for ${r.name.trim()}.` };
    prices.push(value);
  }
  const bodies = named.map((r, i) => {
    const sleeps = Math.max(1, Math.min(20, Number(r.sleeps) || 1));
    return {
      property_id: propertyId,
      name: r.name.trim(),
      units: Math.max(1, Math.min(500, Number(r.units) || 1)),
      capacity: { adults: sleeps, children: 0, total: sleeps },
      sort: i,
    };
  });
  return { bodies, prices };
}

/**
 * Any other kind of business, from the list of hundreds or in the owner's own words: agents can ask for a price and
 * send a message to begin with, and the rules follow what the owner lets them do.
 */
export const GENERAL: SetupKind = {
  key: "general",
  label: "Something else",
  line: "Agents can ask you for a price and write to you; you choose the rest next.",
  preset: null,
  doors: { booking: false, quoteRequest: true, message: true },
  connect: ["calendars", "payments", "shops"],
};

/** The kind of a key, if it is one: the quick picks, and `general` for any other. */
export function kindOf(key: string | null | undefined): SetupKind | undefined {
  return key === GENERAL.key ? GENERAL : KINDS.find((k) => k.key === key);
}

/** The kind of the list each quick pick is, where it is one kind ("A salon, clinic or studio" is many). */
const QUICK_KINDS: Readonly<Record<string, string>> = {
  trades: "tradesperson",
  projects: "builder",
  food: "restaurant",
  bakery: "bakery",
  cafe: "cafe",
  shop: "shop",
  stays: "place-to-stay",
};

/** What a quick pick says the business runs, as the settings keep it; null for one that is many kinds. */
export function quickKind(key: string): ChosenKind | null {
  const kind = businessKind(QUICK_KINDS[key]);
  return kind ? { id: kind.id, label: kind.names.en } : null;
}

/** The setup a kind of the list starts from: its preset's quick pick, or `general`. */
export function setupKindOf(kind: BusinessKind | KindPreset | null | undefined): SetupKind {
  const preset = typeof kind === "string" ? kind : kind?.preset;
  return kindOf(preset) ?? GENERAL;
}

/** The quick pick a saved kind reads as, when the wizard is run again: its own, else its preset's. */
export function setupKeyOfSaved(saved: ChosenKind | null | undefined): string | null {
  if (!saved) return null;
  const quick = Object.entries(QUICK_KINDS).find(([, id]) => id === saved.id)?.[0];
  if (quick) return quick;
  return setupKindOf(businessKind(saved.id)).key;
}

const KITCHENS = new Set(["food", "bakery", "cafe"]);

/** A kitchen (ADR-040): a restaurant or takeaway, a bakery, a café. Its wizard asks for dishes, not services. */
export function isKitchen(kind: SetupKind | string | null | undefined): boolean {
  const key = typeof kind === "string" ? kind : kind?.key;
  return key !== undefined && key !== null && KITCHENS.has(key);
}

/** The groups "What can agents do?" shows its switches in, in order. */
export type DoorGroup = "book" | "buy" | "price" | "after" | "talk";
export const DOOR_GROUPS: readonly { readonly id: DoorGroup; readonly label: string }[] = [
  { id: "book", label: "Booking" },
  { id: "buy", label: "Ordering" },
  { id: "price", label: "Prices" },
  { id: "after", label: "After it is agreed" },
  { id: "talk", label: "Messages" },
];

/** One switch on "What can agents do?", with the line under it: what it means for the owner. */
export interface DoorChoice {
  readonly key: keyof WizardDoors;
  readonly group: DoorGroup;
  readonly label: string;
  readonly line: string;
  /** Said, not switched: what the inbox holds opens it, and nothing here closes it (products already listed). */
  readonly fixed?: boolean | undefined;
}

const QUOTE_LINES: Readonly<Record<string, string>> = {
  food: "An event, catering, a large table.",
  bakery: "A cake made to order, a catering order.",
  cafe: "Catering, a large order.",
  trades: "A job to quote, a visit to arrange.",
  projects: "A project to quote, often after a visit.",
};

/**
 * Every door the inbox has, as the wizard shows a kind: a place to stay asks for stays, a restaurant books tables, a
 * kitchen takes orders for a time, everyone else books time and sells products; each can be asked for a price,
 * negotiate, change what was agreed and write. Each line says what it means for the owner. Ordering products has no
 * switch in Settings: it opens with the first product listed, so with some listed (`listed`) it is said, not
 * switched, and without, the switch only says whether the business sells any.
 */
export function doorRows(kind: SetupKind | undefined, listed = 0): readonly DoorChoice[] {
  const key = kind?.key ?? "";
  const kitchen = isKitchen(kind);
  const stays = key === "stays";
  const rows: DoorChoice[] = [];
  if (stays) {
    rows.push({
      key: "stay",
      group: "book",
      label: "Agents can ask for a stay",
      line: "Dates and guests. Each request comes to you with a quote from your prices, for you to send.",
    });
  } else if (key === "food") {
    rows.push({ key: "booking", group: "book", label: "Agents can book a table", line: "A sitting, for a party." });
  } else if (!kitchen) {
    rows.push({
      key: "booking",
      group: "book",
      label: "Agents can book time",
      line: "They see your free times and ask for one. Your rules can confirm one in a free slot; the rest wait for you.",
    });
  }
  if (kitchen) {
    rows.unshift({
      key: "order",
      group: "buy",
      label: "Agents can order for a time",
      line: "Collection or delivery, at a time your kitchen can make.",
    });
  } else if (!stays && listed > 0) {
    rows.push({
      key: "products",
      group: "buy",
      label: "Agents can order your products",
      line: `${listed} listed, at your prices and stock. Ordering stays open while you list one: Settings → Products.`,
      fixed: true,
    });
  } else if (!stays) {
    rows.push({
      key: "products",
      group: "buy",
      label: "You sell products",
      line: "Agents can order what you list, at your prices and stock. Ordering opens with your first product; on, the next step asks for a few or brings them from your shop.",
    });
  }
  rows.push({
    key: "quoteRequest",
    group: "price",
    label: "Agents can ask for a price",
    line: QUOTE_LINES[key] ?? "They say what they need; you answer with a price they can accept.",
  });
  if (!stays) {
    rows.push({
      key: "negotiate",
      group: "price",
      label: "Agents can suggest their own price",
      line: "It comes to you to take or answer. Your AI and rules may take one only at your price, or as far under it as you allow.",
    });
    rows.push({
      key: "changes",
      group: "after",
      label: "Agents can ask to change it",
      line: "Another time, quantities, a delivery date: nothing changes until it is accepted.",
    });
  }
  rows.push({
    key: "message",
    group: "talk",
    label: "Agents can send a message",
    line: "Anything else, for you to answer.",
  });
  return rows;
}

/**
 * The switches of Settings' three doors and a kitchen's orders for a time, as a kind shows them: a kitchen's start
 * with orders for a time, and only a restaurant books tables.
 */
export function doorsFor(kind: SetupKind | undefined): readonly DoorChoice[] {
  return doorRows(kind).filter((d) => ["order", "booking", "quoteRequest", "message"].includes(d.key));
}

/**
 * What agents can do to begin with, for a kind: its own doors, products for a shop, stays for a place to stay;
 * a price of their own off (the founder's choice, out of the box), changes on, as the inbox has them.
 */
export function defaultDoors(kind: SetupKind | undefined): WizardDoors {
  const doors = kind?.doors ?? { booking: true, quoteRequest: true, message: true };
  // A place to stay's policies are its plans' (Settings → Property): no price of their own, no changes here.
  if (kind?.key === "stays") return { ...doors, stay: true };
  return { ...doors, products: kind?.key === "shop", negotiate: false, changes: true };
}

/**
 * The doors to start from when the owner picks a kind in this session: the kind's own, with a price of their own and
 * changes as the owner already set them in Settings (those are not a kind's to decide).
 */
export function startDoors(kind: SetupKind | undefined, doc: Settings | undefined): WizardDoors {
  const d = defaultDoors(kind);
  if (!doc) return d;
  return {
    ...d,
    ...(d.negotiate !== undefined ? { negotiate: doc.negotiation.priceCounters } : {}),
    ...(d.changes !== undefined ? { changes: doc.negotiation.changes.maxPerItem > 0 } : {}),
  };
}

/**
 * The doors to start from when the wizard opens on what Settings already say (it is run again, or the doors were set
 * in Settings first): every door as Settings keep it, so pressing Continue through writes back what is there and
 * turns nothing back unasked. A door left to follow what the inbox holds reads as on, false as off; a kitchen's
 * orders for a time are `kitchen.enabled`. Settings that say nothing of the doors yet start from the kind's own.
 */
export function savedDoors(kind: SetupKind | undefined, doc: Settings | undefined): WizardDoors {
  const d = startDoors(kind, doc);
  if (!doc) return d;
  const { booking, quoteRequest, message, stay } = doc.doors;
  // The doors step always writes whether agents can ask for a price: with none of them said, it has not run.
  if ([booking, quoteRequest, message, stay].every((v) => v === undefined || v === null)) return d;
  return {
    ...d,
    booking: booking !== false,
    quoteRequest: quoteRequest ?? d.quoteRequest,
    message: message !== false,
    ...(d.stay !== undefined ? { stay: stay !== false } : {}),
    ...(d.order !== undefined ? { order: doc.kitchen.enabled } : {}),
  };
}

/**
 * The doors as the wizard shows them, beside what the inbox holds: with a product listed, ordering is open whatever
 * was chosen, and says so (`doorRows`), for every kind that sells products.
 */
export function withListed(d: WizardDoors, kind: SetupKind | undefined, listed: number): WizardDoors {
  if (listed <= 0 || isKitchen(kind) || kind?.key === "stays") return d;
  return { ...d, products: true };
}

/**
 * What the owner's AI and rules may do with a price of the customer's own, as Settings → Negotiation applies it
 * (core `effectiveFloor`): at 0%, take one only at the owner's price or above; at N%, up to N% under it, never under
 * the lowest price the owner set for an item. Anything lower comes to the owner.
 */
export function discountLine(pct: number): string {
  if (pct <= 0)
    return "Your AI and rules take a price of theirs only at your price or above. Anything lower comes to you.";
  return `Your AI and rules may take a price of theirs up to ${pct}% under yours, never under the lowest price you set for an item in Settings. Anything lower comes to you.`;
}

/** Whether any door is open: with none, agents cannot reach the business at all. */
export function anyDoor(d: WizardDoors): boolean {
  return d.booking || d.quoteRequest || d.message || d.order === true || d.products === true || d.stay === true;
}

/**
 * The limits the doors step sets beside its switches, as Settings keep them: how long before a booking it can be
 * cancelled, how far below a price the owner's AI may go, how many changes, and how customers can pay.
 */
export interface WizardTerms {
  /** `booking.cancellationWindowMin`. */
  readonly cancelMin: number;
  /** `negotiation.ai.maxDiscountPct`. */
  readonly discountPct: number;
  /** `negotiation.changes.maxPerItem` while changes are on. */
  readonly maxChanges: number;
  /** `payments.accepted`: tokens of the payments vocabulary. */
  readonly payments: readonly string[];
}

/** The terms to start from: what the settings say, so running the wizard again changes nothing unasked. */
export function termsOf(doc: Settings | undefined): WizardTerms {
  return {
    cancelMin: doc?.booking.cancellationWindowMin ?? 1440,
    discountPct: doc?.negotiation.ai.maxDiscountPct ?? 0,
    maxChanges: doc?.negotiation.changes.maxPerItem || 3,
    payments: doc?.payments.accepted ?? [],
  };
}

/** The discounts the owner's AI may be allowed, one press each (`negotiation.ai.maxDiscountPct`). */
export const DISCOUNT_CHOICES: readonly number[] = [0, 5, 10, 15];

/**
 * The settings the doors step writes: the three doors, and for a kitchen its starting settings with
 * orders for a time on or off as the owner chose. A merge, like every wizard write. A kind's starting settings
 * (a bakery's slots, a café's preparation time) are written only when the owner picked the kind in this session
 * (`seed`): run again on a kind already saved, only whether orders are taken is, so Settings → Kitchen stays as set.
 */
export function doorsStepDoc(
  d: WizardDoors,
  kind: SetupKind | undefined,
  terms?: WizardTerms | undefined,
  seed = true,
): Record<string, unknown> {
  const doc: Record<string, unknown> = { ...wizardDoorsDoc(d), ...(seed ? (kind?.settings ?? {}) : {}) };
  if (kind && isKitchen(kind)) {
    const kitchen = (seed ? (kind.settings?.kitchen ?? {}) : {}) as Record<string, unknown>;
    doc.kitchen = { ...kitchen, enabled: d.order !== false };
  }
  if (!terms) return doc;
  // A price of their own, the discount the owner's AI may give, and changes: each as Settings keep it, and only
  // what this kind was asked.
  const negotiation: Record<string, unknown> = {};
  if (d.negotiate !== undefined) {
    negotiation.priceCounters = d.negotiate;
    negotiation.ai = { maxDiscountPct: Math.max(0, Math.min(50, terms.discountPct)) };
  }
  if (d.changes !== undefined) {
    negotiation.changes = { maxPerItem: d.changes ? Math.max(1, Math.min(3, terms.maxChanges)) : 0 };
  }
  if (Object.keys(negotiation).length) doc.negotiation = negotiation;
  if (d.booking) doc.booking = { cancellationWindowMin: Math.max(0, terms.cancelMin) };
  doc.payments = { accepted: [...terms.payments] };
  return doc;
}

/* --- a kitchen's first dishes --------------------------------------------------------------- */

/** A dish as the wizard asks it: its name, its price as typed, the section it goes in. */
export interface DishDraft {
  readonly name: string;
  readonly price: string;
  readonly section: string;
}

/** The sections a kitchen chooses its first dishes into, by kind: a chooser, never typed. */
export const DISH_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  food: ["Mains", "Starters", "Desserts", "Drinks"],
  bakery: ["Bread", "Cakes", "Pastries", "Drinks"],
  cafe: ["Coffee", "Food", "Drinks"],
};

/** What the first dish's name box suggests, by kind. */
export const DISH_PLACEHOLDERS: Readonly<Record<string, string>> = {
  food: "Margherita",
  bakery: "Sourdough loaf",
  cafe: "Flat white",
};

/** A section's id from its name, as Settings → Menu makes them: "Mains" is `mains`. */
const sectionId = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "menu";

export type DishPlan =
  | {
      readonly products: readonly { readonly body: ProductBody; readonly section: string }[];
      /** The sections the dishes go in, added to the ones the menu has. */
      readonly sections: readonly { readonly id: string; readonly name: string; readonly sort: number }[];
    }
  | { readonly problem: string };

/**
 * The products the wizard makes for a kitchen's first dishes, each put on the menu in its section with
 * its allergens left for the owner to state and confirm in Settings → Menu. Every dish needs a price
 * that reads: nothing is saved at 0 by mistake. Rows left empty are skipped.
 */
export function dishPlan(
  drafts: readonly DishDraft[],
  currency: string,
  have: readonly { readonly id: string; readonly name: string; readonly sort: number }[],
): DishPlan {
  const planned = offerBodies(
    drafts.map((d) => ({ name: d.name, minutes: "0", price: d.price })),
    "products",
    currency,
  );
  if ("problem" in planned) return { problem: planned.problem };
  const wanted = drafts.filter((d) => d.name.trim());
  const sections = [...have];
  const products = (planned.bodies as readonly ProductBody[]).map((body, i) => {
    const name = wanted[i]?.section || "Menu";
    const id = sectionId(name);
    if (!sections.some((s) => s.id === id)) sections.push({ id, name, sort: sections.length });
    return { body, section: id };
  });
  return { products, sections };
}

/**
 * The rules to start from: the kind's, once the owner said what they run; else bookings' when agents
 * can book, requests for a price's when they can only ask.
 */
export function wizardPreset(d: WizardDoors, kind?: SetupKind | undefined): PresetKey | null {
  if (kind?.preset) return kind.preset;
  if (d.booking) return "appointments";
  if (d.quoteRequest) return "trades";
  return null;
}

/** The network a new inbox is offered at setup, switched on unless the owner says no (core `DEFAULT_NETWORK`). */
export const SETUP_NETWORK = "https://network.surfingdog.ai";

/**
 * What the wizard's last step says about joining `SETUP_NETWORK`:
 *
 * - `switch`: the switch, on unless the owner says no;
 * - `later`: only a line saying to list it once the inbox has a public https address, since a
 *   network cannot verify one at localhost, on a private address or on a port;
 * - null: nothing, when the host holds the networks (it joins a hosted inbox itself), when the inbox
 *   reports to it already, and when this is not a first setup (the wizard run again by an owner who
 *   chose already: Settings → Networks is where they switch it).
 */
export function networkOffer(
  settings: {
    readonly locked?: readonly string[] | undefined;
    readonly doc: { readonly networks: Readonly<Record<string, { readonly enabled: boolean }>> };
  },
  o: { readonly firstRun: boolean; readonly reportable: boolean },
): "switch" | "later" | null {
  if ((settings.locked ?? []).some((l) => l === "networks" || l.startsWith("networks."))) return null;
  if (!o.firstRun || settings.doc.networks[SETUP_NETWORK]?.enabled === true) return null;
  return o.reportable ? "switch" : "later";
}

/**
 * The settings write that joins it, a merge: every other network stays as it is. Listing, counts and
 * receipts; giving first-time customers a key stays off until the owner switches it on in Settings.
 */
export function joinNetworkDoc(): { networks: Record<string, { enabled: true; issue: false }> } {
  return { networks: { [SETUP_NETWORK]: { enabled: true, issue: false } } };
}

/** The wizard's steps by id: a kind of business that needs others (a place to stay) names its own. */
export const STEPS = [
  { id: "kind", label: "Kind" },
  { id: "you", label: "You" },
  { id: "doors", label: "Agents" },
  { id: "offer", label: "Offer" },
  { id: "hours", label: "Hours" },
  { id: "answering", label: "Answering" },
] as const;
/** A place to stay (ADR-037): what agents can do, then the place and its rooms instead of offers and hours. */
export const STAY_STEPS = [
  { id: "kind", label: "Kind" },
  { id: "you", label: "You" },
  { id: "doors", label: "Agents" },
  { id: "place", label: "Place" },
  { id: "rooms", label: "Rooms" },
  { id: "answering", label: "Answering" },
] as const;
export type StepId = (typeof STEPS)[number]["id"] | (typeof STAY_STEPS)[number]["id"] | "where";

/** A trade is asked where it works, after who it is: agents check a site against it before they ask. */
const WHERE = { id: "where", label: "Area" } as const;
const TRADE_KINDS = new Set(["trades", "projects"]);
export function stepsFor(kind: string | null | undefined): readonly { readonly id: StepId; readonly label: string }[] {
  if (kind === "stays") return STAY_STEPS;
  if (isKitchen(kind)) return STEPS.map((s) => (s.id === "offer" ? { id: s.id, label: "Dishes" } : s));
  if (!kind || !TRADE_KINDS.has(kind)) return STEPS;
  return [STEPS[0], STEPS[1], WHERE, ...STEPS.slice(2)];
}

/* --- what the offer step asks for, and where it can be brought from ----------------------------------------- */

/** What the offer step asks for, by what agents can do: services, products, a kitchen's dishes. */
export type OfferSection = "services" | "products" | "menu";

export function offerSections(d: WizardDoors, kind: SetupKind | undefined): readonly OfferSection[] {
  if (isKitchen(kind)) return ["menu"];
  const out: OfferSection[] = [];
  if (d.booking || d.quoteRequest) out.push("services");
  if (d.products) out.push("products");
  return out;
}

/** How the offer step is answered: a few now, brought from the system the business uses, or later. */
export type OfferMode = "now" | "bring" | "later";

/**
 * What of the offer can be brought from a system the business already uses: products from its shop or till, a
 * kitchen's menu from its ordering system. Services cannot: calendars and booking tools keep their times in step
 * (busy times in, bookings out), Square's catalogue leaves them out, so they are named in the wizard.
 */
export function bringable(sections: readonly OfferSection[]): readonly OfferSection[] {
  return sections.filter((s) => s === "products" || s === "menu");
}

/** How the offer step is answered, given what it asks for: bringing them is adding them when none can be brought. */
export function offerModeFor(mode: OfferMode, sections: readonly OfferSection[]): OfferMode {
  return mode === "bring" && bringable(sections).length === 0 ? "now" : mode;
}
