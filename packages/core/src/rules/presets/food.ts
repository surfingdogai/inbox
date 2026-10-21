import { OFFER_A_CODE, type Preset, type PresetSpec } from "./common";

/**
 * Restaurants, pizzerias and takeaways (ADR-036): an order inside what the kitchen set aside (its slot
 * had room, each item within its daily cap, every allergen confirmed by a person, and the kitchen chose
 * "at once within my caps") is accepted at once; every other order, every table and every request for a
 * price (an event, catering) waits for a person. A table books at once only for covers set aside: the
 * inbox refuses a rule's yes for any other (`kitchen/guard.ts`). Nothing here refuses anybody.
 */

/** The kitchen's mark decides: instant is inside the places set aside, with nothing a person must see. */
export const KITCHEN_INSTANT: Preset = {
  name: "Accept orders inside what the kitchen set aside",
  priority: 110,
  definition: {
    on: ["item.created"],
    if: {
      all: [
        { path: "item.type", op: "eq", value: "order" },
        { path: "item.flags.sandbox", op: "neq", value: true },
        { path: "item.payload.kitchen.instant", op: "eq", value: true },
      ],
    },
    actions: [
      { action: "transition", event: "accept", reason: "accepted at once: inside the places the kitchen set aside" },
    ],
    stop: true,
    maxRunsPerItem: 1,
  },
};

/** Every order the kitchen did not mark instant goes to a person, soonest first. */
export const KITCHEN_WAITS: Preset = {
  name: "Orders that wait go to a person",
  priority: 100,
  definition: {
    on: ["item.created"],
    if: {
      all: [
        { path: "item.type", op: "eq", value: "order" },
        { path: "item.payload.kitchen.instant", op: "neq", value: true },
      ],
    },
    actions: [{ action: "set_flags", needsHuman: true, priority: 2 }],
    stop: false,
    maxRunsPerItem: 1,
  },
};

export const ASK_FOR_EVENTS: Preset = {
  name: "Events, catering and large tables go to a person",
  priority: 95,
  definition: {
    on: ["item.created"],
    if: { path: "item.type", op: "eq", value: "quote_request" },
    actions: [{ action: "set_flags", needsHuman: true, priority: 1 }],
    stop: false,
    maxRunsPerItem: 1,
  },
};

export const food: PresetSpec<"food"> = {
  key: "food",
  name: "Restaurant & takeaway",
  rules: [
    KITCHEN_INSTANT,
    KITCHEN_WAITS,
    ASK_FOR_EVENTS,
    {
      name: "Confirm a table inside the covers set aside when the time is free",
      priority: 90,
      definition: {
        on: ["item.created"],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "booking" },
            { path: "item.flags.sandbox", op: "neq", value: true },
            { fn: "slot_is_free" },
            { fn: "within_business_hours" },
          ],
        },
        actions: [{ action: "transition", event: "confirm", reason: "confirmed: covers set aside, time free" }],
        stop: true,
        maxRunsPerItem: 1,
      },
    },
    {
      name: "Ask a person about any other table",
      priority: 10,
      definition: {
        on: ["item.created"],
        if: { path: "item.type", op: "eq", value: "booking" },
        actions: [{ action: "set_flags", needsHuman: true }],
        stop: false,
        maxRunsPerItem: 1,
      },
    },
    OFFER_A_CODE,
  ],
};
