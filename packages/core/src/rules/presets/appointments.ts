import { BACK_TO_US, OFFER_A_CODE, type PresetSpec } from "./common";

/**
 * Appointments: a small booking in a free slot inside opening hours confirms; anything else asks a person.
 * Amounts are in minor units of the business's currency.
 */
export const appointments: PresetSpec<"appointments"> = {
  key: "appointments",
  name: "Appointments",
  rules: [
    {
      name: "Auto-confirm small bookings when the slot is free",
      priority: 100,
      definition: {
        // A request back with us after the customer sent the details or picked another time is a
        // request again (ADR-018 N14), and is judged as a new one would be.
        on: ["item.created", ...BACK_TO_US],
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
    {
      name: "Confirm a customer you know, or a trusted one, at once",
      priority: 120,
      definition: {
        on: ["item.created", ...BACK_TO_US],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "booking" },
            { path: "item.flags.sandbox", op: "neq", value: true },
            { fn: "slot_is_free" },
            { fn: "within_business_hours" },
            {
              any: [
                {
                  all: [
                    { fn: "customer_known" },
                    { path: "customer.completed", op: "gte", value: 2 },
                    { path: "customer.no_shows", op: "eq", value: 0 },
                  ],
                },
                {
                  all: [
                    { fn: "person_trusted" },
                    { path: "customer.open_bookings", op: "lte", value: 2 },
                    {
                      any: [
                        { path: "item.payload.totalPrice.value", op: "lte", value: 20_000 },
                        { path: "item.payload.totalPrice", op: "empty" },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        actions: [
          {
            action: "transition",
            event: "confirm",
            reason: "auto-confirmed: a customer you know or a trusted one, slot free, within opening hours",
          },
        ],
        stop: true,
        maxRunsPerItem: 1,
      },
    },
    OFFER_A_CODE,
  ],
};
