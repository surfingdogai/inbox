import type { PresetSpec } from "./common";

/**
 * A place to stay (ADR-033 §7): rules that only speed things up or ask a person (R25). None reads a
 * guest's standing to refuse anyone, none declines on another calendar's hint alone, and nothing is
 * sent at a price the property's own rates did not give.
 */
const isStay = { path: "item.type", op: "eq", value: "stay" } as const;
const newOrAgain = ["item.created", "item.transitioned:counter"];

export const stays: PresetSpec<"stays"> = {
  key: "stays",
  name: "A place to stay",
  rules: [
    {
      // R2: where nothing can be sold twice, the rates' quote goes at once; the guest still accepts it.
      name: "Send the quote at once when the rooms are kept for direct guests",
      priority: 130,
      definition: {
        on: newOrAgain,
        if: { all: [isStay, { fn: "rates_cover" }, { fn: "nights_free" }] },
        actions: [
          {
            action: "transition",
            event: "quote",
            input: { from: "rates" },
            reason: "quoted from the rates: these rooms cannot be sold twice",
          },
        ],
        stop: true,
        maxRunsPerItem: 3,
      },
    },
    {
      // R3: full on those nights by the owner's own closures, rooms kept or its system: never on a hint alone.
      name: "Say sorry when you are full",
      priority: 120,
      definition: {
        on: ["item.created"],
        if: { all: [isStay, { fn: "nights_closed" }] },
        actions: [{ action: "transition", event: "decline", reason: "full on those nights" }],
        stop: true,
        maxRunsPerItem: 1,
      },
    },
    {
      // R1: the rates' quote, kept for a person to send in one tap.
      name: "Draft a quote from my rates",
      priority: 110,
      definition: {
        on: newOrAgain,
        if: { all: [isStay, { fn: "rates_cover" }, { path: "item.payload.quote", op: "empty" }] },
        actions: [
          { action: "draft", event: "quote", input: { from: "rates" } },
          { action: "set_flags", needsHuman: true },
        ],
        stop: false,
        maxRunsPerItem: 3,
      },
    },
    {
      // R4: another calendar shows the nights as taken: a person looks before anyone answers.
      name: "Ask me when another calendar shows the nights as taken",
      priority: 100,
      definition: {
        on: ["item.created"],
        if: { all: [isStay, { fn: "ical_hint_overlap" }] },
        actions: [
          { action: "set_flags", needsHuman: true, priority: 2 },
          { action: "reply", template: "Another calendar shows some of these nights as taken.", internal: true },
        ],
        stop: false,
        maxRunsPerItem: 1,
      },
    },
    {
      // R5, off until the owner switches it on: a guest's new dates while cancelling is still free.
      name: "Accept date changes while cancellation is free",
      priority: 90,
      enabled: false,
      definition: {
        on: ["item.transitioned:propose_change"],
        if: {
          all: [
            isStay,
            { path: "item.payload.change.by", op: "eq", value: "customer" },
            { fn: "free_cancellation" },
            { fn: "change_nights_free" },
          ],
        },
        actions: [{ action: "transition", event: "accept_change", reason: "a free change, the new nights free" }],
        stop: true,
        maxRunsPerItem: 3,
      },
    },
    {
      // R7: anything else waits for a person.
      name: "Ask a person about anything else",
      priority: 10,
      definition: {
        on: ["item.created", "thread.inbound"],
        if: { all: [isStay] },
        actions: [{ action: "set_flags", needsHuman: true }],
        stop: false,
        maxRunsPerItem: 5,
      },
    },
  ],
};
