import { OFFER_A_CODE, type Preset, type PresetSpec } from "./common";

/**
 * Trades and quotes: every request for a price goes to a person, emergencies and jobs needed within a
 * day first (the job's urgency, ADR-039 §4, and the words a customer used), and a site outside the area
 * the business works in waits for the owner to decide. Nothing here refuses anybody: the emergency door
 * and the area are Settings → Work and Area, checked as a request comes in.
 * Amounts are in minor units of the business's currency.
 */

/**
 * The job's own urgency, as the customer's agent sent it: emergencies first, within a day next. Rules
 * run highest priority first and each `set_flags` writes its priority over the last, so these come
 * after every rule that sets a lower one (a known customer's 2): an emergency ends at 3 whoever sent it.
 */
export const URGENCY_FIRST: readonly Preset[] = [
  {
    name: "Emergencies go first",
    priority: 94,
    definition: {
      on: ["item.created"],
      if: {
        all: [
          { path: "item.type", op: "eq", value: "quote_request" },
          { path: "item.payload.job.urgency", op: "eq", value: "emergency" },
        ],
      },
      actions: [{ action: "set_flags", needsHuman: true, priority: 3 }],
      stop: false,
      maxRunsPerItem: 1,
    },
  },
  {
    name: "Jobs needed within a day go next",
    priority: 93,
    definition: {
      on: ["item.created"],
      if: {
        all: [
          { path: "item.type", op: "eq", value: "quote_request" },
          { path: "item.payload.job.urgency", op: "eq", value: "within_24h" },
        ],
      },
      actions: [{ action: "set_flags", needsHuman: true, priority: 2 }],
      stop: false,
      maxRunsPerItem: 1,
    },
  },
  {
    name: "A site outside your area waits for you",
    priority: 92,
    definition: {
      on: ["item.created"],
      if: {
        all: [
          { path: "item.type", op: "eq", value: "quote_request" },
          { path: "item.payload.job.areaCheck.status", op: "in", value: ["outside", "unknown"] },
        ],
      },
      actions: [{ action: "set_flags", needsHuman: true }],
      stop: false,
      maxRunsPerItem: 1,
    },
  },
];

export const trades: PresetSpec<"trades"> = {
  key: "trades",
  name: "Trades & quotes",
  rules: [
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
    ...URGENCY_FIRST,
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
    {
      name: "Trusted customers and customers you know go first",
      priority: 95,
      definition: {
        on: ["item.created"],
        if: { any: [{ fn: "person_trusted" }, { fn: "customer_known" }] },
        actions: [{ action: "set_flags", priority: 2 }],
        stop: false,
        maxRunsPerItem: 1,
      },
    },
    OFFER_A_CODE,
  ],
};
