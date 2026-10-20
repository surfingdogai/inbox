import { OFFER_A_CODE, type PresetSpec } from "./common";

/**
 * Trades and quotes: every request for a price goes to a person, urgent ones first.
 * Amounts are in minor units of the business's currency.
 */
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
