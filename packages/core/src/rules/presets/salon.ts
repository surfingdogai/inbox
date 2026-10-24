import { BACK_TO_US, OFFER_A_CODE, type PresetSpec } from "./common";

/**
 * Salons, barbers and beauty (ADR-035): a client the salon already knows, coming back, is confirmed at
 * once when their member of staff is free and it is within their hours; a new client's first visit, and
 * anything else, goes to a person. New or returning comes only from this salon's own bookings with them
 * (`customer.completed`): no score of anyone, from anywhere. What must come first (a patch test) is a
 * person's to check whenever the inbox cannot know the client: no rule confirms that, whatever it says.
 * Owners who confirm everything themselves get the same rules without the first.
 */
export const salon: PresetSpec<"salon"> = {
  key: "salon",
  name: "Salon & beauty",
  rules: [
    {
      name: "Confirm a returning client when their stylist is free",
      priority: 120,
      definition: {
        on: ["item.created", ...BACK_TO_US],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "booking" },
            { path: "item.flags.sandbox", op: "neq", value: true },
            { fn: "slot_is_free" },
            { fn: "within_business_hours" },
            { fn: "customer_known" },
            { path: "customer.completed", op: "gte", value: 1 },
            { path: "customer.no_shows", op: "eq", value: 0 },
          ],
        },
        actions: [
          {
            action: "transition",
            event: "confirm",
            reason: "auto-confirmed: a returning client, their stylist free, within their hours",
          },
        ],
        stop: true,
        maxRunsPerItem: 1,
      },
    },
    {
      name: "A new client's first visit goes to a person",
      priority: 110,
      definition: {
        on: ["item.created"],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "booking" },
            { path: "customer.completed", op: "eq", value: 0 },
          ],
        },
        actions: [{ action: "set_flags", needsHuman: true }],
        stop: false,
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
    OFFER_A_CODE,
  ],
};
