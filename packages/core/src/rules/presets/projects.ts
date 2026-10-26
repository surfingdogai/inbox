import { OFFER_A_CODE, type PresetSpec } from "./common";
import { URGENCY_FIRST } from "./trades";

/**
 * Building and renovation (ADR-039 §4): larger jobs, quoted in stages, often after a site visit. Every
 * request for a price goes to a person; one with plans or photos attached is marked for a closer look;
 * a site outside the area waits for the owner. Nothing confirms on its own and nothing refuses anybody.
 */
export const projects: PresetSpec<"projects"> = {
  key: "projects",
  name: "Building & renovation",
  rules: [
    {
      name: "Every project needs a person",
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
      name: "Plans and photos sent with a request go first",
      priority: 99,
      definition: {
        on: ["item.created"],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "quote_request" },
            { path: "item.payload.attachments", op: "exists" },
          ],
        },
        actions: [{ action: "set_flags", needsHuman: true, priority: 2 }],
        stop: false,
        maxRunsPerItem: 1,
      },
    },
    ...URGENCY_FIRST,
    {
      name: "Customers you know go first",
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
