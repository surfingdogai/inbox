import { OFFER_A_CODE, type PresetSpec } from "./common";
import { KITCHEN_INSTANT, KITCHEN_WAITS } from "./food";

/**
 * Bakeries (ADR-040): pre-orders with their notice, inside each item's daily cap, are accepted at once
 * when the bakery chose so; custom cakes are made to order and always wait for a person, and a request
 * for a price (a wedding cake, a picture of what it should look like) goes to a person, the soonest
 * first. Nothing here refuses anybody.
 */
export const bakery: PresetSpec<"bakery"> = {
  key: "bakery",
  name: "Bakery & pre-orders",
  rules: [
    KITCHEN_INSTANT,
    KITCHEN_WAITS,
    {
      name: "Custom cakes and special orders go to a person",
      priority: 95,
      definition: {
        on: ["item.created"],
        if: { path: "item.type", op: "eq", value: "quote_request" },
        actions: [{ action: "set_flags", needsHuman: true, priority: 2 }],
        stop: false,
        maxRunsPerItem: 1,
      },
    },
    {
      name: "Words about a celebration raise priority",
      priority: 90,
      definition: {
        on: ["item.created", "thread.inbound"],
        if: { fn: "text_has_keywords", args: { keywords: ["wedding", "birthday", "tomorrow", "today", "urgent"] } },
        actions: [{ action: "set_flags", needsHuman: true, priority: 3 }],
        stop: false,
        maxRunsPerItem: 2,
      },
    },
    OFFER_A_CODE,
  ],
};
