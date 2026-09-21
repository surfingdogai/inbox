import type { RuleDefinition } from "./schema";

/** Per-vertical starting points. Amounts are in minor units. */
export const PRESETS: Record<string, { name: string; priority: number; definition: RuleDefinition }[]> = {
  appointments: [
    {
      name: "Auto-confirm small bookings when the slot is free",
      priority: 100,
      definition: {
        on: ["item.created"],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "booking" },
            { path: "item.flags.sandbox", op: "neq", value: true },
            {
              any: [
                { path: "item.payload.totalPrice.value", op: "lt", value: 5_000 },
                { path: "item.payload.totalPrice", op: "empty" },
              ],
            },
            { fn: "slot_is_free" },
            { fn: "within_business_hours" },
          ],
        },
        actions: [
          {
            action: "transition",
            event: "confirm",
            reason: "auto-confirmed: small booking, slot free, within opening hours",
          },
        ],
        stop: true,
        maxRunsPerItem: 1,
      },
    },
    {
      name: "Ask a person about anything else",
      priority: 10,
      definition: {
        on: ["item.created"],
        if: { path: "item.state", op: "in", value: ["requested", "received", "open"] },
        actions: [{ action: "set_flags", needsHuman: true }],
        stop: false,
        maxRunsPerItem: 1,
      },
    },
  ],
  trades: [
    {
      name: "Quotes always need a person",
      priority: 100,
      definition: {
        on: ["item.created"],
        if: { path: "item.type", op: "eq", value: "quote_request" },
        actions: [{ action: "set_flags", needsHuman: true, priority: 1 }],
        stop: false,
        maxRunsPerItem: 1,
      },
    },
    {
      name: "Urgent words raise priority",
      priority: 90,
      definition: {
        on: ["item.created", "thread.inbound"],
        if: { fn: "text_has_keywords", args: { keywords: ["urgent", "emergency", "leak", "flood", "asap"] } },
        actions: [{ action: "set_flags", needsHuman: true, priority: 3 }],
        stop: false,
        maxRunsPerItem: 3,
      },
    },
  ],
  shop: [
    {
      name: "Accept small orders, flag large ones",
      priority: 100,
      definition: {
        on: ["item.created"],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "order" },
            { path: "item.payload.totalPrice.value", op: "lte", value: 20_000 },
          ],
        },
        actions: [{ action: "transition", event: "accept", reason: "auto-accepted: under the approval limit" }],
        stop: true,
        maxRunsPerItem: 1,
      },
    },
    {
      name: "Large orders need approval",
      priority: 90,
      definition: {
        on: ["item.created"],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "order" },
            { path: "item.payload.totalPrice.value", op: "gt", value: 20_000 },
          ],
        },
        actions: [{ action: "set_flags", needsHuman: true, priority: 2 }],
        stop: true,
        maxRunsPerItem: 1,
      },
    },
  ],
};
