import { OFFER_A_CODE, type PresetSpec } from "./common";

/**
 * A shop: small orders are accepted and asked to pay, large ones wait for a person.
 * Amounts are in minor units of the business's currency.
 */
export const shop: PresetSpec<"shop"> = {
  key: "shop",
  name: "Shop",
  rules: [
    {
      name: "Accept small orders and ask for payment, flag large ones",
      priority: 100,
      definition: {
        on: ["item.created"],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "order" },
            { path: "item.payload.totalPrice.value", op: "lte", value: 20_000 },
          ],
        },
        actions: [
          { action: "transition", event: "accept", reason: "auto-accepted: under the approval limit" },
          { action: "transition", event: "request_payment", reason: "a new customer pays as the shop's flow says" },
        ],
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
    {
      name: "Accept orders within a customer's limit at once",
      priority: 120,
      definition: {
        on: ["item.created"],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "order" },
            { path: "item.flags.sandbox", op: "neq", value: true },
            { fn: "within_customer_limit" },
          ],
        },
        actions: [
          {
            action: "transition",
            event: "accept",
            reason: "auto-accepted: within twice the customer's largest paid order, or a trusted customer's limit",
          },
        ],
        stop: true,
        maxRunsPerItem: 1,
      },
    },
    OFFER_A_CODE,
  ],
};
